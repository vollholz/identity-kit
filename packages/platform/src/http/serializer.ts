/**
 * Antwort-Serialisierer mit schnellem Start. Fastify baut beim Start je Route und Status einen Serialisierer mit
 * fast-json-stringify und gibt dabei alle gemeinsamen Schemas (`app.addSchema`) mit; fast-json-stringify prüft und
 * registriert sie jedes Mal neu (Tiefe, Meta-Schema, Ref-Resolver). Der Aufwand wächst mit Routen × gemeinsamen Schemas.
 *
 * Hier prüft der erste Serialisierer eines Kontexts alle gemeinsamen Schemas wie bisher (gleiche Fehler, zur gleichen
 * Zeit); jeder weitere bekommt nur die Schemas, auf die er über `$ref` (auch mittelbar) verweist. fast-json-stringify
 * löst `$ref` als Zeichenkette auf (Teil vor `#`, sonst das umgebende Schema), andere Schemas fliessen nicht in den Code
 * ein: gleiche Antworten, gleiche Filterung (additionalProperties). Lässt sich ein Verweis nicht eindeutig zuordnen,
 * bekommt die Route wie bisher alle Schemas.
 *
 * Gebaut wird mit dem Compiler aus der Installation von Fastify (gleiche Version wie ohne diese Fabrik).
 */
import { createRequire } from 'node:module';

type Schema = Record<string, unknown>;
type Schemas = Record<string, Schema>;
type RouteCompiler = (route: { schema: Schema; [k: string]: unknown }) => unknown;
type SerializerFactory = (externalSchemas: Schemas, serializerOpts?: Record<string, unknown>) => RouteCompiler;

const fromFastify = createRequire(createRequire(import.meta.url).resolve('fastify'));
const { SerializerSelector } = fromFastify('@fastify/fast-json-stringify-compiler') as { SerializerSelector: () => SerializerFactory };

const isObject = (v: unknown): v is Schema => typeof v === 'object' && v !== null;
/** Schema-ID wie fast-json-stringify und json-schema-ref-resolver: `$id`, ausser es ist ein Anker (`#…`). */
const ownId = (s: Schema): string | undefined => (typeof s.$id === 'string' && s.$id.charAt(0) !== '#' ? s.$id : undefined);

/** IDs (eigene und eingebettete `$id`) und Verweisziele eines Schemas, je umgebender ID. */
function scan(schema: Schema, rootId: string): { ids: Set<string>; refs: Set<string> } {
  const ids = new Set([ownId(schema) ?? rootId]);
  const refs = new Set<string>();
  const stack: Array<{ v: unknown; base: string }> = [{ v: schema, base: ownId(schema) ?? rootId }];
  // Je Objekt und umgebender ID einmal (geteilte Teilschemas, Zyklen)
  const seen = new Map<object, Set<string>>();
  while (stack.length) {
    const { v, base: outer } = stack.pop()!;
    if (!isObject(v)) continue;
    const bases = seen.get(v) ?? new Set<string>();
    if (bases.has(outer)) continue;
    seen.set(v, bases.add(outer));
    const id = Array.isArray(v) ? undefined : ownId(v);
    if (id) ids.add(id);
    const base = id ?? outer;
    for (const key in v) {
      const child = v[key];
      // Jeder Schlüssel `$ref` zählt (wie in fast-json-stringify), auch in enum, default oder examples: eher mehr
      if (key === '$ref' && typeof child === 'string') {
        const hash = child.indexOf('#');
        refs.add((hash === -1 ? child : child.slice(0, hash)) || base);
      } else if (isObject(child)) stack.push({ v: child, base });
    }
  }
  return { ids, refs };
}

type Scan = ReturnType<typeof scan>;
interface Index { owner: Map<string, string>; refs: Map<string, Set<string>> }

/** Index der gemeinsamen Schemas: jede ID (auch eingebettete) → Schlüssel, Verweise je Schlüssel; null: nicht eindeutig. */
function index(pool: Schemas, scanned: (s: Schema, key: string) => Scan): Index | null {
  const owner = new Map<string, string>();
  const refs = new Map<string, Set<string>>();
  for (const key in pool) {
    const r = scanned(pool[key]!, key);
    for (const id of r.ids) {
      if (owner.has(id) && owner.get(id) !== key) return null;
      owner.set(id, key);
    }
    refs.set(key, r.refs);
  }
  return { owner, refs };
}

/** Gemeinsame Schemas, die das Schema der Route (mittelbar) braucht; null: nicht eindeutig (alle mitgeben). */
function needed(schema: Schema, pool: Schemas, ix: Index): Schemas | null {
  const route = scan(schema, '__route');
  for (const id of route.ids) if (ix.owner.has(id)) return null;
  const keys = new Set<string>();
  const pending = [...route.refs].filter(r => !route.ids.has(r));
  while (pending.length) {
    const key = ix.owner.get(pending.pop()!);
    if (key === undefined) return null;
    if (keys.has(key)) continue;
    keys.add(key);
    pending.push(...ix.refs.get(key)!);
  }
  const out: Schemas = {};
  for (const key in pool) if (keys.has(key)) out[key] = pool[key]!;
  return out;
}

/**
 * `schemaController.compilersFactory.buildSerializer` für Fastify. Fastify ruft die Fabrik in einem Kontext mit
 * `addSchema` für jede Route neu auf (mit einer Kopie der Schemas); was geprüft ist, gilt deshalb über die Aufrufe.
 */
export function buildSerializer(): SerializerFactory {
  const base = SerializerSelector();
  // Gemeinsame Schemas, die ein Bau mit diesen Optionen (Tiefe) schon geprüft hat, je Optionen
  const checked = new WeakMap<object, WeakSet<Schema>>();
  const scans = new WeakMap<Schema, Map<string, Scan>>();
  const scanned = (s: Schema, key: string): Scan => {
    let byKey = scans.get(s);
    if (!byKey) scans.set(s, byKey = new Map());
    let r = byKey.get(key);
    if (!r) byKey.set(key, r = scan(s, key));
    return r;
  };
  const NONE = {};
  return (externalSchemas, serializerOpts) => {
    let pool = externalSchemas;
    const okKey = serializerOpts ?? NONE;
    let ok = checked.get(okKey);
    if (!ok) checked.set(okKey, ok = new WeakSet());
    let ix: Index | null | undefined;
    return route => {
      // Wie @fastify/fast-json-stringify-compiler: Schema mit eigener `$id` aus dem Vorrat (auch für spätere Routen)
      const id = route.schema.$id;
      if (pool && typeof id === 'string' && pool[id]) {
        pool = { ...pool };
        delete pool[id];
        ix = undefined;
      }
      const all = pool ? Object.values(pool) : [];
      // Bis alle gemeinsamen Schemas einmal geprüft sind: alle mitgeben wie bisher (gleiche Fehler zur gleichen Zeit)
      if (!all.every(s => isObject(s) && ok.has(s))) {
        const out = base(pool, serializerOpts)(route);
        for (const s of all) if (isObject(s)) ok.add(s);
        return out;
      }
      if (ix === undefined) ix = index(pool, scanned);
      return base((ix && needed(route.schema, pool, ix)) ?? pool, serializerOpts)(route);
    };
  };
}
