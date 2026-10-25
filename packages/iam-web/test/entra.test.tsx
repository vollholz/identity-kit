/**
 * Anmeldung über Microsoft Entra ID (Spezifikation 9.4, nur mit `features.entra`): Status, Verbinden (Navigation zu
 * Microsoft), Rückkehr, Testanmeldung, «Nur Entra» mit Bestätigung der Liste, Trennen; «Person hinzufügen» aus dem
 * Verzeichnis.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { iamRoutes, makeIamRoutes, type EntraConnection, type IamConfig, type Me, type Member } from '../src/index.ts';
import { EntraConsentReturn, EntraScreen, EntraTestReturn, MembersScreen, OrganizationScreen } from '../src/pages/index.ts';
import { authLink, isConsentUrl } from '../src/client.ts';
import { accountInfo, CATALOG, json, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

const AT = new Date(Date.now() - 3600_000).toISOString();
const CONN: EntraConnection = {
  entraTenantId: '0f0e0d0c-0000-4000-8000-000000000001', entraName: 'Demo AG (Entra)', domains: ['demo.example'], availableDomains: ['extra.example'],
  stage: 'enforced', testedAt: AT, testedBy: 'Anna Admin', enforcedAt: AT, enforcedBy: 'Anna Admin', testLoginPath: '/auth/login?idp=entra-001&org=demo&returnTo=%2Fverwalten%2Fanmeldung%2Ftest',
  status: 'active', lastError: null, connectedAt: AT, connectedBy: 'Anna Admin', refreshedAt: AT,
};
const PENDING: EntraConnection = { ...CONN, stage: 'pending', testedAt: null, testedBy: null, enforcedAt: null, enforcedBy: null };
const RESULT = { connection: PENDING, rejectedDomains: ['muster.example'], members: [
  { email: 'anna@demo.example', name: 'Anna Admin', linked: true, reason: null },
  { email: 'carla@demo.example', name: 'Carla Gast', linked: false, reason: 'Gastkonto in Entra ID' },
] };
const ENTRA: Partial<IamConfig> = { features: { entra: true } };

function setup(ui: ReactElement, routes: Record<string, MockHandler>, o: { path?: string; me?: Partial<Me>; config?: Partial<IamConfig> } = {}) {
  window.history.replaceState(null, '', o.path ?? '/verwalten/anmeldung');
  const api = mockIamApi(routes);
  vi.stubGlobal('fetch', api.fetch);
  return { ...api, ...render(<StaticIam me={o.me} config={o.config ?? ENTRA}>{ui}</StaticIam>) };
}
const status = (connection: EntraConnection | null) => ({ 'GET /v1/admin/entra': () => json({ enabled: true, reason: null, connection }) });
const problem = (status: number, detail: string, extra: Record<string, unknown> = {}) =>
  json({ type: 'about:blank', title: 'Fehler', status, detail, ...extra }, status, { 'Content-Type': 'application/problem+json' });
/** Pfade, die nicht zur App gehören oder nicht unter «/auth/» liegen. */
const FOREIGN = ['//evil.example/auth/x', '@evil.example/x', '/\\evil.example/auth/x', 'https://evil.example/auth/x', '/verwalten/x', '/auth/../verwalten'];

describe('Adressen vom Server', () => {
  it('authLink: nur Pfade unter «/auth/» dieser Herkunft, sonst null', () => {
    expect(authLink('/auth/entra/entra-001?org=demo')).toBe(`${window.location.origin}/auth/entra/entra-001?org=demo`);
    for (const p of [...FOREIGN, '', null, undefined]) expect(authLink(p)).toBeNull();
  });

  it('isConsentUrl: nur https und Hosts aus der Liste', () => {
    const hosts = ['login.microsoftonline.com'];
    expect(isConsentUrl('https://login.microsoftonline.com/x/v2.0/adminconsent', hosts)).toBe(true);
    for (const u of ['http://login.microsoftonline.com/x', 'https://evil.example/x', 'https://login.microsoftonline.com.evil.example/x', 'https://user@evil.example/x', 'javascript:alert(1)', '/relativ'])
      expect(isConsentUrl(u, hosts)).toBe(false);
    expect(isConsentUrl('https://login.microsoftonline.us/x', [...hosts, 'login.microsoftonline.us'])).toBe(true);
  });
});

describe('Anmeldung (Microsoft Entra ID)', () => {
  it('nicht verbunden: Erklärung und «Mit Entra ID verbinden»; der Dialog führt zu Microsoft', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const { calls } = setup(<EntraScreen />, { ...status(null), 'POST /v1/admin/entra/consent': () => json({ url: 'https://login.microsoftonline.com/x/v2.0/adminconsent?state=o.demo.abc', entraTenantId: 'x' }) });
    expect(await screen.findByRole('heading', { name: 'Nicht verbunden' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mit Entra ID verbinden' }));
    const dlg = await screen.findByRole('dialog', { name: '«Demo AG» mit Entra ID verbinden' });
    expect(dlg).toHaveTextContent('An der Anmeldung ändert sich noch nichts');
    expect(dlg).toHaveTextContent('Gastkonten nie');
    expect(within(dlg).getByRole('button', { name: 'Weiter zu Microsoft' })).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText('Verzeichnis'), 'demoag.onmicrosoft.com');
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Weiter zu Microsoft' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/x/v2.0/adminconsent?state=o.demo.abc'));
    expect(await calls.find(c => c.method === 'POST')!.clone().json()).toEqual({ tenant: 'demoag.onmicrosoft.com' });
  });

  it('verbunden: Verzeichnis und Domänen; Trennen nur mit Bestätigung und Hinweis, dass die Anmeldung danach nicht mehr geht', async () => {
    const { calls } = setup(<EntraScreen />, { ...status(CONN), 'DELETE /v1/admin/entra': () => new Response(null, { status: 204 }) });
    expect((await screen.findAllByText('Nur Entra aktiv')).length).toBeGreaterThan(0);
    expect(screen.getByRole('list', { name: 'Gebundene Domänen' })).toHaveTextContent('@demo.example');
    expect(screen.getByRole('button', { name: /Domänen wählen \(1 weitere verifiziert\)/ })).toBeInTheDocument();
    expect(await axeProblems()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Trennen …' }));
    const dlg = await screen.findByRole('alertdialog', { name: '«Demo AG» von Entra ID trennen?' });
    expect(dlg).toHaveTextContent('@demo.example können sich danach nicht mehr anmelden');
    expect(dlg).toHaveTextContent('Konten, Rollen und Daten bleiben');
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Trennen' }));
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE')).toBe(true));
    expect(await screen.findByText('«Demo AG» von Entra ID getrennt')).toBeInTheDocument();
  });

  it('Schritt 2: Testanmeldung als Link, «Nur Entra aktivieren» gesperrt bis zum Test', async () => {
    setup(<EntraScreen />, status(PENDING));
    expect(await screen.findByText('verbunden, noch nicht aktiv')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Testanmeldung mit Microsoft' })).toHaveAttribute('href', `${window.location.origin}${PENDING.testLoginPath}`);
    expect(screen.getByRole('button', { name: 'Link für eine andere Person kopieren' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nur Entra aktivieren …' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('«Nur Entra» aktivieren: Liste «verlieren die Anmeldung», erst nach Bestätigung; geänderte Liste erneut bestätigen', async () => {
    const lost = [{ email: 'carla@demo.example', name: 'Carla Gast', linked: false, reason: 'Gastkonto in Entra ID' }];
    let attempt = 0;
    const { calls } = setup(<EntraScreen />, {
      ...status({ ...PENDING, testedAt: AT, testedBy: 'Olga Extra' }),
      'GET /v1/admin/entra/preview': () => json({ members: [{ email: 'anna@demo.example', name: 'Anna Admin', linked: true, reason: null }, ...lost] }),
      'POST /v1/admin/entra/enforce': () => (++attempt === 1
        ? json({ title: 'Konflikt', status: 409, reason: 'confirm-not-linked', notLinked: [...lost, { email: 'dana@demo.example', name: 'Dana Fehlt', linked: false, reason: 'In Entra ID nicht gefunden' }] }, 409)
        : json({ ...RESULT, connection: CONN })),
    });
    expect((await screen.findByText(/Testanmeldung erfolgreich/)).closest('li')).toHaveTextContent('Olga Extra');
    await userEvent.click(screen.getByRole('button', { name: 'Nur Entra aktivieren …' }));
    const dlg = await screen.findByRole('alertdialog', { name: '«Nur Entra» für «Demo AG» aktivieren?' });
    const list = await within(dlg).findByRole('list', { name: 'Verlieren die Anmeldung' });
    expect(list).toHaveTextContent('Carla Gast');
    expect(dlg).toHaveTextContent('1 Mitglied verliert die Anmeldung');
    expect(dlg).toHaveTextContent('Auch du meldest dich danach mit Microsoft an.');
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    const go = within(dlg).getByRole('button', { name: 'Nur Entra aktivieren' });
    expect(go).toBeDisabled();
    await userEvent.click(within(dlg).getByLabelText(/Verstanden/));
    await userEvent.click(go);
    // Liste hat sich geändert: neu anzeigen, Bestätigung zurückgesetzt
    expect(await within(dlg).findByText(/Dana Fehlt/)).toBeInTheDocument();
    expect(within(dlg).getByLabelText(/Verstanden/)).not.toBeChecked();
    expect(within(dlg).getByRole('status')).toHaveTextContent('Die Liste hat sich inzwischen geändert');
    await userEvent.click(within(dlg).getByLabelText(/Verstanden/));
    await userEvent.click(go);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const posts = calls.filter(c => c.method === 'POST');
    expect(await posts[0]!.clone().json()).toEqual({ notLinked: ['carla@demo.example'] });
    expect(await posts[1]!.clone().json()).toEqual({ notLinked: ['carla@demo.example', 'dana@demo.example'] });
    expect(await screen.findByText('«Nur Entra» für «Demo AG» aktiviert')).toBeInTheDocument();
  });

  it('Domänen wählen: abgewählte Domäne mit Mitgliedern, die die Anmeldung verlieren, erst nach Bestätigung', async () => {
    let attempt = 0;
    const { calls } = setup(<EntraScreen />, {
      ...status(CONN),
      'PUT /v1/admin/entra/domains': () => (++attempt === 1
        ? json({ title: 'Konflikt', status: 409, reason: 'confirm-not-linked', notLinked: [{ email: 'eva@extra.example', name: 'Eva Extra', linked: false, reason: 'In Entra ID nicht gefunden' }] }, 409)
        : json({ ...RESULT, connection: { ...CONN, domains: ['demo.example', 'extra.example'], availableDomains: [] }, members: [] })),
    });
    await userEvent.click(await screen.findByRole('button', { name: /Domänen wählen/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Domänen für «Demo AG»' });
    await userEvent.click(within(dlg).getByRole('checkbox', { name: '@extra.example' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    expect(await within(dlg).findByRole('list', { name: 'Verlieren die Anmeldung' })).toHaveTextContent('Eva Extra');
    expect(within(dlg).getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await userEvent.click(within(dlg).getByLabelText(/Verstanden/));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Domänen für «Demo AG» gespeichert')).toBeInTheDocument();
    const puts = calls.filter(c => c.method === 'PUT');
    expect(await puts[0]!.clone().json()).toEqual({ domains: ['demo.example', 'extra.example'] });
    expect(await puts[1]!.clone().json()).toEqual({ domains: ['demo.example', 'extra.example'], notLinked: ['eva@extra.example'] });
  });

  it('Rückkehr von Microsoft: meldet die Parameter der API und zeigt verknüpfte und nicht verknüpfte Mitglieder', async () => {
    const { calls } = setup(<EntraConsentReturn />, { 'POST /v1/admin/entra/consent/complete': () => json(RESULT) },
      { path: '/verwalten/anmeldung/zustimmung?code=0.AAA-code&state=o.demo.abc&session_state=x' });
    expect(await screen.findByText(/Verbunden mit «Demo AG \(Entra\)»/)).toBeInTheDocument();
    expect(screen.getByText(/1 Mitglied mit Microsoft verknüpft/)).toHaveTextContent('gehören einer anderen Organisation): muster.example');
    expect(screen.getByText(/Carla Gast/).closest('li')).toHaveTextContent('Gastkonto in Entra ID');
    expect(screen.getByRole('note')).toHaveTextContent('Nächster Schritt: Testanmeldung mit Microsoft');
    expect(screen.getByRole('link', { name: 'Weiter' })).toHaveAttribute('href', '/verwalten/anmeldung');
    const body = await calls.find(c => c.method === 'POST')!.clone().json();
    expect(body).toEqual({ state: 'o.demo.abc', code: '0.AAA-code' });
    // Parameter aus der Adresse entfernt (replace), das Ergebnis bleibt sichtbar
    expect(window.location.pathname).toBe('/verwalten/anmeldung/zustimmung');
    expect(window.location.search).toBe('');
    expect(screen.getByText(/Verbunden mit «Demo AG \(Entra\)»/)).toBeInTheDocument();
  });

  it('Rückkehr nach einem Neuladen (404 von der API): «Bereits abgeschlossen» statt Fehler', async () => {
    setup(<EntraConsentReturn />, { 'POST /v1/admin/entra/consent/complete': () => problem(404, 'Die Zustimmung ist abgelaufen, wurde schon verwendet …') },
      { path: '/verwalten/anmeldung/zustimmung?state=o.demo.abc&code=c1' });
    expect(await screen.findByRole('heading', { name: 'Bereits abgeschlossen' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('link', { name: 'Weiter' })).toHaveAttribute('href', '/verwalten/anmeldung');
  });

  it('Rückkehr mit error=access_denied: Parameter gehen an die API, deren Meldung erscheint', async () => {
    const { calls } = setup(<EntraConsentReturn />, { 'POST /v1/admin/entra/consent/complete': () => problem(409, 'Die Zustimmung wurde bei Microsoft abgelehnt.', { reason: 'consent-error', code: 'access_denied' }) },
      { path: '/verwalten/anmeldung/zustimmung?state=o.demo.abc&error=access_denied&error_description=AADSTS65004%3A+declined' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Zustimmung wurde bei Microsoft abgelehnt.');
    expect(await calls.find(c => c.method === 'POST')!.clone().json()).toEqual({ state: 'o.demo.abc', error: 'access_denied', errorDescription: 'AADSTS65004: declined' });
    expect(screen.getByRole('link', { name: 'Weiter' })).toBeInTheDocument();
  });

  it('Rückkehr mit `state` in fremdem Format: kein Aufruf, «Keine Rückkehr von Microsoft»', async () => {
    for (const state of ['x.demo.abc', 'o.Demo.abc', 'o.demo', 'o.demo.a/b', 'p..abc', `o.${'a'.repeat(64)}.abc`]) {
      const { calls, unmount } = setup(<EntraConsentReturn />, {}, { path: `/verwalten/anmeldung/zustimmung?state=${encodeURIComponent(state)}&code=c1` });
      expect(await screen.findByRole('heading', { name: 'Keine Rückkehr von Microsoft' })).toBeInTheDocument();
      expect(calls.some(c => c.url.includes('/entra/'))).toBe(false);
      unmount();
    }
  });

  it('Rückkehr der Plattform-Administration: Organisation aus `state`, zurück zur Organisation', async () => {
    const { calls } = setup(<EntraConsentReturn />, { 'POST /v1/platform/organizations/muster/entra/consent/complete': () => json(RESULT) },
      { path: '/verwalten/anmeldung/zustimmung?state=p.muster.abc&code=c1' });
    expect(await screen.findByText(/Verbunden mit/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zurück zur Organisation' })).toHaveAttribute('href', '/verwalten/organisationen/muster');
    expect(calls.some(c => c.url.endsWith('/v1/platform/organizations/muster/entra/consent/complete'))).toBe(true);
  });

  it('Rückkehr für eine andere Organisation des Tabs: kein Aufruf, Hinweis; ohne Parameter: Hinweis', async () => {
    const { calls, unmount } = setup(<EntraConsentReturn />, {}, { path: '/verwalten/anmeldung/zustimmung?state=o.muster.abc&code=c1' });
    expect(await screen.findByRole('heading', { name: 'Andere Organisation' })).toBeInTheDocument();
    expect(calls.some(c => c.url.includes('/entra/'))).toBe(false);
    unmount();
    setup(<EntraConsentReturn />, {}, { path: '/verwalten/anmeldung/zustimmung' });
    expect(await screen.findByRole('heading', { name: 'Keine Rückkehr von Microsoft' })).toBeInTheDocument();
  });

  it('Rückkehrpfade des Servers passen nicht zu paths.entra: Warnung in der Konsole', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setup(<EntraScreen />, { 'GET /v1/admin/entra': () => json({ enabled: true, reason: null, connection: PENDING, consentPath: '/admin/entra/zustimmung', testPath: '/admin/entra/test' }) });
    await screen.findByText('verbunden, noch nicht aktiv');
    await waitFor(() => expect(warn.mock.calls.some(c => String(c[0]).includes('passen nicht zu paths.entra (/verwalten/anmeldung)'))).toBe(true));
    warn.mockRestore();
  });

  it('Rückkehr mit `state`, aber ohne `code` und ohne `error`: «Keine Rückkehr von Microsoft», kein Aufruf', async () => {
    const { calls } = setup(<EntraConsentReturn />, {}, { path: '/verwalten/anmeldung/zustimmung?state=o.demo.abc&admin_consent=True' });
    expect(await screen.findByRole('heading', { name: 'Keine Rückkehr von Microsoft' })).toBeInTheDocument();
    expect(calls.some(c => c.url.includes('/entra/'))).toBe(false);
  });

  it('409 consent-unproven: Zustimmung nicht nachweisbar, mit Hinweis auf die nötige Rolle im Tenant', async () => {
    setup(<EntraConsentReturn />, { 'POST /v1/admin/entra/consent/complete': () => problem(409, 'Nicht nachweisbar.', { reason: 'consent-unproven' }) },
      { path: '/verwalten/anmeldung/zustimmung?state=o.demo.abc&code=c1' });
    expect(await screen.findByRole('heading', { name: 'Zustimmung nicht nachweisbar' })).toBeInTheDocument();
    expect(screen.getByText('Die Zustimmung muss eine globale Administration oder eine Administration für privilegierte Rollen des Microsoft-Verzeichnisses erteilen.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Weiter' })).toBeInTheDocument();
  });

  it('Vorschau «Nur Entra»: wer Passwort und Passkey behält, steht mit Grund neben der Person', async () => {
    setup(<EntraScreen />, {
      ...status({ ...PENDING, testedAt: AT, testedBy: 'Olga Extra' }),
      'GET /v1/admin/entra/preview': () => json({ members: [
        { email: 'anna@demo.example', name: 'Anna Admin', linked: true, reason: null, passwordKept: 'Konto der Plattform-Administration' },
        { email: 'carla@demo.example', name: 'Carla Gast', linked: false, reason: 'Gastkonto in Entra ID', passwordKept: 'Notfallzugang' },
      ] }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Nur Entra aktivieren …' }));
    const dlg = await screen.findByRole('alertdialog', { name: '«Nur Entra» für «Demo AG» aktivieren?' });
    expect(await within(dlg).findByRole('list', { name: 'Behalten Passwort und Passkey' })).toHaveTextContent('Anna Admin anna@demo.example · Passwort bleibt: Konto der Plattform-Administration');
    expect(within(dlg).getByRole('list', { name: 'Verlieren die Anmeldung' })).toHaveTextContent('Carla Gast carla@demo.example – Gastkonto in Entra ID · Passwort bleibt: Notfallzugang');
  });

  it('Rückkehr der Testanmeldung meldet sie der API (jede Person der Organisation)', async () => {
    const { calls } = setup(<EntraTestReturn />, { 'POST /v1/admin/entra/test': () => json({ ...PENDING, testedAt: AT, testedBy: 'Anna Admin' }) },
      { path: '/verwalten/anmeldung/test', me: { roles: ['viewer'], permissions: ['tenant:read', 'note:read'] } });
    expect(await screen.findByText(/Testanmeldung erfolgreich/)).toBeInTheDocument();
    expect(calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/admin/entra/test'))).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Zur Übersicht' })).toHaveAttribute('href', '/');
  });

  it('Rückkehr der Testanmeldung mit 403: Meldung der API', async () => {
    setup(<EntraTestReturn />, { 'POST /v1/admin/entra/test': () => problem(403, 'Diese Sitzung ist nicht über Microsoft angemeldet.') }, { path: '/verwalten/anmeldung/test' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Diese Sitzung ist nicht über Microsoft angemeldet.');
    expect(screen.queryByText(/Testanmeldung erfolgreich/)).toBeNull();
  });

  it('Testanmeldung und Anmeldelink nur für Pfade unter «/auth/» dieser App', async () => {
    for (const testLoginPath of FOREIGN) {
      const { unmount } = setup(<EntraScreen />, status({ ...PENDING, testLoginPath }));
      expect(await screen.findByText('verbunden, noch nicht aktiv')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Testanmeldung mit Microsoft' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Link für eine andere Person kopieren' })).toBeNull();
      unmount();
    }
  });

  it('Verbinden: Adresse ausserhalb von Microsoft wird nicht geöffnet, Fehler im Dialog; weitere Hosts per entraConsentHosts', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    let url = 'https://evil.example/adminconsent?state=o.demo.abc';
    setup(<EntraScreen />, { ...status(null), 'POST /v1/admin/entra/consent': () => json({ url, entraTenantId: 'x' }) },
      { config: { ...ENTRA, entraConsentHosts: ['login.microsoftonline.us'] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Mit Entra ID verbinden' }));
    const dlg = await screen.findByRole('dialog', { name: '«Demo AG» mit Entra ID verbinden' });
    await userEvent.type(within(dlg).getByLabelText('Verzeichnis'), 'demoag.onmicrosoft.com');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Weiter zu Microsoft' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('keine Adresse von Microsoft');
    expect(assign).not.toHaveBeenCalled();
    url = 'https://login.microsoftonline.us/x/v2.0/adminconsent?state=o.demo.abc';
    await userEvent.click(within(dlg).getByRole('button', { name: 'Weiter zu Microsoft' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(url));
  });

  it('Verbinden: Fehler der API bleibt im Dialog, keine Navigation', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    setup(<EntraScreen />, { ...status(null), 'POST /v1/admin/entra/consent': () => problem(422, 'Kein Microsoft-Verzeichnis zu dieser Domäne gefunden.') });
    await userEvent.click(await screen.findByRole('button', { name: 'Mit Entra ID verbinden' }));
    const dlg = await screen.findByRole('dialog', { name: '«Demo AG» mit Entra ID verbinden' });
    await userEvent.type(within(dlg).getByLabelText('Verzeichnis'), 'unbekannt.example');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Weiter zu Microsoft' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Kein Microsoft-Verzeichnis zu dieser Domäne gefunden.');
    expect(assign).not.toHaveBeenCalled();
  });

  it('Aktualisieren gescheitert: Meldung, Verbindung bleibt angezeigt', async () => {
    setup(<EntraScreen />, { ...status(CONN), 'POST /v1/admin/entra/refresh': () => problem(502, 'Microsoft Graph ist nicht erreichbar.') });
    await userEvent.click(await screen.findByRole('button', { name: 'Aktualisieren' }));
    expect(await screen.findByText(/Aktualisieren gescheitert/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Gebundene Domänen' })).toHaveTextContent('@demo.example');
  });

  it('Routen und Organisation: nur mit features.entra (Seite, Rückkehrseiten, Abschnitt im Detail)', async () => {
    expect(iamRoutes.map(r => r.id)).not.toContain('entra');
    expect(makeIamRoutes({}, { entra: true }).filter(r => r.id.startsWith('entra')).map(r => [r.id, r.path, r.need, r.nav])).toEqual([
      ['entra', '/verwalten/anmeldung', { perm: 'members:admin' }, true],
      ['entraConsent', '/verwalten/anmeldung/zustimmung', null, false],
      ['entraTest', '/verwalten/anmeldung/test', null, false],
    ]);
    const org = { id: 'kc-muster', alias: 'muster', name: 'Muster GmbH', description: null, enabled: true, domains: [], tenant: null };
    const routes = {
      'GET /v1/account': () => json(accountInfo({ platformAdmin: true })),
      'GET /v1/platform/organizations/muster': () => json(org), 'GET /v1/platform/organizations/muster/members': () => json({ items: [] }),
      'GET /v1/platform/organizations/muster/entra': () => json({ enabled: true, reason: null, connection: null }),
    };
    const { unmount, calls } = setup(<OrganizationScreen />, routes, { path: '/verwalten/organisationen/muster', config: {} });
    await screen.findByRole('heading', { name: 'Angaben' });
    expect(screen.queryByRole('heading', { name: 'Anmeldung (Microsoft Entra ID)' })).toBeNull();
    expect(calls.some(c => c.url.includes('/entra'))).toBe(false);
    unmount();
    setup(<OrganizationScreen />, routes, { path: '/verwalten/organisationen/muster' });
    expect(await screen.findByRole('heading', { name: 'Anmeldung (Microsoft Entra ID)' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Mit Entra ID verbinden' })).toBeInTheDocument();
  });
});

describe('Person aus Entra ID hinzufügen', () => {
  const ANNA: Member = { id: 'sub-anna', kind: 'user', principalId: 'p1', username: 'anna', name: 'Anna Admin', email: 'anna@demo.example', status: 'active', roles: ['org-admin'], clearance: 2, breakGlassUntil: null, places: 0, lastSeenAt: new Date().toISOString(), createdAt: null, loginPath: null, clientId: null, scopes: null, description: null };
  const NINA: Member = { id: 'm-nina', kind: 'user', principalId: 'p-new', username: 'nina@demo.example', name: 'Nina Neu', email: 'nina@demo.example', status: 'invited', roles: ['viewer'], lastSeenAt: null, createdAt: new Date().toISOString(), loginPath: '/auth/entra/entra-001?org=demo', clearance: 0, breakGlassUntil: null, places: 0, clientId: null, scopes: null, description: null };
  const STATUS = { enabled: true, reason: null, organization: 'demo', platformAdmin: false, canManageMembers: true, roles: CATALOG.roles };
  const HITS = { more: false, items: [
    { id: '11111111-0000-4000-8000-000000000001', name: 'Nina Neu', email: 'nina@demo.example', userPrincipalName: 'nina@demo.example', department: 'Planung', jobTitle: 'Planerin', selectable: true, reason: null },
    { id: '11111111-0000-4000-8000-000000000002', name: 'Nora Gast', email: 'nora@gmail.example', userPrincipalName: 'nora_gmail.example#EXT#@demo.onmicrosoft.com', department: null, jobTitle: null, selectable: false, reason: 'Gastkonto in Entra ID' },
  ] };
  const members = (connection: EntraConnection | null, extra: Record<string, MockHandler> = {}, config: Partial<IamConfig> = ENTRA) => setup(<MembersScreen />, {
    'GET /v1/admin/status': () => json(STATUS), 'GET /v1/admin/members': () => json({ items: [ANNA, NINA] }), ...status(connection), ...extra,
  }, { path: '/verwalten/mitglieder', config });

  it('ohne Verbindung oder ohne features.entra bleibt «Person einladen» mit E-Mail-Formular', async () => {
    const { unmount, calls } = members(PENDING, {}, {});
    await screen.findByRole('table', { name: 'Mitglieder von Demo AG mit Rollen' });
    expect(screen.getAllByRole('button', { name: 'Person einladen' })).toHaveLength(1);
    expect(calls.some(c => c.url.includes('/entra'))).toBe(false);
    unmount();
    members(null);
    await screen.findByRole('table', { name: 'Mitglieder von Demo AG mit Rollen' });
    await userEvent.click(screen.getByRole('button', { name: 'Person einladen' }));
    expect(await screen.findByRole('dialog', { name: 'Person zu «Demo AG» einladen' })).toBeInTheDocument();
    expect(screen.getByLabelText('E-Mail')).toBeInTheDocument();
  });

  it('verbunden: suchen, nicht wählbare ausgegraut mit Grund, wählen, Rollen, ohne E-Mail → Link zum Weitergeben', async () => {
    const { calls } = members(PENDING, {
      'GET /v1/admin/members/entra-search': () => json(HITS),
      'POST /v1/admin/members/entra': () => json({ result: 'added', emailSent: false, member: { ...NINA, roles: ['viewer'] } }, 202),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Person hinzufügen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Person zu «Demo AG» hinzufügen' });
    expect(within(dlg).getByRole('button', { name: 'Hinzufügen' })).toBeDisabled();
    await userEvent.type(within(dlg).getByRole('searchbox', { name: 'Im Verzeichnis suchen' }), 'n');
    expect(dlg).toHaveTextContent('Mindestens 2 Zeichen');
    await userEvent.type(within(dlg).getByRole('searchbox', { name: 'Im Verzeichnis suchen' }), 'i');
    const list = await within(dlg).findByRole('list', { name: 'Treffer im Verzeichnis' });
    expect(new URL(calls.find(c => c.url.includes('entra-search'))!.url).searchParams.get('q')).toBe('ni');
    const gast = within(list).getByRole('button', { name: /Nora Gast/ });
    // aria-disabled statt disabled: bleibt per Tastatur erreichbar, damit der Grund vorgelesen wird
    expect(gast).toHaveAttribute('aria-disabled', 'true');
    expect(gast).toHaveAccessibleDescription('Gastkonto in Entra ID');
    await userEvent.click(gast);
    expect(within(dlg).getByRole('list', { name: 'Treffer im Verzeichnis' })).toBeInTheDocument();
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(list).getByRole('button', { name: /Nina Neu/ }));
    expect(dlg).toHaveTextContent('Planerin · Planung');
    expect(within(dlg).getAllByRole('group', { name: 'Rollen' })[0]).toHaveClass('iam-role-pick');
    await userEvent.click(within(dlg).getByLabelText('Einladung per E-Mail senden'));
    expect(dlg).toHaveTextContent('Danach erhältst du einen Link');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    const done = await screen.findByRole('dialog', { name: 'Nina Neu hinzugefügt' });
    const post = calls.find(c => c.method === 'POST' && c.url.endsWith('/v1/admin/members/entra'))!;
    expect(await post.clone().json()).toEqual({ id: HITS.items[0]!.id, roles: ['viewer'], sendEmail: false });
    expect(within(done).getByLabelText('Anmeldelink')).toHaveValue(`${window.location.origin}/auth/entra/entra-001?org=demo`);
    expect(done).toHaveTextContent('Nina Neu ist Mitglied von «Demo AG» mit der Rolle Leser:in und meldet sich über Microsoft an.');
    expect(done).not.toHaveTextContent('konnte die Einladung nicht per E-Mail senden');
  });

  it('mit E-Mail, aber nicht gesendet: Hinweis noMail und Link zum Weitergeben', async () => {
    members(PENDING, {
      'GET /v1/admin/members/entra-search': () => json(HITS),
      'POST /v1/admin/members/entra': () => json({ result: 'added', emailSent: false, member: NINA }, 202),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Person hinzufügen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Person zu «Demo AG» hinzufügen' });
    await userEvent.type(within(dlg).getByRole('searchbox', { name: 'Im Verzeichnis suchen' }), 'ni');
    await userEvent.click(await within(dlg).findByRole('button', { name: /Nina Neu/ }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    const done = await screen.findByRole('dialog', { name: 'Nina Neu hinzugefügt' });
    expect(within(done).getByRole('alert')).toHaveTextContent('konnte die Einladung nicht per E-Mail senden');
    expect(within(done).getByLabelText('Anmeldelink')).toHaveValue(`${window.location.origin}${NINA.loginPath}`);
  });

  it('fremder loginPath: kein Link im Ergebnis und kein «Anmeldelink kopieren» im Menü', async () => {
    const EVIL = { ...NINA, loginPath: '//evil.example/auth/x' };
    members(PENDING, {
      'GET /v1/admin/members': () => json({ items: [ANNA, EVIL] }),
      'GET /v1/admin/members/entra-search': () => json(HITS),
      'POST /v1/admin/members/entra': () => json({ result: 'added', emailSent: false, member: { ...NINA, loginPath: '@evil.example/x' } }, 202),
    });
    const table = await screen.findByRole('table', { name: 'Mitglieder von Demo AG mit Rollen' });
    const row = within(table).getByText('Nina Neu').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Mehr zu Nina Neu' }));
    expect(within(await screen.findByRole('menu')).queryByRole('menuitem', { name: 'Anmeldelink kopieren' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Person hinzufügen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Person zu «Demo AG» hinzufügen' });
    await userEvent.type(within(dlg).getByRole('searchbox', { name: 'Im Verzeichnis suchen' }), 'ni');
    await userEvent.click(await within(dlg).findByRole('button', { name: /Nina Neu/ }));
    await userEvent.click(within(dlg).getByLabelText('Einladung per E-Mail senden'));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    const done = await screen.findByRole('dialog', { name: 'Nina Neu hinzugefügt' });
    expect(within(done).queryByLabelText('Anmeldelink')).toBeNull();
  });

  it('Suche im Verzeichnis gescheitert: Meldung im Dialog', async () => {
    members(PENDING, { 'GET /v1/admin/members/entra-search': () => problem(502, 'Microsoft Graph ist nicht erreichbar.') });
    await userEvent.click(await screen.findByRole('button', { name: 'Person hinzufügen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Person zu «Demo AG» hinzufügen' });
    await userEvent.type(within(dlg).getByRole('searchbox', { name: 'Im Verzeichnis suchen' }), 'ni');
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Microsoft Graph ist nicht erreichbar.');
  });

  it('externe Person: Wechsel zu «Per E-Mail einladen»', async () => {
    members(PENDING);
    await userEvent.click(await screen.findByRole('button', { name: 'Person hinzufügen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Person zu «Demo AG» hinzufügen' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Per E-Mail einladen' }));
    expect(await screen.findByRole('dialog', { name: 'Person zu «Demo AG» einladen' })).toBeInTheDocument();
  });

  it('offene Einladung aus Entra ID: «Anmeldelink kopieren» im Menü', async () => {
    // user-event ersetzt die Zwischenablage durch eine eigene Nachbildung
    const u = userEvent.setup();
    members(PENDING);
    const table = await screen.findByRole('table', { name: 'Mitglieder von Demo AG mit Rollen' });
    const row = within(table).getByText('Nina Neu').closest('tr')!;
    expect(within(row).getByText('eingeladen')).toHaveAttribute('title', 'Hat sich noch nie über Microsoft angemeldet');
    await u.click(within(row).getByRole('button', { name: 'Mehr zu Nina Neu' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Anmeldelink kopieren' }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/auth/entra/entra-001?org=demo`));
    expect(await screen.findByText('Anmeldelink für Nina Neu kopiert')).toBeInTheDocument();
  });
});
