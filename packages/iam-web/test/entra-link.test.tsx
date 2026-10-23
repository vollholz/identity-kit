/**
 * Link an die Entra-Administration (0.2.0): Link erzeugen und Liste im Abschnitt «Anmeldung» (mit Sitzung) sowie die
 * öffentlichen Seiten ohne Sitzung – Freigabe unter `<paths.entra>/freigabe#<token>` und die Rückkehr mit `state` `h.…`.
 * Das Token kommt nur aus dem Fragment, verschwindet danach aus der Adresse und geht nur im Body an die API.
 */
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IamProvider, publicEntraPage, type ConsentLink, type EntraConnection, type IamProviderProps } from '../src/index.ts';
import { EntraScreen, OrganizationScreen } from '../src/pages/index.ts';
import { json, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

const TOKEN = 'demo.h0ver_Tok3n-abcdefghijklmnopqrstuvwxyz01234';
const INFO = { organization: 'Demo AG', product: 'Notizen', requestedBy: 'Anna Admin', tenant: 'demoag.onmicrosoft.com', expiresAt: '2030-01-01T10:00:00.000Z' };
const problem = (status: number, detail: string, extra: Record<string, unknown> = {}) => json({ type: 'about:blank', title: 'Fehler', status, detail, ...extra }, status);

/** Öffentliche Seite über IamProvider (ohne Sitzung) an der echten Adresse. */
function open(url: string, routes: Record<string, MockHandler>, props: Partial<IamProviderProps> = {}) {
  window.history.replaceState(null, '', url);
  const api = mockIamApi(routes);
  vi.stubGlobal('fetch', api.fetch);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<IamProvider product="Notizen" queryClient={qc} features={{ entra: true }} {...props}><p>App</p></IamProvider>);
  return api;
}
const body = async (r: Request) => r.clone().json() as Promise<Record<string, unknown>>;
const pathOf = (r: Request) => new URL(r.url).pathname;

describe('Erkennung der öffentlichen Seiten', () => {
  it('Freigabe und Rückkehr mit h.-state; o./p. und andere Pfade nicht', () => {
    const at = (pathname: string, search = '') => publicEntraPage('/verwalten/anmeldung', { pathname, search });
    expect(at('/verwalten/anmeldung/freigabe')).toBe('handover');
    expect(at('/verwalten/anmeldung/zustimmung', '?state=h.demo.abc&code=c')).toBe('handoverReturn');
    expect(at('/verwalten/anmeldung/zustimmung', '?state=o.demo.abc&code=c')).toBeNull();
    expect(at('/verwalten/anmeldung/zustimmung', '?state=h.Demo.abc')).toBeNull();
    expect(at('/verwalten/anmeldung')).toBeNull();
  });
});

describe('Freigabe für die Entra-Administration (öffentlich)', () => {
  it('ohne /auth/me: Angaben zur Anfrage, Token nur im Body und ohne Sitzungs-Header, Fragment danach entfernt', async () => {
    const api = open(`/verwalten/anmeldung/freigabe#${TOKEN}`, { 'POST /v1/entra/handover/info': () => json(INFO) });
    expect(await screen.findByRole('heading', { name: 'Anmeldung über Microsoft freigeben' })).toBeInTheDocument();
    expect(await screen.findByText('Anna Admin bittet Sie, die Anmeldung von «Demo AG» in Notizen mit Ihrem Microsoft-Verzeichnis zu verbinden.')).toBeInTheDocument();
    expect(screen.getByText(/Sie erteilen Notizen Lesezugriff auf das Microsoft-Verzeichnis demoag\.onmicrosoft\.com/)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Nur zustimmen, wenn Sie die Anfrage von Anna Admin erwarten.');
    expect(screen.getByText('Organisation').nextElementSibling).toHaveTextContent('Demo AG');
    expect(api.calls.some(c => pathOf(c) === '/auth/me')).toBe(false);
    const info = api.calls.find(c => pathOf(c) === '/v1/entra/handover/info')!;
    expect(await body(info)).toEqual({ token: TOKEN });
    expect(info.headers.get('X-Tenant')).toBeNull();
    expect(info.headers.get('X-CSRF-Token')).toBeNull();
    expect(info.credentials).toBe('omit');
    expect(api.calls.every(c => !c.url.includes(TOKEN))).toBe(true);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/verwalten/anmeldung/freigabe');
    expect(await axeProblems(document.body)).toEqual([]);
  });

  it('«Bei Microsoft zustimmen» führt nur zu Microsoft; fremde Adresse ergibt einen Fehler', async () => {
    let url = 'https://evil.example/adminconsent';
    const assign = vi.fn();
    window.history.replaceState(null, '', `/verwalten/anmeldung/freigabe#${TOKEN}`);
    vi.stubGlobal('location', { ...window.location, assign });
    const api = mockIamApi({ 'POST /v1/entra/handover/info': () => json(INFO), 'POST /v1/entra/handover/start': () => json({ url }) });
    vi.stubGlobal('fetch', api.fetch);
    render(<IamProvider product="Notizen" queryClient={new QueryClient()} features={{ entra: true }}><p>App</p></IamProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Bei Microsoft zustimmen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('keine Adresse von Microsoft');
    expect(assign).not.toHaveBeenCalled();
    url = 'https://login.microsoftonline.com/x/oauth2/v2.0/authorize?state=h.demo.abc';
    await userEvent.click(screen.getByRole('button', { name: 'Bei Microsoft zustimmen' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(url));
    expect(await body(api.calls.filter(c => pathOf(c) === '/v1/entra/handover/start')[0]!)).toEqual({ token: TOKEN });
  });

  it('ohne Token im Fragment (oder nach dem Neuladen): «Link unvollständig», kein Aufruf; Token im Suchtext zählt nicht', async () => {
    const api = open(`/verwalten/anmeldung/freigabe?token=${TOKEN}`, {});
    expect(await screen.findByRole('heading', { name: 'Link unvollständig' })).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('Token ohne Alias oder mit falscher Länge: «Link unvollständig», kein Aufruf', async () => {
    for (const bad of [TOKEN.slice(5), `${TOKEN}x`, TOKEN.slice(0, -1), `Demo.${TOKEN.slice(5)}`]) {
      const api = open(`/verwalten/anmeldung/freigabe#${bad}`, {});
      expect(await screen.findByRole('heading', { name: 'Link unvollständig' })).toBeInTheDocument();
      expect(api.calls).toHaveLength(0);
      cleanup();
    }
    const api = open(`/verwalten/anmeldung/freigabe#x.${TOKEN.slice(5)}`, { 'POST /v1/entra/handover/info': () => json(INFO) });
    expect(await screen.findByRole('button', { name: 'Bei Microsoft zustimmen' })).toBeInTheDocument();
    expect(await body(api.calls[0]!)).toEqual({ token: `x.${TOKEN.slice(5)}` });
  });

  it('unbekannt, abgelaufen oder eingelöst (404): «Link ungültig»; anderer Fehler mit «Erneut versuchen»', async () => {
    open(`/verwalten/anmeldung/freigabe#${TOKEN}`, { 'POST /v1/entra/handover/info': () => problem(404, 'Nicht gefunden.') });
    expect(await screen.findByRole('heading', { name: 'Link ungültig' })).toBeInTheDocument();
    expect(screen.getByText(/Bitten Sie die anfragende Person um einen neuen Link/)).toBeInTheDocument();
  });

  it('Serverfehler: Meldung mit «Erneut versuchen»', async () => {
    open(`/verwalten/anmeldung/freigabe#${TOKEN}`, { 'POST /v1/entra/handover/info': () => problem(503, 'Nicht verfügbar.') });
    expect(await screen.findByRole('alert')).toHaveTextContent('Nicht verfügbar.');
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });

  it('nur genau diese zwei Pfade: Rückkehr mit o.-state und andere Seiten unter paths.entra brauchen die Sitzung', async () => {
    for (const url of ['/verwalten/anmeldung/zustimmung?code=c&state=o.demo.abc', '/verwalten/anmeldung/zustimmung?code=c&state=p.muster.abc', '/verwalten/anmeldung/test', '/verwalten/anmeldung/freigabe/x']) {
      const api = open(url, {});
      expect(await screen.findByText('App')).toBeInTheDocument();
      expect(api.calls.some(c => pathOf(c) === '/auth/me')).toBe(true);
      expect(api.calls.some(c => pathOf(c).startsWith('/v1/entra/handover'))).toBe(false);
      cleanup();
    }
  });

  it('ohne features.entra: keine öffentliche Seite, normale Anmeldung über /auth/me', async () => {
    const api = open(`/verwalten/anmeldung/freigabe#${TOKEN}`, {}, { features: {} });
    expect(await screen.findByText('App')).toBeInTheDocument();
    expect(api.calls.some(c => pathOf(c) === '/auth/me')).toBe(true);
    expect(api.calls.some(c => pathOf(c).startsWith('/v1/entra/handover'))).toBe(false);
  });
});

describe('Rückkehr von Microsoft für den Link (öffentlich, state h.)', () => {
  const ret = (search: string, complete: MockHandler) => open(`/verwalten/anmeldung/zustimmung${search}`, { 'POST /v1/entra/handover/complete': complete });

  it('Erfolg: «verbunden, Sie können dieses Fenster schliessen»; ohne Sitzung, Parameter entfernt', async () => {
    const api = ret('?code=c-123&state=h.demo.abc', () => json({ organization: 'Demo AG', connected: true }));
    expect(await screen.findByRole('heading', { name: 'Verbunden' })).toBeInTheDocument();
    expect(screen.getByText('«Demo AG» ist mit Ihrem Microsoft-Verzeichnis verbunden. Sie können dieses Fenster schliessen.')).toBeInTheDocument();
    const c = api.calls.find(r => pathOf(r) === '/v1/entra/handover/complete')!;
    expect(await body(c)).toEqual({ state: 'h.demo.abc', code: 'c-123' });
    expect(c.headers.get('X-CSRF-Token')).toBeNull();
    expect(api.calls.some(r => pathOf(r) === '/auth/me')).toBe(false);
    expect(window.location.search).toBe('');
  });

  it('409 consent-unproven: nötige Rolle im Microsoft-Verzeichnis', async () => {
    ret('?code=c&state=h.demo.abc', () => problem(409, 'Nicht nachweisbar.', { reason: 'consent-unproven' }));
    expect(await screen.findByRole('heading', { name: 'Zustimmung nicht nachweisbar' })).toBeInTheDocument();
    expect(screen.getByText(/globale Administration oder eine Administration für privilegierte Rollen/)).toBeInTheDocument();
  });

  it('409 consent-error (z. B. access_denied): «Nicht zugestimmt» mit Meldung', async () => {
    const api = ret('?state=h.demo.abc&error=access_denied&error_description=AADSTS65004', () => problem(409, 'Die Zustimmung wurde bei Microsoft abgelehnt.', { reason: 'consent-error' }));
    expect(await screen.findByRole('heading', { name: 'Nicht zugestimmt' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Die Zustimmung wurde bei Microsoft abgelehnt.');
    expect(await body(api.calls.find(r => pathOf(r) === '/v1/entra/handover/complete')!)).toEqual({ state: 'h.demo.abc', error: 'access_denied', errorDescription: 'AADSTS65004' });
  });

  it('404 (schon verwendet, abgelaufen): «Bereits abgeschlossen»; h.-state ohne code und error: keine Rückkehr, kein Aufruf', async () => {
    ret('?code=c&state=h.demo.abc', () => problem(404, 'Weg.'));
    expect(await screen.findByRole('heading', { name: 'Bereits abgeschlossen' })).toBeInTheDocument();
  });

  it('h.-state ohne code und ohne error: «Keine Rückkehr von Microsoft», kein Aufruf', async () => {
    const api = ret('?state=h.demo.abc', () => json({}));
    expect(await screen.findByRole('heading', { name: 'Keine Rückkehr von Microsoft' })).toBeInTheDocument();
    expect(api.calls.some(r => pathOf(r) === '/v1/entra/handover/complete')).toBe(false);
  });
});

// --------------------------------------------------------------------------------------- Link erzeugen und Liste

const AT = new Date(Date.now() - 3600_000).toISOString();
const SOON = new Date(Date.now() + 3600_000).toISOString();
const link = (o: Partial<ConsentLink>): ConsentLink => ({
  id: 'l1', entraTenantId: 'demoag.onmicrosoft.com', createdByName: 'Anna Admin', createdAt: AT, expiresAt: SOON, status: 'open', usedAt: null, approverName: null, error: null, ...o,
});
const PENDING: EntraConnection = {
  entraTenantId: '0f0e0d0c-0000-4000-8000-000000000001', entraName: 'Demo AG (Entra)', domains: ['demo.example'], availableDomains: [], stage: 'pending',
  testedAt: null, testedBy: null, enforcedAt: null, enforcedBy: null, testLoginPath: '/auth/login?idp=entra-001&org=demo', status: 'active', lastError: null,
  connectedAt: AT, connectedBy: 'Anna Admin', refreshedAt: AT,
};
function admin(routes: Record<string, MockHandler>, ui = <EntraScreen />, path = '/verwalten/anmeldung') {
  window.history.replaceState(null, '', path);
  const api = mockIamApi(routes);
  vi.stubGlobal('fetch', api.fetch);
  render(<StaticIam config={{ features: { entra: true } }}>{ui}</StaticIam>);
  return api;
}
const notConnected = { 'GET /v1/admin/entra': () => json({ enabled: true, reason: null, connection: null }) };

describe('Link an die Entra-Administration (Abschnitt «Anmeldung»)', () => {
  it('Link erzeugen: Verzeichnis und Gültigkeit, danach Link zum Kopieren mit Hinweis; Liste neu', async () => {
    const u = userEvent.setup();
    const URL_ = `https://notizen.example/verwalten/anmeldung/freigabe#${TOKEN}`;
    let items: ConsentLink[] = [];
    const api = admin({
      ...notConnected,
      'GET /v1/admin/entra/consent-links': () => json({ items }),
      'POST /v1/admin/entra/consent-links': () => { items = [link({})]; return json({ id: 'l1', url: URL_, entraTenantId: 'x', expiresAt: SOON }, 201); },
    });
    await u.click(await screen.findByRole('button', { name: 'Link an die Entra-Administration senden' }));
    const dlg = await screen.findByRole('dialog', { name: 'Link an die Entra-Administration von «Demo AG»' });
    expect(within(dlg).getByRole('button', { name: 'Link erzeugen' })).toBeDisabled();
    await u.type(within(dlg).getByLabelText('Verzeichnis'), 'demoag.onmicrosoft.com');
    expect(within(dlg).getByRole('combobox', { name: 'Gültig' })).toHaveValue('15');
    await u.selectOptions(within(dlg).getByRole('combobox', { name: 'Gültig' }), '60');
    expect(await axeProblems(dlg)).toEqual([]);
    await u.click(within(dlg).getByRole('button', { name: 'Link erzeugen' }));
    const done = await screen.findByRole('dialog', { name: 'Link für «Demo AG» erzeugt' });
    expect(within(done).getByLabelText('Link')).toHaveValue(URL_);
    expect(within(done).getByRole('note')).toHaveTextContent('Nur direkt an die Entra-Administration weitergeben');
    await u.click(within(done).getByRole('button', { name: 'Kopieren' }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(URL_));
    expect(await body(api.calls.find(c => c.method === 'POST')!)).toEqual({ tenant: 'demoag.onmicrosoft.com', validMinutes: 60 });
    await u.click(within(done).getByRole('button', { name: 'Schliessen' }));
    expect(await screen.findByRole('table', { name: /Links an die Entra-Administration von Demo AG/ })).toHaveTextContent('offen');
  });

  it('Fehler beim Erzeugen (422 Tenant nicht gefunden, 409 zu viele offene Links) bleiben im Dialog', async () => {
    let status = 422;
    admin({ ...notConnected, 'GET /v1/admin/entra/consent-links': () => json({ items: [] }),
      'POST /v1/admin/entra/consent-links': () => (status === 422 ? problem(422, 'Kein Microsoft-Verzeichnis zu dieser Domäne gefunden.')
        : problem(409, 'Höchstens 5 offene Links je Organisation.', { reason: 'too-many-links' })) });
    await userEvent.click(await screen.findByRole('button', { name: 'Link an die Entra-Administration senden' }));
    const dlg = await screen.findByRole('dialog', { name: 'Link an die Entra-Administration von «Demo AG»' });
    await userEvent.type(within(dlg).getByLabelText('Verzeichnis'), 'unbekannt.example');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Link erzeugen' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Kein Microsoft-Verzeichnis zu dieser Domäne gefunden.');
    status = 409;
    await userEvent.click(within(dlg).getByRole('button', { name: 'Link erzeugen' }));
    await waitFor(() => expect(within(dlg).getByRole('alert')).toHaveTextContent('Es gibt schon 5 offene Links. Widerrufe zuerst einen Link, den du nicht mehr brauchst.'));
  });

  it('Liste: Status, Zustimmung, Fehlertext; Widerrufen nur offene, 409 bleibt im Dialog und lädt die Liste neu', async () => {
    let fail = true;
    const api = admin({ ...notConnected,
      'GET /v1/admin/entra/consent-links': () => json({ items: [
        link({ id: 'l1' }),
        link({ id: 'l2', status: 'connected', usedAt: AT, approverName: 'Iris IT' }),
        link({ id: 'l3', status: 'failed', usedAt: AT, error: { reason: 'consent-unproven', detail: 'Keine Administration des Verzeichnisses.' } }),
        link({ id: 'l4', status: 'expired' }),
        link({ id: 'l5', status: 'revoked', error: { reason: 'creator-lost-access', detail: 'creator-lost-access' } }),
        link({ id: 'l6', status: 'claimed' as ConsentLink['status'] }),
      ] }),
      'DELETE /v1/admin/entra/consent-links/l1': () => (fail ? problem(409, 'Schon eingelöst.') : new Response(null, { status: 204 })),
    });
    const table = await screen.findByRole('table', { name: /Links an die Entra-Administration/ });
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(table).toHaveTextContent('Automatisch widerrufen: Die Person, die den Link erzeugt hat, darf die Mitglieder nicht mehr verwalten.');
    expect(table).not.toHaveTextContent('creator-lost-access');
    expect(table).toHaveTextContent('in Arbeit');
    expect(table).toHaveTextContent('verbunden');
    expect(table).toHaveTextContent('Zugestimmt von Iris IT');
    expect(table).toHaveTextContent('Keine Administration des Verzeichnisses.');
    expect(within(table).getAllByRole('button', { name: /^Widerrufen/ })).toHaveLength(1);
    await userEvent.click(within(table).getByRole('button', { name: /^Widerrufen/ }));
    const c = await screen.findByRole('alertdialog', { name: 'Link widerrufen?' });
    const lists = () => api.calls.filter(r => r.method === 'GET' && pathOf(r).endsWith('/consent-links')).length;
    const before = lists();
    await userEvent.click(within(c).getByRole('button', { name: 'Widerrufen' }));
    expect(await within(c).findByRole('alert')).toHaveTextContent('Schon eingelöst.');
    await waitFor(() => expect(lists()).toBeGreaterThan(before));
    fail = false;
    await userEvent.click(within(c).getByRole('button', { name: 'Widerrufen' }));
    expect(await screen.findByText('Link widerrufen')).toBeInTheDocument();
  });

  it('verbunden: Knopf neben «Erneut zustimmen» mit dem Verzeichnis vorgegeben; Plattformansicht über die Route der Organisation', async () => {
    const api = admin({
      'GET /v1/admin/status': () => json({ enabled: true, reason: null, organization: 'demo', platformAdmin: true, canManageMembers: true, rolesManageable: true, roles: [] }),
      'GET /v1/platform/organizations/muster': () => json({ id: 'kc-muster', alias: 'muster', name: 'Muster GmbH', description: null, enabled: true, domains: [], tenant: { id: 't', status: 'active', createdAt: AT } }),
      'GET /v1/platform/organizations/muster/members': () => json({ items: [] }),
      'GET /v1/platform/organizations/muster/clients': () => json({ items: [] }),
      'GET /v1/platform/organizations/muster/entra': () => json({ enabled: true, reason: null, connection: PENDING }),
      'GET /v1/platform/organizations/muster/entra/consent-links': () => json({ items: [] }),
    }, <OrganizationScreen />, '/verwalten/organisationen/muster');
    await userEvent.click(await screen.findByRole('button', { name: 'Link an die Entra-Administration senden' }));
    const dlg = await screen.findByRole('dialog', { name: 'Link an die Entra-Administration von «Muster GmbH»' });
    expect(within(dlg).getByLabelText('Verzeichnis')).toHaveValue(PENDING.entraTenantId);
    expect(within(dlg).getByLabelText('Verzeichnis')).toHaveAttribute('readonly');
    expect(api.calls.some(c => pathOf(c) === '/v1/platform/organizations/muster/entra/consent-links')).toBe(true);
  });
});
