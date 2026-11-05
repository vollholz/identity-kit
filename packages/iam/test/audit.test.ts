/**
 * Audit mit betroffener Person und Suche (iam_021, audit.ts): bestehende Kette bleibt gültig, `subject` gehört zum Hash,
 * Aufrufe ohne `subject` laufen auch vor der Migration, Suche mit Filtern, Rückfall und Seiten über (ts, seq), Lesen
 * nach Recht nur auf Wunsch der App (`app.audit_read_permission`).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pgAudit, pgAuditSearch, type Actor, type AuditQuery } from '../src/audit.ts';
import { withTenant } from '../src/db.ts';
import { HttpError } from '../src/errors.ts';
import { iamMigrations, migrate } from '../src/migrations.ts';
import { productDb, skipDb } from './support/db.ts';

const skip = await skipDb();

const P1 = '11111111-1111-4111-8111-111111111111', P2 = '22222222-2222-4222-8222-222222222222';
const M1 = 'aaaaaaaa-0000-4000-8000-000000000001', M2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const anna: Actor = { principal: { kind: 'user', principalId: P1, name: 'Anna', clientId: null }, source: 'ui', correlationId: 'req-1' };
const bot: Actor = { principal: { kind: 'client', principalId: P2, name: 'Bot', clientId: 'bot' }, source: 'api' };
const audit = pgAudit({ schema: 'notes' });
const FROM = new Date('2000-01-01T00:00:00Z'), TO = new Date('2100-01-01T00:00:00Z');

describe('Audit: betroffene Person und Suche (iam_021)', { skip }, () => {
  const iam = iamMigrations({ product: 'notes' });
  // Bestand vor iam_021: Einträge mit der alten Kette, dann Migration
  const db = productDb({ iam: false, sources: [{ ...iam, migrations: iam.migrations.filter(m => m.name < 'iam_021') }] });
  let t: Awaited<ReturnType<typeof db.create>>;
  let A: string, B: string;
  const chain = async (tenant: string) => (await t.inspect.query<{ seq: string; hash: Buffer; ok: boolean; linked: boolean }>(`
    SELECT seq, hash, hash = app.audit_hash(prev_hash, l) AS ok, prev_hash IS NOT DISTINCT FROM lag(hash) OVER (ORDER BY seq) AS linked
      FROM notes.audit_log l WHERE tenant_id = $1 ORDER BY seq`, [tenant])).rows;
  const search = pgAuditSearch({ schema: 'notes', subjectFallback: { dataKeys: ['personId'], resourceTypes: ['person'] } });
  const find = (q: Partial<AuditQuery>, tenant = A, settings: Record<string, string> = {}) =>
    withTenant(t.runtime, { tenantId: tenant, settings }, tx => search(tx, { from: FROM, to: TO, ...q }));

  before(async () => {
    t = await db.create();
    const r = async (alias: string) => (await t.runtime.query<{ id: string }>('SELECT app.resolve_tenant($1, null, $1, true) AS id', [alias])).rows[0]!.id;
    A = await r('alpha'); B = await r('beta');
  });
  after(async () => { await t?.drop(); });

  test('vor der Migration: record ohne subject läuft, mit subject scheitert (Spalte fehlt)', async () => {
    await withTenant(t.runtime, { tenantId: A }, async tx => {
      await audit.write(tx, anna, { action: 'person.updated', resourceType: 'person', resourceId: M1, data: { name: 'x' } });
      await audit.write(tx, anna, { action: 'shift.updated', resourceType: 'shift', resourceId: M2, data: { personId: M1 } });
      await audit.write(tx, bot, { action: 'shift.created', resourceType: 'shift', resourceId: M2, data: { personId: M2 } });
    });
    await assert.rejects(withTenant(t.runtime, { tenantId: A }, tx => audit.write(tx, anna, { action: 'x', subject: M1 })), /subject_id/);
  });

  test('Migration: bestehende Hashes unverändert und gültig, Kette läuft weiter', async () => {
    const before = await chain(A);
    assert.equal(before.length, 3);
    const r = await migrate(t.adminUrl, [iam]);
    assert.deepEqual(r.applied, ['iam_021_audit_subject.sql']);
    const now = await chain(A);
    assert.deepEqual(now.map(x => x.hash.toString('hex')), before.map(x => x.hash.toString('hex')));
    assert.ok(now.every(x => x.ok && x.linked));
  });

  test('record mit und ohne subject: Kette lückenlos, subject gehört zum Hash, ungültiges subject abgelehnt', async () => {
    await withTenant(t.runtime, { tenantId: A }, async tx => {
      await audit.write(tx, anna, { action: 'absence.created', resourceType: 'absence', resourceId: M2, subject: M1, data: { days: 2 } });
      await audit.write(tx, anna, { action: 'note.created', resourceType: 'note', resourceId: M2 });
      await audit.write(tx, bot, { action: 'absence.created', resourceType: 'absence', resourceId: M1, subject: 'extern:42' });
    });
    const rows = await chain(A);
    assert.deepEqual(rows.map(x => Number(x.seq)), [1, 2, 3, 4, 5, 6]);
    assert.ok(rows.every(x => x.ok && x.linked));
    // Version 3 nur mit Person: subject ändern bricht den Hash, ohne Person bleibt Version 2
    await t.inspect.query('BEGIN');
    try {
      await t.inspect.query("UPDATE notes.audit_log SET subject_id = 'anders' WHERE tenant_id = $1 AND seq = 4", [A]);
      assert.equal((await t.inspect.query('SELECT hash = app.audit_hash(prev_hash, l) AS ok FROM notes.audit_log l WHERE tenant_id = $1 AND seq = 4', [A])).rows[0].ok, false);
    } finally { await t.inspect.query('ROLLBACK'); }
    for (const bad of ['', 'x'.repeat(201)]) {
      await assert.rejects(withTenant(t.runtime, { tenantId: A }, tx => audit.write(tx, anna, { action: 'x', subject: bad })), /subject/);
      await assert.rejects(withTenant(t.runtime, { tenantId: A }, tx => tx.query("INSERT INTO notes.audit_log (tenant_id, actor_kind, source, action, subject_id) VALUES ($1, 'system', 'system', 'x', $2)", [A, bad])), /audit_log_subject_id_check/);
    }
    const idx = (await t.inspect.query<{ n: string; d: string }>("SELECT indexname AS n, indexdef AS d FROM pg_indexes WHERE schemaname = 'notes' AND indexname IN ('audit_log_subject', 'audit_log_actor_ts') ORDER BY 1")).rows;
    assert.deepEqual(idx.map(x => x.n), ['audit_log_actor_ts', 'audit_log_subject']);
    assert.match(idx[1]!.d, /\(tenant_id, subject_id, ts\) WHERE \(subject_id IS NOT NULL\)/);
  });

  test('Suche nach Person: subject_id, Rückfall über data und Objekt nur für Einträge ohne subject_id', async () => {
    const m1 = await find({ subject: M1 });
    // seq 4 (subject), seq 2 (data.personId), seq 1 (Objekt person); nicht seq 6 (resource_id M1, aber andere Art)
    assert.deepEqual(m1.items.map(x => x.seq), [4, 2, 1]);
    assert.deepEqual(m1.items.map(x => x.subject), [M1, null, null]);
    assert.equal(m1.nextCursor, null);
    assert.deepEqual((await find({ subject: M2 })).items.map(x => x.seq), [3]);
    assert.deepEqual((await find({ subject: 'extern:42' })).items.map(x => x.seq), [6]);
    // ohne Rückfall nur subject_id
    const plain = pgAuditSearch({ schema: 'notes' });
    assert.deepEqual((await withTenant(t.runtime, { tenantId: A }, tx => plain(tx, { subject: M1, from: FROM, to: TO }))).items.map(x => x.seq), [4]);
    const e = (await find({ subject: M1, order: 'asc', limit: 1 })).items[0]!;
    assert.deepEqual({ ...e, ts: undefined }, {
      seq: 1, ts: undefined, actor: { kind: 'user', id: P1, name: 'Anna', clientId: null }, source: 'ui', action: 'person.updated', resourceType: 'person',
      resourceId: M1, subject: null, correlationId: 'req-1', data: { name: 'x' },
    });
    assert.ok(e.ts instanceof Date);
  });

  test('Suche nach Objekt, Akteur und Zeitraum; andere Organisation sieht nichts', async () => {
    assert.deepEqual((await find({ resourceType: 'shift', resourceId: M2 })).items.map(x => x.seq), [3, 2]);
    assert.deepEqual((await find({ resourceType: 'absence' })).items.map(x => x.seq), [6, 4]);
    assert.deepEqual((await find({ actor: P2 })).items.map(x => x.seq), [6, 3]);
    assert.deepEqual((await find({ actor: P2, resourceType: 'shift' })).items.map(x => x.seq), [3]);
    const ts = (await t.inspect.query<{ ts: Date }>('SELECT max(ts) AS ts FROM notes.audit_log WHERE tenant_id = $1', [A])).rows[0]!.ts;
    assert.deepEqual((await find({ to: ts })).items.length, (await find({})).items.length - (await find({ from: ts })).items.length);
    assert.deepEqual((await find({ from: new Date(ts.getTime() + 1) })).items, []);
    assert.deepEqual((await find({}, B)).items, []);
    assert.deepEqual((await find({ subject: M1 }, B)).items, []);
  });

  test('Seiten über (ts, seq): gleiche Zeit in einer Transaktion, absteigend und aufsteigend, ohne Lücken', async () => {
    await withTenant(t.runtime, { tenantId: B }, async tx => {
      for (let i = 0; i < 7; i++) await audit.write(tx, anna, { action: `page.${i}`, resourceType: 'page', resourceId: M1, subject: M2 });
    });
    for (const order of ['desc', 'asc'] as const) {
      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const page = await find({ subject: M2, order, limit: 3, cursor }, B);
        assert.ok(page.items.length <= 3);
        seen.push(...page.items.map(x => x.seq));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(seen, order === 'desc' ? [7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7]);
    }
    const first = await find({ subject: M2, limit: 7 }, B);
    assert.equal(first.items.length, 7);
    assert.equal(first.nextCursor, null, 'genau voll: keine weitere Seite');
  });

  test('ungültige Eingaben und Cursor einer anderen Abfrage → 422', async () => {
    const page = await find({ subject: M2, limit: 2 }, B);
    assert.ok(page.nextCursor);
    const is422 = (e: unknown) => e instanceof HttpError && e.status === 422;
    await assert.rejects(find({ subject: M1, limit: 2, cursor: page.nextCursor }, B), is422);
    await assert.rejects(find({ subject: M2, limit: 2, order: 'asc', cursor: page.nextCursor }, B), is422);
    await assert.rejects(find({ cursor: 'kaputt' }), is422);
    await assert.rejects(find({ resourceId: 'keine-uuid' }), is422);
    await assert.rejects(find({ actor: 'x' }), is422);
    await assert.rejects(find({ subject: '' }), is422);
    await assert.rejects(find({ from: TO, to: FROM }), is422);
    await assert.rejects(find({ from: 'gestern' }), is422);
    await assert.rejects(find({ limit: 0 }), is422);
    await assert.rejects(find({ limit: 201 }), is422);
    assert.throws(() => pgAuditSearch({ schema: 'notes', subjectFallback: { dataKeys: ["x' OR 1=1"] } }), TypeError);
  });

  test('Lesen nach Recht: ohne Aufruf wie bisher, mit app.audit_read_permission nur mit Recht; Anhängen bleibt', async () => {
    const count = (settings: Record<string, string> = {}) => withTenant(t.runtime, { tenantId: A, settings }, async tx => (await tx.query('SELECT count(*)::int AS n FROM notes.audit_log')).rows[0].n as number);
    const all = await count();
    assert.ok(all > 0, 'ohne Bindung liest jede Transaktion der Organisation');
    await assert.rejects(t.runtime.query("SELECT app.audit_read_permission('audit:read')"), /permission denied/);
    await assert.rejects(t.admin.query("SELECT app.audit_read_permission('audit read')"), /ungültig/);
    await t.admin.query("SELECT app.audit_read_permission('audit:read')");
    try {
      assert.equal(await count(), 0, 'ohne Recht');
      assert.equal(await count({ 'app.org_permissions': '{"other:read"}' }), 0, 'anderes Recht');
      assert.equal(await count({ 'app.org_permissions': '{"audit:read"}' }), all, 'mit Recht');
      assert.deepEqual((await find({ subject: M1 })).items, []);
      assert.deepEqual((await find({ subject: M1 }, A, { 'app.org_permissions': '{"audit:read"}' })).items.map(x => x.seq), [4, 2, 1]);
      // Anhängen ohne Leserecht: der Trigger liest den letzten Eintrag als Besitzer, die Kette bleibt lückenlos
      await withTenant(t.runtime, { tenantId: A }, tx => audit.write(tx, anna, { action: 'blind.write', subject: M1 }));
      const rows = await chain(A);
      assert.equal(Number(rows.at(-1)!.seq), rows.length);
      assert.ok(rows.every(x => x.ok && x.linked));
      const pol = (await t.inspect.query<{ p: string; c: string; r: string[]; q: string }>("SELECT permissive AS p, cmd AS c, roles::text[] AS r, qual AS q FROM pg_policies WHERE schemaname = 'notes' AND policyname = 'audit_read'")).rows;
      assert.deepEqual(pol, [{ p: 'RESTRICTIVE', c: 'SELECT', r: ['notes_app'], q: "app.has_permission('audit:read'::text)" }]);
      // erneut aufrufen ersetzt die Policy
      await t.admin.query("SELECT app.audit_read_permission('protokoll:read')");
      assert.equal(await count({ 'app.org_permissions': '{"audit:read"}' }), 0);
      assert.equal(await count({ 'app.org_permissions': '{"protokoll:read"}' }), all + 1);
    } finally {
      await t.admin.query('SELECT app.audit_read_permission(NULL)');
    }
    assert.equal(await count(), all + 1, 'NULL hebt die Bindung auf');
    const fn = (await t.inspect.query<{ secdef: boolean; config: string[] | null }>("SELECT prosecdef AS secdef, proconfig AS config FROM pg_proc WHERE oid = 'app.audit_chain()'::regprocedure")).rows[0];
    assert.deepEqual(fn, { secdef: false, config: null }, 'Trigger wieder wie vor dem Aufruf');
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'notes' AND policyname = 'audit_read'")).rows[0].n, 0);
  });
});
