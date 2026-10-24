/**
 * Zurücksetzen einer App (Kommandozeile `iam-reset`, src/bin/reset.ts): danach lässt sie sich mit `iam-org-bootstrap
 * --file` frisch aufsetzen.
 *
 * - Keycloak (`resetKeycloak`): alle Organisationen samt ihrer Identitätsanbieter (Plätze `entra-NNN`,
 *   `entra-app-<alias>`; sie legt die App an, nicht das Realm-Modul) und alle Personen. Service-Account-Benutzer der
 *   Clients, Realm, Clients, Scopes, übrige Anbieter und Einstellungen bleiben (sie gehören dem OpenTofu-Modul).
 * - Datenbank (`resetDatabase`): als Besitzer-Rolle (`DATABASE_ADMIN_URL`) alle Tabellen im Schema der App leeren
 *   (`TRUNCATE … RESTART IDENTITY CASCADE`), ausser der Migrationsbuchhaltung (`schema_migrations`) und den Tabellen aus
 *   `keep`. Struktur, Rollen, Policies und Funktionen bleiben. Bricht ab, wenn CASCADE eine ausgenommene Tabelle
 *   (oder eine ausserhalb des Schemas) mitleeren würde.
 *
 * Beide sind wiederholbar; mit `dryRun` wird nur gezählt.
 */
import pg from 'pg';
import { schemaName } from './db.ts';
import type { KeycloakAdmin, KcUser } from './keycloak.ts';

/** Tabellen der Migrationsbuchhaltung: bleiben immer. */
export const MIGRATION_TABLES = ['schema_migrations'];

export interface ResetOptions { dryRun?: boolean; log?: (message: string) => void }

export interface KeycloakResetResult { organizations: string[]; identityProviders: string[]; people: number }

/** Service-Account-Benutzer eines Clients (bleibt beim Zurücksetzen). */
export const isServiceAccountUser = (u: Pick<KcUser, 'username' | 'serviceAccountClientId'>) => !!u.serviceAccountClientId || u.username.startsWith('service-account-');

export async function resetKeycloak(kc: KeycloakAdmin, o: ResetOptions = {}): Promise<KeycloakResetResult> {
  const dry = !!o.dryRun;
  const log = (m: string) => o.log?.(`${dry ? '[Probelauf] ' : ''}${m}`);
  const orgs = await kc.listOrgs();
  const idps = new Map<string, string[]>();
  for (const org of orgs) idps.set(org.id, (await kc.orgIdps(org.id)).map(x => x.alias));
  const people = (await kc.listUsers()).filter(u => !isServiceAccountUser(u));
  const res: KeycloakResetResult = { organizations: orgs.map(x => x.alias).sort(), identityProviders: [...idps.values()].flat().sort(), people: people.length };
  log(`Keycloak: ${orgs.length} Organisationen${orgs.length ? ` (${res.organizations.join(', ')})` : ''}, ${res.identityProviders.length} Identitätsanbieter von Organisationen${res.identityProviders.length ? ` (${res.identityProviders.join(', ')})` : ''}, ${people.length} Personen ${dry ? 'würden gelöscht' : 'löschen'}`);
  if (dry) return res;
  for (const org of orgs) {
    for (const alias of idps.get(org.id)!) {
      await kc.unlinkOrgIdp(org.id, alias);
      await kc.deleteIdp(alias);
    }
    await kc.deleteOrg(org.id);
  }
  for (const u of people) await kc.deleteUser(u.id);
  log('Keycloak: zurückgesetzt');
  return res;
}

export interface DatabaseResetOptions extends ResetOptions {
  /** Adresse der Besitzer-Rolle (`DATABASE_ADMIN_URL`). */
  url: string;
  /** Schema der Tabellen der App. */
  schema: string;
  /** Weitere Tabellen, die bleiben (App-spezifisch). */
  keep?: string[];
}

export interface DatabaseResetResult { tables: { name: string; rows: number }[]; kept: string[] }

export async function resetDatabase(o: DatabaseResetOptions): Promise<DatabaseResetResult> {
  const S = schemaName(o.schema);
  const dry = !!o.dryRun;
  const log = (m: string) => o.log?.(`${dry ? '[Probelauf] ' : ''}${m}`);
  const c = new pg.Client({ connectionString: o.url, application_name: 'iam-reset' });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '10s'");
    const all = (await c.query<{ name: string; force: boolean; oid: number }>(
      `SELECT c.relname AS name, c.relforcerowsecurity AS force, c.oid::int AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`, [S])).rows;
    if (!all.length) throw new Error(`Schema ${S} hat keine Tabellen (Schema falsch?)`);
    const keep = new Set(o.keep ?? []);
    const unknown = [...keep].filter(k => !all.some(t => t.name === k));
    if (unknown.length) throw new Error(`--keep-table: ${unknown.join(', ')} nicht im Schema ${S}`);
    const kept = all.filter(t => keep.has(t.name) || MIGRATION_TABLES.includes(t.name)).map(t => t.name);
    const targets = all.filter(t => !kept.includes(t.name));
    // CASCADE leerte auch Tabellen, die auf eine Zieltabelle verweisen: nur zulässig, wenn auch sie Ziel sind
    const refs = (await c.query<{ ref: string; target: string }>(
      `SELECT DISTINCT conrelid::regclass::text AS ref, confrelid::regclass::text AS target FROM pg_constraint
        WHERE contype = 'f' AND confrelid = ANY($1::oid[]) AND NOT (conrelid = ANY($1::oid[])) ORDER BY 1, 2`, [targets.map(t => t.oid)])).rows;
    if (refs.length) throw new Error(`Ausgenommene Tabellen verweisen auf zu leerende (CASCADE leerte sie mit): ${refs.map(r => `${r.ref} → ${r.target}`).join(', ')}`);

    // Zählen: FORCE ROW LEVEL SECURITY gilt auch für die Besitzer-Rolle; nur in einem Savepoint aufgehoben
    await c.query('SAVEPOINT count_rows');
    const tables: DatabaseResetResult['tables'] = [];
    for (const t of targets) {
      if (t.force) await c.query(`ALTER TABLE ${S}.${ident(t.name)} NO FORCE ROW LEVEL SECURITY`);
      tables.push({ name: t.name, rows: Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${S}.${ident(t.name)}`)).rows[0]!.n) });
    }
    await c.query('ROLLBACK TO SAVEPOINT count_rows');
    const width = Math.max(...tables.map(t => t.name.length));
    log(`Datenbank: ${tables.length} Tabellen im Schema ${S} ${dry ? 'würden geleert' : 'leeren'}`);
    for (const t of tables) log(`  ${t.name.padEnd(width)}  ${t.rows}`);
    if (kept.length) log(`Datenbank: bleiben ${kept.join(', ')}`);
    if (dry) { await c.query('ROLLBACK'); return { tables, kept }; }
    if (targets.length) await c.query(`TRUNCATE ${targets.map(t => `${S}.${ident(t.name)}`).join(', ')} RESTART IDENTITY CASCADE`);
    await c.query('COMMIT');
    log('Datenbank: zurückgesetzt');
    return { tables, kept };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { await c.end(); }
}

/** Bezeichner aus dem Katalog in Anführungszeichen (Tabellen der App dürfen beliebig heissen). */
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
