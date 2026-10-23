/**
 * Modul `admin`: Verwaltung von Organisationen, Mitgliedern und Rollen (aus Assets test/platform/admin.test.ts,
 * produktneutral mit der Beispiel-App «notes»), über app.inject gegen Wegwerf-Datenbank, Mock-IdP und den
 * `KeycloakFake` des Test-Kits. Schwerpunkte: Mandantengrenze (auch mit manipulierten IDs), letzter aktiver org-admin,
 * Rechte, Audit, gleiche Antworten beim Einladen, abgeschaltete Verwaltung; dazu der Abgleich im Worker (MemberSync).
 * Assets-Teile ohne Gegenstück im Paket (`/v1/people`, `/v1/tenant`, Objekte) sind über die Tabellen geprüft.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { KeycloakFake, startMockIdp, type FakeOrg, type FakeUser, type MockIdp } from '@vollholz/iam-testkit';
import { pgAudit } from '../src/audit.ts';
import { KeycloakAdmin } from '../src/keycloak.ts';
import { setTenantStatus } from '../src/tenants.ts';
import { MemberSync, syncAllMembers, syncTenantName } from '../src/sync.ts';
import { notesCatalog } from './support/catalogs.ts';
import { testConfig } from './support/config.ts';
import { skipDb } from './support/db.ts';
import { claims, notesApp, notesDb, tenant, type NotesApp } from './support/http.ts';

const skip = await skipDb();
type Res = { status: number; body: any };
const MGMT = { DPOP_MODE: 'optional', KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' };
const ctx = { schema: 'notes', audit: pgAudit({ schema: 'notes' }) };

describe('Verwaltung von Mitgliedern und Organisationen', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp, off: NotesApp;
  const kc = new KeycloakFake();
  const tok: Record<string, string> = {};
  const u = {} as Record<'anna' | 'carla' | 'dana' | 'ben' | 'mona' | 'paula', FakeUser>;
  let demo: FakeOrg, muster: FakeOrg;

  async function call(who: string, method: string, url: string, body?: unknown, o: { app?: NotesApp; headers?: Record<string, string> } = {}): Promise<Res> {
    const r = await (o.app ?? n).app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tok[who]}`, ...o.headers }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const auditOf = async (alias: string, action: string) => (await t.inspect.query<{ actor_name: string; resource_id: string; data: any; source: string }>(
    'SELECT a.actor_name, a.resource_id::text, a.data, a.source FROM notes.audit_log a JOIN notes.tenant t ON t.id = a.tenant_id WHERE t.alias = $1 AND a.action = $2 ORDER BY a.seq', [alias, action])).rows;
  /** Personenverzeichnis (in Assets GET /v1/people): Mitglieder ohne removed_at. */
  const people = async (alias: string) => (await t.inspect.query<{ id: string; subject: string; display_name: string; email: string | null; last_seen_at: Date | null }>(
    "SELECT p.id, p.subject, p.display_name, p.email, p.last_seen_at FROM notes.principal p JOIN notes.tenant t ON t.id = p.tenant_id WHERE t.alias = $1 AND p.kind = 'user' AND p.removed_at IS NULL ORDER BY p.display_name", [alias])).rows;
  const app = (env: Record<string, string> = MGMT) => notesApp({ db: t.runtime, issuer: idp.issuer, env, keycloakFetch: kc.fetch });

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    demo = kc.org('demo', 'Demo AG'); muster = kc.org('muster', 'Muster GmbH'); const ops = kc.org('ops', 'Betrieb');
    u.anna = kc.user('anna', { email: 'anna@demo.example', firstName: 'Anna', lastName: 'Admin' });
    u.carla = kc.user('carla', { email: 'carla@demo.example', firstName: 'Carla', lastName: 'Prüferin' });
    u.dana = kc.user('dana', { email: 'dana@demo.example', firstName: 'Dana', lastName: 'Duss' });
    u.ben = kc.user('ben', { email: 'ben@muster.example', firstName: 'Ben', lastName: 'Leser' });
    u.mona = kc.user('mona', { email: 'mona@muster.example', firstName: 'Mona', lastName: 'Muster' });
    u.paula = kc.user('paula', { email: 'paula@ops.example', firstName: 'Paula', lastName: 'Plattform' });
    kc.member(demo, u.anna, ['org-admin']); kc.member(demo, u.carla, ['viewer', 'editor']); kc.member(demo, u.dana, ['viewer']);
    kc.member(muster, u.ben, ['viewer']); kc.member(muster, u.mona, ['org-admin']);
    kc.member(ops, u.paula, ['org-admin']);
    for (const alias of ['demo', 'muster', 'ops']) for (const r of ['org-admin', 'editor', 'viewer']) kc.groupPath(`/orgs/${alias}/${r}`);

    n = await app();
    off = await app({ DPOP_MODE: 'optional' });

    const person = (x: FakeUser, org: string, roles: string[], extra: Record<string, unknown> = {}) => idp.token({ ...claims.user({ sub: x.id, org, groupRoles: roles, email: x.email, name: `${x.firstName} ${x.lastName}` }), ...extra });
    tok.anna = await person(u.anna, 'demo', ['org-admin']);
    tok.carla = await person(u.carla, 'demo', ['viewer', 'editor']);
    tok.mona = await person(u.mona, 'muster', ['org-admin']);
    tok.ben = await person(u.ben, 'muster', ['viewer']);
    tok.paula = await person(u.paula, 'ops', ['org-admin'], { realm_access: { roles: ['platform-admin'] } });
    await tenant(t.runtime, 'demo', 'demo-m2m');
    tok.svc = await idp.token(claims.client({ clientId: 'demo-m2m', org: 'demo', roles: ['org-admin'], scopes: ['notes:read', 'notes:write'] }));
    tok.mcp = await idp.token({ ...claims.user({ sub: u.anna.id, org: 'demo', groupRoles: ['org-admin'] }), azp: 'notes-mcp', scope: 'notes:read notes:write' });
    // anna, ben … waren schon in der App (Personenverzeichnis), dana noch nie
    for (const who of ['anna', 'ben', 'mona', 'paula']) ok(await call(who, 'GET', '/v1/me'));
  });
  after(async () => { await n?.app.close(); await off?.app.close(); await idp?.close(); await t?.drop(); });

  test('abgeschaltet ohne KEYCLOAK_MGMT_CLIENT_ID: Status mit Hinweis, Endpunkte 503, ohne Recht 403', async () => {
    assert.equal(off.iam.admin, null);
    assert.equal(off.iam.memberAccess, null, 'ohne Verwaltung simuliert GET /v1/acl/effective');
    const s = ok(await call('anna', 'GET', '/v1/admin/status', undefined, { app: off }));
    assert.equal(s.enabled, false);
    assert.match(s.reason, /KEYCLOAK_MGMT_CLIENT_ID/);
    assert.equal(s.canManageMembers, false);
    const r = await call('anna', 'GET', '/v1/admin/members', undefined, { app: off });
    assert.equal(r.status, 503);
    assert.equal(r.body.title, 'Verwaltung nicht eingerichtet');
    assert.equal((await call('carla', 'GET', '/v1/admin/members', undefined, { app: off })).status, 403, 'ohne Recht bleibt es 403');
    assert.equal((await call('paula', 'GET', '/v1/platform/organizations', undefined, { app: off })).status, 503);
    assert.equal((await call('paula', 'POST', '/v1/platform/organizations/demo/suspend', undefined, { app: off })).status, 503);
    // ohne Verwaltungs-Client kein Abgleich des Namens: der Alias aus der Anlage beim ersten Login bleibt
    assert.equal((await t.inspect.query("SELECT name FROM notes.tenant WHERE alias = 'demo'")).rows[0].name, 'demo');
    assert.equal((await auditOf('demo', 'organization.name_synced')).length, 0);
  });

  test('Status: Rollenkatalog mit Erklärung, Präfix der Rollengruppen, wer was darf', async () => {
    const a = ok(await call('anna', 'GET', '/v1/admin/status'));
    assert.deepEqual([a.enabled, a.canManageMembers, a.platformAdmin, a.organization, a.rolesManageable, a.groupRolePrefix], [true, true, false, 'demo', true, '/orgs']);
    const viewer = a.roles.find((r: any) => r.key === 'viewer');
    assert.ok(viewer.description.length > 10 && viewer.label === 'Leser:in' && viewer.permissions.includes('note:read') && viewer.custom === false);
    assert.equal(a.roles.find((r: any) => r.key === 'org-admin').adminOnly, true);
    assert.equal(ok(await call('carla', 'GET', '/v1/admin/status')).canManageMembers, false);
    assert.equal(ok(await call('paula', 'GET', '/v1/admin/status')).platformAdmin, true);
    // anderes Präfix (GROUP_ROLE_PREFIX) erscheint so, wie die Gruppen heissen
    const other = await notesApp({ db: t.runtime, issuer: idp.issuer, env: { ...MGMT, GROUP_ROLE_PREFIX: '/kunden/' }, keycloakFetch: kc.fetch });
    try { assert.equal(ok(await call('anna', 'GET', '/v1/admin/status', undefined, { app: other })).groupRolePrefix, '/kunden'); } finally { await other.app.close(); }
    // eigene Rolle der Organisation im Katalog (custom)
    const demoId = (await t.inspect.query("SELECT id FROM notes.tenant WHERE alias = 'demo'")).rows[0].id;
    await t.inspect.query("INSERT INTO notes.tenant_role (tenant_id, key, label, description, permissions) VALUES ($1, 'c-pruefung', 'Prüfung', 'Liest alles', '{note:read,members:admin}')", [demoId]);
    const c = ok(await call('anna', 'GET', '/v1/admin/status')).roles.find((r: any) => r.key === 'c-pruefung');
    assert.deepEqual([c.custom, c.adminOnly, c.permissions], [true, false, ['note:read']], 'Rechte nur von org-admin entfallen');
    await t.inspect.query("DELETE FROM notes.tenant_role WHERE key = 'c-pruefung'");
  });

  test('Rechte: nur org-admin; Maschinen-Clients und MCP nie, auch mit Rolle org-admin', async () => {
    assert.equal((await call('carla', 'GET', '/v1/admin/members')).status, 403);
    assert.equal((await call('ben', 'POST', '/v1/admin/members', { email: 'x@muster.example' })).status, 403);
    assert.equal((await call('svc', 'GET', '/v1/admin/members')).status, 403, 'Client: kein Scope deckt members:admin');
    assert.equal((await call('mcp', 'GET', '/v1/admin/members')).status, 403, 'MCP: scopegebunden');
    assert.equal((await call('mcp', 'POST', '/v1/platform/organizations/demo/suspend', {})).status, 403);
    assert.equal(ok(await call('svc', 'GET', '/v1/admin/status')).canManageMembers, false);
    assert.ok(!ok(await call('svc', 'GET', '/v1/me')).permissions.includes('members:admin'));
    assert.ok(ok(await call('anna', 'GET', '/v1/me')).permissions.includes('members:admin'));
  });

  test('Liste: Mitglieder der eigenen Organisation mit Rollen, Status, letztem Zugriff; synchronisiert das Personenverzeichnis', async () => {
    const items = ok(await call('anna', 'GET', '/v1/admin/members')).items;
    assert.deepEqual(items.map((m: any) => m.username), ['anna', 'carla', 'dana'], 'nur demo, nach Name');
    const anna = items.find((m: any) => m.username === 'anna'), carla = items.find((m: any) => m.username === 'carla'), dana = items.find((m: any) => m.username === 'dana');
    assert.deepEqual(anna.roles, ['org-admin']);
    assert.deepEqual(carla.roles.sort(), ['editor', 'viewer']);
    assert.ok(anna.lastSeenAt, 'anna hat zugegriffen');
    assert.equal(dana.lastSeenAt, null, 'dana noch nie');
    assert.equal(dana.status, 'active', 'Passwort gesetzt, also nicht «eingeladen»');
    // dana ist jetzt im Personenverzeichnis (noch nie angemeldet)
    const p = (await people('demo')).find(x => x.email === 'dana@demo.example');
    assert.ok(p, 'dana im Verzeichnis');
    assert.equal(p!.last_seen_at, null);
    assert.equal(dana.principalId, p!.id);
    assert.ok(!(await people('demo')).some(x => x.email === 'ben@muster.example'), 'keine Personen anderer Mandanten');
    // meldet sich dana später an, ist es derselbe Eintrag
    const d = await idp.token(claims.user({ sub: u.dana.id, org: 'demo', groupRoles: ['viewer'], email: u.dana.email, name: 'Dana Duss' }));
    const me = await n.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${d}` } });
    assert.equal(JSON.parse(me.body).principal.id, p!.id);
  });

  test('echte Rollen für GET /v1/acl/effective (memberAccess, nur Rollen dieser Organisation)', async () => {
    assert.ok(n.iam.memberAccess);
    const carla = await n.iam.memberAccess!('demo', u.carla.id);
    assert.deepEqual(carla!.roles.sort(), ['editor', 'viewer']);
    assert.ok(carla!.groups.every(g => g.startsWith('/orgs/demo/')), 'keine Gruppen anderer Organisationen');
    assert.equal(await n.iam.memberAccess!('demo', u.ben.id), null, 'kein Mitglied von demo');
  });

  test('Mandantengrenze: org-admin von demo kann muster nicht verwalten, auch nicht mit manipulierten IDs', async () => {
    const before = kc.rolesOf(muster, u.ben);
    assert.equal((await call('anna', 'PUT', `/v1/admin/members/${u.ben.id}/roles`, { roles: ['org-admin'] })).status, 404, 'fremde Person: wie nicht vorhanden');
    assert.equal((await call('anna', 'PUT', `/v1/admin/members/${u.ben.id}/roles`, { roles: ['editor'] })).status, 404);
    assert.equal((await call('anna', 'DELETE', `/v1/admin/members/${u.ben.id}`)).status, 404);
    assert.equal((await call('anna', 'POST', `/v1/admin/members/${u.ben.id}/invitation`)).status, 404);
    assert.equal((await call('anna', 'PUT', `/v1/admin/members/${randomUUID()}/roles`, { roles: ['viewer'] })).status, 404);
    assert.equal((await call('anna', 'GET', '/v1/platform/organizations/muster/members')).status, 403);
    assert.equal((await call('anna', 'DELETE', `/v1/platform/organizations/muster/members/${u.ben.id}`)).status, 403);
    assert.equal((await call('anna', 'GET', '/v1/admin/members', undefined, { headers: { 'x-tenant': 'muster' } })).status, 403, 'Organisation nicht im Token');
    assert.equal((await call('anna', 'POST', '/v1/platform/organizations/muster/suspend')).status, 403);
    // ungültige ID → 422, kein Aufruf bei Keycloak
    const calls = kc.calls.length;
    assert.equal((await call('anna', 'DELETE', '/v1/admin/members/..%2F..%2Fusers')).status, 422);
    assert.equal((await call('paula', 'GET', '/v1/platform/organizations/DEMO/members')).status, 422, 'Alias nur klein (Schema)');
    assert.equal(kc.calls.length, calls);
    assert.deepEqual(kc.rolesOf(muster, u.ben), before, 'ben unverändert');
    assert.ok(kc.orgMembers.get(muster.id)!.has(u.ben.id));
    assert.ok(!kc.calls.some(c => c.includes(`/organizations/${muster.id}/members/`) && !c.startsWith('GET')), 'nie schreibend auf muster');
  });

  /** invitee: ID der Einladung (nach aussen), inviteeUser: Konto in Keycloak. */
  let invitee = '', inviteeUser = '';
  test('Einladen: neues Konto ohne Passwort, Mitglied mit Rolle, E-Mail «Passwort setzen»; ohne SMTP klarer Hinweis', async () => {
    const r = ok(await call('anna', 'POST', '/v1/admin/members', { email: 'Neu.Person@Demo.example', firstName: 'Nora', lastName: 'Neu', roles: ['viewer'] }), 202);
    assert.equal(r.result, 'invitation-sent');
    assert.equal(r.emailSent, false, 'kein SMTP');
    assert.equal(r.member.status, 'invited');
    assert.deepEqual(r.member.roles, ['viewer']);
    assert.equal(r.member.email, 'neu.person@demo.example');
    invitee = r.member.id;
    const ku = kc.byEmail('neu.person@demo.example')!;
    inviteeUser = ku.id;
    assert.notEqual(invitee, ku.id, 'nach aussen die ID der Einladung, nicht die des Kontos');
    assert.equal(ku.password, false, 'kein Passwort über die App');
    assert.deepEqual(ku.requiredActions, ['UPDATE_PASSWORD']);
    assert.ok(kc.orgMembers.get(demo.id)!.has(ku.id));
    assert.deepEqual(kc.rolesOf(demo, ku), ['viewer']);
    const a = await auditOf('demo', 'member.invited');
    assert.equal(a.at(-1)!.resource_id, invitee);
    assert.equal(a.at(-1)!.actor_name, 'Anna Admin');
    assert.deepEqual(a.at(-1)!.data.roles, ['viewer']);
    assert.equal(a.at(-1)!.data.emailSent, false);
    // erst nach Annahme im Personenverzeichnis (gleich wie bei bestehendem Konto); in der Liste als eingeladen
    assert.equal(ok(await call('anna', 'GET', '/v1/admin/members')).items.find((m: any) => m.id === invitee).status, 'invited');
    assert.ok(!(await people('demo')).some(p => p.subject === ku.id));
    // erneut senden mit SMTP
    kc.smtp = true;
    assert.equal(ok(await call('anna', 'POST', `/v1/admin/members/${invitee}/invitation`)).emailSent, true);
    const mail = kc.mails.at(-1)!;
    assert.deepEqual(mail.actions, ['UPDATE_PASSWORD', 'VERIFY_EMAIL']);
    assert.match(mail.query!, /client_id=notes-platform/);
    assert.match(mail.query!, /lifespan=259200/);
    kc.smtp = false;
    assert.equal((await call('anna', 'POST', `/v1/admin/members/${u.carla.id}/invitation`)).status, 409, 'Passwort schon gesetzt');
  });

  test('Einladen: Prüfungen (bereits Mitglied, bestehendes Konto, ungültig, org-admin nur Plattform)', async () => {
    assert.equal((await call('anna', 'POST', '/v1/admin/members', { email: 'carla@demo.example' })).status, 409);
    assert.equal((await call('anna', 'POST', '/v1/admin/members', { email: 'kein-at' })).status, 422);
    assert.equal((await call('anna', 'POST', '/v1/admin/members', { email: 'x@demo.example', roles: ['gott'] })).status, 422);
    const adm = await call('anna', 'POST', '/v1/admin/members', { email: 'chef@demo.example', roles: ['org-admin'] });
    assert.equal(adm.status, 403);
    assert.equal(kc.byEmail('chef@demo.example'), null, 'nichts angelegt');
    // bestehendes Konto einer anderen Organisation: Einladung durch Keycloak, Mitglied erst nach Annahme
    kc.smtp = true;
    const r = ok(await call('anna', 'POST', '/v1/admin/members', { email: 'ben@muster.example', firstName: 'B.', lastName: 'Gast', roles: ['viewer'] }), 202);
    kc.smtp = false;
    assert.deepEqual([r.result, r.emailSent, r.member.status, r.member.name, r.member.email, r.member.principalId], ['invitation-sent', true, 'invited', 'B. Gast', 'ben@muster.example', null], 'Angaben aus der Einladung, nicht aus dem Konto');
    assert.ok(!kc.orgMembers.get(demo.id)!.has(u.ben.id), 'ben ist (noch) nicht Mitglied von demo');
    assert.deepEqual(kc.rolesOf(demo, u.ben), ['viewer'], 'Rolle gesetzt, wirkt erst mit der Mitgliedschaft');
    assert.equal(kc.mails.at(-1)!.kind, 'invite-existing');
    assert.equal((await call('anna', 'POST', '/v1/admin/members', { email: 'ben@muster.example' })).status, 409, 'bereits eingeladen (eigene Organisation)');
    // Offene Einladung nur über ihre ID, nicht über die Keycloak-ID des Kontos
    assert.notEqual(r.member.id, u.ben.id);
    assert.equal((await call('anna', 'DELETE', `/v1/admin/members/${u.ben.id}`)).status, 404);
    assert.equal((await call('anna', 'PUT', `/v1/admin/members/${u.ben.id}/roles`, { roles: [] })).status, 404);
    // Einladung zurückziehen: Rolle weg, Konto bleibt, nichts über andere Organisationen
    const w = ok(await call('anna', 'DELETE', `/v1/admin/members/${r.member.id}`));
    assert.equal(w.accountDeleted, false);
    assert.ok(kc.users.has(u.ben.id) && kc.orgMembers.get(muster.id)!.has(u.ben.id), 'Konto und Mitgliedschaft in muster unberührt');
    assert.deepEqual(kc.rolesOf(demo, u.ben), []);
    assert.deepEqual(kc.rolesOf(muster, u.ben), ['viewer']);
  });

  test('Rollen setzen: zuweisen und entziehen mit Audit; org-admin nur Plattform; unbekannte Rolle 422', async () => {
    const m = ok(await call('anna', 'PUT', `/v1/admin/members/${invitee}/roles`, { roles: ['editor'] }));
    assert.deepEqual(m.roles, ['editor']);
    assert.deepEqual(kc.rolesOf(demo, { id: inviteeUser }), ['editor']);
    const a = (await auditOf('demo', 'member.roles_changed')).at(-1)!;
    assert.deepEqual([a.data.added, a.data.removed], [['editor'], ['viewer']]);
    assert.equal(a.source, 'api');
    assert.equal((await call('anna', 'PUT', `/v1/admin/members/${invitee}/roles`, { roles: ['org-admin'] })).status, 403);
    assert.equal((await call('anna', 'PUT', `/v1/admin/members/${u.anna.id}/roles`, { roles: [] })).status, 403, 'eigene Admin-Rolle abgeben: nur Plattform');
    assert.equal((await call('anna', 'PUT', `/v1/admin/members/${invitee}/roles`, { roles: ['superuser'] })).status, 422);
    const count = (await auditOf('demo', 'member.roles_changed')).length;
    ok(await call('anna', 'PUT', `/v1/admin/members/${invitee}/roles`, { roles: ['editor'] }));
    assert.equal((await auditOf('demo', 'member.roles_changed')).length, count, 'ohne Änderung kein Eintrag');
  });

  test('Letzter org-admin: weder entfernen noch herabstufen, auch nicht durch die Plattform; sich selbst entfernen geht nicht', async () => {
    assert.equal((await call('anna', 'DELETE', `/v1/admin/members/${u.anna.id}`)).status, 409, 'sich selbst');
    const last = await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.anna.id}/roles`, { roles: ['viewer'] });
    assert.equal(last.status, 409);
    assert.equal(last.body.reason, 'last-admin');
    assert.equal((await call('paula', 'DELETE', `/v1/platform/organizations/demo/members/${u.anna.id}`)).status, 409);
    assert.deepEqual(kc.rolesOf(demo, u.anna), ['org-admin']);
    // gesperrtes Konto zählt nicht als Admin
    ok(await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.carla.id}/roles`, { roles: ['org-admin', 'viewer'] }));
    u.carla.enabled = false;
    assert.equal((await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.anna.id}/roles`, { roles: [] })).status, 409);
    u.carla.enabled = true;
    // mit einer zweiten aktiven Person geht es; Audit im Mandanten demo mit Kennzeichen der Plattform
    ok(await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.anna.id}/roles`, { roles: ['org-admin'] }));
    const a = (await auditOf('demo', 'member.roles_changed')).at(-1)!;
    assert.equal(a.actor_name, 'Paula Plattform');
    assert.equal(a.data.platformAdmin, true);
    assert.equal(a.data.actorTenant, 'ops');
    // anna (org-admin) darf carla (org-admin) nicht entfernen
    assert.equal((await call('anna', 'DELETE', `/v1/admin/members/${u.carla.id}`)).status, 403);
    ok(await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.carla.id}/roles`, { roles: ['viewer', 'editor'] }));
  });

  test('Letzter org-admin: nur aktive zählen – eine nie angenommene Einladung mit org-admin (Konto angelegt) zählt nicht (Spez. 9.1 Nr. 6)', async () => {
    // Plattform lädt eine neue Adresse mit org-admin ein: Konto entsteht, ist sofort Mitglied mit offenem «Passwort setzen»
    const inv = ok(await call('paula', 'POST', '/v1/platform/organizations/demo/members', { email: 'chefin-neu@demo.example', roles: ['org-admin'] }), 202);
    const ku = kc.byEmail('chefin-neu@demo.example')!;
    assert.ok(kc.orgMembers.get(demo.id)!.has(ku.id) && kc.rolesOf(demo, ku).includes('org-admin'), 'Gruppenmitglied org-admin und Mitglied (wie Assets)');
    const last = await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.anna.id}/roles`, { roles: ['viewer'] });
    assert.deepEqual([last.status, last.body.reason], [409, 'last-admin'], 'die eingeladene Person kann sich noch nicht anmelden');
    assert.equal((await call('paula', 'DELETE', `/v1/platform/organizations/demo/members/${u.anna.id}`)).status, 409);
    assert.deepEqual(kc.rolesOf(demo, u.anna), ['org-admin']);
    // angenommen (Passwort gesetzt, Abgleich schliesst die Einladung ab): jetzt aktiv
    ku.requiredActions = []; ku.password = true;
    ok(await call('anna', 'GET', '/v1/admin/members'));
    assert.equal(ok(await call('anna', 'GET', '/v1/admin/members')).items.find((m: any) => m.id === ku.id)?.status, 'active');
    ok(await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.anna.id}/roles`, { roles: ['viewer'] }));
    ok(await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.anna.id}/roles`, { roles: ['org-admin'] }));
    assert.ok(inv.member.id);
    ok(await call('paula', 'DELETE', `/v1/platform/organizations/demo/members/${ku.id}`));
    assert.equal((await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.anna.id}/roles`, { roles: ['viewer'] })).status, 409, 'wieder allein');
  });

  test('Gleichzeitig: zwei Admins gleichzeitig herabstufen – einer bleibt', async () => {
    ok(await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.carla.id}/roles`, { roles: ['org-admin'] }));
    const [a, b] = await Promise.all([
      call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.anna.id}/roles`, { roles: ['viewer'] }),
      call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.carla.id}/roles`, { roles: ['viewer'] }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal([u.anna, u.carla].filter(x => kc.rolesOf(demo, x).includes('org-admin')).length, 1);
    // Ausgangslage: anna Admin, carla viewer/editor
    ok(await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.anna.id}/roles`, { roles: ['org-admin'] }));
    ok(await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.carla.id}/roles`, { roles: ['viewer', 'editor'] }));
  });

  test('Entfernen: Rollen und Mitgliedschaft weg; nie angenommene Einladung löscht das Konto; Verzeichnis und Audit', async () => {
    const r = ok(await call('anna', 'DELETE', `/v1/admin/members/${invitee}`));
    assert.equal(r.accountDeleted, false, 'org-admin erfährt nicht, ob das Konto gelöscht wurde');
    assert.ok(!kc.users.has(inviteeUser), 'unbenutztes, mit der Einladung angelegtes Konto gelöscht');
    const a = (await auditOf('demo', 'member.invitation_withdrawn')).at(-1)!;
    assert.deepEqual([a.resource_id, a.data.accountDeleted, a.data.roles], [invitee, undefined, ['editor']]);
    // Person mit Passwort: Konto bleibt, im Verzeichnis als entfernt markiert
    const x = kc.user('xaver', { email: 'xaver@demo.example' }); kc.member(demo, x, ['viewer']);
    ok(await call('anna', 'GET', '/v1/admin/members'));
    assert.ok((await people('demo')).some(p => p.subject === x.id));
    assert.equal(ok(await call('anna', 'DELETE', `/v1/admin/members/${x.id}`)).accountDeleted, false);
    assert.equal((await auditOf('demo', 'member.removed')).at(-1)!.resource_id, x.id);
    assert.ok(kc.users.has(x.id));
    assert.deepEqual(kc.rolesOf(demo, x), []);
    assert.ok(!kc.orgMembers.get(demo.id)!.has(x.id));
    assert.ok(!(await people('demo')).some(p => p.subject === x.id), 'nicht mehr auswählbar');
  });

  test('Mandantentrennung: Einladen verrät nicht, ob ein Konto besteht oder einer anderen Organisation gehört', async () => {
    const slow = await app({ ...MGMT, KEYCLOAK_MGMT_INVITE_MIN_TIME: '400ms' });
    try {
      const invite = async (email: string) => { const t0 = Date.now(); const r = await call('anna', 'POST', '/v1/admin/members', { email, roles: ['viewer'] }, { app: slow }); return { ...r, ms: Date.now() - t0 }; };
      // bestehendes Konto (mona: org-admin von muster), neue Adresse, Benutzername schon vergeben (anderes Konto)
      kc.user('kollision', { username: 'kollision@demo.example', email: 'jemand-anders@muster.example' });
      const cases = [await invite('mona@muster.example'), await invite('niemand@demo.example'), await invite('kollision@demo.example')];
      const neutral = (b: any) => ({ ...b, member: { ...b.member, id: '-', email: '-', name: '-', username: '-', createdAt: '-' } });
      for (const c of cases) {
        assert.equal(c.status, 202, JSON.stringify(c.body));
        assert.ok(c.ms >= 390, `Mindestdauer (${c.ms} ms)`);
        assert.deepEqual(neutral(c.body), neutral(cases[0]!.body));
        assert.equal(c.body.member.name, c.body.member.email, 'Name aus der Einladung (keiner angegeben), nicht aus dem Konto');
      }
      const list = ok(await call('anna', 'GET', '/v1/admin/members')).items;
      const rows = ['mona@muster.example', 'niemand@demo.example', 'kollision@demo.example'].map(e => list.find((m: any) => m.email === e));
      for (const r of rows) assert.deepEqual([r.status, r.principalId, r.lastSeenAt, r.roles], ['invited', null, null, ['viewer']]);
      assert.equal(rows[0].name, 'mona@muster.example', 'nicht «Mona Muster» aus dem Konto');
      assert.ok(!JSON.stringify(list).includes('Mona') && !JSON.stringify(list).includes('jemand-anders'));
      assert.ok(!(await people('demo')).some(p => /muster\.example/.test(p.email ?? '')), 'Personenverzeichnis erst nach Annahme');
      for (const a of (await auditOf('demo', 'member.invited')).slice(-3)) assert.deepEqual(Object.keys(a.data).sort(), ['email', 'emailSent', 'roles']);
      const resend = await Promise.all(rows.map(r => call('anna', 'POST', `/v1/admin/members/${r.id}/invitation`)));
      assert.deepEqual(resend.map(r => [r.status, r.body.title]), resend.map(() => [502, 'Einladung nicht versendet']), 'ohne SMTP für alle gleich');
      const removed = [];
      for (const r of rows) removed.push(await call('anna', 'DELETE', `/v1/admin/members/${r.id}`));
      assert.deepEqual(removed.map(r => [r.status, r.body]), removed.map(() => [200, { accountDeleted: false }]));
      assert.ok(kc.users.has(u.mona.id) && kc.orgMembers.get(muster.id)!.has(u.mona.id), 'mona bleibt in muster');
      assert.deepEqual(kc.rolesOf(muster, u.mona), ['org-admin']);
      assert.equal(kc.byEmail('niemand@demo.example'), null, 'unbenutztes neues Konto gelöscht');
    } finally { await slow.app.close(); }
  });

  test('Person in zwei Organisationen: die Verwaltung zeigt nur Rollen und Angaben dieser Organisation', async () => {
    const d = kc.user('doppel', { email: 'doppel@example.ch', firstName: 'Dora', lastName: 'Doppel' });
    kc.member(demo, d, ['editor']); kc.member(muster, d, ['org-admin', 'viewer']);
    const m = ok(await call('anna', 'GET', '/v1/admin/members')).items.find((x: any) => x.id === d.id);
    assert.deepEqual(m.roles, ['editor']);
    assert.ok(!JSON.stringify(m).includes('muster') && !JSON.stringify(m).includes('org-admin'));
    assert.equal(m.createdAt, null, 'kein Kontoalter aus Keycloak (verriete ein früheres Konto)');
    assert.deepEqual(ok(await call('anna', 'DELETE', `/v1/admin/members/${d.id}`)), { accountDeleted: false });
    assert.deepEqual(kc.rolesOf(muster, d), ['org-admin', 'viewer']);
    assert.ok(kc.orgMembers.get(muster.id)!.has(d.id));
  });

  test('Keycloak verweigert (fehlendes Recht des Service Accounts) → 502 mit Hinweis, nichts protokolliert', async () => {
    kc.deny = [/^PUT \/users\/.*\/groups\//];
    const count = (await auditOf('demo', 'member.roles_changed')).length;
    const r = await call('anna', 'PUT', `/v1/admin/members/${u.dana.id}/roles`, { roles: ['viewer', 'editor'] });
    kc.deny = [];
    assert.equal(r.status, 502);
    assert.match(r.body.detail, /Realm-Modul/);
    assert.equal((await auditOf('demo', 'member.roles_changed')).length, count);
    assert.deepEqual(kc.rolesOf(demo, u.dana), ['viewer']);
  });

  test('Plattform: nur platform-admin; Organisationen auflisten mit Mandantenstatus', async () => {
    assert.equal((await call('anna', 'GET', '/v1/platform/organizations')).status, 403);
    assert.equal((await call('mona', 'POST', '/v1/platform/organizations', { alias: 'x', name: 'X' })).status, 403);
    const list = ok(await call('paula', 'GET', '/v1/platform/organizations')).items;
    assert.deepEqual(list.map((o: any) => o.alias).filter((a: string) => a !== 'leer'), ['demo', 'muster', 'ops']);
    assert.equal(list.find((o: any) => o.alias === 'ops').tenant.status, 'active');
    assert.equal(list.find((o: any) => o.alias === 'demo').tenant.status, 'active');
    assert.deepEqual(list.find((o: any) => o.alias === 'demo').domains, ['demo.example']);
  });

  test('Plattform: Rollen einer anderen Organisation lesen (Format von /v1/roles, mit eigenen Rollen) und eigene Rolle zuweisen', async () => {
    const demoId = (await t.inspect.query("SELECT id FROM notes.tenant WHERE alias = 'demo'")).rows[0].id;
    await t.inspect.query("INSERT INTO notes.tenant_role (tenant_id, key, label, description, permissions) VALUES ($1, 'c-pruefung', 'Prüfung', 'Liest Notizen', '{note:read,tenant:read}')", [demoId]);
    try {
      assert.equal((await call('anna', 'GET', '/v1/platform/organizations/demo/roles')).status, 403, 'nur platform-admin');
      assert.equal((await call('mcp', 'GET', '/v1/platform/organizations/demo/roles')).status, 403);
      assert.equal((await call('paula', 'GET', '/v1/platform/organizations/unbekannt/roles')).status, 404);
      assert.equal((await call('paula', 'GET', '/v1/platform/organizations/demo/roles', undefined, { app: off })).status, 503);
      const r = ok(await call('paula', 'GET', '/v1/platform/organizations/demo/roles'));
      assert.deepEqual(r.items.map((x: any) => [x.key, x.custom, x.adminOnly]), [['org-admin', false, true], ['editor', false, false], ['viewer', false, false], ['c-pruefung', true, false]]);
      const c = r.items.at(-1);
      assert.deepEqual([c.label, c.permissions, c.version, typeof c.id, c.memberCount], ['Prüfung', ['tenant:read', 'note:read'], 1, 'string', 0]);
      assert.equal(r.items[0].memberCount, 1, 'org-admin: anna');
      assert.deepEqual([r.maxCustom, r.customPermissions.includes('members:admin'), r.customPermissions.includes('note:read')], [50, false, true]);
      // eigene Rolle über die Plattform zuweisen (legt die Gruppe an) und wieder entziehen
      n.iam.admin!.forgetRoles('demo');
      assert.deepEqual(ok(await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.dana.id}/roles`, { roles: ['viewer', 'c-pruefung'] })).roles.sort(), ['c-pruefung', 'viewer']);
      assert.equal(ok(await call('paula', 'GET', '/v1/platform/organizations/demo/roles')).items.at(-1).memberCount, 1);
      ok(await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.dana.id}/roles`, { roles: ['viewer'] }));
      // Organisation in Keycloak, noch nie benutzt: nur vordefinierte Rollen, kein Mandant angelegt
      kc.org('leer', 'Leer');
      assert.deepEqual(ok(await call('paula', 'GET', '/v1/platform/organizations/leer/roles')).items.map((x: any) => x.key), ['org-admin', 'editor', 'viewer']);
      assert.equal((await t.inspect.query("SELECT 1 FROM notes.tenant WHERE alias = 'leer'")).rowCount, 0);
    } finally {
      await t.inspect.query("DELETE FROM notes.tenant_role WHERE key = 'c-pruefung'");
      n.iam.admin!.forgetRoles('demo');
    }
  });

  test('Plattform: Name aus Keycloak ist massgeblich – Liste und Detail führen den Namen des Mandanten nach (protokolliert)', async () => {
    const tenantName = async (alias: string) => (await t.inspect.query('SELECT name FROM notes.tenant WHERE alias = $1', [alias])).rows[0].name;
    ok(await call('paula', 'GET', '/v1/platform/organizations'));
    assert.deepEqual([await tenantName('demo'), await tenantName('muster'), await tenantName('ops')], ['Demo AG', 'Muster GmbH', 'Betrieb']);
    const [e, ...more] = await auditOf('demo', 'organization.name_synced');
    assert.equal(more.length, 0);
    assert.deepEqual([e!.data, e!.source], [{ from: 'demo', to: 'Demo AG' }, 'system']);
    demo.name = 'Demo Holding AG';
    try {
      ok(await call('paula', 'GET', '/v1/platform/organizations/demo'));
      ok(await call('paula', 'GET', '/v1/platform/organizations'));
      assert.equal(await tenantName('demo'), 'Demo Holding AG');
      assert.deepEqual((await auditOf('demo', 'organization.name_synced')).map(a => a.data.to), ['Demo AG', 'Demo Holding AG']);
      assert.equal((await auditOf('muster', 'organization.name_synced')).length, 1);
    } finally {
      demo.name = 'Demo AG';
      ok(await call('paula', 'GET', '/v1/platform/organizations'));
    }
    // Veraltet gelesene Organisation (z. B. Liste vor einer Umbenennung über die Plattform) überschreibt den Namen nicht
    const kca = new KeycloakAdmin(testConfig(idp.issuer, MGMT), async () => `${idp.issuer}/protocol/openid-connect/token`, kc.fetch);
    const demoId = (await t.inspect.query("SELECT id FROM notes.tenant WHERE alias = 'demo'")).rows[0].id;
    assert.equal(await syncTenantName(ctx, t.runtime, kca, demoId, { ...demo, name: 'Alt AG' } as never), false);
    assert.equal(await tenantName('demo'), 'Demo AG', 'massgeblich ist der aktuelle Name in Keycloak');
  });

  test('Plattform: anlegen (Alias-Regeln, Gruppen, Mandant, Audit), umbenennen, Domänen, ersten Admin einladen', async () => {
    assert.equal((await call('paula', 'POST', '/v1/platform/organizations', { alias: 'Neu AG', name: 'Neu' })).status, 422);
    assert.equal((await call('paula', 'POST', '/v1/platform/organizations', { alias: '-neu', name: 'Neu' })).status, 422);
    assert.equal((await call('paula', 'POST', '/v1/platform/organizations', { alias: '\u212Aelvin', name: 'Kelvin' })).status, 422, 'Kelvin-Zeichen ist kein «k»');
    assert.equal((await call('paula', 'POST', '/v1/platform/organizations', { alias: 'neu', name: 'Neu', domains: ['kein domain'] })).status, 422);
    assert.equal((await call('paula', 'POST', '/v1/platform/organizations', { alias: 'demo', name: 'Doppelt' })).status, 409);
    const o = ok(await call('paula', 'POST', '/v1/platform/organizations', { alias: 'neu', name: 'Neu AG', domains: ['neu.example'] }), 201);
    assert.deepEqual([o.alias, o.name, o.enabled, o.domains, o.tenant.status], ['neu', 'Neu AG', true, ['neu.example'], 'active']);
    assert.ok([...kc.groups.values()].some(g => g.path === '/orgs/neu/org-admin'));
    assert.equal((await auditOf('neu', 'tenant.provisioned')).at(-1)!.actor_name, 'Paula Plattform');
    assert.deepEqual((await auditOf('neu', 'tenant.provisioned')).at(-1)!.data.domains, ['neu.example']);
    const r = ok(await call('paula', 'PATCH', '/v1/platform/organizations/neu', { name: 'Neu Holding AG', domains: ['neu.example', 'neu-holding.example'] }));
    assert.deepEqual([r.name, r.domains], ['Neu Holding AG', ['neu.example', 'neu-holding.example']]);
    assert.equal((await t.inspect.query("SELECT name FROM notes.tenant WHERE alias = 'neu'")).rows[0].name, 'Neu Holding AG');
    assert.deepEqual((await auditOf('neu', 'organization.updated')).at(-1)!.data.domains.added, ['neu-holding.example']);
    // Mandant scheitert nach der Organisation in Keycloak: Organisation wieder gelöscht
    await t.inspect.query("SELECT app.resolve_tenant('nur-db', null, 'Nur DB', true)");
    const before = kc.orgs.size;
    kc.fail = [{ re: /^GET \/group-by-path\/orgs\/kaputt/, status: 500 }];
    assert.equal((await call('paula', 'POST', '/v1/platform/organizations', { alias: 'kaputt', name: 'Kaputt' })).status, 502);
    kc.fail = [];
    assert.equal(kc.orgs.size, before, 'Organisation in Keycloak zurückgenommen');
    // erster Admin der neuen Organisation
    const inv = ok(await call('paula', 'POST', '/v1/platform/organizations/neu/members', { email: 'chefin@neu.example', roles: ['org-admin'] }), 202);
    assert.deepEqual(inv.member.roles, ['org-admin']);
    assert.ok(kc.orgMembers.get([...kc.orgs.values()].find(x => x.alias === 'neu')!.id)!.has(kc.byEmail('chefin@neu.example')!.id));
  });

  test('Plattform: sperren und entsperren – Keycloak und Mandant gleich; Body optional mit Grund; eigene Organisation nicht', async () => {
    assert.equal((await call('paula', 'POST', '/v1/platform/organizations/ops/suspend')).status, 409);
    const tooLong = await call('paula', 'POST', '/v1/platform/organizations/muster/suspend', { reason: 'x'.repeat(501) });
    assert.equal(tooLong.status, 422, JSON.stringify(tooLong.body));
    assert.equal(muster.enabled, true, 'nichts geändert');
    const s = ok(await call('paula', 'POST', '/v1/platform/organizations/muster/suspend', { reason: 'Vertrag beendet' }));
    assert.deepEqual([s.enabled, s.tenant.status], [false, 'suspended']);
    assert.equal(muster.enabled, false);
    const e = (await auditOf('muster', 'tenant.suspended')).at(-1)!;
    assert.deepEqual([e.data.reason, e.data.platformAdmin, e.actor_name], ['Vertrag beendet', true, 'Paula Plattform']);
    assert.equal((await call('anna', 'POST', '/v1/platform/organizations/muster/resume')).status, 403);
    const fresh = await idp.token(claims.user({ org: 'muster', groupRoles: ['viewer'] }));
    const r = await n.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${fresh}` } });
    assert.equal(r.statusCode, 403, 'gesperrter Mandant, sofort (Resolver dieser Instanz)');
    // ohne Body (auch ohne Content-Type) wie {}
    const back = ok(await call('paula', 'POST', '/v1/platform/organizations/muster/resume'));
    assert.deepEqual([back.enabled, back.tenant.status], [true, 'active']);
    assert.equal((await auditOf('muster', 'tenant.resumed')).at(-1)!.data.reason, '');
    // Keycloak scheitert → Mandant bleibt, wie er war
    kc.deny = [/^PUT \/organizations\//];
    assert.equal((await call('paula', 'POST', '/v1/platform/organizations/muster/suspend', {})).status, 502);
    kc.deny = [];
    assert.equal((await t.inspect.query("SELECT status FROM notes.tenant WHERE alias = 'muster'")).rows[0].status, 'active');
  });

  test('Anmeldung des Verwaltungs-Clients: Client Credentials, Token wird wiederverwendet', async () => {
    const own = kc.tokenRequests.filter(r => r.get('grant_type') === 'client_credentials');
    assert.ok(own.length >= 1 && own.length <= 8, `Token-Anfragen: ${own.length} (je App-Instanz eines)`);
  });

  test('V1: eigene ID je Einladung – zweimal einladen, erneut senden, zurückziehen: gleich für neues, bestehendes und gesperrtes Konto', async () => {
    const slow = await app({ ...MGMT, KEYCLOAK_MGMT_INVITE_MIN_TIME: '100ms' });
    try {
      // gesperrtes Konto einer anderen Organisation: Keycloak lehnt invite-existing-user mit 400 ab, bevor es eine E-Mail versucht
      const gesperrt = kc.user('gesperrt', { email: 'gesperrt@muster.example', enabled: false });
      kc.member(muster, gesperrt, ['viewer']);
      const timed = async (method: string, url: string, body?: unknown) => { const t0 = Date.now(); const r = await call('anna', method, url, body, { app: slow }); return { ...r, ms: Date.now() - t0 }; };
      const neutral = (b: any) => ({ ...b, member: { ...b.member, id: '-', email: '-', name: '-', username: '-', createdAt: '-' } });
      for (const smtp of [true, false]) {
        kc.smtp = smtp;
        const rounds: { id: string; form: unknown }[] = [];
        for (const email of [`neu-${smtp}@demo.example`, 'mona@muster.example', 'gesperrt@muster.example']) {
          for (let i = 0; i < 2; i++) {
            const inv = await timed('POST', '/v1/admin/members', { email, roles: ['viewer'] });
            const resend = await timed('POST', `/v1/admin/members/${inv.body.member.id}/invitation`);
            const del = await timed('DELETE', `/v1/admin/members/${inv.body.member.id}`);
            for (const x of [inv, resend, del]) assert.ok(x.ms >= 95, `Mindestdauer ${email} (${x.ms} ms)`);
            rounds.push({ id: inv.body.member.id, form: { inv: [inv.status, neutral(inv.body)], resend: [resend.status, resend.body.emailSent ?? resend.body.title], del: [del.status, del.body] } });
          }
        }
        for (const r of rounds) assert.deepEqual(r.form, rounds[0]!.form, `gleiche Antworten (SMTP ${smtp})`);
        assert.deepEqual(rounds[0]!.form, { inv: [202, neutral({ result: 'invitation-sent', emailSent: smtp, member: { status: 'invited', roles: ['viewer'], principalId: null, lastSeenAt: null, loginPath: null } })], resend: smtp ? [200, true] : [502, 'Einladung nicht versendet'], del: [200, { accountDeleted: false }] });
        assert.equal(new Set(rounds.map(r => r.id)).size, rounds.length, 'jede Einladung eine neue ID');
        assert.ok(rounds.every(r => !kc.users.has(r.id) && ![u.mona.id, gesperrt.id].includes(r.id)), 'nie die ID des Kontos');
      }
      assert.ok((await auditOf('demo', 'member.invited')).slice(-6).every(a => !kc.users.has(a.resource_id)), 'Protokoll: Einladungs-ID');
      assert.ok(kc.users.has(u.mona.id) && kc.users.has(gesperrt.id) && kc.orgMembers.get(muster.id)!.has(u.mona.id), 'bestehende Konten bleiben');
      assert.deepEqual([kc.rolesOf(demo, u.mona), kc.rolesOf(demo, gesperrt)], [[], []]);
    } finally { kc.smtp = false; await slow.app.close(); }
  });

  test('V2: Zurückziehen löscht nur ein Konto, das die Einladung selbst angelegt hat', async () => {
    const fremd = kc.user('fremd', { email: 'fremd@extern.example', password: false, requiredActions: ['UPDATE_PASSWORD'] });
    const a = ok(await call('paula', 'POST', '/v1/platform/organizations/demo/members', { email: 'fremd@extern.example', roles: ['viewer'] }), 202);
    const b = ok(await call('paula', 'POST', '/v1/platform/organizations/demo/members', { email: 'selbst@demo.example', roles: ['viewer'] }), 202);
    const selbst = kc.byEmail('selbst@demo.example')!;
    const created = async (id: string) => (await t.inspect.query('SELECT created_account FROM notes.member_invitation WHERE id = $1', [id])).rows[0]?.created_account;
    assert.deepEqual([await created(a.member.id), await created(b.member.id)], [false, true]);
    assert.deepEqual(ok(await call('paula', 'DELETE', `/v1/platform/organizations/demo/members/${a.member.id}`)), { accountDeleted: false });
    assert.ok(kc.users.has(fremd.id), 'fremdes Konto bleibt');
    assert.deepEqual(kc.rolesOf(demo, fremd), []);
    assert.deepEqual(ok(await call('paula', 'DELETE', `/v1/platform/organizations/demo/members/${b.member.id}`)), { accountDeleted: true });
    assert.ok(!kc.users.has(selbst.id), 'mit der Einladung angelegtes Konto gelöscht');
    assert.equal((await auditOf('demo', 'member.invitation_withdrawn')).at(-1)!.data.accountDeleted, true);
  });

  test('V3: «constructor», «__proto__», «toString» sind keine Rollen → 422 ohne Aufruf bei Keycloak', async () => {
    const calls = kc.calls.length;
    for (const r of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const inv = await call('anna', 'POST', '/v1/admin/members', { email: 'proto@demo.example', roles: ['viewer', r] });
      assert.equal(inv.status, 422, `${r}: ${JSON.stringify(inv.body)}`);
      assert.equal(inv.body.detail, `Unbekannte Rolle: ${r}`);
      assert.equal((await call('anna', 'PUT', `/v1/admin/members/${u.dana.id}/roles`, { roles: ['viewer', r] })).status, 422);
      assert.equal((await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.dana.id}/roles`, { roles: [r] })).status, 422);
    }
    assert.equal(kc.calls.length, calls, 'kein Aufruf bei Keycloak');
    assert.deepEqual(kc.rolesOf(demo, u.dana), ['viewer']);
    assert.equal(kc.byEmail('proto@demo.example'), null);
    assert.equal(notesCatalog.permissionsForRoles(['constructor', '__proto__', 'toString']).size, 0);
  });

  test('V4: scheitert ein Schritt, nachdem Keycloak geändert wurde → eigener Eintrag «…_failed» mit den erfolgten Schritten', async () => {
    const r = ok(await call('anna', 'POST', '/v1/admin/members', { email: 'teil@demo.example', roles: ['viewer'] }), 202);
    const ku = kc.byEmail('teil@demo.example')!;
    kc.fail = [{ re: /^DELETE \/users\/[^/]+$/, status: 500 }];
    const w = await call('anna', 'DELETE', `/v1/admin/members/${r.member.id}`);
    kc.fail = [];
    assert.equal(w.status, 502);
    const f = (await auditOf('demo', 'member.invitation_withdraw_failed')).at(-1)!;
    assert.deepEqual([f.resource_id, f.actor_name, f.data.status], [r.member.id, 'Anna Admin', 502]);
    assert.deepEqual(f.data.steps, [{ step: 'role_removed', role: 'viewer' }, { step: 'membership_removed' }]);
    assert.ok(!JSON.stringify(f.data).includes(ku.id), 'keine Keycloak-ID');
    assert.ok(!(await auditOf('demo', 'member.invitation_withdrawn')).some(a => a.resource_id === r.member.id), 'kein Erfolgseintrag');
    ok(await call('anna', 'DELETE', `/v1/admin/members/${r.member.id}`));
    assert.ok(!kc.users.has(ku.id), 'erneut zurückziehen holt den Rest nach');
    kc.fail = [{ re: /^DELETE \/users\/.*\/groups\//, status: 500 }];
    const s2 = await call('anna', 'PUT', `/v1/admin/members/${u.dana.id}/roles`, { roles: ['editor'] });
    kc.fail = [];
    assert.equal(s2.status, 502);
    const g = (await auditOf('demo', 'member.roles_change_failed')).at(-1)!;
    assert.deepEqual([g.resource_id, g.data.steps], [u.dana.id, [{ step: 'role_added', role: 'editor' }]]);
    ok(await call('anna', 'PUT', `/v1/admin/members/${u.dana.id}/roles`, { roles: ['viewer'] }));
    // scheitert schon der erste Schritt: Keycloak unverändert, kein Eintrag
    const count = (await auditOf('demo', 'member.roles_change_failed')).length;
    kc.fail = [{ re: /^PUT \/users\/.*\/groups\//, status: 500 }];
    assert.equal((await call('anna', 'PUT', `/v1/admin/members/${u.dana.id}/roles`, { roles: ['viewer', 'editor'] })).status, 502);
    kc.fail = [];
    assert.equal((await auditOf('demo', 'member.roles_change_failed')).length, count, 'erster Schritt gescheitert: kein Eintrag');
    // Plattform-Administration: mit Kennzeichen
    kc.fail = [{ re: /^DELETE \/users\/.*\/groups\//, status: 500 }];
    assert.equal((await call('paula', 'PUT', `/v1/platform/organizations/demo/members/${u.dana.id}/roles`, { roles: ['editor'] })).status, 502);
    kc.fail = [];
    const p = (await auditOf('demo', 'member.roles_change_failed')).at(-1)!;
    assert.deepEqual([p.actor_name, p.data.platformAdmin, p.data.actorTenant, p.data.steps], ['Paula Plattform', true, 'ops', [{ step: 'role_added', role: 'editor' }]]);
    ok(await call('anna', 'PUT', `/v1/admin/members/${u.dana.id}/roles`, { roles: ['viewer'] }));
    assert.deepEqual(kc.rolesOf(demo, u.dana), ['viewer']);
  });

  test('V5: «Erneut senden» prüft das Passwort auch bei einem Mitglied mit offener Einladung', async () => {
    const r = ok(await call('anna', 'POST', '/v1/admin/members', { email: 'passwort@demo.example', roles: ['viewer'] }), 202);
    const ku = kc.byEmail('passwort@demo.example')!;
    assert.ok(kc.orgMembers.get(demo.id)!.has(ku.id), 'neues Konto: Mitglied mit offener Einladung');
    kc.smtp = true;
    try {
      assert.equal(ok(await call('anna', 'POST', `/v1/admin/members/${r.member.id}/invitation`)).emailSent, true, 'ohne Passwort: geht');
      const mails = kc.mails.length;
      ku.password = true;
      const again = await call('anna', 'POST', `/v1/admin/members/${r.member.id}/invitation`);
      assert.equal(again.status, 409);
      assert.match(again.body.detail, /Passwort bereits gesetzt/);
      assert.equal(kc.mails.length, mails, 'kein «Passwort setzen» an ein Konto mit Passwort');
    } finally { kc.smtp = false; }
    ok(await call('anna', 'DELETE', `/v1/admin/members/${r.member.id}`));
    assert.ok(kc.users.has(ku.id), 'Konto mit Passwort bleibt, auch wenn die Einladung es angelegt hat');
  });

  test('V6: Abgleich entfernt Rollengruppen von Personen ohne Mitgliedschaft und ohne offene Einladung (protokolliert)', async () => {
    ok(await call('anna', 'GET', '/v1/admin/members'));
    const olga = kc.user('olga', { email: 'olga@demo.example', firstName: 'Olga', lastName: 'Ost' });
    kc.member(demo, olga, ['editor', 'viewer']); kc.member(muster, olga, ['viewer']);
    kc.orgMembers.get(demo.id)!.delete(olga.id); // Mitgliedschaft endet ausserhalb der App, Gruppen bleiben
    const inv = ok(await call('anna', 'POST', '/v1/admin/members', { email: 'ben@muster.example', roles: ['viewer'] }), 202);
    const list = ok(await call('anna', 'GET', '/v1/admin/members')).items;
    assert.deepEqual(kc.rolesOf(demo, olga), [], 'Rollen in demo entfernt');
    assert.deepEqual(kc.rolesOf(muster, olga), ['viewer'], 'andere Organisation unberührt');
    assert.deepEqual(kc.rolesOf(demo, u.ben), ['viewer'], 'offen eingeladen: bleibt');
    assert.deepEqual(list.find((m: any) => m.id === inv.member.id).roles, ['viewer']);
    const a = (await auditOf('demo', 'member.roles_cleaned')).at(-1)!;
    assert.deepEqual([a.source, a.data], ['system', { persons: 1, roles: { editor: 1, viewer: 1 } }]);
    assert.ok(!JSON.stringify(a).includes(olga.id) && !/olga/i.test(JSON.stringify(a)), 'keine Angaben zur Person');
    const count = (await auditOf('demo', 'member.roles_cleaned')).length;
    ok(await call('anna', 'GET', '/v1/admin/members'));
    assert.equal((await auditOf('demo', 'member.roles_cleaned')).length, count, 'nichts mehr zu tun: kein Eintrag');
    ok(await call('anna', 'DELETE', `/v1/admin/members/${inv.member.id}`));
  });

  test('V8: Verwaltung bindet eine leere Organisations-ID; andere ID → 409 für org-admin und Plattform', async () => {
    const kcId = async (alias: string) => (await t.inspect.query('SELECT kc_org_id FROM notes.tenant WHERE alias = $1', [alias])).rows[0]?.kc_org_id ?? null;
    assert.equal(await kcId('demo'), demo.id);
    await t.inspect.query("UPDATE notes.tenant SET kc_org_id = NULL WHERE alias = 'demo'");
    ok(await call('anna', 'GET', '/v1/admin/members'));
    assert.equal(await kcId('demo'), demo.id, 'leere ID gebunden');
    const other = randomUUID();
    await t.inspect.query("UPDATE notes.tenant SET kc_org_id = $1 WHERE alias = 'muster'", [other]);
    for (const r of [await call('mona', 'GET', '/v1/admin/members'), await call('paula', 'GET', '/v1/platform/organizations/muster/members'), await call('mona', 'POST', '/v1/admin/members', { email: 'x@muster.example' })]) {
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(r.body.detail, /andere ID/);
      assert.doesNotMatch(r.body.detail, /Mandant/);
    }
    assert.equal(await kcId('muster'), other, 'abweichende ID bleibt');
    assert.equal(kc.byEmail('x@muster.example'), null);
    await t.inspect.query("UPDATE notes.tenant SET kc_org_id = NULL WHERE alias = 'muster'");
    ok(await call('mona', 'GET', '/v1/admin/members'));
    assert.equal(await kcId('muster'), muster.id);
  });

  test('A10: Austritt gilt ab dem Entfernen in Keycloak; ein Token aus der Zwischenzeit hebt ihn nicht auf', async () => {
    const pia = kc.user('pia', { email: 'pia@demo.example', firstName: 'Pia', lastName: 'Pause' });
    kc.member(demo, pia, ['viewer']);
    const mint = () => idp.token(claims.user({ sub: pia.id, org: 'demo', groupRoles: ['viewer'], email: pia.email, name: 'Pia Pause' }));
    const me = async (token: string) => n.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    assert.equal((await me(await mint())).statusCode, 200);
    let removedAt = 0, windowToken = '';
    kc.before = async c => {
      if (c !== `DELETE /organizations/${demo.id}/members/${pia.id}`) return;
      await sleep(1100);
      windowToken = await mint();
      removedAt = Date.now();
    };
    try { ok(await call('anna', 'DELETE', `/v1/admin/members/${pia.id}`)); } finally { kc.before = null; }
    assert.ok(windowToken && removedAt);
    const row = (await t.inspect.query<{ removed_at: Date }>("SELECT removed_at FROM notes.principal WHERE kind = 'user' AND subject = $1", [pia.id])).rows[0]!;
    assert.ok(row.removed_at.getTime() >= removedAt, `removed_at ${row.removed_at.toISOString()} nach dem Entfernen in Keycloak ${new Date(removedAt).toISOString()}`);
    const r = await me(windowToken);
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().title, 'Kein Mitglied mehr');
  });

  test('U1/U4: Meldungen nennen Rollen mit Label und sagen «Organisation» statt «Mandant»', async () => {
    const adm = await call('anna', 'POST', '/v1/admin/members', { email: 'chef2@demo.example', roles: ['org-admin'] });
    assert.equal(adm.status, 403);
    assert.equal(adm.body.detail, 'Die Rolle «Organisations-Admin» vergibt und entzieht nur die Plattform-Administration.');
    const last = await call('paula', 'DELETE', `/v1/platform/organizations/demo/members/${u.anna.id}`);
    assert.deepEqual([last.status, last.body.reason], [409, 'last-admin']);
    assert.match(last.body.detail, /Rolle «Organisations-Admin»\./);
    assert.doesNotMatch(last.body.detail, /org-admin/);
    await t.inspect.query("SELECT app.resolve_tenant('nur-plattform', null, 'Nur Plattform', true)");
    const dup = await call('paula', 'POST', '/v1/platform/organizations', { alias: 'nur-plattform', name: 'Nur Plattform' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.detail, 'Der Alias «nur-plattform» ist in der Plattform bereits vergeben.');
    const unknown = await call('paula', 'GET', '/v1/platform/organizations/unbekannt');
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.title, /^Organisation «unbekannt» /);
    for (const b of [adm.body, last.body, dup.body, unknown.body]) assert.doesNotMatch(JSON.stringify(b), /Mandant|Tenant/);
  });
});

describe('Abgleich der Organisationsmitglieder ins Personenverzeichnis (Worker)', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  const kc = new KeycloakFake();
  let demo: FakeOrg, muster: FakeOrg;
  const tok: Record<string, string> = {};
  const SYNC = { DPOP_MODE: 'optional', KEYCLOAK_SYNC_CLIENT_ID: 'notes-sync', KEYCLOAK_SYNC_CLIENT_SECRET: 'geheim', MEMBER_SYNC_INTERVAL: '5m' };
  const syncCfg = () => testConfig(idp.issuer, SYNC);
  const people = async (alias: string) => (await t.inspect.query<{ id: string; display_name: string; last_seen_at: Date | null }>(
    "SELECT p.id, p.display_name, p.last_seen_at FROM notes.principal p JOIN notes.tenant t ON t.id = p.tenant_id WHERE t.alias = $1 AND p.kind = 'user' AND p.removed_at IS NULL ORDER BY p.display_name", [alias])).rows;
  /** Discovery über den echten Mock-IdP, Admin-API und Token über den Ersatz. */
  const mixedFetch = (async (i: Parameters<typeof fetch>[0], init?: RequestInit) => (String(i).includes('/.well-known/') ? fetch(i, init) : kc.fetch(i, init))) as typeof fetch;
  const kca = () => new KeycloakAdmin(syncCfg(), async () => `${idp.issuer}/protocol/openid-connect/token`, kc.fetch, syncCfg().memberSync);

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    demo = kc.org('demo', 'Demo AG');
    muster = kc.org('muster', 'Muster GmbH');
    kc.org('ohne-mandant', 'Noch nie benutzt');
    const anna = kc.user('anna', { email: 'anna@demo.example', firstName: 'Anna', lastName: 'Admin' });
    const ben = kc.user('ben', { email: 'ben@muster.example', firstName: 'Ben', lastName: 'Leser' });
    kc.member(demo, anna, ['org-admin']); kc.member(muster, ben, ['viewer']);
    kc.member(demo, kc.user('erna', { email: 'erna@demo.example', firstName: 'Erna', lastName: 'Neu' }), ['viewer']);
    kc.member(demo, kc.user('fritz', { email: 'fritz@demo.example', firstName: 'Fritz', lastName: 'Neu' }), ['viewer']);
    kc.member(muster, kc.user('mia', { email: 'mia@muster.example', firstName: 'Mia', lastName: 'Muster' }));
    n = await notesApp({ db: t.runtime, issuer: idp.issuer, env: SYNC });
    tok.anna = await idp.token(claims.user({ sub: anna.id, org: 'demo', groupRoles: ['org-admin'], email: anna.email, name: 'Anna Admin' }));
    tok.ben = await idp.token(claims.user({ sub: ben.id, org: 'muster', groupRoles: ['viewer'], email: ben.email, name: 'Ben Leser' }));
    await tenant(t.runtime, 'demo', 'inventar');
    tok.svc = await idp.token(claims.client({ clientId: 'inventar', org: 'demo', roles: ['viewer'], scopes: ['notes:read'] }));
    for (const who of ['anna', 'ben', 'svc']) assert.equal((await n.app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${tok[who]}` } })).statusCode, 200);
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('abgeschaltet ohne KEYCLOAK_SYNC_CLIENT_ID', async () => {
    const s = new MemberSync(testConfig(idp.issuer), t.runtime, { schema: 'notes' });
    assert.equal(s.kc, null);
    assert.deepEqual(await s.runOnce(), []);
    s.start(); await s.stop();
    assert.equal((await t.inspect.query("SELECT name FROM notes.tenant WHERE alias = 'demo'")).rows[0].name, 'demo', 'ohne Client kein Abgleich des Namens');
    // Pflichtangaben und MEMBER_SYNC_INTERVAL ≥ 1m prüft loadIamConfig für den Worker (test/config.test.ts)
  });

  test('Worker: nie angemeldete Mitglieder werden auswählbar; je Mandant getrennt; Organisation ohne Mandant übersprungen', async () => {
    const s = new MemberSync(syncCfg(), t.runtime, { schema: 'notes', fetch: mixedFetch });
    const res = (await s.runOnce())!;
    const by = Object.fromEntries(res.map(r => [r.alias, r]));
    assert.deepEqual([by.demo!.members, by.demo!.added, by.demo!.removed], [3, 2, 0]);
    assert.deepEqual([by.muster!.members, by.muster!.added], [2, 1]);
    assert.equal(by['ohne-mandant']!.skipped, 'kein Mandant');
    assert.deepEqual([by.demo!.renamed, by.muster!.renamed], [true, true]);
    assert.deepEqual((await t.inspect.query("SELECT alias, name FROM notes.tenant WHERE alias IN ('demo', 'muster') ORDER BY alias")).rows.map(r => r.name), ['Demo AG', 'Muster GmbH']);
    const synced = (await t.inspect.query<{ alias: string; data: any }>("SELECT t.alias, a.data FROM notes.audit_log a JOIN notes.tenant t ON t.id = a.tenant_id WHERE a.action = 'organization.name_synced' ORDER BY t.alias")).rows;
    assert.deepEqual(synced, [{ alias: 'demo', data: { from: 'demo', to: 'Demo AG' } }, { alias: 'muster', data: { from: 'muster', to: 'Muster GmbH' } }]);
    assert.equal((await t.inspect.query("SELECT 1 FROM notes.tenant WHERE alias = 'ohne-mandant'")).rowCount, 0, 'kein Mandant angelegt');
    assert.equal(kc.tokenRequests.at(-1)!.get('grant_type'), 'client_credentials');
    const demoPeople = await people('demo');
    assert.deepEqual(demoPeople.map(p => p.display_name), ['Anna Admin', 'Erna Neu', 'Fritz Neu']);
    assert.equal(demoPeople.find(p => p.display_name === 'Erna Neu')!.last_seen_at, null, 'noch nie angemeldet');
    assert.deepEqual((await people('muster')).map(p => p.display_name), ['Ben Leser', 'Mia Muster'], 'muster nur eigene Mitglieder');
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.principal p JOIN notes.tenant t ON t.id = p.tenant_id WHERE t.alias = 'demo' AND p.kind = 'client' AND p.removed_at IS NULL")).rows[0].n, 1, 'Clients unberührt');
    const a = (await t.inspect.query<{ data: any }>("SELECT a.data FROM notes.audit_log a JOIN notes.tenant t ON t.id = a.tenant_id WHERE t.alias = 'demo' AND a.action = 'people.synced'")).rows;
    assert.deepEqual([a.length, a[0]!.data.added], [1, 2]);
    const again = (await s.runOnce())!;
    assert.deepEqual(again.filter(r => !r.skipped).map(r => r.added + r.removed), [0, 0]);
    assert.ok(again.every(r => !r.renamed), 'Name unverändert: kein weiterer Eintrag');
    assert.equal((await t.inspect.query("SELECT 1 FROM notes.audit_log WHERE action = 'organization.name_synced'")).rowCount, 2);
    assert.equal((await t.inspect.query("SELECT 1 FROM notes.audit_log WHERE action = 'people.synced'")).rowCount, 2);
    // läuft schon ein Abgleich (andere Instanz hält die Sperre), überspringt diese Instanz
    const holder = await t.runtime.connect();
    await holder.query('SELECT pg_advisory_lock(727016)');
    try { assert.equal(await s.runOnce(), null); }
    finally { await holder.query('SELECT pg_advisory_unlock(727016)'); holder.release(); }
  });

  test('entfernte Mitglieder: inaktiv statt gelöscht, Verweise bleiben; Rückkehr hebt es auf (gleiche ID)', async () => {
    const erna = (await people('demo')).find(p => p.display_name === 'Erna Neu')!;
    const kErna = kc.byEmail('erna@demo.example')!;
    kc.orgMembers.get(demo.id)!.delete(kErna.id);
    const res = await syncAllMembers(ctx, t.runtime, kca());
    assert.equal(res.find(r => r.alias === 'demo')!.removed, 1);
    assert.ok(!(await people('demo')).some(p => p.id === erna.id), 'nicht mehr auswählbar');
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.principal WHERE id = $1 AND removed_at IS NOT NULL', [erna.id])).rows[0].n, 1, 'nicht gelöscht, nur markiert');
    assert.equal((await people('muster')).length, 2, 'muster unberührt');
    kc.orgMembers.get(demo.id)!.add(kErna.id);
    await syncAllMembers(ctx, t.runtime, kca());
    assert.ok((await people('demo')).some(p => p.id === erna.id), 'wieder auswählbar, gleiche ID');
  });

  test('gesperrter Mandant wird übersprungen; Fehler einer Organisation hält die anderen nicht auf', async () => {
    await setTenantStatus(ctx, t.admin, t.runtime, 'muster', 'suspended');
    kc.deny = [new RegExp(`^GET /organizations/${demo.id}/members`)];
    const logs: string[] = [];
    const res = await syncAllMembers(ctx, t.runtime, kca(), m => logs.push(m));
    kc.deny = [];
    await setTenantStatus(ctx, t.admin, t.runtime, 'muster', 'active');
    assert.equal(res.find(r => r.alias === 'muster')!.skipped, 'gesperrt');
    assert.equal(res.find(r => r.alias === 'demo')!.skipped, 'Fehler');
    assert.ok(logs.some(l => l.includes('fehlgeschlagen')));
    assert.equal((await people('demo')).length, 3, 'bei Fehler nichts als entfernt markiert');
  });

  test('V8: Abgleich bindet eine leere Organisations-ID; andere ID oder ID eines anderen Mandanten → übersprungen', async () => {
    const kcId = async (alias: string) => (await t.inspect.query('SELECT kc_org_id FROM notes.tenant WHERE alias = $1', [alias])).rows[0]?.kc_org_id ?? null;
    const skipped = async () => Object.fromEntries((await syncAllMembers(ctx, t.runtime, kca())).map(r => [r.alias, r.skipped ?? null]));
    assert.deepEqual([await kcId('demo'), await kcId('muster')], [demo.id, muster.id]);
    await t.inspect.query("UPDATE notes.tenant SET kc_org_id = NULL WHERE alias IN ('demo', 'muster')");
    assert.deepEqual(await skipped(), { demo: null, muster: null, 'ohne-mandant': 'kein Mandant' });
    assert.deepEqual([await kcId('demo'), await kcId('muster')], [demo.id, muster.id], 'leere ID gebunden');
    const other = randomUUID();
    await t.inspect.query("UPDATE notes.tenant SET kc_org_id = $1 WHERE alias = 'demo'", [other]);
    await t.inspect.query("UPDATE notes.tenant SET kc_org_id = NULL WHERE alias = 'muster'");
    await t.inspect.query("SELECT app.resolve_tenant('zweit', $1, 'Zweit', true)", [muster.id]);
    const before = (await people('demo')).length;
    kc.member(demo, kc.user('neu-in-demo', { email: 'neu-in-demo@demo.example' }));
    assert.deepEqual(await skipped(), { demo: 'andere Organisation', muster: 'andere Organisation', 'ohne-mandant': 'kein Mandant' });
    assert.deepEqual([await kcId('demo'), await kcId('muster')], [other, null]);
    assert.equal((await people('demo')).length, before, 'keine Personen übernommen');
    await t.inspect.query("UPDATE notes.tenant SET kc_org_id = NULL WHERE alias = 'zweit'");
    await t.inspect.query("UPDATE notes.tenant SET kc_org_id = $1 WHERE alias = 'demo'", [demo.id]);
    assert.deepEqual(await skipped(), { demo: null, muster: null, 'ohne-mandant': 'kein Mandant' });
    assert.equal(await kcId('muster'), muster.id);
  });

  test('Alias mit Kelvin-Zeichen in Keycloak trifft den Mandanten «k…» nicht (nur ASCII klein)', async () => {
    const kelvin = kc.org('Kelvin', 'Kelvin');
    await t.inspect.query("SELECT app.resolve_tenant('kelvin', null, 'kelvin', true)");
    kc.member(kelvin, kc.user('kurt', { email: 'kurt@kelvin.example' }));
    try {
      const res = await syncAllMembers(ctx, t.runtime, kca());
      assert.equal(res.find(r => r.alias === 'Kelvin')!.skipped, 'kein Mandant');
      assert.equal((await people('kelvin')).length, 0);
    } finally { kc.orgs.delete(kelvin.id); }
  });

  test('V7: mehr als 10 000 Einträge in Keycloak → Abgleich bricht ab, nichts als entfernt markiert', async () => {
    const big = kc.org('gross', 'Gross AG');
    await t.inspect.query("SELECT app.resolve_tenant('gross', $1, 'Gross AG', true)", [big.id]);
    const gina = kc.user('gina', { email: 'gina@gross.example', firstName: 'Gina', lastName: 'Gross' });
    kc.member(big, gina);
    const count = async () => (await t.inspect.query<{ n: number; active: number }>(
      "SELECT count(*)::int AS n, (count(*) FILTER (WHERE p.removed_at IS NULL))::int AS active FROM notes.principal p JOIN notes.tenant t ON t.id = p.tenant_id WHERE t.alias = 'gross'")).rows[0]!;
    assert.equal((await syncAllMembers(ctx, t.runtime, kca())).find(r => r.alias === 'gross')!.added, 1);
    const members = kc.orgMembers.get(big.id)!;
    const filler = Array.from({ length: 10_000 }, (_, i) => kc.user(`f${i}`, { email: `f${i}@gross.example` }));
    for (const f of filler) members.add(f.id);
    members.delete(gina.id); members.add(gina.id);
    try {
      const logs: { m: string; d?: Record<string, unknown> }[] = [];
      const res = await syncAllMembers(ctx, t.runtime, kca(), (m, d) => logs.push({ m, d }));
      assert.equal(res.find(r => r.alias === 'gross')!.skipped, 'Fehler');
      assert.equal(res.find(r => r.alias === 'demo')!.skipped, undefined, 'andere Organisationen laufen weiter');
      assert.match(String(logs.find(l => l.d?.alias === 'gross')?.d?.error), /mindestens 10.000 Einträge/);
      assert.deepEqual(await count(), { n: 1, active: 1 }, 'gina nicht entfernt, nichts übernommen');
    } finally {
      kc.orgs.delete(big.id);
      for (const f of filler) { kc.users.delete(f.id); kc.userGroups.delete(f.id); }
    }
  });
});
