/**
 * Betrieb (app-boilerplate 3.1): Betriebs-Endpunkt, geordnetes Beenden und Mandanten über die Kommandozeile.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createRuntime, metrics, startOpsServer } from '../src/index.ts';
import { app } from './fixture/app.ts';
import { createTestDb, full, skipDb, type Harness } from './harness.ts';

const quiet = { info() {}, warn() {}, error() {} };

describe('Betriebs-Endpunkt', () => {
  let ready = true;
  let checks: Record<string, boolean> = { db: true };
  let ops: Awaited<ReturnType<typeof startOpsServer>>;
  const get = (path: string) => fetch(`http://127.0.0.1:${ops.port}${path}`);

  before(async () => { ops = await startOpsServer({ port: 0, host: '127.0.0.1', ready: () => ready, checks: async () => checks, metrics: false, log: quiet }); });
  after(async () => { await ops.close(); });

  test('/healthz immer 200', async () => {
    const r = await get('/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok' });
  });

  test('/readyz: 200 bereit, 503 beim Beenden und bei gescheiterter Prüfung', async () => {
    assert.equal((await get('/readyz')).status, 200);
    checks = { db: false };
    const r = await get('/readyz');
    assert.equal(r.status, 503);
    assert.deepEqual((await r.json() as { checks: unknown }).checks, { db: false });
    checks = { db: true };
    ready = false;
    assert.equal((await get('/readyz')).status, 503);
    ready = true;
  });

  test('/metrics ohne METRICS_ENABLED 404, Unbekanntes 404', async () => {
    assert.equal((await get('/metrics')).status, 404);
    assert.equal((await get('/gibtsnicht')).status, 404);
    // Instrumente ohne gestartete Telemetrie wirken nicht und werfen nicht
    metrics.httpRequest('/v1/x', 'GET', 200, 3);
    metrics.jobDone('probe', 'done', 1);
    metrics.outboxDispatched(2);
  });

  test('/metrics mit METRICS_ENABLED liefert Prometheus-Text', async () => {
    const m = await startOpsServer({ port: 0, host: '127.0.0.1', ready: () => true, metrics: true, log: quiet });
    try {
      const r = await fetch(`http://127.0.0.1:${m.port}/metrics`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /text\/plain/);
    } finally { await m.close(); }
  });
});

describe('Geordnetes Beenden', () => {
  test('nicht mehr bereit, Verzögerung, Schritte rückwärts, Exit 0', async () => {
    const order: string[] = [];
    let code: number | null = null;
    const rt = createRuntime({ service: 'test', shutdownDelayMs: 30, shutdownTimeoutMs: 1000, log: quiet, signals: false, exit: c => { code = c; } });
    rt.markReady();
    assert.equal(rt.ready, true);
    rt.onShutdown(() => { order.push('pools'); });
    rt.onShutdown(async () => { order.push('server'); });
    const t0 = Date.now();
    const done = rt.shutdown('SIGTERM');
    assert.equal(rt.ready, false, 'sofort nicht mehr bereit');
    rt.markReady();
    assert.equal(rt.ready, false, 'nach dem Signal nie wieder bereit');
    const second = rt.shutdown('SIGTERM');
    await Promise.all([done, second]);
    assert.ok(Date.now() - t0 >= 25, 'SHUTDOWN_DELAY abgewartet');
    assert.deepEqual(order, ['server', 'pools']);
    assert.equal(code, 0);
  });

  test('Zeitüberschreitung: Exit 1', async () => {
    const codes: number[] = [];
    const rt = createRuntime({ service: 'test', shutdownDelayMs: 0, shutdownTimeoutMs: 50, log: quiet, signals: false, exit: c => { codes.push(c); } });
    rt.onShutdown(() => new Promise(r => setTimeout(r, 200)));
    await rt.shutdown();
    assert.equal(codes[0], 1);
  });

  test('gescheiterter Schritt hält die übrigen nicht auf', async () => {
    const order: string[] = [];
    let code: number | null = null;
    const rt = createRuntime({ service: 'test', shutdownDelayMs: 0, shutdownTimeoutMs: 500, log: quiet, signals: false, exit: c => { code = c; } });
    rt.onShutdown(() => { order.push('a'); });
    rt.onShutdown(() => { throw new Error('kaputt'); });
    await rt.shutdown();
    assert.deepEqual(order, ['a']);
    assert.equal(code, 0);
  });
});

describe('Mandanten (Kommandozeile)', { skip: await skipDb() }, () => {
  let t: Harness;
  let d: { admin: Harness['runtime']; runtime: Harness['runtime'] };
  before(async () => {
    t = await createTestDb();
    // Besitzer-Rolle als Pool (createTestDb liefert sie als Client)
    const pg = (await import('pg')).default;
    d = { admin: new pg.Pool({ connectionString: t.adminUrl, max: 2 }), runtime: t.runtime };
  });
  after(async () => { await d?.admin.end(); await t?.drop(); });

  const { create: tenantCreate, delete: tenantDelete, list: tenantList, resume: tenantResume, suspend: tenantSuspend } = app.tenants;

  test('anlegen, auflisten, sperren, entsperren, mit Protokoll', async () => {
    const a = await tenantCreate(d, 'alpha', 'Alpha AG');
    assert.equal(a.alias, 'alpha');
    assert.deepEqual((await tenantList(d)).map(x => [x.alias, x.status]), [['alpha', 'active']]);
    assert.equal((await tenantSuspend(d, 'alpha', 'Test')).status, 'suspended');
    assert.equal((await tenantList(d))[0]!.status, 'suspended');
    await tenantResume(d, 'alpha');
    const actions = await full(t.runtime, a.id, async tx => (await tx.query<{ action: string }>('SELECT action FROM probe.audit_log ORDER BY seq')).rows.map(r => r.action));
    assert.deepEqual(actions, ['tenant.provisioned', 'tenant.suspended', 'tenant.resumed']);
  });

  test('löschen nur gesperrt und mit passender Bestätigung; Daten weg, anderer Mandant unberührt', async () => {
    const b = await tenantCreate(d, 'beta');
    const g = await tenantCreate(d, 'gamma');
    for (const id of [b.id, g.id]) await full(t.runtime, id, tx => tx.query("INSERT INTO probe.notiz (tenant_id, label) VALUES ($1, 'Früh')", [id]));
    await assert.rejects(tenantDelete(d, 'beta', 'beta'), /nicht gesperrt/);
    await tenantSuspend(d, 'beta');
    await assert.rejects(tenantDelete(d, 'beta', 'falsch'), /Bestätigung/);
    await tenantDelete(d, 'beta', 'beta');
    assert.ok(!(await tenantList(d)).some(x => x.alias === 'beta'));
    assert.equal(await full(t.runtime, g.id, async tx => (await tx.query('SELECT count(*)::int AS n FROM probe.notiz')).rows[0].n), 1);
    const left = (await t.inspect.query("SELECT count(*)::int AS n FROM probe.notiz WHERE tenant_id = $1", [b.id])).rows[0].n;
    assert.equal(left, 0);
    // Eintrag im Protokoll der Plattform
    const logged = (await t.inspect.query("SELECT count(*)::int AS n FROM probe.platform_audit_log WHERE action = 'tenant.deleted'")).rows[0].n;
    assert.equal(logged, 1);
    // FORCE RLS und Trigger sind danach wieder an
    const weak = (await t.inspect.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'probe' AND relname IN ('notiz', 'audit_log') AND NOT relforcerowsecurity")).rows;
    assert.deepEqual(weak, []);
    const off = (await t.inspect.query("SELECT tgname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'probe' AND NOT g.tgisinternal AND g.tgenabled = 'D'")).rows;
    assert.deepEqual(off, []);
  });
});
