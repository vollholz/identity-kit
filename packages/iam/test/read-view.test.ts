/**
 * Lesesicht = `can` (Spezifikation Kap. 7.6, Pflichttest `read-view` in Kap. 14): Für ein Modell mit allen Wegen liefert
 * eine Liste unter RLS genau die Ressourcen mit `can(read)`, Schreiben unter `USING`/`WITH CHECK` genau die mit
 * `can(write)` – auch für scope-gebundene Zugriffe (Tupel, Zuständigkeit über Einheiten und über Personen aus
 * Fachdaten, org ohne passenden Scope ergeben nichts).
 * Die Policies der Notiz-App folgen dem Muster aus Kap. 7.6 (test/support/http.ts).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { subjectsOf } from '../src/access.ts';
import { pgAudit } from '../src/audit.ts';
import { createIam, type Iam } from '../src/iam.ts';
import type { Principal } from '../src/principal.ts';
import { testConfig } from './support/config.ts';
import { skipDb } from './support/db.ts';
import { folderWithNote, full, grant, notesDb, notesResources, person, responsible, team, tenant, view, type NotesState } from './support/http.ts';
import { notesModel } from './support/models.ts';

const skip = await skipDb();
const G1 = '0b6f2f7e-4c1d-4d2b-9a55-1f0c7c2d9e11';

describe('Lesesicht = can', { skip }, () => {
  const dbs = notesDb();
  let t: Awaited<ReturnType<typeof dbs.create>>;
  let iam: Iam<string, NotesState>;
  let A: string, B: string;
  const notes: string[] = [], views: string[] = [];
  let F1: string, F2: string, F3: string, T1: string, T2: string, N: Record<string, string>;

  before(async () => {
    t = await dbs.create();
    iam = createIam({ cfg: testConfig('http://idp.test/realms/notes'), model: notesModel, db: t.runtime, schema: 'notes', resources: notesResources, audit: pgAudit({ schema: 'notes' }), bff: false });
    A = await tenant(t.runtime, 'acme'); B = await tenant(t.runtime, 'globex');
    T1 = await team(t.runtime, A, 'Abteilung'); T2 = await team(t.runtime, A, 'Gruppe', T1);
    const a = await folderWithNote(t.runtime, A, 'F1');
    F1 = a.folder;
    const b = await folderWithNote(t.runtime, A, 'F2', { parent: F1, classification: 1 });
    F2 = b.folder;
    const c = await folderWithNote(t.runtime, A, 'F3', { team: T2, grants: 'read' });
    F3 = c.folder;
    const d = await folderWithNote(t.runtime, A, 'F4', { team: T1, grants: 'edit', classification: 2 });
    const e = await folderWithNote(t.runtime, A, 'F5', { team: T1, grants: 'none' });
    N = { a: a.note, b: b.note, c: c.note, d: d.note, e: e.note };
    notes.push(...Object.values(N));
    views.push(await view(t.runtime, A, 'V1'), await view(t.runtime, A, 'V2'));
    // Fremder Mandant: nie sichtbar
    await folderWithNote(t.runtime, B, 'fremd');
  });
  after(async () => { await t?.drop(); });

  /** Szenarien: Tupel eines Subjekts, Freigabestufe, Scopes. */
  /** `persons`: Notiz (Schlüssel in N) → Wirkung der eigenen Zuständigkeit über Fachdaten (`edges.persons`). */
  const scenarios: { name: string; tuples: (me: string) => [string, string, string, string | null][]; clearance?: 0 | 1 | 2; groups?: string[]; scopes?: string[]; client?: boolean; persons?: Record<string, 'none' | 'read' | 'edit'> }[] = [
    { name: 'ohne Tupel', tuples: () => [] },
    { name: 'viewer an org', tuples: me => [[me, 'viewer', 'org', null]] },
    { name: 'editor an org, Stufe 2', tuples: me => [[me, 'editor', 'org', null]], clearance: 2 },
    { name: 'org-admin ohne Stufe', tuples: me => [[me, 'org-admin', 'org', null]] },
    { name: 'editor am Ordner F1 (mit Unterordner F2), Stufe 1', tuples: me => [[me, 'editor', 'folder', F1]], clearance: 1 },
    { name: 'viewer am Unterordner F2', tuples: me => [[me, 'viewer', 'folder', F2]], clearance: 1 },
    { name: 'viewer an Notiz a, editor an Notiz e', tuples: me => [[me, 'viewer', 'note', N.a!], [me, 'editor', 'note', N.e!]] },
    { name: 'member am Team T1 (Zuständigkeit, auch T2 darunter), Stufe 2', tuples: me => [[me, 'member', 'team', T1]], clearance: 2 },
    { name: 'Gruppe aus Entra member an T2', tuples: () => [[`group:${G1}`, 'member', 'team', T2]], groups: [G1] },
    { name: 'Alle Mitglieder viewer an F3, owner von V1', tuples: me => [['org:members', 'viewer', 'folder', F3], [me, 'owner', 'view', views[0]!]] },
    { name: 'scopeBound: editor an org mit notes:read', tuples: me => [[me, 'editor', 'org', null]], scopes: ['notes:read'], clearance: 2 },
    { name: 'scopeBound: editor an F1 und member T1 ohne Scope', tuples: me => [[me, 'editor', 'folder', F1], [me, 'member', 'team', T1]], scopes: [], clearance: 2 },
    { name: 'scopeBound: member T1 mit notes:write (ohne Lesen)', tuples: me => [[me, 'member', 'team', T1]], scopes: ['notes:write'], clearance: 2 },
    { name: 'Client editor an org mit beiden Scopes', tuples: me => [[me, 'editor', 'org', null]], scopes: ['notes:read', 'notes:write'], client: true },
    { name: 'Person zuständig: a read, e edit, d edit über der Stufe, c none', tuples: () => [], persons: { a: 'read', e: 'edit', d: 'edit', c: 'none' } },
    { name: 'Person zuständig mit Stufe 2: d edit', tuples: () => [], persons: { d: 'edit' }, clearance: 2 },
    { name: 'scopeBound: Person zuständig edit an a, e mit notes:read', tuples: () => [], persons: { a: 'edit', e: 'edit' }, scopes: ['notes:read'] },
    { name: 'scopeBound: Person zuständig edit an a ohne Scope', tuples: () => [], persons: { a: 'edit' }, scopes: [] },
    { name: 'Client als zuständige «Person» eingetragen: nichts', tuples: () => [], persons: { a: 'edit' }, scopes: ['notes:read', 'notes:write'], client: true },
  ];

  let n = 0;
  for (const s of scenarios) {
    test(s.name, async () => {
      n++;
      const pid = s.client
        ? (await full(t.runtime, A, tx => tx.query<{ id: string }>("INSERT INTO notes.principal (tenant_id, kind, subject, client_id, last_seen_at) VALUES ($1, 'client', $2, $2, NULL) RETURNING id", [A, `client-${n}`]))).rows[0]!.id
        : await person(t.runtime, A, `rv-${n}`, { clearance: s.clearance ?? 0 });
      const base: Principal = {
        tenantId: A, tenantAlias: 'acme', principalId: pid, kind: s.client ? 'client' : 'user', subject: `rv-${n}`, name: 'x', email: null, clientId: null,
        groups: s.groups ?? [], subjects: [], scopes: s.scopes ?? [], scopeBound: s.scopes !== undefined, platformAdmin: false, binding: 'none', token: '',
      };
      const p: Principal = { ...base, subjects: subjectsOf(base) };
      for (const [subject, relation, type, id] of s.tuples(p.subjects[0]!)) await grant(t.runtime, A, subject, relation, { type, id });
      for (const [k, g] of Object.entries(s.persons ?? {})) await responsible(t.runtime, A, N[k]!, pid, g);
      // Freigabestufe beim Anlegen des Principals ohne neues Tupel: Zwischenspeicher verwerfen
      if (s.persons) iam.access.invalidate(A);

      const readable = new Set(await iam.tx(p, async tx => (await tx.query<{ id: string }>('SELECT id FROM notes.note')).rows.map(r => r.id)));
      const writable = new Set<string>();
      for (const id of notes) {
        const ok = await iam.tx(p, async tx => {
          await tx.query('SAVEPOINT w');
          const r = await tx.query('UPDATE notes.note SET title = title WHERE id = $1', [id]).catch(() => ({ rowCount: 0 }));
          await tx.query('ROLLBACK TO SAVEPOINT w');
          return (r.rowCount ?? 0) > 0;
        });
        if (ok) writable.add(id);
      }
      const canRead = new Set<string>(), canWrite = new Set<string>();
      for (const id of notes) {
        if (await iam.access.can(p, 'note:read', { type: 'note', id })) canRead.add(id);
        if (await iam.access.can(p, 'note:write', { type: 'note', id }) && canRead.has(id)) canWrite.add(id);
      }
      const name = (ids: Set<string>) => Object.entries(N).filter(([, v]) => ids.has(v)).map(([k]) => k).sort();
      assert.deepEqual(name(readable), name(canRead), 'Lesen');
      assert.deepEqual(name(writable), name(canWrite), 'Schreiben (USING und WITH CHECK)');
      const seenViews = new Set(await iam.tx(p, async tx => (await tx.query<{ id: string }>('SELECT id FROM notes.view')).rows.map(r => r.id)));
      for (const v of views) assert.equal(seenViews.has(v), await iam.access.can(p, 'view:read', { type: 'view', id: v }), `Ansicht ${v}`);
      // Einfügen (WITH CHECK) gleich wie can(write) am Ordner
      for (const f of [F1, F2, F3]) {
        const inserted = await iam.tx(p, async tx => {
          await tx.query('SAVEPOINT i');
          const ok = await tx.query("INSERT INTO notes.note (tenant_id, folder_id, title) VALUES (app.tenant_id(), $1, 'neu')", [f]).then(() => true, () => false);
          await tx.query('ROLLBACK TO SAVEPOINT i');
          return ok;
        });
        assert.equal(inserted, await iam.access.can(p, 'note:write', { type: 'folder', id: f }), `Einfügen im Ordner ${f}`);
      }
      // Erwartungen, damit der Vergleich nicht leer grün ist
      if (s.name === 'ohne Tupel') assert.equal(readable.size, 0);
      if (s.name === 'editor an org, Stufe 2') assert.equal(readable.size, 5);
      if (s.name === 'org-admin ohne Stufe') assert.deepEqual(name(readable), ['a', 'c', 'e'], 'Klassifizierung gilt auch für org-admin');
      if (s.name.startsWith('member am Team')) assert.deepEqual([name(readable), name(writable)], [['c', 'd'], ['d']]);
      if (s.name.startsWith('scopeBound: editor an F1')) assert.equal(readable.size, 0);
      if (s.name.startsWith('scopeBound: member T1 mit notes:write')) assert.equal(readable.size, 0);
      // c lesen alle Personen über «Alle Mitglieder viewer an F3» (Tupel eines früheren Szenarios)
      if (s.name.startsWith('Person zuständig: a read')) assert.deepEqual([name(readable), name(writable)], [['a', 'c', 'e'], ['e']]);
      if (s.name.startsWith('Person zuständig mit Stufe 2')) assert.deepEqual([name(readable), name(writable)], [['c', 'd'], ['d']]);
      if (s.name.startsWith('scopeBound: Person zuständig edit an a, e mit notes:read')) assert.deepEqual([name(readable), name(writable)], [['a', 'c', 'e'], []]);
      if (s.name.startsWith('scopeBound: Person zuständig edit an a ohne') || s.name.startsWith('Client als')) assert.equal(readable.size, 0);
    });
  }

  test('fremder Mandant sieht nichts, volle Sicht nur intern', async () => {
    const pid = await person(t.runtime, B, 'other', { clearance: 2 });
    await grant(t.runtime, B, `user:${pid}`, 'org-admin');
    const base: Principal = { tenantId: B, tenantAlias: 'globex', principalId: pid, kind: 'user', subject: 'other', name: 'x', email: null, clientId: null, groups: [], subjects: [], scopes: [], platformAdmin: false, binding: 'none', token: '' };
    const p = { ...base, subjects: subjectsOf(base) };
    const seen = await iam.tx(p, async tx => (await tx.query<{ id: string }>('SELECT id FROM notes.note')).rows.map(r => r.id));
    assert.equal(seen.length, 1);
    assert.ok(!notes.some(id => seen.includes(id)));
  });
});
