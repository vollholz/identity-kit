/**
 * Warteschlange (app-boilerplate 5.9): Einreihen in der fachlichen Transaktion, Abholen über alle Mandanten, Kontext des
 * Mandanten im Job, Backoff, endgültiger Fehler, Obergrenze je Mandant, gesperrte Mandanten, Dedupe, verwaiste Jobs,
 * feste Aufgaben höchstens einmal gleichzeitig.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { backoffMs, PermanentJobError, Worker, type JobDefinition } from '../src/index.ts';
import { app } from './fixture/app.ts';
import { enqueue, fullTx, platform } from './fixture/platform.ts';
import { createTestDb, full, skipDb, tenant, type Harness } from './harness.ts';

const skip = await skipDb();
const quiet = { info() {}, warn() {}, error() {} };

describe('Warteschlange', { skip }, () => {
  let t: Harness;
  let A: string, B: string;
  const seen: { kind: string; tenant: string | null; payload: unknown }[] = [];
  let fail = 0;
  const jobs: JobDefinition<any>[] = [
    { kind: 'test.ok', run: async (ctx, p) => { seen.push({ kind: 'test.ok', tenant: await ctx.tx(async tx => (await tx.query('SELECT app.tenant_id() AS t')).rows[0].t), payload: p }); } },
    { kind: 'test.flaky', maxAttempts: 2, run: async () => { if (fail-- > 0) throw new Error('vorübergehend'); } },
    { kind: 'test.permanent', run: async () => { throw new PermanentJobError('nie wieder'); } },
  ];
  const cfg = app.loadConfig({ NODE_ENV: 'test', OIDC_ISSUER_URL: 'http://idp.test/realms/x', DATABASE_URL: 'postgres://x@localhost/x', WORKER_TENANT_LIMIT: '1' }, null);
  let worker: Worker;

  before(async () => {
    t = await createTestDb();
    A = await tenant(t.runtime, 'alpha');
    B = await tenant(t.runtime, 'beta');
    worker = new Worker({ platform: platform.context, fullTx, db: t.worker, cfg, log: quiet, jobs });
  });
  after(async () => { await t?.drop(); });

  const status = (id: string, tid: string) => full(t.runtime, tid, async tx => (await tx.query('SELECT status, attempts, last_error FROM probe.job WHERE id = $1', [id])).rows[0]);
  const drain = async () => { for (let c = await worker.claim(); c; c = await worker.claim()) await worker.execute(c); };

  test('Job läuft im Kontext seines Mandanten; Dedupe hält einen offenen Auftrag je Schlüssel', async () => {
    const id = await full(t.runtime, A, tx => enqueue(tx, 'test.ok', { n: 1 }, { dedupeKey: 'x' }));
    assert.equal(await full(t.runtime, A, tx => enqueue(tx, 'test.ok', { n: 2 }, { dedupeKey: 'x' })), null);
    await drain();
    assert.deepEqual(seen, [{ kind: 'test.ok', tenant: A, payload: { n: 1 } }]);
    assert.equal((await status(id!, A)).status, 'done');
  });

  test('Fehler: Backoff, danach endgültig; PermanentJobError sofort', async () => {
    fail = 10;
    const id = (await full(t.runtime, A, tx => enqueue(tx, 'test.flaky', {})))!;
    await drain();
    let s = await status(id, A);
    assert.deepEqual([s.status, s.attempts, s.last_error], ['queued', 1, 'vorübergehend']);
    await t.worker.query('UPDATE probe.job SET run_at = now() WHERE id = $1', [id]);
    await drain();
    s = await status(id, A);
    assert.deepEqual([s.status, s.attempts], ['failed', 2]);
    const p = (await full(t.runtime, B, tx => enqueue(tx, 'test.permanent', {})))!;
    await drain();
    assert.equal((await status(p, B)).status, 'failed');
    assert.ok(backoffMs(1) >= 8_000 && backoffMs(1) <= 12_000 && backoffMs(30) <= 4_320_000);
  });

  test('Obergrenze je Mandant und gesperrte Mandanten', async () => {
    await full(t.runtime, A, async tx => { await enqueue(tx, 'test.ok', { a: 1 }); await enqueue(tx, 'test.ok', { a: 2 }); });
    const first = await worker.claim();
    assert.equal(first?.tenant_id, A);
    assert.equal(await worker.claim(), null, 'WORKER_TENANT_LIMIT=1: zweiter Job von A wartet');
    await worker.execute(first!);
    await t.inspect.query("UPDATE probe.tenant SET status = 'suspended' WHERE id = $1", [A]);
    assert.equal(await worker.claim(), null, 'gesperrt: nichts abholen');
    await t.inspect.query("UPDATE probe.tenant SET status = 'active' WHERE id = $1", [A]);
    await drain();
  });

  test('verwaiste Jobs werden neu eingereiht', async () => {
    const id = (await full(t.runtime, B, tx => enqueue(tx, 'test.ok', {})))!;
    const c = (await worker.claim())!;
    assert.equal(c.id, id);
    await t.worker.query("UPDATE probe.job SET heartbeat_at = now() - interval '20 minutes' WHERE id = $1", [id]);
    // Eine andere Instanz räumt auf (die eigene erneuert ihr Lebenszeichen)
    const other = new Worker({ platform: platform.context, fullTx, db: t.worker, cfg, log: quiet, jobs });
    await other.heartbeat();
    assert.equal((await status(id, B)).status, 'queued');
    // Die andere Instanz holt ihn; die alte meldet sich verspätet zurück und überschreibt nichts
    const c2 = (await other.claim())!;
    assert.equal(c2.id, id);
    await worker.execute(c);
    const held = (await t.inspect.query('SELECT status, locked_by FROM probe.job WHERE id = $1', [id])).rows[0];
    assert.deepEqual(held, { status: 'running', locked_by: other.id });
    await other.execute(c2);
    assert.equal((await status(id, B)).status, 'done');
  });

  test('Beenden wartet auf laufende feste Aufgaben', async () => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>(r => { started = r; });
    const task = { name: 'test.lang', intervalMs: () => 10, run: () => { started(); return new Promise<void>(r => { release = r; }); } };
    const w = new Worker({ platform: platform.context, fullTx, db: t.worker, cfg, log: quiet, jobs: [], tasks: [task] });
    w.start();
    await begun;
    let stopped = false;
    const stopping = w.stop().then(() => { stopped = true; });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(stopped, false, 'Aufgabe läuft noch');
    release();
    await stopping;
    assert.equal(stopped, true);
  });

  test('feste Aufgabe läuft höchstens einmal gleichzeitig', async () => {
    let release!: () => void;
    let runs = 0;
    const task = { name: 'test.task', intervalMs: () => 0, run: () => { runs++; return new Promise<void>(r => { release = r; }); } };
    const other = new Worker({ platform: platform.context, fullTx, db: t.worker, cfg, log: quiet, jobs: [] });
    const p = worker.runTask(task);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(await other.runTask(task), false);
    release();
    assert.equal(await p, true);
    assert.equal(runs, 1);
  });
});
