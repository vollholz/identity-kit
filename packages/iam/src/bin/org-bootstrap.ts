#!/usr/bin/env node
/**
 * Kommandozeile zu `orgBootstrap` (Spezifikation Kap. 2 Schritt 7, A20): Organisation und erste Person im Realm der App,
 * in der Datenbank der App Mandant, Principal, Rolle org-admin (Tupel) und Freigabestufe 2 – idempotent.
 *
 *   npx iam-org-bootstrap --alias solutions --name "Solutions" --email anna@example.ch --first Anna --last Admin \
 *       [--schema <schema>] [--platform-admin] [--initial-password] [--dry-run]
 *
 * Anmeldung bei Keycloak mit dem Service Account der Einrichtung (realm-admin, `private_key_jwt`):
 *   KEYCLOAK_TF_URL (Basisadresse), KEYCLOAK_TF_REALM (Realm der App, nie master), KEYCLOAK_IAC_CLIENT_ID (Standard
 *   `<realm>-iac`), KEYCLOAK_IAC_PRIVATE_KEY bzw. KEYCLOAK_IAC_PRIVATE_KEY_B64 (PEM).
 * Datenbank: DATABASE_ADMIN_URL (Besitzer-Rolle, wie die Migrationen); Schema `--schema`, Standard der Realm mit «_».
 * Weiter: PLATFORM_ADMIN_ROLE (Standard `platform-admin`), IDENTITY_SECRET_DIR (Standard `~/.identity`, für
 * `--initial-password`).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { orgBootstrap, orgBootstrapErrors } from '../bootstrap.ts';
import type { IamConfig } from '../config.ts';
import { KeycloakAdmin } from '../keycloak.ts';

const { values: a } = parseArgs({
  options: {
    alias: { type: 'string' }, name: { type: 'string' }, domain: { type: 'string' }, schema: { type: 'string' },
    email: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' },
    'platform-admin': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false }, 'initial-password': { type: 'boolean', default: false },
  },
});
const env = process.env;
const fail = (m: string): never => { console.error(m); process.exit(64); };

const alias = (a.alias ?? fail('--alias fehlt')).toLowerCase();
const email = (a.email ?? fail('--email fehlt')).toLowerCase();
const errors = orgBootstrapErrors({ alias, email });
if (errors.length) fail(errors.join('\n'));
const base = (env.KEYCLOAK_TF_URL ?? fail('KEYCLOAK_TF_URL fehlt')).replace(/\/$/, '');
const realm = env.KEYCLOAK_TF_REALM ?? fail('KEYCLOAK_TF_REALM fehlt');
if (realm === 'master') fail('Realm master ist nicht erlaubt');
const dbUrl = env.DATABASE_ADMIN_URL ||  (a['dry-run'] ? null : fail('DATABASE_ADMIN_URL fehlt (Besitzer-Rolle der Datenbank der App)'));
const key = env.KEYCLOAK_IAC_PRIVATE_KEY ?? (env.KEYCLOAK_IAC_PRIVATE_KEY_B64 ? Buffer.from(env.KEYCLOAK_IAC_PRIVATE_KEY_B64, 'base64').toString('utf8') : fail('KEYCLOAK_IAC_PRIVATE_KEY(_B64) fehlt'));

const issuer = `${base}/realms/${realm}`;
// Nur die Felder, die KeycloakAdmin liest (Issuer für die Client Assertion, Adresse der Admin-API, Zeitlimit)
const cfg = { oidc: { issuer }, mgmt: { adminUrl: `${base}/admin/realms/${encodeURIComponent(realm)}`, timeoutMs: 15_000 } } as unknown as Pick<IamConfig, 'oidc' | 'mgmt'>;
const kc = new KeycloakAdmin(cfg,
  async () => `${issuer}/protocol/openid-connect/token`, fetch, { clientId: env.KEYCLOAK_IAC_CLIENT_ID ?? `${realm}-iac`, privateKey: key, clientSecret: null });
try {
  await orgBootstrap(kc, {
    alias, email, name: a.name, domain: a.domain, firstName: a.first, lastName: a.last,
    database: dbUrl ? { url: dbUrl, schema: a.schema ?? realm.replace(/-/g, '_') } : null, platformAdminRole: a['platform-admin'] ? env.PLATFORM_ADMIN_ROLE ?? 'platform-admin' : null,
    initialPassword: a['initial-password'] ? { realm, secretDir: env.IDENTITY_SECRET_DIR || join(homedir(), '.identity') } : null,
    dryRun: a['dry-run'], log: m => console.log(m),
  });
} catch (e) {
  fail(`Abgebrochen: ${(e as Error).message}`);
}
