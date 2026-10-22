/**
 * Migrationen: Runner (wie Assets `db/migrate.ts`) und die SQL-Migrationen des IAM (Spezifikation Kap. 10, 15.3).
 *
 * - Jede Migration läuft in einer Transaktion, danach `app.secure_tenant_tables()`; geschützt durch eine Advisory-Lock
 *   (LOCKS.migrate), mehrere Instanzen gleichzeitig sind unkritisch. Ausgeführte Migrationen stehen mit Prüfsumme in
 *   `public.schema_migrations`; eine nachträglich geänderte Datei bricht ab.
 * - Mehrere Quellen in fester Reihenfolge (IAM vor App); Namen eindeutig über alle Quellen (`iam_…` neben `NNN_…`).
 * - Die IAM-Migrationen liegen als SQL mit Platzhaltern im Paket (`migrations/iam_NNN_*.sql`); `iamMigrations` setzt
 *   Schema, Datenbankrollen und Ressourcentypen ein. Die Prüfsumme gilt für den eingesetzten Text.
 * - Übernahme (`adopted`): Eine App, die die Objekte schon aus eigenen Migrationen hat (Assets bis 049), trägt die
 *   IAM-Migrationen bis `upTo` als angewendet ein, ohne sie auszuführen – nur wenn ihre Vorbedingungen erfüllt sind,
 *   sonst bricht der Runner ab. Spätere IAM-Migrationen laufen normal.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { productIdent } from './config.ts';
import { LOCKS } from './locks.ts';

export interface Migration { name: string; sql: string; checksum: string }

/** Übernahme bestehender Objekte statt Ausführung (siehe oben). */
export interface Adoption {
  /** Letzte übernommene Migration der Quelle (einschliesslich). */
  upTo: string;
  /** Befunde, warum nicht übernommen werden darf (leer = erfüllt); läuft als Besitzer-Rolle vor dem Eintragen. */
  check(client: pg.ClientBase): Promise<string[]>;
}

export interface MigrationSource {
  /** Name für Meldungen, z. B. `iam` oder der Ordner der App. */
  name: string;
  migrations: Migration[];
  adopt?: Adoption;
}

export interface MigrationResult { applied: string[]; adopted: string[]; skipped: number }

/** Zeilenenden normalisieren (gleiche Prüfsumme unter Windows und Linux) und Prüfsumme bilden. */
export function migration(name: string, sql: string): Migration {
  const text = sql.replace(/\r\n/g, '\n');
  return { name, sql: text, checksum: createHash('sha256').update(text).digest('hex') };
}

/** Migrationen `NNN_*.sql` eines Ordners (die der App), sortiert. */
export function dirMigrations(dir: string): MigrationSource {
  const files = readdirSync(dir).filter(f => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  return { name: dir, migrations: files.map(f => migration(f, readFileSync(join(dir, f), 'utf8'))) };
}

const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
const TYPE = /^[a-z][a-z0-9-]{0,62}$/;

export interface IamMigrationOptions {
  /**
   * Technischer Name des Produkts (wie in der Konfiguration, z. B. `my-app`); ergibt mit «_» statt «-» die
   * Datenbankrollen `<ident>_owner`, `<ident>_app`, `<ident>_sched` und das Standardschema (`productIdent`).
   */
  product: string;
  /** Schema der Tabellen (Standard: `productIdent(product)`). */
  schema?: string;
  /** Ressourcentypen der Zugriffsregeln (mit `tenant`, Reihenfolge wie im Katalog); Standard nur `tenant`. */
  resourceTypes?: readonly string[];
  /** Blätter der Kette: dort nie `grant` (Kap. 7.1; Assets: `object`). */
  leafTypes?: readonly string[];
  /**
   * Objekte bestehen schon aus Migrationen der App (Assets: bis `049_tenant_roles.sql`): IAM-Migrationen bis
   * `IAM_BASELINE` nur eintragen, wenn `after` angewendet ist und die Objekte vorhanden sind.
   */
  adopted?: { after: string };
}

/** Letzte IAM-Migration, die dem Stand von Assets nach Migration 049 entspricht (Übernahme). */
export const IAM_BASELINE = 'iam_008_entra.sql';

/** Ordner der SQL-Vorlagen (im Paket neben `src` bzw. `dist`). */
export const IAM_MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

const lit = (v: string) => `'${v}'`;

/** Platzhalter `{{name}}` einsetzen; unbekannte Platzhalter sind ein Fehler. */
export function render(sql: string, vars: Record<string, string>): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!Object.hasOwn(vars, k)) throw new Error(`Unbekannter Platzhalter {{${k}}}`);
    return vars[k]!;
  });
}

/** Die SQL-Migrationen des IAM mit eingesetzten Parametern. */
export function iamMigrations(o: IamMigrationOptions): MigrationSource {
  const ident = productIdent(o.product);
  const schema = o.schema ?? ident;
  if (!IDENT.test(schema)) throw new Error(`schema: ungültiger Bezeichner «${schema}»`);
  const types = [...(o.resourceTypes ?? ['tenant'])];
  const leaves = [...(o.leafTypes ?? [])];
  if (!types.includes('tenant')) throw new Error('resourceTypes: «tenant» fehlt (Wurzel der Kette)');
  for (const t of [...types, ...leaves]) if (!TYPE.test(t)) throw new Error(`Ressourcentyp «${t}» ungültig`);
  for (const t of leaves) if (!types.includes(t) || t === 'tenant') throw new Error(`leafTypes: «${t}» ist kein Ressourcentyp unter dem Mandanten`);
  if (new Set(types).size !== types.length) throw new Error('resourceTypes: doppelte Einträge');
  // Freigaben nie auf Blättern; eine Bedingung je App (Assets: genau `object`, gleiche Form wie Migration 048)
  const grantCheck = !leaves.length ? ''
    : `,\n  CONSTRAINT acl_entry_grant_resource_check CHECK (effect <> 'grant' OR ${leaves.length === 1 ? `resource_type <> ${lit(leaves[0]!)}` : `resource_type NOT IN (${leaves.map(lit).join(', ')})`})`;
  const vars = {
    schema, owner: `${ident}_owner`, app: `${ident}_app`, sched: `${ident}_sched`,
    resource_types: types.map(lit).join(', '), grant_check: grantCheck,
  };
  const files = readdirSync(IAM_MIGRATIONS_DIR).filter(f => /^iam_\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const migrations = files.map(f => migration(f, render(readFileSync(join(IAM_MIGRATIONS_DIR, f), 'utf8'), vars)));
  return { name: 'iam', migrations, ...(o.adopted ? { adopt: { upTo: IAM_BASELINE, check: c => adoptionProblems(c, schema, o.adopted!.after) } } : {}) };
}

/** Tabellen und Funktionen, die die Übernahme voraussetzt (Stand Assets 049). */
const BASELINE_TABLES = ['tenant', 'principal', 'acl_entry', 'tenant_role', 'member_invitation', 'client_grant', 'session', 'replay_guard', 'rate_limit', 'audit_log', 'audit_anchor', 'entra_connection', 'entra_consent'];
const BASELINE_COLUMNS: [string, string][] = [['principal', 'last_roles'], ['principal', 'removed_at'], ['member_invitation', 'id'], ['member_invitation', 'entra'], ['audit_log', 'seq'], ['session', 'idp_sid'], ['tenant_role', 'deleted_at']];
const BASELINE_FUNCTIONS = ['tenant_id', 'principal_id', 'secure_tenant_tables', 'resolve_tenant', 'bump_acl_version', 'audit_hash', 'audit_chain', 'suspended_tenants', 'platform_tenants', 'set_tenant_status', 'entra_login_alias', 'entra_free_slot', 'entra_domains_taken'];

/** Vorbedingungen der Übernahme: Migration `after` angewendet, Tabellen, Spalten und Funktionen vorhanden. */
export async function adoptionProblems(c: pg.ClientBase, schema: string, after: string): Promise<string[]> {
  const out: string[] = [];
  if (!(await c.query('SELECT 1 FROM public.schema_migrations WHERE name = $1', [after])).rowCount) out.push(`Migration ${after} ist nicht angewendet`);
  const tables = new Set((await c.query<{ t: string }>("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r'", [schema])).rows.map(r => r.t));
  for (const t of BASELINE_TABLES) if (!tables.has(t)) out.push(`Tabelle ${schema}.${t} fehlt`);
  const cols = new Set((await c.query<{ k: string }>("SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = $1", [schema])).rows.map(r => r.k));
  for (const [t, col] of BASELINE_COLUMNS) if (tables.has(t) && !cols.has(`${t}.${col}`)) out.push(`Spalte ${schema}.${t}.${col} fehlt`);
  const fns = new Set((await c.query<{ f: string }>("SELECT p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'")).rows.map(r => r.f));
  for (const f of BASELINE_FUNCTIONS) if (!fns.has(f)) out.push(`Funktion app.${f} fehlt`);
  return out;
}

/**
 * Führt die Migrationen aller Quellen in der gegebenen Reihenfolge aus (als Besitzer-Rolle, `adminUrl`).
 * @param log Meldung je ausgeführter oder übernommener Migration
 */
export async function migrate(adminUrl: string, sources: MigrationSource[], log: (m: string) => void = () => undefined): Promise<MigrationResult> {
  const names = new Map<string, string>();
  for (const s of sources) for (const m of s.migrations) {
    if (names.has(m.name)) throw new Error(`Migration ${m.name} kommt in ${names.get(m.name)} und ${s.name} vor`);
    names.set(m.name, s.name);
  }
  const client = new pg.Client({ connectionString: adminUrl, application_name: 'iam-migrate' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCKS.migrate]);
    await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Map((await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM public.schema_migrations')).rows.map(r => [r.name, r.checksum]));
    const applied: string[] = [], adopted: string[] = [];
    let total = 0;
    for (const s of sources) {
      total += s.migrations.length;
      const upTo = s.adopt ? s.migrations.findIndex(m => m.name === s.adopt!.upTo) : -1;
      if (s.adopt && upTo < 0) throw new Error(`Übernahme bis ${s.adopt.upTo}: Migration fehlt in ${s.name}`);
      // Vorbedingungen nur prüfen, wenn noch etwas zu übernehmen ist
      if (s.adopt && s.migrations.slice(0, upTo + 1).some(m => !done.has(m.name))) {
        const problems = await s.adopt.check(client);
        if (problems.length) throw new Error(`Übernahme der Migrationen von ${s.name} nicht möglich:\n  - ${problems.join('\n  - ')}`);
      }
      for (const [i, m] of s.migrations.entries()) {
        if (done.has(m.name)) {
          if (done.get(m.name) !== m.checksum) throw new Error(`Migration ${m.name} wurde nach dem Ausführen geändert (Prüfsumme). Änderungen gehören in eine neue Migration.`);
          continue;
        }
        if (i <= upTo) {
          await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
          adopted.push(m.name); log(`Migration ${m.name} übernommen (Objekte bestehen)`);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('SELECT app.secure_tenant_tables()');
          await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
          await client.query('COMMIT');
          applied.push(m.name); log(`Migration ${m.name} ausgeführt`);
        } catch (e) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${m.name} fehlgeschlagen: ${(e as Error).message}`);
        }
      }
    }
    return { applied, adopted, skipped: total - applied.length - adopted.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCKS.migrate]).catch(() => undefined);
    await client.end();
  }
}
