/**
 * Öffentliche Routen eines Moduls mit Token (ohne Sitzung, z. B. Kalender-Abo `GET /kalender/{alias}.{token}.ics`):
 * Clients, die sich nicht anmelden können, erreichen Daten genau einer Organisation über ein geheimes Token in der URL.
 *
 * Das Paket übernimmt alles, was nicht Fachlogik ist:
 * - Organisation aus dem Alias (`app.resolve_tenant`, nie anlegen; unbekannt oder gesperrt = nicht gefunden).
 * - Transaktion im Kontext genau dieser Organisation (RLS `tenant_isolation`) ohne Lesesicht: Tabellen mit Policies
 *   der Lesesicht liefern nichts, bis das Modul mit `viewAs` in die Lesesicht der Person des Tokens wechselt.
 *   Zugriff über Organisationsgrenzen ist damit ausgeschlossen, auch bei einem Fehler im Modul.
 * - Token nur als SHA-256 (`tokenHash`); das Modul speichert und sucht nur den Hash (`publicToken()`).
 * - Rate-Limit je IP und Route (auch ausserhalb von `/v1`), Antworten nicht zwischenspeicherbar, ohne Referrer.
 * - Keine Existenz-Leaks: ungültiges Format, unbekannte oder gesperrte Organisation, unbekanntes Token und eine Person,
 *   die nicht mehr Mitglied ist, ergeben dieselbe Antwort (404 problem+json, gleicher Text).
 * - Token nie im Log: Die Anfrage wird mit dem Routenmuster statt der URL protokolliert.
 *
 * Pfade unter `/v1/` und `/auth/` sind ausgeschlossen (dort verlangt @vollholz/iam eine Anmeldung).
 */
import { createHash, randomBytes } from 'node:crypto';
import { HttpError, problemBody, setContext, subjectsOf, type Principal } from '@vollholz/iam';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from 'fastify';
import type { Tx } from '../db/pool.ts';
import { withTenant } from '../db/pool.ts';
import type { Deps } from './app.ts';

/** Token in der URL: base64url, mindestens 128 Bit. */
export const PUBLIC_TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
/** Alias der Organisation (wie `app.resolve_tenant`). */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED = ['/v1/', '/auth/', '/healthz', '/readyz', '/metrics'];

/** Organisation und Token, wie die Route sie in der Anfrage findet. */
export interface PublicCredentials { alias: string; token: string }

export interface PublicRouteContext {
  /** Organisation aus dem Alias. */
  tenant: { id: string; alias: string };
  /** SHA-256 des Tokens (hex), zum Vergleich mit dem gespeicherten Hash. */
  tokenHash: string;
  /**
   * Transaktion im Kontext der Organisation, ohne Lesesicht: lesbar sind nur Tabellen ohne Policies der Lesesicht
   * (z. B. die Tabelle der Tokens des Moduls).
   */
  tx: Tx;
  /**
   * Wechselt `tx` in die Lesesicht der Person (`principal.id`) für den Rest der Transaktion – mit ihren Rechten,
   * begrenzt auf `scopes` der Route, ohne Gruppen aus Entra (nur aus dem Token einer Anmeldung bekannt). `false`, wenn
   * die Person nicht (mehr) Mitglied der Organisation ist; das Modul antwortet dann wie bei einem unbekannten Token.
   */
  viewAs(principalId: string): Promise<boolean>;
}

export interface PublicRoute {
  /** Name, eindeutig in der App (Rate-Limit, Log), z. B. `kalender-abo`. */
  name: string;
  /** Methode (Standard GET). */
  method?: 'GET' | 'POST';
  /** Pfad nach Fastify, z. B. `/kalender/:datei`; nie unter `/v1/` oder `/auth/`. */
  url: string;
  /** Alias und Token aus der Anfrage; null = Format ungültig (Antwort wie unbekannt). Hilfe: `aliasToken`. */
  credentials(req: FastifyRequest): PublicCredentials | null;
  /** Scopes des Modells, auf die `viewAs` die Rechte der Person begrenzt (empfohlen: nur Lesen). Ohne: alle ihre Rechte. */
  scopes?: readonly string[];
  /** Anfragen je IP und Zeitfenster (Standard 30 je Minute). */
  rateLimit?: { max: number; timeWindow?: number };
  /** Schema der Route (Parameter, Antworten, Doku); `security: []` setzt das Paket. */
  schema?: FastifySchema;
  /**
   * Fachlogik: Token suchen (`tokenHash`), mit `viewAs` lesen, Antwort senden oder zurückgeben. `null`/`undefined`
   * ohne gesendete Antwort = nicht gefunden (dieselbe Antwort wie bei unbekannter Organisation).
   */
  handler(ctx: PublicRouteContext, req: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

/** Neues Token für eine öffentliche Route: `token` geht einmal an die Person, gespeichert wird nur `hash`. */
export function publicToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: publicTokenHash(token) };
}

/** SHA-256 (hex) eines Tokens. */
export const publicTokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Alias und Token aus einem Pfadteil `<alias>.<token><suffix>` (z. B. `acme.Xy3….ics` mit `suffix: '.ics'`); null,
 * wenn das Format nicht passt.
 */
export function aliasToken(part: unknown, o: { suffix?: string } = {}): PublicCredentials | null {
  if (typeof part !== 'string') return null;
  const suffix = o.suffix ?? '';
  if (!part.endsWith(suffix)) return null;
  const core = part.slice(0, part.length - suffix.length);
  const dot = core.indexOf('.');
  if (dot < 1) return null;
  return { alias: core.slice(0, dot), token: core.slice(dot + 1) };
}

/** Einheitliche Antwort für alles, was nicht gefunden wird (kein Hinweis, woran es lag). */
export const publicNotFound = () => new HttpError(404, 'Nicht gefunden', 'Der Link ist ungültig oder nicht mehr aktiv.');

/** Prüft die öffentlichen Routen aller Module (Namen, Pfade, Scopes). */
export function checkPublicRoutes(routes: readonly PublicRoute[], scopes?: ReadonlyMap<string, unknown>): void {
  const seen = new Set<string>();
  for (const r of routes) {
    if (!NAME.test(r.name)) throw new Error(`Öffentliche Route: Name «${r.name}» ungültig (klein, Ziffern, Bindestrich)`);
    if (seen.has(r.name)) throw new Error(`Öffentliche Route «${r.name}» doppelt`);
    seen.add(r.name);
    if (!r.url.startsWith('/') || RESERVED.some(p => r.url === p.replace(/\/$/, '') || r.url.startsWith(p))) {
      throw new Error(`Öffentliche Route «${r.name}»: Pfad «${r.url}» nicht erlaubt (nicht unter ${RESERVED.join(', ')})`);
    }
    for (const s of r.scopes ?? []) if (scopes && !scopes.has(s)) throw new Error(`Öffentliche Route «${r.name}»: Scope «${s}» fehlt im Modell`);
  }
}

/** Hängt die öffentlichen Routen ein (vor der Oberfläche, deren Fallback sonst greift). */
export function registerPublicRoutes(app: FastifyInstance, deps: Deps, routes: readonly PublicRoute[]): void {
  const { iam, platform, cfg } = deps;
  const typeBase = `${cfg.publicBaseUrl}/probleme/`;
  checkPublicRoutes(routes, iam.model.scopes);
  if (routes.length && !app.hasDecorator('rateLimit')) throw new Error('Öffentliche Routen brauchen @fastify/rate-limit');
  for (const route of routes) {
    app.route({
      method: route.method ?? 'GET',
      url: route.url,
      schema: { ...route.schema, security: [] },
      // Token nie im Log: Routenmuster statt URL (Fastify kennt die Option je Route, ihre Typen nicht)
      ...({ logSerializers: { req: (req: FastifyRequest) => ({ method: req.method, url: route.url, reqId: req.id }) } } as object),
      config: {
        rateLimit: {
          max: route.rateLimit?.max ?? 30, timeWindow: route.rateLimit?.timeWindow ?? 60_000, allowList: null as never,
          keyGenerator: (req: FastifyRequest) => `public:${route.name}:${req.ip}`,
        },
      },
      handler: async (req, reply) => {
        reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').header('x-robots-tag', 'noindex');
        try {
          return await run(route, req, reply);
        } catch (e) {
          // Fehler als problem+json mit dem Routenmuster als `instance` (die URL enthält das Token)
          if (!(e instanceof HttpError) || reply.sent) throw e;
          return reply.status(e.status).headers(e.headers).type('application/problem+json').send(problemBody(e, typeBase, route.url));
        }
      },
    });
  }

  async function run(route: PublicRoute, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const c = route.credentials(req);
    if (!c || !ALIAS.test(c.alias) || !PUBLIC_TOKEN.test(c.token)) throw publicNotFound();
    const tenantId = (await deps.db.query<{ id: string | null }>('SELECT app.resolve_tenant($1, null, null, false) AS id', [c.alias])).rows[0]?.id;
    if (!tenantId) throw publicNotFound();
    const alias = c.alias.toLowerCase();
    const result = await withTenant(deps.db, { tenantId }, tx => route.handler({
      tenant: { id: tenantId, alias }, tokenHash: publicTokenHash(c.token), tx,
      viewAs: async principalId => {
        if (typeof principalId !== 'string' || !UUID.test(principalId)) return false;
        const p = (await tx.query<{ id: string; subject: string; display_name: string | null; email: string | null }>(
          `SELECT id, subject, display_name, email FROM ${platform.schema}.principal WHERE id = $1 AND kind = 'user' AND removed_at IS NULL`,
          [principalId])).rows[0];
        if (!p) return false;
        const base: Principal = {
          tenantId, tenantAlias: alias, principalId: p.id, kind: 'user', subject: p.subject, name: p.display_name ?? '', email: p.email,
          clientId: null, groups: [], subjects: [], scopes: [...(route.scopes ?? [])], scopeBound: route.scopes !== undefined,
          platformAdmin: false, binding: 'none', token: '',
        };
        const who: Principal = { ...base, subjects: subjectsOf(base) };
        const settings = await iam.access.readView(tenantId, who, await iam.access.load(tenantId));
        await setContext(tx, { tenantId, principalId: p.id, settings });
        return true;
      },
    }, req, reply));
    if (reply.sent) return reply;
    if (result === null || result === undefined) throw publicNotFound();
    return result;
  }
}
