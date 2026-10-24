#!/usr/bin/env node
/**
 * Kommandozeile zu `orgBootstrap` (Spezifikation Kap. 2 Schritt 7, A20): Organisation und erste Person im Realm der App,
 * in der Datenbank der App Mandant, Principal, Rolle org-admin (Tupel) und Freigabestufe 2 – idempotent.
 *
 *   npx iam-org-bootstrap --alias solutions --name "Solutions" --email anna@example.ch --first Anna --last Admin \
 *       [--schema <schema>] [--platform-admin] [--initial-password] [--dry-run]
 *   npx iam-org-bootstrap --file init.json [--schema <schema>] [--initial-password] [--dry-run]
 *
 * `--file`: mehrere Organisationen mit je mehreren Admins (Format `schema/init.schema.json`, `platformAdmin` je Person);
 * nicht zusammen mit `--alias`, `--email`, `--name`, `--domain`, `--first`, `--last`, `--platform-admin`.
 * Anmeldung bei Keycloak: siehe src/bin/env.ts.
 * Datenbank: DATABASE_ADMIN_URL (Besitzer-Rolle, wie die Migrationen); Schema `--schema`, Standard der Realm mit «_».
 * Weiter: PLATFORM_ADMIN_ROLE (Standard `platform-admin`), IDENTITY_SECRET_DIR (Standard `~/.identity`, für
 * `--initial-password`).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { initFileErrors, orgBootstrap, orgBootstrapErrors, orgBootstrapFile, type InitFile } from '../bootstrap.ts';
import { defaultSchema, keycloakFromEnv, realmFromEnv } from './env.ts';

const { values: a } = parseArgs({
  options: {
    alias: { type: 'string' }, name: { type: 'string' }, domain: { type: 'string' }, schema: { type: 'string' },
    email: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' }, file: { type: 'string' },
    'platform-admin': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false }, 'initial-password': { type: 'boolean', default: false },
  },
});
const env = process.env;
const fail = (m: string): never => { console.error(m); process.exit(64); };

let file: InitFile | null = null;
let alias = '', email = '';
if (a.file !== undefined) {
  const single = (['alias', 'email', 'name', 'domain', 'first', 'last'] as const).filter(k => a[k] !== undefined).map(k => `--${k}`);
  if (a['platform-admin']) single.push('--platform-admin');
  if (single.length) fail(`--file nicht zusammen mit ${single.join(', ')}`);
  let data: unknown;
  try { data = JSON.parse(readFileSync(a.file, 'utf8')); } catch (e) { fail(`--file ${a.file}: ${(e as Error).message}`); }
  const errors = initFileErrors(data);
  if (errors.length) fail(`--file ${a.file} ungültig:\n${errors.join('\n')}`);
  file = data as InitFile;
} else {
  alias = (a.alias ?? fail('--alias fehlt (oder --file)')).toLowerCase();
  email = (a.email ?? fail('--email fehlt')).toLowerCase();
  const errors = orgBootstrapErrors({ alias, email });
  if (errors.length) fail(errors.join('\n'));
}
if (!env.KEYCLOAK_TF_URL) fail('KEYCLOAK_TF_URL fehlt');
const realm = realmFromEnv(env, fail);
const dbUrl = env.DATABASE_ADMIN_URL || (a['dry-run'] ? null : fail('DATABASE_ADMIN_URL fehlt (Besitzer-Rolle der Datenbank der App)'));
const kc = keycloakFromEnv(env, fail);
const common = {
  database: dbUrl ? { url: dbUrl, schema: a.schema ?? defaultSchema(realm) } : null,
  initialPassword: a['initial-password'] ? { realm, secretDir: env.IDENTITY_SECRET_DIR || join(homedir(), '.identity') } : null,
  dryRun: a['dry-run'], log: (m: string) => console.log(m),
};
const platformAdminRole = env.PLATFORM_ADMIN_ROLE || 'platform-admin';
try {
  if (file) await orgBootstrapFile(kc, file, { ...common, platformAdminRole });
  else await orgBootstrap(kc, { ...common, alias, email, name: a.name, domain: a.domain, firstName: a.first, lastName: a.last, platformAdminRole: a['platform-admin'] ? platformAdminRole : null });
} catch (e) {
  fail(`Abgebrochen: ${(e as Error).message}`);
}
