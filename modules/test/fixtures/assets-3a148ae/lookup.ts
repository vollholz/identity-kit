/**
 * Interne ID eines Clients im Realm (für admin.tf, data "external"). Ersetzt data "keycloak_openid_client" für die
 * eingebauten Clients realm-management und admin-permissions: der Provider liest dabei das Client-Secret, was
 * Keycloak ab 26.8 verweigert (403). Hier wird kein Secret gelesen. Keine Abhängigkeiten ausser Node.
 *
 *   stdin  {"client_id": "realm-management"}
 *   stdout {"id": "<uuid>"}
 *
 * Anmeldung wie org-mapper.ts: assets-iac im Realm, private_key_jwt (ES256). Umgebung von kc.sh: KEYCLOAK_REALM,
 * KEYCLOAK_IAC_PRIVATE_KEY, TF_VAR_keycloak_url, TF_VAR_keycloak_base_path.
 */
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = process.env;
const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`${k} fehlt`); return v; };

const base = `${need('TF_VAR_keycloak_url').replace(/\/$/, '')}${(env.TF_VAR_keycloak_base_path ?? '').replace(/\/$/, '')}`;
const realm = need('KEYCLOAK_REALM');
const q = JSON.parse(readFileSync(0, 'utf8')) as { client_id: string };
const clientId = 'assets-iac';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const input = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({ iss: clientId, sub: clientId, aud: `${base}/realms/${realm}`, jti: randomUUID(), iat: now, exp: now + 60 })}`;
const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey(need('KEYCLOAK_IAC_PRIVATE_KEY')), dsaEncoding: 'ieee-p1363' }).toString('base64url');
const tokenRes = await fetch(`${base}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'client_credentials', client_id: clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: `${input}.${signature}`,
  }),
});
if (!tokenRes.ok) throw new Error(`Anmeldung an Keycloak fehlgeschlagen: HTTP ${tokenRes.status}`);
const token = ((await tokenRes.json()) as { access_token: string }).access_token;

const r = await fetch(`${base}/admin/realms/${encodeURIComponent(realm)}/clients?clientId=${encodeURIComponent(q.client_id)}`, { headers: { authorization: `Bearer ${token}` } });
if (!r.ok) throw new Error(`Client ${q.client_id}: HTTP ${r.status}`);
const list = (await r.json()) as { id: string }[];
if (list.length !== 1) throw new Error(`Client ${q.client_id} im Realm ${realm} nicht gefunden`);
process.stdout.write(JSON.stringify({ id: list[0]!.id }));
