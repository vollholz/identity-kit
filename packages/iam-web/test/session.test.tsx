/**
 * Sitzung: Wechsel per POST mit CSRF, öffentliche Abmeldeseite, «Recht irgendwo», Sitzungsablauf, Anmeldung bei 401.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ICON_NAMES, iamFetch, IamProvider, orgName, tenantName, useIam, type IamProviderProps } from '../src/index.ts';
import { json, ME, mockIamApi, type MockHandler } from '../src/testing/index.tsx';

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => { assign = vi.fn(); vi.stubGlobal('location', { ...window.location, pathname: '/', search: '', assign, reload: vi.fn() }); });
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

function setup(routes: Record<string, MockHandler>, props: Partial<IamProviderProps> = {}, app = <p>App</p>) {
  const api = mockIamApi(routes);
  vi.stubGlobal('fetch', api.fetch);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<IamProvider product="Notizen" queryClient={qc} {...props}>{app}</IamProvider>);
  return { api, qc, view };
}

const choose = { 'GET /auth/me': () => json({ ...ME, tenant: null, selectedOrganization: null, tenantError: 'Organisation wählen' }) };

describe('Organisation wechseln', () => {
  it('sendet POST /auth/switch mit X-CSRF-Token und folgt der Antwort', async () => {
    const { api } = setup({ ...choose, 'POST /auth/switch': () => json({ redirect: '/' }) });
    expect(await screen.findByRole('heading', { name: 'Organisation wählen' })).toBeInTheDocument();
    expect(screen.getByText('Organisation wählen', { selector: 'p' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Muster GmbH' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    const req = api.calls.find(r => r.method === 'POST')!;
    expect(new URL(req.url).pathname).toBe('/auth/switch');
    expect(req.headers.get('X-CSRF-Token')).toBe('csrf-123');
    expect(await req.json()).toEqual({ org: 'muster', returnTo: '/' });
    expect(JSON.parse(sessionStorage.getItem('iam.tab.org')!)).toMatchObject({ sub: 'sub-anna', alias: 'muster', name: 'Muster GmbH' });
  });

  it('meldet einen abgelehnten Wechsel, statt weiterzuleiten', async () => {
    setup({ ...choose, 'POST /auth/switch': () => json({ title: 'Organisation nicht erlaubt', status: 403 }, 403) });
    await userEvent.click(await screen.findByRole('button', { name: 'Muster GmbH' }));
    expect(await screen.findByText(/Organisation nicht gewechselt: Organisation nicht erlaubt/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('ohne Organisation im Konto: Hinweis an die Plattform-Administration; Marke der App', async () => {
    setup({ 'GET /auth/me': () => json({ ...ME, tenant: null, organizations: [], organizationNames: {}, tenantError: null }) }, { brand: <span>Marke Notizen</span> });
    expect(await screen.findByText(/keine Organisation zugeordnet/)).toBeInTheDocument();
    expect(screen.getByText('Marke Notizen')).toBeInTheDocument();
    expect(screen.getByText('Du gehörst mehreren Organisationen an. In welcher möchtest du arbeiten?')).toBeInTheDocument();
  });
});

describe('Anmeldung und Abmeldung', () => {
  it('ohne Sitzung (401) zur Anmeldung mit Rücksprung', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/notizen', search: '?q=1', hash: '', assign });
    setup({ 'GET /auth/me': () => json({ title: 'Nicht angemeldet', status: 401 }, 401) });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/auth/login?returnTo=%2Fnotizen%3Fq%3D1'));
    expect(screen.getByText('Weiterleitung zur Anmeldung …')).toBeInTheDocument();
  });

  it('zeigt unter /abgemeldet die öffentliche Seite, ohne /auth/me abzufragen oder weiterzuleiten', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/abgemeldet', search: '', assign });
    const { api } = setup({});
    expect(await screen.findByRole('heading', { name: 'Du bist abgemeldet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Erneut anmelden' })).toHaveAttribute('href', '/auth/login?returnTo=%2F');
    expect(screen.queryByText('App')).not.toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
    expect(document.title).toBe('Abgemeldet · Notizen');
  });

  it('Abmeldeseite unter einem eigenen Pfad', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/logged-out', search: '', assign });
    setup({}, { paths: { loggedOut: '/logged-out' } });
    expect(await screen.findByRole('heading', { name: 'Du bist abgemeldet' })).toBeInTheDocument();
  });

  it('Abmelden: POST mit CSRF, Organisation des Tabs weg, onLogout der App, dann /abgemeldet', async () => {
    const onLogout = vi.fn();
    function Out() { const { logout } = useIam(); return <button type="button" onClick={() => void logout()}>Abmelden</button>; }
    const { api } = setup({ 'POST /auth/logout': () => json({ redirect: '/' }) }, { onLogout }, <Out />);
    await userEvent.click(await screen.findByRole('button', { name: 'Abmelden' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/abgemeldet'));
    expect(api.calls.find(c => c.method === 'POST')!.headers.get('x-csrf-token')).toBe('csrf-123');
    expect(sessionStorage.getItem('iam.tab.org')).toBeNull();
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('Abmelden mit Serverfehler: Meldung, Sitzung und Organisation des Tabs bleiben; 401 gilt als abgemeldet', async () => {
    const onLogout = vi.fn();
    let status = 500;
    function Out() { const { logout } = useIam(); return <button type="button" onClick={() => void logout()}>Abmelden</button>; }
    setup({ 'POST /auth/logout': () => json({ title: 'Interner Fehler', status }, status) }, { onLogout }, <Out />);
    await userEvent.click(await screen.findByRole('button', { name: 'Abmelden' }));
    expect(await screen.findByText(/^Abmelden fehlgeschlagen: Interner Fehler/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('iam.tab.org')).not.toBeNull();
    status = 401;
    await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/abgemeldet'));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('CSRF-Token steht bereit, bevor Kinder zeichnen (auch für Layout-Effekte)', async () => {
    function Write() {
      useLayoutEffect(() => { void iamFetch('/v1/notes', { method: 'POST', body: {} }).catch(() => undefined); }, []);
      return <p>Schreibt beim Einhängen</p>;
    }
    const { api } = setup({ 'POST /v1/notes': () => json({ id: 'n1' }, 201) }, {}, <Write />);
    expect(await screen.findByText('Schreibt beim Einhängen')).toBeInTheDocument();
    await waitFor(() => expect(api.calls.find(c => c.method === 'POST')?.headers.get('x-csrf-token')).toBe('csrf-123'));
  });

  it('401 einer späteren Anfrage öffnet «Sitzung abgelaufen»; Eingaben bleiben, «Erneut anmelden» mit Rücksprung', async () => {
    function Form() { return <><input aria-label="Notiz" defaultValue="" /><button type="button" onClick={() => void iamFetch('/v1/notes').catch(() => undefined)}>Laden</button></>; }
    setup({ 'GET /v1/notes': () => json({ title: 'Nicht angemeldet', status: 401 }, 401) }, {}, <Form />);
    await userEvent.type(await screen.findByLabelText('Notiz'), 'nicht verlieren');
    await userEvent.click(screen.getByRole('button', { name: 'Laden' }));
    const dlg = await screen.findByRole('alertdialog', { name: 'Sitzung abgelaufen' });
    expect(within(dlg).getByRole('link', { name: 'Erneut anmelden' })).toHaveAttribute('href', '/auth/login?returnTo=%2F');
    await waitFor(() => expect(within(dlg).getByRole('link', { name: 'Erneut anmelden' })).toHaveFocus());
    await userEvent.click(within(dlg).getByRole('button', { name: 'Später' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByLabelText('Notiz')).toHaveValue('nicht verlieren');
  });

  it('403 einer Anfrage lässt /auth/me neu prüfen', async () => {
    function Probe() { return <button type="button" onClick={() => void iamFetch('/v1/notes').catch(() => undefined)}>Laden</button>; }
    const { api } = setup({ 'GET /v1/notes': () => json({ title: 'Dafür fehlt dir das Recht.', status: 403 }, 403) }, {}, <Probe />);
    await userEvent.click(await screen.findByRole('button', { name: 'Laden' }));
    await waitFor(() => expect(api.calls.filter(c => new URL(c.url).pathname === '/auth/me')).toHaveLength(2));
  });

  it('Serverfehler beim Start: zwei Wiederholungen, dann Fehler mit Referenz und «Erneut versuchen»', async () => {
    let n = 0;
    setup({ 'GET /auth/me': () => (++n > 3 ? json(ME) : json({ title: 'Interner Fehler', status: 500 }, 500, { 'x-request-id': 'r1' })) });
    await userEvent.click(await screen.findByRole('button', { name: 'Erneut versuchen' }, { timeout: 8000 }));
    expect(n).toBe(4);
    expect(await screen.findByText('App')).toBeInTheDocument();
  }, 15_000);
});

describe('Rechte aus Freigaben', () => {
  function Probe() {
    const { can, canSomewhere, orgName } = useIam();
    return <p>{`can:${can('folder:admin')} irgendwo:${canSomewhere('folder:admin')} lesen:${canSomewhere('note:read')} protokoll:${canSomewhere('audit:read')} org:${orgName}`}</p>;
  }

  it('canSomewhere gilt auch für Rechte nur an einzelnen Orten (somewhere), can nicht', async () => {
    setup({ 'GET /auth/me': () => json({ ...ME, roles: ['viewer'], permissions: ['tenant:read', 'note:read'], somewhere: ['tenant:read', 'note:read', 'folder:admin'] }) }, {}, <Probe />);
    expect(await screen.findByText('can:false irgendwo:true lesen:true protokoll:false org:Demo AG')).toBeInTheDocument();
  });

  it('ohne somewhere (unvollständige Antwort) wie can', async () => {
    const { somewhere: _, ...old } = ME;
    setup({ 'GET /auth/me': () => json({ ...old, roles: ['viewer'], permissions: ['note:read'] }) }, {}, <Probe />);
    expect(await screen.findByText(/^can:false irgendwo:false lesen:true protokoll:false/)).toBeInTheDocument();
  });
});

describe('IamProvider', () => {
  it('nutzt den QueryClient der App und meldet Person und Organisation (onTenant)', async () => {
    const onTenant = vi.fn();
    const { qc } = setup({}, { onTenant });
    expect(await screen.findByText('App')).toBeInTheDocument();
    expect(qc.getQueryData(['iam', 'me'])).toMatchObject({ tenant: { alias: 'demo' } });
    expect(onTenant).toHaveBeenCalledWith(expect.objectContaining({ person: expect.objectContaining({ subject: 'sub-anna' }) }));
  });

  it('übernimmt einmal einen früheren Schlüssel der Organisation je Tab (legacyTabKey)', async () => {
    sessionStorage.setItem('app.tab.org', JSON.stringify({ sub: 'sub-anna', alias: 'muster', name: 'Muster GmbH' }));
    const { api } = setup({}, { legacyTabKey: 'app.tab.org' });
    expect(await screen.findByText('App')).toBeInTheDocument();
    expect(api.calls[0]!.headers.get('x-tenant')).toBe('muster');
    expect(sessionStorage.getItem('app.tab.org')).toBeNull();
  });

  it('Sprache und Texte der App gelten für die Bausteine', async () => {
    setup(choose, { locale: 'en', texts: { en: { 'iam.org.choose': 'Pick an organization' } } });
    expect(await screen.findByRole('heading', { name: 'Pick an organization' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    act(() => { /* zurück für die übrigen Tests */ });
  });
});

describe('Name der Organisation (0.3.1)', () => {
  const tenant = ME.tenant!;
  it('leerer Name ohne organizationNames: Alias als Rückfall (auch für den Tab)', () => {
    const me = { ...ME, tenant: { ...tenant, name: '' }, organizationNames: {} };
    expect(orgName(me, tenant.alias)).toBe(tenant.alias);
    expect(tenantName(me)).toBe(tenant.alias);
  });
  it('leerer Eintrag in organizationNames: Name aus tenant, sonst Alias', () => {
    expect(orgName({ ...ME, tenant: { ...tenant, name: 'Demo AG' }, organizationNames: { [tenant.alias]: '' } }, tenant.alias)).toBe('Demo AG');
    expect(orgName({ ...ME, organizationNames: { andere: '' } }, 'andere')).toBe('andere');
    expect(orgName({ ...ME, organizationNames: { andere: 'Andere GmbH' } }, 'andere')).toBe('Andere GmbH');
  });
});

it('Symbole layers, plug und inbox im Satz des Pakets (0.3.1)', () => {
  expect(ICON_NAMES).toEqual(expect.arrayContaining(['layers', 'plug', 'inbox']));
});
