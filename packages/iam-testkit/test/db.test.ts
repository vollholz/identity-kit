/**
 * Wegwerf-Datenbank und RLS-Prüfungen gegen PostgreSQL: ein korrekt geschütztes Schema ohne Befunde, ein fehlerhaftes
 * mit einem Befund je Prüfung. Ohne erreichbare Datenbank übersprungen (POSTGRES_SUPERUSER_PASSWORD, POSTGRES_PORT).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { bypassRoleProblems, grantedTableProblems, publicExecuteProblems, publicSchemaProblems, securityDefinerProblems, tenantTableProblems, testDatabases, type TestDb } from '../src/index.ts';

const FIX = join(import.meta.dirname, 'fixtures');
const PORT = process.env.POSTGRES_PORT ?? '5433';
const su = process.env.TEST_POSTGRES_URL ?? (process.env.POSTGRES_SUPERUSER_PASSWORD ? `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_SUPERUSER_PASSWORD)}@localhost:${PORT}/postgres` : null);
const host = su ? new URL(su).host : `localhost:${PORT}`;
const env = { ...process.env, DATABASE_URL: `postgres://iamkit_runtime:iamkit-runtime@${host}/x`, DATABASE_ADMIN_URL: `postgres://iamkit_owner:iamkit-owner@${host}/x` };

async function reachable() {
  if (!su) return false;
  const c = new pg.Client({ connectionString: su, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
const skip = !(await reachable()) && 'PostgreSQL nicht erreichbar (POSTGRES_SUPERUSER_PASSWORD, POSTGRES_PORT)';

/** Rollen der Fixtures (clusterweit, idempotent). */
async function roles() {
  const c = new pg.Client({ connectionString: su! });
  await c.connect();
  try {
    for (const sql of [
      "CREATE ROLE iamkit_owner LOGIN PASSWORD 'iamkit-owner' NOSUPERUSER NOBYPASSRLS",
      'CREATE ROLE iamkit_app NOLOGIN NOBYPASSRLS',
      "CREATE ROLE iamkit_runtime LOGIN PASSWORD 'iamkit-runtime' NOBYPASSRLS IN ROLE iamkit_app",
    ]) await c.query(sql).catch((e: { code?: string }) => { if (e.code !== '42710') throw e; });
  } finally { await c.end(); }
}

async function migrate(url: string, dir?: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { for (const f of readdirSync(dir!).filter(x => x.endsWith('.sql')).sort()) await c.query(readFileSync(join(dir!, f), 'utf8')); } finally { await c.end(); }
}

const dbs = testDatabases({
  prefix: 'iamkit_test_', owner: 'iamkit_owner', connect: ['iamkit_app'], env, migrate,
  runtime: url => new pg.Pool({ connectionString: url, max: 2 }), closeRuntime: p => p.end(),
});

describe('Wegwerf-Datenbank und RLS-Prüfungen', { skip }, () => {
  let ok: TestDb<pg.Pool>, bad: TestDb<pg.Pool>;
  before(async () => {
    await roles();
    ok = await dbs.createTestDb({ migrationsDir: join(FIX, 'ok') });
    bad = await dbs.createTestDb({ migrationsDir: join(FIX, 'bad') });
  });
  after(async () => { await ok?.drop(); await bad?.drop(); });

  test('dbAvailable, Namen mit Zeitstempel, Laufzeit-Rolle unterliegt RLS', async () => {
    assert.equal(await dbs.dbAvailable(), true);
    assert.match(ok.name, /^iamkit_test_[0-9a-z]+_[0-9a-f]{8}$/);
    const t = randomTenant();
    await ok.inspect.query('INSERT INTO kit.tenant (id, alias) VALUES ($1, $2)', [t, `a-${t.slice(0, 8)}`]);
    await ok.inspect.query('INSERT INTO kit.note (tenant_id, id, body) VALUES ($1, $1, $2)', [t, 'geheim']);
    assert.equal((await ok.runtime.query('SELECT count(*)::int AS n FROM kit.note')).rows[0].n, 0, 'ohne Kontext keine Zeilen');
    assert.equal((await ok.admin.query('SELECT count(*)::int AS n FROM kit.note')).rows[0].n, 0, 'Besitzer unterliegt FORCE RLS');
    const c = await ok.runtime.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [t]);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM kit.note')).rows[0].n, 1);
      await c.query('COMMIT');
    } finally { c.release(); }
  });

  test('korrektes Schema: keine Befunde', async () => {
    assert.deepEqual(await tenantTableProblems(ok.inspect, { appRole: 'iamkit_app' }), []);
    assert.deepEqual(await grantedTableProblems(ok.inspect, { roles: ['iamkit_app'], withoutTenant: { 'kit.session': 'Sitzungen ohne Mandantendaten' } }), []);
    assert.deepEqual(await securityDefinerProblems(ok.inspect, { allowed: { 'app.resolve_tenant(p_alias text)': 'Alias auflösen' } }), []);
    assert.deepEqual(await publicExecuteProblems(ok.inspect, { schemas: ['app', 'kit'], strict: true }), []);
    assert.deepEqual(await publicSchemaProblems(ok.inspect, { schemas: ['app', 'kit'] }), []);
    assert.deepEqual(await bypassRoleProblems(ok.inspect, { rolePrefix: 'iamkit_' }), []);
  });

  test('fehlerhaftes Schema: jede Prüfung meldet', async () => {
    const tt = await tenantTableProblems(bad.inspect, { appRole: 'iamkit_app' });
    assert.ok(tt.some(p => p.startsWith('kit.note: rls=true force=false')), tt.join('\n'));
    assert.ok(tt.some(p => p.startsWith('kit.comment:') && p.includes('USING true')), tt.join('\n'));
    const gt = await grantedTableProblems(bad.inspect, { roles: ['iamkit_app'], withoutTenant: { 'kit.session': 'gibt es hier nicht' } });
    assert.ok(gt.some(p => p.startsWith('kit.leak (iamkit_app): ohne Mandantentrennung')), gt.join('\n'));
    assert.ok(gt.some(p => p.startsWith('kit.note (iamkit_app): ohne Mandantentrennung')), gt.join('\n'));
    assert.ok(gt.includes('Ausnahme kit.session veraltet (fehlt, ohne Rechte oder hat tenant_id)'), gt.join('\n'));
    assert.ok(gt.includes('kit.note: TRUNCATE für iamkit_app'), gt.join('\n'));
    const sd = await securityDefinerProblems(bad.inspect, { allowed: {} });
    assert.deepEqual(sd, [
      'app.resolve_tenant(p_alias text): search_path ohne pg_temp am Ende (kein search_path)',
      'app.resolve_tenant(p_alias text): PUBLIC darf ausführen',
      'app.resolve_tenant(p_alias text): SECURITY DEFINER ohne Begründung',
    ]);
    assert.deepEqual(await publicExecuteProblems(bad.inspect, { schemas: ['app', 'kit'] }), ['app.resolve_tenant(p_alias text): PUBLIC darf ausführen', 'app.tenant_id(): PUBLIC darf ausführen']);
    assert.deepEqual((await publicExecuteProblems(bad.inspect, { schemas: ['app', 'kit'], strict: true })).filter(p => p.startsWith('kit.')), ['kit.helper(): PUBLIC darf ausführen (Schema ohne USAGE für PUBLIC)']);
    assert.deepEqual(await publicSchemaProblems(bad.inspect, { schemas: ['app', 'kit', 'fehlt'] }), ['Schema app: USAGE für PUBLIC', 'Schema fehlt fehlt']);
  });

  test('Rolle mit BYPASSRLS wird gemeldet', async () => {
    await ok.inspect.query("DO $$ BEGIN CREATE ROLE iamkit_bypass_probe NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$");
    try { assert.deepEqual(await bypassRoleProblems(ok.inspect, { rolePrefix: 'iamkit_bypass_' }), ['iamkit_bypass_probe: BYPASSRLS']); }
    finally { await ok.inspect.query('DROP ROLE IF EXISTS iamkit_bypass_probe'); }
  });

  test('Aufräumen: nur alte Datenbanken mit dem Präfix', async () => {
    const c = new pg.Client({ connectionString: su! });
    await c.connect();
    const old = dbs.testDbName(Date.now() - 2 * 3_600_000, 'iamkit_sweep_');
    const fresh = dbs.testDbName(Date.now(), 'iamkit_sweep_');
    try {
      await c.query(`CREATE DATABASE ${old}`); await c.query(`CREATE DATABASE ${fresh}`);
      const dropped = await dbs.sweepStaleTestDbs({ prefix: 'iamkit_sweep_', only: n => n === old || n === fresh });
      assert.deepEqual(dropped, [old]);
    } finally { await c.query(`DROP DATABASE IF EXISTS ${old}`); await c.query(`DROP DATABASE IF EXISTS ${fresh}`); await c.end(); }
  });
});

function randomTenant() { return crypto.randomUUID(); }
