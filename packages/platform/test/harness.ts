/**
 * Testumgebung des Backends: Wegwerf-Datenbank je Testdatei (Werkzeuge des Test-Kits) mit allen Migrationen, Rollen
 * wie in Produktion. Verbindungen laufen als Superuser mit gesetzter Rolle (`options=-c role=<rolle>`), so braucht es
 * keine Passwörter; RLS gilt für die gesetzte Rolle.
 *
 * Umgebung: `TEST_POSTGRES_URL` oder `POSTGRES_SUPERUSER_PASSWORD` (+ `POSTGRES_PORT`, Standard 5433). Ohne erreichbare
 * Datenbank überspringen sich die Tests (`skipDb`); in CI ist sie immer da.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { testDatabases, type TestDb } from '@vollholz/iam-testkit';
import { runMigrations } from '../src/index.ts';
import { MIGRATIONS_DIR } from './fixture/app.ts';
import type { Tx } from '../src/index.ts';
import { app } from './fixture/app.ts';
import { fullTx } from './fixture/platform.ts';

export const P = 'probe';

export const superuser = process.env.TEST_POSTGRES_URL
  ?? (process.env.POSTGRES_SUPERUSER_PASSWORD ? `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_SUPERUSER_PASSWORD)}@localhost:${process.env.POSTGRES_PORT ?? '5433'}/postgres` : null);

/** Adresse des Superusers mit gesetzter Rolle. */
export function asRole(url: string, role: string): string {
  const u = new URL(url);
  u.searchParams.set('options', `-c role=${role}`);
  return u.toString();
}

async function reachable(): Promise<boolean> {
  if (!superuser) return false;
  const c = new pg.Client({ connectionString: superuser, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

/** Grund zum Überspringen (false: Datenbank da). In CI (`CI=true`) ist eine fehlende Datenbank ein Fehler. */
export async function skipDb(): Promise<false | string> {
  if (await reachable()) return false;
  if (process.env.CI) throw new Error('PostgreSQL in CI nicht erreichbar (POSTGRES_SUPERUSER_PASSWORD, POSTGRES_PORT)');
  return 'PostgreSQL nicht erreichbar (POSTGRES_SUPERUSER_PASSWORD, POSTGRES_PORT)';
}

/** Rollen nach app-boilerplate 5.3 (clusterweit, idempotent, auch bei parallelen Testdateien). */
export async function ensureRoles(): Promise<void> {
  const c = new pg.Client({ connectionString: superuser! });
  await c.connect();
  try {
    await c.query("SELECT pg_advisory_lock(hashtext('probe-test-roles'))");
    for (const sql of [
      `CREATE ROLE ${P}_owner NOLOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS`,
      `CREATE ROLE ${P}_app NOLOGIN NOBYPASSRLS`,
      `CREATE ROLE ${P}_sched NOLOGIN NOBYPASSRLS`,
      `CREATE ROLE ${P}_runtime NOLOGIN NOBYPASSRLS IN ROLE ${P}_app`,
      `CREATE ROLE ${P}_worker NOLOGIN NOBYPASSRLS IN ROLE ${P}_app, ${P}_sched`,
    ]) await c.query(sql).catch((e: { code?: string }) => { if (e.code !== '42710' && e.code !== '23505') throw e; });
  } finally { await c.end(); }
}

const su = superuser ?? 'postgres://x@localhost/x';
const dbs = testDatabases<pg.Pool>({
  prefix: `${P}_test_`, owner: `${P}_owner`, connect: [`${P}_app`, `${P}_sched`],
  env: {
    ...process.env,
    DATABASE_URL: asRole(su, `${P}_runtime`), DATABASE_ADMIN_URL: asRole(su, `${P}_owner`), DATABASE_WORKER_URL: asRole(su, `${P}_worker`),
  },
  // Ordner mit `adopted.txt`: Übernahme der Plattform-Migrationen nach der darin genannten Migration (migrations.test.ts)
  migrate: (url, dir) => runMigrations(url, app.platform.context, app.platform.model, {
    dir: dir ?? MIGRATIONS_DIR,
    ...(dir && existsSync(join(dir, 'adopted.txt')) ? { adopted: { after: readFileSync(join(dir, 'adopted.txt'), 'utf8').trim() } } : {}),
  }),
  runtime: url => new pg.Pool({ connectionString: url, max: 5 }),
  closeRuntime: p => p.end(),
});

export type Harness = TestDb<pg.Pool> & { worker: pg.Pool };

/** Wegwerf-Datenbank mit Migrationen; `runtime` = API (probe_runtime), `worker` = Worker (probe_worker). */
export async function createTestDb(o: { migrationsDir?: string } = {}): Promise<Harness> {
  await ensureRoles();
  const t = await dbs.createTestDb(o);
  const worker = new pg.Pool({ connectionString: t.workerUrl, max: 3 });
  return { ...t, worker, drop: async () => { await worker.end(); await t.drop(); } };
}

/** Mandant anlegen (wie die erste Anmeldung) und seine ID liefern. */
export async function tenant(db: pg.Pool, alias: string): Promise<string> {
  return (await db.query<{ id: string }>('SELECT app.resolve_tenant($1, null, $1, true) AS id', [alias])).rows[0]!.id;
}

/** Testdaten mit voller Sicht im Mandanten. */
export const full = <T>(db: pg.Pool, tenantId: string, fn: (tx: Tx) => Promise<T>) => fullTx(db, tenantId, fn);
