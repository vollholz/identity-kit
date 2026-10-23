/**
 * Personen in mehreren Organisationen über HTTP (aus Assets test/platform/multi-org.test.ts, «Personen in mehreren
 * Organisationen», produktneutral mit der Beispiel-App «notes»). Ergänzt principal.test.ts (Resolver), http.test.ts
 * (Wahl der Organisation) und acl.test.ts (Gruppen und Subjects je Mandant) um Rechte über eine Fachroute, Client-Rollen
 * mit ROLE_SOURCE=both und den Austritt über die Verwaltung (Modul `admin`), der nur die eine Organisation betrifft.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { KeycloakFake, startMockIdp, type FakeOrg, type FakeUser, type MockIdp } from '@vollholz/iam-testkit';
import { skipDb } from './support/db.ts';
import { claims, notesApp, notesDb, type NotesApp } from './support/http.ts';

const skip = await skipDb();
type Res = { status: number; body: any };
const ENV = { ROLE_SOURCE: 'groups', KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'x', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' };

describe('Personen in mehreren Organisationen (HTTP, mit Verwaltung)', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  const kc = new KeycloakFake();
  let acme: FakeOrg, globex: FakeOrg, dora: FakeUser, ada: FakeUser;
  /** Dora: editor in acme, viewer in globex; Client-Rolle org-admin (wirkt mit ROLE_SOURCE=groups nicht). */
  const doraToken = () => idp.token({
    ...claims.user({ sub: dora.id, org: ['acme', 'globex'], name: 'Dora Doppel', email: 'dora@example.ch', roles: ['org-admin'] }),
    groups: ['/orgs/acme/editor', '/orgs/globex/viewer', '/it-alle'],
  });
  async function call(token: string, method: string, url: string, o: { tenant?: string; body?: unknown; app?: NotesApp } = {}): Promise<Res> {
    const r = await (o.app ?? n).app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}`, ...(o.tenant ? { 'x-tenant': o.tenant } : {}) }, ...(o.body !== undefined ? { payload: o.body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    acme = kc.org('acme', 'Acme'); globex = kc.org('globex', 'Globex');
    dora = kc.user('dora', { email: 'dora@example.ch', firstName: 'Dora', lastName: 'Doppel' });
    ada = kc.user('ada', { email: 'ada@acme.example', firstName: 'Ada', lastName: 'Acme' });
    kc.member(acme, dora, ['editor']); kc.member(globex, dora, ['viewer']); kc.member(acme, ada, ['org-admin']);
    n = await notesApp({ db: t.runtime, issuer: idp.issuer, env: ENV, keycloakFetch: kc.fetch });
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('je Mandant eigener Principal, eigene Rollen und Rechte; Rechte aus acme helfen in globex nicht', async () => {
    const tok = await doraToken();
    const none = await call(tok, 'GET', '/v1/me');
    assert.deepEqual([none.status, none.body.organizations], [400, ['acme', 'globex']], 'ohne Wahl 400 mit eigener Liste');
    const a = ok(await call(tok, 'GET', '/v1/me', { tenant: 'acme' })), g = ok(await call(tok, 'GET', '/v1/me', { tenant: 'globex' }));
    assert.deepEqual([a.tenant.alias, a.roles, g.tenant.alias, g.roles], ['acme', ['editor'], 'globex', ['viewer']], 'Client-Rolle org-admin wirkt nicht');
    assert.notEqual(a.principal.id, g.principal.id, 'eigene Zeile je Mandant');
    assert.ok(a.permissions.includes('note:write') && !g.permissions.includes('note:write'));
    ok(await call(tok, 'POST', '/v1/folders', { tenant: 'acme', body: { name: 'Von Dora' } }), 201);
    assert.equal((await call(tok, 'POST', '/v1/folders', { tenant: 'globex', body: { name: 'Von Dora' } })).status, 403);
    assert.equal(Number((await t.inspect.query("SELECT count(*) FROM notes.folder f JOIN notes.tenant t ON t.id = f.tenant_id WHERE t.alias = 'globex'")).rows[0].count), 0);
  });

  test('ROLE_SOURCE=both: Client-Rollen gelten nur mit einer Organisation im Token – mit mehreren nur Gruppen', async () => {
    const both = await notesApp({ db: t.runtime, issuer: idp.issuer, env: { ...ENV, ROLE_SOURCE: 'both' }, keycloakFetch: kc.fetch });
    try {
      assert.ok(!ok(await call(await doraToken(), 'GET', '/v1/me', { tenant: 'globex', app: both })).roles.includes('org-admin'), 'mehrere Organisationen: nur Gruppen');
      const single = await idp.token({ ...claims.user({ sub: dora.id, org: 'globex', roles: ['org-admin'] }), groups: ['/orgs/globex/viewer'] });
      assert.ok(ok(await call(single, 'GET', '/v1/me', { app: both })).roles.includes('org-admin'), 'eine Organisation: Client-Rolle gilt');
    } finally { await both.app.close(); }
  });

  test('Austritt über die Verwaltung: Tokens von vorher gelten in acme nicht mehr, in globex weiter; Rollen in globex unberührt', async () => {
    const before = await doraToken();
    ok(await call(before, 'GET', '/v1/me', { tenant: 'acme' }));
    const admin = await idp.token(claims.user({ sub: ada.id, org: 'acme', groupRoles: ['org-admin'], name: 'Ada Acme' }));
    assert.deepEqual(ok(await call(admin, 'DELETE', `/v1/admin/members/${dora.id}`)), { accountDeleted: false });
    const r = await call(before, 'GET', '/v1/me', { tenant: 'acme' });
    assert.deepEqual([r.status, r.body.title], [403, 'Kein Mitglied mehr'], 'sofort in dieser Instanz');
    ok(await call(before, 'GET', '/v1/me', { tenant: 'globex' }));
    assert.deepEqual([kc.rolesOf(acme, dora), kc.rolesOf(globex, dora)], [[], ['viewer']]);
    assert.ok(kc.orgMembers.get(globex.id)!.has(dora.id) && kc.users.has(dora.id), 'Konto und Mitgliedschaft in globex bleiben');
    const removed = (await t.inspect.query<{ alias: string; removed: boolean }>(
      "SELECT t.alias, p.removed_at IS NOT NULL AS removed FROM notes.principal p JOIN notes.tenant t ON t.id = p.tenant_id WHERE p.subject = $1 ORDER BY t.alias", [dora.id])).rows;
    assert.deepEqual(removed, [{ alias: 'acme', removed: true }, { alias: 'globex', removed: false }]);
  });
});
