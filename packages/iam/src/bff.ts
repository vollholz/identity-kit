/**
 * Backend for Frontend (Spezifikation Kap. 6.2; aus Assets `modules/auth/bff.ts`): Anmeldung der Oberfläche über
 * Keycloak (Code-Flow mit PKCE S256, state, nonce). Tokens verlassen den Server nie; der Browser erhält nur ein
 * signiertes, HttpOnly-Cookie mit einer zufälligen Sitzungs-ID (256 Bit). In `<schema>.session` liegt deren Hash, der
 * Inhalt (Tokens, Person, Organisationen) ist mit AES-256-GCM verschlüsselt. Als `SessionBridge` liefert die Klasse dem
 * Plugin pro Anfrage ein gültiges Access Token.
 *
 * Organisation je Tab: Die Anmeldung fordert `organization:*` an, das Token trägt alle Organisationen der Person. Die
 * Oberfläche sendet die Organisation ihres Tabs als `X-Tenant`; die Wahl der Sitzung (`org`) ist nur die Vorgabe für
 * Anfragen ohne `X-Tenant` (neuer Tab, API-Aufrufe mit dem Cookie). Geprüft wird allein im Resolver gegen das Token.
 */
import { createHash, createPrivateKey, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { importPKCS8, jwtVerify, type CryptoKey } from 'jose';
import * as client from 'openid-client';
import { checkProduct, ConfigError, type IamConfig } from './config.ts';
import { Sealer } from './crypto.ts';
import { schemaName, withTx, type Db, type Tx } from './db.ts';
import { HttpError } from './errors.ts';
import type { SessionBridge } from './http/plugin.ts';
import { orgAlias, orgsFromClaims } from './principal.ts';
import { MemoryReplayStore, type ReplayStore } from './state.ts';
import type { OidcProvider } from './tokens.ts';

/** So lange vor Ablauf wird das Access Token erneuert. */
const REFRESH_SKEW_MS = 30_000;
const LOGIN_TTL_MS = 10 * 60_000;

/** Callback ohne gültigen Anmeldezustand (unbekannt, abgelaufen, anderer Browser oder Tab). */
export class LoginExpired extends HttpError {
  constructor() { super(400, 'Anmeldung abgelaufen', 'Der Anmeldevorgang ist unbekannt oder abgelaufen. Bitte erneut anmelden.'); }
}
const BCL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

export interface SessionData {
  sub: string;
  idpSid: string | null;
  name: string;
  email: string | null;
  idToken: string;
  accessToken: string;
  /** Ablauf des Access Tokens (ms seit Epoche). */
  accessExp: number;
  refreshToken: string | null;
  /** Vorgabe für Anfragen ohne `X-Tenant` (Alias) oder null, solange bei mehreren noch nicht gewählt. */
  org: string | null;
  /** Organisationen der Person laut aktuellem Access Token (Aliasse); folgt jeder Erneuerung. */
  orgs: string[];
}

export interface Session { id: string; csrf: string; data: SessionData; createdAt: number; expiresAt: number; lastSeenAt: number }

interface LoginState { state: string; nonce: string; verifier: string; returnTo: string; org: string | null; exp: number; v: 1 }

interface Logger { warn(obj: object, msg?: string): void; error(obj: object, msg?: string): void }

export interface BffOptions {
  /** Uhr (ms), für Tests verstellbar. */
  now?: () => number;
  log?: Logger;
  cleanupIntervalMs?: number;
  /** Replay-Schutz für Logout-Tokens; im Cluster geteilt. */
  replay?: ReplayStore;
}

const UNSAFE_PATH = /[\\\x00-\x1f\x7f]/;

/**
 * Nur relative Ziele innerhalb der Anwendung, sonst `/` (verhindert offene Weiterleitungen). Geprüft wird auch das
 * normalisierte Ergebnis: Punktsegmente machen aus `/.//x`, `/a/..//x` oder `/%2e//x` sonst wieder `//x` (A1).
 */
export function safeReturnTo(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 2048) return '/';
  if (!v.startsWith('/') || v.startsWith('//') || UNSAFE_PATH.test(v)) return '/';
  try {
    const base = 'http://bff.invalid';
    const u = new URL(v, base);
    if (u.origin !== base) return '/';
    const out = `${u.pathname}${u.search}${u.hash}`;
    return out.startsWith('/') && !out.startsWith('//') && !UNSAFE_PATH.test(out) ? out : '/';
  } catch { return '/'; }
}

/**
 * Scopes für die Anmeldung: `organization` bzw. `organization:<alias>` wird zu `organization:*`, damit das Token alle
 * Organisationen der Person trägt (Keycloak 26; sonst nur die beim Anmelden gewählte, ohne Wahl keine). Ohne
 * Organisations-Scope in OIDC_SCOPES bleibt die Liste, wie sie ist.
 */
export function scopesFor(scopes: string): string {
  const list = scopes.split(/\s+/).filter(Boolean);
  const isOrg = (s: string) => s === 'organization' || s.startsWith('organization:');
  const at = list.findIndex(isOrg);
  if (at < 0) return list.join(' ');
  return list.flatMap((s, i) => (i === at ? ['organization:*'] : isOrg(s) ? [] : [s])).join(' ');
}

export function isOrgAlias(v: unknown): v is string { return orgAlias(v) !== null; }

/** Zeitkonstanter Vergleich (Länge wird über den Hash verborgen). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

const hashId = (sid: string) => createHash('sha256').update(sid).digest('hex');
const ts = (ms: number) => new Date(ms).toISOString();

async function privateKeyFromPem(pem: string): Promise<CryptoKey> {
  const k = createPrivateKey(pem);
  const t = k.asymmetricKeyType;
  const alg = t === 'rsa' ? 'RS256' : t === 'rsa-pss' ? 'PS256' : t === 'ed25519' ? 'EdDSA'
    : t === 'ec' ? ({ prime256v1: 'ES256', secp384r1: 'ES384', secp521r1: 'ES512' } as Record<string, string>)[k.asymmetricKeyDetails?.namedCurve ?? ''] : undefined;
  if (!alg) throw new ConfigError(`OIDC_BFF_PRIVATE_KEY: Schlüsseltyp ${t} nicht unterstützt`);
  return importPKCS8(k.export({ format: 'pem', type: 'pkcs8' }).toString(), alg);
}

function oidcError(e: unknown): string {
  const x = e as { error?: string; error_description?: string; code?: string; message?: string };
  return [x.error, x.error_description].filter(Boolean).join(': ') || x.message || String(e);
}

export class Bff implements SessionBridge {
  readonly cookieName: string;
  readonly loginCookieName: string;
  private readonly cfg: IamConfig;
  private readonly db: Db;
  private readonly schema: string;
  private readonly provider: OidcProvider;
  private readonly sealer: Sealer;
  private readonly prod: boolean;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly cleanupIntervalMs: number;
  private readonly inflight = new Map<string, Promise<SessionData | null>>();
  private readonly replay: ReplayStore;
  private config: Promise<client.Configuration> | null = null;
  private timer: NodeJS.Timeout | null = null;

  /** @param o.product technischer Name (Cookies `<product>_sid`, `<product>_login`; in Produktion mit `__Host-`) */
  constructor(cfg: IamConfig, db: Db, provider: OidcProvider, o: BffOptions & { schema: string; product: string }) {
    this.cfg = cfg; this.db = db; this.provider = provider; this.schema = schemaName(o.schema);
    this.now = o.now ?? Date.now;
    this.replay = o.replay ?? new MemoryReplayStore();
    this.log = o.log ?? { warn: (obj, msg) => console.warn(msg, obj), error: (obj, msg) => console.error(msg, obj) };
    this.cleanupIntervalMs = o.cleanupIntervalMs ?? 5 * 60_000;
    this.prod = cfg.mode === 'production';
    const prefix = this.prod ? '__Host-' : '';
    // Name des Produkts im Cookie-Namen: nur das Muster der Produkte (sonst ConfigError beim Start, nicht 500 beim Login)
    checkProduct(o.product);
    this.cookieName = `${prefix}${o.product}_sid`;
    this.loginCookieName = `${prefix}${o.product}_login`;
    if (!cfg.session.secrets.length) throw new ConfigError('SESSION_SECRET fehlt – ohne Schlüssel keine Anmeldung über die Oberfläche.');
    if (!cfg.oidc.bffClientSecret && !cfg.oidc.bffPrivateKey) throw new ConfigError('OIDC_BFF_CLIENT_SECRET oder OIDC_BFF_PRIVATE_KEY fehlt – ohne Clientauthentifizierung keine Anmeldung über die Oberfläche.');
    let keys = cfg.encryptionKeys;
    if (!keys.length) {
      if (this.prod) throw new ConfigError('ENCRYPTION_KEYS fehlt – Sitzungsinhalte müssen verschlüsselt werden.');
      keys = [{ id: 'ephemeral', key: randomBytes(32) }];
      this.log.warn({}, 'ENCRYPTION_KEYS fehlt: flüchtiger Schlüssel, Sitzungen gehen beim Neustart verloren');
    }
    this.sealer = new Sealer(keys);
  }

  get redirectUri() { return `${this.cfg.publicBaseUrl}/auth/callback`; }
  /** Öffentliche Seite «Du bist abgemeldet» der Oberfläche (in Keycloak als post.logout.redirect.uris eingetragen). */
  get postLogoutUri() { return `${this.cfg.publicBaseUrl}/abgemeldet`; }

  // ---------------------------------------------------------------- OIDC-Client (Discovery, Clientauthentifizierung)
  private oidc(): Promise<client.Configuration> {
    if (!this.config) {
      const o = this.cfg.oidc;
      const p = (async () => {
        const auth = o.bffPrivateKey ? client.PrivateKeyJwt(await privateKeyFromPem(o.bffPrivateKey)) : client.ClientSecretBasic(o.bffClientSecret!);
        const execute: ((c: client.Configuration) => void)[] = [client.enableNonRepudiationChecks];
        if (o.issuer.startsWith('http:') && !this.prod) execute.push(client.allowInsecureRequests);
        try {
          return await client.discovery(new URL(o.issuer), o.bffClientId, { [client.clockTolerance]: o.clockToleranceSec }, auth, { execute, timeout: 10 });
        } catch (e) { throw new HttpError(503, 'Anmeldedienst nicht erreichbar', oidcError(e)); }
      })();
      p.catch(() => { if (this.config === p) this.config = null; });
      this.config = p;
    }
    return this.config;
  }

  // ---------------------------------------------------------------- Cookies
  private cookieOpts(maxAgeSec: number) {
    return { path: '/', httpOnly: true, secure: this.prod, sameSite: 'lax' as const, maxAge: maxAgeSec };
  }
  private setSessionCookie(reply: FastifyReply, sid: string) {
    reply.setCookie(this.cookieName, sid, { ...this.cookieOpts(Math.floor(this.cfg.session.ttlMs / 1000)), signed: true });
  }
  clearSessionCookie(reply: FastifyReply) { reply.clearCookie(this.cookieName, this.cookieOpts(0)); }

  // ---------------------------------------------------------------- Anmeldung
  /**
   * Startet den Code-Flow. Der Anmeldezustand liegt verschlüsselt in einem kurzlebigen Cookie. `org` wählt nur vor:
   * Steht die Organisation im Token, wird sie die Vorgabe der Sitzung; angefordert werden immer alle (`organization:*`).
   * @param idp Anbieter für `kc_idp_hint` (nur `entra-NNN`); mit `prompt=login`, sonst gälte die bestehende Keycloak-Sitzung weiter.
   */
  async beginLogin(reply: FastifyReply, returnTo: unknown, org: string | null, idp: string | null = null): Promise<string> {
    const c = await this.oidc();
    const verifier = client.randomPKCECodeVerifier();
    const st: LoginState = { v: 1, state: client.randomState(), nonce: client.randomNonce(), verifier, returnTo: safeReturnTo(returnTo), org: orgAlias(org), exp: this.now() + LOGIN_TTL_MS };
    const url = client.buildAuthorizationUrl(c, {
      response_type: 'code', redirect_uri: this.redirectUri, scope: scopesFor(this.cfg.oidc.scopes),
      state: st.state, nonce: st.nonce, code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      ...(idp && /^entra-(\d{3}|app-[a-z0-9][a-z0-9_-]{0,62})$/.test(idp) ? { kc_idp_hint: idp, prompt: 'login' } : {}),
    });
    reply.setCookie(this.loginCookieName, this.sealer.sealString(JSON.stringify(st), 'login'), this.cookieOpts(LOGIN_TTL_MS / 1000));
    return url.href;
  }

  /** Callback: Code tauschen, ID-Token prüfen (Signatur, iss, aud, nonce), neue Sitzung anlegen. Liefert das Rücksprungziel. */
  async completeLogin(req: FastifyRequest, reply: FastifyReply): Promise<string> {
    const raw = req.cookies[this.loginCookieName];
    reply.clearCookie(this.loginCookieName, this.cookieOpts(0));
    let st: LoginState | null = null;
    try { st = raw ? JSON.parse(this.sealer.openString(raw, 'login')) as LoginState : null; } catch { st = null; }
    if (!st || st.v !== 1 || st.exp < this.now()) throw new LoginExpired();
    const c = await this.oidc();
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(c, new URL(`${this.cfg.publicBaseUrl}${req.url}`), {
        pkceCodeVerifier: st.verifier, expectedState: st.state, expectedNonce: st.nonce, idTokenExpected: true,
      });
    } catch (e) {
      this.log.warn({ reason: oidcError(e) }, 'Anmeldung fehlgeschlagen');
      throw new HttpError(400, 'Anmeldung fehlgeschlagen', oidcError(e));
    }
    const claims = tokens.claims()!;
    if (!tokens.id_token) throw new HttpError(400, 'Anmeldung fehlgeschlagen', 'Kein ID-Token erhalten.');

    // Session-Fixation: eine bestehende Sitzung wird nie weiterverwendet, sondern beendet und ersetzt.
    const previous = await this.load(req, reply, { touch: false });
    if (previous) await this.destroy(previous.id);

    // Organisationen wie im Resolver aus dem Access Token (mit organization:* alle der Person)
    const orgs = this.orgsOf(tokens.access_token);
    const org = st.org && orgs.includes(st.org) ? st.org : orgs.length === 1 ? orgs[0]! : null;
    const data: SessionData = {
      sub: claims.sub, idpSid: typeof claims.sid === 'string' ? claims.sid : null,
      name: String(claims.name ?? claims.preferred_username ?? claims.sub), email: typeof claims.email === 'string' ? claims.email : null,
      idToken: tokens.id_token, accessToken: tokens.access_token, accessExp: this.now() + (tokens.expires_in ?? 300) * 1000,
      refreshToken: tokens.refresh_token ?? null, org, orgs,
    };
    await this.create(reply, data);
    reply.clearCookie(this.retryCookieName, this.cookieOpts(0));
    return st.returnTo;
  }

  /**
   * Abgelaufener oder unbekannter Anmeldezustand im Callback (z. B. «Passwort vergessen» in einem anderen Tab): eine
   * automatische neue Anmeldung ist erlaubt, wenn in den letzten 10 Minuten keine stattfand (Cookie, Schutz gegen
   * Schleifen). true: erlaubt und vermerkt.
   */
  retryLogin(req: FastifyRequest, reply: FastifyReply): boolean {
    if (req.cookies[this.retryCookieName]) return false;
    reply.setCookie(this.retryCookieName, '1', this.cookieOpts(LOGIN_TTL_MS / 1000));
    return true;
  }
  /** Vermerk der automatischen neuen Anmeldung entfernen (Fehlerseite: «Erneut anmelden» startet frisch). */
  clearRetry(reply: FastifyReply) { reply.clearCookie(this.retryCookieName, this.cookieOpts(0)); }
  private get retryCookieName() { return `${this.loginCookieName}_retry`;
  }

  private async create(reply: FastifyReply, data: SessionData): Promise<void> {
    const sid = randomBytes(32).toString('base64url');
    const id = hashId(sid), now = this.now();
    await this.db.query(
      `INSERT INTO ${this.schema}.session (id, data, csrf, created_at, last_seen_at, expires_at, subject, idp_sid) VALUES ($1, $2, $3, $4, $4, $5, $6, $7)`,
      [id, this.sealer.seal(JSON.stringify(data), id), randomBytes(32).toString('base64url'), ts(now), ts(now + this.cfg.session.ttlMs), data.sub, data.idpSid]);
    this.setSessionCookie(reply, sid);
  }

  // ---------------------------------------------------------------- Sitzung laden (TTL, Idle-Timeout)
  /** Sitzung aus dem Cookie laden; abgelaufene oder ungültige Sitzungen werden entfernt. */
  async load(req: FastifyRequest, reply: FastifyReply, o: { touch?: boolean } = {}): Promise<Session | null> {
    const raw = req.cookies[this.cookieName];
    if (!raw) return null;
    const u = req.unsignCookie(raw);
    if (!u.valid || !u.value) { this.clearSessionCookie(reply); return null; }
    const id = hashId(u.value);
    const row = (await this.db.query<{ data: Buffer; csrf: string; created_at: Date; last_seen_at: Date; expires_at: Date }>(
      `SELECT data, csrf, created_at, last_seen_at, expires_at FROM ${this.schema}.session WHERE id = $1`, [id])).rows[0];
    if (!row) { this.clearSessionCookie(reply); return null; }
    const now = this.now();
    const lastSeenAt = row.last_seen_at.getTime(), expiresAt = row.expires_at.getTime();
    let data: SessionData | null = null;
    if (expiresAt > now && now - lastSeenAt < this.cfg.session.idleMs) {
      try { data = JSON.parse(this.sealer.open(row.data, id).toString('utf8')) as SessionData; }
      catch (e) { this.log.warn({ reason: (e as Error).message }, 'Sitzung nicht entschlüsselbar'); }
    }
    if (!data) { await this.destroy(id); this.clearSessionCookie(reply); return null; }
    if (u.renew) this.setSessionCookie(reply, u.value);
    if (o.touch !== false && now - lastSeenAt > Math.min(60_000, this.cfg.session.idleMs / 10)) {
      await this.db.query(`UPDATE ${this.schema}.session SET last_seen_at = $2 WHERE id = $1`, [id, ts(now)]);
    }
    return { id, csrf: row.csrf, data, createdAt: row.created_at.getTime(), expiresAt, lastSeenAt: o.touch === false ? lastSeenAt : now };
  }

  /** Sitzung mit gültigem Access Token (bei Bedarf erneuert) oder null. */
  async current(req: FastifyRequest, reply: FastifyReply): Promise<Session | null> {
    const s = await this.load(req, reply);
    if (!s) return null;
    const data = await this.fresh(s.id, s.data);
    if (!data) { this.clearSessionCookie(reply); return null; }
    return { ...s, data };
  }

  // ---------------------------------------------------------------- SessionBridge
  async accessToken(req: FastifyRequest, reply: FastifyReply): Promise<{ token: string; csrfOk: boolean } | null> {
    const s = await this.current(req, reply);
    if (!s) return null;
    // Links ohne eigene Header (Downloads, Bilder) nennen die Organisation des Tabs als `?x-tenant=` (nur lesend; der
    // Parameter wird vor der Schemaprüfung entfernt, der Resolver prüft gegen das Token wie beim Header)
    const q = req.query as Record<string, unknown> | undefined;
    if (q && typeof q['x-tenant'] === 'string') {
      if ((req.method === 'GET' || req.method === 'HEAD') && !req.headers['x-tenant']) req.headers['x-tenant'] = q['x-tenant'];
      delete q['x-tenant'];
    }
    // Gewählte Organisation als Mandant, sofern die Anfrage nicht selbst einen wählt (der Resolver prüft gegen das Token).
    if (s.data.org && !req.headers['x-tenant']) req.headers['x-tenant'] = s.data.org;
    return { token: s.data.accessToken, csrfOk: this.csrfOk(req.headers['x-csrf-token'], s.csrf) };
  }

  csrfOk(provided: unknown, expected: string): boolean {
    return typeof provided === 'string' && provided.length > 0 && safeEqual(provided, expected);
  }

  // ---------------------------------------------------------------- Erneuerung (Refresh-Token-Rotation)
  /** Erneuert das Access Token kurz vor Ablauf. Parallele Anfragen teilen sich eine Erneuerung (im Prozess per Promise, über Prozesse per Zeilensperre). */
  private fresh(id: string, data: SessionData): Promise<SessionData | null> {
    if (data.accessExp - this.now() > REFRESH_SKEW_MS) return Promise.resolve(data);
    let p = this.inflight.get(id);
    if (!p) {
      p = this.refresh(id).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  private refresh(id: string): Promise<SessionData | null> {
    return withTx(this.db, async tx => {
      const row = (await tx.query<{ data: Buffer }>(`SELECT data FROM ${this.schema}.session WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!row) return null;
      const data = JSON.parse(this.sealer.open(row.data, id).toString('utf8')) as SessionData;
      if (data.accessExp - this.now() > REFRESH_SKEW_MS) return data; // eine andere Instanz war schneller
      const drop = async () => { await tx.query(`DELETE FROM ${this.schema}.session WHERE id = $1`, [id]); return null; };
      if (!data.refreshToken) return drop();
      let tokens: Awaited<ReturnType<typeof client.refreshTokenGrant>>;
      try {
        tokens = await client.refreshTokenGrant(await this.oidc(), data.refreshToken);
      } catch (e) {
        if ((e as { error?: string }).error === 'invalid_grant') return drop(); // abgelaufen, widerrufen oder in Keycloak abgemeldet
        if (e instanceof HttpError) throw e;
        throw new HttpError(503, 'Anmeldedienst nicht erreichbar', oidcError(e));
      }
      if (tokens.claims() && tokens.claims()!.sub !== data.sub) return drop();
      // Liste der Organisationen folgt dem neuen Token (Austritt, neue Mitgliedschaft); die Vorgabe nur, solange sie darin steht (T6)
      const orgs = this.orgsOf(tokens.access_token);
      const next: SessionData = {
        ...data, accessToken: tokens.access_token, accessExp: this.now() + (tokens.expires_in ?? 300) * 1000,
        refreshToken: tokens.refresh_token ?? data.refreshToken, idToken: tokens.id_token ?? data.idToken,
        orgs, org: data.org && orgs.includes(data.org) ? data.org : null,
      };
      await tx.query(`UPDATE ${this.schema}.session SET data = $2 WHERE id = $1`, [id, this.sealer.seal(JSON.stringify(next), id)]);
      return next;
    });
  }

  /** Aliasse der Organisationen im Token (klein, sortiert). */
  private orgsOf(accessToken: string): string[] {
    return [...new Set(orgsFromClaims(decodeClaims(accessToken), this.cfg.tenancy.claim).map(o => orgAlias(o.alias)).filter((a): a is string => a !== null))].sort();
  }

  // ---------------------------------------------------------------- Organisation wechseln
  /**
   * Setzt die Vorgabe der Sitzung (für Tabs und Anfragen ohne `X-Tenant`), wenn das aktuelle Token die Organisation
   * enthält; Tabs mit eigener Wahl bleiben, wo sie sind. Sonst false (→ neue Anmeldung als Rückfall).
   */
  async switchOrg(s: Session, org: string): Promise<boolean> {
    const alias = orgAlias(org);
    if (!alias || !this.orgsOf(s.data.accessToken).includes(alias)) return false;
    // Frisch und gesperrt lesen, nur `org` ändern: sonst schriebe ein Wechsel ein inzwischen rotiertes Refresh Token zurück
    return withTx(this.db, async tx => {
      const row = (await tx.query<{ data: Buffer }>(`SELECT data FROM ${this.schema}.session WHERE id = $1 FOR UPDATE`, [s.id])).rows[0];
      if (!row) return false;
      const data = JSON.parse(this.sealer.open(row.data, s.id).toString('utf8')) as SessionData;
      if (!data.orgs.includes(alias)) return false;
      await tx.query(`UPDATE ${this.schema}.session SET data = $2 WHERE id = $1`, [s.id, this.sealer.seal(JSON.stringify({ ...data, org: alias }), s.id)]);
      return true;
    });
  }

  /**
   * Namen der Organisationen im Token für die Auswahl: Name des Mandanten, gelesen im Kontext des jeweiligen Mandanten
   * (RLS); ohne Mandant (noch nie benutzt, gesperrt oder mit anderer Keycloak-ID) der Alias.
   */
  async organizationNames(s: Session): Promise<Record<string, string>> {
    const orgs = orgsFromClaims(decodeClaims(s.data.accessToken), this.cfg.tenancy.claim);
    const out: Record<string, string> = {};
    if (!orgs.length) return out;
    await withTx(this.db, async tx => {
      for (const o of orgs) {
        const alias = orgAlias(o.alias);
        if (!alias) continue; // ungültiger Alias im Claim: auch der Resolver lehnt ihn ab
        const id = (await tx.query<{ id: string | null }>('SELECT app.resolve_tenant($1, $2, $1, false) AS id', [alias, o.id])).rows[0]?.id ?? null;
        out[alias] = id ? await this.nameIn(tx, id) ?? alias : alias;
      }
    });
    return out;
  }

  /** Name des Mandanten im Kontext des Mandanten (für /auth/me). */
  tenantName(tenantId: string): Promise<string | null> {
    return withTx(this.db, tx => this.nameIn(tx, tenantId));
  }

  private async nameIn(tx: Tx, tenantId: string): Promise<string | null> {
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return (await tx.query<{ name: string }>(`SELECT name FROM ${this.schema}.tenant WHERE id = $1`, [tenantId])).rows[0]?.name ?? null;
  }

  // ---------------------------------------------------------------- Abmeldung
  async destroy(id: string) { await this.db.query(`DELETE FROM ${this.schema}.session WHERE id = $1`, [id]); }

  /** Sitzung beenden; liefert die Adresse für den RP-initiated Logout bei Keycloak. */
  async logout(s: Session, reply: FastifyReply): Promise<string> {
    await this.destroy(s.id);
    this.clearSessionCookie(reply);
    try {
      const c = await this.oidc();
      if (!c.serverMetadata().end_session_endpoint) return this.postLogoutUri;
      return client.buildEndSessionUrl(c, { id_token_hint: s.data.idToken, post_logout_redirect_uri: this.postLogoutUri, client_id: this.cfg.oidc.bffClientId }).href;
    } catch (e) {
      this.log.warn({ reason: oidcError(e) }, 'Abmeldung bei Keycloak nicht möglich, nur lokal abgemeldet');
      return this.postLogoutUri;
    }
  }

  /** Backchannel-Logout (OIDC Back-Channel Logout 1.0): Logout-Token prüfen und betroffene Sitzungen beenden. Liefert die Anzahl. */
  async backchannelLogout(logoutToken: string): Promise<number> {
    let p: Record<string, unknown>;
    try {
      ({ payload: p } = await jwtVerify(logoutToken, await this.provider.keys(), {
        issuer: this.provider.issuer, audience: this.cfg.oidc.bffClientId, algorithms: ALGS, clockTolerance: this.cfg.oidc.clockToleranceSec,
        requiredClaims: ['iat', 'jti'], maxTokenAge: '10m',
      }));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'Logout-Token ungültig', (e as Error).message);
    }
    const events = p.events as Record<string, unknown> | undefined;
    if (!events || typeof events !== 'object' || typeof events[BCL_EVENT] !== 'object' || events[BCL_EVENT] === null) throw new HttpError(400, 'Logout-Token ungültig', 'Ereignis backchannel-logout fehlt.');
    if (p.nonce !== undefined) throw new HttpError(400, 'Logout-Token ungültig', 'nonce ist nicht erlaubt.');
    const sid = typeof p.sid === 'string' ? p.sid : null, sub = typeof p.sub === 'string' ? p.sub : null;
    if (!sid && !sub) throw new HttpError(400, 'Logout-Token ungültig', 'sid oder sub fehlt.');
    const jti = `bcl:${String(p.jti)}`;
    if (!(await this.replay.claim(jti, 20 * 60_000))) throw new HttpError(400, 'Logout-Token ungültig', 'Token wurde bereits verwendet.');
    try {
      const r = sid
        ? await this.db.query(`DELETE FROM ${this.schema}.session WHERE idp_sid = $1 AND ($2::text IS NULL OR subject = $2)`, [sid, sub])
        : await this.db.query(`DELETE FROM ${this.schema}.session WHERE subject = $1`, [sub]);
      return r.rowCount ?? 0;
    } catch (e) {
      // Nicht abgemeldet: Keycloak darf es wiederholen
      await this.replay.release?.(jti).catch(() => undefined);
      throw e;
    }
  }

  // ---------------------------------------------------------------- Aufräumen
  async cleanup(): Promise<number> {
    const now = this.now();
    const r = await this.db.query(`DELETE FROM ${this.schema}.session WHERE expires_at <= $1 OR last_seen_at <= $2`, [ts(now), ts(now - this.cfg.session.idleMs)]);
    return r.rowCount ?? 0;
  }

  startCleanup() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.cleanup().catch(e => this.log.error({ reason: (e as Error).message }, 'Aufräumen der Sitzungen fehlgeschlagen')); }, this.cleanupIntervalMs);
    this.timer.unref();
  }

  stopCleanup() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

/** Claims eines JWT ohne Prüfung lesen (nur für Tokens, die wir selbst vom Token-Endpunkt erhalten haben). */
export function decodeClaims(jwt: string): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return {}; }
}
