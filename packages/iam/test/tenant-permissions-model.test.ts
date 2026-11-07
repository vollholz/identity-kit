/**
 * Haken «Rechte je Organisation» im Modell (`withPermissions`): eingeschränkte Rechte fehlen in Rechten, Rollen (auch
 * eigenen), Scopes, owner, MCP-Werkzeugen, Katalog und Entscheidung; reservierte Rechte bleiben; Zusammenspiel mit
 * `withRoles`; `null` hebt die Einschränkung auf. Das frühere Modulkonzept des Modells bricht mit Hinweis ab.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AccessService, subjectsOf, type TenantAccess, type Tuple } from '../src/access.ts';
import { defineModel, ModelError, type Model } from '../src/model.ts';
import type { Principal } from '../src/principal.ts';
import { notesInput, notesModel } from './support/models.ts';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Rechte je Organisation: Modell (withPermissions)', () => {
  const m = defineModel({
    ...notesInput(),
    mcpTools: {
      notes_list: { title: 'Notizen auflisten', permission: 'note:read', readOnly: true },
      views_list: { title: 'Ansichten auflisten', permission: 'view:read', readOnly: true },
    },
  } as never) as unknown as Model;
  const org = m.withPermissions(['note:read', 'note:write', 'team:read', 'gibt:es-nicht']);

  test('Modell der App: keine Einschränkung', () => {
    assert.equal(m.allowedPermissions, null);
    assert.equal(notesModel.withPermissions(null), notesModel, 'null auf dem Modell der App: das Modell selbst');
  });

  test('übrige Rechte fehlen in permissions, Rollen, Scopes, owner und MCP-Werkzeugen; reservierte bleiben; Rollen bleiben', () => {
    assert.deepEqual([...org.allowedPermissions!].sort(), ['note:read', 'note:write', 'team:read'], 'unbekannte Rechte zählen nicht');
    assert.ok(!org.isPermission('view:read') && !org.isPermission('note:share'));
    assert.ok(org.isPermission('note:read') && org.isPermission('tenant:read') && org.isPermission('access:admin') && org.isPermission('members:admin'), 'reservierte Rechte bleiben');
    assert.deepEqual([...org.permissionsForRoles(['viewer'])], ['tenant:read', 'note:read', 'team:read']);
    assert.ok(![...org.permissionsForRoles(['org-admin'])].some(p => p.startsWith('view:') || p === 'note:share'));
    assert.ok([...org.permissionsForRoles(['org-admin'])].includes('members:admin'));
    assert.deepEqual([...org.permissionsForScopes(['notes:read', 'notes:write'])], ['tenant:read', 'note:read', 'team:read', 'note:write']);
    assert.deepEqual([...org.permissionsOf('owner', 'view')], ['access:admin']);
    assert.deepEqual(Object.keys(org.mcpTools), ['notes_list']);
    assert.ok(org.roles.has('editor') && org.roles.has('viewer'), 'Rollen bleiben zuweisbar');
    assert.equal(org.base, m);
    assert.ok(org.info.has('view:read' as never), 'Texte für Meldungen bleiben');
  });

  test('Katalog der Organisation: nur die gelassenen Rechte', () => {
    const cat = org.toJSON();
    assert.ok(!cat.permissions.some(p => p.key.startsWith('view:') || p.key === 'note:share'));
    assert.ok(cat.permissions.some(p => p.key === 'tenant:read'));
    assert.ok(!cat.roles.some(r => r.permissions.some(p => p.startsWith('view:'))));
    assert.ok(!cat.scopes.some(s => s.permissions.some(p => p.startsWith('view:'))));
    assert.deepEqual(cat.mcpTools.map(t => t.name), ['notes_list']);
  });

  test('erneutes withPermissions ersetzt die Menge; null hebt sie auf', () => {
    const again = org.withPermissions(['view:read']);
    assert.ok(again.isPermission('view:read') && !again.isPermission('note:read'), 'vom ungefilterten Modell aus');
    const free = org.withPermissions(null);
    assert.equal(free.allowedPermissions, null);
    assert.deepEqual([...free.permissions], [...m.permissions]);
    assert.deepEqual(free.roles.get('editor')!.permissions, m.roles.get('editor')!.permissions);
  });

  test('mit eigenen Rollen: in beiden Reihenfolgen gefiltert', () => {
    const def = { key: 'c-mix', label: 'Mix', description: '', permissions: ['view:read', 'note:read'], places: ['org'] };
    assert.deepEqual(m.withRoles([def]).withPermissions(['note:read']).roles.get('c-mix')!.permissions, ['note:read']);
    const b = m.withPermissions(['note:read']).withRoles([def]);
    assert.deepEqual(b.roles.get('c-mix')!.permissions, ['note:read'], 'withRoles behält die Einschränkung');
    assert.ok(!b.isPermission('view:read'));
    assert.deepEqual(b.customRoleProblems(def), [], 'eigene Rollen prüfen gegen das Grundmodell');
  });

  test('Modulkonzept des Modells entfällt (iam 7): modules, packages, modul und features.modules brechen mit Hinweis ab', () => {
    const i = notesInput();
    const legacy = { ...i, permissions: { ...i.permissions, 'note:read': { ...i.permissions['note:read'], modul: 'notizen' } }, modules: [], packages: [], features: { modules: true } };
    assert.throws(() => defineModel(legacy as never), (e: unknown) => {
      const errors = (e as ModelError).errors;
      return e instanceof ModelError && ['modules:', 'packages:', 'features.modules:', 'Recht «note:read»: modul'].every(x => errors.some(m => m.startsWith(x) && /tenantPermissions/.test(m)));
    });
  });

  test('Entscheidung: can, canSomewhere und Scope ∩ Rolle sind für ausgeschlossene Rechte false, auch für org-admin und owner', () => {
    const access = new AccessService(null as never, { model: m, schema: 'notes' });
    const base: Principal = { tenantId: 't', tenantAlias: 'a', principalId: U(1), kind: 'user', subject: 's', name: 'n', email: null, clientId: null, groups: [], subjects: [], scopes: [], platformAdmin: false, binding: 'none', token: '' };
    const p = { ...base, subjects: subjectsOf(base) };
    const tuples: Tuple[] = [
      { id: U(901), subject: `user:${U(1)}`, relation: 'org-admin', object_type: 'org', object_id: null, expires_at: null, created_at: new Date(), created_by: null },
      { id: U(902), subject: `user:${U(1)}`, relation: 'owner', object_type: 'view', object_id: U(30), expires_at: null, created_at: new Date(), created_by: null },
    ];
    const acl = (model: Model): TenantAccess => ({ version: '1', model, roles: [], tuples, byPlace: new Map([['org:', [tuples[0]!]], [`view:${U(30)}`, [tuples[1]!]]]), clearances: new Map(), state: null });
    const on = acl(m), off = acl(org);
    assert.equal(access.decide(p, on, 'view:read'), true);
    assert.equal(access.decide(p, off, 'view:read'), false, 'org-admin hat ausgeschlossene Rechte nicht');
    assert.equal(access.decide(p, off, 'view:write', { type: 'view', id: U(30) }), false, 'owner auch nicht');
    assert.equal(access.decide(p, off, 'note:read'), true);
    assert.equal(access.decide(p, off, 'members:admin'), true, 'reservierte Rechte bleiben');
    assert.equal(access.somewhere(p, off, 'view:read'), false);
    assert.ok(!access.orgPermissions(p, off).includes('view:read'));
    assert.ok(!access.somewherePermissions(p, off).includes('view:read'));
    const client = { ...p, kind: 'client' as const, subjects: [`client:${U(1)}`], scopes: ['notes:read'] };
    assert.equal(access.scopeAllows(client, 'view:read'), true, 'Scope der App deckt es');
    assert.equal(access.decide(client, off, 'view:read'), false, 'im Modell der Organisation nicht');
  });
});
