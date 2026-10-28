/**
 * Eigene Rollen der Organisation (roles.ts, Modul `roles`, iam_019): zusammenstellen, vergeben (an org und an Orten),
 * Wirkung in Entscheidung und Lesesicht (RLS), ändern wirkt sofort, löschen nur unvergeben, Regeln (nur Rechte des
 * Modells, keine nur von org-admin, niemand gibt mehr, als er hat, Recht roles:admin, nur Personen), Katalog und Status
 * mit eigenen Rollen, Ereignisse, abschaltbar. Die Trennung zwischen Organisationen prüft tenant-isolation.test.ts.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { KeycloakFake, startMockIdp, type FakeOrg, type FakeUser, type MockIdp } from '@vollholz/iam-testkit';
import type { IamEvent } from '../src/events.ts';
import { CUSTOM_ROLE_LIMIT, defineModel } from '../src/model.ts';
import { customRoleKey } from '../src/roles.ts';
import { skipDb } from './support/db.ts';
import { claims, folderWithNote, full, grant, member, notesApp, notesDb, tenant, view, type NotesApp } from './support/http.ts';
import { notesInput } from './support/models.ts';

const skip = await skipDb();
type Res = { status: number; body: any };
const MGMT = { DPOP_MODE: 'optional', KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' };

/** Notiz-App mit einer Rolle, die eigene Rollen zusammenstellen darf (roles:admin), ohne alle Rechte. */
const input = notesInput();
const model = defineModel({
  ...input,
  roles: { ...input.roles, steward: { label: 'Rollenverwaltung', description: 'Stellt Rollen für Mitglieder zusammen und liest Notizen; Organisation lesen.', permissions: ['tenant:read', 'roles:admin', 'note:read'] } },
});
const offModel = defineModel({ ...input, features: { audit: true, customRoles: false } });

describe('Eigene Rollen der Organisation', { skip }, () => {
  const db = notesDb(model);
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp, off: NotesApp;
  const kc = new KeycloakFake();
  const tok: Record<string, string> = {};
  let demo: FakeOrg, anna: FakeUser, dana: FakeUser, sven: FakeUser, olga: FakeUser, demoId: string, notes: { folder: string; note: string }, viewId: string;

  async function call(who: string, method: string, url: string, body?: unknown, app: NotesApp = n): Promise<Res> {
    const r = await app.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tok[who]}` }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const perms = async (who: string) => (ok(await call(who, 'GET', '/v1/me')).permissions as string[]);
  const audits = async (action: string) => (await t.inspect.query<{ resource_id: string; data: any }>(
    "SELECT a.resource_id, a.data FROM notes.audit_log a JOIN notes.tenant x ON x.id = a.tenant_id WHERE x.alias = 'demo' AND a.action = $1 ORDER BY a.seq", [action])).rows;
  const pid = async (sub: string) => (await t.inspect.query<{ id: string }>('SELECT id FROM notes.principal WHERE subject = $1', [sub])).rows[0]!.id;

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    demo = kc.org('demo', 'Demo AG'); const ops = kc.org('ops', 'Betrieb');
    anna = kc.user('anna', { email: 'anna@demo.example', firstName: 'Anna', lastName: 'Admin' });
    dana = kc.user('dana', { email: 'dana@demo.example', firstName: 'Dana', lastName: 'Duss' });
    sven = kc.user('sven', { email: 'sven@demo.example', firstName: 'Sven', lastName: 'Steward' });
    olga = kc.user('olga', { email: 'olga@demo.example', firstName: 'Olga', lastName: 'Ort' });
    const paula = kc.user('paula', { email: 'paula@ops.example', firstName: 'Paula', lastName: 'Plattform' });
    for (const [u, r] of [[anna, 'org-admin'], [dana, 'viewer'], [sven, 'steward'], [olga, null]] as const) { kc.member(demo, u); await member(t.runtime, 'demo', u.id, r); }
    kc.member(ops, paula); await member(t.runtime, 'ops', paula.id, 'org-admin');
    demoId = await tenant(t.runtime, 'demo');
    notes = await folderWithNote(t.runtime, demoId, 'Prüfung');
    await folderWithNote(t.runtime, demoId, 'Andere');
    viewId = await view(t.runtime, demoId, 'Ansicht');
    n = await notesApp({ db: t.runtime, issuer: idp.issuer, env: MGMT, keycloakFetch: kc.fetch, model });
    off = await notesApp({ db: t.runtime, issuer: idp.issuer, env: MGMT, keycloakFetch: kc.fetch, model: offModel });
    const person = (u: FakeUser, org = 'demo') => idp.token(claims.user({ sub: u.id, org, email: u.email, name: `${u.firstName} ${u.lastName}` }));
    tok.anna = await person(anna); tok.dana = await person(dana); tok.sven = await person(sven); tok.olga = await person(olga);
    tok.paula = await idp.token({ ...claims.user({ sub: paula.id, org: 'ops', email: paula.email, name: 'Paula Plattform' }), realm_access: { roles: ['platform-admin'] } });
    tok.mcp = await idp.token({ ...claims.user({ sub: anna.id, org: 'demo' }), azp: 'notes-mcp', scope: 'notes:read notes:write' });
    for (const who of ['anna', 'dana', 'sven', 'olga', 'paula']) ok(await call(who, 'GET', '/v1/me'));
  });
  after(async () => { await n?.app.close(); await off?.app.close(); await idp?.close(); await t?.drop(); });

  test('anlegen: Schlüssel aus dem Namen, im Katalog (custom) und im Status, an ihren Orten; Audit', async () => {
    const r = ok(await call('anna', 'POST', '/v1/admin/roles', { label: 'Prüfer:in Ärzte', description: 'Liest Notizen zur Prüfung.', permissions: ['note:read', 'tenant:read'], places: ['org', 'folder'] }), 201);
    assert.deepEqual([r.key, r.label, r.permissions, r.places, r.assignments], ['c-pruefer-in-aerzte', 'Prüfer:in Ärzte', ['note:read', 'tenant:read'], ['org', 'folder'], 0]);
    const cat = ok(await call('dana', 'GET', '/v1/authz/catalog'));
    const role = cat.roles.find((x: any) => x.key === r.key);
    assert.deepEqual([role.custom, role.adminOnly, cat.roles.at(-1).key], [true, false, r.key], 'nach den Rollen des Modells');
    assert.ok(cat.types.find((x: any) => x.key === 'folder').roles.includes(r.key));
    assert.ok(!cat.types.find((x: any) => x.key === 'view').roles.includes(r.key), 'nur an ihren Orten');
    assert.ok(ok(await call('anna', 'GET', '/v1/admin/status')).roles.some((x: any) => x.key === r.key && x.custom === true));
    assert.deepEqual(ok(await call('anna', 'GET', '/v1/admin/roles')).items.map((x: any) => x.key), [r.key]);
    const a = (await audits('role.created')).at(-1)!;
    assert.deepEqual([a.data.key, a.data.permissions], [r.key, ['note:read', 'tenant:read']]);
    assert.equal(customRoleKey('Leitung Ö-Team'), 'c-leitung-oe-team');
  });

  test('vergeben an org (Rollen setzen) wirkt in Entscheidung, Lesesicht (RLS) und Ereignis; an einem Ort nur, wo zulässig', async () => {
    n.events.length = 0;
    const m = ok(await call('anna', 'PUT', `/v1/admin/members/${dana.id}/roles`, { roles: ['c-pruefer-in-aerzte'] }));
    assert.deepEqual(m.roles, ['c-pruefer-in-aerzte']);
    assert.deepEqual(n.events.map(e => [e.type, (e as IamEvent<'access.granted'>).data.relation]), [['access.revoked', 'viewer'], ['access.granted', 'c-pruefer-in-aerzte']]);
    assert.deepEqual((await perms('dana')).sort(), ['note:read', 'tenant:read']);
    assert.equal(ok(await call('dana', 'GET', `/v1/notes/${notes.note}`)).id, notes.note, 'Entscheidung');
    assert.equal(ok(await call('dana', 'GET', '/v1/notes')).items.length, 2, 'Lesesicht: alle Notizen (Rolle an org)');
    assert.ok(ok(await call('dana', 'GET', '/v1/me')).roles.includes('c-pruefer-in-aerzte'));
    // An einem Ort: Person ohne Rolle an org erhält sie am Ordner – sieht nur dessen Notiz (Entscheidung und RLS)
    const op = await pid(olga.id);
    ok(await call('anna', 'POST', '/v1/access', { subject: `user:${op}`, relation: 'c-pruefer-in-aerzte', type: 'folder', id: notes.folder }), 201);
    assert.deepEqual(ok(await call('olga', 'GET', '/v1/notes')).items.map((x: any) => x.id), [notes.note], 'Lesesicht: nur die Notiz im Ordner');
    assert.equal(ok(await call('olga', 'GET', `/v1/notes/${notes.note}`)).id, notes.note);
    assert.deepEqual(await perms('olga'), [], 'an org keine Rechte');
    const sp = await pid(sven.id);
    const g = ok(await call('anna', 'POST', '/v1/access', { subject: `user:${sp}`, relation: 'c-pruefer-in-aerzte', type: 'folder', id: notes.folder }), 201);
    assert.equal(g.relation, 'c-pruefer-in-aerzte');
    const v = await call('anna', 'POST', '/v1/access', { subject: `user:${sp}`, relation: 'c-pruefer-in-aerzte', type: 'view', id: viewId });
    assert.equal(v.status, 422, 'nicht an diesem Typ');
    assert.equal((await call('anna', 'POST', '/v1/admin/members', { email: 'neu@demo.example', roles: ['c-gibt-es-nicht'] })).status, 422);
    const inv = ok(await call('anna', 'POST', '/v1/admin/members', { email: 'neu@demo.example', roles: ['c-pruefer-in-aerzte'] }), 202);
    assert.deepEqual(inv.member.roles, ['c-pruefer-in-aerzte'], 'einladen mit eigener Rolle');
    assert.equal(ok(await call('anna', 'GET', '/v1/admin/roles')).items[0].assignments, 4);
  });

  test('ändern wirkt sofort; Ort entfernen und löschen nur unvergeben (409 in-use, auch in der Datenbank)', async () => {
    ok(await call('anna', 'PUT', '/v1/admin/roles/c-pruefer-in-aerzte', { label: 'Prüfer:in Ärzte', permissions: ['team:read', 'tenant:read'], places: ['org', 'folder'] }));
    assert.deepEqual((await perms('dana')).sort(), ['team:read', 'tenant:read'], 'neue Rechte gelten sofort');
    assert.equal((await call('dana', 'GET', `/v1/notes/${notes.note}`)).status, 403);
    const a = (await audits('role.updated')).at(-1)!;
    assert.deepEqual([a.data.before.permissions, a.data.after.permissions], [['note:read', 'tenant:read'], ['team:read', 'tenant:read']]);
    const place = await call('anna', 'PUT', '/v1/admin/roles/c-pruefer-in-aerzte', { label: 'Prüfer:in Ärzte', permissions: ['team:read'], places: ['org'] });
    assert.deepEqual([place.status, place.body.reason], [409, 'in-use'], 'am Ordner noch vergeben');
    const del = await call('anna', 'DELETE', '/v1/admin/roles/c-pruefer-in-aerzte');
    assert.deepEqual([del.status, del.body.reason, del.body.assignments], [409, 'in-use', 4]);
    await assert.rejects(full(t.runtime, demoId, tx => tx.query("DELETE FROM notes.authz_role WHERE key = 'c-pruefer-in-aerzte'")), /noch vergeben/);
    await assert.rejects(full(t.runtime, demoId, tx => tx.query("UPDATE notes.authz_role SET key = 'c-anders' WHERE key = 'c-pruefer-in-aerzte'")), /lässt sich nicht ändern/);
    await assert.rejects(grant(t.runtime, demoId, 'org:members', 'c-pruefer-in-aerzte', { type: 'view', id: viewId }), /nicht zulässig/);
  });

  test('Regeln: nur Rechte des Modells, keine nur von org-admin, Namen eindeutig, Höchstzahl; Rollen des Modells unverändert', async () => {
    const bad = await call('anna', 'POST', '/v1/admin/roles', { label: 'Zu viel', permissions: ['members:admin'], places: ['org'] });
    assert.equal(bad.status, 422, 'members:admin hat nur org-admin');
    assert.equal((await call('anna', 'POST', '/v1/admin/roles', { label: 'X', permissions: ['nix:da'], places: ['org'] })).status, 422);
    assert.equal((await call('anna', 'POST', '/v1/admin/roles', { label: 'X', permissions: ['note:read'], places: ['gibts-nicht'] })).status, 422);
    assert.equal((await call('anna', 'POST', '/v1/admin/roles', { key: 'editor', label: 'X', permissions: ['note:read'], places: ['org'] })).status, 422, 'Schlüssel ohne «c-»: nie eine Rolle des Modells');
    const dup = await call('anna', 'POST', '/v1/admin/roles', { label: ' prüfer:in ärzte ', permissions: ['note:read'], places: ['org'] });
    assert.deepEqual([dup.status, dup.body.reason], [409, 'duplicate-label']);
    assert.equal(ok(await call('dana', 'GET', '/v1/authz/catalog')).roles.find((x: any) => x.key === 'editor').label, 'Bearbeiter:in');
    // Höchstzahl
    await full(t.runtime, demoId, async tx => {
      for (let i = 1; i < CUSTOM_ROLE_LIMIT; i++) await tx.query("INSERT INTO notes.authz_role (tenant_id, key, label, permissions, places) VALUES ($1, $2, $3, '{note:read}', '{org}')", [demoId, `c-viele-${i}`, `Viele ${i}`]);
    });
    const lim = await call('anna', 'POST', '/v1/admin/roles', { label: 'Eine zu viel', permissions: ['note:read'], places: ['org'] });
    assert.deepEqual([lim.status, lim.body.reason], [409, 'limit']);
    await full(t.runtime, demoId, tx => tx.query("DELETE FROM notes.authz_role WHERE key LIKE 'c-viele-%'"));
  });

  test('wer darf: roles:admin, nur Personen; niemand gibt mehr, als er hat (auch beim Ändern und Löschen); Plattform', async () => {
    assert.equal((await call('dana', 'GET', '/v1/admin/roles')).status, 403, 'ohne roles:admin');
    assert.equal((await call('mcp', 'GET', '/v1/admin/roles')).status, 403, 'nicht über den MCP-Dienst');
    const more = await call('sven', 'POST', '/v1/admin/roles', { label: 'Schreiben', permissions: ['note:read', 'note:write'], places: ['org'] });
    assert.deepEqual([more.status, more.body.reason, more.body.missing], [403, 'exceeds-own', ['note:write']]);
    const mine = ok(await call('sven', 'POST', '/v1/admin/roles', { label: 'Nur lesen', permissions: ['note:read'], places: ['folder'] }), 201);
    const up = await call('sven', 'PUT', '/v1/admin/roles/c-pruefer-in-aerzte', { label: 'Prüfer:in Ärzte', permissions: ['note:read'], places: ['org', 'folder'] });
    assert.deepEqual([up.status, up.body.reason], [403, 'exceeds-own'], 'vorher team:read, das sven nicht hat');
    assert.equal((await call('sven', 'DELETE', `/v1/admin/roles/${mine.key}`)).status, 204);
    const p = ok(await call('paula', 'POST', '/v1/platform/organizations/demo/roles', { label: 'Plattform-Rolle', permissions: ['view:read', 'view:write'], places: ['view'] }), 201);
    assert.ok(ok(await call('paula', 'GET', '/v1/platform/organizations/demo/roles')).items.some((x: any) => x.key === p.key));
    assert.equal((await audits('role.created')).at(-1)!.data.platformAdmin, true);
    assert.equal((await call('paula', 'DELETE', `/v1/platform/organizations/demo/roles/${p.key}`)).status, 204);
  });

  test('abgeschaltet (features.customRoles: false): keine Routen, kein roles:admin, eigene Rollen zählen nicht', async () => {
    assert.equal((await call('anna', 'GET', '/v1/admin/roles', undefined, off)).status, 404);
    const cat = ok(await call('dana', 'GET', '/v1/authz/catalog', undefined, off));
    assert.ok(!cat.permissions.some((x: any) => x.key === 'roles:admin'));
    assert.ok(!cat.roles.some((x: any) => x.custom), 'die Zeilen der Datenbank bleiben unbeachtet');
    assert.equal((await call('anna', 'PUT', `/v1/admin/members/${dana.id}/roles`, { roles: ['c-pruefer-in-aerzte'] }, off)).status, 422);
    assert.ok(!(await call('dana', 'GET', '/v1/me', undefined, off)).body.permissions.includes('team:read'), 'Tupel einer eigenen Rolle geben keine Rechte');
  });
});
