/**
 * Konformität auf Ebene Datenbank (gegen eine laufende Datenbank der App, als Besitzer-Rolle `<produkt>_owner` oder
 * Superuser): Migrationen des Kits angewendet, Rollen ohne BYPASSRLS, Mandantentrennung (RLS), Lesesicht,
 * SECURITY DEFINER, PUBLIC – und jede aktive Organisation hat mindestens einen `org-admin`.
 * Die Ausnahmen des Kits stehen hier; die der App kommen begründet aus dem Manifest (`exceptions`).
 */
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type pg from 'pg';
import { finding, type Finding } from './report.ts';
import {
  bypassRoleProblems, grantedTableProblems, publicExecuteProblems, publicSchemaProblems, readViewProblems, securityDefinerProblems, tenantTableProblems,
} from '../rls.ts';
import { ADMIN_ROLE } from '../model.ts';

type Query = Pick<pg.Client, 'query'>;

/** Tabellen des Kits ohne tenant_id, auf die Laufzeit oder Worker Rechte haben (`{s}` = Schema). */
export const KIT_WITHOUT_TENANT: Record<string, string> = {
  '{s}.tenant': 'Mandantenzeile selbst: RLS mit tenant_self (nur der eigene Mandant), Schreiben nur name und settings',
  '{s}.session': 'Sitzungen der Oberfläche (BFF): verschlüsselt, Zugriff nur über die zufällige Sitzungs-ID',
  '{s}.rate_limit': 'Zähler des Rate-Limits je Route und Schlüssel, keine Mandantendaten',
  '{s}.replay_guard': 'Replay-Schutz (DPoP-Proofs, Logout-Tokens), nur Schlüssel und Ablauf',
};

/** SECURITY-DEFINER-Funktionen des Kits. */
export const KIT_SECURITY_DEFINER: Record<string, string> = {
  'app.resolve_tenant(p_alias text, p_kc_org_id text, p_name text, p_create boolean)': 'Mandant auflösen, bevor der Kontext gesetzt ist; liefert nur die ID',
  'app.bump_acl_version()': 'Trigger: Version des Mandanten nach Änderung an Tupeln und Freigabestufen',
  'app.suspended_tenants()': 'Worker: gesperrte Mandanten ohne Kontext',
  'app.platform_tenants()': 'Plattform-Administration: Mandanten aller Organisationen (API prüft platform-admin)',
  'app.set_tenant_status(p_id uuid, p_status text)': 'Plattform-Administration: sperren und entsperren',
  'app.entra_login_alias(p_domain text)': 'Resolver: Anbieter einer gebundenen Domäne, nie der Mandant',
  'app.entra_free_slot(p_max integer)': 'Entra: kleinster freier Platz',
  'app.entra_domains_taken(p_domains text[])': 'Entra: Domänen anderer Mandanten, ohne sie zu nennen',
  'app.account_touch(p_subject text, p_email text, p_name text)': 'Konto ohne Mandant: anlegen bzw. nachführen, liefert nur die eigene ID (iam 3.0)',
  'app.account_reserve_org(p_account uuid, p_limit integer)': 'Konto: Höchstzahl selbst erstellter Organisationen (atomar)',
  'app.account_release_org(p_account uuid)': 'Konto: Reservierung zurückgeben',
  'app.platform_audit(p_actor_kind text, p_actor_id uuid, p_actor_name text, p_source text, p_action text, p_resource_type text, p_resource_id uuid, p_org uuid, p_correlation text, p_data jsonb)': 'Protokoll der Plattform: nur anhängen',
};

/** Namen der Migrationen des installierten `@vollholz/iam` (aus `node_modules` der App). */
export function kitMigrationNames(appDir: string): string[] | null {
  try {
    const pkg = createRequire(join(appDir, 'package.json')).resolve('@vollholz/iam/package.json');
    const dir = join(dirname(pkg), 'migrations');
    return existsSync(dir) ? readdirSync(dir).filter(f => /^iam_\d{3}_[\w-]+\.sql$/.test(f)).sort() : null;
  } catch { return null; }
}

/** Jede aktive Organisation (Mandant) hat mindestens einen gültigen `org-admin` (Person nicht entfernt, Tupel nicht abgelaufen). */
export async function adminProblems(db: Query, schema: string): Promise<string[]> {
  const tenants = (await db.query<{ id: string; alias: string }>(`SELECT id, alias FROM ${schema}.tenant WHERE status = 'active' ORDER BY alias`)).rows;
  const out: string[] = [];
  await db.query('BEGIN');
  try {
    for (const t of tenants) {
      // Als Besitzer-Rolle nur im Kontext des Mandanten (Policy owner_tenant); als Superuser ohnehin
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);
      const n = (await db.query<{ n: number }>(`
        SELECT count(*)::int AS n FROM ${schema}.authz_tuple a
         WHERE a.tenant_id = $1 AND a.relation = $2 AND a.object_type = 'org' AND (a.expires_at IS NULL OR a.expires_at > now())
           AND (a.subject NOT LIKE 'user:%' OR EXISTS (SELECT 1 FROM ${schema}.principal p WHERE p.tenant_id = a.tenant_id AND a.subject = 'user:' || p.id AND p.removed_at IS NULL))`,
      [t.id, ADMIN_ROLE.key])).rows[0]!.n;
      if (!n) out.push(`Organisation ${t.alias}: kein ${ADMIN_ROLE.key} (npx iam-org-bootstrap --manifest identity.app.json, oder in der Oberfläche durch platform-admin)`);
    }
  } finally { await db.query('ROLLBACK'); }
  if (!tenants.length) out.push(`keine aktive Organisation in ${schema}.tenant (erste Organisation: npx iam-org-bootstrap --manifest identity.app.json)`);
  return out;
}

/** Rollen nach Spezifikation 10.1 vorhanden; Laufzeit, Worker und App-Rolle besitzen keine Objekte. */
async function roleProblems(db: Query, ident: string): Promise<string[]> {
  const want = ['owner', 'app', 'sched', 'runtime', 'worker'].map(r => `${ident}_${r}`);
  const have = (await db.query<{ r: string }>('SELECT rolname AS r FROM pg_roles WHERE rolname = ANY ($1::text[])', [want])).rows.map(x => x.r);
  const out = want.filter(r => !have.includes(r)).map(r => `Rolle ${r} fehlt (db/bootstrap.sql des Pakets)`);
  const owned = (await db.query<{ o: string; r: string }>(`
    SELECT n.nspname || '.' || c.relname AS o, pg_get_userbyid(c.relowner) AS r FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE pg_get_userbyid(c.relowner) = ANY ($1::text[]) ORDER BY 1`, [[`${ident}_app`, `${ident}_runtime`, `${ident}_worker`, `${ident}_sched`]])).rows;
  for (const x of owned) out.push(`${x.o} gehört ${x.r} (nur ${ident}_owner besitzt Objekte)`);
  return out;
}

export interface DbOptions {
  /** Produkt-Bezeichner für Rollen (`notes`, `my_app`). */
  ident: string;
  schema: string;
  /** Erwartete Migrationen des Kits; Standard aus `node_modules/@vollholz/iam` von `appDir`. */
  kitMigrations?: string[] | null;
  appDir?: string;
  exceptions?: { withoutTenant?: Record<string, string>; securityDefiner?: Record<string, string> };
}

export async function dbChecks(db: Query, o: DbOptions): Promise<Finding[]> {
  const out: Finding[] = [];
  const kit = { level: 'db', zone: 'fest' } as const;
  const S = o.schema, app = `${o.ident}_app`;

  const names = o.kitMigrations === undefined ? kitMigrationNames(o.appDir ?? process.cwd()) : o.kitMigrations;
  const hasTable = (await db.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS t")).rows[0]!.t as boolean;
  const applied = hasTable ? (await db.query<{ name: string }>('SELECT name FROM public.schema_migrations')).rows.map(r => r.name) : [];
  const mig: string[] = [];
  if (!hasTable) mig.push('public.schema_migrations fehlt: keine Migrationen gelaufen');
  else if (!names) mig.push('@vollholz/iam nicht installiert: erwartete Migrationen unbekannt');
  else {
    for (const n of names) if (!applied.includes(n)) mig.push(`${n} nicht angewendet (Migrationen des Kits vor denen der App: iamMigrations)`);
  }
  out.push(finding({ ...kit, check: 'Migrationen des Kits angewendet', source: 'identity-kit · @vollholz/iam' }, mig));
  const newerInDb = names ? applied.filter(n => n.startsWith('iam_') && !names.includes(n)) : [];
  if (newerInDb.length) out.push({ ...kit, check: 'Datenbank neuer als das installierte Paket', source: 'identity-kit · @vollholz/iam', status: 'warn', details: newerInDb.map(n => `${n} angewendet, aber nicht im installierten @vollholz/iam`) });
  if (!hasTable) return out;

  out.push(finding({ ...kit, check: 'Rollen ohne BYPASSRLS, Laufzeit ohne Objekte', source: 'identity-kit · Spezifikation 10.1' },
    [...await roleProblems(db, o.ident), ...(await bypassRoleProblems(db, { rolePrefix: `${o.ident}_` }))]));
  out.push(finding({ ...kit, check: 'Mandantentrennung: FORCE RLS und tenant_isolation', source: 'identity-kit · Spezifikation 10.2' }, await tenantTableProblems(db, { appRole: app })));
  const withoutTenant = { ...Object.fromEntries(Object.entries(KIT_WITHOUT_TENANT).map(([k, v]) => [k.replace('{s}', S), v])), ...o.exceptions?.withoutTenant };
  out.push(finding({ ...kit, check: 'Tabellen mit Rechten nur mit Mandantentrennung oder begründet', source: 'identity-kit · Ausnahmen: Kit + identity.app.json › exceptions.withoutTenant' },
    await grantedTableProblems(db, { roles: [app, `${o.ident}_sched`], withoutTenant })));
  out.push(finding({ ...kit, check: 'Tupel und Lesesicht', source: 'identity-kit · Spezifikation 7.6, 10.3' }, await readViewProblems(db, { schema: S, appRole: app })));
  out.push(finding({ ...kit, check: 'SECURITY DEFINER nur begründet, mit festem search_path', source: 'identity-kit · Ausnahmen: Kit + identity.app.json › exceptions.securityDefiner' },
    await securityDefinerProblems(db, { allowed: { ...KIT_SECURITY_DEFINER, ...o.exceptions?.securityDefiner } })));
  out.push(finding({ ...kit, check: 'Kein Zugriff für PUBLIC', source: 'identity-kit · Spezifikation 10' },
    [...await publicSchemaProblems(db, { schemas: ['app', S] }), ...await publicExecuteProblems(db, { schemas: ['app', S], strict: true })]));

  const orgs = await adminProblems(db, S);
  out.push(finding({ level: 'db', check: 'Jede Organisation hat einen org-admin', zone: 'fest', source: 'identity-kit · Spezifikation 9.1 (letzter Admin)' }, orgs));
  const unbound = (await db.query<{ alias: string }>(`SELECT alias FROM ${S}.tenant WHERE kc_org_id IS NULL ORDER BY 1`)).rows.map(r => r.alias);
  if (unbound.length) out.push({ level: 'db', check: 'Mandanten an Organisationen gebunden', zone: 'fest', source: 'identity-kit · Spezifikation 4', status: 'warn', details: unbound.map(a => `${a}: noch ohne kc_org_id (bindet sich bei der ersten Anmeldung)`) });
  return out;
}
