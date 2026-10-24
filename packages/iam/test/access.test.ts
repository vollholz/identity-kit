/**
 * Entscheidung nach Spezifikation Kap. 7.5 (Pflichttest `access`, Kap. 14): Rolle an org, am Ort, Vererbung über `parent`
 * und `self`, Blatt-Tupel (nur Rollen mit `read`, nie `member`), Gruppen-Subjekte, «Alle Mitglieder», Zuständigkeit
 * (`grants` read/edit, Vererbung über untergeordnete Einheiten, Tiefe 16, Kreis), Besitz, Klassifizierung (auch
 * org-admin scheitert), Break-Glass, Ablauf von Tupeln (zählt nicht, Aufräumen, `access.expired`), Scope-Grenze für
 * jeden Weg, Client ohne Tupel → 403, `canSomewhere`, Zwischenspeicher nach `acl_version`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { accessCases, runAccessCases } from '@vollholz/iam-testkit';
import { AccessService, capabilities, noFacts, subjectsOf, type Facts, type TenantAccess, type Tuple } from '../src/access.ts';
import { pgAudit } from '../src/audit.ts';
import { resourceProblems } from '../src/iam.ts';
import { defineModel } from '../src/model.ts';
import { withTenant } from '../src/db.ts';
import type { Level } from '../src/model.ts';
import type { Principal } from '../src/principal.ts';
import { refKey } from '../src/resources.ts';
import { expireAccess } from '../src/sync.ts';
import { skipDb } from './support/db.ts';
import { folderWithNote, full, grant, notesDb, notesResources, person, team, tenant, type NotesState } from './support/http.ts';
import { notesInput, notesModel } from './support/models.ts';

const skip = await skipDb();
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const G1 = '0b6f2f7e-4c1d-4d2b-9a55-1f0c7c2d9e11', G2 = '1c7a3e8f-5d2e-4e3c-8b66-2a1d8d3e0f22';

const p = (extra: Partial<Principal> = {}): Principal => {
  const base: Principal = { tenantId: 't', tenantAlias: 'a', principalId: U(1), kind: 'user', subject: 's', name: 'n', email: null, clientId: null, groups: [], subjects: [], scopes: [], platformAdmin: false, binding: 'none', token: '', ...extra };
  return { ...base, subjects: subjectsOf(base) };
};
/** Ordner F1 → F2 (Unterordner) → Notiz N1; Ordner F3 mit Notiz N2. */
const state: NotesState = {
  folderParent: new Map([[U(11), null], [U(12), U(11)], [U(13), null]]),
  noteFolder: new Map([[U(21), U(12)], [U(22), U(13)]]),
};
let seq = 0;
const tuple = (subject: string, relation: string, type = 'org', id: string | null = null, expires: Date | null = null): Tuple =>
  ({ id: U(900 + ++seq), subject, relation, object_type: type, object_id: id, expires_at: expires, created_at: new Date(), created_by: null });
function acl(tuples: Tuple[], clearances: [string, { clearance: Level; boost: Level | null; until: Date | null }][] = []): TenantAccess<NotesState> {
  const byPlace = new Map<string, Tuple[]>();
  for (const t of tuples) { const k = refKey({ type: t.object_type, id: t.object_id }); byPlace.set(k, [...byPlace.get(k) ?? [], t]); }
  return { version: '1', tuples, byPlace, clearances: new Map(clearances), state };
}
const me = `user:${U(1)}`;
const N1 = { type: 'note', id: U(21) }, N2 = { type: 'note', id: U(22) }, F1 = { type: 'folder', id: U(11) }, F2 = { type: 'folder', id: U(12) };
const facts = (o: Partial<Facts>): Facts => ({ ...noFacts(), ...o });

describe('Entscheidung (ohne Datenbank)', () => {
  const acc = new AccessService(null as never, { model: notesModel, schema: 'notes', resources: notesResources });

  test('Rolle an org gibt ihre Rechte überall, nur ihre', () => {
    const a = acl([tuple(me, 'viewer')]);
    assert.equal(acc.decide(p(), a, 'tenant:read'), true);
    assert.equal(acc.decide(p(), a, 'note:read', N1), true);
    assert.equal(acc.decide(p(), a, 'note:write', N1), false);
    assert.equal(acc.decide(p(), a, 'members:admin'), false);
    assert.equal(acc.decide(p(), acl([tuple(me, 'org-admin')]), 'members:admin'), true, 'org-admin hat alle Rechte');
  });

  test('Rolle am Ort: dort und darunter, Vererbung über parent und self, nicht daneben', () => {
    const a = acl([tuple(me, 'editor', 'folder', U(11))]);
    assert.equal(acc.decide(p(), a, 'note:write', F1), true);
    assert.equal(acc.decide(p(), a, 'note:write', F2), true, 'Unterordner (self)');
    assert.equal(acc.decide(p(), a, 'note:write', N1), true, 'Notiz im Unterordner (parent)');
    assert.equal(acc.decide(p(), a, 'note:write', N2), false, 'anderer Ordner');
    assert.equal(acc.decide(p(), a, 'note:write'), false, 'nicht an org');
    assert.equal(acc.decide(p(), acl([tuple(me, 'editor', 'folder', U(12))]), 'note:read', F1), false, 'nicht nach oben');
  });

  test('canSomewhere über Zuständigkeit gilt für jeden Typ mit scope, nicht nur den ersten', () => {
    const i = notesInput();
    const two = defineModel({
      ...i,
      permissions: { ...i.permissions, 'doc:read': { label: 'Dokumente lesen', group: 'notes', description: 'Dokumente sehen.', resources: ['org', 'doc'] }, 'doc:write': { label: 'Dokumente ändern', group: 'notes', description: 'Dokumente ändern.', resources: ['org', 'doc'] } },
      roles: { ...i.roles, viewer: { ...i.roles.viewer, permissions: [...i.roles.viewer.permissions, 'doc:read'] }, editor: { ...i.roles.editor, permissions: [...i.roles.editor.permissions, 'doc:read', 'doc:write'] } },
      types: { ...i.types, doc: { label: 'Dokument', parent: 'org', roles: ['editor', 'viewer'], scope: { via: 'reference', relation: 'betrifft' }, read: 'doc:read', write: 'doc:write' } },
    } as never);
    const a2 = new AccessService(null as never, { model: two, schema: 'notes', resources: notesResources });
    const a = acl([tuple(me, 'member', 'team', U(31))]);
    for (const perm of ['note:read', 'note:write', 'doc:read', 'doc:write']) assert.equal(a2.somewhere(p({ subjects: [me] }), a, perm), true, perm);
    assert.equal(a2.somewhere(p({ subjects: [me] }), a, 'team:read'), false, 'member gibt kein Recht an der Einheit');
  });

  test('ResourceModel mit load braucht version (sonst bliebe die Kette im Zwischenspeicher)', () => {
    const { version: _, ...noVersion } = notesResources;
    assert.ok(resourceProblems(notesModel, noVersion as never).some(x => /version fehlt/.test(x)));
    assert.deepEqual(resourceProblems(notesModel, notesResources), []);
  });

  test('Blatt-Tupel: Rolle an der Notiz; member gibt keine Rechte, auch nicht an der Einheit selbst', () => {
    assert.equal(acc.decide(p(), acl([tuple(me, 'viewer', 'note', U(21))]), 'note:read', N1), true);
    assert.equal(acc.decide(p(), acl([tuple(me, 'viewer', 'note', U(21))]), 'note:read', N2), false);
    const t = { type: 'team', id: U(31) };
    assert.equal(acc.decide(p(), acl([tuple(me, 'member', 'team', U(31))]), 'team:read', t), false);
  });

  test('Subjekte: Gruppe aus dem Token, «Alle Mitglieder» nur für Personen, Client nur client:', () => {
    const a = acl([tuple(`group:${G1}`, 'viewer'), tuple('org:members', 'editor', 'folder', U(13))]);
    assert.equal(acc.decide(p({ groups: [G1] }), a, 'note:read'), true);
    assert.equal(acc.decide(p({ groups: [G2] }), a, 'note:read'), false, 'andere Gruppe');
    assert.equal(acc.decide(p(), a, 'note:write', N2), true, 'org:members');
    const c = p({ kind: 'client', principalId: U(2), scopes: ['notes:read', 'notes:write'] });
    assert.deepEqual(c.subjects, [`client:${U(2)}`]);
    assert.equal(acc.decide(c, a, 'note:write', N2), false, 'Clients sind nie «Alle Mitglieder» (A5)');
    assert.deepEqual(subjectsOf({ kind: 'user', principalId: U(1), groups: [G1, 'kein-guid'] }), [me, `group:${G1}`, 'org:members']);
  });

  test('Besitz: owner hat alle Rechte der Ressource (resources enthält den Typ), nur dort', () => {
    const v = { type: 'view', id: U(41) };
    const a = acl([tuple(me, 'owner', 'view', U(41))]);
    assert.equal(acc.decide(p(), a, 'view:write', v), true);
    assert.equal(acc.decide(p(), a, 'access:admin', v), true);
    assert.equal(acc.decide(p(), a, 'view:read', { type: 'view', id: U(42) }), false);
    assert.equal(acc.decide(p(), a, 'note:read', N1), false);
  });

  test('Zuständigkeit: grants read ergibt read, edit auch write; nur über units(p)', () => {
    const a = acl([]);
    const read = facts({ units: new Set([U(31)]), belongs: new Map([[refKey(N1), [{ id: U(21), unit_id: U(31), grants: 'read', label: 'gehört zu' }]]]) });
    assert.equal(acc.decide(p(), a, 'note:read', N1, null, read), true);
    assert.equal(acc.decide(p(), a, 'note:write', N1, null, read), false);
    const edit = facts({ units: new Set([U(31)]), belongs: new Map([[refKey(N1), [{ id: U(21), unit_id: U(31), grants: 'edit', label: 'gehört zu' }]]]) });
    assert.equal(acc.decide(p(), a, 'note:write', N1, null, edit), true);
    assert.equal(acc.decide(p(), a, 'note:read', N1, null, facts({ ...edit, units: new Set([U(32)]) })), false, 'andere Einheit');
    const none = facts({ units: new Set([U(31)]), belongs: new Map([[refKey(N1), [{ id: U(21), unit_id: U(31), grants: 'none', label: 'gehört zu' }]]]) });
    assert.equal(acc.decide(p(), a, 'note:read', N1, null, none), false, 'grants none');
  });

  test('Klassifizierung: Stufe ≤ Freigabestufe, auch org-admin scheitert; Break-Glass hebt, Ablauf beendet', () => {
    const f = facts({ classification: new Map([[refKey(N1), 2]]) });
    const admin = acl([tuple(me, 'org-admin')]);
    assert.equal(acc.decide(p(), admin, 'note:read', N1, null, f), false);
    assert.equal(acc.decide(p(), acl([tuple(me, 'org-admin')], [[U(1), { clearance: 2, boost: null, until: null }]]), 'note:read', N1, null, f), true);
    const soon = new Date(Date.now() + 60_000), past = new Date(Date.now() - 1000);
    assert.equal(acc.decide(p(), acl([tuple(me, 'org-admin')], [[U(1), { clearance: 0, boost: 2, until: soon }]]), 'note:read', N1, null, f), true, 'Break-Glass');
    assert.equal(acc.decide(p(), acl([tuple(me, 'org-admin')], [[U(1), { clearance: 0, boost: 2, until: past }]]), 'note:read', N1, null, f), false, 'abgelaufen');
    assert.equal(acc.clearanceOf(p({ kind: 'client' }), acl([], [[U(1), { clearance: 1, boost: 2, until: soon }]])), 1, 'nicht für Clients');
    assert.equal(acc.decide(p(), admin, 'note:read', N1, null, facts({ classification: new Map([[refKey(N1), 0]]) })), true);
  });

  test('Ablauf: abgelaufene Tupel zählen nicht', () => {
    assert.equal(acc.decide(p(), acl([tuple(me, 'viewer', 'org', null, new Date(Date.now() - 1000))]), 'note:read'), false);
    assert.equal(acc.decide(p(), acl([tuple(me, 'viewer', 'org', null, new Date(Date.now() + 60_000))]), 'note:read'), true);
  });

  test('Scope-Grenze für jeden Weg (Rolle, Besitz, Zuständigkeit)', () => {
    const mcp = p({ scopeBound: true, scopes: ['notes:read'] });
    assert.equal(acc.decide(mcp, acl([tuple(me, 'editor')]), 'note:read'), true);
    assert.equal(acc.decide(mcp, acl([tuple(me, 'editor')]), 'note:write'), false, 'Rolle');
    assert.equal(acc.decide(mcp, acl([tuple(me, 'owner', 'view', U(41))]), 'view:write', { type: 'view', id: U(41) }), false, 'Besitz');
    const edit = facts({ units: new Set([U(31)]), belongs: new Map([[refKey(N1), [{ id: U(21), unit_id: U(31), grants: 'edit', label: 'x' }]]]) });
    assert.equal(acc.decide(mcp, acl([]), 'note:write', N1, null, edit), false, 'Zuständigkeit');
    assert.equal(acc.decide(mcp, acl([]), 'note:read', N1, null, edit), true);
    assert.equal(acc.decide(p({ scopeBound: true, scopes: ['notes:read', 'notes:write'] }), acl([tuple(me, 'org-admin')]), 'access:admin'), false, 'access:admin in keinem Scope');
  });

  test('Recht irgendwo (canSomewhere), Rechte an org, Rollen an org', () => {
    const a = acl([tuple(me, 'editor', 'folder', U(11)), tuple(me, 'viewer'), tuple(me, 'member', 'team', U(31))]);
    assert.equal(acc.somewhere(p(), a, 'note:write'), true);
    assert.equal(acc.decide(p(), a, 'note:write'), false);
    assert.equal(acc.somewhere(p(), a, 'members:admin'), false);
    assert.deepEqual(acc.rolesAtOrg(p(), a), ['viewer']);
    assert.deepEqual(acc.orgPermissions(p(), a), ['tenant:read', 'note:read', 'team:read', 'view:read']);
    const some = acc.somewherePermissions(p(), a);
    for (const x of ['note:write', 'note:share', 'view:write', 'access:admin']) assert.ok(some.includes(x as never), x);
    assert.equal(acc.somewhere(p(), acl([tuple(me, 'member', 'team', U(31))]), 'note:read'), true, 'Zuständigkeit (member) zählt irgendwo');
    assert.equal(acc.somewhere(p({ scopeBound: true, scopes: [] }), a, 'note:write'), false);
  });

  test('Client: Freigabe nur mit nicht abgelaufenem Rollen-Tupel an org', () => {
    assert.equal(acc.clientGranted(acl([tuple(`client:${U(2)}`, 'viewer')]), U(2)), true);
    assert.equal(acc.clientGranted(acl([tuple(`client:${U(2)}`, 'viewer', 'org', null, new Date(Date.now() - 1))]), U(2)), false);
    assert.equal(acc.clientGranted(acl([tuple(`client:${U(3)}`, 'viewer')]), U(2)), false);
  });

  test('Fähigkeiten je Ressource mit Fakten', () => {
    const a = acl([tuple(me, 'viewer')]);
    assert.deepEqual(capabilities(acc, p(), a, 'note', U(21)), { write: false, share: false });
    assert.deepEqual(capabilities(acc, p(), acl([tuple(me, 'editor')]), 'note', U(21)), { write: true, share: true });
  });

  test('Standardfälle des Test-Kits', async () => {
    const decide = async (c: ReturnType<typeof accessCases>[number]) => {
      const who = p({ kind: c.who.kind, groups: c.who.groupInToken ? [G1] : [], scopes: c.who.scopes ?? [], scopeBound: c.who.scopes !== undefined });
      const subj = (s: string) => (s === 'me' ? who.subjects[0]! : s === 'group' ? `group:${G1}` : s);
      return acc.decide(who, acl(c.tuples.map(t => tuple(subj(t.subject), t.relation, 'org', null, t.expired ? new Date(Date.now() - 1000) : null))), c.permission);
    };
    assert.deepEqual(await runAccessCases(accessCases(notesModel.toJSON()), decide), []);
  });
});

describe('Entscheidung mit PostgreSQL', { skip }, () => {
  const dbs = notesDb();
  let t: Awaited<ReturnType<typeof dbs.create>>;
  let A: string;
  let acc: AccessService<string, NotesState>;
  before(async () => {
    t = await dbs.create();
    A = await tenant(t.runtime, 'acme');
    acc = new AccessService(t.runtime, { model: notesModel, schema: 'notes', resources: notesResources });
  });
  after(async () => { await t?.drop(); });

  test('accessTag ändert sich, wenn ein Tupel mit Ablauf abläuft (ohne neue Version, vor dem Aufräumen)', async ctx => {
    const pid = await person(t.runtime, A, 'tag-expiry');
    const who = p({ tenantId: A, principalId: pid, subjects: [`user:${pid}`, 'org:members'] });
    const id = await grant(t.runtime, A, `user:${pid}`, 'viewer', { type: 'org' }, new Date(Date.now() + 3_600_000));
    const live = await acc.accessTag(who);
    const version = (await acc.load(A)).version;
    // Zwei Stunden später, gleiche Version (der Worker hat noch nicht aufgeräumt)
    ctx.mock.timers.enable({ apis: ['Date'], now: Date.now() + 7_200_000 });
    try {
      assert.equal((await acc.load(A)).version, version, 'gleiche Version');
      assert.notEqual(await acc.accessTag(who), live, 'abgelaufen: anderer Tag');
    } finally { ctx.mock.timers.reset(); }
    await full(t.runtime, A, tx => tx.query('DELETE FROM notes.authz_tuple WHERE id = $1', [id]));
  });

  test('Zuständigkeit über untergeordnete Teams (inherits), Tiefe 16, Kreis endet', async () => {
    const root = await team(t.runtime, A, 'root');
    let cur = root;
    const chain = [root];
    for (let i = 0; i < 18; i++) { cur = await team(t.runtime, A, `t${i}`, cur); chain.push(cur); }
    const off = await team(t.runtime, A, 'aus', root, false);
    const pid = await person(t.runtime, A, 'sub-units');
    await grant(t.runtime, A, `user:${pid}`, 'member', { type: 'team', id: root });
    const who = p({ tenantId: A, principalId: pid });
    const units = await acc.fullTx(A, async tx => acc.units(tx, who, await acc.load(A)));
    assert.ok(units.has(root) && units.has(chain[16]!), 'bis Tiefe 16');
    assert.ok(!units.has(chain[17]!), 'nicht tiefer');
    assert.ok(!units.has(off), 'ohne inherits_scope');
    // Kreis: root ← letzter
    await full(t.runtime, A, tx => tx.query('UPDATE notes.team SET parent_id = $1 WHERE id = $2', [chain[3], root]));
    const again = await acc.fullTx(A, async tx => acc.units(tx, who, await acc.load(A)));
    assert.ok(again.has(chain[3]!));

    const { note } = await folderWithNote(t.runtime, A, 'Zuständig', { team: chain[2], grants: 'edit' });
    assert.equal(await acc.can(who, 'note:write', { type: 'note', id: note }), true);
    const { note: n2 } = await folderWithNote(t.runtime, A, 'Lesen', { team: chain[2], grants: 'read' });
    assert.equal(await acc.can(who, 'note:read', { type: 'note', id: n2 }), true);
    assert.equal(await acc.can(who, 'note:write', { type: 'note', id: n2 }), false);
  });

  test('Klassifizierung aus der Datenbank; 403 mit Grund clearance', async () => {
    const pid = await person(t.runtime, A, 'classified');
    await grant(t.runtime, A, `user:${pid}`, 'org-admin');
    const { note } = await folderWithNote(t.runtime, A, 'Geheim', { classification: 2 });
    const who = p({ tenantId: A, principalId: pid });
    assert.equal(await acc.can(who, 'note:read', { type: 'note', id: note }), false);
    await assert.rejects(acc.require(who, 'note:read', { type: 'note', id: note }), (e: { status: number; extra: { reason: string } }) => e.status === 403 && e.extra.reason === 'clearance');
    await full(t.runtime, A, tx => tx.query('UPDATE notes.principal SET clearance = 2 WHERE id = $1', [pid]));
    assert.equal(await acc.can(who, 'note:read', { type: 'note', id: note }), true, 'sofort (acl_version)');
    await assert.rejects(acc.requireClearance({ ...who, principalId: U(99) }, 1), (e: { extra: { reason: string } }) => e.extra.reason === 'clearance');
  });

  test('Zwischenspeicher bis acl_version: neues Tupel wirkt sofort, ohne Änderung derselbe Stand', async () => {
    const a1 = await acc.load(A), a2 = await acc.load(A);
    assert.equal(a1, a2);
    const pid = await person(t.runtime, A, 'cache');
    await grant(t.runtime, A, `user:${pid}`, 'viewer');
    const a3 = await acc.load(A);
    assert.notEqual(a3.version, a1.version);
    assert.equal(acc.decide(p({ tenantId: A, principalId: pid }), a3, 'note:read'), true);
  });

  test('Aufräumen: abgelaufene Tupel gelöscht mit access.expired, abgelaufenes Break-Glass mit break_glass.ended', async () => {
    const pid = await person(t.runtime, A, 'expire');
    await grant(t.runtime, A, `user:${pid}`, 'viewer', { type: 'org' }, new Date(Date.now() + 200));
    await full(t.runtime, A, tx => tx.query("UPDATE notes.principal SET clearance_boost = 2, clearance_until = now() + interval '200 milliseconds' WHERE id = $1", [pid]));
    await new Promise(r => setTimeout(r, 300));
    const r = await expireAccess({ schema: 'notes', audit: pgAudit({ schema: 'notes' }) }, t.runtime, A);
    assert.deepEqual(r, { expired: 1, breakGlassEnded: 1 });
    const log = await withTenant(t.runtime, { tenantId: A }, async tx => (await tx.query<{ action: string; data: Record<string, unknown> }>("SELECT action, data FROM notes.audit_log WHERE action IN ('access.expired', 'break_glass.ended') ORDER BY seq")).rows);
    assert.deepEqual(log.map(x => x.action), ['access.expired', 'break_glass.ended']);
    assert.equal(log[0]!.data.subject, `user:${pid}`);
    assert.equal(log[1]!.data.expired, true);
    assert.deepEqual(await expireAccess({ schema: 'notes', audit: pgAudit({ schema: 'notes' }) }, t.runtime, A), { expired: 0, breakGlassEnded: 0 });
  });
});
