#!/usr/bin/env node
/**
 * Kommandozeile zu `resetKeycloak` und `resetDatabase` (src/reset.ts): eine App vollständig zurücksetzen, danach mit
 * `iam-org-bootstrap --file` frisch aufsetzen.
 *
 *   npx iam-reset --keycloak --database --confirm <realm> [--schema <schema>] [--keep-table <name> …] [--dry-run]
 *
 * - `--keycloak`: alle Organisationen (samt ihrer Identitätsanbieter) und alle Personen im Realm löschen;
 *   Service-Account-Benutzer, Realm, Clients, Scopes, übrige Anbieter und Einstellungen bleiben.
 * - `--database`: alle Tabellen im Schema der App leeren ausser `schema_migrations` und `--keep-table` (mehrfach).
 * - `--confirm` muss dem Realm (KEYCLOAK_TF_REALM) entsprechen; `--dry-run` zählt nur.
 * Erst die Datenbank, dann Keycloak (bricht Keycloak ab, ist ein erneuter Lauf möglich, ohne dass Mandanten an
 * gelöschte Organisationen gebunden bleiben). Nach dem Leeren der Datenbank eine Zeile `audit platform.reset` (JSON)
 * auf stdout: Das Audit-Protokoll der App gehört je Mandant und ist danach leer.
 * Anmeldung bei Keycloak: siehe src/bin/env.ts. Datenbank: DATABASE_ADMIN_URL (Besitzer-Rolle). Exit-Code 64 bei
 * falschem Aufruf, 1 bei einem Fehler unterwegs.
 */
import { parseArgs } from 'node:util';
import { resetDatabase, resetKeycloak } from '../reset.ts';
import { defaultSchema, keycloakFromEnv, realmFromEnv } from './env.ts';

const { values: a } = parseArgs({
  options: {
    keycloak: { type: 'boolean', default: false }, database: { type: 'boolean', default: false },
    confirm: { type: 'string' }, schema: { type: 'string' }, 'keep-table': { type: 'string', multiple: true, default: [] },
    'dry-run': { type: 'boolean', default: false },
  },
});
const env = process.env;
const fail = (m: string, code = 64): never => { console.error(m); process.exit(code); };

if (!a.keycloak && !a.database) fail('--keycloak und/oder --database angeben');
const realm = realmFromEnv(env, fail);
if (a.confirm === undefined) fail(`--confirm ${realm} fehlt`);
if (a.confirm !== realm) fail(`--confirm «${a.confirm}» entspricht nicht dem Realm ${realm}`);
if (a['keep-table'].length && !a.database) fail('--keep-table nur mit --database');
const dbUrl = a.database ? env.DATABASE_ADMIN_URL || fail('DATABASE_ADMIN_URL fehlt (Besitzer-Rolle der Datenbank der App)') : null;
const kc = a.keycloak ? keycloakFromEnv(env, fail) : null;
const dryRun = a['dry-run'], log = (m: string) => console.log(m);
const schema = a.schema ?? defaultSchema(realm);

try {
  if (dbUrl) {
    const r = await resetDatabase({ url: dbUrl, schema, keep: a['keep-table'], dryRun, log });
    if (!dryRun) {
      const rows = r.tables.reduce((n, t) => n + t.rows, 0);
      console.log(`audit ${JSON.stringify({ action: 'platform.reset', at: new Date().toISOString(), realm, schema, tables: r.tables.length, rows, kept: r.kept, by: env.GITHUB_ACTOR ?? env.USER ?? null, via: 'iam-reset' })}`);
    }
  }
  if (kc) await resetKeycloak(kc, { dryRun, log });
  console.log(dryRun ? '[Probelauf] nichts geändert.' : 'Fertig.');
} catch (e) {
  fail(`Abgebrochen: ${(e as Error).message}`, 1);
}
