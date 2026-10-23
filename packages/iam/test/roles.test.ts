/**
 * Modul `roles`: Rollen als Ressource (aus Assets test/platform/roles.test.ts, produktneutral mit der Beispiel-App
 * «notes»): vordefinierte lesen, eigene anlegen, ändern, vergeben und löschen, gegen Wegwerf-Datenbank, Mock-IdP und den
 * `KeycloakFake` des Test-Kits. Schwerpunkte: Rechte eigener Rollen wirken sofort (auch nach Änderung), nie Rechte nur
 * für org-admin, Löschen entzieht die Rolle überall (Gruppe, ACL), vordefinierte bleiben unverändert, Audit.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { KeycloakFake, startMockIdp, type FakeOrg, type FakeUser, type MockIdp } from '@vollholz/iam-testkit';
import { roleKey } from '../src/http/roles.ts';
import { skipDb } from './support/db.ts';
import { claims, notesApp, notesDb, tenant, type NotesApp } from './support/http.ts';

const skip = await skipDb();
type Res = { status: number; body: any; headers: Record<string, unknown> };

test('technischer Name aus dem Namen', () => {
  assert.equal(roleKey('Datenpflege Büro'), 'c-datenpflege-buero');
  assert.equal(roleKey('  Prüfer:in (extern) '), 'c-pruefer-in-extern');
  assert.equal(roleKey('***'), 'c-rolle');
  assert.match(roleKey('x'.repeat(80)), /^c-x{32}$/);
});

describe('Rollen: vordefinierte und eigene', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp, off: NotesApp;
  const kc = new KeycloakFake();
  const tok: Record<string, string> = {};
  const u = {} as Record<'anna' | 'carla' | 'dana', FakeUser>;
  let demo: FakeOrg;
  let key = '';

  async function call(who: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}, app = n): Promise<Res> {
    const r = await app.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tok[who]}`, ...headers }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const perms = async (who: string): Promise<string[]> => ok(await call(who, 'GET', '/v1/me')).permissions;
  const auditOf = async (action: string) => (await t.inspect.query<{ data: any }>(
    "SELECT a.data FROM notes.audit_log a JOIN notes.tenant t ON t.id = a.tenant_id WHERE t.alias = 'demo' AND a.action = $1 ORDER BY a.seq", [action])).rows.map(r => r.data);

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    demo = kc.org('demo', 'Demo AG');
    u.anna = kc.user('anna', { email: 'anna@demo.example', firstName: 'Anna', lastName: 'Admin' });
    u.carla = kc.user('carla', { email: 'carla@demo.example', firstName: 'Carla', lastName: 'Prüferin' });
    u.dana = kc.user('dana', { email: 'dana@demo.example', firstName: 'Dana', lastName: 'Duss' });
    kc.member(demo, u.anna, ['org-admin']); kc.member(demo, u.carla, ['editor']); kc.member(demo, u.dana, ['viewer']);
    for (const r of ['org-admin', 'editor', 'viewer']) kc.groupPath(`/orgs/demo/${r}`);
    n = await notesApp({ db: t.runtime, issuer: idp.issuer, env: { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' }, keycloakFetch: kc.fetch });
    off = await notesApp({ db: t.runtime, issuer: idp.issuer });
    const person = (x: FakeUser, roles: string[]) => idp.token(claims.user({ sub: x.id, org: 'demo', groupRoles: roles, email: x.email, name: `${x.firstName} ${x.lastName}` }));
    tok.anna = await person(u.anna, ['org-admin']);
    tok.carla = await person(u.carla, ['editor']);
    await tenant(t.runtime, 'demo', 'demo-m2m');
    tok.svc = await idp.token(claims.client({ clientId: 'demo-m2m', org: 'demo', roles: ['org-admin'], scopes: ['notes:read', 'notes:write'] }));
    for (const who of ['anna', 'carla']) ok(await call(who, 'GET', '/v1/me'));
  });
  after(async () => { await n?.app.close(); await off?.app.close(); await idp?.close(); await t?.drop(); });

  test('Liste: vordefinierte zuerst, Personenzahl nur für members:admin; ohne Verwaltung lesbar ohne Zahlen', async () => {
    const c = ok(await call('carla', 'GET', '/v1/roles'));
    assert.deepEqual(c.items.map((r: any) => r.key), ['org-admin', 'editor', 'viewer']);
    assert.ok(c.items.every((r: any) => !r.custom && r.memberCount === null));
    assert.deepEqual([c.maxCustom, c.customPermissions.includes('members:admin'), c.customPermissions.includes('note:write')], [50, false, true]);
    const a = ok(await call('anna', 'GET', '/v1/roles'));
    assert.deepEqual(a.items.map((r: any) => [r.key, r.memberCount, r.adminOnly]), [['org-admin', 1, true], ['editor', 1, false], ['viewer', 1, false]]);
    assert.equal(ok(await call('carla', 'GET', '/v1/roles/viewer')).label, 'Leser:in');
    assert.equal((await call('carla', 'GET', '/v1/roles/c-gibt-es-nicht')).status, 404);
    assert.equal(ok(await call('svc', 'GET', '/v1/roles')).items[0].memberCount, null, 'Maschinen-Client: ohne Zahlen');
    assert.equal(ok(await call('anna', 'GET', '/v1/roles', undefined, {}, off)).items[0].memberCount, null, 'ohne Verwaltung: ohne Zahlen');
  });

  test('Anlegen: nur Personen mit members:admin; abgelehnt werden Rechte nur für org-admin und vergebene Namen', async () => {
    const body = { label: 'Datenpflege', description: 'Pflegt Notizen', permissions: ['note:write', 'tenant:read', 'note:read'] };
    assert.equal((await call('carla', 'POST', '/v1/roles', body)).status, 403);
    assert.equal((await call('svc', 'POST', '/v1/roles', body)).status, 403, 'Maschinen-Client nie, auch mit org-admin');
    const admin = await call('anna', 'POST', '/v1/roles', { ...body, permissions: ['note:read', 'members:admin'] });
    assert.equal(admin.status, 422);
    assert.match(JSON.stringify(admin.body), /Mitglieder und Rollen verwalten/);
    assert.equal((await call('anna', 'POST', '/v1/roles', { ...body, permissions: ['gibt:es-nicht'] })).status, 422, 'unbekanntes Recht (Schema)');
    assert.equal((await call('anna', 'POST', '/v1/roles', { ...body, label: 'leser:IN' })).status, 422, 'Name einer vordefinierten Rolle');

    const r = await call('anna', 'POST', '/v1/roles', body);
    const role = ok(r, 201);
    key = role.key;
    assert.deepEqual([role.key, role.custom, role.version, role.permissions], ['c-datenpflege', true, 1, ['tenant:read', 'note:read', 'note:write']], 'Rechte in Katalogreihenfolge');
    assert.equal(r.headers.etag, 'W/"1"');
    assert.equal(r.headers.location, '/v1/roles/c-datenpflege');
    assert.equal((await call('anna', 'POST', '/v1/roles', { ...body, label: ' DATENPFLEGE ' })).status, 422, 'gleicher Name');
    assert.equal(ok(await call('anna', 'POST', '/v1/roles', { ...body, label: 'Datenpflege!' }), 201).key, 'c-datenpflege-2', 'gleicher Kurzname, anderer Name');
    assert.deepEqual((await auditOf('role.created')).map(x => x.key), ['c-datenpflege', 'c-datenpflege-2']);
    const st = ok(await call('anna', 'GET', '/v1/admin/status'));
    assert.deepEqual(st.roles.filter((x: any) => x.custom).map((x: any) => x.label), ['Datenpflege', 'Datenpflege!']);
  });

  test('Vergeben: eigene Rolle als Gruppe in Keycloak, Rechte wirken für die Person', async () => {
    const dana = ok(await call('anna', 'GET', '/v1/admin/members')).items.find((m: any) => m.username === 'dana');
    assert.equal((await call('anna', 'PUT', `/v1/admin/members/${dana.id}/roles`, { roles: ['viewer', 'c-unbekannt'] })).status, 422);
    assert.deepEqual(ok(await call('anna', 'PUT', `/v1/admin/members/${dana.id}/roles`, { roles: ['viewer', key] })).roles.sort(), [key, 'viewer']);
    assert.deepEqual(kc.rolesOf(demo, u.dana), [key, 'viewer']);
    tok.dana = await idp.token(claims.user({ sub: u.dana.id, org: 'demo', groupRoles: kc.rolesOf(demo, u.dana), email: u.dana.email }));
    const p = await perms('dana');
    assert.ok(p.includes('note:write') && !p.includes('note:share'));
    assert.equal(ok(await call('anna', 'GET', `/v1/roles/${key}`)).memberCount, 1);
  });

  test('Ändern: If-Match, neue Rechte gelten sofort; vordefinierte Rollen nicht änderbar', async () => {
    assert.equal((await call('anna', 'PATCH', '/v1/roles/viewer', { description: 'x' })).status, 409);
    assert.equal((await call('carla', 'PATCH', `/v1/roles/${key}`, { description: 'x' })).status, 403);
    assert.equal((await call('anna', 'PATCH', `/v1/roles/${key}`, { label: 'Datenpflege!' })).status, 422, 'Name einer anderen eigenen Rolle');
    const r = await call('anna', 'PATCH', `/v1/roles/${key}`, { permissions: ['tenant:read', 'note:read', 'note:write', 'note:share'] }, { 'if-match': 'W/"1"' });
    assert.equal(ok(r).version, 2);
    assert.equal(r.headers.etag, 'W/"2"');
    assert.ok((await perms('dana')).includes('note:share'), 'ohne neues Token: Rechte kommen aus der Organisation');
    // Andere Instanz (eigener Zwischenspeicher): Rechte der Rolle sofort neu (acl_version, Trigger auf tenant_role)
    const other = await notesApp({ db: t.runtime, issuer: idp.issuer });
    try {
      assert.ok(ok(await call('dana', 'GET', '/v1/me', undefined, {}, other)).permissions.includes('note:share'));
      ok(await call('anna', 'PATCH', `/v1/roles/${key}`, { permissions: ['tenant:read', 'note:read', 'note:write'] }));
      assert.ok(!ok(await call('dana', 'GET', '/v1/me', undefined, {}, other)).permissions.includes('note:share'), 'andere Instanz ohne Warten');
      ok(await call('anna', 'PATCH', `/v1/roles/${key}`, { permissions: ['tenant:read', 'note:read', 'note:write', 'note:share'] }));
    } finally { await other.app.close(); }
    assert.equal((await call('anna', 'PATCH', `/v1/roles/${key}`, { description: 'alt' }, { 'if-match': 'W/"1"' })).status, 412);
    assert.equal((await call('anna', 'PATCH', `/v1/roles/${key}`, { description: 'alt' }, { 'if-match': 'kaputt' })).status, 412);
    assert.deepEqual((await auditOf('role.updated'))[0], { key, label: 'Datenpflege', added: ['note:share'], removed: [] });
    assert.equal(ok(await call('anna', 'GET', `/v1/roles/${key}`)).version, 4);
  });

  test('Zugriffsregeln: eigene Rolle als Wer; unbekannte eigene Rolle abgelehnt', async () => {
    ok(await call('anna', 'POST', '/v1/acl', { resourceType: 'tenant', principalType: 'role', principalRef: key, permission: 'note:share', effect: 'deny' }), 201);
    assert.ok(!(await perms('dana')).includes('note:share'), 'verboten über die ACL');
    assert.equal((await call('anna', 'POST', '/v1/acl', { resourceType: 'tenant', principalType: 'role', principalRef: 'c-gibt-es-nicht', permission: 'note:read', effect: 'deny' })).status, 422);
  });

  test('Löschen: Gruppe und ACL-Einträge weg, Rechte sofort weg, Audit; Grabstein', async () => {
    assert.equal((await call('anna', 'DELETE', '/v1/roles/editor')).status, 409);
    assert.equal((await call('carla', 'DELETE', `/v1/roles/${key}`)).status, 403);
    assert.equal((await call('anna', 'DELETE', `/v1/roles/${key}`, undefined, { 'if-match': 'W/"1"' })).status, 412);
    // Zugriffsregel auf die Gruppe der Rolle: wirkte sonst über noch gültige Tokens früherer Mitglieder weiter
    const group = `/orgs/demo/${key}`;
    ok(await call('anna', 'POST', '/v1/acl', { resourceType: 'tenant', principalType: 'group', principalRef: group, permission: 'note:read', effect: 'grant' }), 201);
    n.events.length = 0;
    assert.equal((await call('anna', 'DELETE', `/v1/roles/${key}`, undefined, { 'if-match': 'W/"4"' })).status, 204);
    assert.deepEqual(n.events.map(e => [e.type, e.data.action, e.data.principalRef, e.data.reason]).sort(),
      [['acl.changed', 'acl.deleted', group, 'role.deleted'], ['acl.changed', 'acl.deleted', key, 'role.deleted']], 'acl.changed je gelöschtem Eintrag');
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.acl_entry WHERE principal_ref = $1', [group])).rows[0].n, 0);
    const late = await call('anna', 'POST', '/v1/acl', { resourceType: 'tenant', principalType: 'group', principalRef: group, permission: 'note:read', effect: 'grant' });
    assert.equal(late.status, 422, 'Gruppe einer gelöschten Rolle');
    assert.deepEqual(kc.rolesOf(demo, u.dana), ['viewer']);
    assert.ok(![...kc.groups.values()].some(g => g.path === `/orgs/demo/${key}`), 'Gruppe gelöscht');
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.acl_entry WHERE principal_ref = $1', [key])).rows[0].n, 0);
    assert.ok(!(await perms('dana')).includes('note:write'), 'altes Token mit der Gruppe gibt nichts mehr');
    assert.equal((await call('anna', 'GET', `/v1/roles/${key}`)).status, 404);
    const [d] = await auditOf('role.deleted');
    assert.deepEqual([d.key, d.members, d.aclEntries], [key, 1, 2]);
    const again = ok(await call('anna', 'POST', '/v1/roles', { label: 'Datenpflege', permissions: ['note:read', 'note:write'] }), 201);
    assert.equal(again.key, 'c-datenpflege-3', 'c-datenpflege-2 ist noch aktiv, c-datenpflege ist ein Grabstein');
    assert.ok(!(await perms('dana')).includes('note:write'), 'altes Token mit der Gruppe der gelöschten Rolle');
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.tenant_role WHERE key = $1 AND deleted_at IS NOT NULL', [key])).rows[0].n, 1);
  });

  test('Höchstzahl eigener Rollen: 409', async () => {
    const demoId = (await t.inspect.query("SELECT id FROM notes.tenant WHERE alias = 'demo'")).rows[0].id;
    const have = (await t.inspect.query('SELECT count(*)::int AS n FROM notes.tenant_role WHERE tenant_id = $1 AND deleted_at IS NULL', [demoId])).rows[0].n;
    await t.inspect.query("INSERT INTO notes.tenant_role (tenant_id, key, label, permissions) SELECT $1, 'c-fuell-' || i, 'Füll ' || i, '{note:read}' FROM generate_series(1, $2::int) i", [demoId, 50 - have]);
    const r = await call('anna', 'POST', '/v1/roles', { label: 'Eine zu viel', permissions: ['note:read'] });
    assert.deepEqual([r.status, r.body.reason], [409, 'too-many-roles']);
    await t.inspect.query("DELETE FROM notes.tenant_role WHERE key LIKE 'c-fuell-%'");
  });

  const fresh = async (label: string) => ok(await call('anna', 'POST', '/v1/roles', { label, permissions: ['note:read'] }), 201) as { key: string; version: number };

  test('Gleichzeitig ändern: If-Match gilt (einmal 200, einmal 412), nichts geht verloren', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await fresh(`Parallel ${i}`);
      const patch = (permissions: string[]) => call('anna', 'PATCH', `/v1/roles/${r.key}`, { permissions }, { 'if-match': `W/"${r.version}"` });
      const res = await Promise.all([patch(['note:read', 'note:write']), patch(['note:read', 'note:share'])]);
      assert.deepEqual(res.map(x => x.status).sort(), [200, 412], `Lauf ${i}`);
      // Nur Beschreibung ohne If-Match: schreibt nie einen veralteten Stand der Rechte zurück
      await Promise.all([call('anna', 'PATCH', `/v1/roles/${r.key}`, { permissions: ['note:read'] }), call('anna', 'PATCH', `/v1/roles/${r.key}`, { description: 'neu' })]);
      assert.deepEqual(ok(await call('anna', 'GET', `/v1/roles/${r.key}`)).permissions, ['note:read'], `Lauf ${i}: Rechteentzug bleibt`);
    }
  });

  test('Löschen gegen gleichzeitiges Ändern: nie Gruppe weg und Rolle aktiv, kein geänderter Grabstein', async () => {
    const r = await fresh('Wettlauf');
    const dana = ok(await call('anna', 'GET', '/v1/admin/members')).items.find((m: any) => m.username === 'dana');
    ok(await call('anna', 'PUT', `/v1/admin/members/${dana.id}/roles`, { roles: ['viewer', r.key] }));
    // Während Keycloak die Gruppe löscht, ändert jemand die Rolle
    let patch: Promise<Res> | null = null;
    kc.before = async c => {
      if (!c.startsWith('DELETE /groups/') || patch) return;
      patch = call('anna', 'PATCH', `/v1/roles/${r.key}`, { description: 'gleichzeitig' });
      await Promise.race([patch, new Promise(res => setTimeout(res, 300))]);
    };
    try {
      const del = await call('anna', 'DELETE', `/v1/roles/${r.key}`, undefined, { 'if-match': `W/"${r.version}"` });
      assert.equal(del.status, 204, JSON.stringify(del.body));
      assert.equal((await patch!)?.status, 404, 'Änderung wartet auf das Löschen und findet die Rolle nicht mehr');
    } finally { kc.before = null; }
    const row = (await t.inspect.query('SELECT description, deleted_at FROM notes.tenant_role WHERE key = $1', [r.key])).rows[0];
    assert.ok(row.deleted_at && row.description === '', 'Grabstein unverändert');
    assert.ok(![...kc.groups.values()].some(g => g.path === `/orgs/demo/${r.key}`));
  });

  test('Vergeben auf einer anderen Instanz nach dem Löschen: 422, keine neue Gruppe (Rollen-Zwischenspeicher)', async () => {
    const r = await fresh('Andere Instanz');
    const other = await notesApp({ db: t.runtime, issuer: idp.issuer, env: { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' }, keycloakFetch: kc.fetch });
    try {
      const dana = ok(await call('anna', 'GET', '/v1/admin/members', undefined, {}, other)).items.find((m: any) => m.username === 'dana');
      ok(await call('anna', 'PUT', `/v1/admin/members/${dana.id}/roles`, { roles: ['viewer', r.key] }, {}, other));
      ok(await call('anna', 'PUT', `/v1/admin/members/${dana.id}/roles`, { roles: ['viewer'] }, {}, other));
      assert.equal((await call('anna', 'DELETE', `/v1/roles/${r.key}`)).status, 204);
      const again = await call('anna', 'PUT', `/v1/admin/members/${dana.id}/roles`, { roles: ['viewer', r.key] }, {}, other);
      assert.equal(again.status, 422, JSON.stringify(again.body));
      assert.ok(![...kc.groups.values()].some(g => g.path === `/orgs/demo/${r.key}`), 'Gruppe nicht neu angelegt');
      assert.deepEqual(kc.rolesOf(demo, u.dana), ['viewer']);
    } finally { await other.app.close(); }
  });

  test('Client-Rollen `c-…` eines Service Accounts gelten nie als eigene Rolle', async () => {
    const r = ok(await call('anna', 'POST', '/v1/roles', { label: 'Für Clients', permissions: ['note:read', 'note:write'] }), 201);
    tok.svcCustom = await idp.token(claims.client({ clientId: 'demo-m2m', org: 'demo', roles: [r.key], scopes: ['notes:read', 'notes:write'] }));
    const me = ok(await call('svcCustom', 'GET', '/v1/me'));
    assert.ok(!me.roles.includes(r.key) && !me.permissions.includes('note:write'), JSON.stringify(me));
  });
});

describe('Rollengruppen mit mehrstufigem Präfix (GROUP_ROLE_PREFIX)', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  const kc = new KeycloakFake({ groupPrefix: '/kunden/orgs' });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('fehlende Stufen werden einzeln angelegt', async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    kc.org('demo', 'Demo AG');
    const ops = kc.org('ops', 'Betrieb'), paula = kc.user('paula', { email: 'paula@ops.example' });
    kc.member(ops, paula);
    n = await notesApp({ db: t.runtime, issuer: idp.issuer, env: { GROUP_ROLE_PREFIX: '/kunden/orgs', KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' }, keycloakFetch: kc.fetch });
    const tok = await idp.token({ ...claims.user({ sub: paula.id, org: 'ops' }), realm_access: { roles: ['platform-admin'] } });
    const r = await n.app.inject({ method: 'POST', url: '/v1/platform/organizations/demo/members', headers: { authorization: `Bearer ${tok}` }, payload: { email: 'neu@demo.example', roles: ['viewer'] } });
    assert.equal(r.statusCode, 202, r.body);
    const paths = [...kc.groups.values()].map(g => [g.path, g.name]);
    assert.ok(paths.some(([p, nm]) => p === '/kunden' && nm === 'kunden') && paths.some(([p]) => p === '/kunden/orgs/demo/viewer'), JSON.stringify(paths));
  });
});
