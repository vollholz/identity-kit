/**
 * HTTP-Anwendung (app-boilerplate 5.5): Fastify mit dem Querschnitt – Logger mit Redaction, Request-ID, Helmet, CSP je
 * Antwortart, Rate-Limit, OpenAPI 3.1 mit Doku, Anmeldung und Rechte aus @vollholz/iam, Idempotenz, Metriken,
 * Fehler als problem+json – und den eingehängten Modulen. Die Module übergibt `defineApp`.
 */
import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { IAM_API_TAGS, iamPlugin, optionalBodies, readinessChecks, requestPath, type Iam } from '@vollholz/iam';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { PlatformConfig } from '../config/env.ts';
import type { PlatformContext } from '../context.ts';
import { REDACT_PATHS } from '../core/redact.ts';
import { rateLimitStore } from '../core/shared-state.ts';
import type { Db } from '../db/pool.ts';
import { metrics } from '../ops/metrics.ts';
import type { ApiTag, PlatformModule } from '../module.ts';
import { registerIdempotency } from './idempotency.ts';
import { registerPublicRoutes } from './public-route.ts';
import { emptyAsNullDocs } from './route-kit.ts';
import { buildSerializer } from './serializer.ts';

/** Abhängigkeiten der Module, einmal gebaut in der Kompositionswurzel. */
export interface Deps {
  platform: PlatformContext;
  cfg: PlatformConfig;
  /** Pool der Laufzeit-Rolle (`<ident>_runtime`). */
  db: Db;
  iam: Iam<string, any>;
  /** Bereitschaft des Prozesses (false beim Beenden → /readyz 503). */
  ready: () => boolean;
}

export type App = FastifyInstance;

/** Tags der API: die der Module, dann die des IAM, zuletzt «Betrieb». Genau einer je Route (`httpSuite`). */
export function apiTags(modules: readonly PlatformModule[]): ApiTag[] {
  return [
    ...modules.flatMap(m => m.tags ?? []),
    ...IAM_API_TAGS,
    { name: 'Betrieb', description: 'Bereitschaft und Lebenszeichen des Dienstes.' },
  ];
}

export interface BuildOptions {
  modules: readonly PlatformModule[];
  /** Modul `people` des IAM: Rechte, die das Personenverzeichnis öffnen (Standard des IAM). */
  people?: { permissions?: string[] };
  fastify?: FastifyServerOptions;
}

/** CSP für alle Antworten ohne eigene Richtlinie (JSON, Fehler). */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** CSP der API-Doku unter /v1/docs (Swagger UI aus eigenen Dateien, ohne fremde Hosts). */
export const DOCS_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function fastifyOptions(cfg: PlatformConfig): FastifyServerOptions {
  return {
    logger: {
      level: cfg.app.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[entfernt]' },
      // Trace-ID der aktiven Spur in jede Zeile (falls Telemetrie aktiv)
      mixin: () => traceIds(),
    },
    // Request-ID übernehmen (Proxy) oder neu; nur sichere Zeichen
    genReqId: req => {
      const h = req.headers['x-request-id'];
      const v = Array.isArray(h) ? h[0] : h;
      return v && /^[\w.:-]{1,128}$/.test(v) ? v : randomUUID();
    },
    requestIdHeader: false,
    // Anzahl der Proxys ist erlaubt (Fastify), fehlt aber im Typ
    trustProxy: cfg.app.http.trustProxy as FastifyServerOptions['trustProxy'],
    bodyLimit: cfg.app.http.bodyLimit,
    // Pfadteile bis 256 Zeichen (Standard 100): `<alias>.<token>.ics` öffentlicher Routen passt sonst nicht zur Route
    routerOptions: { maxParamLength: 256 },
    // Unbekannte Felder ergeben 422 statt still zu verschwinden (Voraussetzung von @vollholz/iam)
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true } },
    // Serialisierer je Route nur mit den gemeinsamen Schemas, die sie braucht (Start wächst sonst mit Routen × Schemas)
    schemaController: { compilersFactory: { buildSerializer: buildSerializer() as never } },
  };
}

/** Pfade einer Anfrage für Entscheide nach Präfix: Routenmuster und dekodierter Pfad (nie der rohe `req.url`). */
export function apiPaths(req: { url: string; routeOptions: { url?: string } }): string[] {
  return [req.routeOptions.url, requestPath(req.url)].filter((p): p is string => !!p);
}

let spanContext: (() => { traceId: string; spanId: string } | undefined) | null = null;
/** Telemetrie meldet hier, wie die aktive Spur gelesen wird (ops/telemetry.ts über main/). */
export function setSpanContext(fn: typeof spanContext): void { spanContext = fn; }
function traceIds(): Record<string, string> {
  const c = spanContext?.();
  return c && c.traceId !== '00000000000000000000000000000000' ? { trace_id: c.traceId, span_id: c.spanId } : {};
}

/**
 * Baut die Anwendung. `modules` in Reihenfolge; das Modul der Oberfläche (SPA-Fallback, `uiModule`) zuletzt.
 */
export async function buildApp(deps: Deps, o: BuildOptions): Promise<App> {
  const { cfg, iam, platform } = deps;
  const app = Fastify({ ...fastifyOptions(cfg), ...o.fastify }).withTypeProvider<TypeBoxTypeProvider>();

  app.addHook('onRequest', async (req, reply) => { reply.header('x-request-id', req.id); });
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', API_CSP);
    return payload;
  });
  app.addHook('onResponse', async (req, reply) => {
    metrics.httpRequest(req.routeOptions.url ?? 'unbekannt', req.method, reply.statusCode, reply.elapsedTime);
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    hsts: cfg.mode === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });
  // @fastify/cookie registriert das IAM-Plugin selbst (mit SESSION_SECRET)
  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler',
    max: cfg.app.http.rateLimit,
    timeWindow: 60_000,
    // Je Principal im Mandanten, ohne Anmeldung je IP; Oberfläche und Betrieb nie begrenzt
    keyGenerator: req => (req.principal ? `p:${req.principal.tenantId}:${req.principal.principalId}` : `ip:${req.ip}`),
    // Am Routenmuster und am dekodierten Pfad: `/%761/…` erreicht dieselbe Route wie `/v1/…` und zählt mit
    allowList: req => !apiPaths(req).some(p => (p.startsWith('/v1/') || p.startsWith('/auth/')) && !p.startsWith('/v1/docs')),
    nameSpace: `${cfg.ops.rateLimitNamespace ? `${cfg.ops.rateLimitNamespace}:` : ''}${platform.product}:api:`,
    ...rateLimitStore(platform, cfg, deps.db),
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: platform.title, version: '1', description: `REST-API von ${platform.title}. Fehler als application/problem+json (RFC 9457).` },
      servers: [{ url: cfg.publicBaseUrl }],
      tags: apiTags(o.modules),
    },
    refResolver: { buildLocalReference: (json, _b, _f, i) => (typeof json.$id === 'string' ? json.$id : `def-${i}`) },
    transformObject: ((doc: Parameters<typeof optionalBodies>[0]) => emptyAsNullDocs(optionalBodies(doc))) as never,
  });
  await app.register(swaggerUi, {
    routePrefix: '/v1/docs',
    staticCSP: DOCS_CSP,
    uiConfig: { docExpansion: 'list', deepLinking: true, defaultModelsExpandDepth: 0 },
  });
  await app.register(iamPlugin, {
    iam,
    publicPaths: ['/v1/openapi.json', '/v1/docs', '/v1/docs/*'],
    ...(o.people ? { people: o.people as never } : {}),
  });
  registerIdempotency(app, { db: deps.db, schema: platform.schema, ttlMs: cfg.app.http.idempotencyTtlMs });

  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // Lebenszeichen auch auf dem Dienst-Port (neben dem Betriebs-Endpunkt)
  const checks = readinessChecks(iam);
  app.get('/healthz', { schema: { tags: ['Betrieb'], summary: 'Lebenszeichen', hide: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { tags: ['Betrieb'], summary: 'Bereitschaft', hide: true } }, async (_req, reply) => {
    if (!deps.ready()) return reply.code(503).send({ status: 'stopping' });
    const failed: string[] = [];
    await Promise.all(checks.map(c => c.run().catch(() => failed.push(c.failure))));
    return failed.length ? reply.code(503).send({ status: 'unavailable', failed }) : { status: 'ok' };
  });

  // Öffentliche Routen mit Token vor den Modulen (die Oberfläche als letztes Modul hat den Fallback)
  registerPublicRoutes(app, deps, o.modules.flatMap(m => m.publicRoutes ?? []));
  for (const m of o.modules) await m.register?.(app, deps);
  return app;
}
