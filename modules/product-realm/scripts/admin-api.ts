/**
 * Anmeldung an der Admin-API des Realms als IaC-Client (<produkt>-iac, realm-admin) mit private_key_jwt (ES256, RFC 7523),
 * ohne Bibliothek. Gemeinsam für lookup.ts, org-mapper.ts und smtp-test.ts. Der private Schlüssel kommt nur aus der
 * Umgebung (KEYCLOAK_IAC_PRIVATE_KEY, PEM; kc.sh setzt ihn), nie aus der Konfiguration von OpenTofu.
 */
import { createPrivateKey, randomUUID, sign } from 'node:crypto';

export const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} fehlt`); return v; };

export interface AdminApi {
  realm: string;
  clientId: string;
  /** Antwort als JSON; wirft bei HTTP-Fehlern */
  kc<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Antwort mit Status, ohne zu werfen */
  raw<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }>;
}

/** url: Adresse der Instanz mit Basispfad (z. B. https://identity.project-suite.ch) */
export async function adminApi(url: string, realm: string, clientId: string): Promise<AdminApi> {
  const base = url.replace(/\/$/, '');
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
  if (!tokenRes.ok) throw new Error(`Anmeldung an Keycloak als ${clientId} fehlgeschlagen: HTTP ${tokenRes.status}`);
  const token = ((await tokenRes.json()) as { access_token: string }).access_token;

  async function raw<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const r = await fetch(`${base}/admin/realms/${encodeURIComponent(realm)}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, data: (text ? JSON.parse(text) : undefined) as T };
  }
  async function kc<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await raw<T>(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
  return { realm, clientId, kc, raw };
}
