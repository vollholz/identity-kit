/**
 * Eigene App-Registrierung (0.3.0): Wege je nach `methods` des Servers, Dialog mit Anleitung und Feldern, Fehler mit
 * eigenem Text, Secret wechseln mit Ablauf und Warnung, Link «Credentials eintragen» und seine öffentliche Seite («Sie»)
 * mit denselben Schutzmassnahmen für das Token wie 0.2.0.
 */
import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IamProvider, type EntraConnection, type EntraStatus } from '../src/index.ts';
import { EntraScreen } from '../src/pages/index.ts';
import { json, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

const TOKEN = 'demo.h0ver_Tok3n-abcdefghijklmnopqrstuvwxyz01234';
const TID = '3f2b6c1e-8a4d-4f0e-9c7b-1d2e3f4a5b6c';
const CID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const AT = new Date(Date.now() - 3600_000).toISOString();
const GUIDE = {
  redirectUri: 'https://login.notizen.example/realms/notizen/broker/entra-demo/endpoint',
  permissions: [
    { name: 'User.Read', type: 'Delegated' as const, why: 'Anmeldung', optional: false },
    { name: 'User.Read.All', type: 'Application' as const, why: 'Personen der Domänen lesen und verknüpfen', optional: false },
    { name: 'Application.Read.All', type: 'Application' as const, why: 'Ablauf des Secrets lesen', optional: true },
  ],
};
const problem = (status: number, detail: string, extra: Record<string, unknown> = {}) => json({ type: 'about:blank', title: 'Fehler', status, detail, ...extra }, status);
const OWN: EntraConnection = {
  entraTenantId: TID, entraName: 'Demo AG (Entra)', domains: ['demo.example'], availableDomains: [], stage: 'pending',
  testedAt: null, testedBy: null, enforcedAt: null, enforcedBy: null, testLoginPath: '/auth/login?idp=entra-001&org=demo', status: 'active', lastError: null,
  connectedAt: AT, connectedBy: 'Anna Admin', refreshedAt: AT, method: 'own', clientId: CID, secretExpiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(), secretExpiresSoon: false,
};
const status = (o: Partial<EntraStatus>): EntraStatus => ({ enabled: true, reason: null, connection: null, methods: { platformApp: false, ownApp: true }, ownApp: GUIDE, ...o });

function admin(routes: Record<string, MockHandler>) {
  window.history.replaceState(null, '', '/verwalten/anmeldung');
  const api = mockIamApi({ 'GET /v1/admin/entra/consent-links': () => json({ items: [] }), ...routes });
  vi.stubGlobal('fetch', api.fetch);
  render(<StaticIam config={{ features: { entra: true } }}><EntraScreen /></StaticIam>);
  return api;
}
const bodyOf = async (api: ReturnType<typeof mockIamApi>, method: string, path: string) =>
  api.calls.filter(c => c.method === method && new URL(c.url).pathname === path).at(-1)!.clone().json() as Promise<Record<string, unknown>>;

/** Felder ausfüllen (im Dialog oder auf der öffentlichen Seite). */
async function fill(scope: HTMLElement, v: { tenant?: string; client?: string; secret: string }) {
  if (v.tenant !== undefined) await userEvent.type(within(scope).getByLabelText('Verzeichnis'), v.tenant);
  if (v.client !== undefined) { await userEvent.clear(within(scope).getByLabelText('Anwendungs-ID')); await userEvent.type(within(scope).getByLabelText('Anwendungs-ID'), v.client); }
  await userEvent.type(within(scope).getByLabelText('Geheimer Clientschlüssel (Wert)'), v.secret);
}

describe('Wege je nach Server', () => {
  it('nur eigene App (enabled false: keine App der Plattform): «Eigene App verbinden», kein «Mit Entra ID verbinden»', async () => {
    admin({ 'GET /v1/admin/entra': () => json(status({ enabled: false, reason: 'ENTRA_CLIENT_ID fehlt' })) });
    expect(await screen.findByRole('button', { name: 'Eigene App verbinden' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mit Entra ID verbinden' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Link an die Entra-Administration senden' })).toBeInTheDocument();
    expect(screen.getByText(/über eine App-Registrierung in eurem Microsoft-Verzeichnis/)).toBeInTheDocument();
  });

  it('älterer Server ohne methods: nur die Zustimmung (wie 0.2.0), Link ohne kind', async () => {
    const api = admin({
      'GET /v1/admin/entra': () => json({ enabled: true, reason: null, connection: null }),
      'POST /v1/admin/entra/consent-links': () => json({ id: 'l1', url: `https://x.example/f#${TOKEN}`, entraTenantId: TID, expiresAt: AT }, 201),
    });
    expect(await screen.findByRole('button', { name: 'Mit Entra ID verbinden' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Eigene App verbinden' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Link an die Entra-Administration senden' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).queryByRole('radio')).toBeNull();
    await userEvent.type(within(dlg).getByLabelText('Verzeichnis'), 'demo.example');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Link erzeugen' }));
    await screen.findByRole('dialog', { name: 'Link für «Demo AG» erzeugt' });
    expect(await bodyOf(api, 'POST', '/v1/admin/entra/consent-links')).toEqual({ tenant: 'demo.example', validMinutes: 15 });
  });

  it('beide Wege: Link-Art wählbar, «Eigene App-Registrierung eintragen» sendet kind credentials', async () => {
    const api = admin({
      'GET /v1/admin/entra': () => json(status({ methods: { platformApp: true, ownApp: true } })),
      'POST /v1/admin/entra/consent-links': () => json({ id: 'l1', url: `https://x.example/f#${TOKEN}`, entraTenantId: TID, expiresAt: AT }, 201),
    });
    expect(await screen.findByRole('button', { name: 'Mit Entra ID verbinden' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Eigene App verbinden' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Link an die Entra-Administration senden' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByRole('radio', { name: 'Bei Microsoft zustimmen' })).toBeChecked();
    await userEvent.click(within(dlg).getByRole('radio', { name: 'Eigene App-Registrierung eintragen' }));
    expect(dlg).toHaveTextContent('Das Secret siehst du so nie.');
    await userEvent.type(within(dlg).getByLabelText('Verzeichnis'), TID);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Link erzeugen' }));
    await screen.findByRole('dialog', { name: 'Link für «Demo AG» erzeugt' });
    expect(await bodyOf(api, 'POST', '/v1/admin/entra/consent-links')).toEqual({ tenant: TID, validMinutes: 15, kind: 'credentials' });
  });

  it('kein Weg gemeldet: weder Verbinden noch Link', async () => {
    admin({ 'GET /v1/admin/entra': () => json(status({ enabled: false, methods: { platformApp: false, ownApp: false }, ownAppReason: 'Secrets lassen sich ohne ENCRYPTION_KEYS nicht speichern.', ownApp: null })) });
    expect(await screen.findByText('Entra ID nicht eingerichtet')).toBeInTheDocument();
    expect(screen.getByText('Secrets lassen sich ohne ENCRYPTION_KEYS nicht speichern.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /verbinden|Link an die/ })).toBeNull();
  });
});

describe('Eigene App verbinden', () => {
  it('Anleitung mit Umleitungs-URI und Berechtigungen; erst mit zwei GUIDs und Secret; Körper ohne Leerzeichen am Rand', async () => {
    let connected = false;
    const api = admin({
      'GET /v1/admin/entra': () => json(status({ connection: connected ? OWN : null })),
      'PUT /v1/admin/entra/app': () => { connected = true; return json({ connection: OWN, members: [{ email: 'a@demo.example', name: 'Anna', linked: true, reason: null }], rejectedDomains: [] }); },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Eigene App verbinden' }));
    const dlg = await screen.findByRole('dialog', { name: '«Demo AG» mit eigener App-Registrierung verbinden' });
    const guide = within(dlg).getByRole('list', { name: 'Anleitung für die App-Registrierung' });
    expect(within(guide).getByLabelText('Umleitungs-URI')).toHaveValue(GUIDE.redirectUri);
    const perms = within(guide).getByRole('list', { name: 'Berechtigungen von Microsoft Graph' });
    expect(perms).toHaveTextContent('User.Read.All');
    expect(perms).toHaveTextContent('Anwendung');
    expect(perms).toHaveTextContent('Delegiert');
    expect(within(perms).getByText('Application.Read.All').closest('li')).toHaveTextContent('optional');
    expect(within(perms).getByText('User.Read.All').closest('li')).not.toHaveTextContent('optional');
    expect(guide).toHaveTextContent('Nur Konten in diesem Organisationsverzeichnis');
    expect(guide).toHaveTextContent('Administratorzustimmung erteilen');
    const go = within(dlg).getByRole('button', { name: 'Verbinden' });
    expect(go).toBeDisabled();
    await userEvent.type(within(dlg).getByLabelText('Verzeichnis'), 'kein verzeichnis');
    await userEvent.tab();
    expect(within(dlg).getByLabelText('Verzeichnis')).toHaveAttribute('aria-invalid', 'true');
    expect(dlg).toHaveTextContent('Erwartet wird eine Verzeichnis-ID (GUID) oder eine Domäne');
    await userEvent.clear(within(dlg).getByLabelText('Verzeichnis'));
    await userEvent.type(within(dlg).getByLabelText('Anwendungs-ID'), 'abc');
    await userEvent.tab();
    expect(dlg).toHaveTextContent('Erwartet wird eine GUID');
    await fill(dlg, { tenant: ' demo.example ', client: CID.toUpperCase(), secret: ' s3cr3t~Wert \n' });
    await userEvent.type(within(dlg).getByLabelText('Secret gültig bis (optional)'), '2027-06-30');
    expect(within(dlg).getByLabelText('Geheimer Clientschlüssel (Wert)')).toHaveAttribute('type', 'password');
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(go);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await bodyOf(api, 'PUT', '/v1/admin/entra/app')).toEqual({ tenant: 'demo.example', clientId: CID, clientSecret: 's3cr3t~Wert', secretExpiresAt: '2027-06-30T23:59:59.000Z' });
    expect(await screen.findByText('«Demo AG» ist mit der eigenen App-Registrierung verbunden')).toBeInTheDocument();
    expect(await screen.findByText('Eigene App-Registrierung')).toBeInTheDocument();
  });

  it.each([
    [409, { reason: 'invalid-secret' }, 'Microsoft lehnt das Secret ab. Häufig wurde die «Geheimnis-ID» statt des «Werts» kopiert.'],
    [409, { reason: 'secret-expired' }, 'Das Secret ist bei Microsoft abgelaufen.'],
    [409, { reason: 'wrong-tenant' }, 'keine App mit dieser Anwendungs-ID'],
    [409, { reason: 'invalid-client' }, 'Microsoft lehnt die Anmeldung der App ab.'],
    [409, { reason: 'missing-permissions', missing: ['User.Read.All', 'Organization.Read.All'] }, 'fehlen Berechtigungen oder die Administratorzustimmung dafür: User.Read.All, Organization.Read.All.'],
    [409, { reason: 'domains-taken' }, 'gehören bereits einer anderen Organisation'],
    [409, { reason: 'tenant-mismatch' }, 'bleibt das Microsoft-Verzeichnis gleich'],
    [503, { reason: 'encryption-missing' }, 'nicht verschlüsselt speichern'],
    [422, { errors: [{ path: '/tenant', message: 'nicht gefunden' }] }, 'Das Microsoft-Verzeichnis wurde nicht gefunden.'],
    [409, { reason: 'unbekannt' }, 'Meldung des Servers'],
  ] as const)('Fehler %i %o: eigener Text, sonst die Meldung des Servers', async (code, extra, text) => {
    admin({ 'GET /v1/admin/entra': () => json(status({})), 'PUT /v1/admin/entra/app': () => problem(code, 'Meldung des Servers', extra) });
    await userEvent.click(await screen.findByRole('button', { name: 'Eigene App verbinden' }));
    const dlg = await screen.findByRole('dialog');
    await fill(dlg, { tenant: TID, client: CID, secret: 'x' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Verbinden' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(text);
  });
});

describe('Verbunden mit eigener App', () => {
  it('Verbindung, Client-ID, Ablauf; «Secret wechseln …»: Verzeichnis fest, Anwendungs-ID vorgegeben, nur der Secret-Schritt; kein «Erneut zustimmen»', async () => {
    const api = admin({ 'GET /v1/admin/entra': () => json(status({ connection: OWN })), 'PUT /v1/admin/entra/app': () => json({ connection: OWN, members: [], rejectedDomains: [] }) });
    expect(await screen.findByText('Eigene App-Registrierung')).toBeInTheDocument();
    expect(screen.getByText(CID)).toBeInTheDocument();
    expect(screen.getByText('Secret läuft ab')).toBeInTheDocument();
    expect(screen.queryByText(/läuft bald ab|abgelaufen/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Erneut zustimmen' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Secret wechseln …' }));
    const dlg = await screen.findByRole('dialog', { name: 'Secret für «Demo AG» wechseln' });
    expect(within(dlg).getByLabelText('Verzeichnis')).toHaveValue(TID);
    expect(within(dlg).getByLabelText('Verzeichnis')).toHaveAttribute('readonly');
    expect(within(dlg).getByLabelText('Anwendungs-ID')).toHaveValue(CID);
    expect(within(dlg).getByLabelText('Anwendungs-ID')).not.toHaveAttribute('readonly');
    expect(within(dlg).getByLabelText('Geheimer Clientschlüssel (Wert)')).toHaveFocus();
    expect(within(dlg).queryByLabelText('Umleitungs-URI')).toBeNull();
    expect(dlg).toHaveTextContent('Zertifikate & Geheimnisse');
    await userEvent.type(within(dlg).getByLabelText('Geheimer Clientschlüssel (Wert)'), 'neu');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Secret speichern' }));
    expect(await screen.findByText('Neues Secret für «Demo AG» gespeichert')).toBeInTheDocument();
    expect(await bodyOf(api, 'PUT', '/v1/admin/entra/app')).toEqual({ tenant: TID, clientId: CID, clientSecret: 'neu' });
  });

  it('Secret läuft bald ab bzw. ist abgelaufen: Warnung', async () => {
    admin({ 'GET /v1/admin/entra': () => json(status({ connection: { ...OWN, secretExpiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), secretExpiresSoon: true } })) });
    expect(await screen.findByText(/Das Secret läuft bald ab/)).toBeInTheDocument();
  });

  it('abgelaufen: Fehlerhinweis; ohne bekannten Ablauf «unbekannt»', async () => {
    admin({ 'GET /v1/admin/entra': () => json(status({ connection: { ...OWN, secretExpiresAt: AT, secretExpiresSoon: true } })) });
    expect(await screen.findByText(/Das Secret ist abgelaufen/)).toBeInTheDocument();
  });

  it('Ablauf unbekannt', async () => {
    admin({ 'GET /v1/admin/entra': () => json(status({ connection: { ...OWN, secretExpiresAt: null } })) });
    expect(await screen.findByText('unbekannt')).toBeInTheDocument();
  });
});

describe('Link «Credentials eintragen» (öffentlich)', () => {
  const INFO = {
    organization: 'Demo AG', product: 'Notizen', requestedBy: 'Anna Admin', tenant: 'demo.example', entraTenantId: TID, notice: 'Verifizierte Domänen gehen an «Demo AG».',
    expiresAt: new Date(Date.now() + 900_000).toISOString(), kind: 'credentials', ownApp: GUIDE,
  };
  function open(routes: Record<string, MockHandler>) {
    window.history.replaceState(null, '', `/verwalten/anmeldung/freigabe#${TOKEN}`);
    const api = mockIamApi({ 'POST /v1/entra/handover/info': () => json(INFO), ...routes });
    vi.stubGlobal('fetch', api.fetch);
    render(<IamProvider product="Notizen" queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} features={{ entra: true }}><p>App</p></IamProvider>);
    return api;
  }

  it('ohne Sitzung: Anleitung («Sie»), Verzeichnis vom Link (kein Feld), Token und Angaben nur im Body, «Gespeichert»', async () => {
    const api = open({ 'POST /v1/entra/handover/credentials': () => json({ organization: 'Demo AG', connected: true }) });
    expect(await screen.findByRole('heading', { name: 'App-Registrierung für die Anmeldung über Microsoft eintragen' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(screen.getByText(/Anna Admin bittet Sie, für «Demo AG» eine App-Registrierung/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Anleitung für die App-Registrierung' })).toHaveTextContent('Dafür brauchen Sie die Rolle');
    expect(screen.getByLabelText('Umleitungs-URI')).toHaveValue(GUIDE.redirectUri);
    expect(screen.getByRole('note')).toHaveTextContent('Nur eintragen, wenn Sie die Anfrage von Anna Admin erwarten.');
    expect(screen.queryByLabelText('Verzeichnis')).toBeNull();
    expect(screen.getByText('Verzeichnis-ID').nextElementSibling).toHaveTextContent(TID);
    expect(screen.queryByRole('button', { name: 'Bei Microsoft zustimmen' })).toBeNull();
    expect(await axeProblems(document.body)).toEqual([]);
    await fill(document.body, { client: CID, secret: 'wert' });
    await userEvent.click(screen.getByRole('button', { name: 'Angaben prüfen und speichern' }));
    expect(await screen.findByRole('heading', { name: 'Gespeichert' })).toBeInTheDocument();
    expect(screen.getByText(/Sie können dieses Fenster schliessen/)).toBeInTheDocument();
    const call = api.calls.find(c => new URL(c.url).pathname === '/v1/entra/handover/credentials')!;
    expect(await call.clone().json()).toEqual({ token: TOKEN, clientId: CID, clientSecret: 'wert' });
    expect(call.credentials).toBe('omit');
    expect(call.headers.get('X-Tenant')).toBeNull();
    expect(call.headers.get('X-CSRF-Token')).toBeNull();
    expect(api.calls.some(c => new URL(c.url).pathname === '/auth/me')).toBe(false);
    expect(api.calls.every(c => !c.url.includes(TOKEN))).toBe(true);
  });

  it('Fehler mit eigenem Text; 404 (inzwischen abgelaufen oder eingelöst): «Link ungültig»', async () => {
    let res = () => problem(409, 'Ungültig.', { reason: 'invalid-secret' });
    open({ 'POST /v1/entra/handover/credentials': () => res() });
    await screen.findByLabelText('Anwendungs-ID');
    await fill(document.body, { client: CID, secret: 'wert' });
    await userEvent.click(screen.getByRole('button', { name: 'Angaben prüfen und speichern' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Microsoft lehnt das Secret ab.');
    res = () => problem(404, 'Nicht gefunden.');
    await userEvent.click(screen.getByRole('button', { name: 'Angaben prüfen und speichern' }));
    expect(await screen.findByRole('heading', { name: 'Link ungültig' })).toBeInTheDocument();
  });
});
