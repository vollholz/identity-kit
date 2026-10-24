import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { accessCases, checkModel, personCases, runAccessCases, type AuthzModel } from '../src/index.ts';

/** Kleinstes gültiges Modell nach Spezifikation Kap. 7.3, 8 (Notiz-App: Ordner → Notiz). */
function model(): AuthzModel {
  const p = (key: string, label: string, group: string, resources = ['org']) => ({ key, label, group, description: `${label}.`, resources });
  const permissions = [
    p('tenant:read', 'Organisation lesen', 'tenant'), p('members:admin', 'Mitglieder und Rollen verwalten', 'members'),
    p('note:read', 'Notizen lesen', 'notes', ['org', 'folder', 'note']), p('note:write', 'Notizen ändern', 'notes', ['org', 'folder', 'note']),
    p('access:admin', 'Zugriff verwalten', 'access', ['org', 'folder', 'note']),
  ];
  return {
    permissions,
    groups: [{ key: 'tenant', label: 'Organisation' }, { key: 'members', label: 'Mitglieder und Rollen' }, { key: 'notes', label: 'Notizen', match: 'notiz' }, { key: 'access', label: 'Zugriff', match: 'zugriff' }],
    roles: [
      { key: 'org-admin', label: 'Organisations-Admin', description: 'Alles: Notizen, Zugriff, Mitglieder.', permissions: permissions.map(x => x.key), adminOnly: true },
      { key: 'editor', label: 'Bearbeiter:in', description: 'Liest und ändert Notizen, gibt Zugriff.', permissions: ['tenant:read', 'note:read', 'note:write', 'access:admin'], adminOnly: false },
      { key: 'viewer', label: 'Leser:in', description: 'Liest Notizen.', permissions: ['tenant:read', 'note:read'], adminOnly: false },
    ],
    scopes: [{ key: 'notes:read', text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] }, { key: 'notes:write', text: 'Notizen ändern', permissions: ['note:write'] }],
    types: [
      { key: 'org', label: 'Organisation', parent: null, roles: ['org-admin', 'editor', 'viewer'], relations: ['org-admin', 'editor', 'viewer'], read: 'tenant:read' },
      { key: 'folder', label: 'Ordner', parent: 'org', roles: ['editor', 'viewer'], relations: ['editor', 'viewer'], read: 'note:read' },
      { key: 'note', label: 'Notiz', parent: 'folder', roles: ['editor', 'viewer'], relations: ['editor', 'viewer'], leaf: true, read: 'note:read', write: 'note:write' },
    ],
    classifications: [{ level: 0, label: 'intern' }, { level: 1, label: 'vertraulich' }, { level: 2, label: 'streng vertraulich' }],
  };
}

describe('checkModel', () => {
  test('gültiges Modell: keine Fehler; Lese-Scope als Warnung; platform.json nur Scopes', () => {
    assert.deepEqual(checkModel(model()), { errors: [], warnings: [] });
    assert.deepEqual(checkModel(model(), { product: 'notes', platformJson: '{ "scopes": ["notes:read", "notes:write"] }' }), { errors: [], warnings: [] });
    assert.deepEqual(checkModel(model(), { product: 'kanban' }).warnings, ['Lese-Scope «kanban:read» fehlt']);
    assert.match(checkModel(model(), { platformJson: '{ "roles": {}, "scopes": ["notes:read", "notes:write"] }' }).errors.join(), /platform.json veraltet/);
  });

  const cases: [string, (c: AuthzModel) => void, RegExp][] = [
    ['org-admin nicht zuerst', c => { c.roles.push(c.roles.shift()!); }, /M3 Rolle «org-admin» fehlt oder steht nicht zuerst/],
    ['org-admin falsches Label', c => { c.roles[0]!.label = 'Admin'; }, /M1 Rolle «org-admin»: Label/],
    ['org-admin ohne alle Rechte', c => { c.roles[0]!.permissions = ['tenant:read']; }, /M3 Rolle «org-admin» hat nicht alle Rechte/],
    ['Rolle member', c => { c.roles.push({ key: 'member', label: 'M', description: 'Notizen', permissions: ['note:read'] }); }, /M1 Rolle «member»: reservierter Name/],
    ['acl:read entfällt', c => { c.permissions.push({ key: 'acl:read', label: 'Zugriff lesen', group: 'access', description: 'x', resources: ['org'] }); }, /M1 Recht «acl:read» entfällt/],
    ['resources ohne org', c => { c.permissions[2]!.resources = ['note']; }, /M2 Recht «note:read»: resources ohne «org»/],
    ['Beschreibung ohne Gruppe', c => { c.roles[2]!.description = 'Liest.'; }, /M3 Rolle «viewer»: Beschreibung nennt die Rechtegruppe «notes» nicht/],
    ['parent fehlt', c => { c.types[1]!.parent = 'nix'; }, /M4 Typ «folder»: parent fehlt/],
    ['Kreis', c => { c.types[1]!.parent = 'note'; c.types[2]!.leaf = undefined; }, /M4 Typ «folder»: Kette hat einen Kreis/],
    ['org-admin am Ort', c => { c.types[1]!.roles.push('org-admin'); }, /M5 Typ «folder»: org-admin nur an org/],
    ['zwei Blätter', c => { c.types[1]!.leaf = true; }, /M6 höchstens ein Blatt-Typ/],
    ['Blatt ohne write', c => { c.types[2]!.write = undefined; }, /M7 Typ «note»: write fehlt/],
    ['read ohne Typ in resources', c => { c.permissions[2]!.resources = ['org']; }, /M7 Typ «folder»: «note:read» hat den Typ nicht in resources/],
    ['fremde Beziehung', c => { c.types[1]!.relations.push('boss'); }, /M8 Typ «folder»: Beziehung «boss»/],
    ['owner an org', c => { c.types[0]!.owner = true; }, /M9 Typ «org»/],
    ['access:admin im Scope', c => { c.scopes[1]!.permissions.push('access:admin'); }, /M10 Scope «notes:write» enthält «access:admin»/],
    ['Stufen', c => { c.classifications = c.classifications.slice(0, 2); }, /M12/],
  ];
  for (const [name, change, want] of cases) {
    test(name, () => {
      const c = model();
      change(c);
      assert.match(checkModel(c).errors.join('\n'), want);
    });
  }
});

describe('accessCases', () => {
  test('Fälle aus dem Modell; ein korrektes Entscheidungsmodell besteht alle, ein falsches nicht', async () => {
    const m = model();
    const cases = accessCases(m);
    assert.ok(cases.length >= 10);
    // Kleine Referenz der Entscheidung an org nach Kap. 7.5
    const decide = async (c: (typeof cases)[number]) => {
      const subjects = c.who.kind === 'client' ? ['me'] : ['me', 'org:members', ...(c.who.groupInToken ? ['group'] : [])];
      const roles = c.tuples.filter(t => !t.expired && subjects.includes(t.subject)).map(t => t.relation);
      const has = m.roles.filter(r => roles.includes(r.key)).some(r => r.permissions.includes(c.permission));
      const scoped = c.who.kind === 'client' || c.who.scopes !== undefined;
      return has && (!scoped || m.scopes.filter(s => c.who.scopes?.includes(s.key)).some(s => s.permissions.includes(c.permission)));
    };
    assert.deepEqual(await runAccessCases(cases, decide), []);
    const wrong = await runAccessCases(cases, async c => c.tuples.length > 0);
    assert.ok(wrong.length > 0);
  });
});

describe('personCases', () => {
  test('Fälle je Typ mit scope; eine Referenz nach Kap. 7.5 Regel 2 besteht alle, eine falsche nicht', async () => {
    const m = model();
    m.types = [...m.types.filter(t => t.key !== 'note'), { key: 'note', label: 'Notiz', parent: 'org', roles: [], relations: [], leaf: true, classified: true, scope: { relation: 'gehört zu' }, read: 'note:read', write: 'note:write' } as never];
    m.scopes = [{ key: 'x:read', text: 'Lesen', permissions: ['note:read'] }, { key: 'x:write', text: 'Ändern', permissions: ['note:write'] }];
    const cases = personCases(m);
    assert.ok(cases.length >= 10);
    const decide = async (c: (typeof cases)[number]) => {
      const t = m.types.find(x => x.key === c.type)!;
      const way = c.who.kind === 'user' && c.holder === 'me' && (c.grants === 'edit' || (c.grants === 'read' && c.permission === t.read));
      const scoped = c.who.scopes !== undefined || c.who.kind === 'client';
      const scopeOk = !scoped || m.scopes.filter(s => c.who.scopes?.includes(s.key)).some(s => s.permissions.includes(c.permission));
      return way && scopeOk && (c.classification ?? 0) === 0;
    };
    assert.deepEqual(await runAccessCases(cases, decide), []);
    assert.ok((await runAccessCases(cases, async c => c.grants !== 'none')).length > 0);
  });
});
