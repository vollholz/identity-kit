#!/usr/bin/env node
/**
 * Kommandozeile zu `orgBootstrap` und `operatorBootstrap` (Spezifikation Kap. 2 Schritt 7, Kap. 6.3, A20): Organisation
 * und erste Person im Realm der App, in der Datenbank der App Mandant, Principal, Rolle org-admin (Tupel) und
 * Freigabestufe 2 – bzw. ein Konto des Betriebs mit der Realm-Rolle der Plattform-Administration, ohne Organisation.
 * Idempotent.
 *
 *   npx iam-org-bootstrap --operator --email betrieb@example.ch --first Bea --last Betrieb [--initial-password] [--dry-run]
 *   npx iam-org-bootstrap --alias solutions --name "Solutions" --email anna@example.ch --first Anna --last Admin \
 *       [--schema <schema>] [--initial-password] [--dry-run]
 *   npx iam-org-bootstrap --file init.json [--schema <schema>] [--initial-password] [--dry-run]
 *   alle: [--no-email | --resend] [--invite-days <tage>] [--client-id <client> [--redirect-uri <url>]]
 *
 * `--file`: Betrieb (`operators`) und mehrere Organisationen mit je mehreren Admins (Format `schema/init.schema.json`);
 * nicht zusammen mit `--operator`, `--alias`, `--email`, `--name`, `--domain`, `--first`, `--last`. Betrieb und
 * Organisation nie mit demselben Konto (Abbruch).
 * Einladung «Passwort festlegen» per E-Mail an neu angelegte Personen ohne Passwort und Identitätsanbieter (Standard,
 * gültig 7 Tage); `--resend` auch an bestehende ohne Passwort, `--no-email` keine. Scheitert der Versand (kein SMTP),
 * meldet der Lauf das am Schluss und endet trotzdem mit 0. Nicht zusammen mit `--initial-password` (Alternative).
 * Anmeldung bei Keycloak: siehe src/bin/env.ts.
 * Datenbank: DATABASE_ADMIN_URL (Besitzer-Rolle, wie die Migrationen); Schema `--schema`, Standard der Realm mit «_».
 * Weiter: PLATFORM_ADMIN_ROLE (Standard `platform-admin`), IDENTITY_SECRET_DIR (Standard `~/.identity`, für
 * `--initial-password`).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { initFileErrors, inviteErrors, operatorBootstrap, orgBootstrap, orgBootstrapErrors, orgBootstrapFile, type InitFile, type OrgBootstrapResult } from '../bootstrap.ts';
import { defaultSchema, keycloakFromEnv, realmFromEnv } from './env.ts';

const env = process.env;
const fail = (m: string): never => { console.error(m); process.exit(64); };
let parsed;
try {
  parsed = parseArgs({
    options: {
      alias: { type: 'string' }, name: { type: 'string' }, domain: { type: 'string' }, schema: { type: 'string' },
      email: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' }, file: { type: 'string' },
      operator: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false }, 'initial-password': { type: 'boolean', default: false },
      'no-email': { type: 'boolean', default: false }, resend: { type: 'boolean', default: false },
      'invite-days': { type: 'string' }, 'client-id': { type: 'string' }, 'redirect-uri': { type: 'string' },
    },
  });
} catch (e) { fail((e as Error).message); }
const a = parsed!.values;

if (a['no-email'] && a.resend) fail('--resend nicht zusammen mit --no-email');
if (a['initial-password'] && (a.resend || a['invite-days'] !== undefined || a['client-id'] !== undefined || a['redirect-uri'] !== undefined)) {
  fail('--initial-password ist die Alternative zur Einladung: nicht zusammen mit --resend, --invite-days, --client-id, --redirect-uri');
}
let lifespanSec: number | undefined;
if (a['invite-days'] !== undefined) {
  const d = Number(a['invite-days']);
  if (!/^\d+$/.test(a['invite-days']) || d < 1 || d > 30) fail('--invite-days: ganze Zahl von 1 bis 30');
  lifespanSec = d * 24 * 3600;
}
const invite = { lifespanSec, clientId: a['client-id'], redirectUri: a['redirect-uri'] };
if (inviteErrors(invite).length) fail(inviteErrors(invite).join('\n'));
let file: InitFile | null = null;
let alias = '', email = '';
if (a.file !== undefined) {
  const single = (['alias', 'email', 'name', 'domain', 'first', 'last'] as const).filter(k => a[k] !== undefined).map(k => `--${k}`);
  if (a.operator) single.push('--operator');
  if (single.length) fail(`--file nicht zusammen mit ${single.join(', ')}`);
  let data: unknown;
  try { data = JSON.parse(readFileSync(a.file, 'utf8')); } catch (e) { fail(`--file ${a.file}: ${(e as Error).message}`); }
  const errors = initFileErrors(data);
  if (errors.length) fail(`--file ${a.file} ungültig:\n${errors.join('\n')}`);
  file = data as InitFile;
} else if (a.operator) {
  const other = (['alias', 'name', 'domain', 'schema'] as const).filter(k => a[k] !== undefined).map(k => `--${k}`);
  if (other.length) fail(`--operator (Betrieb, ohne Organisation) nicht zusammen mit ${other.join(', ')}`);
  email = (a.email ?? fail('--email fehlt')).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('E-Mail-Adresse ungültig');
} else {
  alias = (a.alias ?? fail('--alias fehlt (oder --file, --operator)')).toLowerCase();
  email = (a.email ?? fail('--email fehlt')).toLowerCase();
  const errors = orgBootstrapErrors({ alias, email });
  if (errors.length) fail(errors.join('\n'));
}
if (!env.KEYCLOAK_TF_URL) fail('KEYCLOAK_TF_URL fehlt');
const realm = realmFromEnv(env, fail);
const dbUrl = env.DATABASE_ADMIN_URL || (a['dry-run'] || a.operator ? null : fail('DATABASE_ADMIN_URL fehlt (Besitzer-Rolle der Datenbank der App)'));
const kc = keycloakFromEnv(env, fail);
const common = {
  database: dbUrl ? { url: dbUrl, schema: a.schema ?? defaultSchema(realm) } : null,
  initialPassword: a['initial-password'] ? { realm, secretDir: env.IDENTITY_SECRET_DIR || join(homedir(), '.identity') } : null,
  sendEmail: !a['no-email'], resend: a.resend, invite,
  dryRun: a['dry-run'], log: (m: string) => console.log(m),
};
const platformAdminRole = env.PLATFORM_ADMIN_ROLE || 'platform-admin';
let results: OrgBootstrapResult[] = [];
try {
  if (file) results = await orgBootstrapFile(kc, file, { ...common, platformAdminRole });
  else if (a.operator) results = [await operatorBootstrap(kc, { ...common, email, firstName: a.first, lastName: a.last, platformAdminRole })];
  else results = [await orgBootstrap(kc, { ...common, alias, email, name: a.name, domain: a.domain, firstName: a.first, lastName: a.last, operatorRole: platformAdminRole })];
} catch (e) {
  fail(`Abgebrochen: ${(e as Error).message}`);
}
// Zusammenfassung der Einladungen (z. B. für die Zusammenfassung eines Workflows)
const to = (k: 'sent' | 'failed') => [...new Set(results.filter(r => r.invitation === k).map(r => r.email))];
if (to('sent').length) console.log(`Einladung gesendet an: ${to('sent').join(', ')}`);
if (to('failed').length) console.log(`Einladung NICHT gesendet an: ${to('failed').join(', ')} – SMTP im Realm prüfen, dann erneut mit --resend (oder --initial-password)`);
