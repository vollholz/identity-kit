/**
 * HTTP-Client des Vertrags (Spezifikation 5.2, 11.1). Herkunft: vollholz/assets `web/src/api/client.ts`.
 * - Sitzungs-Cookie (same-origin), `X-CSRF-Token` automatisch bei schreibenden Aufrufen
 * - Organisation des Tabs als `X-Tenant` bei jeder Anfrage: Die Sitzung gilt für alle Tabs, die Organisation nicht; ohne
 *   Header nähme der Server die Vorgabe der Sitzung, die ein anderer Tab inzwischen geändert haben kann
 * - Fehler als `ApiError` (problem+json); 401 meldet einen Sitzungsablauf, 403 lässt die Sitzung prüfen, ob die
 *   Organisation des Tabs noch verfügbar ist – auch für eigene Clients der App (`iamMiddleware`, `reportStatus`)
 */
import { ApiError, errorFrom, networkError } from './problem.ts';

let csrfToken: string | null = null;
let tenant: string | null = null;
const expiredListeners = new Set<() => void>();
const forbiddenListeners = new Set<() => void>();

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function setCsrfToken(token: string | null) { csrfToken = token; }
/** Organisation dieses Tabs (Alias), gesendet als `X-Tenant`; gesetzt von der Sitzung. */
export function setTenant(alias: string | null) { tenant = alias; }
export const currentTenant = (): string | null => tenant;

/** `X-Tenant` und – für schreibende Aufrufe – `X-CSRF-Token` für eigene Aufrufe der App (z. B. Streaming, Upload). */
export function tenantHeaders(method = 'POST'): Record<string, string> {
  return { ...(csrfToken && !SAFE.has(method.toUpperCase()) ? { 'X-CSRF-Token': csrfToken } : {}), ...(tenant ? { 'X-Tenant': tenant } : {}) };
}

/** Link ohne eigene Header (Download, Bild) mit der Organisation dieses Tabs (`?x-tenant=`, nur GET/HEAD, 5.2). */
export function withTenant(url: string): string {
  if (!tenant) return url;
  // vor dem Fragment einfügen: alles nach «#» erreicht den Server nie
  const hash = url.indexOf('#');
  const [base, frag] = hash < 0 ? [url, ''] : [url.slice(0, hash), url.slice(hash)];
  return `${base}${base.includes('?') ? '&' : '?'}x-tenant=${encodeURIComponent(tenant)}${frag}`;
}

/** 401 einer Anfrage: Sitzung abgelaufen. Gibt die Abmeldung des Empfängers zurück. */
export function onSessionExpired(fn: () => void): () => void { expiredListeners.add(fn); return () => { expiredListeners.delete(fn); }; }
/** 403 einer Anfrage: fehlendes Recht oder Organisation nicht mehr verfügbar (z. B. nach einem Austritt). */
export function onForbidden(fn: () => void): () => void { forbiddenListeners.add(fn); return () => { forbiddenListeners.delete(fn); }; }

/**
 * Status einer Antwort melden, die nicht über das Paket lief (eigener Client der App): 401 öffnet «Sitzung abgelaufen»,
 * 403 lässt `/auth/me` neu prüfen. Andere Status ignoriert.
 */
export function reportStatus(status: number) {
  if (status === 401) for (const fn of [...expiredListeners]) fn();
  if (status === 403) for (const fn of [...forbiddenListeners]) fn();
}

export const origin: string = typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null' ? window.location.origin : 'http://localhost';

/** Version (ETag `W/"n"`) als If-Match-Header. */
export const ifMatch = (version: number): Record<string, string> => ({ 'If-Match': `W/"${version}"` });

const here = () => (typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}${window.location.hash}`);

/** Anmeldung beim BFF mit Rücksprung; `org` wählt die Organisation vor (5.1). */
export function loginUrl(returnTo: string = here(), org?: string): string {
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}${org ? `&org=${encodeURIComponent(org)}` : ''}`;
}

function prepare(headers: Headers, method: string) {
  if (!SAFE.has(method) && csrfToken && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', csrfToken);
  if (tenant && !headers.has('X-Tenant')) headers.set('X-Tenant', tenant);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json, application/problem+json');
}

/**
 * Anfrage an den BFF (`/auth/*`); liefert die Antwort ohne Fehlerbehandlung (die Sitzung wertet 401 selbst aus).
 * `X-Tenant` wie bei allen Aufrufen, sofern nicht selbst gesetzt; Netzwerkfehler als ApiError mit Status 0.
 */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  prepare(headers, (init.method ?? 'GET').toUpperCase());
  try { return await globalThis.fetch(`${origin}${path}`, { ...init, headers, credentials: 'same-origin' }); }
  catch (e) { throw networkError(e); }
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];

export interface IamRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Suchparameter; Listen werden wiederholt (`?roles=a&roles=b`), leere Werte weggelassen. */
  query?: Record<string, QueryValue>;
  /** JSON-Körper. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Adresse mit Suchparametern. */
export function withQuery(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === '') continue;
    for (const x of Array.isArray(v) ? v : [v]) p.append(k, String(x));
  }
  const s = p.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

/**
 * Aufruf an `/v1/…` des Vertrags: JSON hin und zurück, Fehler als ApiError (401/403 gemeldet), 204 → `undefined`.
 */
export async function iamFetch<T>(path: string, req: IamRequest = {}): Promise<T> {
  const method = req.method ?? 'GET';
  const headers = new Headers(req.headers);
  prepare(headers, method);
  if (req.body !== undefined) headers.set('Content-Type', 'application/json');
  let res: Response;
  try {
    res = await globalThis.fetch(`${origin}${withQuery(path, req.query)}`, {
      method, headers, credentials: 'same-origin', signal: req.signal,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw networkError(e);
  }
  if (!res.ok) {
    reportStatus(res.status);
    throw await errorFrom(res);
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Middleware für eigene Clients der App nach der Schnittstelle von `openapi-fetch` (ohne es zu importieren): setzt
 * `X-Tenant`, `X-CSRF-Token` und `Accept`, wirft Fehler als ApiError und meldet 401/403 an die Sitzung.
 * Verwendung: `api.use(iamMiddleware)`.
 */
export const iamMiddleware = {
  onRequest({ request }: { request: Request }): Request {
    prepare(request.headers, request.method.toUpperCase());
    return request;
  },
  async onResponse({ response }: { response: Response }): Promise<Response> {
    if (response.ok || response.status === 304) return response;
    reportStatus(response.status);
    throw await errorFrom(response);
  },
  onError({ error }: { error: unknown }): Error {
    return error instanceof ApiError ? error : networkError(error);
  },
};
