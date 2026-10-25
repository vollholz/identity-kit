/**
 * Modell der App (Spezifikation Kap. 7.3, 8; Pflichttest `model` in Kap. 14): `defineModel` mit den Regeln M1–M13,
 * reservierte Namen (8.1), Katalog nach 9.5 (besteht `checkModel` des Test-Kits), `platform.json` nur Scopes (O4), CHECKs
 * von `authz_tuple` über `syncModelChecks` (Tupel mit entfernten Relationen lassen den Abgleich scheitern, 8.2).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { checkModel } from '@vollholz/iam-testkit';
import { iamMigrations, migrate, modelChecks } from '../src/migrations.ts';
import { defineModel, ModelError, type ModelInput } from '../src/model.ts';
import { productDb, skipDb } from './support/db.ts';
import { full, grant, tenant } from './support/http.ts';
import { notesInput, notesModel, orgLimitedModel, simpleModel } from './support/models.ts';

const skip = await skipDb();

/** Befunde von defineModel (leer = gültig). */
function errorsOf(change: (m: any) => void): string[] {
  const input = structuredClone(notesInput()) as any;
  change(input);
  try { defineModel(input as ModelInput); return []; } catch (e) { assert.ok(e instanceof ModelError); return e.errors; }
}

/** Grosses Modell (Konzept 5.1): Schema → Typ (self) → Objekt (Blatt, Klassifizierung, Zuständigkeit), Ansichten mit Besitz. */
const inventory = () => defineModel({
  product: 'inventar',
  permissions: {
    'object:read': { label: 'Objekte lesen', group: 'catalog', description: 'Objekte sehen.', resources: ['org', 'schema', 'type', 'object'] },
    'object:write': { label: 'Objekte ändern', group: 'catalog', description: 'Objekte ändern.', resources: ['org', 'schema', 'type', 'object'] },
    'schema:admin': { label: 'Schemas verwalten', group: 'catalog', description: 'Schemas ändern.', resources: ['org', 'schema'] },
    'view:read': { label: 'Ansichten lesen', group: 'views', description: 'Ansichten sehen.', resources: ['org', 'view'] },
    'view:write': { label: 'Ansichten ändern', group: 'views', description: 'Ansichten ändern.', resources: ['org', 'view'] },
    'access:admin': { resources: ['org', 'schema', 'type', 'object', 'view'] },
  },
  groups: [{ key: 'catalog', label: 'Objektkatalog', match: /objekt|schema/ }, { key: 'views', label: 'Ansichten', match: 'ansicht' }],
  roles: {
    'schema-admin': { label: 'Schema-Admin', description: 'Verwaltet Schemas und Objekte, gibt Zugriff; Organisation lesen.', permissions: ['tenant:read', 'object:read', 'object:write', 'schema:admin', 'access:admin'] },
    editor: { label: 'Bearbeiter:in', description: 'Ändert Objekte und Ansichten, gibt Zugriff; Organisation lesen.', permissions: ['tenant:read', 'object:read', 'object:write', 'view:read', 'view:write', 'access:admin'] },
    viewer: { label: 'Leser:in', description: 'Liest Objekte und Ansichten; Organisation lesen.', permissions: ['tenant:read', 'object:read', 'view:read'] },
  },
  scopes: { 'inventar:read': { text: 'Lesen', permissions: ['tenant:read', 'object:read', 'view:read'] } },
  types: {
    schema: { label: 'Schema', parent: 'org', roles: ['schema-admin', 'editor', 'viewer'], read: 'object:read' },
    type: { label: 'Objekttyp', parent: 'schema', self: 'type', roles: ['editor', 'viewer'], read: 'object:read' },
    object: { label: 'Objekt', parent: 'type', roles: ['editor', 'viewer'], relations: ['member'], leaf: true, classified: true, scope: { via: 'reference', relation: 'gehört zu' }, read: 'object:read', write: 'object:write' },
    view: { label: 'Ansicht', parent: 'org', roles: ['editor', 'viewer'], owner: true, read: 'view:read', write: 'view:write' },
  },
  features: { audit: true, tenantSettings: true },
});

describe('defineModel', () => {
  test('Inventar und Notizen: gültig, besteht checkModel; Reserviertes ergänzt, org-admin zuerst mit allen Rechten', () => {
    const a = inventory();
    assert.deepEqual(checkModel(a.toJSON(), { product: 'inventar', platformJson: a.platformJson() }), { errors: [], warnings: [] });
    assert.deepEqual(checkModel(notesModel.toJSON(), { product: 'notes', platformJson: notesModel.platformJson() }), { errors: [], warnings: [] });
    assert.deepEqual(checkModel(simpleModel.toJSON()).errors, []);
    assert.deepEqual(a.permissions.slice(0, 2), ['tenant:read', 'tenant:admin']);
    assert.deepEqual(a.permissions.slice(-2), ['members:admin', 'audit:read']);
    assert.deepEqual([...a.roles.keys()][0], 'org-admin');
    assert.equal(a.roles.get('org-admin')!.permissions.length, a.permissions.length);
    assert.deepEqual(a.groups.map(g => g.key), ['tenant', 'catalog', 'views', 'members', 'access', 'audit']);
    assert.deepEqual([...a.types.keys()], ['org', 'schema', 'type', 'object', 'view']);
    assert.equal(a.leaf?.key, 'object');
    assert.deepEqual(a.relationsAt('object'), ['editor', 'viewer', 'member']);
    assert.deepEqual(a.relationsAt('view'), ['editor', 'viewer', 'owner']);
    assert.deepEqual(a.relationsAt('org'), ['org-admin', 'schema-admin', 'editor', 'viewer']);
    assert.deepEqual([...a.permissionsOf('owner', 'view')], ['view:read', 'view:write', 'access:admin']);
    assert.deepEqual(a.rolesWith('object:write'), ['org-admin', 'schema-admin', 'editor']);
    assert.deepEqual([...a.adminOnly].sort(), ['audit:read', 'members:admin', 'tenant:admin']);
    // Stufe «einfach»: ohne Orte kein access:admin
    assert.ok(!simpleModel.isPermission('access:admin'));
    assert.deepEqual([...simpleModel.types.keys()], ['org']);
  });

  test('GET /v1/authz/catalog nach 9.5: Typen, Stufen, Rollen mit adminOnly nur bei org-admin', () => {
    const j = notesModel.toJSON();
    assert.deepEqual(j.types.find(t => t.key === 'note'), {
      key: 'note', label: 'Notiz', parent: 'folder', roles: ['editor', 'viewer'], relations: ['editor', 'viewer'], leaf: true, classified: true, scope: { relation: 'gehört zu' }, read: 'note:read', write: 'note:write',
    });
    assert.deepEqual(j.types[0], { key: 'org', label: 'Organisation', parent: null, roles: ['org-admin', 'editor', 'viewer'], relations: ['org-admin', 'editor', 'viewer'], read: 'tenant:read' });
    assert.deepEqual(j.classifications, [{ level: 0, label: 'intern' }, { level: 1, label: 'vertraulich' }, { level: 2, label: 'streng vertraulich' }]);
    assert.deepEqual(j.roles.map(r => [r.key, r.adminOnly]), [['org-admin', true], ['editor', false], ['viewer', false]]);
    assert.deepEqual(j.permissions.filter(p => p.personOnly).map(p => p.key), ['note:share', 'access:admin', 'members:admin']);
  });

  test('membersRole (D10): Standard viewer bei owner-Typen, eigene Rolle im Katalog, sonst nichts', () => {
    const mr = (x: { types: ReadonlyMap<any, { membersRole: string | null }> }) => ({ get: (k: string) => x.types.get(k)!.membersRole });
    const viewType = (j: ReturnType<typeof notesModel.toJSON>) => j.types.find(t => t.key === 'view')!;
    assert.equal(viewType(notesModel.toJSON()).membersRole, 'viewer');
    assert.equal(mr(notesModel).get('view'), 'viewer');
    assert.equal(mr(notesModel).get('folder'), null, 'ohne owner kein Schalter');
    const input = structuredClone(notesInput()) as any;
    input.roles['share-viewer'] = { label: 'Teilen (lesen)', description: 'Liest Ansichten.', permissions: ['view:read'] };
    input.types.view.roles = ['editor', 'share-viewer'];
    assert.equal(mr(defineModel(structuredClone(input))).get('view'), null, 'viewer nicht am Typ: kein Schalter');
    input.types.view.membersRole = 'share-viewer';
    const m = defineModel(input as ModelInput);
    assert.equal(mr(m).get('view'), 'share-viewer');
    assert.equal(viewType(m.toJSON()).membersRole, 'share-viewer');
    assert.deepEqual(checkModel(m.toJSON()).errors, []);
  });

  test('types.org.roles (Kit 1.3): Liste begrenzt die Rollen an org, org-admin wird ergänzt; ohne Angabe «*»', () => {
    const orgOf = (m: ReturnType<typeof defineModel>) => m.toJSON().types[0]!;
    assert.deepEqual(orgOf(orgLimitedModel).roles, ['org-admin', 'editor', 'viewer']);
    assert.deepEqual(orgOf(orgLimitedModel).relations, ['org-admin', 'editor', 'viewer']);
    assert.deepEqual(orgLimitedModel.relationsAt('org'), ['org-admin', 'editor', 'viewer']);
    assert.ok(orgLimitedModel.relationsAt('folder').includes('sharer'));
    assert.deepEqual(orgOf(notesModel).roles, ['org-admin', 'editor', 'viewer'], 'Standard: alle Rollen');
    assert.deepEqual(checkModel(orgLimitedModel.toJSON()).errors, []);
    const input = structuredClone(notesInput()) as any;
    input.types.org = { label: 'Organisation', roles: ['org-admin', 'viewer'] };
    assert.deepEqual(orgOf(defineModel(input)).roles, ['org-admin', 'viewer']);
    input.types.org = { label: 'Organisation', roles: '*' };
    assert.deepEqual(orgOf(defineModel(input)).roles, ['org-admin', 'editor', 'viewer']);
  });

  test('platform.json nur Scopes (O4)', () => {
    assert.equal(notesModel.platformJson(), `${JSON.stringify({ scopes: ['notes:read', 'notes:write'] }, null, 2)}\n`);
  });

  const cases: [string, (m: any) => void, RegExp][] = [
    ['M1 Schlüssel eines Rechts', m => { m.permissions['Note:Read'] = { label: 'x', group: 'notes', description: 'x' }; }, /M1/],
    ['M1 reserviertes Recht mit falschem Label', m => { m.permissions['tenant:read'] = { label: 'Lesen', group: 'tenant' }; }, /Recht «tenant:read»: Label «Lesen»/],
    ['M1 acl:read entfällt', m => { m.permissions['acl:read'] = { label: 'Zugriff lesen', group: 'access', description: 'x' }; }, /acl:read» entfällt/],
    ['M1 Rolle member', m => { m.roles.member = { label: 'M', description: 'Notizen', permissions: ['note:read'] }; }, /Rolle «member»: reservierter Name/],
    ['M2 Gruppe fehlt', m => { m.permissions['note:read'].group = 'nix'; }, /M2/],
    ['M2 resources ohne org', m => { m.permissions['note:read'].resources = ['note']; }, /resources ohne «org»/],
    ['M2 resources mit fremdem Typ', m => { m.permissions['note:read'].resources = ['org', 'nix']; }, /Typ «nix» in resources/],
    ['M3 Rolle ohne Rechte', m => { m.roles.viewer.permissions = []; }, /Rolle «viewer»: ohne Rechte/],
    ['M3 Beschreibung nennt Gruppe nicht', m => { m.roles.viewer.description = 'Liest.'; }, /nennt die Rechtegruppe «notes» nicht/],
    ['M3 «*» nur bei org-admin', m => { m.roles.viewer.permissions = '*'; }, /«\*» nur bei org-admin/],
    ['M3 org-admin mit Liste', m => { m.roles['org-admin'] = { label: 'Organisations-Admin', description: 'Alles: Notizen, Teams, Ansichten, Zugriff, Mitglieder.', permissions: ['tenant:read'] }; }, /permissions muss «\*» sein/],
    ['M4 parent fehlt', m => { delete m.types.folder.parent; }, /Typ «folder»: parent fehlt/],
    ['M4 Kreis', m => { m.types.folder.parent = 'view'; m.types.view.parent = 'folder'; }, /Kreis/],
    ['M4 self fremd', m => { m.types.folder.self = 'note'; }, /self nur gleich/],
    ['M5 org-admin am Ort', m => { m.types.folder.roles = ['org-admin']; }, /org-admin nur an org/],
    ['M5 org: unbekannte Rolle', m => { m.types.org = { label: 'Organisation', roles: ['viewer', 'nix'] }; }, /Typ «org»: Rolle «nix» nicht im Modell \(M5\)/],
    ['M5 org: Rolle doppelt', m => { m.types.org = { label: 'Organisation', roles: ['viewer', 'viewer'] }; }, /Typ «org»: roles mit doppelten Rollen \(M5\)/],
    ['M5 org: weder «*» noch Liste', m => { m.types.org = { label: 'Organisation', roles: 'viewer' }; }, /Typ «org»: roles ist «\*» oder eine Liste/],
    ['M5 «*» am Ort', m => { m.types.folder.roles = '*'; }, /roles «\*» nur bei org/],
    ['M6 zwei Blätter', m => { m.types.view.leaf = true; m.types.view.write = 'view:write'; }, /Höchstens ein Blatt-Typ/],
    ['M6 Blatt als parent', m => { m.types.sub = { label: 'Sub', parent: 'note', roles: [], read: 'note:read' }; m.permissions['note:read'].resources.push('sub'); }, /Blatt, aber Typ «sub»/],
    ['M7 read fehlt', m => { delete m.types.view.read; }, /Typ «view»: read fehlt/],
    ['M7 write fehlt am Blatt', m => { delete m.types.note.write; }, /Typ «note»: write fehlt/],
    ['M7 read ohne Typ in resources', m => { m.types.view.read = 'note:read'; }, /read «note:read» hat «view» nicht in resources/],
    ['M8 andere Beziehung', m => { m.types.team.relations = ['boss']; }, /Beziehung «boss» nicht zulässig/],
    ['M9 owner an org', m => { m.types.org = { label: 'Organisation', roles: '*', owner: true }; }, /owner nicht erlaubt \(M9\)/],
    ['M13 membersRole nicht am Typ', m => { m.types.view.membersRole = 'schema-admin'; }, /membersRole «schema-admin» ist am Typ nicht zulässig \(M13\)/],
    ['M13 membersRole mit Rechten nur von org-admin', m => { m.types.view.membersRole = 'org-admin'; }, /membersRole «org-admin» ist am Typ nicht zulässig \(M13\)/],
    ['M13 membersRole ohne owner', m => { m.types.folder.membersRole = 'viewer'; }, /membersRole nur bei Typen mit owner \(M13\)/],
    ['M13 membersRole an org', m => { m.types.org = { label: 'Organisation', roles: '*', membersRole: 'viewer' }; }, /membersRole nicht erlaubt \(M13\)/],
    ['M10 access:admin im Scope', m => { m.scopes['notes:write'].permissions.push('access:admin'); }, /enthält «access:admin»/],
    ['M10 scope:false im Scope', m => { m.scopes['notes:write'].permissions.push('note:share'); }, /enthält «note:share»/],
    ['M11 Fähigkeit mit fremdem Typ', m => { m.capabilities.nix = { a: 'note:read' }; }, /Fähigkeiten: Typ «nix»/],
    ['M11 MCP ohne Titel', m => { m.mcpTools = { x: { title: '', permission: 'note:read', readOnly: true } }; }, /MCP-Werkzeug «x»: Titel fehlt/],
    ['M12 Stufen', m => { m.classifications = ['a', '', 'c']; }, /M12/],
  ];
  for (const [name, change, want] of cases) test(name, () => assert.match(errorsOf(change).join('\n'), want));

  test('alle Befunde auf einmal', () => {
    const errs = errorsOf(m => { m.roles.viewer.permissions = []; delete m.types.view.read; });
    assert.equal(errs.length, 2);
  });
});

describe('syncModelChecks', { skip }, () => {
  const dbs = productDb({ model: notesModel });
  let t: Awaited<ReturnType<typeof dbs.create>>;
  before(async () => { t = await dbs.create(); });
  after(async () => { await t?.drop(); });

  test('CHECKs aus dem Modell; neue Rolle ohne Migration; entfernte Rolle mit Tupeln bricht ab', async () => {
    const defs = async () => new Map((await t.inspect.query<{ n: string; d: string }>("SELECT conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'notes.authz_tuple'::regclass AND conname LIKE 'authz_tuple_%_check'")).rows.map(r => [r.n, r.d]));
    const want = modelChecks({ types: [...notesModel.types.keys()], relations: notesModel.allRelations() });
    assert.equal((await defs()).get('authz_tuple_relation_check'), want.authz_tuple_relation_check!.def);
    assert.equal((await defs()).get('authz_tuple_object_type_check'), want.authz_tuple_object_type_check!.def);
    const A = await tenant(t.runtime, 'acme');
    await assert.rejects(grant(t.runtime, A, 'org:members', 'boss'), /authz_tuple_relation_check/);
    await grant(t.runtime, A, 'org:members', 'viewer', { type: 'folder', id: '00000000-0000-4000-8000-000000000001' });
    // Zweiter Lauf: unverändert, nichts geändert
    const lines: string[] = [];
    await migrate(t.adminUrl, [iamMigrations({ product: 'notes', model: notesModel })], m => lines.push(m));
    assert.ok(!lines.some(l => l.includes('Bedingung')), lines.join('\n'));
    // Neue Rolle: angepasst ohne Migration
    const more = { types: [...notesModel.types.keys()], relations: [...notesModel.allRelations(), 'reviewer'] };
    lines.length = 0;
    await migrate(t.adminUrl, [iamMigrations({ product: 'notes', model: more })], m => lines.push(m));
    assert.ok(lines.some(l => l.includes('authz_tuple_relation_check')));
    // Rolle viewer entfernt, aber Tupel vorhanden: Abbruch mit Hinweis, nichts geändert
    await assert.rejects(migrate(t.adminUrl, [iamMigrations({ product: 'notes', model: { types: more.types, relations: more.relations.filter(r => r !== 'viewer') } })]), /Tupel mit entfernten Relationen oder Typen zuerst löschen/);
    await full(t.runtime, A, tx => tx.query("DELETE FROM notes.authz_tuple WHERE relation = 'viewer'"));
    await migrate(t.adminUrl, [iamMigrations({ product: 'notes', model: notesModel })]);
  });
});
