/**
 * Nachgebildeter Anmeldedienst (OIDC-Discovery, JWKS, Token Exchange) zum Ausstellen beliebiger Tokens, dazu
 * DPoP-Proofs. Verhalten wie Keycloak 26, soweit der Baukasten es nutzt (Spezifikation Kap. 6, 12).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { calculateJwkThumbprint, EmbeddedJWK, exportJWK, generateKeyPair, jwtVerify, SignJWT, type CryptoKey, type JWK } from 'jose';

export interface MockIdp {
  issuer: string;
  close(): Promise<void>;
  token(claims: Record<string, unknown>, opts?: { aud?: string | string[]; expiresIn?: string; jkt?: string; kid?: string }): Promise<string>;
  /** Anzahl Token-Exchange-Anfragen (nur mit Option `exchange`). */
  exchanges: number;
}

export interface MockIdpOptions {
  /** Name des Realms im Issuer (Standard `test`). */
  realm?: string;
  /** Zielgruppe von `token()` ohne `aud` (z. B. `<produkt>-api`). */
  audience: string;
  /**
   * Token Exchange (RFC 8693) am Token-Endpunkt wie Keycloak: vertraulicher Client mit Basic-Anmeldung, Subject Token
   * muss gültig sein; das neue Token übernimmt die Claims, `azp` = Client, `aud` = Parameter `audience`,
   * `scope` = angeforderte Scopes ∩ Scopes des Subject Tokens.
   * Mit Header `DPoP` (gültiger Proof für POST auf den Token-Endpunkt) wird das Token gebunden (`cnf.jkt`, token_type DPoP).
   * Sendergebundene Subject Tokens (`cnf`) werden wie bei Keycloak 26 abgewiesen.
   * `nonce`: Proofs müssen diese Nonce tragen, sonst 400 use_dpop_nonce mit Header `DPoP-Nonce`.
   * `ignoreDpop`: stellt trotz Proof ungebundene Tokens aus (falsch eingerichteter Anmeldedienst).
   */
  exchange?: { clientId: string; clientSecret: string; expiresIn?: number; nonce?: string; ignoreDpop?: boolean };
}

export async function startMockIdp(o: MockIdpOptions): Promise<MockIdp> {
  const realm = o.realm ?? 'test';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  let issuer = '';
  const sign = (claims: Record<string, unknown>, aud: string | string[], expiresIn: string | number, kid = 'k1') => new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).setIssuer(issuer).setAudience(aud).setSubject(String(claims.sub ?? randomUUID()))
    .setIssuedAt().setExpirationTime(typeof expiresIn === 'number' ? Math.floor(Date.now() / 1000) + expiresIn : expiresIn).setJti(randomUUID()).sign(privateKey);
  const idp: MockIdp = { issuer: '', exchanges: 0, close: async () => undefined, token: async () => '' };

  async function exchange(body: string, auth: string | undefined, dpop: string | undefined): Promise<[number, unknown, Record<string, string>?]> {
    const ex = o.exchange!;
    const f = new URLSearchParams(body);
    if (auth !== `Basic ${Buffer.from(`${ex.clientId}:${ex.clientSecret}`).toString('base64')}`) return [401, { error: 'invalid_client', error_description: 'Invalid client credentials' }];
    if (f.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:token-exchange') return [400, { error: 'unsupported_grant_type' }];
    let jkt: string | null = null;
    if (dpop) {
      try {
        const { payload, protectedHeader } = await jwtVerify(dpop, EmbeddedJWK, { typ: 'dpop+jwt' });
        if (payload.htm !== 'POST' || payload.htu !== `${issuer}/protocol/openid-connect/token` || !payload.jti || payload.ath) throw new Error('DPoP HTTP method/URL mismatch');
        if (ex.nonce && payload.nonce !== ex.nonce) return [400, { error: 'use_dpop_nonce', error_description: 'Authorization server requires nonce in DPoP proof' }, { 'DPoP-Nonce': ex.nonce }];
        jkt = await calculateJwkThumbprint(protectedHeader.jwk!, 'sha256');
      } catch (e) { return [400, { error: 'invalid_dpop_proof', error_description: (e as Error).message }]; }
    }
    idp.exchanges++;
    let sub: Record<string, unknown>;
    try { sub = (await jwtVerify(f.get('subject_token') ?? '', publicKey, { issuer })).payload as Record<string, unknown>; }
    catch (e) { return [400, { error: 'invalid_request', error_description: `Invalid token: ${(e as Error).message}` }]; }
    if (sub.cnf) return [400, { error: 'invalid_request', error_description: 'Sender-constrained tokens are not supported as subject_token. Use a Bearer token instead.' }];
    const have = String(sub.scope ?? '').split(' ').filter(Boolean);
    const want = f.get('scope') ? f.get('scope')!.split(' ').filter(Boolean) : have;
    const { iss: _i, aud: _a, exp: _e, iat: _t, jti: _j, nbf: _n, ...claims } = sub;
    const bind = jkt && !ex.ignoreDpop;
    const token = await sign({ ...claims, azp: ex.clientId, scope: want.filter(x => have.includes(x)).join(' '), ...(bind ? { cnf: { jkt } } : {}) }, f.get('audience') ?? ex.clientId, ex.expiresIn ?? 300);
    return [200, { access_token: token, token_type: bind ? 'DPoP' : 'Bearer', expires_in: ex.expiresIn ?? 300, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' }];
  }

  const base = `/realms/${realm}`;
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === `${base}/protocol/openid-connect/token` && o.exchange) {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => void exchange(body, req.headers.authorization, typeof req.headers.dpop === 'string' ? req.headers.dpop : undefined).then(([status, out, headers]) => {
        for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
        res.statusCode = status; res.end(JSON.stringify(out));
      }));
      return;
    }
    if (req.url === `${base}/.well-known/openid-configuration`) {
      return res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/protocol/openid-connect/certs`, token_endpoint: `${issuer}/protocol/openid-connect/token`, authorization_endpoint: `${issuer}/protocol/openid-connect/auth` }));
    }
    if (req.url === `${base}/protocol/openid-connect/certs`) return res.end(JSON.stringify({ keys: [jwk] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}${base}`;
  idp.issuer = issuer;
  idp.close = () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); });
  idp.token = (claims, t = {}) => sign({ ...claims, ...(t.jkt ? { cnf: { jkt: t.jkt } } : {}) }, t.aud ?? o.audience, t.expiresIn ?? '5m', t.kid);
  return idp;
}

/** DPoP-Proof-Generator für einen Schlüssel (RFC 9449). */
export async function dpopKey() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');
  return {
    jkt,
    proof: (htm: string, htu: string, accessToken: string, over: Record<string, unknown> = {}, key: CryptoKey = privateKey) =>
      new SignJWT({ htm, htu, jti: randomUUID(), ath: createHash('sha256').update(accessToken).digest('base64url'), iat: Math.floor(Date.now() / 1000), ...over })
        .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk }).sign(key),
  };
}
