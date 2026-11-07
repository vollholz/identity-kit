/**
 * Produktmodule im Modell (Konzept «Module je Organisation», Abschnitte 2, 4, 11): Prüfungen von `defineModel`,
 * `withModules` (Rechte inaktiver Module fehlen in Rechten, Rollen, Scopes, owner, MCP-Werkzeugen, Katalog und
 * Entscheidung), Zusammenspiel mit eigenen Rollen und das Modell ohne `modules` (stiller Kern, unverändert).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AccessService, subjectsOf, type TenantAccess, type Tuple } from '../src/access.ts';
import { defineModel, ModelError, type Model } from '../src/model.ts';
import { activeModules, moduleStates, type ModuleRow } from '../src/modules.ts';
import type { Principal } from '../src/principal.ts';
import { modulesInput, modulesModel, notesInput, notesModel } from './support/models.ts';

const errorsOf = (f: () => unknown): string[] => {
  try { f(); } catch (e) { if (e instanceof ModelError) return e.errors; throw e; }
  return [];
};
const define = (patch: (i: ReturnType<typeof modulesInput>) => object) => () => defineModel(patch(modulesInput()) as never);
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Produktmodule: Verzeichnis im Modell', () => {
  test('gültiges Verzeichnis: Module, Teilfunktionen, Pakete, modul je Recht; tenant:admin mit modules', () => {
    const m = modulesModel;
    assert.equal(m.features.modules, true);
    assert.equal(m.features.tenantSettings, true, 'mit modules ist tenantSettings Standard');
    assert.ok(m.isPermission('tenant:admin'));
    assert.equal(m.coreModule, 'kern');
    assert.deepEqual(m.modules.map(x => x.key), ['kern', 'notizen', 'ansichten', 'teams']);
    assert.deepEqual(m.modules[1]!.parts, [{ key: 'notizen.teilen', label: 'Teilen', description: '' }]);
    assert.deepEqual(m.packages.map(p => [p.key, p.modules, p.off]), [['basis', ['kern', 'notizen'], ['notizen.teilen']], ['alles', ['kern', 'notizen', 'ansichten', 'teams'], []]]);
    assert.deepEqual([m.moduleOf('note:read'), m.moduleOf('note:share'), m.moduleOf('tenant:read'), m.moduleOf('unbekannt:x')], ['notizen', 'notizen.teilen', 'kern', 'kern']);
    assert.deepEqual([...m.activeModules], ['kern', 'notizen', 'notizen.teilen', 'ansichten', 'teams'], 'im Modell der App alles aktiv');
    const cat = m.toJSON();
    assert.equal(cat.permissions.find(p => p.key === 'view:read')!.modul, 'ansichten');
    assert.equal(cat.permissions.find(p => p.key === 'members:admin')!.modul, 'kern');
    assert.deepEqual(cat.modules.find(x => x.key === 'ansichten'), { key: 'ansichten', label: 'Ansichten', description: '', core: false, requires: ['notizen'], parts: [] });
    assert.deepEqual(cat.packages.map(p => p.key), ['basis', 'alles']);
    const explicit = defineModel({ ...modulesInput(), features: { audit: true, tenantSettings: false } } as never) as unknown as Model;
    assert.ok(!explicit.isPermission('tenant:admin'), 'ausdrücklich abgeschaltet bleibt es aus');
  });

  test('ohne modules: stiller Kern, alle Rechte darin, withModules ändert nichts, keine Pakete', () => {
    const m = notesModel as unknown as Model;
    assert.equal(m.features.modules, false);
    assert.equal(m.features.tenantSettings, false, 'Standard unverändert');
    assert.deepEqual(m.modules, [{ key: 'kern', label: 'Kern', description: '', core: true, requires: [], parts: [] }]);
    assert.deepEqual(m.packages, []);
    assert.ok(m.permissions.every(p => m.moduleOf(p) === 'kern'));
    assert.equal(m.withModules([]), m);
    assert.deepEqual([...m.activeModules], ['kern']);
    assert.deepEqual(m.toJSON().modules.map(x => x.key), ['kern']);
  });

  test('defineModel wirft: zwei Kerne, kein Kern, unbekannte Voraussetzung, Zyklus, Kern braucht etwas, Modul ohne Kern', () => {
    const two = errorsOf(define(i => ({ ...i, modules: [...i.modules, { key: 'basis', label: 'Basis', core: true }] })));
    assert.ok(two.some(e => /Genau ein Modul mit core: true \(gefunden: «kern», «basis»\)/.test(e)), two.join('\n'));
    assert.ok(errorsOf(define(i => ({ ...i, modules: i.modules.map(m => ({ ...m, core: undefined })) }))).some(e => /gefunden: keines/.test(e)));
    assert.ok(errorsOf(define(i => ({ ...i, modules: [...i.modules, { key: 'lohn', label: 'Lohn', requires: ['zeit'] }] }))).some(e => /Modul «lohn»: Voraussetzung «zeit» nicht im Modell/.test(e)));
    const cycle = errorsOf(define(i => ({ ...i, modules: [...i.modules, { key: 'a-mod', label: 'A', requires: ['kern', 'b-mod'] }, { key: 'b-mod', label: 'B', requires: ['a-mod'] }] })));
    assert.ok(cycle.some(e => /Voraussetzungen im Kreis \(a-mod → b-mod → a-mod\)/.test(e)), cycle.join('\n'));
    assert.ok(errorsOf(define(i => ({ ...i, modules: i.modules.map(m => (m.core ? { ...m, requires: ['teams'] } : m)) }))).some(e => /der Kern braucht nichts/.test(e)));
    assert.ok(errorsOf(define(i => ({ ...i, modules: [...i.modules, { key: 'insel', label: 'Insel' }] }))).some(e => /Modul «insel»: braucht den Kern «kern» nicht/.test(e)));
    // «eines von»: genügt, wenn jede Alternative den Kern braucht
    assert.deepEqual(errorsOf(define(i => ({ ...i, modules: [...i.modules, { key: 'pruefen', label: 'Prüfen', requires: [['ansichten', 'teams']] }] }))), []);
    assert.ok(errorsOf(define(i => ({ ...i, modules: [...i.modules, { key: 'x-mod', label: 'X', requires: [[]] }] }))).some(e => /requires mit leerer Liste/.test(e)));
  });

  test('defineModel wirft: Schlüssel, doppelte Module und Teilfunktionen, Teilfunktion mit requires, Labels', () => {
    const e = errorsOf(define(i => ({
      ...i, modules: [...i.modules, { key: 'Teams', label: '' }, { key: 'teams', label: 'Teams 2', requires: ['kern'] },
        { key: 'dok', label: 'Dok', requires: ['kern'], parts: [{ key: 'a1', label: 'A' }, { key: 'a1', label: 'A' }, { key: 'b1', label: 'B', requires: ['kern'] }] }],
    })));
    for (const re of [/Modul «Teams»: Schlüssel/, /Modul «Teams»: Label fehlt/, /Modul «teams» mehrfach/, /Teilfunktion «dok\.a1» mehrfach/, /Teilfunktion «dok\.b1»: Teilfunktionen haben keine eigenen requires/]) {
      assert.ok(e.some(x => re.test(x)), `${re}\n${e.join('\n')}`);
    }
  });

  test('defineModel wirft: Recht mit unbekanntem Modul oder Teilfunktion, reserviertes Recht mit Modul, modul ohne modules', () => {
    const e = errorsOf(define(i => ({ ...i, permissions: { ...i.permissions, 'team:read': { ...i.permissions['team:read'], modul: 'personal' }, 'note:write': { ...i.permissions['note:write'], modul: 'notizen.export' }, 'access:admin': { ...i.permissions['access:admin'], modul: 'teams' } } })));
    assert.ok(e.some(x => /Recht «team:read»: modul «personal» nicht im Modell/.test(x)), e.join('\n'));
    assert.ok(e.some(x => /Recht «note:write»: modul «notizen\.export» nicht im Modell/.test(x)));
    assert.ok(e.some(x => /Recht «access:admin»: reservierte Rechte gehören immer zum Kern/.test(x)));
    const i = notesInput();
    const no = errorsOf(() => defineModel({ ...i, permissions: { ...i.permissions, 'team:read': { ...i.permissions['team:read'], modul: 'teams' } } } as never));
    assert.ok(no.some(x => /modul «teams» ohne modules im Modell/.test(x)), no.join('\n'));
    assert.ok(errorsOf(() => defineModel({ ...i, packages: [{ key: 'p1', label: 'P', modules: '*' }] } as never)).some(x => /packages ohne modules/.test(x)));
  });

  test('defineModel wirft: Paket ohne Kern, mit unbekanntem Modul, unerfüllter Voraussetzung, falschem off, doppelt', () => {
    const e = errorsOf(define(i => ({
      ...i, packages: [
        { key: 'ohne', label: 'Ohne Kern', modules: ['notizen'] },
        { key: 'fremd', label: 'Fremd', modules: ['kern', 'lohn'] },
        { key: 'luecke', label: 'Lücke', modules: ['kern', 'ansichten'] },
        { key: 'aus', label: 'Aus', modules: ['kern', 'teams'], off: ['notizen.teilen', 'teams.x'] },
        { key: 'aus', label: 'Doppelt', modules: '*' },
      ],
    })));
    for (const re of [/Paket «ohne»: ohne den Kern «kern»/, /Paket «fremd»: Modul «lohn» nicht im Modell/, /Paket «luecke»: Modul «ansichten» braucht «notizen»/,
      /Paket «aus»: off «notizen\.teilen» gehört zu keinem Modul des Pakets/, /Paket «aus»: off «teams\.x» ist keine Teilfunktion/, /Paket «aus» mehrfach/]) {
      assert.ok(e.some(x => re.test(x)), `${re}\n${e.join('\n')}`);
    }
    const alt = errorsOf(define(i => ({ ...i, modules: [...i.modules, { key: 'pruefen', label: 'Prüfen', requires: [['ansichten', 'teams']] }], packages: [{ key: 'p1', label: 'P', modules: ['kern', 'pruefen'] }] })));
    assert.ok(alt.some(x => /Paket «p1»: Modul «pruefen» braucht eines von «ansichten», «teams»/.test(x)), alt.join('\n'));
  });
});

describe('Produktmodule: Modell der Organisation (withModules)', () => {
  const m = modulesModel;
  const org = m.withModules(['notizen', 'teams']);

  test('Rechte inaktiver Module fehlen in permissions, Rollen, Scopes, owner und MCP-Werkzeugen; Rollen bleiben', () => {
    assert.deepEqual([...org.activeModules], ['notizen', 'teams', 'kern']);
    assert.ok(!org.isPermission('view:read') && !org.isPermission('note:share'), 'Ansichten aus, Teilfunktion nicht in der Liste');
    assert.ok(org.isPermission('note:read') && org.isPermission('team:read') && org.isPermission('tenant:read'));
    assert.deepEqual([...org.permissionsForRoles(['viewer'])], ['tenant:read', 'note:read', 'team:read']);
    assert.ok(![...org.permissionsForRoles(['org-admin'])].some(p => p.startsWith('view:')));
    assert.deepEqual([...org.permissionsForScopes(['notes:read', 'notes:write'])], ['tenant:read', 'note:read', 'team:read', 'note:write']);
    assert.deepEqual([...org.permissionsOf('owner', 'view')], ['access:admin'], 'owner an Ansichten: nur noch Rechte des Kerns');
    assert.ok(org.roles.has('editor') && org.roles.has('viewer'), 'Rollen bleiben zuweisbar');
    assert.equal(org.base, m, 'Grundmodell bleibt das Modell der App');
    assert.ok(org.info.has('view:read' as never), 'Texte für Meldungen bleiben');
    assert.deepEqual(org.customRoleProblems({ key: 'c-ansicht', label: 'Ansicht', description: '', permissions: ['view:read'], places: ['org'] }), [], 'eigene Rollen prüfen gegen das Grundmodell');
  });

  test('Katalog der Organisation: nur Rechte aktiver Module, Verzeichnis vollständig', () => {
    const cat = org.toJSON();
    assert.ok(!cat.permissions.some(p => p.key.startsWith('view:') || p.key === 'note:share'));
    assert.ok(!cat.roles.some(r => r.permissions.some(p => p.startsWith('view:'))));
    assert.ok(!cat.scopes.some(s => s.permissions.some(p => p.startsWith('view:'))));
    assert.deepEqual(cat.modules.map(x => x.key), ['kern', 'notizen', 'ansichten', 'teams']);
  });

  test('Teilfunktion nur mit ihrem Modul; unbekannte Schlüssel zählen nicht; erneutes withModules ersetzt die Menge', () => {
    assert.ok(!m.withModules(['notizen.teilen']).isPermission('note:share'), 'Teilfunktion ohne Modul');
    assert.ok(m.withModules(['notizen', 'notizen.teilen']).isPermission('note:share'));
    assert.deepEqual([...m.withModules(['gibt-es-nicht']).activeModules], ['kern']);
    const again = org.withModules(['ansichten', 'notizen']);
    assert.ok(again.isPermission('view:read') && !again.isPermission('team:read'), 'vom ungefilterten Modell aus');
    assert.ok(again.roles.get('editor')!.permissions.includes('view:read' as never));
  });

  test('mit eigenen Rollen: withRoles(…).withModules(…) filtert auch eigene Rollen; withRoles auf gefiltertem Modell behält die Module', () => {
    const def = { key: 'c-mix', label: 'Mix', description: '', permissions: ['view:read', 'note:read'], places: ['org'] };
    const a = m.withRoles([def]).withModules(['notizen']);
    assert.deepEqual(a.roles.get('c-mix')!.permissions, ['note:read'], 'Recht des inaktiven Moduls fällt weg');
    assert.ok(a.customRoles.has('c-mix'));
    const b = m.withModules(['notizen']).withRoles([def]);
    assert.deepEqual(b.roles.get('c-mix')!.permissions, ['note:read']);
    assert.ok(!b.isPermission('view:read'));
    // Nach erneutem Aktivieren gelten die Rechte der Rolle wieder (Tupel und Rolle unverändert)
    assert.deepEqual(m.withRoles([def]).withModules(['notizen', 'ansichten']).roles.get('c-mix')!.permissions, ['view:read', 'note:read']);
  });

  test('Entscheidung: can und canSomewhere sind für Rechte inaktiver Module false, auch für org-admin, owner und Scopes', () => {
    const access = new AccessService(null as never, { model: m, schema: 'notes' });
    const base: Principal = { tenantId: 't', tenantAlias: 'a', principalId: U(1), kind: 'user', subject: 's', name: 'n', email: null, clientId: null, groups: [], subjects: [], scopes: [], platformAdmin: false, binding: 'none', token: '' };
    const p = { ...base, subjects: subjectsOf(base) };
    const tuples: Tuple[] = [
      { id: U(901), subject: `user:${U(1)}`, relation: 'org-admin', object_type: 'org', object_id: null, expires_at: null, created_at: new Date(), created_by: null },
      { id: U(902), subject: `user:${U(1)}`, relation: 'owner', object_type: 'view', object_id: U(30), expires_at: null, created_at: new Date(), created_by: null },
    ];
    const acl = (model: Model): TenantAccess => ({ version: '1', model, modules: model.activeModules, roles: [], tuples, byPlace: new Map([['org:', [tuples[0]!]], [`view:${U(30)}`, [tuples[1]!]]]), clearances: new Map(), state: null });
    const on = acl(m), off = acl(org);
    assert.equal(access.decide(p, on, 'view:read'), true);
    assert.equal(access.decide(p, off, 'view:read'), false, 'org-admin hat Rechte inaktiver Module nicht');
    assert.equal(access.decide(p, off, 'view:write', { type: 'view', id: U(30) }), false, 'owner auch nicht');
    assert.equal(access.decide(p, off, 'note:read'), true);
    assert.equal(access.somewhere(p, off, 'view:read'), false);
    assert.ok(!access.orgPermissions(p, off).includes('view:read'));
    assert.ok(!access.somewherePermissions(p, off).includes('view:read'));
    assert.equal(access.tupleReasons(p, off, 'view:read', { type: 'org' }).length, 0, '«Warum?» findet keinen Weg');
    const client = { ...p, kind: 'client' as const, subjects: [`client:${U(1)}`], scopes: ['notes:read'] };
    assert.equal(access.scopeAllows(client, 'view:read'), true, 'Scope der App deckt es');
    assert.equal(access.decide(client, off, 'view:read'), false, 'im Modell der Organisation nicht');
  });
});

describe('Produktmodule: Zustand aus tenant_module', () => {
  const row = (module: string, allowed: boolean, active: boolean): ModuleRow => ({ module, allowed, active, active_since: null, inactive_since: null, changed_at: new Date(), changed_by: null });

  test('Kern immer aktiv; ohne Zeile nicht erlaubt; Teilfunktion ohne Zeile wie ihr Modul; aktiv nur, wenn erlaubt', () => {
    assert.deepEqual([...activeModules(modulesModel, [])], ['kern']);
    const rows = [row('notizen', true, true), row('ansichten', true, false), row('teams', false, false)];
    const s = moduleStates(modulesModel, rows);
    assert.deepEqual(s.map(x => [x.key, x.module, x.allowed, x.active]), [
      ['kern', null, true, true], ['notizen', null, true, true], ['notizen.teilen', 'notizen', true, true], ['ansichten', null, true, false], ['teams', null, false, false],
    ]);
    assert.deepEqual([...activeModules(modulesModel, [...rows, row('notizen.teilen', true, false)])], ['kern', 'notizen']);
    assert.deepEqual([...activeModules(modulesModel, [row('notizen', false, true)])], ['kern'], 'aktiv ohne erlaubt zählt nicht');
    assert.deepEqual([...activeModules(modulesModel, [row('notizen', false, false), row('notizen.teilen', true, true)])], ['kern'], 'Teilfunktion ohne erlaubtes Modul');
  });
});
