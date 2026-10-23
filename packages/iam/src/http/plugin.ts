/**
 * Fastify-Plugin des IAM (Entwurf 3.2, 3.3, 13.4; aus Assets `http/app.ts`): Anmeldung je Anfrage (Bearer, DPoP, mTLS,
 * Sitzung der Oberfläche), Dekorationen der Anfrage, Fehler als problem+json und die Module des Pakets.
 *
 * Nicht gekapselt (`skip-override`): Hooks und Dekorationen wirken auf die ganze App. Die App registriert ihre
 * OpenAPI-Beschreibung (`@fastify/swagger`) vorher, damit sie die Routen des Pakets sieht; Rate-Limit, Idempotenz,
 * CSP und Telemetrie bleiben in der App und sehen `req.principal`, weil der Hook des Plugins vor ihren Routen-Hooks läuft.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AccessService, TenantAccess } from '../access.ts';
import { capabilities } from '../access.ts';
import type { AuditEntry, Source } from '../audit.ts';
import type { RegisteredPermission } from '../catalog.ts';
import type { Tx } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { Iam } from '../iam.ts';
import type { Principal } from '../principal.ts';
import type { ResourceRef } from '../resources.ts';
import { accountModule } from './account.ts';
import { aclModule } from './acl.ts';
import { bffModule } from './bff.ts';
import { registerErrorHandler, registerProblemSchemas } from './problems.ts';
import type { IamModule, ModuleContext, OpenApiOverrides } from './routes.ts';

/** Sitzung der Oberfläche (Modul `bff`): gültiges Access Token für eine Anfrage mit Sitzungs-Cookie oder null. */
export interface SessionBridge {
  accessToken(req: FastifyRequest, reply: FastifyReply): Promise<{ token: string; csrfOk: boolean } | null>;
}

export type IamModuleName = 'account' | 'acl' | 'bff';

export interface IamPluginOptions {
  iam: Iam<any, any>;
  /** Module des Pakets; Standard: alle, die Katalog und Konfiguration erlauben (`acl` mit Zugriffsregeln, `bff` mit `iam.bff`). */
  modules?: IamModuleName[];
  /** Fehlerbehandlung und 404 als problem+json (Standard `true`; `false`, wenn die App eigene hat). */
  errorHandler?: boolean;
  /** Fehlerschemas als Komponenten und übliche Fehlerantworten je Route unter `apiPrefix` (Standard `true`). */
  problemSchemas?: boolean;
  /** Präfix für `type` der Fehler (Assets: `https://assets.example.ch/probleme/`); Standard `<PUBLIC_BASE_URL>/probleme/`. */
  problemTypeBase?: string;
  /** Präfix der API (Standard `/v1`): alles darunter braucht ein Token, ausser `publicPaths`. */
  apiPrefix?: string;
  /** Pfade ohne Anmeldung, `*` am Ende für ein Präfix (Assets: `/v1/openapi.json`, `/v1/docs`, `/v1/docs/*`). */
  publicPaths?: string[];
  /** Sitzung der Oberfläche; Standard `iam.bff`. */
  sessions?: SessionBridge;
  /** Tags, Zusammenfassungen und Beschreibungen der Routen des Pakets (Entwurf 13.4). */
  openapi?: OpenApiOverrides;
  /** Span-Attribut mit dem Alias der Organisation (Standard `iam.tenant`). */
  spanAttribute?: string;
}

type Perm = RegisteredPermission;

declare module 'fastify' {
  interface FastifyRequest {
    /** Angemeldeter Principal oder null (Pfade ohne Anmeldung). */
    principal: Principal | null;
    /** Herkunft der Anfrage: Oberfläche (Sitzung), API oder MCP-Dienst. */
    source: Source;
    /** Principal oder 401. */
    requirePrincipal(): Principal;
    /** Arbeit im Mandantenkontext des Principals (RLS aktiv) mit dem Kontext der App (`resources.dbContext`). */
    tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
    /** Recht prüfen ((Rolle ∨ Freigabe) ∧ Scope ∧ Zugriffsregel), sonst 403 mit Label. */
    need(perm: Perm, ref?: ResourceRef, hint?: string | null): Promise<void>;
    /** Recht auf Mandantenebene oder über eine Freigabe auf einer Ressource, sonst 403 (nur für Listen und Einstiege). */
    needSomewhere(perm: Perm): Promise<void>;
    /** Entscheidung ohne Wurf (Zugriffsregeln einmal je Anfrage geladen). */
    can(perm: Perm, ref?: ResourceRef, hint?: string | null): Promise<boolean>;
    /** Fähigkeiten nach dem Katalog für viele Ressourcen (Zugriffsregeln einmal geladen). */
    capabilities(): Promise<(kind: string, id: string, hint?: string | null) => Record<string, boolean>>;
    /** Audit-Eintrag über den `AuditPort` in derselben Transaktion. */
    audit(tx: Tx, e: AuditEntry): Promise<void>;
  }
}

/**
 * Pfad ohne Query, Prozent-Kodierung aufgelöst. Der Router dekodiert ebenfalls (`/%761/…` trifft `/v1/…`); Prüfungen
 * am rohen `req.url` liessen sich so umgehen. Unlesbare Kodierung: roher Pfad.
 */
export function requestPath(url: string): string {
  const raw = url.split(/[?#]/, 1)[0] || '/';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/**
 * Braucht die Anfrage ein Token? Entschieden am Routenmuster und am dekodierten Pfad: alles unter dem Präfix ausser
 * den öffentlichen Pfaden – auch Pfade ohne Route (404 erst nach der Anmeldung).
 */
export function needsToken(prefix: string, isPublic: (path: string) => boolean, routeUrl: string | undefined, url: string): boolean {
  return [routeUrl, requestPath(url)].some(p => !!p && p.startsWith(`${prefix}/`) && !isPublic(p));
}

const publicMatcher = (paths: readonly string[]) => (path: string) => paths.some(p => (p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p));

/** Schreibende Anfrage? (CSRF-Schutz für die Sitzung) */
const reading = (method: string) => ['GET', 'HEAD', 'OPTIONS'].includes(method);

async function iamPluginImpl(app: FastifyInstance, o: IamPluginOptions) {
  const { iam } = o;
  const { cfg } = iam;
  const prefix = o.apiPrefix ?? '/v1';
  const typeBase = o.problemTypeBase ?? `${cfg.publicBaseUrl}/probleme/`;
  const isPublic = publicMatcher(o.publicPaths ?? []);
  const spanAttribute = o.spanAttribute ?? 'iam.tenant';
  const realm = iam.catalog.product;
  const challenge = { 'WWW-Authenticate': `Bearer realm="${realm}", DPoP algs="ES256 PS256 RS256"` };
  const invalidToken = { 'WWW-Authenticate': 'DPoP error="invalid_token"' };
  const names = o.modules ?? (['account', ...(iam.catalog.acl ? ['acl'] : []), ...(iam.bff ? ['bff'] : [])] as IamModuleName[]);
  const sessions = o.sessions ?? iam.bff ?? undefined;
  if (names.includes('acl') && !iam.catalog.acl) throw new Error('Modul «acl» braucht Zugriffsregeln (Ressourcen im Katalog)');

  await checkCookies(app, cfg.session.secrets);
  // Telemetrie ist optional: ohne @opentelemetry/api kein Span-Attribut
  const otel = await import('@opentelemetry/api').catch(() => null);

  if (o.errorHandler !== false) registerErrorHandler(app, typeBase);
  if (o.problemSchemas !== false) registerProblemSchemas(app, prefix);

  // ---------- Anmeldung pro Anfrage (Bearer/DPoP oder Sitzung der Oberfläche)
  app.decorateRequest('principal', null);
  app.decorateRequest('source', 'api');
  app.addHook('onRequest', async (req, reply) => {
    if (!needsToken(prefix, isPublic, req.routeOptions.url, req.url)) return;
    const auth = req.headers.authorization;
    let token: string | null = null, scheme: 'Bearer' | 'DPoP' | null = null;
    if (auth) {
      const m = /^(Bearer|DPoP)\s+([\w.~+/-]+=*)$/i.exec(auth);
      if (!m) throw new HttpError(401, 'Authorization-Header ungültig', 'Erwartet «Bearer <token>» oder «DPoP <token>».', challenge);
      scheme = m[1]!.toLowerCase() === 'dpop' ? 'DPoP' : 'Bearer'; token = m[2]!;
    } else if (sessions) {
      const s = await sessions.accessToken(req, reply);
      if (s) {
        if (!reading(req.method) && !s.csrfOk) throw new HttpError(403, 'CSRF-Token fehlt oder ist ungültig', 'Header «X-CSRF-Token» aus /auth/me mitsenden.');
        token = s.token; req.source = 'ui';
      }
    }
    if (!token) throw new HttpError(401, 'Nicht angemeldet', 'Access Token im Authorization-Header senden.', challenge);
    const url = `${cfg.publicBaseUrl}${req.url.split('?')[0]}`;
    // Zertifikat vom Proxy (PEM oder DER/base64, siehe parseClientCert); der Proxy muss den Header immer überschreiben
    const certHeader = cfg.m2m.mtlsHeader ? req.headers[cfg.m2m.mtlsHeader.toLowerCase()] : undefined;
    const verified = await iam.verifier.verify(token, {
      audience: cfg.oidc.apiAudience, method: req.method, url, dpopHeader: typeof req.headers.dpop === 'string' ? req.headers.dpop : undefined,
      clientCert: typeof certHeader === 'string' ? certHeader : null,
    });
    if (scheme === 'Bearer' && verified.binding === 'dpop') throw new HttpError(401, 'Falsches Schema', 'DPoP-gebundene Tokens mit «Authorization: DPoP …» senden.', invalidToken);
    // Das Schema DPoP behauptet eine Bindung: ohne DPoP-gebundenes Token wurde kein Nachweis geprüft (RFC 9449, 7.1)
    if (scheme === 'DPoP' && verified.binding !== 'dpop') throw new HttpError(401, 'Falsches Schema', 'Nicht DPoP-gebundene Tokens mit «Authorization: Bearer …» senden.', invalidToken);
    // Vor dem Resolver: abgewiesene Tokens schreiben nichts (Principal, letzte Rollen und Scopes)
    const dm = cfg.m2m.dpopMode;
    if (verified.binding === 'none' && req.source !== 'ui' && (dm === 'required' || (dm === 'required-for-clients' && iam.resolver.kindOf(verified.claims) === 'client'))) {
      throw new HttpError(401, 'Sendergebundenes Token nötig', 'Maschinen-Clients müssen DPoP- oder mTLS-gebundene Tokens verwenden.', invalidToken);
    }
    const p = await iam.resolver.resolve(verified, typeof req.headers['x-tenant'] === 'string' ? req.headers['x-tenant'] : null);
    if (req.source !== 'ui' && p.clientId && p.clientId === cfg.mcp.clientId) req.source = 'mcp';
    req.principal = p;
    otel?.trace.getActiveSpan()?.setAttribute(spanAttribute, p.tenantAlias);
  });

  // ---------- Dekorationen
  const access = iam.access as AccessService<string, unknown>;
  // Zugriffsregeln einmal je Anfrage (Fähigkeiten über Listen ohne erneutes Laden)
  const acls = new WeakMap<FastifyRequest, Promise<TenantAccess>>();
  const aclOf = (req: FastifyRequest) => {
    let a = acls.get(req);
    if (!a) { a = access.load(req.requirePrincipal().tenantId); acls.set(req, a); }
    return a;
  };
  app.decorateRequest('requirePrincipal', function (this: FastifyRequest) {
    if (!this.principal) throw new HttpError(401, 'Nicht angemeldet', undefined, challenge);
    return this.principal;
  });
  app.decorateRequest('tx', function <T>(this: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return iam.tx(this.requirePrincipal(), fn);
  });
  app.decorateRequest('need', async function (this: FastifyRequest, perm: string, ref?: ResourceRef, hint?: string | null) {
    await access.require(this.requirePrincipal(), perm, ref, hint);
  });
  app.decorateRequest('needSomewhere', async function (this: FastifyRequest, perm: string) {
    await access.requireSomewhere(this.requirePrincipal(), perm);
  });
  app.decorateRequest('can', async function (this: FastifyRequest, perm: string, ref?: ResourceRef, hint?: string | null) {
    return access.decide(this.requirePrincipal(), await aclOf(this), perm, ref, hint);
  });
  app.decorateRequest('capabilities', async function (this: FastifyRequest) {
    // Derselbe Stand der Zugriffsregeln wie `can` in dieser Anfrage
    const p = this.requirePrincipal(), acl = await aclOf(this);
    return (kind: string, id: string, hint?: string | null) => capabilities(access, p, acl, kind, id, hint);
  });
  app.decorateRequest('audit', async function (this: FastifyRequest, tx: Tx, e: AuditEntry) {
    const p = this.principal;
    await iam.audit.write(tx, { principal: p && { kind: p.kind, principalId: p.principalId, name: p.name, clientId: p.clientId }, source: this.source, correlationId: this.id }, e);
  });

  // ---------- Module
  const ctx: ModuleContext = { iam, prefix, openapi: o.openapi ?? {} };
  const modules: Record<IamModuleName, IamModule> = { account: accountModule, acl: aclModule, bff: bffModule };
  for (const n of names) await modules[n].register(app, ctx);
}

/**
 * Cookies mit `SESSION_SECRET` signiert: Ist `@fastify/cookie` schon registriert, muss es mit denselben Geheimnissen
 * signieren (sonst Abbruch beim Start, Entwurf 13.4); sonst registriert es das Plugin.
 */
async function checkCookies(app: FastifyInstance, secrets: string[]) {
  // Erst hier geladen: Worker und Skripte nutzen das Paket ohne Fastify
  const { default: cookie, signerFactory, sign } = await import('@fastify/cookie');
  if (!app.hasDecorator('parseCookie')) {
    await app.register(cookie, { secret: secrets.length ? secrets : undefined });
    return;
  }
  if (!secrets.length) return;
  // Gleich signieren (erstes Geheimnis) und jedes Geheimnis annehmen, auch die älteren einer Rotation
  const ours = signerFactory(secrets);
  let same = false;
  try { same = app.signCookie('iam-check') === ours.sign('iam-check') && secrets.every(s => app.unsignCookie(sign('iam-check', s)).valid); } catch { same = false; }
  if (!same) throw new Error('@fastify/cookie ist ohne SESSION_SECRET registriert: mit secret = SESSION_SECRET registrieren oder dem IAM-Plugin überlassen');
}

/** Das Plugin (nicht gekapselt). */
export const iamPlugin = Object.assign(iamPluginImpl, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: '@vollholz/iam',
});

/**
 * `need` als preHandler (Entwurf 13.4): `{ preHandler: need('note:read', r => ({ type: 'note', id: r.params.id })) }`.
 * `hint` z. B. der Elterntyp aus der Anfrage.
 */
export function need<R extends FastifyRequest = FastifyRequest>(perm: Perm, ref?: (req: R) => ResourceRef, hint?: (req: R) => string | null) {
  return async (req: R) => { await req.need(perm, ref?.(req), hint?.(req)); };
}
