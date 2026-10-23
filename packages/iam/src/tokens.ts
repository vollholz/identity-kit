/**
 * Prüfung von Access Tokens aus Keycloak (JWT) inkl. sendergebundener Tokens: DPoP (RFC 9449) und mTLS-gebundene
 * Tokens (RFC 8705). Spezifikation Kap. 6.1; aus Assets `auth/tokens.ts`.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { calculateJwkThumbprint, createRemoteJWKSet, decodeProtectedHeader, importJWK, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { IamConfig } from './config.ts';
import { HttpError } from './errors.ts';
import { MemoryReplayStore, type ReplayStore } from './state.ts';

export interface VerifiedToken {
  token: string;
  claims: JWTPayload & Record<string, unknown>;
  /** Art der Bindung des Tokens an den Absender. */
  binding: 'none' | 'dpop' | 'mtls';
}

interface Discovery { issuer: string; jwks_uri: string; token_endpoint: string; introspection_endpoint?: string; end_session_endpoint?: string; authorization_endpoint: string }

/** OIDC-Discovery mit Zwischenspeicher. */
export class OidcProvider {
  private disc: Discovery | null = null;
  private fetchedAt = 0;
  private jwks: JWTVerifyGetKey | null = null;
  readonly issuer: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private pending: Promise<Discovery> | null = null;

  constructor(issuer: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000) { this.issuer = issuer.replace(/\/$/, ''); this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; }

  /** Gleichzeitige Abfragen teilen sich einen Abruf; schlägt die Erneuerung fehl, gilt die bisherige Discovery weiter. */
  async discovery(): Promise<Discovery> {
    if (this.disc && Date.now() - this.fetchedAt < 3_600_000) return this.disc;
    this.pending ??= this.fetchDiscovery().finally(() => { this.pending = null; });
    try { return await this.pending; } catch (e) { if (this.disc) return this.disc; throw e; }
  }

  private async fetchDiscovery(): Promise<Discovery> {
    // Netzwerkfehler, Zeitlimit und unlesbare Antworten → 503, nicht 401 (sonst gälten bei einem Ausfall alle als abgemeldet)
    const down = (why: string) => new HttpError(503, 'Anmeldedienst nicht erreichbar', `Discovery ${why}`);
    let res: Response, d: Discovery;
    try { res = await this.fetchImpl(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(this.timeoutMs) }); } catch (e) { throw down((e as Error).message); }
    if (!res.ok) throw down(String(res.status));
    try { d = await res.json() as Discovery; } catch { throw down('ohne JSON'); }
    if (typeof d?.issuer !== 'string') throw down('ohne issuer');
    if (d.issuer.replace(/\/$/, '') !== this.issuer) throw new HttpError(503, 'Anmeldedienst falsch konfiguriert', 'Issuer stimmt nicht mit OIDC_ISSUER_URL überein');
    this.disc = d; this.fetchedAt = Date.now();
    this.jwks = createRemoteJWKSet(new URL(d.jwks_uri), { cooldownDuration: 30_000, cacheMaxAge: 600_000, timeoutDuration: this.timeoutMs });
    return d;
  }

  async keys(): Promise<JWTVerifyGetKey> { await this.discovery(); return this.jwks!; }
}

export interface VerifyOptions {
  audience: string;
  method: string;
  /** Absolute URL der Anfrage (für `htu`), ohne Query und Fragment. */
  url: string;
  dpopHeader?: string;
  /** Client-Zertifikat aus dem Header des Proxys (MTLS_HEADER), Formate siehe parseClientCert. */
  clientCert?: string | null;
}

/**
 * Client-Zertifikat aus dem Header des Proxys: PEM (URL-kodiert wie nginx `$ssl_client_escaped_cert`, auch ohne
 * Zeilenumbrüche) oder DER als base64 (Caddy `{http.request.tls.client.certificate_der_base64}`, RFC 9440 `:…:`).
 * Bei einer Kette zählt das erste Zertifikat. Unlesbar → null (die Anfrage scheitert dann mit 401, nicht 500).
 */
export function parseClientCert(header: string): X509Certificate | null {
  try {
    let v = header.trim();
    if (v.includes('%')) v = decodeURIComponent(v);
    const pem = /-----BEGIN[ +]CERTIFICATE-----([\s\S]*?)-----END[ +]CERTIFICATE-----/.exec(v);
    const b64 = (pem ? pem[1]! : v.replace(/^:([^:]*):$/, '$1')).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return null;
    return new X509Certificate(Buffer.from(b64, 'base64'));
  } catch { return null; }
}

/** Typen von Access Tokens (Claim `typ`, Keycloak: `Bearer`, bei DPoP-Bindung `DPoP`); ID-, Refresh-, Logout-Tokens nie. */
const ACCESS_TYPES = ['bearer', 'dpop'];

const ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

export class TokenVerifier {
  readonly provider: OidcProvider;
  private readonly cfg: Pick<IamConfig, 'oidc' | 'm2m'>;
  /** Gegen wiederverwendete Proofs (jti). Im Cluster geteilt (SHARED_STATE=postgres). */
  private readonly replay: ReplayStore;

  constructor(provider: OidcProvider, cfg: Pick<IamConfig, 'oidc' | 'm2m'>, replay: ReplayStore = new MemoryReplayStore()) { this.provider = provider; this.cfg = cfg; this.replay = replay; }

  async verify(token: string, o: VerifyOptions): Promise<VerifiedToken> {
    let claims: VerifiedToken['claims'];
    try {
      const { payload } = await jwtVerify(token, await this.provider.keys(), {
        issuer: this.provider.issuer, audience: o.audience, algorithms: ALGS, clockTolerance: this.cfg.oidc.clockToleranceSec, requiredClaims: ['exp', 'iat', 'sub'],
      });
      claims = payload as VerifiedToken['claims'];
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(401, 'Token ungültig', (e as Error).message, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    }
    const invalid = (detail: string) => new HttpError(401, 'Token ungültig', detail, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    // Nur Access Tokens: ID-, Refresh-, Offline- und Logout-Tokens desselben Realms tragen einen anderen `typ`.
    // Ohne `typ` (Tokens anderer Aussteller, Tests) bleibt das Token zulässig.
    if (claims.typ !== undefined && (typeof claims.typ !== 'string' || !ACCESS_TYPES.includes(claims.typ.toLowerCase()))) {
      throw invalid(`Tokentyp «${String(claims.typ).slice(0, 40)}» ist kein Access Token.`);
    }
    if (claims.cnf === undefined) return { token, claims, binding: 'none' };
    const cnf = (claims.cnf && typeof claims.cnf === 'object' ? claims.cnf : {}) as { jkt?: unknown; 'x5t#S256'?: unknown };
    if (typeof cnf.jkt === 'string' && cnf.jkt) {
      if (!o.dpopHeader) throw new HttpError(401, 'DPoP-Nachweis fehlt', 'Das Token ist an einen Schlüssel gebunden (cnf.jkt).', { 'WWW-Authenticate': 'DPoP error="invalid_token"' });
      await this.verifyDpop(o.dpopHeader, token, cnf.jkt, o);
      return { token, claims, binding: 'dpop' };
    }
    const x5t = cnf['x5t#S256'];
    if (typeof x5t === 'string' && x5t) {
      if (!o.clientCert) throw new HttpError(401, 'Client-Zertifikat fehlt', 'Das Token ist an ein Zertifikat gebunden (cnf.x5t#S256).');
      const cert = parseClientCert(o.clientCert);
      if (!cert) throw new HttpError(401, 'Client-Zertifikat ungültig', 'Das Zertifikat vom Proxy ist weder PEM noch DER (base64).');
      if (createHash('sha256').update(cert.raw).digest('base64url') !== x5t) throw new HttpError(401, 'Client-Zertifikat passt nicht zum Token');
      return { token, claims, binding: 'mtls' };
    }
    // Unbekannte Bindung: nie als ungebundenes Token annehmen
    throw invalid('Unbekannte Bindung (cnf): erwartet jkt (DPoP) oder x5t#S256 (mTLS).');
  }

  /** DPoP-Proof prüfen (RFC 9449 Abschnitt 4.3). */
  private async verifyDpop(proof: string, accessToken: string, jkt: string, o: VerifyOptions) {
    const fail = (why: string): never => { throw new HttpError(401, 'DPoP-Nachweis ungültig', why, { 'WWW-Authenticate': 'DPoP error="invalid_dpop_proof"' }); };
    let header: ReturnType<typeof decodeProtectedHeader>;
    try { header = decodeProtectedHeader(proof); } catch { return fail('Proof ist kein JWS'); }
    if (header.typ !== 'dpop+jwt') fail('typ muss dpop+jwt sein');
    if (!header.alg || !ALGS.includes(header.alg)) fail('Algorithmus nicht erlaubt');
    if (!header.jwk || (header.jwk as { d?: string }).d) fail('jwk fehlt oder enthält privaten Schlüssel');
    let payload: JWTPayload & { htm?: string; htu?: string; ath?: string };
    try { payload = (await jwtVerify(proof, await importJWK(header.jwk!, header.alg), { typ: 'dpop+jwt', algorithms: ALGS })).payload; }
    catch (e) { return fail(`Signatur: ${(e as Error).message}`); }
    if (payload.htm !== o.method.toUpperCase()) fail('htm passt nicht zur Methode');
    // Keine gültige URL (signiert, aber unbrauchbar) → 401 statt 500
    if (typeof payload.htu !== 'string' || !URL.canParse(payload.htu) || normalizeHtu(payload.htu) !== normalizeHtu(o.url)) fail('htu passt nicht zur URL');
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.iat !== 'number' || Math.abs(now - payload.iat) > this.cfg.m2m.dpopMaxAgeSec) fail('Proof zu alt oder aus der Zukunft');
    if (!payload.jti) fail('jti fehlt');
    if (payload.ath !== createHash('sha256').update(accessToken).digest('base64url')) fail('ath passt nicht zum Access Token');
    if (await calculateJwkThumbprint(header.jwk!, 'sha256') !== jkt) fail('Schlüssel passt nicht zum Token (cnf.jkt)');
    if (!(await this.replay.claim(`dpop:${jkt}:${payload.jti}`, (this.cfg.m2m.dpopMaxAgeSec * 2 + 1) * 1000))) fail('Proof wurde bereits verwendet');
  }
}

export function normalizeHtu(u: string): string {
  const x = new URL(u);
  return `${x.protocol}//${x.host.toLowerCase()}${x.pathname}`;
}
