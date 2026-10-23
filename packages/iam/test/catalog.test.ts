/**
 * Rechtekatalog (Spezifikation Kap. 7.2, 8; Entwurf 4, 13.1; aus Assets test/platform/authz.test.ts, Katalogteil).
 * Pflichttest (Auflage 1): Der Katalog von Assets besteht `defineCatalog` und `checkCatalog`, und die Antwort von
 * `GET /v1/authz/catalog` ist die von Assets (ergänzt nur um `match` und `personOnly`).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkCatalog } from '@vollholz/iam-testkit';
import { ADMIN_ROLE, CatalogError, defineCatalog, type AuthzCatalogJson, type CatalogInput } from '../src/catalog.ts';
import { assetsCatalog, assetsFixture, assetsInput, notesCatalog, notesInput } from './support/catalogs.ts';

/** Antwort ohne die Felder, die das Paket ergänzt. */
const withoutAdditions = (j: AuthzCatalogJson) => ({ ...j, permissions: j.permissions.map(({ personOnly: _p, ...p }) => p), groups: j.groups.map(({ match: _m, ...g }) => g), resourceTypes: j.resourceTypes.map(({ leaf: _l, ...r }) => r) });

/** Befunde von defineCatalog (leer = gültig). */
function errorsOf(input: unknown): string[] {
  try { defineCatalog(input as CatalogInput<string>); return []; } catch (e) { assert.ok(e instanceof CatalogError); return e.errors; }
}

describe(`Katalog von Assets (${assetsFixture.source})`, () => {
  test('GET /v1/authz/catalog wie Assets, platform.json byte-gleich', () => {
    assert.deepEqual(withoutAdditions(assetsCatalog.toJSON()), assetsFixture.expected);
    // platform.json ohne org-admin (legt das Realm-Modul ab 0.2.0 selbst an), sonst wie in Assets
    const { 'org-admin': _admin, ...roles } = (JSON.parse(assetsFixture.platformJson) as { roles: Record<string, string> }).roles;
    assert.equal(assetsCatalog.platformJson(), `${JSON.stringify({ ...JSON.parse(assetsFixture.platformJson), roles }, null, 2)}\n`);
    assert.deepEqual(assetsCatalog.warnings, []);
  });

  test('besteht checkCatalog des Test-Kits, mit Stichwörtern und «nur für Personen»', () => {
    assert.deepEqual(checkCatalog(assetsCatalog.toJSON(), { product: 'assets', acl: true }), { errors: [], warnings: [] });
    assert.deepEqual(assetsCatalog.toJSON().permissions.filter(p => p.personOnly).map(p => p.key), ['members:admin', 'connector:activate', 'assistant:use']);
    assert.equal(assetsCatalog.toJSON().groups.find(g => g.key === 'discussion')!.match, 'kommentier|anh[äa]ng');
  });

  test('adminOnly: genau die Rechte, die nur org-admin hat; eigene Rollen ohne sie', () => {
    assert.deepEqual([...assetsCatalog.adminOnly], assetsFixture.expected.permissions.filter(p => p.adminOnly).map(p => p.key));
    assert.deepEqual([...assetsCatalog.adminOnly].sort(), ['acl:admin', 'comment:moderate', 'connector:activate', 'members:admin', 'tenant:admin']);
    assert.ok(!assetsCatalog.customRolePermissions.some(p => assetsCatalog.adminOnly.has(p)));
    assert.equal(assetsCatalog.roles.get(ADMIN_ROLE)!.permissions.length, assetsCatalog.permissions.length);
  });

  test('Scopes: engster Scope je Recht, Lese-Scope ohne Angabe, Rechte nur für Personen ohne Scope', () => {
    assert.equal(assetsCatalog.scopeForPermission('connection:sync'), 'connections:sync');
    assert.equal(assetsCatalog.scopeForPermission('object:read'), null);
    assert.equal(assetsCatalog.scopeForPermission('members:admin'), null);
    assert.deepEqual([...assetsCatalog.permissionsForScopes(['objects:write', 'unbekannt'])], ['object:write', 'object:delete']);
  });

  test('eigene Rollen: Rechte aus der Organisation, nie Rechte nur für org-admin, nur mit Präfix c-', () => {
    const custom = new Map([['c-pflege', ['tenant:read', 'object:write', 'members:admin', 'erfunden:x']], ['viewer', ['object:delete']]]);
    assert.deepEqual([...assetsCatalog.permissionsForRoles(['c-pflege'], custom)], ['tenant:read', 'object:write']);
    assert.ok(!assetsCatalog.permissionsForRoles(['viewer'], custom).has('object:delete'), 'vordefinierte Rollen kommen nur aus dem Code');
    assert.deepEqual([...assetsCatalog.permissionsForRoles(['c-andere'], custom)], []);
  });

  test('Meldungstext mit Label und Schlüssel', () => {
    assert.equal(assetsCatalog.permissionText('object:write'), '«Objekte ändern» (object:write)');
    assert.equal(assetsCatalog.permissionText('x:y'), '«x:y» (x:y)');
  });
});

describe('defineCatalog: Ergänzungen und Reihenfolge', () => {
  test('reservierte Rechte und Gruppen werden ergänzt, org-admin zuerst mit allen Rechten', () => {
    const j = notesCatalog.toJSON();
    assert.deepEqual(j.permissions.map(p => p.key), ['tenant:read', 'note:read', 'note:write', 'note:share', 'members:admin', 'acl:read', 'acl:admin']);
    assert.deepEqual(j.groups.map(g => g.key), ['tenant', 'notes', 'members', 'access']);
    assert.deepEqual(j.roles.map(r => r.key), ['org-admin', 'editor', 'viewer']);
    assert.deepEqual(j.roles[0]!.permissions, j.permissions.map(p => p.key));
    assert.equal(j.roles[0]!.description, 'Verwaltet die Organisation vollständig: Organisation, Notizen, Mitglieder und Rollen und Zugriff. Enthält alle anderen Rollen.');
    assert.deepEqual(j.resourceTypes, [{ key: 'tenant', label: 'Organisation' }, { key: 'folder', label: 'Ordner' }, { key: 'note', label: 'Notiz', leaf: true }], 'Blatt ausgeliefert (resourceTypes[].leaf)');
    assert.deepEqual(notesCatalog.resourceTypes.filter(t => t.leaf).map(t => t.key), ['note']);
    assert.deepEqual(j.permissions.filter(p => p.personOnly).map(p => p.key), ['note:share', 'members:admin']);
    assert.deepEqual(checkCatalog(j, { product: 'notes', acl: true }), { errors: [], warnings: [] });
    assert.equal(notesCatalog.platformJson(), `${JSON.stringify({ roles: { editor: 'Bearbeiter:in', viewer: 'Leser:in' }, scopes: ['notes:read', 'notes:write'] }, null, 2)}\n`);
  });

  test('Funktionen: tenant:admin und audit:read nur auf Wunsch, ohne Ressourcen keine Zugriffsregeln', () => {
    const c = defineCatalog({ ...notesInput(), resources: undefined, capabilities: undefined, features: { tenantSettings: true, audit: true, members: false },
      permissions: { 'note:read': { label: 'Notizen lesen', group: 'notes', description: 'Notizen sehen.' } },
      roles: { viewer: { label: 'Leser:in', description: 'Liest Notizen.', permissions: ['note:read'] } }, scopes: { 'notes:read': { text: 'Lesen', permissions: ['note:read'] } } });
    assert.deepEqual(c.permissions, ['tenant:read', 'tenant:admin', 'note:read', 'audit:read']);
    assert.equal(c.acl, false);
    assert.deepEqual(c.resourceTypes.map(t => t.key), ['tenant']);
    assert.deepEqual(c.toJSON().groups.map(g => g.key), ['tenant', 'notes', 'audit']);
  });

  test('reservierte Rechte selbst aufgeführt: Reihenfolge und Beschreibung der App bleiben', () => {
    const input = notesInput();
    const c = defineCatalog<string>({ ...input, permissions: { 'note:read': input.permissions['note:read'], 'members:admin': { label: 'Mitglieder und Rollen verwalten', group: 'members', description: 'Eigener Text.' }, 'tenant:read': { label: 'Organisation lesen', group: 'tenant', description: 'Eigene Beschreibung.' } },
      roles: { viewer: { label: 'Leser:in', description: 'Liest Notizen.', permissions: ['tenant:read', 'note:read'] } }, scopes: {}, capabilities: {} });
    assert.deepEqual(c.permissions, ['note:read', 'members:admin', 'tenant:read', 'acl:read', 'acl:admin']);
    assert.equal(c.info.get('tenant:read')!.description, 'Eigene Beschreibung.');
    assert.deepEqual(c.warnings, ['Lese-Scope «notes:read» fehlt']);
  });
});

describe('defineCatalog: Prüfungen (Abbruch mit allen Befunden)', () => {
  const base = notesInput;
  const cases: [string, (i: ReturnType<typeof notesInput>) => unknown, RegExp][] = [
    ['Label eines reservierten Rechts', i => ({ ...i, permissions: { ...i.permissions, 'tenant:read': { label: 'Lesen', group: 'tenant', description: 'x' } } }), /Recht «tenant:read»: Label «Lesen» statt «Organisation lesen» \(reserviert\)/],
    ['Gruppe eines reservierten Rechts', i => ({ ...i, permissions: { ...i.permissions, 'members:admin': { label: 'Mitglieder und Rollen verwalten', group: 'notes', description: 'x' } } }), /Recht «members:admin»: Gruppe «notes» statt «members»/],
    ['Schlüssel eines Rechts', i => ({ ...i, permissions: { ...i.permissions, 'Note:Read': { label: 'x', group: 'notes', description: 'x' } } }), /Recht «Note:Read»: Schlüssel/],
    ['Gruppe fehlt', i => ({ ...i, permissions: { ...i.permissions, 'note:x': { label: 'x', group: 'fehlt', description: 'x' } } }), /Gruppe «fehlt» nicht im Katalog/],
    ['Ressourcentyp ohne tenant', i => ({ ...i, permissions: { ...i.permissions, 'note:x': { label: 'x', group: 'notes', description: 'x', resources: ['note'] } } }), /Ressourcentypen ohne «tenant»/],
    ['unbekannter Ressourcentyp', i => ({ ...i, permissions: { ...i.permissions, 'note:x': { label: 'x', group: 'notes', description: 'x', resources: ['tenant', 'board'] } } }), /Ressourcentyp «board» nicht im Katalog/],
    ['Beschreibung fehlt', i => ({ ...i, permissions: { ...i.permissions, 'note:x': { label: 'x', group: 'notes', description: ' ' } } }), /Recht «note:x»: Beschreibung fehlt/],
    ['Rolle mit c-', i => ({ ...i, roles: { ...i.roles, 'c-x': { label: 'x', description: 'Notizen.', permissions: ['note:read'] } } }), /Präfix «c-»/],
    ['Rolle mit /', i => ({ ...i, roles: { ...i.roles, 'a/b': { label: 'x', description: 'Notizen.', permissions: ['note:read'] } } }), /Rolle «a\/b»: Schlüssel/],
    ['Rolle platform-admin', i => ({ ...i, roles: { ...i.roles, 'platform-admin': { label: 'x', description: 'Notizen.', permissions: ['note:read'] } } }), /reserviert für die Realm-Rolle/],
    ['Rolle mit unbekanntem Recht', i => ({ ...i, roles: { ...i.roles, x: { label: 'x', description: 'Notizen.', permissions: ['note:erfunden'] } } }), /Recht «note:erfunden» nicht im Katalog/],
    ['Rolle ohne Rechte', i => ({ ...i, roles: { ...i.roles, x: { label: 'x', description: 'x', permissions: [] } } }), /Rolle «x»: ohne Rechte/],
    ['Beschreibung nennt Gruppe nicht', i => ({ ...i, roles: { ...i.roles, viewer: { label: 'Leser:in', description: 'Liest Texte.', permissions: ['note:read'] } } }), /Rolle «viewer»: Beschreibung nennt die Rechtegruppe «notes» nicht/],
    ['org-admin mit anderem Label', i => ({ ...i, roles: { ...i.roles, 'org-admin': { label: 'Chef', description: 'Notizen, Mitglieder, Zugriff.', permissions: [] } } }), /Rolle «org-admin»: Label «Chef»/],
    ['org-admin ohne alle Rechte', i => ({ ...i, roles: { ...i.roles, 'org-admin': { label: 'Organisations-Admin', description: 'Notizen, Mitglieder, Zugriff.', permissions: ['note:read'] } } }), /hat nicht alle Rechte/],
    ['members:admin in einem Scope', i => ({ ...i, scopes: { ...i.scopes, 'notes:admin': { text: 'x', permissions: ['members:admin'] } } }), /Scope «notes:admin» enthält «members:admin» \(nur für Personen/],
    ['Recht nur für Personen in einem Scope', i => ({ ...i, scopes: { ...i.scopes, 'notes:share': { text: 'x', permissions: ['note:share'] } } }), /enthält «note:share»/],
    ['Scope ohne Text', i => ({ ...i, scopes: { ...i.scopes, 'notes:x': { text: '', permissions: ['note:read'] } } }), /Scope «notes:x»: Text fehlt/],
    ['Scope-Schlüssel', i => ({ ...i, scopes: { ...i.scopes, notes: { text: 'x', permissions: ['note:read'] } } }), /Scope «notes»: Schlüssel/],
    ['Gruppe doppelt', i => ({ ...i, groups: [...i.groups, { key: 'notes', label: 'Nochmals' }] }), /Gruppe «notes» mehrfach/],
    ['reservierte Gruppe mit anderem Label', i => ({ ...i, groups: [...i.groups, { key: 'access', label: 'Rechte' }] }), /Gruppe «access»: Label «Rechte» statt «Zugriff»/],
    ['tenant mit anderem Label', i => ({ ...i, resources: { ...i.resources, tenant: { label: 'Mandant' } } }), /Ressourcentyp «tenant»: Label «Mandant»/],
    ['Fähigkeit mit unbekanntem Recht', i => ({ ...i, capabilities: { note: { delete: 'note:delete' } } }), /Fähigkeit note\.delete: Recht «note:delete» nicht im Katalog/],
    ['Fähigkeit auf unbekanntem Typ', i => ({ ...i, capabilities: { board: { write: 'note:write' } } }), /Fähigkeiten: Ressourcentyp «board» nicht im Katalog/],
    ['MCP-Werkzeug mit unbekanntem Recht', i => ({ ...i, mcpTools: { notiz_lesen: { title: 'Notiz lesen', permission: 'note:x', readOnly: true } } }), /MCP-Werkzeug «notiz_lesen»: Recht «note:x»/],
  ];
  for (const [label, change, message] of cases) {
    test(label, () => {
      const errors = errorsOf(change(base()));
      assert.ok(errors.some(e => message.test(e)), `${label}: ${errors.join(' | ') || 'keine Befunde'}`);
    });
  }

  test('alle Befunde zugleich, gültiger Katalog ohne Befunde', () => {
    assert.deepEqual(errorsOf(base()), []);
    const i = base();
    assert.ok(errorsOf({ ...i, roles: { ...i.roles, 'c-x': { label: '', description: '', permissions: [] } } }).length >= 4);
  });

  test('gleiches Urteil wie checkCatalog des Test-Kits auf denselben Katalogen', () => {
    // Gültig: beide ohne Befunde; Verstoss gegen eine gemeinsame Regel: beide mit Befund
    assert.deepEqual(checkCatalog(notesCatalog.toJSON(), { product: 'notes', acl: true }).errors, []);
    const bad = notesCatalog.toJSON();
    bad.roles[1]!.description = 'Liest Texte.';
    bad.scopes.push({ key: 'notes:share', text: 'x', permissions: ['note:share'] });
    const kit = checkCatalog(bad, { product: 'notes', acl: true }).errors;
    const own = errorsOf({ ...base(), roles: { ...base().roles, editor: { ...base().roles.editor, description: 'Liest Texte.' } }, scopes: { ...base().scopes, 'notes:share': { text: 'x', permissions: ['note:share'] } } });
    for (const re of [/Rolle «editor»: Beschreibung nennt die Rechtegruppe «notes» nicht/, /Scope «notes:share» enthält «note:share»/]) {
      assert.ok(kit.some(e => re.test(e)), `Test-Kit: ${re}`);
      assert.ok(own.some(e => re.test(e)), `defineCatalog: ${re}`);
    }
  });
});

test('Assets ohne Stichwörter wäre nicht geprüft; mit falscher Beschreibung bricht defineCatalog ab', () => {
  const i = assetsInput();
  (i.roles.viewer as { description: string }).description = 'Liest alles.';
  assert.ok(errorsOf(i).some(e => /Rolle «viewer»: Beschreibung nennt die Rechtegruppe «schemas» nicht/.test(e)));
});

test('Stichwörter als RegExp mit g oder y: jede Rollenbeschreibung wird von vorn geprüft', () => {
  for (const flags of ['g', 'y', 'gi']) {
    const i = notesInput();
    assert.deepEqual(errorsOf({ ...i, groups: [{ key: 'notes', label: 'Notizen', match: new RegExp('notiz|.*notiz', flags) }] }), [], flags);
  }
});

test('Stichwörter als RegExp nur mit i (g, y ignoriert); andere Flags gingen in der Antwort verloren', () => {
  const i = notesInput();
  assert.ok(errorsOf({ ...i, groups: [{ key: 'notes', label: 'Notizen', match: /^notiz/m }] }).some(e => /Gruppe «notes»: Stichwörter mit Flags «m»; erlaubt ist nur i/.test(e)));
});

test('erzeugte Beschreibung von org-admin ohne Stichwort einer Gruppe: klare Meldung', () => {
  const i = notesInput();
  const errors = errorsOf({ ...i, groups: [{ key: 'notes', label: 'Texte', match: 'notiz' }] });
  assert.ok(errors.some(e => /Rolle «org-admin»: die erzeugte Beschreibung nennt die Rechtegruppe «notes» nicht .*eigene Beschreibung für org-admin angeben/.test(e)), errors.join(' | '));
  const own = { ...i, groups: [{ key: 'notes', label: 'Texte', match: 'notiz' }], roles: { ...i.roles, 'org-admin': { label: 'Organisations-Admin', description: 'Verwaltet Notizen, Mitglieder und den Zugriff der Organisation.', permissions: [] } } };
  assert.deepEqual(errorsOf(own), []);
});

test('reservierte Rechte und Gruppen ohne Label und Gruppe: Werte aus dem Baukasten, Reihenfolge der App', () => {
  const c = defineCatalog({
    product: 'notes',
    permissions: {
      'note:read': { label: 'Notizen lesen', group: 'notes', description: 'Notizen sehen.' },
      'acl:read': {},
      'members:admin': { description: 'Mitglieder der Notizablage verwalten.' },
      'acl:admin': {},
    },
    groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }, { key: 'access' }, { key: 'members' }],
    roles: { viewer: { label: 'Leser:in', description: 'Liest Notizen.', permissions: ['note:read'] } },
    scopes: { 'notes:read': { text: 'Notizen lesen', permissions: ['note:read'] } },
    resources: { note: { label: 'Notiz' } },
  });
  const j = c.toJSON();
  assert.deepEqual(j.permissions.map(p => p.key), ['tenant:read', 'note:read', 'acl:read', 'members:admin', 'acl:admin']);
  assert.deepEqual(j.permissions.find(p => p.key === 'acl:read'), { key: 'acl:read', label: 'Zugriff lesen', group: 'access', description: 'Zugriffsregeln und wirksame Rechte sehen.', resources: ['tenant'], adminOnly: true });
  assert.equal(j.permissions.find(p => p.key === 'members:admin')!.description, 'Mitglieder der Notizablage verwalten.');
  assert.deepEqual(j.groups.map(g => [g.key, g.label]), [['tenant', 'Organisation'], ['notes', 'Notizen'], ['access', 'Zugriff'], ['members', 'Mitglieder und Rollen']]);
  assert.equal(j.roles[0]!.key, 'org-admin');
});

test('eigene Rechte und Gruppen brauchen Label, Gruppe und Beschreibung', () => {
  const i = notesInput();
  const errors = errorsOf({ ...i, permissions: { ...i.permissions, 'note:other': {} }, groups: [...i.groups, { key: 'extra' }] });
  for (const m of [/Recht «note:other»: Label fehlt/, /Recht «note:other»: Beschreibung fehlt/, /Recht «note:other»: Gruppe fehlt/, /Gruppe «extra»: Label fehlt/]) assert.ok(errors.some(e => m.test(e)), `${m} in ${errors.join(' | ')}`);
});

test('erzeugte Beschreibung von org-admin: Rechtegruppen in Anzeigereihenfolge, zuletzt mit «und»', () => {
  const c = defineCatalog({
    product: 'notes',
    permissions: { 'note:read': { label: 'Notizen lesen', group: 'notes', description: 'Notizen sehen.' }, 'acl:read': {} },
    groups: [{ key: 'access' }, { key: 'notes', label: 'Notizen', match: 'notiz' }],
    roles: { viewer: { label: 'Leser:in', description: 'Liest Notizen.', permissions: ['note:read'] } },
    resources: { note: { label: 'Notiz' } },
  });
  assert.equal(c.roles.get(ADMIN_ROLE)!.description, 'Verwaltet die Organisation vollständig: Organisation, Zugriff, Notizen und Mitglieder und Rollen. Enthält alle anderen Rollen.');
});
