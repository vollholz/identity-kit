/**
 * Anmeldung im MCP-Dienst der App (Spezifikation 12.2, Entwurf 13.5; aus Assets `mcp/server.ts`), ohne MCP-SDK: Der
 * Dienst baut Server und Werkzeuge selbst und ruft je Anfrage `authorize` auf.
 *
 * Ablauf je Anfrage
 *   1. Ursprung prüfen (DNS-Rebinding), Bearer-Token prüfen (Issuer, Signatur, Zielgruppe OIDC_MCP_AUDIENCE; DPoP, falls
 *      gebunden). Ohne gültiges Token: 401 mit `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728).
 *   2. Mindestens ein Scope des Katalogs (sonst 403 insufficient_scope), nur POST (zustandslos), keine gebundenen
 *      Tokens, nur Tokens der MCP-Hosts (`azp` in MCP_HOST_CLIENT_IDS), sonst 403.
 *   3. Token Exchange (RFC 8693) gegen ein API-Token, DPoP-gebunden an den Schlüssel des Dienstes; eine bei der Anmeldung
 *      gewählte Organisation bleibt festgelegt (`exchangeScopes`).
 *   4. Effektive Rechte über `GET /v1/me` je Organisation (60 s zwischengespeichert, Schlüssel Token + Mandant).
 *      Organisation über `X-Tenant` oder `?org=`; mehrere im Token ohne Wahl: alle laden, gewählt wird je
 *      Werkzeugaufruf. Antwortet die API mit der Liste zur Wahl, wird daraus der Fehler -32602 mit dieser Liste.
 *
 * Fehler als JSON-RPC-Antwort ohne `id` (`errorResponse`), damit der Host die Meldung anzeigt.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Model } from '../model.ts';
import type { IamConfig } from '../config.ts';
import { HttpError } from '../errors.ts';
import { ALIAS_PATTERN, orgAlias, orgsFromClaims } from '../principal.ts';
import type { TokenVerifier, VerifiedToken } from '../tokens.ts';
import { ApiClient, ApiError } from './api.ts';
import type { TokenExchanger } from './exchange.ts';

/** Antwort von `GET /v1/me` (Auszug, den der MCP-Dienst braucht). */
export interface McpMe { tenant: { id: string; alias: string }; permissions: string[]; [k: string]: unknown }
/** Eine Organisation, in der die Anfrage handeln darf: API-Client mit getauschtem Token und effektive Rechte. */
export interface McpOrg { api: ApiClient; me: McpMe }
export interface McpAuthorized { token: VerifiedToken; scopes: string[]; orgs: McpOrg[] }
/** Anfrage, wie Fastify oder ein anderer Server sie liefert: `url` mit Pfad und Query. */
export interface McpRequest { method: string; url: string; headers: Record<string, string | string[] | undefined>; id?: string }

export interface McpAuthOptions {
  cfg: IamConfig;
  model: Model;
  verifier: TokenVerifier;
  exchanger: TokenExchanger;
  fetch?: typeof fetch;
  /** Weitere erlaubte Browser-Ursprünge (Header `Origin`); der Ursprung von MCP_PUBLIC_URL gilt immer. */
  allowedOrigins?: string[];
  /** Name in den Metadaten (RFC 9728), Standard «<produkt> (MCP)». */
  resourceName?: string;
}

/**
 * Scopes für den Token Exchange. Wer mehreren Organisationen angehört, wählt sie bei der Anmeldung; das Token des Hosts
 * trägt dann genau diese eine. Beim Tausch gibt es keine Auswahl: Mit dem allgemeinen Scope «organization» liesse
 * Keycloak den Claim im API-Token ganz weg (API: 403 «Keine Organisation»). Deshalb die gewählte Organisation
 * ausdrücklich anfordern (`organization:<alias>`); bei mehreren im Token bleibt es beim allgemeinen Scope (Wahl über
 * X-Tenant bzw. ?org=).
 */
export function exchangeScopes(scopes: string[], claims: VerifiedToken['claims'], claim = 'organization'): string[] {
  const orgs = orgsFromClaims(claims, claim);
  const alias = orgs.length === 1 ? orgAlias(orgs[0]!.alias) : null;
  if (!alias || !scopes.includes('organization')) return scopes;
  return scopes.map(s => s === 'organization' ? `organization:${alias}` : s);
}

/** Text für einen Header-Parameter: Umlaute ohne Zeichen, «…» als «...», Striche als «-», sonst nur druckbares ASCII ohne «"» und «\». */
export function headerText(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/…/g, '...').replace(/[\u2010-\u2015]/g, '-')
    .replace(/[«»„“”]/g, "'").replace(/[^\x20-\x7e]+/g, ' ').replace(/["\\]/g, '').trim();
}

export class McpAuth {
  /** Resource Identifier (MCP_PUBLIC_URL). */
  readonly resource: string;
  /** Adresse der Metadaten mit Pfad des Resource Identifiers (RFC 9728 Abschnitt 3.1). */
  readonly metadataUrl: string;
  /** Pfade der Metadaten: an der Wurzel und mit Pfad des Resource Identifiers. */
  readonly metadataPaths: string[];
  /**
   * Scopes, die ein MCP-Host anfordern soll (Anmeldung, alle Organisationen, Lesen; schreibende nach Bedarf).
   * `organization:*`: alle Organisationen der Person ins Token, gewählt wird je Werkzeugaufruf.
   */
  readonly defaultScopes: string[];
  private readonly o: McpAuthOptions;
  private readonly origins: Set<string>;
  private readonly meCache = new Map<string, { me: McpMe; at: number }>();
  /** Effektive Rechte gelten so lange (ms) aus dem Zwischenspeicher. */
  static readonly ME_TTL_MS = 60_000;

  constructor(o: McpAuthOptions) {
    this.o = o;
    this.resource = o.cfg.mcp.publicUrl;
    const u = new URL(this.resource), path = u.pathname.replace(/\/$/, '');
    this.metadataPaths = [...new Set(['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${path}`])];
    this.metadataUrl = `${u.origin}${this.metadataPaths.at(-1)}`;
    this.origins = new Set([u.origin, ...(o.allowedOrigins ?? [])]);
    this.defaultScopes = ['openid', 'organization:*', ...(o.model.scopes.has(`${o.model.product}:read`) ? [`${o.model.product}:read`] : [])];
  }

  /** OAuth Protected Resource Metadata (RFC 9728) mit den Scopes des Katalogs. */
  metadata() {
    const { cfg, model } = this.o;
    return {
      resource: this.resource,
      authorization_servers: [cfg.oidc.issuer],
      // nur organization:* – zusammen mit «organization» weist Keycloak die ganze Anfrage ab (invalid_scope)
      scopes_supported: ['openid', 'organization:*', ...model.scopes.keys()],
      bearer_methods_supported: ['header'],
      resource_name: this.o.resourceName ?? `${model.product} (MCP)`,
      resource_documentation: `${cfg.publicBaseUrl}/v1/docs`,
      dpop_signing_alg_values_supported: ['ES256', 'PS256', 'RS256'],
    };
  }

  /**
   * Inhalt von `WWW-Authenticate`; ohne `error` für Anfragen ohne Token (RFC 6750 Abschnitt 3.1). Die Beschreibung nur
   * als druckbares ASCII: Zeichen wie «…» oder ein Zeilenumbruch liessen das Setzen des Headers scheitern, der Host
   * fände dann die Metadaten nicht.
   */
  challenge(error?: string, description?: string): string {
    return `Bearer resource_metadata="${this.metadataUrl}", scope="${this.defaultScopes.join(' ')}"${error ? `, error="${error}"` : ''}${description ? `, error_description="${headerText(description)}"` : ''}`;
  }

  /** Fehler → JSON-RPC-Antwort ohne `id` (Status, Header, Body); 5xx ohne Interna. */
  errorResponse(err: unknown): { status: number; headers: Record<string, string>; body: { jsonrpc: '2.0'; id: null; error: { code: number; message: string; data?: Record<string, unknown> } } } {
    const e = err as Error & { statusCode?: number };
    const status = err instanceof HttpError ? err.status : e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
    const headers: Record<string, string> = err instanceof HttpError ? { ...err.headers } : {};
    // ohne eigene Challenge: invalid_token mit Begründung
    if (status === 401 && !headers['WWW-Authenticate']?.includes('resource_metadata')) headers['WWW-Authenticate'] = this.challenge('invalid_token', err instanceof HttpError ? err.detail ?? err.title : e.message);
    const code = status === 401 || status === 403 ? -32001 : status === 400 ? -32602 : status === 405 ? -32000 : -32603;
    const message = err instanceof HttpError ? [err.title, err.detail].filter(Boolean).join(': ') : status >= 500 ? 'Interner Fehler' : e.message;
    const data = err instanceof HttpError && Object.keys(err.extra).length ? err.extra : undefined;
    return { status, headers, body: { jsonrpc: '2.0', id: null, error: { code, message, ...(data ? { data } : {}) } } };
  }

  /** Schritte 1–4; liefert die Organisationen, in denen die Anfrage handeln darf (mindestens eine). */
  async authorize(req: McpRequest): Promise<McpAuthorized> {
    const { cfg, model, exchanger } = this.o;
    const header = (n: string) => { const v = req.headers[n]; return typeof v === 'string' ? v : undefined; };
    // Schutz gegen DNS-Rebinding (MCP-Spezifikation): fremde Browser-Ursprünge abweisen
    const origin = header('origin');
    if (origin && !this.origins.has(origin)) throw new HttpError(403, 'Ursprung nicht erlaubt', `Origin «${origin}» ist nicht zugelassen.`);
    const v = await this.authenticate(req);
    const scopes = String(v.claims.scope ?? '').split(' ').filter(Boolean);
    if (!model.permissionsForScopes(scopes).size) {
      throw new HttpError(403, 'Scope fehlt', `Das Token enthält keinen Scope für den Katalog. Mindestens «${this.defaultScopes.at(-1)}» anfordern.`, { 'WWW-Authenticate': this.challenge('insufficient_scope') });
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Nur POST', 'Dieser Dienst ist zustandslos: nur POST, kein SSE-Strom und keine Sitzungen.', { allow: 'POST' });
    // Keycloak tauscht keine sendergebundenen Tokens (DPoP/mTLS, d. h. Maschinen-Clients); klare Meldung statt
    // «Token nicht tauschbar» mit 401, das den Host nur zur erneuten Anmeldung schicken würde
    if (v.binding !== 'none') throw new HttpError(403, 'Gebundenes Token nicht unterstützt', 'Der MCP-Dienst kann sendergebundene Tokens (DPoP/mTLS) nicht gegen ein API-Token tauschen. Maschinen-Clients rufen die REST-API direkt auf.');
    // Nur Anmeldungen über die MCP-Hosts: Nach dem Tausch trägt das Token `azp = MCP_CLIENT_ID` und gilt in der API als
    // Person – ein beliebiger anderer Client mit der Zielgruppe des MCP-Dienstes darf das nicht
    const azp = typeof v.claims.azp === 'string' ? v.claims.azp : '';
    if (!cfg.mcp.hostClients.includes(azp)) {
      throw new HttpError(403, 'Client nicht zugelassen', `Der MCP-Dienst nimmt nur Anmeldungen über ${cfg.mcp.hostClients.map(c => `«${c}»`).join(', ')} an (MCP_HOST_CLIENT_IDS), nicht über «${azp || 'unbekannt'}». Trag im MCP-Host die Client-ID «${cfg.mcp.hostClients[0] ?? ''}» ein; Maschinen-Clients rufen die REST-API direkt auf.`);
    }
    // Organisation: Header X-Tenant, sonst ?org=<alias> an der MCP-Adresse (für Hosts, die keine eigenen Header setzen)
    const org = new URL(req.url, this.resource).searchParams.get('org');
    const tenant = header('x-tenant') ?? (org || null);
    if (tenant !== null && !ALIAS_PATTERN.test(tenant)) throw new HttpError(400, 'Organisation ungültig', 'X-Tenant bzw. ?org= ist kein Alias einer Organisation (Kleinbuchstaben, Ziffern, «-» und «_»).');
    const exchanged = await exchanger.exchange(v.token, exchangeScopes(scopes, v.claims, cfg.tenancy.claim));
    const load = async (alias: string | null): Promise<McpOrg> => {
      const api = new ApiClient({ baseUrl: cfg.mcp.apiUrl, publicBaseUrl: cfg.publicBaseUrl, token: exchanged.token, dpop: exchanger.dpop, tenant: alias, fetch: this.o.fetch, requestId: req.id });
      try { return { api, me: await this.effective(api, createHash('sha256').update(`${exchanged.token}|${alias ?? ''}`).digest('base64url')) }; }
      catch (e) { throw this.apiFailure(e, v.token); }
    };
    // Gewählte Organisation oder höchstens eine im Token: genau diese. Mehrere im Token (organization:*): alle laden;
    // ohne Zugriff (403, z. B. gesperrt) fallen weg, solange eine bleibt
    const inToken = [...new Set(orgsFromClaims(v.claims, cfg.tenancy.claim).map(o => orgAlias(o.alias)).filter((a): a is string => !!a))].sort();
    if (tenant || inToken.length < 2) return { token: v, scopes, orgs: [await load(tenant)] };
    const all = await Promise.allSettled(inToken.map(load));
    const orgs = all.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    const failed = all.flatMap(r => r.status === 'rejected' ? [r.reason as unknown] : []);
    const blocking = failed.find(e => !(e instanceof HttpError && e.status === 403));
    if (blocking || !orgs.length) throw blocking ?? failed[0];
    return { token: v, scopes, orgs };
  }

  private async authenticate(req: McpRequest): Promise<VerifiedToken> {
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const m = /^(Bearer|DPoP)\s+([\w.~+/-]+=*)$/i.exec(auth);
    if (!m) throw new HttpError(401, 'Nicht angemeldet', 'Access Token im Authorization-Header senden.', { 'WWW-Authenticate': this.challenge() });
    const v = await this.o.verifier.verify(m[2]!, {
      audience: this.o.cfg.oidc.mcpAudience, method: req.method, url: `${new URL(this.resource).origin}${req.url.split('?')[0]}`,
      dpopHeader: typeof req.headers.dpop === 'string' ? req.headers.dpop : undefined,
    });
    if (m[1]!.toLowerCase() === 'bearer' && v.binding === 'dpop') throw new HttpError(401, 'Falsches Schema', 'DPoP-gebundene Tokens mit «Authorization: DPoP …» senden.');
    return v;
  }

  private async effective(api: ApiClient, key: string): Promise<McpMe> {
    const hit = this.meCache.get(key);
    if (hit && Date.now() - hit.at < McpAuth.ME_TTL_MS) return hit.me;
    const me = await api.get<McpMe>('/v1/me');
    if (this.meCache.size > 10_000) this.meCache.clear();
    this.meCache.set(key, { me, at: Date.now() });
    return me;
  }

  /** Fehler der API beim Laden der Rechte → Antwort an den Host. */
  private apiFailure(e: unknown, subjectToken: string): unknown {
    if (e instanceof ApiError && e.status === 401) { this.o.exchanger.forget(subjectToken); return new HttpError(401, 'API-Token abgewiesen', e.message); }
    if (e instanceof ApiError && e.status === 400 && Array.isArray(e.problem.organizations)) {
      // Person in mehreren Organisationen: klar sagen, wie wählen (nur die eigenen Organisationen aus dem Token)
      const orgs = (e.problem.organizations as unknown[]).map(String);
      return new HttpError(400, 'Organisation wählen', `Du gehörst mehreren Organisationen an (${orgs.join(', ')}). Im MCP-Host den Header «X-Tenant: <alias>» setzen oder die Adresse mit «?org=<alias>» verwenden, z. B. ${this.resource}?org=${orgs[0]}.`, {}, { organizations: orgs });
    }
    if (e instanceof ApiError) return new HttpError(e.status, String(e.problem.title ?? 'Fehler der API'), e.problem.detail as string | undefined);
    return e;
  }
}

/**
 * Für einen MCP-Dienst mit Fastify: Metadaten (RFC 9728) an beiden Pfaden und Fehler als JSON-RPC-Antwort. Den
 * Endpunkt selbst (`POST /mcp` mit `authorize` und dem MCP-Server) registriert die App.
 */
export function registerMcpAuth(app: FastifyInstance, auth: McpAuth): void {
  app.setErrorHandler((err, req, reply) => {
    const r = auth.errorResponse(err);
    if (r.status >= 500) req.log.error({ err }, 'Fehler im MCP-Dienst');
    for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    return reply.status(r.status).type('application/json').send(r.body);
  });
  for (const p of auth.metadataPaths) app.get(p, async () => auth.metadata());
}
