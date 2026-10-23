#!/usr/bin/env node
/**
 * Kommandozeile zu `orgBootstrap` (aus Assets `scripts/org-bootstrap.ts`): Organisation, Rollengruppen und erste Person
 * im Realm der App anlegen – idempotent.
 *
 *   npx iam-org-bootstrap --catalog infra/keycloak/platform.json --alias solutions --name "Solutions" \
 *       --email anna@example.ch --first Anna --last Admin [--roles org-admin] [--platform-admin] [--initial-password] [--dry-run]
 *
 * Anmeldung bei Keycloak mit dem Service Account der Einrichtung (realm-admin, `private_key_jwt`):
 *   KEYCLOAK_TF_URL (Basisadresse), KEYCLOAK_TF_REALM (Realm der App, nie master), KEYCLOAK_IAC_CLIENT_ID (Standard
 *   `<realm>-iac`), KEYCLOAK_IAC_PRIVATE_KEY bzw. KEYCLOAK_IAC_PRIVATE_KEY_B64 (PEM).
 * Weiter: GROUP_ROLE_PREFIX (Standard `/orgs`), PLATFORM_ADMIN_ROLE (Standard `platform-admin`), IDENTITY_SECRET_DIR
 * (Standard `~/.identity`, für `--initial-password`).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { orgBootstrap, orgBootstrapErrors } from '../bootstrap.ts';
import type { IamConfig } from '../config.ts';
import { KeycloakAdmin } from '../keycloak.ts';

const { values: a } = parseArgs({
  options: {
    catalog: { type: 'string' }, alias: { type: 'string' }, name: { type: 'string' }, domain: { type: 'string' },
    email: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' },
    roles: { type: 'string', default: 'org-admin' }, 'platform-admin': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false }, 'initial-password': { type: 'boolean', default: false },
  },
});
const env = process.env;
const fail = (m: string): never => { console.error(m); process.exit(64); };

const catalogRoles = Object.keys((JSON.parse(readFileSync(a.catalog ?? fail('--catalog fehlt (platform.json aus catalog.platformJson())'), 'utf8')) as { roles?: Record<string, string> }).roles ?? {});
const alias = (a.alias ?? fail('--alias fehlt')).toLowerCase();
const email = (a.email ?? fail('--email fehlt')).toLowerCase();
const roles = a.roles!.split(',').map(r => r.trim()).filter(Boolean);
const errors = orgBootstrapErrors({ alias, email, roles, catalogRoles });
if (errors.length) fail(errors.join('\n'));
const base = (env.KEYCLOAK_TF_URL ?? fail('KEYCLOAK_TF_URL fehlt')).replace(/\/$/, '');
const realm = env.KEYCLOAK_TF_REALM ?? fail('KEYCLOAK_TF_REALM fehlt');
if (realm === 'master') fail('Realm master ist nicht erlaubt');
const key = env.KEYCLOAK_IAC_PRIVATE_KEY ?? (env.KEYCLOAK_IAC_PRIVATE_KEY_B64 ? Buffer.from(env.KEYCLOAK_IAC_PRIVATE_KEY_B64, 'base64').toString('utf8') : fail('KEYCLOAK_IAC_PRIVATE_KEY(_B64) fehlt'));

const issuer = `${base}/realms/${realm}`;
// Nur die Felder, die KeycloakAdmin liest (Issuer für die Client Assertion, Adresse der Admin-API, Zeitlimit)
const cfg = { oidc: { issuer }, mgmt: { adminUrl: `${base}/admin/realms/${encodeURIComponent(realm)}`, timeoutMs: 15_000 } } as unknown as Pick<IamConfig, 'oidc' | 'mgmt'>;
const kc = new KeycloakAdmin(cfg,
  async () => `${issuer}/protocol/openid-connect/token`, fetch, { clientId: env.KEYCLOAK_IAC_CLIENT_ID ?? `${realm}-iac`, privateKey: key, clientSecret: null });
try {
  await orgBootstrap(kc, {
    alias, email, roles, catalogRoles, name: a.name, domain: a.domain, firstName: a.first, lastName: a.last,
    groupRolePrefix: env.GROUP_ROLE_PREFIX ?? '/orgs', platformAdminRole: a['platform-admin'] ? env.PLATFORM_ADMIN_ROLE ?? 'platform-admin' : null,
    initialPassword: a['initial-password'] ? { realm, secretDir: env.IDENTITY_SECRET_DIR || join(homedir(), '.identity') } : null,
    dryRun: a['dry-run'], log: m => console.log(m),
  });
} catch (e) {
  fail(`Abgebrochen: ${(e as Error).message}`);
}
