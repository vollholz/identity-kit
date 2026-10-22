/**
 * Bausteine für den Isolations-Durchlauf über alle Routen (Spezifikation Kap. 14): Organisation B erfährt nichts von
 * Organisation A – weder Inhalte noch die Existenz von IDs, Namen, Personen oder Mengen.
 *
 * Die App liefert ihre Testdaten und Tabellen (fremde IDs im Pfad, in Eingaben, Listen); dieses Modul liefert das
 * Gerüst: Routen sammeln, prüfen, dass ein Aufruf die gemeinte Route wirklich erreicht, Antworten vergleichbar machen,
 * Abflüsse finden und die Abdeckung aller Routen erzwingen (kein leeres Grün).
 */
import { randomBytes, randomUUID } from 'node:crypto';

/** Routenmuster in der Schreibweise der OpenAPI-Beschreibung (wie @fastify/swagger): `:id(…)` → `{id}`, `::` → `:`, `*` → `{*}`. */
export const openApiPath = (url: string) => url.replace(/::|:(\w+)(\((?:[^()]|\([^()]*\))*\))?|\*/g, (m, name: string) => (m === '::' ? ':' : m === '*' ? '{*}' : `{${name}}`));

/** Minimal benötigte Teile einer Fastify-Instanz (ohne Abhängigkeit von Fastify). */
interface HookHost {
  addHook(name: 'onRoute', fn: (r: { method: string | string[]; url: string }) => void): unknown;
}
interface ProbeHost {
  addHook(name: 'preHandler', fn: (req: unknown, reply: { header(k: string, v: string): unknown }) => Promise<void>): unknown;
  addHook(name: 'onSend', fn: (req: { routeOptions: { url?: string } }, reply: { header(k: string, v: string): unknown }, payload: unknown) => Promise<unknown>): unknown;
}

/** Sammelt alle Routen (Methode und Pfad in OpenAPI-Schreibweise), auch versteckte; vor den Modulen registrieren. */
export function routeCollector() {
  const routes = new Set<string>();
  return {
    routes,
    install(app: HookHost) { app.addHook('onRoute', r => { for (const m of [r.method].flat()) routes.add(`${m} ${openApiPath(r.url)}`); }); },
  };
}

export const ROUTE_HEADER = 'x-test-route';
export const HANDLER_HEADER = 'x-test-handler';

/**
 * Testsonden: Kopfzeile mit der erreichten Route und Marke «Schemaprüfung bestanden» (preHandler läuft erst nach der
 * Validierung). Nach den Modulen registrieren.
 */
export function installProbes(app: ProbeHost) {
  app.addHook('preHandler', async (_req, reply) => { reply.header(HANDLER_HEADER, '1'); });
  app.addHook('onSend', async (req, reply, payload) => { reply.header(ROUTE_HEADER, req.routeOptions.url ?? ''); return payload; });
}

export interface ProbeResponse { status: number; text: string; headers: Record<string, unknown> }

/**
 * Hat der Aufruf `route` erreicht und die Schemaprüfung bestanden? Sonst prüft er nichts («Route nicht gefunden» bzw.
 * 422 aus der Eingabeprüfung). Liefert den Befund oder null.
 */
export function unreached(res: ProbeResponse, method: string, route: string): string | null {
  const h = res.headers[ROUTE_HEADER];
  const hit = typeof h === 'string' && h ? `${method} ${openApiPath(h)}` : '(keine)';
  if (hit !== route) return `Route nicht gefunden – der Aufruf erreicht ${hit} statt ${route} (${res.status} ${res.text.slice(0, 200)})`;
  if (res.status === 422 && !res.headers[HANDLER_HEADER]) return `422 aus der Schemaprüfung – der Aufruf erreicht die Prüfung nicht (${res.text.slice(0, 300)})`;
  return null;
}

/**
 * Abfluss in einer Antwort an B: Markierungen aus den Daten von A (ohne Gross-/Kleinschreibung) oder IDs von A. Echos
 * der eigenen Eingabe (`allowed`, z. B. die angefragte URL) zählen nicht. Liefert die Befunde.
 */
export function leaks(text: string, o: { markers: string[]; ids?: Iterable<string>; allowed?: Iterable<string> }): string[] {
  let t = text ?? '';
  for (const v of o.allowed ?? []) if (v) t = t.split(v).join('<eingabe>');
  const lower = t.toLowerCase(), out: string[] = [];
  for (const m of o.markers) if (lower.includes(m.toLowerCase())) out.push(`enthält «${m}» aus Organisation A`);
  for (const id of o.ids ?? []) if (id && id.length >= 8 && t.includes(id)) out.push(`enthält die ID ${id} aus Organisation A`);
  return out;
}

/**
 * IDs von A bzw. unbekannte IDs für den Bau eines Aufrufs; merkt sich die verwendeten (Vergleich, erlaubte Echos).
 * `unknown(key)` erzeugt für einen Schlüssel eine ID, die es nirgends gibt (Standard: neue UUID).
 * `own`: Schlüssel, die immer die eigenen IDs von B liefern (z. B. ein Typ von B für einen gültigen Body).
 */
export function idSource<T extends Record<string, string | undefined>>(src: T | null, o: { unknown?: (key: string) => string; own?: (key: string) => string | undefined } = {}) {
  const used = new Map<string, string>();
  const ids = new Proxy({} as Record<string, string>, {
    get(_t, k) {
      if (typeof k !== 'string') return undefined;
      const mine = o.own?.(k);
      if (mine !== undefined) return mine;
      if (!used.has(k)) {
        const v = src ? src[k] : (o.unknown?.(k) ?? randomUUID());
        if (v === undefined) throw new Error(`Testaufbau: ID «${k}» von A fehlt`);
        used.set(k, v);
      }
      return used.get(k);
    },
  });
  return { ids, used };
}

/** Zufällige Kennung, die es sicher nirgends gibt (für Schlüssel, die keine UUID sind). */
export const unknownKey = (prefix = 'unbekannt') => `${prefix}-${randomBytes(4).toString('hex')}`;

/**
 * Vergleichbare Form einer Antwort: verwendete IDs durch ihren Namen ersetzt; Zeitpunkte und neu vergebene UUIDs
 * (ausser `keep`) durch Platzhalter, dazu eigene Ersetzungen der App (`replace`, z. B. Geheimnisse, Objektschlüssel).
 */
export function normalize(text: string, used: Map<string, string>, o: { keep?: Iterable<string>; replace?: [RegExp, string][] } = {}): unknown {
  let s = text ?? '';
  for (const [k, v] of used) s = s.split(v).join(`<${k}>`);
  const keep = new Set(o.keep ?? []);
  s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<zeit>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, m => (keep.has(m) ? m : '<neu>'));
  for (const [re, by] of o.replace ?? []) s = s.replace(re, by);
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Abdeckung: jede Route der API (`all`) ist geprüft (`covered`: Route → Art der Prüfung) oder begründet ausgenommen
 * (`exempt`: Pfad bzw. Präfix mit «/» am Ende → Begründung); geprüfte Routen gibt es noch.
 */
export function coverageProblems(o: { all: Iterable<string>; covered: Map<string, string> | Iterable<string>; exempt: Record<string, string> }): { missing: string[]; stale: string[] } {
  const all = new Set(o.all);
  const covered = new Set(o.covered instanceof Map ? o.covered.keys() : o.covered);
  const exempt = (r: string) => Object.keys(o.exempt).some(p => { const path = r.split(' ')[1] ?? ''; return p.endsWith('/') ? path.startsWith(p) : path === p; });
  return {
    missing: [...all].filter(r => !covered.has(r) && !exempt(r)).sort(),
    stale: [...covered].filter(r => !all.has(r)).sort(),
  };
}

/** Operationen eines Path Item (OpenAPI 3.1); übrige Schlüssel (`summary`, `parameters`, `servers`, `$ref` …) sind keine. */
const OPERATIONS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Routen aus einer OpenAPI-Beschreibung (`paths`), z. B. gefiltert auf `/v1/`. */
export function routesOf(doc: { paths: Record<string, Record<string, unknown>> }, filter: (route: string) => boolean = () => true): string[] {
  return Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).filter(m => OPERATIONS.includes(m)).map(m => `${m.toUpperCase()} ${path}`)).filter(filter);
}
