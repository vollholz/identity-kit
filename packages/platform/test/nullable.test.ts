/**
 * `Nullable` und `EmptyAsNull` mit den AJV-Optionen der Plattform (`coerceTypes: 'array'`) und mit TypeBox (`Value`,
 * TypeCompiler). Spezifikation: `Nullable(X)` = X (mit dessen Umwandlung und Ablehnung) und zusätzlich null;
 * `EmptyAsNull(X)` = `Nullable(X)` und "" als null, wo X "" ablehnt. Ausgangslage: CSPAG/ppm #159 (`anyOf [X, null]`
 * machte aus null 0) und nachtschicht (`anyOf [null, X, null]` bis 0.6.3 machte aus ungültigen Eingaben null).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { before, describe, test } from 'node:test';
import { FormatRegistry, Kind, Type, type TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import swagger from '@fastify/swagger';
import { optionalBodies } from '@vollholz/iam';
import Fastify from 'fastify';
import { emptyAsNullDocs } from '../src/http/route-kit.ts';
import { DateTime, EmptyAsNull, fastifyOptions, Nullable, Uuid, type PlatformConfig } from '../src/index.ts';

const cfg = { app: { logLevel: 'silent', http: { trustProxy: false, bodyLimit: 1_048_576 } } } as unknown as PlatformConfig;
const TYPES: Record<string, TSchema> = {
  number: Type.Number(), integer: Type.Integer(), integerMin1: Type.Integer({ minimum: 1 }), string: Type.String(),
  stringMin1: Type.String({ minLength: 1 }), boolean: Type.Boolean(), array: Type.Array(Type.String()), dateTime: DateTime, uuid: Uuid,
  object: Type.Object({ a: Type.Number() }, { additionalProperties: false }), literal: Type.Union([Type.Literal('a'), Type.Literal('b')]),
};
const INPUTS: unknown[] = [null, 0, 1, '', '0', '5', 'abc', false, true, 'true', [], ['x'], 'x', { a: 1 }, { a: '2' }, '2026-10-28T00:00:00Z',
  '00000000-0000-4000-8000-000000000000', 'a'];
/** Frühere Formen von `Nullable`. */
const OLD = {
  '0.6.1': (s: TSchema) => Type.Union([s, Type.Null()]),
  '0.6.3': (s: TSchema) => Type.Union([Type.Unsafe({ [Kind]: 'NullExakt', const: null }), s, Type.Null()]),
};

/** Ergebnis je Feld und Eingabe (Anfrage und Antwort): Wert nach der Prüfung oder Status. */
async function results(wrap: (s: TSchema) => TSchema): Promise<Map<string, unknown>> {
  const app = Fastify({ ...fastifyOptions(cfg), logger: false });
  const Body = Type.Object(Object.fromEntries(Object.entries(TYPES).map(([k, s]) => [k, Type.Optional(wrap(s))])), { additionalProperties: false });
  app.patch('/x', { schema: { body: Body, response: { 200: Body } } }, async req => req.body);
  const out = new Map<string, unknown>();
  for (const field of Object.keys(TYPES)) {
    for (const input of INPUTS) {
      const r = await app.inject({ method: 'PATCH', url: '/x', payload: { [field]: input } });
      out.set(`${field} ← ${JSON.stringify(input)}`, r.statusCode === 200 ? r.json()[field] : r.statusCode);
    }
  }
  await app.close();
  return out;
}
/** Abweichungen zwischen zwei Ergebnissen, lesbar. */
const diff = (a: Map<string, unknown>, b: Map<string, unknown>) =>
  [...a].filter(([k, v]) => JSON.stringify(b.get(k)) !== JSON.stringify(v)).map(([k, v]) => `${k}: ${JSON.stringify(v)} → ${JSON.stringify(b.get(k))}`);

describe('Nullable und EmptyAsNull mit AJV (coerceTypes)', () => {
  let plain: Map<string, unknown>;
  before(async () => { plain = await results(s => s); });

  test('Fehler der früheren Formen nachgestellt', async () => {
    const v061 = await results(OLD['0.6.1']);
    assert.deepEqual([v061.get('number ← null'), v061.get('string ← null'), v061.get('boolean ← null')], [0, '', false], 'null → Wert von X');
    const v063 = await results(OLD['0.6.3']);
    assert.deepEqual([v063.get('integerMin1 ← 0'), v063.get('object ← ""'), v063.get('number ← ""')], [null, null, null], 'ungültig → null');
  });

  test('Nullable(X) = X und zusätzlich null (0, "", false bleiben, Ungültiges 400)', async () => {
    const r = await results(Nullable);
    const expected = new Map([...plain].map(([k, v]) => [k, k.endsWith('← null') ? null : v]));
    assert.deepEqual(diff(expected, r), []);
    assert.deepEqual([r.get('number ← 0'), r.get('string ← ""'), r.get('boolean ← false')], [0, '', false]);
    assert.deepEqual([r.get('integerMin1 ← 0'), r.get('object ← ""'), r.get('dateTime ← ""'), r.get('number ← ""')], [400, 400, 400, 400]);
  });

  test('EmptyAsNull(X) = Nullable(X) und "" als null, wo X "" ablehnt; 0 und false nie null', async () => {
    const n = await results(Nullable);
    const r = await results(EmptyAsNull);
    const expected = new Map([...n].map(([k, v]) => [k, k.endsWith('← ""') && v === 400 ? null : v]));
    assert.deepEqual(diff(expected, r), []);
    assert.deepEqual([r.get('dateTime ← ""'), r.get('uuid ← ""'), r.get('string ← ""')], [null, null, '']);
    assert.deepEqual([r.get('integerMin1 ← 0'), r.get('object ← false')], [400, 400]);
  });

  test('Schema: Nullable = anyOf [{ const: null }, X], EmptyAsNull mit allOf [{ const: "" }, { type: null }]', () => {
    for (const s of [Type.Number({ minimum: 1, description: 'd' }), ...Object.values(TYPES), Type.Ref('X')]) {
      const x = JSON.parse(JSON.stringify(s));
      assert.deepEqual(JSON.parse(JSON.stringify(Nullable(s))), { anyOf: [{ const: null }, x] });
      assert.deepEqual(JSON.parse(JSON.stringify(EmptyAsNull(s))), { anyOf: [{ const: null }, x, { allOf: [{ const: '' }, { type: 'null' }] }] });
    }
  });
});

describe('EmptyAsNull in der OpenAPI', () => {
  test('"" als gültige Eingabe beschrieben (wie in buildApp), Nullable unverändert', async () => {
    const app = Fastify({ ...fastifyOptions(cfg), logger: false });
    await app.register(swagger, { openapi: { openapi: '3.1.0', info: { title: 't', version: '1' } }, transformObject: (d => emptyAsNullDocs(optionalBodies(d))) as never });
    app.patch('/x', { schema: { body: Type.Object({ bis: EmptyAsNull(DateTime), id: Nullable(Uuid) }) } }, async () => null);
    await app.ready();
    const props = (app.swagger() as any).paths['/x'].patch.requestBody.content['application/json'].schema.properties;
    assert.deepEqual(props.bis.anyOf, [{ enum: [null] }, { type: 'string', format: 'date-time' }, { enum: [''], description: 'Leer (""), gilt als `null`.' }]);
    assert.deepEqual(props.id.anyOf, [{ enum: [null] }, { type: 'string', format: 'uuid' }]);
    assert.ok(!JSON.stringify(app.swagger()).includes('allOf'), 'kein unerfüllbares allOf');
    await app.close();
  });
});

/** AJV ohne Umwandlung mit den Formaten von Fastify (aus dessen Installation), zum Vergleich mit TypeBox. */
const fromFastify = createRequire(createRequire(import.meta.url).resolve('fastify'));
const ajvCompiler = createRequire(fromFastify.resolve('@fastify/ajv-compiler'));
const AjvClass = ajvCompiler('ajv').default as new (o: object) => { compile(s: object): (v: unknown) => boolean };
const ajv = new AjvClass({ strict: false });
ajvCompiler('ajv-formats').default(ajv);

describe('Nullable und EmptyAsNull mit Value.Check, Value.Errors und TypeCompiler von TypeBox', () => {
  // Formate wie AJV (TypeBox kennt ohne Eintrag keine); DateTime ist `Unsafe` und für Value ohnehin nicht prüfbar
  before(() => {
    if (!FormatRegistry.Has('uuid')) FormatRegistry.Set('uuid', v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  });
  const VALUE_TYPES = Object.entries(TYPES).filter(([k]) => k !== 'dateTime');

  for (const [name, wrap] of [['Nullable', Nullable], ['EmptyAsNull', EmptyAsNull]] as const) {
    test(`${name}: gleiches Ergebnis wie AJV ohne Umwandlung und wie anyOf [X, null], für alle Feldtypen und Eingaben`, () => {
      const out: string[] = [];
      for (const [field, s] of VALUE_TYPES) {
        const schema = wrap(s);
        const compiled = TypeCompiler.Compile(schema);
        const viaAjv = ajv.compile(JSON.parse(JSON.stringify(schema)));
        for (const input of INPUTS) {
          const check = Value.Check(schema, input);
          const noErrors = [...Value.Errors(schema, input)].length === 0;
          const old = Value.Check(Type.Union([s, Type.Null()]), input);
          if (check !== old || check !== viaAjv(input) || noErrors !== check || compiled.Check(input) !== check) {
            out.push(`${field} ← ${JSON.stringify(input)}: Check ${check}, ohne Fehler ${noErrors}, Compiler ${compiled.Check(input)}, anyOf [X, null] ${old}, AJV ${viaAjv(input)}`);
          }
        }
      }
      assert.deepEqual(out, []);
    });
  }
});
