/**
 * Entscheidung (Spezifikation Kap. 7.1; Entwurf 13.2, 13.3; aus Assets test/platform/unit.test.ts «ACL-Entscheidung»):
 * (Rolle ∨ Freigabe) ∧ Scope ∧ kein Verbot und keine Beschränkung, mit dem Katalog von Assets und einem Ressourcen-Modell
 * wie Assets; dazu Laden, Zwischenspeicher und Kontext gegen PostgreSQL.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AccessService, capabilities, capabilitiesFor, canSchema, indexAcl, type AclRow, type TenantAccess } from '../src/access.ts';
import { withTenant } from '../src/db.ts';
import { migration } from '../src/migrations.ts';
import type { Principal } from '../src/principal.ts';
import type { ResourceModel } from '../src/resources.ts';
import { assetsResources, type AssetsState } from './support/assets-resources.ts';
import { assetsCatalog, notesCatalog } from './support/catalogs.ts';
import { productDb, skipDb } from './support/db.ts';

const skip = await skipDb();

const p = (roles: string[], extra: Partial<Principal> = {}): Principal => ({ tenantId: 't', tenantAlias: 'a', principalId: 'p1', kind: 'user', subject: 's', name: 'n', email: null, clientId: null, roles, groups: [], scopes: [], platformAdmin: false, binding: 'none', token: '', ...extra });

describe('Entscheidung wie Assets (ohne Datenbank)', () => {
  const acc = new AccessService(null as never, { catalog: assetsCatalog, schema: 'assets', resources: assetsResources });
  const acl = (entries: object[], roles: [string, string[]][] = []): TenantAccess<AssetsState> => ({ version: '1', entries: entries as AclRow[], byKey: indexAcl(entries as AclRow[]), roles: new Map(roles), state: { typeSchema: new Map([['laptop', 's1'], ['notebook', 's1']]), typeParent: new Map<string, string | null>([['laptop', null], ['notebook', 'laptop']]) } });

  test('eigene Rolle: Rechte aus der Organisation, nie Rechte nur für org-admin, nur mit Präfix c-', () => {
    const a = acl([], [['c-pflege', ['tenant:read', 'object:read', 'object:write', 'members:admin']], ['viewer', ['object:delete']]]);
    assert.equal(acc.decide(p(['c-pflege']), a, 'object:write'), true);
    assert.equal(acc.decide(p(['c-pflege']), a, 'object:delete'), false);
    assert.equal(acc.decide(p(['c-pflege']), a, 'members:admin'), false, 'ADMIN_ONLY bleibt bei org-admin, auch wenn die Datenbank mehr enthielte');
    assert.equal(acc.decide(p(['c-andere']), a, 'object:read'), false, 'unbekannte eigene Rolle gibt nichts');
    assert.equal(acc.decide(p(['viewer']), a, 'object:delete'), false, 'vordefinierte Rollen kommen nur aus dem Code');
    assert.equal(acc.decide(p(['c-pflege']), acl([{ resource_type: 'type', resource_id: 'laptop', principal_type: 'role', principal_ref: 'c-pflege', permission: 'object:write', effect: 'deny' }], [['c-pflege', ['object:write']]]), 'object:write', { type: 'type', id: 'laptop' }), false, 'ACL für die eigene Rolle');
  });

  test('ohne Einträge gilt das Rollenrecht', () => {
    assert.ok(acc.decide(p(['viewer']), acl([]), 'object:read', { type: 'object', id: 'o' }, 'notebook'));
    assert.ok(!acc.decide(p(['viewer']), acl([]), 'object:write', { type: 'object', id: 'o' }, 'notebook'));
  });

  test('Beschränkung auf übergeordnetem Typ schränkt ein und vererbt sich', () => {
    const a = acl([{ resource_type: 'type', resource_id: 'laptop', principal_type: 'group', principal_ref: '/orgs/a/it', permission: 'object:read', effect: 'restrict' }]);
    assert.ok(!acc.decide(p(['viewer']), a, 'object:read', { type: 'object', id: 'o' }, 'notebook'));
    assert.ok(acc.decide(p(['viewer'], { groups: ['/orgs/a/it'] }), a, 'object:read', { type: 'object', id: 'o' }, 'notebook'));
  });

  test('Deny gewinnt, org-admin ist ausgenommen', () => {
    const a = acl([{ resource_type: 'schema', resource_id: 's1', principal_type: 'role', principal_ref: 'editor', permission: 'object:delete', effect: 'deny' }]);
    assert.ok(!acc.decide(p(['editor']), a, 'object:delete', { type: 'type', id: 'laptop' }));
    assert.ok(acc.decide(p(['org-admin']), a, 'object:delete', { type: 'type', id: 'laptop' }));
    assert.ok(acc.isExempt(p(['org-admin'])) && !acc.isExempt(p(['org-admin'], { kind: 'client' })));
  });

  test('Deny gilt für Maschinen-Clients mit org-admin (Ausnahme nur für Personen)', () => {
    const a = acl([{ resource_type: 'schema', resource_id: 's1', principal_type: 'client', principal_ref: 'import', permission: 'object:delete', effect: 'deny' }]);
    const c = p(['org-admin'], { kind: 'client', clientId: 'import', scopes: ['assets:read', 'objects:write'] });
    assert.ok(!acc.decide(c, a, 'object:delete', { type: 'type', id: 'laptop' }));
    assert.ok(acc.decide(c, a, 'object:write', { type: 'type', id: 'laptop' }));
    // Person mit org-admin über den MCP-Dienst bleibt ausgenommen (durch Scopes begrenzt)
    const mcp = p(['org-admin'], { clientId: 'import', scopeBound: true, scopes: ['assets:read', 'objects:write'] });
    assert.ok(acc.decide(mcp, a, 'object:delete', { type: 'type', id: 'laptop' }));
  });

  test('getauschtes Token eines Maschinen-Clients über MCP: Regeln für den ursprünglichen Client gelten', () => {
    const at = { type: 'type', id: 'laptop' };
    const c = p(['editor'], { kind: 'client', clientId: 'assets-mcp', grantId: 'import', scopes: ['assets:read', 'objects:write'] });
    const deny = (ref: string) => acl([{ resource_type: 'schema', resource_id: 's1', principal_type: 'client', principal_ref: ref, permission: 'object:write', effect: 'deny' }]);
    const only = (ref: string) => acl([{ resource_type: 'schema', resource_id: 's1', principal_type: 'client', principal_ref: ref, permission: 'object:write', effect: 'restrict' }]);
    assert.ok(!acc.decide(c, deny('import'), 'object:write', at), 'Verbot für den Client wirkt auch über MCP');
    assert.ok(!acc.decide(c, deny('assets-mcp'), 'object:write', at), 'Verbot für den MCP-Dienst wirkt');
    assert.ok(acc.decide(c, only('import'), 'object:write', at), 'Beschränkung auf den Client lässt ihn durch');
    assert.ok(!acc.decide(p(['editor'], { kind: 'client', clientId: 'assets-mcp', grantId: 'export', scopes: ['assets:read', 'objects:write'] }), only('import'), 'object:write', at), 'anderer Client nicht');
  });

  test('Freigabe gibt das Recht auf der Ressource und darunter, nicht daneben', () => {
    const a = acl([{ resource_type: 'type', resource_id: 'laptop', principal_type: 'user', principal_ref: 'p1', permission: 'object:write', effect: 'grant' }]);
    assert.ok(acc.decide(p(['viewer']), a, 'object:write', { type: 'object', id: 'o' }, 'notebook'), 'Untertyp erbt');
    assert.ok(!acc.decide(p(['viewer']), a, 'object:write'), 'nicht auf Mandantenebene');
    assert.ok(!acc.decide(p(['viewer']), a, 'object:write', { type: 'schema', id: 's1' }), 'nicht auf dem Schema darüber');
    assert.ok(!acc.decide(p(['viewer'], { principalId: 'p2', subject: 's2' }), a, 'object:write', { type: 'type', id: 'laptop' }), 'andere Person');
    assert.ok(acc.somewhere(p(['viewer']), a, 'object:write'));
    assert.ok(!acc.somewhere(p(['viewer']), a, 'object:delete'));
  });

  test('Freigabe: Verbote und Beschränkungen gelten auch für sie, Clients brauchen den Scope', () => {
    const grant = { resource_type: 'schema', resource_id: 's1', principal_type: 'role', principal_ref: 'viewer', permission: 'object:write', effect: 'grant' };
    const denied = acl([grant, { resource_type: 'type', resource_id: 'notebook', principal_type: 'role', principal_ref: 'viewer', permission: 'object:write', effect: 'deny' }]);
    assert.ok(acc.decide(p(['viewer']), denied, 'object:write', { type: 'type', id: 'laptop' }));
    assert.ok(!acc.decide(p(['viewer']), denied, 'object:write', { type: 'type', id: 'notebook' }));
    const restricted = acl([grant, { resource_type: 'schema', resource_id: 's1', principal_type: 'group', principal_ref: '/it', permission: 'object:write', effect: 'restrict' }]);
    assert.ok(!acc.decide(p(['viewer']), restricted, 'object:write', { type: 'type', id: 'laptop' }));
    assert.ok(acc.decide(p(['viewer'], { groups: ['/it'] }), restricted, 'object:write', { type: 'type', id: 'laptop' }));
    assert.ok(!acc.somewhere(p(['viewer']), restricted, 'object:write'), 'unwirksame Freigabe zählt nicht');
    const a = acl([grant]);
    assert.ok(!acc.decide(p(['viewer'], { kind: 'client', scopes: ['assets:read'] }), a, 'object:write', { type: 'type', id: 'laptop' }));
    assert.ok(acc.decide(p(['viewer'], { kind: 'client', scopes: ['assets:read', 'objects:write'] }), a, 'object:write', { type: 'type', id: 'laptop' }));
  });

  test('Clients: Rolle ohne Scope reicht nicht', () => {
    const c = p(['editor'], { kind: 'client', scopes: ['assets:read'] });
    assert.ok(acc.decide(c, acl([]), 'object:read'));
    assert.ok(!acc.decide(c, acl([]), 'object:write'));
  });

  test('eine Stufe allein (stepAllows): Verbot auf dem Objekt, Ausnahme für org-admin', () => {
    const a = acl([{ resource_type: 'object', resource_id: 'o1', principal_type: 'role', principal_ref: 'viewer', permission: 'object:read', effect: 'deny' }]);
    assert.ok(!acc.stepAllows(p(['viewer']), a, 'object:read', { type: 'object', id: 'o1' }));
    assert.ok(acc.stepAllows(p(['viewer']), a, 'object:read', { type: 'object', id: 'o2' }));
    assert.ok(acc.stepAllows(p(['org-admin']), a, 'object:read', { type: 'object', id: 'o1' }));
  });

  test('Fähigkeiten aus dem Katalog; Schema für OpenAPI wie Assets', () => {
    const a = acl([{ resource_type: 'schema', resource_id: 's1', principal_type: 'role', principal_ref: 'editor', permission: 'object:write', effect: 'deny' }]);
    assert.deepEqual(capabilities(acc, p(['editor']), a, 'object', 'o1', 'laptop'), { write: false, delete: true });
    assert.deepEqual(capabilities(acc, p(['editor']), a, 'object', 'o1', null), { write: true, delete: true });
    assert.deepEqual(canSchema(assetsCatalog, 'connection').required, ['write', 'sync', 'editMapping', 'activateMapping']);
    assert.equal((canSchema(assetsCatalog, 'credential').properties as Record<string, { description: string }>).use!.description, 'Recht «credential:use» auf dieser Ressource');
  });
});

describe('Zugriffsregeln aus PostgreSQL (Notiz-App, Kette Ordner → Notiz)', { skip }, () => {
  const app = migration('001_notes.sql', `
    CREATE TABLE notes.folder (tenant_id uuid NOT NULL REFERENCES notes.tenant(id), id uuid NOT NULL DEFAULT gen_random_uuid(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, id));
    CREATE TABLE notes.note (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), folder_id uuid NOT NULL, PRIMARY KEY (tenant_id, id), FOREIGN KEY (tenant_id, folder_id) REFERENCES notes.folder (tenant_id, id));
    -- Lesesicht der App: verborgen, ausser mit voller Lesesicht (wie Assets app.read_all)
    CREATE POLICY hidden ON notes.note AS RESTRICTIVE FOR SELECT TO notes_app USING (current_setting('app.read_all', true) = 'on');`);
  const db = productDb({ resourceTypes: ['tenant', 'folder', 'note'], leafTypes: ['note'], sources: [{ name: 'app', migrations: [app] }] });
  const seen: string[] = [];
  const resources: ResourceModel<string> = {
    fullContext: { 'app.read_all': 'on' },
    version: async tx => (await tx.query("SELECT coalesce(max(updated_at)::text, '') AS v FROM notes.folder")).rows[0].v,
    load: async tx => { const r = (await tx.query("SELECT current_setting('app.read_all', true) AS r, (SELECT count(*) FROM notes.note)::text AS n")).rows[0]; seen.push(`${r.r}:${r.n}`); return r.n; },
    chain: (_s, ref, folder) => (ref.type === 'note' ? [{ type: 'tenant' }, ...(folder ? [{ type: 'folder', id: folder }] : []), ref] : ref.type === 'folder' ? [{ type: 'tenant' }, ref] : [{ type: 'tenant' }]),
    exists: async (tx, ref) => ((await tx.query(`SELECT 1 FROM notes.${ref.type === 'note' ? 'note' : 'folder'} WHERE id = $1`, [ref.id])).rowCount ?? 0) > 0,
  };
  let t: Awaited<ReturnType<typeof db.create>>;
  let access: AccessService<string, string>;
  let A: string, folder: string;
  const person = (roles: string[], extra: Partial<Principal> = {}) => p(roles, { tenantId: A, principalId: '00000000-0000-4000-8000-000000000001', subject: 'u1', ...extra });
  const insertAcl = (perm: string, effect: string, type = 'tenant', id: string | null = null, ref = 'viewer', kind = 'role') => withTenant(t.runtime, { tenantId: A }, tx =>
    tx.query('INSERT INTO notes.acl_entry (tenant_id, resource_type, resource_id, principal_type, principal_ref, permission, effect) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id', [A, type, id, kind, ref, perm, effect]));

  before(async () => {
    t = await db.create();
    access = new AccessService(t.runtime, { catalog: notesCatalog, schema: 'notes', resources });
    A = (await t.runtime.query<{ id: string }>("SELECT app.resolve_tenant('alpha', null, 'alpha', true) AS id")).rows[0]!.id;
    folder = await withTenant(t.runtime, { tenantId: A }, async tx => {
      const f = (await tx.query('INSERT INTO notes.folder (tenant_id) VALUES ($1) RETURNING id', [A])).rows[0].id;
      await tx.query('INSERT INTO notes.note (tenant_id, folder_id) VALUES ($1, $2)', [A, f]);
      return f;
    });
  });
  after(async () => { await t?.drop(); });

  test('Laden im Mandantenkontext mit voller Lesesicht der App (fullContext); Zwischenspeicher bis zur Änderung', async () => {
    const a = await access.load(A);
    assert.equal(a.state, '1', 'verborgene Notiz mitgezählt');
    assert.deepEqual(seen, ['on:1']);
    assert.match(a.version, /^1:\d{4}-/);
    assert.equal(await access.load(A), a, 'unverändert: aus dem Zwischenspeicher');
    await insertAcl('note:write', 'deny', 'folder', folder, 'editor');
    const b = await access.load(A);
    assert.notEqual(b, a);
    assert.equal(b.entries.length, 1);
    assert.match(b.version, /^2:/, 'Trigger erhöht acl_version');
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query("UPDATE notes.folder SET updated_at = now() + interval '1 second'"));
    assert.notEqual(await access.load(A), b, 'Version des Ressourcen-Modells');
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query("INSERT INTO notes.tenant_role (tenant_id, key, label, permissions) VALUES ($1, 'c-leser', 'Leser', '{note:read,members:admin}')", [A]));
    const c = await access.load(A);
    assert.deepEqual(c.roles.get('c-leser'), ['note:read', 'members:admin']);
    assert.ok(await access.can(person(['c-leser']), 'note:read'));
    assert.ok(!(await access.can(person(['c-leser']), 'members:admin')), 'eigene Rolle nie mit Rechten nur von org-admin');
    access.invalidate(A);
    assert.notEqual(await access.load(A), c);
  });

  test('Kette der App: Verbot auf dem Ordner gilt für Notizen darin; 403-Text mit Label und Ressource', async () => {
    const editor = person(['editor']);
    assert.ok(!(await access.can(editor, 'note:write', { type: 'note', id: 'n1' }, folder)));
    assert.ok(await access.can(editor, 'note:write', { type: 'note', id: 'n1' }, null));
    await assert.rejects(access.require(editor, 'note:write', { type: 'folder', id: folder }), (e: { status: number; detail: string }) => e.status === 403 && e.detail === `Dir fehlt das Recht «Notizen ändern» (note:write) für folder ${folder}.`);
    await assert.rejects(access.require(person(['viewer']), 'note:write'), (e: { detail: string }) => e.detail === 'Dir fehlt das Recht «Notizen ändern» (note:write).');
    const can = await capabilitiesFor(access, editor);
    assert.deepEqual([can('note', 'n1', folder), can('note', 'n1')], [{ write: false }, { write: true }]);
  });

  test('effective, granted, somewhere: Rechte auf Mandantenebene und nur über Freigaben', async () => {
    const viewer = person(['viewer']);
    await insertAcl('note:write', 'grant', 'folder', folder, '00000000-0000-4000-8000-000000000001', 'user');
    assert.deepEqual(await access.effective(viewer), ['tenant:read', 'note:read']);
    assert.deepEqual(await access.granted(viewer), ['note:write']);
    assert.ok(await access.canSomewhere(viewer, 'note:write'));
    await access.requireSomewhere(viewer, 'note:write');
    await assert.rejects(access.requireSomewhere(viewer, 'acl:admin'), /Zugriff verwalten/);
    assert.deepEqual(await access.effective(person(['org-admin'])), notesCatalog.permissions);
  });

  test('Zugriffsstand für ETags: Version, Identität, Rollen, Gruppen, Scopes', async () => {
    const base = await access.accessTag(person(['viewer']));
    assert.match(base, /^[\w-]{10}$/);
    assert.equal(await access.accessTag(person(['viewer'])), base);
    for (const other of [person(['viewer'], { principalId: 'x' }), person(['viewer'], { groups: ['/g'] }), person(['editor']), person(['viewer'], { scopes: ['notes:read'] }), person(['viewer'], { scopeBound: true })]) {
      assert.notEqual(await access.accessTag(other), base);
    }
    await insertAcl('note:read', 'deny', 'tenant', null, 'nobody');
    assert.notEqual(await access.accessTag(person(['viewer'])), base, 'neue Zugriffsregel');
  });
});
