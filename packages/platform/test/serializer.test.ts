/**
 * Antwort-Serialisierer (src/http/serializer.ts): gleicher Code und gleiche Antworten wie der Standard von Fastify,
 * gleiche Fehler bei ungültigen Schemas, Start ohne Aufwand Routen × gemeinsame Schemas.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { buildSerializer } from '../src/http/serializer.ts';
import { manyRoutes } from './fixture/many-routes.ts';

type Schema = Record<string, any>;
type Factory = (ext: Record<string, Schema>, opts?: Record<string, unknown>) => (route: { schema: Schema }) => unknown;
const fromFastify = createRequire(createRequire(import.meta.url).resolve('fastify'));
const { SerializerSelector } = fromFastify('@fastify/fast-json-stringify-compiler') as { SerializerSelector: () => Factory };

const ours = (): FastifyServerOptions => ({ schemaController: { compilersFactory: { buildSerializer: buildSerializer() as never } } });
/** Fabrik, die jeden Aufruf von Fastify aufzeichnet und an den Standard weitergibt. */
function recording(calls: Array<{ ext: Record<string, Schema>; schema: Schema }>): FastifyServerOptions {
  const std = SerializerSelector();
  return { schemaController: { compilersFactory: { buildSerializer: ((ext: Record<string, Schema>, o: Record<string, unknown>) => {
    const c = std(ext, o);
    return (route: { schema: Schema }) => { calls.push({ ext, schema: route.schema }); return c(route); };
  }) as never } } };
}

const obj = (properties: Schema, o: Schema = {}) => ({ type: 'object', properties, additionalProperties: false, ...o });
/** Gemeinsame Schemas mit allen Formen von Verweisen, die fast-json-stringify kennt. */
const SHARED: Schema[] = [
  { $id: 'Tree', ...obj({ name: { type: 'string' }, children: { type: 'array', items: { $ref: 'Tree#' } } }) },
  { $id: 'Defs', definitions: { a: obj({ x: { type: 'string' } }), b: { $ref: '#/definitions/a' } } },
  { $id: 'Outer', ...obj({ inner: { $id: 'Inner', ...obj({ y: { type: 'integer' }, again: { $ref: '#' } }) } }) },
  { $id: 'Anch', definitions: { z: { $id: '#zed', type: 'string' } } },
  { $id: 'Choice', anyOf: [{ $ref: 'Defs#/definitions/a' }, { type: 'null' }] },
  { $id: 'Self', ...obj({ s: { type: 'string' } }) },
  { $id: 'Deep', ...obj({ d: { $ref: 'Choice' }, t: { $ref: 'Tree' } }) },
  ...Array.from({ length: 30 }, (_, i) => ({ $id: `Unused${i}`, ...obj({ u: { type: 'string' }, r: { $ref: 'Defs#/definitions/a' } }) })),
];
const VALUE = { name: 'n', children: [{ name: 'c', children: [], geheim: 1 }], x: 'x', y: 1, again: { y: 2, geheim: 1 }, inner: { y: 3, geheim: 1 },
  s: 's', d: { x: 'dx', geheim: 1 }, t: { name: 't', children: [] }, geheim: 'weg', items: [{ x: 'i', geheim: 1 }] };
/** Antwort-Schemas der Routen (die erste baut mit allen Schemas, alle weiteren mit Teilmengen). */
const ROUTES: Array<[string, Schema]> = [
  ['plain', obj({ x: { type: 'string' } })],
  ['tree', { $ref: 'Tree#' }],
  ['defs', { $ref: 'Defs#/definitions/b' }],
  ['inner', { $ref: 'Inner#' }],
  ['outer', { $ref: 'Outer' }],
  ['anchor', obj({ x: { $ref: 'Anch#zed' } })],
  ['choice', { $ref: 'Choice#' }],
  ['deep', { $ref: 'Deep' }],
  ['self', SHARED.find(s => s.$id === 'Self')!],
  ['local', { definitions: { e: obj({ x: { type: 'string' } }) }, ...obj({ items: { type: 'array', items: { $ref: '#/definitions/e' } } }) }],
  ['own-id', { $id: 'Eigen', ...obj({ d: { $ref: 'Eigen#/definitions/q' } }), definitions: { q: { $ref: 'Defs#/definitions/a' } } }],
  ['list', obj({ items: { type: 'array', items: { $ref: 'Deep#' } } })],
];

async function app(fastify: FastifyServerOptions, shared = SHARED, routes = ROUTES): Promise<FastifyInstance> {
  const a = Fastify({ logger: false, ...fastify });
  for (const s of shared) a.addSchema(s);
  for (const [name, schema] of routes) a.get(`/${name}`, { schema: { response: { 200: schema, 404: { $ref: 'Defs#/definitions/a' } } } }, async () => VALUE);
  return a;
}

/** Fehler beim Start: Meldung oder null. */
async function startError(fastify: FastifyServerOptions, shared: Schema[], routes: Array<[string, Schema]>, opts?: FastifyServerOptions): Promise<string | null> {
  const a = await app({ ...opts, ...fastify }, shared, routes);
  try { await a.ready(); return null; } catch (e) { return (e as Error).message; } finally { await a.close().catch(() => {}); }
}

describe('Antwort-Serialisierer', () => {
  test('gleicher Code wie der Standard für jede Route (auch IDs, Anker, Zeiger, anyOf, Rekursion, eigene $id)', async () => {
    const recorded: Array<{ ext: Record<string, Schema>; schema: Schema }> = [];
    const r = await app(recording(recorded));
    await r.ready();
    await r.close();
    const m = await manyRoutes({ schemas: 8, routes: 8, fastify: recording(recorded) });
    await m.ready();
    await m.close();
    assert.ok(recorded.length > 2 * ROUTES.length);
    const std = SerializerSelector();
    const fast = buildSerializer();
    const opts = { mode: 'standalone' };
    const norm = (code: unknown) => String(code).replace(/__fjs_(root|merged)_\d+/g, '__fjs_$1');
    for (const { ext, schema } of recorded) {
      assert.equal(norm(fast({ ...ext }, opts)({ schema })), norm(std({ ...ext }, opts)({ schema })), JSON.stringify(schema).slice(0, 120));
    }
  });

  test('gleiche Antworten, unbekannte Felder entfernt (additionalProperties)', async () => {
    const before = await app({});
    const after = await app(ours());
    for (const [name] of ROUTES) {
      const [x, y] = await Promise.all([before.inject(`/${name}`), after.inject(`/${name}`)]);
      assert.equal(y.statusCode, x.statusCode, name);
      assert.equal(y.body, x.body, name);
      assert.doesNotMatch(y.body, /geheim|weg/, name);
    }
    await Promise.all([before.close(), after.close()]);
  });

  test('gleiche Fehler bei ungültigen Schemas, auch nach der ersten Route', async () => {
    const cases: Array<[string, Schema[], Array<[string, Schema]>, FastifyServerOptions?]> = [
      ['gemeinsames Schema ungültig', [...SHARED, { $id: 'Kaputt', type: 'objekt' }], ROUTES],
      ['gemeinsames Schema zu tief', [...SHARED, { $id: 'Tief', ...obj({ a: obj({ b: obj({ c: { type: 'string' } }) }) }) }], ROUTES, { serializerOpts: { maxDepth: 3 } } as never],
      ['Verweis ins Leere (erste Route)', SHARED, [['fehlt', { $ref: 'Fehlt#' }], ...ROUTES]],
      ['Verweis ins Leere (spätere Route)', SHARED, [...ROUTES, ['fehlt', { $ref: 'Fehlt#' }]]],
      ['Zeiger ins Leere (spätere Route)', SHARED, [...ROUTES, ['zeiger', { $ref: 'Defs#/definitions/nein' }]]],
      ['Schema der Route ungültig (spätere Route)', SHARED, [...ROUTES, ['kaputt', { type: 'objekt' }]]],
    ];
    for (const [name, shared, routes, opts] of cases) {
      const x = await startError({}, shared, routes, opts);
      assert.ok(x, `${name}: Standard ohne Fehler`);
      assert.equal(await startError(ours(), shared, routes, opts), x, name);
    }
  });

  test('Start: gemeinsame Schemas nicht je Route neu geprüft (Benchmark)', async t => {
    const time = async (fastify: FastifyServerOptions) => {
      const t0 = performance.now();
      const a = await manyRoutes({ schemas: 40, routes: 80, fastify });
      await a.ready();
      await a.close();
      return performance.now() - t0;
    };
    const before = await time({});
    const after = await time(ours());
    t.diagnostic(`40 gemeinsame Schemas, 160 Routen: Standard ${Math.round(before)} ms, mit buildSerializer ${Math.round(after)} ms`);
    assert.ok(after < before / 2, `${Math.round(after)} ms nicht unter der Hälfte von ${Math.round(before)} ms`);
  });
});
