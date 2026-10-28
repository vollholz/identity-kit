/**
 * Mandantentrennung über die Routen des Pakets (Spezifikation Kap. 14; mit den Werkzeugen
 * des Test-Kits): Organisation B erfährt nichts von
 * Organisation A – weder Inhalte noch die Existenz von IDs, Namen, Personen oder Mengen.
 *
 * A («acme») legt Ordner, Notizen, Tupel (auch einer Gruppe aus Entra) und Principals mit auffälligen Markierungen an;
 * B («globex») hat
 * org-admin. Geprüft wird:
 *   1. Fremde IDs im Pfad und in Eingaben: gleiche Antwort wie für eine ID, die es nirgends gibt, ohne Daten von A
 *   2. Listen und Konto: nur Daten von B
 *   3. Vollständigkeit: jede Route des Pakets ist hier abgedeckt; Routen der Beispiel-App sind begründet ausgenommen
 * Jeder Aufruf muss die gemeinte Route erreichen und die Schemaprüfung bestehen (sonst prüfte er nichts).
 * Eigene Routen der Entra-Anbindung tragen keine IDs; ihre Mandantentrennung (state, Domänen, Tenant) prüfen entra.test.ts und
 * entra-members.test.ts (OTHER). Die Verwaltung (Modul `admin`) läuft gegen den
 * `KeycloakFake` des Test-Kits; Plattform-Routen prüfen, dass B ohne platform-admin für A und Unbekanntes gleich 403 erhält.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { coverageProblems, idSource, installProbes, KeycloakFake, leaks, normalize, routeCollector, startMockIdp, unknownKey, unreached, type FakeOrg, type FakeUser, type MockIdp, type ProbeResponse } from '@vollholz/iam-testkit';
import { skipDb } from './support/db.ts';
import { claims, folderWithNote, grant, grantClient, member, notesApp, notesDb, tenant, type NotesApp } from './support/http.ts';

const skip = await skipDb();

/** Markierungen in den Daten von A: keine Antwort an B darf sie enthalten (ohne Gross-/Kleinschreibung). */
/** Objekt-ID einer Gruppe aus Entra in A. */
const GROUP_A = '6e0c1d5a-0a1b-4c2d-8e3f-a1b2c3d4e5f6';
const MARKERS = ['GEHEIM-A', 'Alice Geheim', 'alice@acme', 'geheim-client', 'acme', 'geheim-a-person', GROUP_A];
interface Call { method: string; url: string; body?: unknown }
type Ids = Record<string, string>;

// ---------------------------------------------------------------- 1. Fremde IDs im Pfad und in Eingaben (Löschen zuletzt)
const FOREIGN: { route: string; label: string; call: (i: Ids) => Call }[] = [
  // Zugriff (Kap. 9.1): Orte, Subjekte und Tupel von A
  { route: 'GET /v1/access', label: 'Wer hat Zugriff? am Ordner von A', call: i => ({ method: 'GET', url: `/v1/access?type=folder&id=${i.folder}` }) },
  { route: 'GET /v1/access', label: 'Wer hat Zugriff? an der Notiz von A', call: i => ({ method: 'GET', url: `/v1/access?type=note&id=${i.note}` }) },
  { route: 'GET /v1/access', label: 'Freigaben einer Person von A', call: i => ({ method: 'GET', url: `/v1/access?subject=user:${i.person}` }) },
  { route: 'GET /v1/access', label: 'Freigaben eines Clients von A', call: i => ({ method: 'GET', url: `/v1/access?subject=client:${i.clientPrincipal}` }) },
  { route: 'GET /v1/access/explain', label: 'Warum? am Ordner von A', call: i => ({ method: 'GET', url: `/v1/access/explain?type=folder&id=${i.folder}&permission=note:read` }) },
  { route: 'GET /v1/access/explain', label: 'Warum? für eine Person von A', call: i => ({ method: 'GET', url: `/v1/access/explain?type=org&permission=note:read&subject=user:${i.person}` }) },
  { route: 'POST /v1/access', label: 'Freigabe am Ordner von A', call: i => ({ method: 'POST', url: '/v1/access', body: { subject: 'org:members', relation: 'viewer', type: 'folder', id: i.folder } }) },
  { route: 'POST /v1/access', label: 'Rolle an eine Person von A', call: i => ({ method: 'POST', url: '/v1/access', body: { subject: `user:${i.person}`, relation: 'viewer', type: 'org' } }) },
  { route: 'PATCH /v1/access/{id}', label: 'Ablauf eines Tupels von A ändern', call: i => ({ method: 'PATCH', url: `/v1/access/${i.tuple}`, body: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }) },
  { route: 'PUT /v1/admin/members/{id}/clearance', label: 'Freigabestufe eines Mitglieds von A', call: i => ({ method: 'PUT', url: `/v1/admin/members/${i.member}/clearance`, body: { clearance: 0 } }) },
  { route: 'PUT /v1/admin/members/{id}/clearance', label: 'Freigabestufe einer Einladung von A', call: i => ({ method: 'PUT', url: `/v1/admin/members/${i.invitation}/clearance`, body: { clearance: 0 } }) },
  { route: 'PUT /v1/platform/organizations/{alias}/members/{id}/clearance', label: 'Freigabestufe in A über die Plattform-Route', call: i => ({ method: 'PUT', url: `/v1/platform/organizations/${i.alias}/members/${i.member}/clearance`, body: { clearance: 0 } }) },
  // Freigaben: B nennt die Client-ID von A (zuerst löschen, sonst gäbe das Freigeben danach eine Zeile in B)
  { route: 'DELETE /v1/admin/clients/{clientId}', label: 'Freigabe des Clients von A entziehen', call: i => ({ method: 'DELETE', url: `/v1/admin/clients/${i.client}` }) },
  { route: 'GET /v1/platform/organizations/{alias}/clients', label: 'Freigaben von A über die Plattform-Route', call: i => ({ method: 'GET', url: `/v1/platform/organizations/${i.alias}/clients` }) },
  { route: 'PUT /v1/platform/organizations/{alias}/clients/{clientId}', label: 'Client in A über die Plattform-Route freigeben', call: i => ({ method: 'PUT', url: `/v1/platform/organizations/${i.alias}/clients/${i.client}`, body: { roles: ['viewer'] } }) },
  { route: 'DELETE /v1/platform/organizations/{alias}/clients/{clientId}', label: 'Freigabe in A über die Plattform-Route entziehen', call: i => ({ method: 'DELETE', url: `/v1/platform/organizations/${i.alias}/clients/${i.client}` }) },
  { route: 'PUT /v1/admin/clients/{clientId}', label: 'Client-ID von A im eigenen Mandanten freigeben', call: i => ({ method: 'PUT', url: `/v1/admin/clients/${i.client}`, body: { roles: ['viewer'] } }) },
  // Verwaltung: Mitglied (Keycloak-ID) und offene Einladung (Einladungs-ID) von A über die eigenen Routen von B
  { route: 'PUT /v1/admin/members/{id}/roles', label: 'Rollen eines Mitglieds von A setzen', call: i => ({ method: 'PUT', url: `/v1/admin/members/${i.member}/roles`, body: { roles: ['viewer'] } }) },
  { route: 'PUT /v1/admin/members/{id}/roles', label: 'Rollen einer Einladung von A setzen', call: i => ({ method: 'PUT', url: `/v1/admin/members/${i.invitation}/roles`, body: { roles: ['viewer'] } }) },
  { route: 'POST /v1/admin/members/{id}/invitation', label: 'Einladung von A erneut senden', call: i => ({ method: 'POST', url: `/v1/admin/members/${i.invitation}/invitation` }) },
  { route: 'POST /v1/admin/members/{id}/invitation', label: 'Mitglied von A erneut einladen', call: i => ({ method: 'POST', url: `/v1/admin/members/${i.member}/invitation` }) },
  { route: 'DELETE /v1/admin/members/{id}', label: 'Einladung von A zurückziehen', call: i => ({ method: 'DELETE', url: `/v1/admin/members/${i.invitation}` }) },
  { route: 'DELETE /v1/admin/members/{id}', label: 'Mitglied von A entfernen', call: i => ({ method: 'DELETE', url: `/v1/admin/members/${i.member}` }) },
  // Plattform-Routen: B ohne platform-admin
  { route: 'GET /v1/platform/organizations/{alias}', label: 'Organisation A lesen', call: i => ({ method: 'GET', url: `/v1/platform/organizations/${i.alias}` }) },
  { route: 'PATCH /v1/platform/organizations/{alias}', label: 'Organisation A umbenennen', call: i => ({ method: 'PATCH', url: `/v1/platform/organizations/${i.alias}`, body: { name: 'fremd' } }) },
  { route: 'POST /v1/platform/organizations/{alias}/suspend', label: 'Organisation A sperren', call: i => ({ method: 'POST', url: `/v1/platform/organizations/${i.alias}/suspend`, body: { reason: 'fremd' } }) },
  { route: 'POST /v1/platform/organizations/{alias}/resume', label: 'Organisation A entsperren', call: i => ({ method: 'POST', url: `/v1/platform/organizations/${i.alias}/resume` }) },
  { route: 'GET /v1/platform/organizations/{alias}/members', label: 'Mitglieder von A', call: i => ({ method: 'GET', url: `/v1/platform/organizations/${i.alias}/members` }) },
  { route: 'POST /v1/platform/organizations/{alias}/members', label: 'in A einladen', call: i => ({ method: 'POST', url: `/v1/platform/organizations/${i.alias}/members`, body: { email: 'neu@globex.example' } }) },
  { route: 'PUT /v1/platform/organizations/{alias}/members/{id}/roles', label: 'Rollen in A setzen', call: i => ({ method: 'PUT', url: `/v1/platform/organizations/${i.alias}/members/${i.member}/roles`, body: { roles: ['viewer'] } }) },
  { route: 'POST /v1/platform/organizations/{alias}/members/{id}/invitation', label: 'Einladung in A erneut senden', call: i => ({ method: 'POST', url: `/v1/platform/organizations/${i.alias}/members/${i.invitation}/invitation` }) },
  { route: 'DELETE /v1/platform/organizations/{alias}/members/{id}', label: 'aus A entfernen', call: i => ({ method: 'DELETE', url: `/v1/platform/organizations/${i.alias}/members/${i.member}` }) },
  // Rollen und Personen von A
  { route: 'GET /v1/people/{id}', label: 'Person von A lesen', call: i => ({ method: 'GET', url: `/v1/people/${i.person}` }) },
  { route: 'GET /v1/people/{id}', label: 'Client von A lesen', call: i => ({ method: 'GET', url: `/v1/people/${i.clientPrincipal}` }) },
  { route: 'GET /v1/people', label: 'Personen von A über ids', call: i => ({ method: 'GET', url: `/v1/people?ids=${i.person}&ids=${i.clientPrincipal}` }) },
  // Entra-Anbindung von A über die Plattform-Routen (B ohne platform-admin)
  ...[['GET', ''], ['DELETE', ''], ['POST', '/consent'], ['POST', '/consent/complete'], ['PUT', '/app'], ['GET', '/preview'], ['POST', '/enforce'], ['PUT', '/domains'], ['POST', '/refresh'], ['POST', '/consent-links'], ['GET', '/consent-links']].map(([method, sub]) => ({
    route: `${method} /v1/platform/organizations/{alias}/entra${sub}`, label: `Entra von A: ${method} ${sub || '/'}`,
    call: (i: Ids): Call => ({ method: method!, url: `/v1/platform/organizations/${i.alias}/entra${sub}`, ...({ '/consent': { body: { tenant: 'acme.example' } }, '/consent-links': method === 'POST' ? { body: { tenant: 'acme.example' } } : undefined, '/consent/complete': { body: { state: 'o.acme.abcdefghijk' } }, '/app': { body: { tenant: 'acme.example', clientId: crypto.randomUUID(), clientSecret: 'x' } }, '/enforce': { body: {} }, '/domains': { body: { domains: ['acme.example'] } } } as Record<string, { body: unknown } | undefined>)[sub!] }),
  })),
  { route: 'DELETE /v1/platform/organizations/{alias}/entra/consent-links/{id}', label: 'Link der Entra-Administration von A widerrufen', call: i => ({ method: 'DELETE', url: `/v1/platform/organizations/${i.alias}/entra/consent-links/${crypto.randomUUID()}` }) },
  { route: 'GET /v1/platform/organizations/{alias}/members/entra-search', label: 'Entra-Suche in A', call: i => ({ method: 'GET', url: `/v1/platform/organizations/${i.alias}/members/entra-search?q=alice` }) },
  { route: 'POST /v1/platform/organizations/{alias}/members/entra', label: 'Person aus Entra in A', call: i => ({ method: 'POST', url: `/v1/platform/organizations/${i.alias}/members/entra`, body: { id: crypto.randomUUID() } }) },
  // Eigene Rollen von A: über die eigenen Routen von B (Schlüssel gilt je Organisation) und die Plattform-Routen
  { route: 'PUT /v1/admin/roles/{key}', label: 'eigene Rolle von A ändern', call: i => ({ method: 'PUT', url: `/v1/admin/roles/${i.role}`, body: { label: 'fremd', permissions: ['note:read'], places: ['org'] } }) },
  { route: 'DELETE /v1/admin/roles/{key}', label: 'eigene Rolle von A löschen', call: i => ({ method: 'DELETE', url: `/v1/admin/roles/${i.role}` }) },
  { route: 'GET /v1/platform/organizations/{alias}/roles', label: 'eigene Rollen von A über die Plattform-Route', call: i => ({ method: 'GET', url: `/v1/platform/organizations/${i.alias}/roles` }) },
  { route: 'POST /v1/platform/organizations/{alias}/roles', label: 'eigene Rolle in A über die Plattform-Route', call: i => ({ method: 'POST', url: `/v1/platform/organizations/${i.alias}/roles`, body: { label: 'fremd', permissions: ['note:read'], places: ['org'] } }) },
  { route: 'PUT /v1/platform/organizations/{alias}/roles/{key}', label: 'eigene Rolle von A über die Plattform-Route ändern', call: i => ({ method: 'PUT', url: `/v1/platform/organizations/${i.alias}/roles/${i.role}`, body: { label: 'fremd', permissions: ['note:read'], places: ['org'] } }) },
  { route: 'DELETE /v1/platform/organizations/{alias}/roles/{key}', label: 'eigene Rolle von A über die Plattform-Route löschen', call: i => ({ method: 'DELETE', url: `/v1/platform/organizations/${i.alias}/roles/${i.role}` }) },
  { route: 'DELETE /v1/access/{id}', label: 'Tupel von A löschen', call: i => ({ method: 'DELETE', url: `/v1/access/${i.tuple}` }) },
];

// ---------------------------------------------------------------- 2. Listen und Konto
const LISTS: { route: string; url: string }[] = [
  { route: 'GET /v1/me', url: '/v1/me' },
  { route: 'GET /v1/authz/catalog', url: '/v1/authz/catalog' },
  { route: 'GET /v1/access', url: '/v1/access?type=org' },
  { route: 'GET /v1/access', url: '/v1/access?subject=me' },
  { route: 'GET /v1/access/explain', url: '/v1/access/explain?type=org&permission=note:read' },
  { route: 'GET /v1/admin/clients', url: '/v1/admin/clients' },
  { route: 'GET /v1/admin/status', url: '/v1/admin/status' },
  { route: 'GET /v1/admin/members', url: '/v1/admin/members' },
  { route: 'GET /v1/admin/entra', url: '/v1/admin/entra' },
  { route: 'GET /v1/admin/roles', url: '/v1/admin/roles' },
  { route: 'GET /v1/notes', url: '/v1/notes' },
  { route: 'GET /v1/people', url: '/v1/people' },
  { route: 'GET /v1/people', url: '/v1/people?q=alice' },
  { route: 'GET /v1/people', url: '/v1/people?kind=client' },
  { route: 'GET /v1/people', url: '/v1/people?kind=client&q=geheim' },
];

/** Eigene Routen der Entra-Anbindung: Organisation aus dem Token, keine IDs von A möglich; geprüft in den Entra-Tests. */
const ENTRA_OWN = 'Entra (Kap. 9.4): Organisation nur aus dem Token, Verbindung und state je Mandant (RLS), belegte Domänen ohne die Organisation zu nennen; entra.test.ts «Rückkehr …» und «Mandantentrennung …», entra-members.test.ts «Suche …»';
const OTHER: Record<string, string> = Object.fromEntries([
  'POST /v1/admin/entra/consent', 'POST /v1/admin/entra/consent/complete', 'GET /v1/admin/entra/preview', 'POST /v1/admin/entra/enforce', 'PUT /v1/admin/entra/domains',
  'POST /v1/admin/entra/refresh', 'DELETE /v1/admin/entra', 'POST /v1/admin/entra/test', 'GET /v1/admin/members/entra-search', 'POST /v1/admin/members/entra',
  'POST /v1/admin/entra/consent-links', 'GET /v1/admin/entra/consent-links', 'DELETE /v1/admin/entra/consent-links/{id}', 'PUT /v1/admin/entra/app',
  'GET /v1/access/groups',
].map(r => [r, ENTRA_OWN]).concat([['POST /v1/break-glass', 'Ohne IDs: wirkt nur auf den eigenen Principal im eigenen Mandanten; break-glass.test.ts «Mandantentrennung»'],
  ['DELETE /v1/break-glass', 'Ohne IDs: wirkt nur auf den eigenen Principal im eigenen Mandanten; break-glass.test.ts «Mandantentrennung»']]).concat(['info', 'start', 'complete', 'credentials'].map(x => [`POST /v1/entra/handover/${x}`,
  'Öffentlich ohne Anmeldung: nur über das Token des Links bzw. state (Hash, Mandant aus dem Alias, RLS); entra-handover.test.ts «Missbrauch …»'])));

/** Routen der Beispiel-App (Fachrouten, nicht Teil des Pakets) und öffentliche Beschreibung. */
const EXEMPT: Record<string, string> = {
  '/v1/folders': 'Fachroute der Beispiel-App, nicht Teil des Pakets',
  '/v1/folders/{id}': 'Fachroute der Beispiel-App, nicht Teil des Pakets',
  '/v1/notes/{id}': 'Fachroute der Beispiel-App, nicht Teil des Pakets',
  '/v1/openapi.json': 'öffentliche Beschreibung der API, ohne Mandantendaten',
  '/v1/platform/organizations': 'Plattform-Administration arbeitet absichtlich mandantenübergreifend (Realm-Rolle platform-admin); ohne die Rolle 403, Grenze in admin.test.ts',
  '/v1/platform/entra/refresh': 'Plattform-Administration über alle Organisationen (platform-admin); ohne die Rolle 403, entra.test.ts «Aktualisieren …»',
  '/v1/account': 'Kontext Konto ohne Mandant: nur das eigene Konto und die Organisationen aus dem eigenen Token; account.test.ts «K4»',
  '/v1/account/organizations': 'Kontext Konto: legt einen neuen Mandanten an, liest keinen bestehenden; account.test.ts «K6»',
  '/v1/signup': 'Öffentlich ohne Anmeldung, ohne Mandant; gleiche Antwort für bestehende und neue Adressen; account.test.ts «K7»',
};

describe('Mandantentrennung über die Routen des Pakets', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  const collector = routeCollector();
  const covered = new Map<string, string>();
  const a: Ids = {};
  const tok: Record<string, string> = {};

  const as = async (who: string, c: Call): Promise<ProbeResponse> => {
    const r = await n.app.inject({ method: c.method as 'GET', url: c.url, headers: { authorization: `Bearer ${tok[who]}` }, ...(c.body !== undefined ? { payload: c.body as object } : {}) });
    return { status: r.statusCode, text: r.body, headers: r.headers };
  };

  const kc = new KeycloakFake();
  let orgA: FakeOrg, alice: FakeUser;
  const rolesOfAlice = async () => (await t.inspect.query<{ r: string }>(
    "SELECT a.relation AS r FROM notes.authz_tuple a JOIN notes.principal p ON a.subject = 'user:' || p.id WHERE p.subject = $1 AND a.object_type = 'org' ORDER BY 1", [alice.id])).rows.map(r => r.r);

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    orgA = kc.org('acme', 'GEHEIM-A AG'); const orgB = kc.org('globex', 'Globex');
    alice = kc.user('alice', { email: 'alice@acme.example', firstName: 'Alice', lastName: 'Geheim' });
    const gus = kc.user('gus', { email: 'gus@globex.example', firstName: 'Gus', lastName: 'Globex' });
    kc.member(orgA, alice); kc.member(orgB, gus);
    n = await notesApp({
      db: t.runtime, issuer: idp.issuer, env: { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'x', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' }, keycloakFetch: kc.fetch,
      before: async app => collector.install(app), after: app => installProbes(app),
    });
    const A = await tenant(t.runtime, 'acme');
    await grantClient(t.runtime, A, 'geheim-client', 'viewer');
    await member(t.runtime, 'acme', alice.id, 'org-admin', 2); await member(t.runtime, 'globex', gus.id, 'org-admin', 2);
    tok.alice = await idp.token({ ...claims.user({ org: 'acme', sub: alice.id, name: 'Alice Geheim', email: 'alice@acme.example' }) });
    tok.gus = await idp.token(claims.user({ org: 'globex', sub: gus.id, name: 'Gus Globex', email: 'gus@globex.example' }));
    tok.client = await idp.token(claims.client({ clientId: 'geheim-client', org: 'acme', scopes: ['notes:read'] }));
    a.person = JSON.parse((await as('alice', { method: 'GET', url: '/v1/me' })).text).principal.id;
    const me = await as('client', { method: 'GET', url: '/v1/me' });
    assert.equal(me.status, 200);
    a.clientPrincipal = JSON.parse(me.text).principal.id;
    a.client = 'geheim-client';
    a.alias = 'acme';
    a.member = alice.id;
    const inv = await as('alice', { method: 'POST', url: '/v1/admin/members', body: { email: 'geheim-a-person@acme.example', firstName: 'GEHEIM-A', roles: ['viewer'] } });
    assert.equal(inv.status, 202, inv.text);
    a.invitation = JSON.parse(inv.text).member.id;
    ({ folder: a.folder!, note: a.note! } = await folderWithNote(t.runtime, A, 'GEHEIM-A Ordner'));
    const e = await as('alice', { method: 'POST', url: '/v1/access', body: { subject: 'org:members', relation: 'viewer', type: 'folder', id: a.folder } });
    assert.equal(e.status, 201, e.text);
    a.tuple = JSON.parse(e.text).id;
    // Gruppe aus Entra an org (ohne Verbindung direkt angelegt): ihre Objekt-ID darf B nie sehen
    a.groupTuple = await grant(t.runtime, A, `group:${GROUP_A}`, 'viewer');
    // Eigene Rolle in A, an einem Ordner vergeben: weder ihr Name noch ihr Schlüssel dürfen B erreichen
    const role = await as('alice', { method: 'POST', url: '/v1/admin/roles', body: { key: 'c-rolle-a', label: 'GEHEIM-A Rolle', permissions: ['note:read'], places: ['org', 'folder'] } });
    assert.equal(role.status, 201, role.text);
    a.role = 'c-rolle-a';
    const rt = await as('alice', { method: 'POST', url: '/v1/access', body: { subject: 'org:members', relation: a.role, type: 'folder', id: a.folder } });
    assert.equal(rt.status, 201, rt.text);
    a.roleTuple = JSON.parse(rt.text).id;
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('1. fremde IDs: gleiche Antwort wie eine unbekannte ID, ohne Daten von A', async () => {
    const problems: string[] = [];
    for (const f of FOREIGN) {
      const foreign = idSource(a), unknown = idSource(null, { unknown: k => (k === 'client' ? unknownKey('client') : k === 'alias' ? unknownKey('org') : k === 'role' ? 'c-unbekannt' : crypto.randomUUID()) });
      const cf = f.call(foreign.ids), cu = f.call(unknown.ids);
      const rf = await as('gus', cf), ru = await as('gus', cu);
      for (const [r, c] of [[rf, cf], [ru, cu]] as const) { const u = unreached(r, c.method, f.route); if (u) problems.push(`${f.label}: ${u}`); }
      // Was B selbst nennt (Pfad oder Body), darf als Echo zurückkommen
      const input = `${cf.url} ${JSON.stringify(cf.body ?? '')}`;
      problems.push(...leaks(rf.text, { markers: MARKERS.filter(m => !input.includes(m)), ids: Object.values(a).filter(v => !input.includes(v)) }).map(x => `${f.label}: ${x}`));
      const same = (r: ProbeResponse, used: Map<string, string>) => ({ status: r.status, body: normalize(r.text, new Map([...used].map(([k, v]) => [k, v]))) });
      // Die Client-ID ist eine Eingabe von B (Echo im Namen): im Vergleich durch ihren Schlüssel ersetzt
      const f1 = same(rf, foreign.used), u1 = same(ru, unknown.used);
      if (JSON.stringify(f1) !== JSON.stringify(u1)) problems.push(`${f.label}: Antwort verrät die Existenz (${JSON.stringify(f1).slice(0, 300)} ≠ ${JSON.stringify(u1).slice(0, 300)})`);
      covered.set(f.route, 'fremde IDs');
    }
    assert.deepEqual(problems, []);
    assert.deepEqual((await t.inspect.query('SELECT id, expires_at FROM notes.authz_tuple WHERE id = ANY($1::uuid[]) ORDER BY id', [[a.tuple, a.groupTuple]])).rows.length, 2, 'Tupel von A unverändert');
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.authz_tuple WHERE id = $1 AND expires_at IS NULL', [a.tuple])).rows[0].n, 1, 'Ablauf unverändert');
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.authz_tuple WHERE subject = 'client:' || $1", [a.clientPrincipal])).rows[0].n, 1, 'Freigabe von A unverändert');
    assert.deepEqual(await rolesOfAlice(), ['org-admin'], 'Rollen von alice in A unverändert');
    assert.deepEqual((await t.inspect.query("SELECT r.label, r.permissions FROM notes.authz_role r JOIN notes.tenant x ON x.id = r.tenant_id WHERE x.alias = 'acme'")).rows, [{ label: 'GEHEIM-A Rolle', permissions: ['note:read'] }], 'eigene Rolle von A unverändert');
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.authz_role r JOIN notes.tenant x ON x.id = r.tenant_id WHERE x.alias = 'globex'")).rows[0].n, 0, 'keine Rolle in B');
    assert.deepEqual((await t.inspect.query('SELECT clearance FROM notes.principal WHERE id = $1', [a.person])).rows[0].clearance, 2, 'Freigabestufe von alice unverändert');
    assert.ok(kc.orgMembers.get(orgA.id)!.has(alice.id) && orgA.enabled && orgA.name === 'GEHEIM-A AG', 'Mitgliedschaft und Organisation A unverändert');
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.member_invitation WHERE id = $1 AND accepted_at IS NULL', [a.invitation])).rows[0].n, 1, 'Einladung von A offen');
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.authz_tuple a JOIN notes.tenant x ON x.id = a.tenant_id WHERE x.alias = 'globex' AND a.subject LIKE 'user:%' AND a.subject <> ALL (SELECT 'user:' || id FROM notes.principal WHERE tenant_id = x.id)")).rows[0].n, 0, 'kein Tupel in B für Principals von A');
    // Eigene Freigaben von B aus den Aufrufen (Eingaben von B) entfernen, damit die Listen in 2. nur Daten von B ohne Echo zeigen
    await t.inspect.query("DELETE FROM notes.authz_tuple a USING notes.tenant x WHERE x.id = a.tenant_id AND x.alias = 'globex' AND a.subject LIKE 'client:%'");
    await t.inspect.query("DELETE FROM notes.principal p USING notes.tenant x WHERE x.id = p.tenant_id AND x.alias = 'globex' AND p.kind = 'client'");
  });

  test('2. Listen und Konto: nur Daten von B', async () => {
    const problems: string[] = [];
    for (const l of LISTS) {
      const r = await as('gus', { method: 'GET', url: l.url });
      const u = unreached(r, 'GET', l.route);
      if (u) problems.push(`${l.url}: ${u}`);
      if (r.status !== 200) problems.push(`${l.url}: ${r.status} ${r.text.slice(0, 200)}`);
      problems.push(...leaks(r.text, { markers: MARKERS, ids: Object.values(a), allowed: [l.url] }).map(x => `${l.url}: ${x}`));
      covered.set(l.route, 'Liste');
    }
    assert.deepEqual(problems, []);
    assert.deepEqual(JSON.parse((await as('gus', { method: 'GET', url: '/v1/notes' })).text).items, [], 'Lesesicht: keine Notiz von A');
    assert.ok(JSON.parse((await as('gus', { method: 'GET', url: '/v1/access?type=org' })).text).items.every((x: { subject: { ref: string } }) => !x.subject.ref.includes(GROUP_A)));
  });

  test('3. Einladen einer Adresse aus A: Antwort wie für eine neue Adresse, ohne Angaben aus dem Konto', async () => {
    const invite = (email: string) => as('gus', { method: 'POST', url: '/v1/admin/members', body: { email } });
    const known = await invite('alice@acme.example'), fresh = await invite(`neu-${crypto.randomUUID().slice(0, 6)}@globex.example`);
    assert.equal(known.status, 202, known.text);
    const body = (r: ProbeResponse) => JSON.parse(r.text);
    const neutral = (b: any) => ({ ...b, member: { ...b.member, id: '-', principalId: '-', email: '-', name: '-', username: '-', createdAt: '-' } });
    assert.deepEqual([fresh.status, neutral(body(fresh))], [known.status, neutral(body(known))]);
    assert.deepEqual(leaks(known.text, { markers: MARKERS.filter(m => !['alice@acme', 'acme'].includes(m)), ids: Object.values(a) }), []);
    const members = JSON.parse((await as('gus', { method: 'GET', url: '/v1/admin/members' })).text).items as { id: string; name: string; lastSeenAt: string | null }[];
    const invited = members.find(m => m.id === body(known).member.id)!;
    assert.ok(invited && !/Alice Geheim/i.test(invited.name) && invited.lastSeenAt === null, JSON.stringify(invited));
    const del = await as('gus', { method: 'DELETE', url: `/v1/admin/members/${body(known).member.id}` });
    assert.deepEqual([del.status, JSON.parse(del.text)], [200, { accountDeleted: false }]);
    assert.ok(kc.users.has(alice.id), 'Konto von alice bleibt');
    assert.deepEqual(await rolesOfAlice(), ['org-admin'], 'Rollen von alice in A unverändert');
    covered.set('POST /v1/admin/members', 'Eindeutigkeit nur im Mandanten (Einladung einer Adresse aus A)');
  });

  test('3b. eigene Rollen: gleicher Schlüssel und Name wie in A legt eine Rolle in B an; A und ihre Vergaben unverändert, keine Rolle von A vergebbar', async () => {
    const created = await as('gus', { method: 'POST', url: '/v1/admin/roles', body: { key: a.role, label: 'GEHEIM-A Rolle', permissions: ['team:read'], places: ['org'] } });
    assert.equal(created.status, 201, created.text);
    assert.deepEqual(leaks(created.text, { markers: MARKERS.filter(m => !['GEHEIM-A'].includes(m)), ids: Object.values(a).filter(v => v !== a.role) }), []);
    const rows = (await t.inspect.query<{ alias: string; permissions: string[] }>("SELECT x.alias, r.permissions FROM notes.authz_role r JOIN notes.tenant x ON x.id = r.tenant_id WHERE r.key = $1 ORDER BY x.alias", [a.role])).rows;
    assert.deepEqual(rows, [{ alias: 'acme', permissions: ['note:read'] }, { alias: 'globex', permissions: ['team:read'] }]);
    // B gibt die Rolle mit dem Schlüssel von A an einem Ort von A: Ort unbekannt (wie jede fremde ID)
    const r = await as('gus', { method: 'POST', url: '/v1/access', body: { subject: 'org:members', relation: a.role, type: 'folder', id: a.folder } });
    assert.equal(r.status, 404, r.text);
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.authz_tuple WHERE id = $1', [a.roleTuple])).rows[0].n, 1);
    // Ohne Zeile in B lehnt die Datenbank eine Vergabe einer fremden Rolle ab (Trigger je Mandant)
    const B = (await t.inspect.query<{ id: string }>("SELECT id FROM notes.tenant WHERE alias = 'globex'")).rows[0]!.id;
    await t.inspect.query("DELETE FROM notes.authz_role WHERE key = $1 AND tenant_id = $2", [a.role, B]);
    await assert.rejects(grant(t.runtime, B, 'org:members', a.role!), /ist an org nicht zulässig/);
    covered.set('POST /v1/admin/roles', 'Schlüssel und Namen je Organisation; Vergabe nur mit eigener Zeile (Trigger)');
  });

  test('4. Vollständigkeit: jede Route des Pakets geprüft, Routen der App begründet ausgenommen', () => {
    for (const [r, why] of Object.entries(OTHER)) covered.set(r, why);
    const { missing, stale } = coverageProblems({ all: [...collector.routes].filter(r => r.split(' ')[1]!.startsWith('/v1/') && !r.startsWith('HEAD ')), covered, exempt: EXEMPT });
    assert.deepEqual({ missing, stale }, { missing: [], stale: [] });
    assert.ok(covered.size >= 20);
  });
});
