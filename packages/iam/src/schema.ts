/**
 * Abzug der Datenbankobjekte des IAM (Entwurf Kap. 6.4): Tabellen mit Besitzer, Spalten, Bedingungen, Indizes,
 * Policies, Triggern, RLS und Rechten; Sequenzen mit Besitzer und Rechten; Funktionen mit Besitzer, Rumpf,
 * SECURITY DEFINER, Einstellungen und Rechten; Rechte der Schemas und Standardrechte. Spalten nach Namen (nicht nach
 * Position), Rechte sortiert. Für den Gleichheitstest mit Assets und für Apps, die ihre Übernahme selbst prüfen.
 */
import type pg from 'pg';

/** Tabellen des IAM (Stand Assets 049). */
export const IAM_TABLES = ['tenant', 'principal', 'acl_entry', 'tenant_role', 'member_invitation', 'client_grant', 'session', 'replay_guard', 'rate_limit', 'audit_log', 'audit_anchor', 'entra_connection', 'entra_consent', 'entra_consent_link'];
/** Funktionen des IAM im Schema `app`. */
export const IAM_FUNCTIONS = ['tenant_id', 'principal_id', 'secure_tenant_tables', 'resolve_tenant', 'bump_acl_version', 'audit_hash', 'audit_chain', 'suspended_tenants', 'platform_tenants', 'set_tenant_status', 'entra_login_alias', 'entra_free_slot', 'entra_domains_taken'];

const sortAcl = (acl: string[] | null) => (acl ? [...acl].sort() : null);

export interface SchemaSnapshot {
  schemas: Record<string, string[] | null>;
  defaultAcl: string[];
  tables: Record<string, unknown>;
  sequences: Record<string, unknown>;
  functions: Record<string, unknown>;
}

/** @param c Superuser-Verbindung auf die Datenbank */
export async function schemaSnapshot(c: pg.ClientBase, schema: string, tables = IAM_TABLES, functions = IAM_FUNCTIONS): Promise<SchemaSnapshot> {
  const out: SchemaSnapshot = { schemas: {}, defaultAcl: [], tables: {}, sequences: {}, functions: {} };
  for (const r of (await c.query<{ n: string; acl: string[] | null }>('SELECT nspname AS n, nspacl::text[] AS acl FROM pg_namespace WHERE nspname = ANY($1) ORDER BY 1', [['app', schema]])).rows) out.schemas[r.n] = sortAcl(r.acl);
  out.defaultAcl = (await c.query<{ d: string }>(
    `SELECT pg_get_userbyid(d.defaclrole) || ' ' || coalesce(n.nspname, '*') || ' ' || d.defaclobjtype::text || ' ' || array_to_string(ARRAY(SELECT x FROM unnest(d.defaclacl::text[]) x ORDER BY x), ',') AS d
       FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace ORDER BY 1`)).rows.map(r => r.d);
  for (const t of tables) {
    const rel = (await c.query<{ oid: number; owner: string; persistence: string; rls: boolean; force: boolean; acl: string[] | null }>(
      `SELECT c.oid, pg_get_userbyid(c.relowner) AS owner, c.relpersistence::text AS persistence, c.relrowsecurity AS rls, c.relforcerowsecurity AS force, c.relacl::text[] AS acl
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`, [schema, t])).rows[0];
    if (!rel) { out.tables[t] = null; continue; }
    const columns = Object.fromEntries((await c.query<{ name: string; type: string; notnull: boolean; def: string | null; identity: string; acl: string[] | null }>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def,
              a.attidentity::text AS identity, a.attacl::text[] AS acl
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname`, [rel.oid])).rows
      .map(r => [r.name, { type: r.type, notnull: r.notnull, default: r.def, identity: r.identity || null, acl: sortAcl(r.acl) }]));
    const constraints = Object.fromEntries((await c.query<{ name: string; def: string }>(
      'SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1 ORDER BY conname', [rel.oid])).rows.map(r => [r.name, r.def]));
    const indexes = Object.fromEntries((await c.query<{ name: string; def: string }>(
      'SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname', [schema, t])).rows.map(r => [r.name, r.def]));
    const policies = Object.fromEntries((await c.query<{ name: string; cmd: string; permissive: string; roles: string[]; qual: string | null; check: string | null }>(
      'SELECT policyname AS name, cmd, permissive, roles::text[] AS roles, qual, with_check AS check FROM pg_policies WHERE schemaname = $1 AND tablename = $2 ORDER BY policyname', [schema, t])).rows
      .map(r => [r.name, { cmd: r.cmd, permissive: r.permissive, roles: [...r.roles].sort(), using: r.qual, check: r.check }]));
    const triggers = Object.fromEntries((await c.query<{ name: string; def: string }>(
      'SELECT tgname AS name, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal ORDER BY tgname', [rel.oid])).rows.map(r => [r.name, r.def]));
    out.tables[t] = { owner: rel.owner, persistence: rel.persistence, rls: rel.rls, force: rel.force, acl: sortAcl(rel.acl), columns, constraints, indexes, policies, triggers };
  }
  // Sequenzen der Tabellen (Identitätsspalten): Name nach Tabelle und Spalte, nicht nach dem erzeugten Namen
  for (const r of (await c.query<{ k: string; owner: string; acl: string[] | null }>(
    `SELECT t.relname || '.' || a.attname AS k, pg_get_userbyid(s.relowner) AS owner, s.relacl::text[] AS acl
       FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
       JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE n.nspname = $1 AND t.relname = ANY ($2) ORDER BY 1`, [schema, tables])).rows) out.sequences[r.k] = { owner: r.owner, acl: sortAcl(r.acl) };
  for (const f of functions) {
    const rows = (await c.query<{ args: string; owner: string; def: string; secdef: boolean; config: string[] | null; acl: string[] | null; volatile: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args, pg_get_userbyid(p.proowner) AS owner, pg_get_functiondef(p.oid) AS def, p.prosecdef AS secdef, p.proconfig AS config,
              p.proacl::text[] AS acl, p.provolatile::text AS volatile
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = $1 ORDER BY 1`, [f])).rows;
    out.functions[f] = rows.map(r => ({ ...r, acl: sortAcl(r.acl) }));
  }
  return out;
}

/** Unterschiede zweier Abzüge als Pfade (`tables.principal.columns.email.type: a ≠ b`). */
export function diffSnapshots(a: unknown, b: unknown, path = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap(k => diffSnapshots((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  return [`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`];
}
