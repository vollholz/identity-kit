/**
 * Überspringen ohne Datenbank: ohne Konfiguration zählt node:test die Datenbank-Tests sichtbar als übersprungen (mit
 * Grund), konfiguriert, aber nicht erreichbar, scheitert der Lauf. Ausgangslage: In einer App liefen die Datenbank-
 * Tests ohne PostgreSQL still nicht, der Lauf war mit 311 statt 782 Tests grün.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { dbTests, NO_POSTGRES, postgresSkip, superuserUrlFrom, testDatabases } from '../src/index.ts';

/** Umgebung ohne Datenbank-Variablen. */
function bare(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // NODE_TEST_CONTEXT: sonst meldet ein Kindprozess von node --test an diesen Lauf statt auf stdout
  for (const k of ['TEST_POSTGRES_URL', 'POSTGRES_SUPERUSER_PASSWORD', 'POSTGRES_PORT', 'DATABASE_URL', 'DATABASE_ADMIN_URL', 'CI', 'NODE_TEST_CONTEXT']) delete env[k];
  return { ...env, ...extra };
}
/** Konfiguriert, aber nicht erreichbar (Port 1 lehnt sofort ab). */
const UNREACHABLE = { TEST_POSTGRES_URL: 'postgres://postgres:x@127.0.0.1:1/postgres' };

describe('postgresSkip und dbSkip', () => {
  test('ohne Konfiguration: Grund zum Überspringen', async () => {
    assert.equal(await postgresSkip(bare()), NO_POSTGRES);
    assert.match(NO_POSTGRES, /übersprungen.*TEST_POSTGRES_URL.*POSTGRES_SUPERUSER_PASSWORD/);
    assert.equal(superuserUrlFrom(bare({ POSTGRES_SUPERUSER_PASSWORD: 'a b', POSTGRES_PORT: '6000' })), 'postgres://postgres:a%20b@localhost:6000/postgres');
  });

  test('konfiguriert, aber nicht erreichbar: Fehler mit Variable und Adresse', async () => {
    await assert.rejects(postgresSkip(bare(UNREACHABLE)), /PostgreSQL konfiguriert \(TEST_POSTGRES_URL\), aber nicht erreichbar unter 127\.0\.0\.1:1/);
    await assert.rejects(postgresSkip(bare({ POSTGRES_SUPERUSER_PASSWORD: 'x', POSTGRES_PORT: '1' })), /\(POSTGRES_SUPERUSER_PASSWORD\), aber nicht erreichbar unter localhost:1/);
  });

  test('testDatabases().dbSkip: wie postgresSkip; mit Datenbank Fehler, wenn DATABASE_URL oder DATABASE_ADMIN_URL fehlt', async t => {
    const dbs = (env: NodeJS.ProcessEnv) => testDatabases({ prefix: 'skipprobe_', owner: 'skipprobe_owner', connect: [], migrate: async () => {}, runtime: () => null, closeRuntime: async () => {}, env });
    assert.equal(await dbs(bare()).dbSkip(), NO_POSTGRES);
    await assert.rejects(dbs(bare(UNREACHABLE)).dbSkip(), /nicht erreichbar/);
    if (await postgresSkip()) return t.skip(NO_POSTGRES);
    const su = { TEST_POSTGRES_URL: superuserUrlFrom()! };
    await assert.rejects(dbs(bare(su)).dbSkip(), /DATABASE_URL und DATABASE_ADMIN_URL fehlt/);
    assert.equal(await dbs(bare({ ...su, DATABASE_URL: 'postgres://a@h/x', DATABASE_ADMIN_URL: 'postgres://b@h/x' })).dbSkip(), false);
  });

  test('dbTests ohne Grund: die Funktionen von node:test', async () => {
    const nt = await import('node:test');
    const d = dbTests(false);
    assert.equal(d.test, nt.test);
    assert.equal(d.before, nt.before);
    assert.equal(dbTests('x').describe, nt.describe);
    const { test } = dbTests('x');
    for (const k of ['only', 'skip', 'todo'] as const) assert.equal(typeof test[k], 'function', k);
    assert.equal(test.test, test, 'test.test ist die umhüllte Funktion');
  });

  test('Lauf von node --test: ohne Datenbank als übersprungen gezählt, nicht erreichbar scheitert', () => {
    const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--test', '--test-reporter=spec', join(import.meta.dirname, 'fixtures', 'db-skip-probe.ts')], { env, encoding: 'utf8' });
    const none = run(bare());
    assert.equal(none.status, 0, none.stdout + none.stderr);
    assert.match(none.stdout, /ℹ skipped 4/, 'jeder Datenbank-Test gezählt, auch test.only und test.todo');
    assert.match(none.stdout, /ℹ pass 1/);
    assert.match(none.stdout, /ℹ fail 0/, 'Hooks laufen nicht');
    assert.ok(none.stdout.includes(NO_POSTGRES), 'Grund in der Ausgabe');
    const down = run(bare(UNREACHABLE));
    assert.notEqual(down.status, 0, 'Lauf scheitert');
    assert.match(down.stdout + down.stderr, /nicht erreichbar unter 127\.0\.0\.1:1/);
  });
});
