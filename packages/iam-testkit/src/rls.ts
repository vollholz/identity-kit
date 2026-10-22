/**
 * Allgemeine Prüfungen der Mandantentrennung in PostgreSQL (Spezifikation Kap. 10, 14). Jede Funktion liefert die
 * Befunde als Liste (leer = in Ordnung), damit Tests sie mit `assert.deepEqual(…, [])` prüfen und die Meldung lesbar ist.
 * Abfragen laufen als Superuser auf der Testdatenbank (`TestDb.inspect`). Policies, die eine App zusätzlich hat
 * (Lesesichten, eigene Personen), prüft die App selbst.
 */
import type pg from 'pg';

type Query = Pick<pg.Client, 'query'>;

const SYSTEM = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'";
const norm = (sql: string | null) => (sql === null ? null : sql.replace(/\s+/g, ' ').trim());

/**
 * Jede Tabelle mit `tenant_id` hat ENABLE + FORCE RLS und die Policy `tenant_isolation` (permissiv, ALL, nur `appRole`,
 * USING und CHECK `expression`); `tenant_isolation` gibt es nur auf solchen Tabellen.
 * @param o.expression Standard `(tenant_id = app.tenant_id())` (so, wie PostgreSQL ihn ausgibt)
 * @param o.minTables mindestens so viele Mandantentabellen (gegen leeres Grün)
 */
export async function tenantTableProblems(db: Query, o: { appRole: string; expression?: string; minTables?: number }): Promise<string[]> {
  const expr = o.expression ?? '(tenant_id = app.tenant_id())';
  const rows = (await db.query<{ tbl: string; rls: boolean; force: boolean; iso: string | null }>(`
    SELECT n.nspname || '.' || c.relname AS tbl, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
           (SELECT p.permissive || ' ' || p.cmd || ' ' || array_to_string(p.roles, ',') || ' USING ' || coalesce(p.qual, '-') || ' CHECK ' || coalesce(p.with_check, '-')
              FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS iso
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND ${SYSTEM}
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     ORDER BY 1`)).rows;
  const out: string[] = [];
  if (rows.length < (o.minTables ?? 1)) out.push(`nur ${rows.length} Tabellen mit tenant_id gefunden (erwartet mindestens ${o.minTables ?? 1})`);
  const want = `PERMISSIVE ALL ${o.appRole} USING ${expr} CHECK ${expr}`;
  for (const r of rows) if (!(r.rls && r.force && norm(r.iso) === want)) out.push(`${r.tbl}: rls=${r.rls} force=${r.force} tenant_isolation=${norm(r.iso) ?? 'fehlt'}`);
  const elsewhere = (await db.query<{ t: string }>(`SELECT schemaname || '.' || tablename AS t FROM pg_policies WHERE policyname = 'tenant_isolation' ORDER BY 1`)).rows;
  for (const e of elsewhere) if (!rows.some(r => r.tbl === e.t)) out.push(`${e.t}: tenant_isolation auf einer Tabelle ohne tenant_id`);
  return out;
}

/**
 * Jede Tabelle (auch Sicht), auf die eine der `roles` Rechte hat, hat `tenant_id` mit RLS und FORCE oder steht mit
 * Begründung in `withoutTenant`; jede Ausnahme besteht noch und hat wirklich kein `tenant_id`; keine dieser Rollen darf
 * TRUNCATE (umgeht RLS).
 */
export async function grantedTableProblems(db: Query, o: { roles: string[]; withoutTenant: Record<string, string>; minTables?: number }): Promise<string[]> {
  const rows = (await db.query<{ tbl: string; tenant: boolean; rls: boolean; force: boolean; roles: string[]; truncate: string[] }>(`
    SELECT n.nspname || '.' || c.relname AS tbl, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS tenant,
           ARRAY(SELECT r FROM unnest($1::text[]) r WHERE has_table_privilege(r, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                   OR has_any_column_privilege(r, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')) AS roles,
           ARRAY(SELECT r FROM unnest($1::text[]) r WHERE has_table_privilege(r, c.oid, 'TRUNCATE')) AS truncate
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ${SYSTEM}
     ORDER BY 1`, [o.roles])).rows;
  const granted = rows.filter(r => r.roles.length);
  const out: string[] = [];
  if (granted.length < (o.minTables ?? 1)) out.push(`nur ${granted.length} Tabellen mit Rechten gefunden (erwartet mindestens ${o.minTables ?? 1})`);
  for (const r of granted) if (!(r.tenant && r.rls && r.force) && !o.withoutTenant[r.tbl]) out.push(`${r.tbl} (${r.roles.join(', ')}): ohne Mandantentrennung (tenant_id=${r.tenant} rls=${r.rls} force=${r.force}) und nicht begründet ausgenommen`);
  for (const tbl of Object.keys(o.withoutTenant)) if (!granted.some(r => r.tbl === tbl && !r.tenant)) out.push(`Ausnahme ${tbl} veraltet (fehlt, ohne Rechte oder hat tenant_id)`);
  for (const r of rows) if (r.truncate.length) out.push(`${r.tbl}: TRUNCATE für ${r.truncate.join(', ')}`);
  return out;
}

const PUBLIC_EXEC = `EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')`;

/**
 * SECURITY DEFINER: fester `search_path` mit `pg_temp` am Ende, nicht für PUBLIC ausführbar. Mit `allowed` muss jede
 * solche Funktion begründet aufgeführt sein (Signatur wie `schema.name(arg typen)`), und jede aufgeführte bestehen.
 */
export async function securityDefinerProblems(db: Query, o: { allowed?: Record<string, string> } = {}): Promise<string[]> {
  const rows = (await db.query<{ f: string; config: string[] | null; pub: boolean }>(`
    SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f, p.proconfig AS config, ${PUBLIC_EXEC} AS pub
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`)).rows;
  const out: string[] = [];
  for (const r of rows) {
    // Ohne pg_temp am Ende sucht PostgreSQL zuerst in pg_temp: ein Aufrufer könnte Tabellen oder Funktionen unterschieben
    if (!(r.config ?? []).some(c => /^search_path=.+, pg_temp$/.test(c))) out.push(`${r.f}: search_path ohne pg_temp am Ende (${r.config?.join(' ') ?? 'kein search_path'})`);
    if (r.pub) out.push(`${r.f}: PUBLIC darf ausführen`);
    if (o.allowed && !o.allowed[r.f]) out.push(`${r.f}: SECURITY DEFINER ohne Begründung`);
  }
  for (const f of Object.keys(o.allowed ?? {})) if (!rows.some(r => r.f === f)) out.push(`Ausnahme ${f} veraltet`);
  return out;
}

/**
 * Funktionen in `schemas`, die PUBLIC erreicht: EXECUTE (Standardrecht von PostgreSQL) **und** USAGE auf das Schema.
 * Mit `strict` jede Funktion mit EXECUTE für PUBLIC, auch in Schemas ohne USAGE für PUBLIC (Tiefenverteidigung).
 */
export async function publicExecuteProblems(db: Query, o: { schemas: string[]; strict?: boolean }): Promise<string[]> {
  const rows = (await db.query<{ f: string; usage: boolean }>(`
    SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f,
           EXISTS (SELECT 1 FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) x WHERE x.grantee = 0 AND x.privilege_type = 'USAGE') AS usage
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ANY ($1::text[]) AND ${PUBLIC_EXEC} ORDER BY 1`, [o.schemas])).rows;
  return rows.filter(r => r.usage || o.strict).map(r => `${r.f}: PUBLIC darf ausführen${r.usage ? '' : ' (Schema ohne USAGE für PUBLIC)'}`);
}

/** Schemas in `schemas`, auf die PUBLIC USAGE oder CREATE hat. */
export async function publicSchemaProblems(db: Query, o: { schemas: string[] }): Promise<string[]> {
  const rows = (await db.query<{ s: string; priv: string }>(`
    SELECT n.nspname AS s, x.privilege_type AS priv FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) x
     WHERE n.nspname = ANY ($1::text[]) AND x.grantee = 0 ORDER BY 1, 2`, [o.schemas])).rows;
  const out = rows.map(r => `Schema ${r.s}: ${r.priv} für PUBLIC`);
  const found = (await db.query<{ s: string }>('SELECT nspname AS s FROM pg_namespace WHERE nspname = ANY ($1::text[])', [o.schemas])).rows.map(r => r.s);
  for (const s of o.schemas) if (!found.includes(s)) out.push(`Schema ${s} fehlt`);
  return out;
}

/** Rollen mit diesem Präfix (z. B. `assets_`) dürfen weder Superuser sein noch RLS umgehen. */
export async function bypassRoleProblems(db: Query, o: { rolePrefix: string }): Promise<string[]> {
  const rows = (await db.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
    `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE starts_with(rolname, $1) ORDER BY 1`, [o.rolePrefix])).rows;
  const out = rows.filter(r => r.rolbypassrls || r.rolsuper).map(r => `${r.rolname}: ${r.rolsuper ? 'Superuser' : 'BYPASSRLS'}`);
  if (!rows.length) out.push(`keine Rollen mit Präfix ${o.rolePrefix}`);
  return out;
}
