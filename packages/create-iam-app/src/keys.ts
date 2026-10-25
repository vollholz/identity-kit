/**
 * Schlüsselpaare der App (EC P-256, `kid` = JWK-Thumbprint nach RFC 7638): öffentlich als JWKS nach
 * `infra/keycloak/keys/<produkt>-<client>.json` (versioniert), privat als PEM in ein Verzeichnis nur für dich (0700,
 * Dateien 0600, nie überschrieben). `<produkt>-tofu` bleibt ganz ausserhalb des Repositorys: den öffentlichen Teil gibt
 * die App dem Betreiber der Keycloak-Instanz.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '@vollholz/iam-testkit';

export interface Jwks { keys: [{ kty: 'EC'; crv: 'P-256'; x: string; y: string; kid: string; alg: 'ES256'; use: 'sig' }] }

/** Neues Schlüsselpaar: PEM (PKCS#8) und JWKS mit Thumbprint als `kid`. */
export function keyPair(): { pem: string; jwks: Jwks } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y } = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  // RFC 7638: Pflichtfelder in lexikografischer Reihenfolge, ohne Leerzeichen
  const kid = createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x, y })).digest('base64url');
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), jwks: { keys: [{ kty: 'EC', crv: 'P-256', x, y, kid, alg: 'ES256', use: 'sig' }] } };
}

/** Clients mit eigenem Schlüssel: tofu (Bootstrap, nur lokal), iac, platform, admin, sync und mit MCP mcp. */
export const keyClients = (m: Manifest) => ['tofu', 'iac', 'platform', 'admin', 'sync', ...(m.realm?.mcp ? ['mcp'] : [])];

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} ist kein Verzeichnis`);
  if (st.mode & 0o077) throw new Error(`${dir} ist für andere zugänglich (chmod 700 ${dir})`);
}

function writeSecret(file: string, content: string) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, content); } finally { closeSync(fd); }
}

export interface KeyResult { client: string; publicFile: string; privateFile: string }

/**
 * Fehlende Schlüssel erzeugen; bestehende (öffentlich im Repository oder privat im Verzeichnis) bleiben unverändert.
 * @param secretDir Verzeichnis für die privaten Schlüssel, z. B. ~/.identity/<produkt>
 */
export function generateKeys(dir: string, m: Manifest, secretDir: string): { created: KeyResult[]; skipped: string[] } {
  privateDir(secretDir);
  const created: KeyResult[] = [], skipped: string[] = [];
  for (const c of keyClients(m)) {
    const name = `${m.product}-${c}`;
    // tofu: öffentlicher Teil nur für den Betreiber, nicht ins Repository der App
    const publicFile = c === 'tofu' ? join(secretDir, `${name}.json`) : join(dir, 'infra', 'keycloak', 'keys', `${name}.json`);
    const privateFile = join(secretDir, `${name}.pem`);
    if (existsSync(publicFile) || existsSync(privateFile)) { skipped.push(name); continue; }
    const k = keyPair();
    writeSecret(privateFile, k.pem);
    mkdirSync(join(publicFile, '..'), { recursive: true });
    writeFileSync(publicFile, `${JSON.stringify(k.jwks, null, 2)}\n`);
    created.push({ client: name, publicFile, privateFile });
  }
  return { created, skipped };
}
