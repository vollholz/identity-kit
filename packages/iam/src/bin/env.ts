/**
 * Gemeinsame Umgebung der Kommandozeilen (`iam-org-bootstrap`, `iam-reset`): Anmeldung bei Keycloak mit dem Service
 * Account der Einrichtung (realm-admin, `private_key_jwt`):
 *   KEYCLOAK_TF_URL (Basisadresse), KEYCLOAK_TF_REALM (Realm der App, nie master), KEYCLOAK_IAC_CLIENT_ID (Standard
 *   `<realm>-iac`), KEYCLOAK_IAC_PRIVATE_KEY bzw. KEYCLOAK_IAC_PRIVATE_KEY_B64 (PEM).
 */
import type { IamConfig } from '../config.ts';
import { dbSslFromEnv, type DbSsl } from '../db.ts';
import { KeycloakAdmin } from '../keycloak.ts';

export type Fail = (message: string) => never;

/** Realm der App aus KEYCLOAK_TF_REALM (nie master). */
export function realmFromEnv(env: NodeJS.ProcessEnv, fail: Fail): string {
  const realm = env.KEYCLOAK_TF_REALM || fail('KEYCLOAK_TF_REALM fehlt');
  if (realm === 'master') fail('Realm master ist nicht erlaubt');
  return realm;
}

/** TLS zur Datenbank aus DATABASE_SSL (wie die übrigen Verbindungen); ungültiger Wert → Abbruch. */
export function dbSslOrFail(env: NodeJS.ProcessEnv, fail: Fail): DbSsl {
  try { return dbSslFromEnv(env); } catch (e) { return fail((e as Error).message); }
}

/** Schema der Tabellen: `--schema`, Standard der Realm mit «_». */
export const defaultSchema = (realm: string) => realm.replace(/-/g, '_');

export function keycloakFromEnv(env: NodeJS.ProcessEnv, fail: Fail): KeycloakAdmin {
  const base = (env.KEYCLOAK_TF_URL || fail('KEYCLOAK_TF_URL fehlt')).replace(/\/$/, '');
  const realm = realmFromEnv(env, fail);
  const key = env.KEYCLOAK_IAC_PRIVATE_KEY || (env.KEYCLOAK_IAC_PRIVATE_KEY_B64 ? Buffer.from(env.KEYCLOAK_IAC_PRIVATE_KEY_B64, 'base64').toString('utf8') : fail('KEYCLOAK_IAC_PRIVATE_KEY(_B64) fehlt'));
  const issuer = `${base}/realms/${realm}`;
  // Nur die Felder, die KeycloakAdmin liest (Issuer für die Client Assertion, Adresse der Admin-API, Zeitlimit)
  const cfg = { oidc: { issuer }, mgmt: { adminUrl: `${base}/admin/realms/${encodeURIComponent(realm)}`, timeoutMs: 15_000 } } as unknown as Pick<IamConfig, 'oidc' | 'mgmt'>;
  return new KeycloakAdmin(cfg, async () => `${issuer}/protocol/openid-connect/token`, fetch, { clientId: env.KEYCLOAK_IAC_CLIENT_ID || `${realm}-iac`, privateKey: key, clientSecret: null });
}
