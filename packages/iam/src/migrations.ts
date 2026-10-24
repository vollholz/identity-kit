/**
 * Migrationen: Runner (wie Assets `db/migrate.ts`) und die SQL-Migrationen des IAM (Spezifikation Kap. 10, 15.3).
 *
 * - Jede Migration läuft in einer Transaktion (`lock_timeout` 10 s: wartet sie länger auf eine Sperre, bricht sie ab, statt
 *   den laufenden Betrieb hinter sich anzustauen), danach `app.secure_tenant_tables()`; geschützt durch eine Advisory-Lock
 *   (LOCKS.migrate), mehrere Instanzen gleichzeitig sind unkritisch. Ausgeführte Migrationen stehen mit Prüfsumme in
 *   `public.schema_migrations`; eine nachträglich geänderte Datei bricht ab.
 * - Mehrere Quellen in fester Reihenfolge (IAM vor App); Namen eindeutig über alle Quellen (`iam_…` neben `NNN_…`).
 *   Der Runner läuft nur als Besitzer-Rolle des Produkts (`<ident>_owner`), sonst Abbruch.
 * - Die IAM-Migrationen liegen als SQL mit Platzhaltern im Paket (`migrations/iam_NNN_*.sql`); `iamMigrations` setzt
 *   Schema und Datenbankrollen ein. Die Prüfsumme gilt für den eingesetzten Text.
 * - Relationen und Typen der Tupel (CHECK-Bedingungen von `authz_tuple`) hängen am Modell der App und ändern sich mit
 *   ihm. Sie stehen deshalb nicht in einer Migration, sondern werden nach den IAM-Migrationen abgeglichen
 *   (`syncModelChecks`): ein neuer Typ oder eine neue Rolle braucht keine eigene Migration und bricht keine Prüfsumme.
 * - Übernahme (`adopted`): Eine App, die die Objekte schon aus eigenen Migrationen hat (Assets bis 049, mit `adopted.map` bis 053), trägt die
 *   IAM-Migrationen bis IAM_BASELINE als angewendet ein, ohne sie auszuführen – nur wenn ihre Vorbedingungen erfüllt
 *   sind (in derselben Transaktion), sonst bricht der Runner ab und trägt nichts ein. Die IAM-Migrationen laufen dann
 *   direkt nach der Marke der App (`after`), spätere Migrationen der App danach; so dürfen auch diese spätere
 *   IAM-Migrationen voraussetzen.
 * - Übernahme späterer IAM-Migrationen (`adopted.map`): Hat die App auch Entsprechungen nach der Grundlage schon
 *   angewendet (Assets 051–053 = iam_010–012), nennt sie die Zuordnung. Diese IAM-Migrationen werden dann ebenfalls nur
 *   eingetragen – wenn die Migration der App angewendet ist und die Objekte bestehen, sonst Abbruch. `after` ist dann
 *   die letzte dieser Migrationen der App (Assets: `053_acl_unique.sql`), damit sie auch in einer frischen Datenbank
 *   vor der Übernahme laufen.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { productIdent } from './config.ts';
import { LOCKS } from './locks.ts';
import { ADMIN_ROLE, ORG, type Model } from './model.ts';

export interface Migration { name: string; sql: string; checksum: string }

/** Übernahme bestehender Objekte statt Ausführung (siehe oben). */
export interface Adoption {
  /** Letzte übernommene Migration der Quelle (einschliesslich). */
  upTo: string;
  /** Weitere übernommene Migrationen der Quelle nach `upTo`, je mit der Migration einer anderen Quelle, die ihr entspricht. */
  also?: { name: string; when: string }[];
  /** Marke in einer anderen Quelle: Diese Quelle läuft direkt nach ihr. */
  after: string;
  /** Befunde, warum nicht übernommen werden darf (leer = erfüllt); läuft als Besitzer-Rolle vor dem Eintragen. */
  check(client: pg.ClientBase): Promise<string[]>;
}

export interface MigrationSource {
  /** Name für Meldungen, z. B. `iam` oder der Ordner der App. */
  name: string;
  migrations: Migration[];
  adopt?: Adoption;
  /** Rolle, als die der Runner laufen muss (Besitzerin aller Objekte). */
  owner?: string;
  /** Abgleich nach den Migrationen der Quelle (in einer Transaktion); liefert Meldungen. */
  sync?(client: pg.ClientBase): Promise<string[]>;
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
  /** Modell der App (Typen und Relationen für die CHECKs von `authz_tuple`); Standard nur `org` mit `org-admin`. */
  model?: ModelChecksInput | Pick<Model, 'types' | 'allRelations'>;
  /**
   * Objekte bestehen schon aus Migrationen der App (Assets: bis `049_tenant_roles.sql`): IAM-Migrationen bis
   * `IAM_BASELINE` nur eintragen, wenn `after` angewendet ist und die Objekte geschützt vorhanden sind.
   */
  adopted?: {
    after: string;
    /**
     * Migrationen der App, die IAM-Migrationen nach der Grundlage entsprechen (Name der App → Name im IAM); diese werden
     * nur eingetragen. Assets: `{ '051_revoke_public_execute.sql': 'iam_010_revoke_public_execute.sql',
     * '052_resolve_tenant_strict.sql': 'iam_011_resolve_tenant_strict.sql', '053_acl_unique.sql': 'iam_012_acl_unique.sql' }`
     * mit `after: '053_acl_unique.sql'` (`ASSETS_ADOPTION`).
     */
    map?: Record<string, string>;
  };
}

/** Übernahme für Assets: alles bis 053, ausgeführt werden nur iam_009 und neuere (Entwurf 6.4). */
export const ASSETS_ADOPTION = {
  after: '053_acl_unique.sql',
  map: { '051_revoke_public_execute.sql': 'iam_010_revoke_public_execute.sql', '052_resolve_tenant_strict.sql': 'iam_011_resolve_tenant_strict.sql', '053_acl_unique.sql': 'iam_012_acl_unique.sql' },
} as const satisfies NonNullable<IamMigrationOptions['adopted']>;

/** Letzte IAM-Migration, die dem Stand von Assets nach Migration 049 entspricht (Übernahme). */
export const IAM_BASELINE = 'iam_008_entra.sql';

/** Längste Wartezeit einer Migration auf eine Sperre (Tabellen im Betrieb). */
const MIGRATION_LOCK_TIMEOUT = '10s';

/** Ordner der SQL-Vorlagen (im Paket neben `src` bzw. `dist`). */
export const IAM_MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

/** Platzhalter `{{name}}` einsetzen; unbekannte Platzhalter sind ein Fehler. */
export function render(sql: string, vars: Record<string, string>): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!Object.hasOwn(vars, k)) throw new Error(`Unbekannter Platzhalter {{${k}}}`);
    return vars[k]!;
  });
}

/** Die SQL-Migrationen des IAM mit eingesetzten Parametern, dazu Abgleich der Ressourcentypen und ggf. Übernahme. */
export function iamMigrations(o: IamMigrationOptions): MigrationSource {
  const ident = productIdent(o.product);
  const schema = o.schema ?? ident;
  if (!IDENT.test(schema)) throw new Error(`schema: ungültiger Bezeichner «${schema}»`);
  const checks = o.model && 'allRelations' in o.model ? modelChecksInput(o.model) : o.model;
  modelChecks(checks);
  const roles = { owner: `${ident}_owner`, app: `${ident}_app`, sched: `${ident}_sched` };
  const files = readdirSync(IAM_MIGRATIONS_DIR).filter(f => /^iam_\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const migrations = files.map(f => migration(f, render(readFileSync(join(IAM_MIGRATIONS_DIR, f), 'utf8'), { schema, ...roles })));
  return {
    name: 'iam', migrations, owner: roles.owner,
    sync: c => syncModelChecks(c, schema, checks),
    ...(o.adopted ? { adopt: adoption(o.adopted, migrations, schema, roles.app, roles.sched) } : {}),
  };
}

/** Übernahme prüfen und zusammenstellen: zugeordnete IAM-Migrationen gibt es und sie liegen nach der Grundlage. */
function adoption(a: NonNullable<IamMigrationOptions['adopted']>, migrations: Migration[], schema: string, app: string, sched: string): Adoption {
  const also = Object.entries(a.map ?? {}).map(([when, name]) => ({ name, when }));
  for (const x of also) {
    if (!migrations.some(m => m.name === x.name)) throw new Error(`adopted.map: IAM-Migration ${x.name} gibt es nicht`);
    if (x.name <= IAM_BASELINE) throw new Error(`adopted.map: ${x.name} gehört zur Grundlage (bis ${IAM_BASELINE}) und wird ohnehin übernommen`);
  }
  if (new Set(also.map(x => x.name)).size !== also.length) throw new Error('adopted.map: eine IAM-Migration ist mehrfach zugeordnet');
  return { upTo: IAM_BASELINE, after: a.after, also, check: c => adoptionProblems(c, { schema, app, sched, after: a.after, also }) };
}

/** Typen und Relationen für die CHECKs von `authz_tuple`: aus dem Modell, sonst nur `org` mit `org-admin`. */
export interface ModelChecksInput { types: readonly string[]; relations: readonly string[] }

/** Typen und Relationen eines Modells (Relationen aller Typen und alle Rollen). */
export function modelChecksInput(model: Pick<Model, 'types' | 'allRelations'>): ModelChecksInput {
  return { types: [...model.types.keys()], relations: model.allRelations() };
}

function checkInput(o: ModelChecksInput | undefined): ModelChecksInput {
  const types = [...new Set(o?.types ?? [ORG])], relations = [...new Set(o?.relations ?? [ADMIN_ROLE])];
  if (!types.includes(ORG)) throw new Error('model: Typ «org» fehlt (Wurzel der Kette)');
  for (const t of [...types, ...relations]) if (!TYPE.test(t)) throw new Error(`model: Schlüssel «${t}» ungültig`);
  return { types, relations };
}

const lit = (v: string) => `'${v}'`;
const arr = (v: readonly string[]) => `ARRAY[${v.map(x => `'${x}'::text`).join(', ')}]`;
const inCheck = (col: string, v: readonly string[]) => ({
  sql: `CHECK (${col} IN (${v.map(lit).join(', ')}))`,
  // IN mit einem Wert gibt PostgreSQL als Vergleich aus
  def: v.length === 1 ? `CHECK ((${col} = ${lit(v[0]!)}::text))` : `CHECK ((${col} = ANY (${arr(v)})))`,
});

/** Bedingungen von `authz_tuple` zu Relationen und Typen: SQL zum Anlegen und die Form, die PostgreSQL ausgibt. */
export function modelChecks(o?: ModelChecksInput): Record<string, { sql: string; def: string }> {
  const { types, relations } = checkInput(o);
  return { authz_tuple_relation_check: inCheck('relation', relations), authz_tuple_object_type_check: inCheck('object_type', types) };
}

/**
 * Gleicht die CHECKs von `authz_tuple` mit dem Modell ab (nach den IAM-Migrationen, bei jedem Lauf; Spezifikation 10.2).
 * Unverändert → nichts. Tupel mit einer nicht mehr bekannten Relation oder einem entfernten Typ lassen den Abgleich
 * scheitern (Kap. 8.2: zuerst ihre Tupel löschen).
 */
export async function syncModelChecks(c: pg.ClientBase, schema: string, model?: ModelChecksInput | Pick<Model, 'types' | 'allRelations'>): Promise<string[]> {
  if (!IDENT.test(schema)) throw new Error(`schema: ungültiger Bezeichner «${schema}»`);
  const want = modelChecks(model && 'allRelations' in model ? modelChecksInput(model) : model);
  if (!(await c.query('SELECT to_regclass($1) AS t', [`${schema}.authz_tuple`])).rows[0].t) return [];
  const have = new Map((await c.query<{ n: string; d: string }>(
    `SELECT conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = '${schema}.authz_tuple'::regclass AND conname = ANY ($1)`,
    [Object.keys(want)])).rows.map(r => [r.n, r.d]));
  const out: string[] = [];
  for (const [name, w] of Object.entries(want)) {
    if (have.get(name) === w.def) continue;
    try {
      await c.query('SAVEPOINT model_check');
      await c.query(`ALTER TABLE ${schema}.authz_tuple DROP CONSTRAINT IF EXISTS ${name}`);
      await c.query(`ALTER TABLE ${schema}.authz_tuple ADD CONSTRAINT ${name} ${w.sql}`);
      await c.query('RELEASE SAVEPOINT model_check');
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT model_check');
      throw new Error(`Bedingung ${name} lässt sich nicht an das Modell anpassen (${(e as Error).message}): Tupel mit entfernten Relationen oder Typen zuerst löschen.`);
    }
    out.push(`Bedingung ${name} an das Modell angepasst`);
  }
  return out;
}

/** Tabellen und Funktionen, die die Übernahme voraussetzt (Stand Assets 049). */
const BASELINE_TABLES = ['tenant', 'principal', 'acl_entry', 'tenant_role', 'member_invitation', 'client_grant', 'session', 'replay_guard', 'rate_limit', 'audit_log', 'audit_anchor', 'entra_connection', 'entra_consent'];
/** Mandantentabellen darunter: RLS mit FORCE und Policy tenant_isolation. */
const BASELINE_TENANT_TABLES = ['principal', 'acl_entry', 'tenant_role', 'member_invitation', 'client_grant', 'audit_log', 'audit_anchor', 'entra_connection', 'entra_consent'];
const BASELINE_COLUMNS: [string, string][] = [['principal', 'last_roles'], ['principal', 'removed_at'], ['member_invitation', 'id'], ['member_invitation', 'entra'], ['audit_log', 'seq'], ['session', 'idp_sid'], ['tenant_role', 'deleted_at']];
const BASELINE_FUNCTIONS = ['tenant_id', 'principal_id', 'secure_tenant_tables', 'resolve_tenant', 'bump_acl_version', 'audit_hash', 'audit_chain', 'suspended_tenants', 'platform_tenants', 'set_tenant_status', 'entra_login_alias', 'entra_free_slot', 'entra_domains_taken'];
const BASELINE_DEFINER = ['resolve_tenant', 'bump_acl_version', 'suspended_tenants', 'platform_tenants', 'set_tenant_status', 'entra_login_alias', 'entra_free_slot', 'entra_domains_taken'];
const TENANT_EXPR = '(tenant_id = app.tenant_id())';
const SELF_EXPR = '(id = app.tenant_id())';

/**
 * Vorbedingungen der Übernahme: Marke `after` angewendet; Tabellen, Spalten und Funktionen vorhanden und geschützt
 * (RLS mit FORCE und tenant_isolation je Mandantentabelle, tenant_self, kein Recht für PUBLIC, SECURITY DEFINER mit
 * festem search_path). Die Bedingungen zu Ressourcentypen gleicht danach `syncAclChecks` ab.
 */
export async function adoptionProblems(c: pg.ClientBase, o: { schema: string; app: string; sched?: string; after: string; also?: { name: string; when: string }[] }): Promise<string[]> {
  const { schema, app } = o;
  const out: string[] = [];
  if (!(await c.query('SELECT 1 FROM public.schema_migrations WHERE name = $1', [o.after])).rowCount) out.push(`Migration ${o.after} ist nicht angewendet`);
  for (const x of o.also ?? []) {
    if (!(await c.query('SELECT 1 FROM public.schema_migrations WHERE name = $1', [x.when])).rowCount) out.push(`Migration ${x.when} (für ${x.name}) ist nicht angewendet`);
    const problem = await laterObjectProblem(c, schema, { app, sched: o.sched ?? app.replace(/_app$/, '_sched') }, x.name);
    if (problem) out.push(`${x.name}: ${problem}`);
  }
  const tables = new Map((await c.query<{ t: string; rls: boolean; force: boolean; pub: boolean }>(
    `SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x WHERE x.grantee = 0) AS pub
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r'`, [schema])).rows.map(r => [r.t, r]));
  for (const t of BASELINE_TABLES) {
    const r = tables.get(t);
    if (!r) { out.push(`Tabelle ${schema}.${t} fehlt`); continue; }
    if (r.pub) out.push(`Tabelle ${schema}.${t}: PUBLIC hat Rechte`);
  }
  const policies = new Map((await c.query<{ k: string; roles: string[]; cmd: string; q: string | null; w: string | null }>(
    "SELECT tablename || '.' || policyname AS k, roles::text[] AS roles, cmd, qual AS q, with_check AS w FROM pg_policies WHERE schemaname = $1", [schema])).rows.map(r => [r.k, r]));
  const policyOk = (k: string, expr: string) => {
    const p = policies.get(k);
    return !!p && p.cmd === 'ALL' && p.roles.length === 1 && p.roles[0] === app && p.q === expr && p.w === expr;
  };
  for (const t of BASELINE_TENANT_TABLES) {
    const r = tables.get(t);
    if (!r) continue;
    if (!r.rls || !r.force) out.push(`Tabelle ${schema}.${t}: RLS mit FORCE fehlt`);
    if (!policyOk(`${t}.tenant_isolation`, TENANT_EXPR)) out.push(`Tabelle ${schema}.${t}: Policy tenant_isolation für ${app} mit app.tenant_id() fehlt`);
  }
  if (tables.get('tenant') && (!tables.get('tenant')!.rls || !policyOk('tenant.tenant_self', SELF_EXPR))) out.push(`Tabelle ${schema}.tenant: RLS mit Policy tenant_self fehlt`);
  const cols = new Set((await c.query<{ k: string }>("SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = $1", [schema])).rows.map(r => r.k));
  for (const [t, col] of BASELINE_COLUMNS) if (tables.has(t) && !cols.has(`${t}.${col}`)) out.push(`Spalte ${schema}.${t}.${col} fehlt`);
  const fns = new Map((await c.query<{ f: string; secdef: boolean; config: string[] | null }>(
    "SELECT p.proname AS f, p.prosecdef AS secdef, p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'")).rows.map(r => [r.f, r]));
  for (const f of BASELINE_FUNCTIONS) if (!fns.has(f)) out.push(`Funktion app.${f} fehlt`);
  for (const f of BASELINE_DEFINER) {
    const r = fns.get(f);
    if (r && !(r.secdef && (r.config ?? []).includes(`search_path=${schema}, pg_temp`))) out.push(`Funktion app.${f}: SECURITY DEFINER mit search_path=${schema}, pg_temp fehlt`);
  }
  return out;
}

/**
 * Zustand einer übernommenen IAM-Migration nach der Grundlage – wie die Migration ihn herstellt, nicht nur ein Merkmal:
 * Rechte (iam_010), Verhalten (iam_011, Probe in einer zurückgerollten Teiltransaktion), Katalog (iam_009, iam_012).
 */
async function laterObjectProblem(c: pg.ClientBase, schema: string, roles: { app: string; sched: string }, name: string): Promise<string | null> {
  if (name.startsWith('iam_009_')) {
    const pk = (await c.query<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'", [`${schema}.tenant_role`])).rows[0]?.d;
    return pk === 'PRIMARY KEY (tenant_id, id)' ? null : `Primärschlüssel ${schema}.tenant_role (tenant_id, id) fehlt`;
  }
  if (name.startsWith('iam_010_')) {
    const pub = (await c.query<{ f: string }>(
      `SELECT n.nspname || '.' || p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('app', $1) AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')`, [schema])).rows.map(r => r.f);
    if (pub.length) return `PUBLIC darf noch ausführen: ${pub.join(', ')}`;
    // Ohne diese Rechte scheitert app.audit_chain() (Trigger der Audit-Kette) für App und Scheduler
    const fn = `app.audit_hash(bytea, ${schema}.audit_log)`;
    const missing = [];
    for (const role of [roles.app, roles.sched]) {
      if (!(await c.query<{ ok: boolean }>('SELECT has_function_privilege($1, $2, $3) AS ok', [role, fn, 'EXECUTE'])).rows[0]!.ok) missing.push(role);
    }
    return missing.length ? `EXECUTE auf ${fn} fehlt für ${missing.join(', ')}` : null;
  }
  if (name.startsWith('iam_011_')) return resolveTenantProbe(c);
  if (name.startsWith('iam_012_')) {
    const idx = (await c.query<{ unique: boolean; valid: boolean; partial: boolean; expr: boolean; nnd: boolean; cols: string[] }>(
      `SELECT i.indisunique AS unique, i.indisvalid AS valid, i.indpred IS NOT NULL AS partial, i.indexprs IS NOT NULL AS expr, i.indnullsnotdistinct AS nnd,
              array(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols
         FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid
        WHERE i.indrelid = $1::regclass AND x.relname = 'acl_entry_unique'`, [`${schema}.acl_entry`])).rows[0];
    const cols = ['tenant_id', 'resource_type', 'resource_id', 'principal_type', 'principal_ref', 'permission', 'effect'];
    if (!idx) return `eindeutiger Index ${schema}.acl_entry_unique fehlt`;
    const ok = idx.unique && idx.valid && !idx.partial && !idx.expr && idx.nnd && idx.cols.join() === cols.join();
    return ok ? null : `Index ${schema}.acl_entry_unique entspricht nicht iam_012 (UNIQUE, gültig, ohne Bedingung, NULLS NOT DISTINCT, Spalten ${cols.join(', ')})`;
  }
  return 'keine Prüfung für diese Migration bekannt; nur iam_009 bis iam_012 lassen sich übernehmen';
}

/**
 * Verhalten von app.resolve_tenant nach iam_011, geprüft in einer Teiltransaktion, die danach zurückgerollt wird
 * (nichts bleibt): ungültiger Alias (Kelvin-Zeichen) → NULL; Organisations-ID eines anderen Mandanten beim Anlegen und
 * beim Binden → NULL statt Fehler bzw. fremder Mandant.
 */
async function resolveTenantProbe(c: pg.ClientBase): Promise<string | null> {
  const r = (alias: string, kc: string | null, create: boolean) => c.query<{ id: string | null }>('SELECT app.resolve_tenant($1, $2, $3, $4) AS id', [alias, kc, 'Probe', create]).then(x => x.rows[0]!.id);
  const tag = `iamprobe-${Date.now().toString(36)}`, kc = `${tag}-org`;
  await c.query('SAVEPOINT iam_probe');
  try {
    if (!(await r(`${tag}-a`, kc, true))) return 'app.resolve_tenant legt keinen Mandanten an';
    await r(`${tag}-k`, null, true);
    if (await r(`${tag}-\u212a`, null, false)) return 'app.resolve_tenant findet einen Mandanten über einen ungültigen Alias (Kelvin-Zeichen)';
    if (await r(`${tag}-b`, kc, true)) return 'app.resolve_tenant legt einen Mandanten mit der Organisations-ID eines anderen an';
    if (await r(`${tag}-k`, kc, false)) return 'app.resolve_tenant bindet die Organisations-ID eines anderen Mandanten';
    return null;
  } catch (e) {
    return `app.resolve_tenant: ${(e as Error).message}`;
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT iam_probe');
  }
}

/** Reihenfolge der Ausführung: Quellen wie gegeben, eine übernommene Quelle direkt nach ihrer Marke. */
function plan(sources: MigrationSource[]): MigrationSource[] {
  const order: { s: MigrationSource; from: number; to: number }[] = [];
  const deferred = sources.filter(s => s.adopt);
  for (const s of sources.filter(x => !x.adopt)) {
    const cut = deferred.map(d => ({ d, i: s.migrations.findIndex(m => m.name === d.adopt!.after) })).filter(x => x.i >= 0).sort((a, b) => a.i - b.i);
    let from = 0;
    for (const { d, i } of cut) { order.push({ s, from, to: i + 1 }, { s: d, from: 0, to: d.migrations.length }); from = i + 1; }
    order.push({ s, from, to: s.migrations.length });
  }
  // Übernommene Quelle ohne Marke in einer anderen Quelle (bestehende Datenbank, Marke nur in schema_migrations): am Ende
  for (const d of deferred) if (!order.some(o => o.s === d)) order.push({ s: d, from: 0, to: d.migrations.length });
  return order.filter(o => o.to > o.from || o.s.adopt || o.s.sync).map(o => ({ ...o.s, migrations: o.s.migrations.slice(o.from, o.to) }));
}

/**
 * Führt die Migrationen aller Quellen aus (als Besitzer-Rolle, `adminUrl`).
 * @param log Meldung je ausgeführter oder übernommener Migration und je Abgleich
 */
export async function migrate(adminUrl: string, sources: MigrationSource[], log: (m: string) => void = () => undefined): Promise<MigrationResult> {
  const names = new Map<string, string>();
  for (const s of sources) for (const m of s.migrations) {
    if (names.has(m.name)) throw new Error(`Migration ${m.name} kommt in ${names.get(m.name)} und ${s.name} vor`);
    names.set(m.name, s.name);
  }
  for (const s of sources) if (s.adopt && !s.migrations.some(m => m.name === s.adopt!.upTo)) throw new Error(`Übernahme bis ${s.adopt.upTo}: Migration fehlt in ${s.name}`);
  const client = new pg.Client({ connectionString: adminUrl, application_name: 'iam-migrate' });
  await client.connect();
  try {
    // Alle Objekte gehören der Besitzer-Rolle (Rechte, Standardrechte, Policies für die Besitzer-Rolle)
    const user = (await client.query<{ u: string }>('SELECT current_user AS u')).rows[0]!.u;
    for (const s of sources) if (s.owner && s.owner !== user) throw new Error(`Migrationen von ${s.name} laufen als ${s.owner}, nicht als ${user}`);
    await client.query('SELECT pg_advisory_lock($1)', [LOCKS.migrate]);
    await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Map((await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM public.schema_migrations')).rows.map(r => [r.name, r.checksum]));
    const applied: string[] = [], adopted: string[] = [];
    let total = 0;
    for (const s of sources) total += s.migrations.length;
    for (const s of plan(sources)) {
      for (const m of s.migrations) {
        if (done.has(m.name) && done.get(m.name) !== m.checksum) throw new Error(`Migration ${m.name} wurde nach dem Ausführen geändert (Prüfsumme). Änderungen gehören in eine neue Migration.`);
      }
      // Übernahme: Vorbedingungen und Einträge in einer Transaktion
      const upTo = s.adopt ? s.migrations.findIndex(m => m.name === s.adopt!.upTo) : -1;
      const also = new Set((s.adopt?.also ?? []).map(x => x.name));
      const toAdopt = s.migrations.filter((m, i) => (i <= upTo || also.has(m.name)) && !done.has(m.name));
      if (s.adopt && toAdopt.length) {
        await client.query('BEGIN');
        try {
          const problems = await s.adopt.check(client);
          if (problems.length) throw new Error(`Übernahme der Migrationen von ${s.name} nicht möglich:\n  - ${problems.join('\n  - ')}`);
          for (const m of toAdopt) await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; }
        for (const m of toAdopt) { done.set(m.name, m.checksum); adopted.push(m.name); log(`Migration ${m.name} übernommen (Objekte bestehen)`); }
      }
      for (const m of s.migrations) {
        if (done.has(m.name)) continue;
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
          await client.query(m.sql);
          await client.query('SELECT app.secure_tenant_tables()');
          await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
          await client.query('COMMIT');
          done.set(m.name, m.checksum); applied.push(m.name); log(`Migration ${m.name} ausgeführt`);
        } catch (e) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${m.name} fehlgeschlagen: ${(e as Error).message}`);
        }
      }
      if (s.sync) {
        await client.query('BEGIN');
        try { for (const line of await s.sync(client)) log(line); await client.query('COMMIT'); } catch (e) { await client.query('ROLLBACK'); throw e; }
      }
    }
    return { applied, adopted, skipped: total - applied.length - adopted.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCKS.migrate]).catch(() => undefined);
    await client.end();
  }
}
