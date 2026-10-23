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
/** Abbruch über `AbortSignal`; `DOMException` ist nicht überall eine Unterklasse von `Error`, daher nur der Name. */
const isAbort = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';

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

/**
 * `If-Match` aus der Version (`W/"<version>"`) oder unverändert aus einem ETag einer GET-Antwort
 * (`W/"<version>-<zugriff>"`, Spezifikation 7.1). Der Server vergleicht nur die Version (Assets: `ifMatchVersion`).
 */
export const ifMatch = (versionOrEtag: number | string): Record<string, string> =>
  ({ 'If-Match': typeof versionOrEtag === 'number' ? `W/"${versionOrEtag}"` : versionOrEtag });

const here = () => (typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}${window.location.hash}`);

/** Pfad innerhalb dieser App: beginnt mit «/», nicht mit «//», «/\» oder «/@» (keine andere Herkunft, 5.2). */
export const isLocalPath = (p: string): boolean => p.startsWith('/') && !/^\/[/\\@]/.test(p);

/**
 * Anmeldelink vom Server (`testLoginPath`, `Mitglied.loginPath`) als absolute Adresse: nur ein Pfad unter «/auth/»
 * dieser Herkunft, sonst `null` (dann zeigt die Oberfläche keinen Knopf und keinen Link).
 */
export function authLink(path: string | null | undefined): string | null {
  if (!path || !isLocalPath(path) || !path.startsWith('/auth/')) return null;
  const base = typeof window === 'undefined' ? origin : window.location.origin;
  try {
    const url = new URL(path, base);
    return url.origin === base && url.pathname.startsWith('/auth/') ? url.href : null;
  } catch { return null; }
}

/** Adresse für die Zustimmung bei Microsoft: nur https und ein Host aus `hosts`. */
export function isConsentUrl(url: string, hosts: readonly string[]): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && hosts.includes(u.hostname.toLowerCase());
  } catch { return false; }
}

/**
 * Anmeldung beim BFF mit Rücksprung; `org` wählt die Organisation vor (5.1). Ein `returnTo` ausserhalb der App (absolut,
 * «//…») wird zu «/»; der BFF prüft zusätzlich (5.2).
 */
export function loginUrl(returnTo: string = here(), org?: string): string {
  const target = isLocalPath(returnTo) ? returnTo : '/';
  return `/auth/login?returnTo=${encodeURIComponent(target)}${org ? `&org=${encodeURIComponent(org)}` : ''}`;
}

/** Adresse an der eigenen Herkunft; andere Pfade sind ein Programmierfehler (CSRF-Token und Organisation nie fremd). */
function sameOrigin(path: string): string {
  const url = `${origin}${path}`;
  if (!isLocalPath(path) || new URL(url).origin !== origin) throw new TypeError(`Nur Pfade dieser App: ${path}`);
  return url;
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
  const url = sameOrigin(path);
  prepare(headers, (init.method ?? 'GET').toUpperCase());
  try { return await globalThis.fetch(url, { ...init, headers, credentials: 'same-origin' }); }
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
  /** Öffentlicher Aufruf ohne Sitzung: ohne Cookie, X-Tenant und X-CSRF-Token, 401/403 nicht an die Sitzung gemeldet. */
  anonymous?: boolean;
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
  const url = sameOrigin(withQuery(path, req.query));
  const headers = new Headers(req.headers);
  if (!req.anonymous) prepare(headers, method);
  if (req.body !== undefined) headers.set('Content-Type', 'application/json');
  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      method, headers, credentials: req.anonymous ? 'omit' : 'same-origin', signal: req.signal,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw networkError(e);
  }
  if (!res.ok) {
    if (!req.anonymous) reportStatus(res.status);
    throw await errorFrom(res);
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Middleware für eigene Clients der App nach der Schnittstelle von `openapi-fetch` (ohne es zu importieren): setzt
 * `X-Tenant`, `X-CSRF-Token` und `Accept` – nur für Anfragen an die eigene Herkunft, nie an fremde Hosts –, wirft Fehler
 * als ApiError und meldet 401/403 an die Sitzung. Abbrüche bleiben Abbrüche. Verwendung: `api.use(iamMiddleware)`.
 */
export const iamMiddleware = {
  onRequest({ request }: { request: Request }): Request {
    if (new URL(request.url).origin === origin) prepare(request.headers, request.method.toUpperCase());
    return request;
  },
  async onResponse({ response }: { response: Response }): Promise<Response> {
    if (response.ok || response.status === 304) return response;
    reportStatus(response.status);
    throw await errorFrom(response);
  },
  /** `undefined`: openapi-fetch wirft den ursprünglichen Fehler weiter (Abbrüche; `DOMException` ist kein `Error`). */
  onError({ error }: { error: unknown }): Error | undefined {
    if (error instanceof ApiError || isAbort(error)) return undefined;
    return networkError(error);
  },
};
