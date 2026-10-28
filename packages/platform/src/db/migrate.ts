/**
 * Migrationen (app-boilerplate 5.2) in fester Reihenfolge: @vollholz/iam (Schema, Rollen, Tupel mit CHECKs aus dem
 * Modell), dann die der Plattform (`platform_NNN_*.sql`: Warteschlange, Idempotenz, Outbox), dann `NNN_*.sql` der
 * App. Jede Migration in eigener Transaktion, protokolliert mit Prüfsumme in `public.schema_migrations`; nur vorwärts,
 * als Besitzer-Rolle `<ident>_owner`.
 *
 * Übernahme (`adopted`): Eine App, die Warteschlange, Idempotenz und Outbox schon aus eigenen Migrationen hat (z. B.
 * nachtschicht `001_core.sql` + `004_…`), trägt `platform_001_core.sql` nur ein, wenn die Objekte in der Endform
 * bestehen; sonst bricht der Runner ab.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirMigrations, iamMigrations, migrate, migration, render, type DbSsl, type MigrationResult, type MigrationSource, type Model } from '@vollholz/iam';
import type pg from 'pg';
import type { PlatformContext } from '../context.ts';

/** Ordner der SQL-Vorlagen (im Paket neben `src` bzw. `dist`). */
export const PLATFORM_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

export interface PlatformMigrationOptions {
  /** Objekte bestehen aus Migrationen der App: eintragen statt ausführen, direkt nach `after` (Name der App-Migration). */
  adopted?: { after: string };
}

/** Tabellen und Policies, die `platform_001_core.sql` anlegt (Prüfung der Übernahme). */
const CORE = {
  tables: ['job', 'idempotency_key', 'outbox_event'],
  policies: [
    ['job', 'sched_read'], ['job', 'sched_write'], ['outbox_event', 'sched_read'], ['outbox_event', 'sched_write'],
    ['idempotency_key', 'sched_cleanup'], ['idempotency_key', 'sched_read'],
  ],
} as const;

async function adoptionProblems(c: pg.ClientBase, schema: string): Promise<string[]> {
  const problems: string[] = [];
  for (const t of CORE.tables) {
    const r = await c.query<{ rls: boolean; force: boolean }>(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`, [schema, t]);
    if (!r.rows[0]) problems.push(`Tabelle ${schema}.${t} fehlt`);
    else if (!r.rows[0].rls || !r.rows[0].force) problems.push(`Tabelle ${schema}.${t} ohne ENABLE/FORCE ROW LEVEL SECURITY`);
  }
  for (const [t, p] of CORE.policies) {
    const r = await c.query('SELECT 1 FROM pg_policies WHERE schemaname = $1 AND tablename = $2 AND policyname = $3', [schema, t, p]);
    if (!r.rowCount) problems.push(`Policy ${p} auf ${schema}.${t} fehlt`);
  }
  const old = await c.query<{ t: string }>(`SELECT tablename AS t FROM pg_policies WHERE schemaname = $1 AND policyname = 'sched_all' AND tablename = ANY($2)`, [schema, CORE.tables]);
  for (const r of old.rows) problems.push(`Policy sched_all auf ${schema}.${r.t} besteht noch (Schreiben über alle Mandanten)`);
  return problems;
}

/** Die SQL-Migrationen der Plattform mit eingesetztem Schema und Rollen. */
export function platformMigrations(ctx: PlatformContext, o: PlatformMigrationOptions = {}): MigrationSource {
  const files = readdirSync(PLATFORM_MIGRATIONS_DIR).filter(f => /^platform_\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const vars = { schema: ctx.schema, app: ctx.roles.app, sched: ctx.roles.sched };
  const migrations = files.map(f => migration(f, render(readFileSync(join(PLATFORM_MIGRATIONS_DIR, f), 'utf8'), vars)));
  return {
    name: 'platform', migrations, owner: ctx.roles.owner,
    ...(o.adopted ? { adopt: { upTo: migrations.at(-1)!.name, after: o.adopted.after, check: c => adoptionProblems(c, ctx.schema) } } : {}),
  };
}

export interface RunMigrationsOptions extends PlatformMigrationOptions {
  /** Ordner mit `NNN_*.sql` der App (fehlt er, nur IAM und Plattform). */
  dir?: string | null;
  /** Übernahme der IAM-Migrationen (siehe `iamMigrations`). */
  iamAdopted?: Parameters<typeof iamMigrations>[0]['adopted'];
  log?: (m: string) => void;
  /** TLS zur Datenbank wie `DATABASE_SSL`; Standard `disable`. */
  ssl?: DbSsl;
}

/** Alle Migrationen ausführen: IAM, Plattform, App. */
export function runMigrations(adminUrl: string, ctx: PlatformContext, model: Model<string>, o: RunMigrationsOptions = {}): Promise<MigrationResult> {
  const sources = [
    iamMigrations({ product: ctx.product, schema: ctx.schema, model, ...(o.iamAdopted ? { adopted: o.iamAdopted } : {}) }),
    platformMigrations(ctx, o),
    ...(o.dir ? [dirMigrations(o.dir)] : []),
  ];
  return migrate(adminUrl, sources, { ...(o.log ? { log: o.log } : {}), ...(o.ssl ? { ssl: o.ssl } : {}) });
}
