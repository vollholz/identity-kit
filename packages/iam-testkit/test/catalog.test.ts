import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkCatalog, type AuthzCatalog } from '../src/index.ts';

/** Kleinster gültiger Katalog nach Spezifikation Kap. 8 (eine Notiz-App mit Zugriffsregeln). */
function catalog(): AuthzCatalog {
  const p = (key: string, label: string, group: string, resources = ['tenant']) => ({ key, label, group, description: `${label}.`, resources });
  const permissions = [
    p('tenant:read', 'Organisation lesen', 'tenant'), p('tenant:admin', 'Organisation verwalten', 'tenant'),
    p('members:admin', 'Mitglieder und Rollen verwalten', 'members'), p('acl:read', 'Zugriff lesen', 'access'), p('acl:admin', 'Zugriff verwalten', 'access'),
    p('audit:read', 'Protokoll lesen', 'audit'), p('note:read', 'Notizen lesen', 'notes', ['tenant', 'note']), p('note:write', 'Notizen ändern', 'notes', ['tenant', 'note']),
  ];
  return {
    permissions,
    groups: [{ key: 'tenant', label: 'Organisation' }, { key: 'members', label: 'Mitglieder und Rollen' }, { key: 'access', label: 'Zugriff' }, { key: 'audit', label: 'Protokoll' }, { key: 'notes', label: 'Notizen' }],
    roles: [
      { key: 'org-admin', label: 'Organisations-Admin', description: 'Alles in der Organisation.', permissions: permissions.map(x => x.key) },
      { key: 'editor', label: 'Bearbeiter:in', description: 'Liest und ändert Notizen.', permissions: ['tenant:read', 'note:read', 'note:write'] },
    ],
    scopes: [{ key: 'notes:read', text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] }, { key: 'notes:write', text: 'Notizen ändern', permissions: ['note:write'] }],
    resourceTypes: [{ key: 'tenant', label: 'Organisation' }, { key: 'note', label: 'Notiz' }],
  };
}

describe('checkCatalog', () => {
  test('gültiger Katalog: keine Fehler, Lese-Scope als Warnung', () => {
    assert.deepEqual(checkCatalog(catalog(), { acl: true }), { errors: [], warnings: [] });
    assert.deepEqual(checkCatalog(catalog(), { product: 'notes' }).warnings, []);
    assert.deepEqual(checkCatalog(catalog(), { product: 'kanban' }).warnings, ['Lese-Scope «kanban:read» fehlt']);
  });

  const cases: [string, (c: AuthzCatalog) => void, string][] = [
    ['org-admin fehlt', c => { c.roles = c.roles.filter(r => r.key !== 'org-admin'); }, 'Rolle «org-admin» fehlt'],
    ['org-admin falsches Label', c => { c.roles[0]!.label = 'Admin'; }, 'Rolle «org-admin»: Label «Admin» statt «Organisations-Admin»'],
    ['org-admin ohne alle Rechte', c => { c.roles[0]!.permissions = ['tenant:read']; }, 'Rolle «org-admin» hat nicht alle Rechte'],
    ['tenant:read fehlt', c => { c.permissions = c.permissions.filter(p => p.key !== 'tenant:read'); for (const r of c.roles) r.permissions = r.permissions.filter(p => p !== 'tenant:read'); c.scopes[0]!.permissions = ['note:read']; }, 'Recht «tenant:read» fehlt'],
    ['reserviertes Recht falsches Label', c => { c.permissions[2]!.label = 'Leute verwalten'; }, 'Recht «members:admin»: Label «Leute verwalten» statt «Mitglieder und Rollen verwalten»'],
    ['reserviertes Recht falsche Gruppe', c => { c.permissions[5]!.group = 'notes'; }, 'Recht «audit:read»: Gruppe «notes» statt «audit»'],
    ['members:admin in einem Scope', c => { c.scopes[1]!.permissions.push('members:admin'); }, 'Scope «notes:write» enthält «members:admin»'],
    ['Rolle mit Präfix c-', c => { c.roles.push({ key: 'c-team', label: 'Team', description: 'x', permissions: ['note:read'] }); }, 'Präfix «c-» ist eigenen Rollen'],
    ['Rolle platform-admin', c => { c.roles.push({ key: 'platform-admin', label: 'P', description: 'x', permissions: ['note:read'] }); }, 'reserviert für die Realm-Rolle'],
    ['Rolle mit /', c => { c.roles.push({ key: 'a/b', label: 'AB', description: 'x', permissions: ['note:read'] }); }, 'Rolle «a/b»: Schlüssel nicht'],
    ['Rechteschlüssel ohne Doppelpunkt', c => { c.permissions.push({ key: 'notesread', label: 'L', group: 'notes', description: 'd', resources: ['tenant'] }); c.roles[0]!.permissions.push('notesread'); }, 'Recht «notesread»: Schlüssel nicht <bereich>:<verb>'],
    ['Recht ohne Beschreibung', c => { c.permissions[6]!.description = ''; }, 'Recht «note:read»: Beschreibung fehlt'],
    ['Gruppe unbekannt', c => { c.permissions[6]!.group = 'gibtsnicht'; }, 'Recht «note:read»: Gruppe «gibtsnicht» nicht im Katalog'],
    ['Rolle mit unbekanntem Recht', c => { c.roles[1]!.permissions.push('note:delete'); }, 'Rolle «editor»: Recht «note:delete» nicht im Katalog'],
    ['Scope ohne Text', c => { c.scopes[0]!.text = ' '; }, 'Scope «notes:read»: Text fehlt'],
    ['Ressourcentyp unbekannt', c => { c.permissions[6]!.resources = ['tenant', 'folder']; }, 'Ressourcentyp «folder» nicht im Katalog'],
    ['Ressourcentypen fehlen ganz', c => { delete c.resourceTypes; }, 'Ressourcentyp «tenant» fehlt'],
    ['Ressourcentyp tenant fehlt', c => { c.resourceTypes = c.resourceTypes!.filter(t => t.key !== 'tenant'); for (const p of c.permissions) p.resources = p.resources.filter(r => r !== 'tenant'); }, 'Ressourcentyp «tenant» fehlt'],
    ['reservierte Gruppe falsches Label', c => { c.groups[3]!.label = 'Audit'; }, 'Gruppe «audit»: Label «Audit» statt «Protokoll»'],
    ['doppelte Rolle', c => { c.roles.push({ ...c.roles[1]! }); }, 'Rolle «editor» mehrfach'],
  ];
  for (const [name, change, expected] of cases) {
    test(name, () => {
      const c = catalog();
      change(c);
      const { errors } = checkCatalog(c, { acl: true });
      assert.ok(errors.some(e => e.includes(expected)), `erwartet «${expected}», erhalten:\n${errors.join('\n')}`);
    });
  }

  test('acl:read/acl:admin nur Pflicht mit Zugriffsregeln, members:admin abschaltbar', () => {
    const c = catalog();
    const drop = (keys: string[]) => { c.permissions = c.permissions.filter(p => !keys.includes(p.key)); for (const r of c.roles) r.permissions = r.permissions.filter(p => !keys.includes(p)); c.groups = c.groups.filter(g => !['access', 'members'].includes(g.key) || c.permissions.some(p => p.group === g.key)); };
    drop(['acl:read', 'acl:admin']);
    assert.deepEqual(checkCatalog(c).errors, []);
    assert.ok(checkCatalog(c, { acl: true }).errors.includes('Recht «acl:read» fehlt'));
    drop(['members:admin']);
    assert.ok(checkCatalog(c).errors.includes('Recht «members:admin» fehlt'));
    assert.deepEqual(checkCatalog(c, { members: false }).errors, []);
  });

  test('0.2.0: Stichwörter der Gruppen in Rollenbeschreibungen (match), nur für Personen (personOnly)', () => {
    const c = catalog();
    c.groups = c.groups.map(g => (g.key === 'notes' ? { ...g, match: 'notiz' } : g.key === 'members' ? { ...g, match: 'mitglieder' } : g));
    assert.deepEqual(checkCatalog(c).errors, ['Rolle «org-admin»: Beschreibung nennt die Rechtegruppe «members» nicht (Stichwort mitglieder)', 'Rolle «org-admin»: Beschreibung nennt die Rechtegruppe «notes» nicht (Stichwort notiz)']);
    c.roles[0]!.description = 'Verwaltet Mitglieder und Notizen.';
    assert.deepEqual(checkCatalog(c).errors, []);
    c.roles[1]!.description = 'Liest und ändert Texte.';
    assert.deepEqual(checkCatalog(c).errors, ['Rolle «editor»: Beschreibung nennt die Rechtegruppe «notes» nicht (Stichwort notiz)']);
    c.groups = c.groups.map(g => (g.key === 'notes' ? { ...g, match: 'not(' } : g));
    assert.match(checkCatalog(c).errors.join('\n'), /Stichwort «not\(» ist kein regulärer Ausdruck/);
    // Ohne match keine Prüfung (Kataloge vor 0.2.0)
    assert.deepEqual(checkCatalog(catalog()).errors, []);
    const p = catalog();
    p.permissions = p.permissions.map(x => (x.key === 'note:write' ? { ...x, personOnly: true } : x));
    assert.deepEqual(checkCatalog(p).errors, ['Scope «notes:write» enthält «note:write» (nur für Personen, in keinem Scope)']);
  });
});
