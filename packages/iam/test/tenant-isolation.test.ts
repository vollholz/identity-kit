/**
 * Mandantentrennung über die Routen des Pakets (Spezifikation Kap. 14; Gerüst nach Assets
 * test/platform/tenant-isolation.test.ts mit den Werkzeugen des Test-Kits): Organisation B erfährt nichts von
 * Organisation A – weder Inhalte noch die Existenz von IDs, Namen, Personen oder Mengen.
 *
 * A («acme») legt Ordner, Notizen, Zugriffsregeln und Principals mit auffälligen Markierungen an; B («globex») hat
 * org-admin. Geprüft wird:
 *   1. Fremde IDs im Pfad und in Eingaben: gleiche Antwort wie für eine ID, die es nirgends gibt, ohne Daten von A
 *   2. Listen und Konto: nur Daten von B
 *   3. Vollständigkeit: jede Route des Pakets ist hier abgedeckt; Routen der Beispiel-App sind begründet ausgenommen
 * Jeder Aufruf muss die gemeinte Route erreichen und die Schemaprüfung bestehen (sonst prüfte er nichts).
 * Die weiteren Module (Rollen, Entra) kommen mit ihren Teil-PRs hinzu. Die Verwaltung (Modul `admin`) läuft gegen den
 * `KeycloakFake` des Test-Kits; Plattform-Routen prüfen, dass B ohne platform-admin für A und Unbekanntes gleich 403 erhält.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { coverageProblems, idSource, installProbes, KeycloakFake, leaks, normalize, routeCollector, startMockIdp, unknownKey, unreached, type FakeOrg, type FakeUser, type MockIdp, type ProbeResponse } from '@vollholz/iam-testkit';
import { withTenant } from '../src/db.ts';
import { skipDb } from './support/db.ts';
import { claims, folderWithNote, notesApp, notesDb, tenant, type NotesApp } from './support/http.ts';

const skip = await skipDb();

/** Markierungen in den Daten von A: keine Antwort an B darf sie enthalten (ohne Gross-/Kleinschreibung). */
const MARKERS = ['GEHEIM-A', 'Alice Geheim', 'alice@acme', 'geheim-a-principal', 'geheim-client', 'acme', 'geheim-a-person'];
interface Call { method: string; url: string; body?: unknown }
type Ids = Record<string, string>;

// ---------------------------------------------------------------- 1. Fremde IDs im Pfad und in Eingaben (Löschen zuletzt)
const FOREIGN: { route: string; label: string; call: (i: Ids) => Call }[] = [
  { route: 'POST /v1/acl', label: 'Zugriffsregel auf Ordner von A', call: i => ({ method: 'POST', url: '/v1/acl', body: { resourceType: 'folder', resourceId: i.folder, principalType: 'role', principalRef: 'viewer', permission: 'note:read', effect: 'deny' } }) },
  { route: 'POST /v1/acl', label: 'Zugriffsregel auf Notiz von A', call: i => ({ method: 'POST', url: '/v1/acl', body: { resourceType: 'note', resourceId: i.note, principalType: 'role', principalRef: 'viewer', permission: 'note:read', effect: 'deny' } }) },
  { route: 'GET /v1/acl', label: 'Liste gefiltert nach Ressource von A', call: i => ({ method: 'GET', url: `/v1/acl?resourceType=folder&resourceId=${i.folder}` }) },
  { route: 'GET /v1/acl/effective', label: 'wirksame Rechte einer Person von A', call: i => ({ method: 'GET', url: `/v1/acl/effective?principal=${i.person}` }) },
  { route: 'GET /v1/acl/effective', label: 'wirksame Rechte eines Clients von A', call: i => ({ method: 'GET', url: `/v1/acl/effective?client=${i.client}` }) },
  // Freigaben: B nennt die Client-ID von A (zuerst löschen, sonst gäbe das Freigeben danach eine Zeile in B)
  { route: 'DELETE /v1/admin/clients/{clientId}', label: 'Freigabe des Clients von A entziehen', call: i => ({ method: 'DELETE', url: `/v1/admin/clients/${i.client}` }) },
  { route: 'GET /v1/platform/organizations/{alias}/clients', label: 'Freigaben von A über die Plattform-Route', call: i => ({ method: 'GET', url: `/v1/platform/organizations/${i.alias}/clients` }) },
  { route: 'PUT /v1/platform/organizations/{alias}/clients/{clientId}', label: 'Client in A über die Plattform-Route freigeben', call: i => ({ method: 'PUT', url: `/v1/platform/organizations/${i.alias}/clients/${i.client}`, body: {} }) },
  { route: 'DELETE /v1/platform/organizations/{alias}/clients/{clientId}', label: 'Freigabe in A über die Plattform-Route entziehen', call: i => ({ method: 'DELETE', url: `/v1/platform/organizations/${i.alias}/clients/${i.client}` }) },
  { route: 'PUT /v1/admin/clients/{clientId}', label: 'Client-ID von A im eigenen Mandanten freigeben', call: i => ({ method: 'PUT', url: `/v1/admin/clients/${i.client}`, body: {} }) },
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
  { route: 'DELETE /v1/acl/{id}', label: 'Zugriffsregel von A löschen', call: i => ({ method: 'DELETE', url: `/v1/acl/${i.acl}` }) },
];

// ---------------------------------------------------------------- 2. Listen und Konto
const LISTS: { route: string; url: string }[] = [
  { route: 'GET /v1/me', url: '/v1/me' },
  { route: 'GET /v1/authz/catalog', url: '/v1/authz/catalog' },
  { route: 'GET /v1/acl', url: '/v1/acl' },
  { route: 'GET /v1/acl', url: '/v1/acl?principalRef=geheim-a-principal' },
  { route: 'GET /v1/acl/effective', url: '/v1/acl/effective' },
  { route: 'GET /v1/acl/effective', url: '/v1/acl/effective?roles=editor&groups=/orgs/acme/geheim' },
  { route: 'GET /v1/admin/clients', url: '/v1/admin/clients' },
  { route: 'GET /v1/admin/status', url: '/v1/admin/status' },
  { route: 'GET /v1/admin/members', url: '/v1/admin/members' },
];

/** Routen der Beispiel-App (Fachrouten, nicht Teil des Pakets) und öffentliche Beschreibung. */
const EXEMPT: Record<string, string> = {
  '/v1/folders': 'Fachroute der Beispiel-App, nicht Teil des Pakets',
  '/v1/folders/{id}': 'Fachroute der Beispiel-App, nicht Teil des Pakets',
  '/v1/notes/{id}': 'Fachroute der Beispiel-App, nicht Teil des Pakets',
  '/v1/openapi.json': 'öffentliche Beschreibung der API, ohne Mandantendaten',
  '/v1/platform/organizations': 'Plattform-Administration arbeitet absichtlich mandantenübergreifend (Realm-Rolle platform-admin); ohne die Rolle 403, Grenze in admin.test.ts',
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

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    orgA = kc.org('acme', 'GEHEIM-A AG'); const orgB = kc.org('globex', 'Globex');
    alice = kc.user('alice', { email: 'alice@acme.example', firstName: 'Alice', lastName: 'Geheim' });
    const gus = kc.user('gus', { email: 'gus@globex.example', firstName: 'Gus', lastName: 'Globex' });
    kc.member(orgA, alice, ['org-admin']); kc.member(orgB, gus, ['org-admin']);
    n = await notesApp({
      db: t.runtime, issuer: idp.issuer, env: { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'x', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' }, keycloakFetch: kc.fetch,
      before: async app => collector.install(app), after: app => installProbes(app),
    });
    const A = await tenant(t.runtime, 'acme', 'geheim-client');
    await tenant(t.runtime, 'globex');
    tok.alice = await idp.token({ ...claims.user({ org: 'acme', sub: alice.id, name: 'Alice Geheim', email: 'alice@acme.example', groupRoles: ['org-admin'] }) });
    tok.gus = await idp.token(claims.user({ org: 'globex', sub: gus.id, groupRoles: ['org-admin'], name: 'Gus Globex', email: 'gus@globex.example' }));
    tok.client = await idp.token(claims.client({ clientId: 'geheim-client', org: 'acme', roles: ['viewer'], scopes: ['notes:read'] }));
    a.person = JSON.parse((await as('alice', { method: 'GET', url: '/v1/me' })).text).principal.id;
    assert.equal((await as('client', { method: 'GET', url: '/v1/me' })).status, 200);
    a.client = 'geheim-client';
    a.alias = 'acme';
    a.member = alice.id;
    const inv = await as('alice', { method: 'POST', url: '/v1/admin/members', body: { email: 'geheim-a-person@acme.example', firstName: 'GEHEIM-A', roles: ['viewer'] } });
    assert.equal(inv.status, 202, inv.text);
    a.invitation = JSON.parse(inv.text).member.id;
    ({ folder: a.folder!, note: a.note! } = await folderWithNote(t.runtime, A, 'GEHEIM-A Ordner'));
    const e = await as('alice', { method: 'POST', url: '/v1/acl', body: { resourceType: 'folder', resourceId: a.folder, principalType: 'user', principalRef: 'geheim-a-principal', permission: 'note:read', effect: 'deny' } });
    assert.equal(e.status, 201, e.text);
    a.acl = JSON.parse(e.text).id;
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query("INSERT INTO notes.acl_entry (tenant_id, resource_type, principal_type, principal_ref, permission, effect) VALUES ($1, 'tenant', 'group', '/orgs/acme/geheim', 'note:read', 'deny')", [A]));
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('1. fremde IDs: gleiche Antwort wie eine unbekannte ID, ohne Daten von A', async () => {
    const problems: string[] = [];
    for (const f of FOREIGN) {
      const foreign = idSource(a), unknown = idSource(null, { unknown: k => (k === 'client' ? unknownKey('client') : k === 'alias' ? unknownKey('org') : crypto.randomUUID()) });
      const cf = f.call(foreign.ids), cu = f.call(unknown.ids);
      const rf = await as('gus', cf), ru = await as('gus', cu);
      for (const [r, c] of [[rf, cf], [ru, cu]] as const) { const u = unreached(r, c.method, f.route); if (u) problems.push(`${f.label}: ${u}`); }
      problems.push(...leaks(rf.text, { markers: MARKERS.filter(m => !cf.url.includes(m)), ids: Object.values(a).filter(v => !cf.url.includes(v)) }).map(x => `${f.label}: ${x}`));
      const same = (r: ProbeResponse, used: Map<string, string>) => ({ status: r.status, body: normalize(r.text, new Map([...used].map(([k, v]) => [k, v]))) });
      // Die Client-ID ist eine Eingabe von B (Echo im Namen): im Vergleich durch ihren Schlüssel ersetzt
      const f1 = same(rf, foreign.used), u1 = same(ru, unknown.used);
      if (JSON.stringify(f1) !== JSON.stringify(u1)) problems.push(`${f.label}: Antwort verrät die Existenz (${JSON.stringify(f1).slice(0, 300)} ≠ ${JSON.stringify(u1).slice(0, 300)})`);
      covered.set(f.route, 'fremde IDs');
    }
    assert.deepEqual(problems, []);
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.acl_entry WHERE id = $1', [a.acl])).rows[0].n, 1, 'Regel von A unverändert');
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.client_grant g JOIN notes.tenant t ON t.id = g.tenant_id WHERE t.alias = 'acme' AND g.client_id = 'geheim-client'")).rows[0].n, 1, 'Freigabe von A unverändert');
    assert.deepEqual(kc.rolesOf(orgA, alice), ['org-admin'], 'Rollen von alice in A unverändert');
    assert.ok(kc.orgMembers.get(orgA.id)!.has(alice.id) && orgA.enabled && orgA.name === 'GEHEIM-A AG', 'Mitgliedschaft und Organisation A unverändert');
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.member_invitation WHERE id = $1 AND accepted_at IS NULL', [a.invitation])).rows[0].n, 1, 'Einladung von A offen');
    // Eigene Freigaben von B aus den Aufrufen (Eingaben von B) entfernen, damit die Listen in 2. nur Daten von B ohne Echo zeigen
    await t.inspect.query("DELETE FROM notes.client_grant g USING notes.tenant t WHERE t.id = g.tenant_id AND t.alias = 'globex'");
  });

  test('2. Listen und Konto: nur Daten von B', async () => {
    const problems: string[] = [];
    for (const l of LISTS) {
      const r = await as('gus', { method: 'GET', url: l.url });
      const u = unreached(r, 'GET', l.route);
      if (u) problems.push(`${l.url}: ${u}`);
      if (r.status !== 200) problems.push(`${l.url}: ${r.status} ${r.text.slice(0, 200)}`);
      problems.push(...leaks(r.text, { markers: MARKERS, ids: Object.values(a), allowed: [l.url, '/orgs/acme/geheim'] }).map(x => `${l.url}: ${x}`));
      covered.set(l.route, 'Liste');
    }
    assert.deepEqual(problems, []);
    assert.deepEqual(JSON.parse((await as('gus', { method: 'GET', url: '/v1/acl' })).text).items, []);
  });

  test('3. Einladen einer Adresse aus A: Antwort wie für eine neue Adresse, ohne Angaben aus dem Konto', async () => {
    const invite = (email: string) => as('gus', { method: 'POST', url: '/v1/admin/members', body: { email } });
    const known = await invite('alice@acme.example'), fresh = await invite(`neu-${crypto.randomUUID().slice(0, 6)}@globex.example`);
    assert.equal(known.status, 202, known.text);
    const body = (r: ProbeResponse) => JSON.parse(r.text);
    const neutral = (b: any) => ({ ...b, member: { ...b.member, id: '-', email: '-', name: '-', username: '-', createdAt: '-' } });
    assert.deepEqual([fresh.status, neutral(body(fresh))], [known.status, neutral(body(known))]);
    assert.deepEqual(leaks(known.text, { markers: MARKERS.filter(m => !['alice@acme', 'acme'].includes(m)), ids: Object.values(a) }), []);
    const members = JSON.parse((await as('gus', { method: 'GET', url: '/v1/admin/members' })).text).items as { id: string; name: string; lastSeenAt: string | null }[];
    const invited = members.find(m => m.id === body(known).member.id)!;
    assert.ok(invited && !/Alice Geheim/i.test(invited.name) && invited.lastSeenAt === null, JSON.stringify(invited));
    const del = await as('gus', { method: 'DELETE', url: `/v1/admin/members/${body(known).member.id}` });
    assert.deepEqual([del.status, JSON.parse(del.text)], [200, { accountDeleted: false }]);
    assert.ok(kc.users.has(alice.id), 'Konto von alice bleibt');
    assert.deepEqual(kc.rolesOf(orgA, alice), ['org-admin'], 'Rollen von alice in A unverändert');
    covered.set('POST /v1/admin/members', 'Eindeutigkeit nur im Mandanten (Einladung einer Adresse aus A)');
  });

  test('4. Vollständigkeit: jede Route des Pakets geprüft, Routen der App begründet ausgenommen', () => {
    const { missing, stale } = coverageProblems({ all: [...collector.routes].filter(r => r.split(' ')[1]!.startsWith('/v1/') && !r.startsWith('HEAD ')), covered, exempt: EXEMPT });
    assert.deepEqual({ missing, stale }, { missing: [], stale: [] });
    assert.ok(covered.size >= 20);
  });
});
