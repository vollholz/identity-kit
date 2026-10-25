/**
 * Token Exchange (RFC 8693): Das Token des MCP-Hosts (Zielgruppe `<produkt>-mcp`) wird bei
 * Keycloak gegen ein Token für die REST-API (Zielgruppe `<produkt>-api`) getauscht. Der MCP-Dienst meldet sich dabei als vertraulicher Client
 * an (Geheimnis per client_secret_basic oder private_key_jwt nach RFC 7523).
 *
 * Getauschte Tokens werden bis kurz vor Ablauf zwischengespeichert (Schlüssel: Hash des eingehenden Tokens).
 *
 * Jeder Tausch trägt einen DPoP-Proof (RFC 9449) mit dem Schlüssel des MCP-Dienstes; Keycloak bindet das neue
 * Token daran (`cnf.jkt`, `token_type` DPoP). Liefert der Anmeldedienst ein ungebundenes Token, gilt der Tausch
 * als fehlgeschlagen – ein abgegriffenes API-Token soll ohne den Schlüssel nie verwendbar sein.
 * Fordert der Anmeldedienst eine Nonce an (`use_dpop_nonce`), wird einmal mit Nonce wiederholt.
 *
 * Gebundene Tokens als Subject Token (DPoP/mTLS von Maschinen-Clients) tauscht Keycloak nicht
 * («Sender-constrained tokens are not supported as subject_token»); `McpAuth` weist sie vorher ab.
 */
import { createHash, createPrivateKey, randomUUID } from 'node:crypto';
import { importPKCS8, SignJWT, type CryptoKey } from 'jose';
import type { Model } from '../model.ts';
import { ConfigError, type IamConfig } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { OidcProvider } from '../tokens.ts';
import type { DpopSigner } from './dpop.ts';

const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

export interface ExchangedToken { token: string; expiresAt: number }

async function signingKey(pem: string): Promise<{ key: CryptoKey; alg: string }> {
  const k = createPrivateKey(pem);
  const t = k.asymmetricKeyType;
  const alg = t === 'rsa' ? 'RS256' : t === 'rsa-pss' ? 'PS256' : t === 'ed25519' ? 'EdDSA'
    : t === 'ec' ? ({ prime256v1: 'ES256', secp384r1: 'ES384', secp521r1: 'ES512' } as Record<string, string>)[k.asymmetricKeyDetails?.namedCurve ?? ''] : undefined;
  if (!alg) throw new ConfigError(`MCP_PRIVATE_KEY: Schlüsseltyp ${t} nicht unterstützt`);
  return { key: await importPKCS8(k.export({ format: 'pem', type: 'pkcs8' }).toString(), alg), alg };
}

export class TokenExchanger {
  private readonly cache = new Map<string, ExchangedToken>();
  private readonly inflight = new Map<string, Promise<ExchangedToken>>();
  private readonly cfg: IamConfig;
  private readonly provider: OidcProvider;
  private readonly model: Model;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private key: Promise<{ key: CryptoKey; alg: string }> | null = null;
  /** Schlüssel, an den die getauschten Tokens gebunden werden; dieselbe Instanz signiert die Proofs der API-Aufrufe. */
  readonly dpop: DpopSigner;
  /** Getauschte Tokens gelten bis so viele Millisekunden vor ihrem Ablauf. */
  static readonly MARGIN_MS = 30_000;
  /** Höchstens so viele getauschte Tokens im Zwischenspeicher. */
  static readonly MAX_CACHED = 10_000;

  /** @param o.model Katalog der App: nur seine Scopes (und `organization…`) gehen in den Tausch. */
  constructor(cfg: IamConfig, provider: OidcProvider, o: { dpop: DpopSigner; model: Model; fetch?: typeof fetch; now?: () => number }) {
    if (!cfg.mcp.clientSecret && !cfg.mcp.privateKey) throw new ConfigError('MCP_CLIENT_SECRET oder MCP_PRIVATE_KEY fehlt – ohne Client-Anmeldung ist kein Token Exchange möglich.');
    this.cfg = cfg; this.provider = provider; this.model = o.model; this.dpop = o.dpop; this.fetchImpl = o.fetch ?? fetch; this.now = o.now ?? Date.now;
    if (cfg.mcp.privateKey) this.key = signingKey(cfg.mcp.privateKey);
  }

  /** API-Token für das eingehende Token; `scopes` begrenzt das Ergebnis (Downscoping) auf die Scopes des MCP-Tokens. */
  async exchange(subjectToken: string, scopes: string[]): Promise<ExchangedToken> {
    // Ohne Scope des Katalogs gäbe es ein API-Token ohne Fachrechte (oder Keycloak nähme die Scopes des Clients): nie tauschen
    if (!scopes.some(s => this.model.scopes.has(s))) throw new HttpError(403, 'Scope fehlt', 'Das Token enthält keinen Scope des Katalogs; ohne ihn wird nicht getauscht.');
    const id = createHash('sha256').update(subjectToken).digest('base64url');
    const hit = this.cache.get(id);
    if (hit && hit.expiresAt - TokenExchanger.MARGIN_MS > this.now()) return hit;
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.request(subjectToken, scopes).then(t => {
      if (this.cache.size >= TokenExchanger.MAX_CACHED) {
        for (const [k, v] of this.cache) if (v.expiresAt <= this.now()) this.cache.delete(k);
        // immer noch voll: die ältesten Einträge zuerst (Map in Einfügereihenfolge)
        for (const k of this.cache.keys()) { if (this.cache.size < TokenExchanger.MAX_CACHED) break; this.cache.delete(k); }
      }
      this.cache.set(id, t);
      return t;
    }).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** Verwirft ein zwischengespeichertes Token (z. B. wenn die API es abweist). */
  forget(subjectToken: string) { this.cache.delete(createHash('sha256').update(subjectToken).digest('base64url')); }

  private async request(subjectToken: string, scopes: string[]): Promise<ExchangedToken> {
    const { token_endpoint: endpoint } = await this.provider.discovery();
    const m = this.cfg.mcp;
    const body = new URLSearchParams({ grant_type: GRANT, subject_token: subjectToken, subject_token_type: ACCESS_TOKEN, requested_token_type: ACCESS_TOKEN, audience: this.cfg.oidc.apiAudience });
    // nur Scopes, die der MCP-Client bei Keycloak anfordern darf (Organisation und Katalog); andere, z. B. der
    // Zielgruppen-Scope des MCP-Tokens, lehnt Keycloak mit invalid_scope ab
    // `organization:<alias>`: im Host gewählte Organisation bleibt im API-Token festgelegt; `organization:*`: alle
    const wanted = [...new Set(scopes)].filter(s => s === 'organization' || s === 'organization:*' || /^organization:[a-z0-9][a-z0-9_-]{0,62}$/i.test(s) || this.model.scopes.has(s));
    if (wanted.length) body.set('scope', wanted.join(' '));
    type Answer = { access_token?: string; token_type?: string; expires_in?: number; error?: string; error_description?: string };
    let res: Response, data: Answer;
    for (let attempt = 0; ; attempt++) {
      // je Versuch frisch: Client Assertion und Proof sind Einmalwerte (jti)
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', dpop: await this.dpop.proof('POST', endpoint) };
      if (this.key) {
        const { key, alg } = await this.key;
        const now = Math.floor(this.now() / 1000);
        body.set('client_id', m.clientId);
        body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
        body.set('client_assertion', await new SignJWT({}).setProtectedHeader({ alg, typ: 'JWT' }).setIssuer(m.clientId).setSubject(m.clientId)
          .setAudience(endpoint).setIssuedAt(now).setExpirationTime(now + 60).setJti(randomUUID()).sign(key));
      } else {
        headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(m.clientId)}:${encodeURIComponent(m.clientSecret!)}`).toString('base64')}`;
      }
      try { res = await this.fetchImpl(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) }); }
      catch (e) { throw new HttpError(503, 'Anmeldedienst nicht erreichbar', `Token Exchange: ${(e as Error).message}`); }
      data = await res.json().catch(() => ({})) as Answer;
      const fresh = this.dpop.remember(endpoint, res.headers);
      // RFC 9449 Abschnitt 8: Nonce verlangt → einmal mit der neuen Nonce wiederholen
      if (attempt === 0 && res.status === 400 && data.error === 'use_dpop_nonce' && fresh) continue;
      break;
    }
    if (!res.ok || !data.access_token) {
      const why = [data.error, data.error_description].filter(Boolean).join(': ') || `Status ${res.status}`;
      // invalid_grant u. ä.: das eingehende Token taugt nicht (abgelaufen, widerrufen, falsche Zielgruppe) → neu anmelden
      // invalid_client/unauthorized_client/invalid_dpop_proof/use_dpop_nonce: Sache des MCP-Dienstes → Betriebsfehler, nicht Sache der Person
      // (Keycloak meldet Fehler im Proof als invalid_request mit «DPoP …» in der Beschreibung)
      const ours = ['invalid_client', 'unauthorized_client', 'invalid_dpop_proof', 'use_dpop_nonce'].includes(data.error ?? '') || /^DPoP\b/.test(data.error_description ?? '');
      if (!ours && [400, 401, 403].includes(res.status)) throw new HttpError(401, 'Token nicht tauschbar', why, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      throw new HttpError(502, 'Token Exchange fehlgeschlagen', why);
    }
    if (data.token_type?.toLowerCase() !== 'dpop') throw new HttpError(502, 'Token Exchange fehlgeschlagen', `Der Anmeldedienst hat kein DPoP-gebundenes Token ausgestellt (token_type ${data.token_type ?? 'fehlt'}).`);
    return { token: data.access_token, expiresAt: this.now() + (data.expires_in ?? 60) * 1000 };
  }
}
