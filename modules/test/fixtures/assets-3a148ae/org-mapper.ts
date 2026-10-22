/**
 * Gleicht den von Keycloak angelegten Mapper «organization» (Scope «organization») an die Soll-Konfiguration an –
 * idempotent; aufgerufen von OpenTofu (scopes.tf, terraform_data.organization_mapper), wenn sich die Soll-Konfiguration
 * oder der Scope ändert. Keine Abhängigkeiten ausser Node.
 *
 * Anmeldung wie der Provider: Service Account assets-iac im Realm, private_key_jwt (ES256).
 * Umgebung: KEYCLOAK_TF_URL_ORIGIN, KEYCLOAK_TF_BASE_PATH, KEYCLOAK_REALM, KEYCLOAK_IAC_PRIVATE_KEY (PEM, von kc.sh),
 *           ORGANIZATION_MAPPER (JSON der Soll-Konfiguration)
 */
import { createPrivateKey, randomUUID, sign } from 'node:crypto';

const env = process.env;
const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`${k} fehlt`); return v; };

const base = `${need('KEYCLOAK_TF_URL_ORIGIN').replace(/\/$/, '')}${(env.KEYCLOAK_TF_BASE_PATH ?? '').replace(/\/$/, '')}`;
const realm = need('KEYCLOAK_REALM');
const want = JSON.parse(need('ORGANIZATION_MAPPER')) as Record<string, string>;
const clientId = 'assets-iac';
const tokenUrl = `${base}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;

// Client-Assertion (RFC 7523) mit ES256, ohne Bibliothek
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const input = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({ iss: clientId, sub: clientId, aud: `${base}/realms/${realm}`, jti: randomUUID(), iat: now, exp: now + 60 })}`;
const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey(need('KEYCLOAK_IAC_PRIVATE_KEY')), dsaEncoding: 'ieee-p1363' }).toString('base64url');

const tokenRes = await fetch(tokenUrl, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'client_credentials', client_id: clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: `${input}.${signature}`,
  }),
});
if (!tokenRes.ok) throw new Error(`Anmeldung an Keycloak fehlgeschlagen: HTTP ${tokenRes.status}`);
const token = ((await tokenRes.json()) as { access_token: string }).access_token;

async function kc<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}/admin/realms/${encodeURIComponent(realm)}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${await r.text()}`);
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

interface Mapper { id: string; name: string; protocol: string; protocolMapper: string; config: Record<string, string> }
const scope = (await kc<{ id: string; name: string }[]>('GET', '/client-scopes')).find(s => s.name === 'organization');
if (!scope) throw new Error('Scope «organization» fehlt im Realm');
const mappers = await kc<Mapper[]>('GET', `/client-scopes/${scope.id}/protocol-mappers/models`);
const m = mappers.find(x => x.protocolMapper === 'oidc-organization-membership-mapper');
if (!m) throw new Error('Mapper vom Typ oidc-organization-membership-mapper fehlt im Scope «organization»');

const diff = Object.entries(want).filter(([k, v]) => m.config[k] !== v).map(([k]) => k);
if (diff.length === 0) {
  console.log(`Mapper «${m.name}»: aktuell`);
} else {
  await kc('PUT', `/client-scopes/${scope.id}/protocol-mappers/models/${m.id}`, { ...m, config: { ...m.config, ...want } });
  const after = (await kc<Mapper[]>('GET', `/client-scopes/${scope.id}/protocol-mappers/models`)).find(x => x.id === m.id)!;
  const still = Object.entries(want).filter(([k, v]) => after.config[k] !== v).map(([k]) => k);
  if (still.length) throw new Error(`Mapper «${m.name}»: nach dem Abgleich weichen noch ab: ${still.join(', ')}`);
  console.log(`Mapper «${m.name}»: abgeglichen (${diff.join(', ')})`);
}
