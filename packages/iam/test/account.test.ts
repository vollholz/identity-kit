/**
 * Konto ohne Organisation (Spezifikation Kap. 6.3), Prüfpunkte K1–K10: Kontexte `account`, `tenant` und `platform`,
 * Plattform-Administration ohne Mitgliedschaft, Registrieren mit E-Mail und eigene Organisation erstellen. Beispiel-App
 * «notes» über app.inject gegen Wegwerf-Datenbank, Mock-IdP und den `KeycloakFake` des Test-Kits.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { KeycloakFake, startMockIdp, type FakeUser, type MockIdp } from '@vollholz/iam-testkit';
import { skipDb } from './support/db.ts';
import { claims, grantClient, member, notesApp, notesDb, tenant, type NotesApp } from './support/http.ts';

const skip = await skipDb();
type Res = { status: number; body: any };
const ENV = {
  DPOP_MODE: 'optional', KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0',
  SELF_SERVICE_SIGNUP: 'true', SELF_SERVICE_ORGS: 'true', SELF_SERVICE_ORG_LIMIT: '2', TENANT_AUTO_PROVISION: 'false',
};

describe('Konto ohne Organisation', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp, off: NotesApp;
  const kc = new KeycloakFake();
  const tok: Record<string, string> = {};
  const u = {} as Record<'anna' | 'olga' | 'paula' | 'pia' | 'neu' | 'unbestaetigt', FakeUser>;

  async function call(who: string | null, method: string, url: string, body?: unknown, o: { app?: NotesApp; headers?: Record<string, string> } = {}): Promise<Res> {
    const r = await (o.app ?? n).app.inject({ method: method as 'GET', url, headers: { ...(who ? { authorization: `Bearer ${tok[who]}` } : {}), ...o.headers }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const person = (x: FakeUser, org: string[], extra: Record<string, unknown> = {}) =>
    idp.token({ ...claims.user({ sub: x.id, org, email: x.email, name: `${x.firstName} ${x.lastName}` }), email_verified: true, ...extra });
  const platformLog = async (action: string) => (await t.inspect.query<{ actor_id: string | null; org_id: string | null; data: any }>(
    'SELECT actor_id::text, org_id::text, data FROM notes.platform_audit_log WHERE action = $1 ORDER BY seq', [action])).rows;

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    kc.smtp = true;
    const demo = kc.org('demo', 'Demo AG');
    u.anna = kc.user('anna', { email: 'anna@demo.example', firstName: 'Anna', lastName: 'Admin' });
    u.olga = kc.user('olga', { email: 'olga@frei.example', firstName: 'Olga', lastName: 'Ohne' });
    u.paula = kc.user('paula', { email: 'paula@betrieb.example', firstName: 'Paula', lastName: 'Plattform' });
    u.pia = kc.user('pia', { email: 'pia@demo.example', firstName: 'Pia', lastName: 'Plattform-Mitglied' });
    u.neu = kc.user('neu', { email: 'neu@start.example', firstName: 'Nina', lastName: 'Neu' });
    u.unbestaetigt = kc.user('unbestaetigt', { email: 'u@start.example', firstName: 'Ulla', lastName: 'Unbestätigt', emailVerified: false });
    await tenant(t.runtime, 'demo');
    kc.member(demo, u.anna); kc.member(demo, u.pia);
    await member(t.runtime, 'demo', u.anna.id, 'org-admin');
    await member(t.runtime, 'demo', u.pia.id, 'viewer');
    await tenant(t.runtime, 'andere');

    n = await notesApp({ db: t.runtime, issuer: idp.issuer, env: ENV, keycloakFetch: kc.fetch });
    off = await notesApp({ db: t.runtime, issuer: idp.issuer, env: { ...ENV, SELF_SERVICE_SIGNUP: 'false', SELF_SERVICE_ORGS: 'false' }, keycloakFetch: kc.fetch });

    tok.anna = await person(u.anna, ['demo']);
    tok.olga = await person(u.olga, []);
    tok.paula = await person(u.paula, [], { realm_access: { roles: ['platform-admin'] } });
    tok.pia = await person(u.pia, ['demo'], { realm_access: { roles: ['platform-admin'] } });
    tok.neu = await person(u.neu, []);
    tok.unbestaetigt = await person(u.unbestaetigt, [], { email_verified: false });
    await grantClient(t.runtime, await tenant(t.runtime, 'demo'), 'demo-m2m', 'viewer');
    tok.svc = await idp.token(claims.client({ clientId: 'demo-m2m', org: 'demo', scopes: ['notes:read'] }));
    tok.mcp = await idp.token({ ...claims.user({ sub: u.anna.id, org: 'demo' }), azp: 'notes-mcp', scope: 'notes:read' });
  });
  after(async () => { await n?.app.close(); await off?.app.close(); await idp?.close(); await t?.drop(); });

  test('K1: ohne Organisation im Token antworten Routen des Mandanten mit 403 «no-organization»', async () => {
    for (const url of ['/v1/me', '/v1/access?type=org', '/v1/admin/status', '/v1/admin/members', '/v1/folders']) {
      const r = await call('olga', 'GET', url);
      assert.deepEqual([r.status, r.body.reason], [403, 'no-organization'], url);
    }
    // Der Katalog beschreibt die App, nicht einen Mandanten: auch ohne Organisation lesbar
    assert.ok(ok(await call('olga', 'GET', '/v1/authz/catalog')).roles.length);
    // Kein Mandant entsteht nebenbei (TENANT_AUTO_PROVISION aus)
    const neu = await person(u.olga, ['unbekannt']);
    tok.olgaUnbekannt = neu;
    assert.equal((await call('olgaUnbekannt', 'GET', '/v1/me')).status, 403);
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.tenant WHERE alias = 'unbekannt'")).rows[0].n, 0);
  });

  test('K4: GET /v1/account – eigenes Konto und Organisationen aus dem eigenen Token, ohne Mandant', async () => {
    const a = ok(await call('olga', 'GET', '/v1/account'));
    assert.deepEqual([a.account.subject, a.account.name, a.account.email, a.account.emailVerified, a.platformAdmin, a.organizations], [u.olga.id, 'Olga Ohne', 'olga@frei.example', true, false, []]);
    assert.deepEqual(a.selfService, { signup: true, createOrganization: true, organizationLimit: 2 });
    const b = ok(await call('anna', 'GET', '/v1/account'));
    assert.deepEqual(b.organizations, [{ alias: 'demo', name: 'demo', status: 'active' }]);
    assert.notEqual(a.account.id, b.account.id);
    // Die Laufzeit liest Konten und das Protokoll der Plattform nie direkt
    for (const table of ['account', 'platform_audit_log']) {
      await assert.rejects(t.runtime.query(`SELECT * FROM notes.${table}`), /permission denied/, table);
    }
    // Konto bleibt dasselbe über Anfragen und Mitgliedschaften
    assert.equal(ok(await call('olga', 'GET', '/v1/account')).account.id, a.account.id);
  });

  test('K10: Maschinen-Clients und der MCP-Dienst erreichen weder Konto noch Plattform', async () => {
    for (const who of ['svc', 'mcp']) {
      for (const url of ['/v1/account', '/v1/platform/organizations']) {
        const r = await call(who, 'GET', url);
        assert.deepEqual([r.status, r.body.title], [403, 'Nur für Personen'], `${who} ${url}`);
      }
    }
  });

  test('K2: Plattform-Administration ohne Mitgliedschaft verwaltet Organisationen, erreicht aber keine Route eines Mandanten', async () => {
    const list = ok(await call('paula', 'GET', '/v1/platform/organizations'));
    assert.ok(list.items.some((o: { alias: string }) => o.alias === 'demo'));
    ok(await call('paula', 'POST', '/v1/platform/organizations', { alias: 'kunde', name: 'Kunde AG' }), 201);
    const inv = ok(await call('paula', 'POST', '/v1/platform/organizations/kunde/members', { email: 'chefin@kunde.example', roles: ['org-admin'] }), 202);
    assert.deepEqual(inv.member.roles, ['org-admin']);
    assert.equal(ok(await call('paula', 'GET', '/v1/account')).platformAdmin, true);
    for (const url of ['/v1/me', '/v1/access?type=org', '/v1/admin/members']) assert.equal((await call('paula', 'GET', url)).status, 403, url);
    // Ohne die Realm-Rolle: Konto ja, Plattform nein
    const r = await call('olga', 'GET', '/v1/platform/organizations');
    assert.deepEqual([r.status, r.body.reason], [403, 'platform-admin-only']);
    // Protokoll: im Mandanten mit Kennzeichen, in der Plattform mit dem Konto und der Organisation (K9)
    const k = await tenant(t.runtime, 'kunde');
    const acct = ok(await call('paula', 'GET', '/v1/account')).account.id;
    const log = (await platformLog('member.invited')).at(-1)!;
    assert.deepEqual([log.actor_id, log.org_id], [acct, k]);
    assert.ok((await platformLog('tenant.provisioned')).some(x => x.org_id === k));
  });

  test('K3: Realm-Rolle gibt im Mandanten keine Rechte; Mandant B bleibt verschlossen', async () => {
    const me = ok(await call('pia', 'GET', '/v1/me'));
    assert.deepEqual(me.roles, ['viewer']);
    assert.ok(!me.permissions.includes('members:admin'));
    assert.equal((await call('pia', 'GET', '/v1/admin/members')).status, 403);
    const g = await call('pia', 'POST', '/v1/access', { subject: 'org:members', relation: 'org-admin', type: 'org' });
    assert.deepEqual([g.status, g.body.reason], [403, 'platform-admin-only']);
    assert.equal((await call('pia', 'GET', '/v1/me', undefined, { headers: { 'x-tenant': 'andere' } })).status, 403);
    // Mit Organisationen im Token arbeitet sie in der Plattform trotzdem ohne Mandant
    assert.equal((await call('pia', 'GET', '/v1/platform/organizations', undefined, { headers: { 'x-tenant': 'andere' } })).status, 200);
  });

  test('K6: eigene Organisation erstellen – org-admin nur dort, nichts sonst; Regeln und Grenzen', async () => {
    const r = ok(await call('neu', 'POST', '/v1/account/organizations', { alias: 'start-up', name: 'Start-up GmbH' }), 201);
    assert.deepEqual(r, { alias: 'start-up', name: 'Start-up GmbH' });
    const org = [...kc.orgs.values()].find(o => o.alias === 'start-up')!;
    assert.deepEqual([org.name, org.domains], ['Start-up GmbH', []], 'ohne Domäne');
    assert.ok(kc.orgMembers.get(org.id)!.has(u.neu.id));
    // nach dem Erneuern des Tokens: org-admin mit Freigabestufe 2, keine Plattform
    tok.neuOrg = await person(u.neu, ['start-up']);
    const me = ok(await call('neuOrg', 'GET', '/v1/me'));
    assert.deepEqual([me.tenant.alias, me.roles, me.clearance], ['start-up', ['org-admin'], 2]);
    assert.equal((await call('neuOrg', 'GET', '/v1/platform/organizations')).status, 403);
    assert.equal((await call('neuOrg', 'GET', '/v1/me', undefined, { headers: { 'x-tenant': 'demo' } })).status, 403);
    const sid = await tenant(t.runtime, 'start-up');
    const prov = (await t.inspect.query("SELECT data FROM notes.audit_log WHERE tenant_id = $1 AND action = 'tenant.provisioned'", [sid])).rows[0].data;
    assert.equal(prov.selfService, true);
    assert.ok((await platformLog('organization.self_created')).some(x => x.org_id === sid && x.data.alias === 'start-up'));

    const fail = async (body: object, status: number, reason?: string, who = 'neu') => {
      const x = await call(who, 'POST', '/v1/account/organizations', body);
      assert.equal(x.status, status, JSON.stringify(x.body));
      if (reason) assert.equal(x.body.reason, reason);
      return x.body;
    };
    await fail({ alias: 'start-up', name: 'Nochmal' }, 409, 'alias-taken');
    await fail({ alias: 'demo', name: 'Fremd' }, 409, 'alias-taken');
    for (const alias of ['platform', 'notes', 'ops']) assert.equal((await fail({ alias, name: 'x' }, 422)).title, 'Ungültige Eingabe', alias);
    await fail({ alias: 'Ungültig!', name: 'x' }, 422);
    await fail({ alias: 'zweite', name: 'x' }, 403, 'email-unverified', 'unbestaetigt');
    ok(await call('neu', 'POST', '/v1/account/organizations', { alias: 'zweite', name: 'Zweite' }), 201);
    await fail({ alias: 'dritte', name: 'Dritte' }, 409, 'org-limit');
    assert.ok(![...kc.orgs.values()].some(o => o.alias === 'dritte'), 'nichts angelegt');
    // abgeschaltet
    const offRes = await call('olga', 'POST', '/v1/account/organizations', { alias: 'olgas', name: 'Olgas' }, { app: off });
    assert.deepEqual([offRes.status, offRes.body.reason], [403, 'self-service-off']);
  });

  test('K6: scheitert ein Schritt nach Keycloak, bleibt nichts zurück (Organisation gelöscht, Reservierung frei)', async () => {
    const orgsBefore = kc.orgs.size;
    const created = () => t.inspect.query<{ n: number }>('SELECT orgs_created AS n FROM notes.account WHERE subject = $1', [u.olga.id]).then(r => r.rows[0]?.n ?? 0);
    ok(await call('olga', 'GET', '/v1/account'));
    kc.fail.push({ re: /^POST \/organizations\/[^/]+\/members$/, status: 500 });
    try {
      const r = await call('olga', 'POST', '/v1/account/organizations', { alias: 'halb', name: 'Halb' });
      assert.equal(r.status, 502, 'Fehler von Keycloak');
    } finally { kc.fail.length = 0; }
    assert.equal(kc.orgs.size, orgsBefore, 'Organisation in Keycloak wieder gelöscht');
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.tenant WHERE alias = 'halb'")).rows[0].n, 0, 'kein Mandant');
    assert.equal(await created(), 0, 'Reservierung freigegeben');
    // danach geht es
    ok(await call('olga', 'POST', '/v1/account/organizations', { alias: 'halb', name: 'Halb' }), 201);
    assert.equal(await created(), 1);
  });

  test('K7: Registrieren – gleiche Antwort für neue und bestehende Adressen; Konto ohne Passwort mit E-Mail', async () => {
    const mails = kc.mails.length;
    const fresh = await call(null, 'POST', '/v1/signup', { email: 'Frisch@Neu.Example', firstName: 'Fritz' });
    const known = await call(null, 'POST', '/v1/signup', { email: 'anna@demo.example' });
    assert.deepEqual([fresh.status, fresh.body], [202, { result: 'signup-received' }]);
    assert.deepEqual([known.status, known.body], [fresh.status, fresh.body]);
    const created = kc.byEmail('frisch@neu.example')!;
    assert.deepEqual([created.password, created.emailVerified, created.requiredActions.sort()], [false, false, ['UPDATE_PASSWORD', 'VERIFY_EMAIL']]);
    assert.equal(kc.mails.length, mails + 1, 'nur das neue Konto erhält eine E-Mail');
    assert.deepEqual((await platformLog('account.signup')).map(x => x.data.domain), ['neu.example']);
    assert.deepEqual((await platformLog('account.signup_ignored')).map(x => x.data.reason), ['exists']);
    assert.equal((await call(null, 'POST', '/v1/signup', { email: 'kein-mail' })).status, 422);
    const offRes = await call(null, 'POST', '/v1/signup', { email: 'x@y.example' }, { app: off });
    assert.deepEqual([offRes.status, offRes.body.reason], [403, 'self-service-off']);
  });
});
