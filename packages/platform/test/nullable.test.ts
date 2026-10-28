/**
 * `Nullable` mit den AJV-Optionen der Plattform (`coerceTypes: 'array'`): null bleibt null, 0, "" und false bleiben,
 * alle anderen Eingaben wie bisher. Ausgangslage CSPAG/ppm #159: `anyOf [X, null]` speicherte bei PATCH mit null eine 0.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { before, describe, test } from 'node:test';
import { FormatRegistry } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import { Type, type TSchema } from '@sinclair/typebox';
import Fastify from 'fastify';
import { DateTime, fastifyOptions, Nullable, Uuid, type PlatformConfig } from '../src/index.ts';

const cfg = { app: { logLevel: 'silent', http: { trustProxy: false, bodyLimit: 1_048_576 } } } as unknown as PlatformConfig;
const helpers: Record<string, (s: TSchema) => TSchema> = {
  Nullable,
  'anyOf [X, null] (bis 0.6.1)': s => Type.Union([s, Type.Null()]),
  'anyOf [null, X]': s => Type.Union([Type.Null(), s]),
};
const TYPES: Record<string, TSchema> = {
  number: Type.Number(), integer: Type.Integer(), string: Type.String(), boolean: Type.Boolean(), array: Type.Array(Type.String()),
  dateTime: DateTime, uuid: Uuid, object: Type.Object({ a: Type.Number() }, { additionalProperties: false }),
  literal: Type.Union([Type.Literal('a'), Type.Literal('b')]),
};
const INPUTS: unknown[] = [null, 0, 1, '', '0', '5', 'abc', false, true, 'true', [], ['x'], 'x', { a: 1 }, { a: '2' }, '2026-10-28T00:00:00Z',
  '00000000-0000-4000-8000-000000000000', 'a'];

/** Ergebnis je Feld und Eingabe: Status 200 mit dem Wert nach der Prüfung, sonst der Status. */
async function results(nullable: (s: TSchema) => TSchema): Promise<Map<string, unknown>> {
  const app = Fastify({ ...fastifyOptions(cfg), logger: false });
  const props = Object.fromEntries(Object.entries(TYPES).map(([k, s]) => [k, Type.Optional(nullable(s))]));
  const Body = Type.Object(props, { additionalProperties: false });
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

describe('Nullable', () => {
  test('Fehler der bisherigen Formen nachgestellt: null → 0 / "" / false, bzw. 0 / "" / false → null', async () => {
    const xFirst = await results(helpers['anyOf [X, null] (bis 0.6.1)']!);
    assert.equal(xFirst.get('number ← null'), 0);
    assert.equal(xFirst.get('integer ← null'), 0);
    assert.equal(xFirst.get('string ← null'), '');
    assert.equal(xFirst.get('boolean ← null'), false);
    const nullFirst = await results(helpers['anyOf [null, X]']!);
    assert.equal(nullFirst.get('number ← 0'), null);
    assert.equal(nullFirst.get('string ← ""'), null);
    assert.equal(nullFirst.get('boolean ← false'), null);
  });

  test('null bleibt null, 0, "" und false bleiben (Anfrage und Antwort)', async () => {
    const r = await results(Nullable);
    for (const field of Object.keys(TYPES)) assert.equal(r.get(`${field} ← null`), null, field);
    assert.equal(r.get('number ← 0'), 0);
    assert.equal(r.get('integer ← 0'), 0);
    assert.equal(r.get('string ← ""'), '');
    assert.equal(r.get('boolean ← false'), false);
    assert.deepEqual(r.get('array ← []'), []);
  });

  test('alle anderen Eingaben wie bisher (Umwandlung, Ablehnung)', async () => {
    const before = await results(helpers['anyOf [X, null] (bis 0.6.1)']!);
    const after = await results(Nullable);
    const diff = [...before].filter(([k, v]) => !k.endsWith('← null') && JSON.stringify(after.get(k)) !== JSON.stringify(v))
      .map(([k, v]) => `${k}: ${JSON.stringify(v)} → ${JSON.stringify(after.get(k))}`);
    assert.deepEqual(diff, []);
    assert.equal(after.get('number ← "5"'), 5);
    assert.equal(after.get('number ← "abc"'), 400);
    assert.equal(after.get('uuid ← "abc"'), 400);
    assert.equal(after.get('dateTime ← ""'), null, 'leeres Datumsfeld wie bisher null');
    assert.equal(after.get('string ← ["x"]'), 'x');
  });

  test('Schema: anyOf [{ const: null }, X, { type: null }], Angaben von X bleiben', () => {
    for (const s of [Type.Number({ minimum: 1, description: 'd' }), ...Object.values(TYPES), Type.Ref('X')]) {
      assert.deepEqual(JSON.parse(JSON.stringify(Nullable(s))), { anyOf: [{ const: null }, JSON.parse(JSON.stringify(s)), { type: 'null' }] });
    }
  });
});

/** AJV ohne Umwandlung mit den Formaten von Fastify (aus dessen Installation), zum Vergleich mit TypeBox. */
const fromFastify = createRequire(createRequire(import.meta.url).resolve('fastify'));
const ajvCompiler = createRequire(fromFastify.resolve('@fastify/ajv-compiler'));
const AjvClass = ajvCompiler('ajv').default as new (o: object) => { compile(s: object): (v: unknown) => boolean };
const ajv = new AjvClass({ strict: false });
ajvCompiler('ajv-formats').default(ajv);

describe('Nullable mit Value.Check, Value.Errors und TypeCompiler von TypeBox', () => {
  // Formate wie AJV (TypeBox kennt ohne Eintrag keine); DateTime ist `Unsafe` und für Value ohnehin nicht prüfbar
  before(() => {
    if (!FormatRegistry.Has('uuid')) FormatRegistry.Set('uuid', v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  });
  const VALUE_TYPES = Object.entries(TYPES).filter(([k]) => k !== 'dateTime');

  test('gleiches Ergebnis wie AJV (ohne Umwandlung) und wie anyOf [X, null] für alle Feldtypen und Eingaben', () => {
    const diff: string[] = [];
    for (const [field, s] of VALUE_TYPES) {
      const schema = Nullable(s);
      const compiled = TypeCompiler.Compile(schema);
      const viaAjv = ajv.compile(JSON.parse(JSON.stringify(schema)));
      for (const input of INPUTS) {
        const check = Value.Check(schema, input);
        const errors = [...Value.Errors(schema, input)].length === 0;
        const expected = { old: Value.Check(Type.Union([s, Type.Null()]), input), ajv: viaAjv(input) };
        if (check !== expected.old || check !== expected.ajv || errors !== check || compiled.Check(input) !== check) {
          diff.push(`${field} ← ${JSON.stringify(input)}: Check ${check}, Errors leer ${errors}, Compiler ${compiled.Check(input)}, bisher ${expected.old}, AJV ${expected.ajv}`);
        }
      }
    }
    assert.deepEqual(diff, []);
    assert.equal(Value.Check(Nullable(Type.Number()), null), true);
    assert.equal(Value.Check(Nullable(Type.Number()), 0), true);
    assert.equal(Value.Check(Nullable(Type.Number()), 'x'), false);
  });
});
