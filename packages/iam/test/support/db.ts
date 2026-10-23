/**
 * Wegwerf-Datenbanken für die Tests des Pakets (Werkzeuge des Test-Kits): Rollen nach Spezifikation Kap. 10.1 für ein
 * Produkt, Migrationen des IAM (und optional weitere Quellen).
 *
 * Verbindungen laufen als Superuser mit gesetzter Rolle (`options=-c role=<rolle>`): So braucht es keine Passwörter, und
 * bestehende Rollen (z. B. von Assets im lokalen PostgreSQL) bleiben unverändert. RLS gilt für die gesetzte Rolle
 * (`current_user`), nicht für den Superuser der Sitzung.
 * Umgebung wie das Test-Kit: `TEST_POSTGRES_URL` oder `POSTGRES_SUPERUSER_PASSWORD` (+ `POSTGRES_PORT`, Standard 5433).
 */
import pg from 'pg';
import { testDatabases, type TestDatabases } from '@vollholz/iam-testkit';
import { productIdent } from '../../src/config.ts';
import { iamMigrations, migrate, type IamMigrationOptions, type MigrationSource } from '../../src/migrations.ts';

const PORT = process.env.POSTGRES_PORT ?? '5433';
export const superuser = process.env.TEST_POSTGRES_URL
  ?? (process.env.POSTGRES_SUPERUSER_PASSWORD ? `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_SUPERUSER_PASSWORD)}@localhost:${PORT}/postgres` : null);

/** Adresse des Superusers mit gesetzter Rolle. */
export function asRole(url: string, role: string): string {
  const u = new URL(url);
  u.searchParams.set('options', `-c role=${role}`);
  return u.toString();
}

export async function reachable(): Promise<boolean> {
  if (!superuser) return false;
  const c = new pg.Client({ connectionString: superuser, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

/** Grund zum Überspringen, falls keine Datenbank erreichbar ist. */
export const skipDb = async () => !(await reachable()) && 'PostgreSQL nicht erreichbar (POSTGRES_SUPERUSER_PASSWORD, POSTGRES_PORT)';

/** Rollen eines Produkts (clusterweit, idempotent, auch bei parallelen Testdateien). */
export async function ensureRoles(product: string): Promise<void> {
  const p = productIdent(product);
  const c = new pg.Client({ connectionString: superuser! });
  await c.connect();
  try {
    // Testdateien laufen parallel: Rollen nacheinander anlegen (gleichzeitiges CREATE ROLE kann sonst scheitern)
    await c.query("SELECT pg_advisory_lock(hashtext('iam-test-roles'))");
    for (const sql of [
      `CREATE ROLE ${p}_owner NOLOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS`,
      `CREATE ROLE ${p}_app NOLOGIN NOBYPASSRLS`,
      `CREATE ROLE ${p}_sched NOLOGIN NOBYPASSRLS`,
      `CREATE ROLE ${p}_runtime NOLOGIN NOBYPASSRLS IN ROLE ${p}_app`,
      `CREATE ROLE ${p}_worker NOLOGIN NOBYPASSRLS IN ROLE ${p}_app, ${p}_sched`,
    ]) await c.query(sql).catch((e: { code?: string }) => { if (e.code !== '42710' && e.code !== '23505') throw e; });
  } finally { await c.end(); }
}

export interface ProductDb {
  product: string;
  dbs: TestDatabases<pg.Pool>;
  /** Rollen sicherstellen, dann Wegwerf-Datenbank mit Migrationen. */
  create(): ReturnType<TestDatabases<pg.Pool>['createTestDb']>;
}

/**
 * Wegwerf-Datenbanken eines Produkts mit den IAM-Migrationen.
 * @param sources zusätzliche Quellen (nach dem IAM bzw. statt, mit `iam: false`)
 */
export function productDb(o: Omit<IamMigrationOptions, 'product'> & { product?: string; sources?: MigrationSource[]; iam?: boolean } = {}): ProductDb {
  const product = o.product ?? 'notes';
  const p = productIdent(product);
  const env = {
    ...process.env,
    DATABASE_URL: asRole(superuser ?? 'postgres://x@localhost/x', `${p}_runtime`),
    DATABASE_ADMIN_URL: asRole(superuser ?? 'postgres://x@localhost/x', `${p}_owner`),
    DATABASE_WORKER_URL: asRole(superuser ?? 'postgres://x@localhost/x', `${p}_worker`),
  };
  const dbs = testDatabases({
    prefix: `iam_${p}_test_`, owner: `${p}_owner`, connect: [`${p}_app`, `${p}_sched`], env,
    migrate: async url => {
      const iam = o.iam === false ? [] : [iamMigrations({ product, schema: o.schema, model: o.model, adopted: o.adopted })];
      return migrate(url, [...iam, ...(o.sources ?? [])]);
    },
    runtime: url => new pg.Pool({ connectionString: url, max: 3 }),
    closeRuntime: p => p.end(),
  });
  return { product, dbs, create: async () => { await ensureRoles(product); return dbs.createTestDb(); } };
}
