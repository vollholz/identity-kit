/**
 * Rollen an `org` begrenzen (Kit 1.3, `types.org.roles`, Spezifikation 7.3, M5): Der Katalog liefert die Liste, `POST /v1/access`,
 * Clients und Mitglieder (`checkRoles`) lehnen Rollen ab, die an `org` nicht hängen dürfen (422), die Rolle gilt an anderen
 * Orten weiter; die Rollenauswahl der Mitglieder (`GET /v1/admin/status`) zeigt nur Rollen, die an `org` zulässig sind.
 */
import assert from 'node:assert/strict';
import pg from 'pg';
import { after, before, describe, test } from 'node:test';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { syncModelChecks } from '../src/migrations.ts';
import { checkRoles } from '../src/rules.ts';
import { skipDb } from './support/db.ts';
import { claims, folderWithNote, grant, grantClient, notesApp, notesDb, tenant, withRole, type NotesApp } from './support/http.ts';
import { orgLimitedModel } from './support/models.ts';

const skip = await skipDb();

describe('Rollen an org begrenzen (types.org.roles)', { skip }, () => {
  const dbs = notesDb(orgLimitedModel);
  let t: Awaited<ReturnType<typeof dbs.create>>, idp: MockIdp, n: NotesApp;
  let A: string, F1: string, tok: string;
  const call = (method: string, url: string, payload?: unknown) => n.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tok}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  before(async () => {
    t = await dbs.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    n = await notesApp({ db: t.runtime, issuer: idp.issuer, model: orgLimitedModel });
    A = await tenant(t.runtime, 'acme', 'import');
    F1 = (await folderWithNote(t.runtime, A, 'F1')).folder;
    tok = await idp.token({ ...await withRole(t.runtime, claims.user({ org: 'acme', name: 'Ada' }), 'org-admin', 2) });
    assert.equal((await call('GET', '/v1/me')).statusCode, 200);
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('Katalog: types.org.roles ohne die Rolle, Ordner mit', async () => {
    const types = (await call('GET', '/v1/authz/catalog')).json().types as { key: string; roles: string[] }[];
    assert.deepEqual(types.find(x => x.key === 'org')!.roles, ['org-admin', 'editor', 'viewer']);
    assert.ok(types.find(x => x.key === 'folder')!.roles.includes('sharer'));
  });

  test('POST /v1/access: Rolle an org 422 (/relation), am Ordner 201', async () => {
    const me = (await call('GET', '/v1/me')).json().principal.id as string;
    const bad = await call('POST', '/v1/access', { subject: `user:${me}`, relation: 'sharer', type: 'org' });
    assert.equal(bad.statusCode, 422, bad.body);
    assert.equal(bad.json().errors[0].path, '/relation');
    assert.equal((await call('POST', '/v1/access', { subject: `user:${me}`, relation: 'sharer', type: 'folder', id: F1 })).statusCode, 201);
  });

  test('Clients: Rolle nur am Ordner → 422; Mitglieder-Rollen (checkRoles) ebenso', async () => {
    const r = await call('PUT', '/v1/admin/clients/import', { roles: ['sharer'] });
    assert.equal(r.statusCode, 422, r.body);
    assert.match(r.json().detail, /sharer/);
    assert.equal((await call('PUT', '/v1/admin/clients/import', { roles: ['viewer'] })).statusCode, 200);
    assert.deepEqual(checkRoles(n.iam.access, ['viewer', 'viewer']), ['viewer']);
    assert.throws(() => checkRoles(n.iam.access, ['sharer']), /Rolle an der Organisation nicht zulässig: sharer/);
  });

  test('Mitglieder: Status liefert nur Rollen, die an org zulässig sind', async () => {
    const roles = ((await call('GET', '/v1/admin/status')).json().roles as { key: string }[]).map(x => x.key);
    assert.deepEqual(roles, ['org-admin', 'editor', 'viewer']);
  });

  test('bestehende Tupel mit an org nicht zulässiger Rolle zählen nicht; neue lehnt die Datenbank ab (NOT VALID)', async () => {
    const bea = await idp.token(await withRole(t.runtime, claims.user({ org: 'acme', name: 'Bea' }), null));
    const me = (await n.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${bea}` } })).json().principal.id as string;
    // Zustand vor dem Begrenzen: Bedingung weg, Tupel an org (und am Ordner) mit «sharer» vorhanden
    await t.inspect.query('ALTER TABLE notes.authz_tuple DROP CONSTRAINT authz_tuple_type_relation_check');
    await grant(t.runtime, A, `user:${me}`, 'sharer');
    await grant(t.runtime, A, `user:${me}`, 'sharer', { type: 'folder', id: F1 });
    const clientId = await grantClient(t.runtime, A, 'old-client', 'sharer');
    n.iam.access.invalidate(A);
    const as = (x: string, url: string) => n.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${x}` } });
    const b = (await as(bea, '/v1/me')).json();
    assert.deepEqual([b.roles, b.permissions], [[], []], 'org-Tupel zählt nicht (Rollen, Rechte)');
    assert.ok(b.somewhere.includes('note:read'), 'am Ordner gilt die Rolle weiter');
    assert.equal(n.iam.access.clientGranted(await n.iam.access.load(A), clientId), false, 'Client ohne zulässige Rolle an org');
    // Auskunft: das ungültige org-Tupel erscheint nicht
    const org = (await call('GET', '/v1/access?type=org')).json();
    assert.ok(!org.items.some((i: { relation: string }) => i.relation === 'sharer'));
    // Lesesicht: Relationen am Blatt nur mit am Blatt zulässigen Rollen
    const view = await n.iam.access.readView(A, { kind: 'user', principalId: me, subjects: [`user:${me}`], scopeBound: false, scopes: [] } as never, await n.iam.access.load(A));
    assert.ok(!view['app.read_relations']!.includes('sharer'), view['app.read_relations']);
    // Abgleich: Bedingung kommt zurück, bestehende Tupel bleiben, neue werden abgelehnt
    const c = new pg.Client({ connectionString: t.adminUrl });
    await c.connect();
    try { await c.query('BEGIN'); await syncModelChecks(c, 'notes', orgLimitedModel); await c.query('COMMIT'); } finally { await c.end(); }
    assert.equal((await t.inspect.query("SELECT convalidated FROM pg_constraint WHERE conname = 'authz_tuple_type_relation_check'")).rows[0].convalidated, false);
    assert.equal(Number((await t.inspect.query("SELECT count(*) FROM notes.authz_tuple WHERE relation = 'sharer' AND object_type = 'org'")).rows[0].count), 2, 'bestehende bleiben');
    await assert.rejects(grant(t.runtime, A, `user:${me}`, 'sharer'), /authz_tuple_type_relation_check/);
    await grant(t.runtime, A, `user:${me}`, 'viewer', { type: 'folder', id: F1 });
  });
});
