/**
 * Hilfen für den Keycloak-Nachweis (keycloak.sh) gegen eine lokale Wegwerf-Instanz. Übernimmt, was in Produktion
 * der Betreiber der Instanz als Server-Admin erledigt (Spezifikation Kap. 2, Schritte 1, 2, 5), und erzeugt Testschlüssel.
 * Anmeldung als Admin des Realms master mit Passwort – nur hier, nur gegen die lokale Instanz.
 *
 *   node kc.ts keys <verzeichnis> <client> …           Schlüsselpaare: <client>.json (JWKS, öffentlich), <client>.pem
 *   node kc.ts wait                                     wartet, bis Keycloak antwortet (höchstens 180 s)
 *   node kc.ts product-tofu <produkt> <jwks-datei>      Service Account <produkt>-tofu im Realm master, nur create-realm
 *   node kc.ts grant-realm-admin <realm> <client>       realm-management/realm-admin für den Service Account
 *
 * Umgebung: KC_URL (z. B. http://127.0.0.1:18080), KC_ADMIN_USER, KC_ADMIN_PASSWORD.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const env = process.env;
const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`${k} fehlt`); return v; };
const [cmd, ...args] = process.argv.slice(2);

async function adminToken(): Promise<string> {
  const r = await fetch(`${need('KC_URL')}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: need('KC_ADMIN_USER'), password: need('KC_ADMIN_PASSWORD') }),
  });
  if (!r.ok) throw new Error(`Admin-Anmeldung: HTTP ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${need('KC_URL')}/admin/realms${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function serviceAccount(token: string, realm: string, clientId: string): Promise<{ id: string }> {
  const [client] = await api<{ id: string }[]>(token, 'GET', `/${realm}/clients?clientId=${encodeURIComponent(clientId)}`);
  if (!client) throw new Error(`Client ${clientId} im Realm ${realm} fehlt`);
  return api(token, 'GET', `/${realm}/clients/${client.id}/service-account-user`);
}

switch (cmd) {
  case 'keys': {
    // EC P-256, kid = JWK-Thumbprint (RFC 7638)
    const [dir, ...clients] = args;
    mkdirSync(dir!, { recursive: true });
    for (const c of clients) {
      const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
      const kid = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
      writeFileSync(`${dir}/${c}.json`, JSON.stringify({ keys: [{ kty: jwk.kty, x: jwk.x, y: jwk.y, crv: jwk.crv, kid, alg: 'ES256', use: 'sig' }] }, null, 2) + '\n');
      writeFileSync(`${dir}/${c}.pem`, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    }
    break;
  }
  case 'wait': {
    for (let i = 0; i < 90; i++) {
      try { if ((await fetch(`${need('KC_URL')}/realms/master/.well-known/openid-configuration`)).ok) process.exit(0); } catch { /* startet noch */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Keycloak antwortet nicht');
  }
  case 'product-tofu': {
    // Wie beim Betreiber: Client <produkt>-tofu im Realm master, nur create-realm
    const [product, jwksFile] = args;
    const token = await adminToken();
    await api(token, 'POST', '/master/clients', {
      clientId: `${product}-tofu`, protocol: 'openid-connect', publicClient: false, clientAuthenticatorType: 'client-jwt',
      standardFlowEnabled: false, implicitFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: true,
      attributes: {
        'use.jwks.url': 'false', 'use.jwks.string': 'true', 'jwks.string': JSON.stringify(JSON.parse(readFileSync(jwksFile!, 'utf8'))),
        'token.endpoint.auth.signing.alg': 'ES256', 'access.token.lifespan': '300',
      },
    });
    const sa = await serviceAccount(token, 'master', `${product}-tofu`);
    const role = await api<{ id: string; name: string }>(token, 'GET', '/master/roles/create-realm');
    await api(token, 'POST', `/master/users/${sa.id}/role-mappings/realm`, [role]);
    console.log(`${product}-tofu: create-realm`);
    break;
  }
  case 'grant-realm-admin': {
    // Wie beim Betreiber: realm-admin für <produkt>-iac
    const [realm, clientId] = args;
    const token = await adminToken();
    const sa = await serviceAccount(token, realm!, clientId!);
    const [rm] = await api<{ id: string }[]>(token, 'GET', `/${realm}/clients?clientId=realm-management`);
    const role = await api<{ id: string; name: string }>(token, 'GET', `/${realm}/clients/${rm!.id}/roles/realm-admin`);
    await api(token, 'POST', `/${realm}/users/${sa.id}/role-mappings/clients/${rm!.id}`, [role]);
    console.log(`${clientId}: realm-admin im Realm ${realm}`);
    break;
  }
  default:
    throw new Error(`unbekannter Befehl: ${cmd ?? ''}`);
}
