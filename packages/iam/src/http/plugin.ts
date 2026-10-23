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
import { capabilities, noFacts } from '../access.ts';
import type { AuditEntry, Source } from '../audit.ts';
import type { Level, RegisteredPermission } from '../model.ts';
import type { Tx } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { Iam } from '../iam.ts';
import type { Principal } from '../principal.ts';
import type { ResourceRef } from '../resources.ts';
import { accessModule } from './access.ts';
import { accountModule } from './account.ts';
import { breakGlassModule } from './break-glass.ts';
import { adminModule } from './admin.ts';
import { bffModule } from './bff.ts';
import { clientsModule } from './clients.ts';
import { entraModule } from './entra.ts';
import { defaultPeoplePermissions, peopleModule } from './people.ts';
import { registerErrorHandler, registerProblemSchemas } from './problems.ts';
import type { IamModule, ModuleContext, OpenApiOverrides } from './routes.ts';

/** Sitzung der Oberfläche (Modul `bff`): gültiges Access Token für eine Anfrage mit Sitzungs-Cookie oder null. */
export interface SessionBridge {
  accessToken(req: FastifyRequest, reply: FastifyReply): Promise<{ token: string; csrfOk: boolean } | null>;
}

export type IamModuleName = 'account' | 'access' | 'admin' | 'bff' | 'break-glass' | 'clients' | 'entra' | 'people';

export interface IamPluginOptions {
  iam: Iam<any, any>;
  /**
   * Module des Pakets; Standard: alle, die Modell und Konfiguration erlauben (`bff` mit `iam.bff`; `admin` und `entra`
   * immer, ohne Verwaltungs-Client bzw. Entra-App mit 503 nach Kap. 9.1 Nr. 13).
   */
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
  /** Sitzung der Oberfläche; Standard `iam.bff`, wenn das Modul `bff` aktiv ist. */
  sessions?: SessionBridge;
  /** Tags, Zusammenfassungen und Beschreibungen der Routen des Pakets (Entwurf 13.4). */
  openapi?: OpenApiOverrides;
  /**
   * Modul `people`: Rechte, von denen eines irgendwo (`needSomewhere`) das Personenverzeichnis öffnet; Standard die
   * Fachrechte des Lese-Scopes `<produkt>:read` und `access:admin` (Assets: `['object:read']`).
   */
  people?: { permissions?: Perm[] };
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
    /** Arbeit im Mandantenkontext des Principals (RLS aktiv) mit der Lesesicht der Anfrage (Kap. 7.6). */
    tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
    /** Recht prüfen (Kap. 7.5: Freigabe ∨ Zuständigkeit ∨ Besitz, ∧ Vertraulichkeit ∧ Scope), sonst 403 mit Label. */
    need(perm: Perm, ref?: ResourceRef, hint?: string | null): Promise<void>;
    /** Recht an mindestens einem Ort, sonst 403 (nur für Listen und Einstiege). */
    needSomewhere(perm: Perm): Promise<void>;
    /** Entscheidung ohne Wurf (Tupel einmal je Anfrage geladen). */
    can(perm: Perm, ref?: ResourceRef, hint?: string | null): Promise<boolean>;
    /**
     * Fähigkeiten nach dem Modell für viele Ressourcen (Tupel einmal geladen). `refs`: Ressourcen, deren Fachdaten
     * (Vertraulichkeit, Zuständigkeit) vorab gelesen werden; ohne zählt die Zuständigkeit nicht.
     */
    capabilities(refs?: ResourceRef[]): Promise<(kind: string, id: string, hint?: string | null) => Record<string, boolean>>;
    /** Freigabestufe mindestens `level`, sonst 403 mit Grund `clearance` (A14). */
    needClearance(level: Level): Promise<void>;
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
  // Seite der Entra-Administration (Link ohne Sitzung): Schutz über Token, state und PKCE
  const isPublic = publicMatcher([...(o.publicPaths ?? []), `${prefix}/entra/handover/*`]);
  const spanAttribute = o.spanAttribute ?? 'iam.tenant';
  const realm = iam.model.product;
  const challenge = { 'WWW-Authenticate': `Bearer realm="${realm}", DPoP algs="ES256 PS256 RS256"` };
  const invalidToken = { 'WWW-Authenticate': 'DPoP error="invalid_token"' };
  // Personenverzeichnis ohne Option nur, wenn ein Recht es öffnen kann (sonst startete die App nicht); ausdrücklich in
  // `modules` verlangt, meldet das Modul den Fehler
  const people = !o.modules && (!!o.people || defaultPeoplePermissions(iam.model).some(x => iam.model.isPermission(x)));
  if (!o.modules && !people) app.log.warn('Modul «people» nicht geladen: kein Recht öffnet das Verzeichnis (Option people.permissions oder Lese-Scope <produkt>:read)');
  const names = o.modules ?? (['account', 'access', 'admin', 'break-glass', 'entra', ...(iam.bff ? ['bff'] : []), 'clients', ...(people ? ['people'] : [])] as IamModuleName[]);
  // Sitzungscookies nur mit Modul bff oder ausdrücklicher SessionBridge (der MCP-Dienst nimmt keine an)
  const sessions = o.sessions ?? (names.includes('bff') ? iam.bff ?? undefined : undefined);

  await checkCookies(app, cfg.session.secrets);
  // Telemetrie ist optional: ohne @opentelemetry/api kein Span-Attribut
  const otel = await import('@opentelemetry/api').catch(() => null);

  if (o.errorHandler !== false) registerErrorHandler(app, typeBase);
  if (o.problemSchemas !== false) registerProblemSchemas(app, prefix);

  // Unbekannte Felder: Das Paket setzt `ajv.customOptions.removeAdditional: false` voraus (docs/backend.md). Ohne entfernt
  // Fastify sie still; das öffnet nichts, verdeckt aber Tippfehler. Fastify verrät die Einstellung nicht, also einmal bei
  // der ersten Anfrage mit dem Validator der App prüfen
  let ajvChecked = false;
  app.addHook('onRequest', async req => {
    if (ajvChecked) return;
    ajvChecked = true;
    const probe: Record<string, unknown> = { unknown: 1 };
    try {
      if (req.compileValidationSchema({ type: 'object', additionalProperties: false })(probe) && !('unknown' in probe)) {
        req.log.warn('@vollholz/iam: Fastify entfernt unbekannte Felder still. Mit ajv.customOptions.removeAdditional: false ergeben sie 422 (docs/backend.md).');
      }
    } catch { /* eigener Validator der App: nicht prüfbar */ }
  });

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
    p.clearance = iam.access.clearanceOf(p, await iam.access.load(p.tenantId));
    req.principal = p;
    otel?.trace.getActiveSpan()?.setAttribute(spanAttribute, p.tenantAlias);
  });

  // ---------- Dekorationen
  const access = iam.access as AccessService<string, unknown>;
  // Tupel einmal je Anfrage (Fähigkeiten über Listen ohne erneutes Laden)
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
    const p = this.requirePrincipal(), acl = await aclOf(this), r = ref ?? { type: 'org' };
    const h = hint === undefined && r.type !== 'org' ? await access.hint(p.tenantId, r) : hint;
    return access.decide(p, acl, perm, r, h, await access.facts(p, acl, [r], p.tenantId));
  });
  app.decorateRequest('capabilities', async function (this: FastifyRequest, refs?: ResourceRef[]) {
    // Derselbe Stand der Tupel wie `can` in dieser Anfrage
    const p = this.requirePrincipal(), acl = await aclOf(this);
    const facts = refs?.length ? await access.facts(p, acl, refs, p.tenantId) : noFacts();
    return (kind: string, id: string, hint?: string | null) => capabilities(access, p, acl, kind, id, hint, facts);
  });
  app.decorateRequest('needClearance', async function (this: FastifyRequest, level: Level) {
    await access.requireClearance(this.requirePrincipal(), level);
  });
  app.decorateRequest('audit', async function (this: FastifyRequest, tx: Tx, e: AuditEntry) {
    const p = this.principal;
    await iam.audit.write(tx, { principal: p && { kind: p.kind, principalId: p.principalId, name: p.name, clientId: p.clientId }, source: this.source, correlationId: this.id }, e);
  });

  // ---------- Module
  const ctx: ModuleContext = { iam, prefix, openapi: o.openapi ?? {}, ...(o.people ? { people: o.people } : {}) };
  const modules: Record<IamModuleName, IamModule> = { account: accountModule, access: accessModule, admin: adminModule, bff: bffModule, 'break-glass': breakGlassModule, clients: clientsModule, entra: entraModule, people: peopleModule };
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
