/**
 * `Nullable` mit den AJV-Optionen von Fastify (`coerceTypes: 'array'`, auch in der Plattform) und mit TypeBox:
 * `Nullable(X)` = X (mit dessen Umwandlung und Ablehnung) und zusätzlich null.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { before, describe, test } from 'node:test';
import { FormatRegistry, Kind } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import { Type, type TSchema } from '@sinclair/typebox';
import Fastify from 'fastify';
import { DateTime, Nullable, Uuid } from '../src/http/routes.ts';

const TYPES: Record<string, TSchema> = {
  number: Type.Number(), integer: Type.Integer(), string: Type.String(), boolean: Type.Boolean(), array: Type.Array(Type.String()),
  dateTime: DateTime, uuid: Uuid, object: Type.Object({ a: Type.Number() }, { additionalProperties: false }),
};
const INPUTS: unknown[] = [null, 0, 1, '', '0', '5', 'abc', false, true, 'true', [], ['x'], 'x', { a: 1 }, '2026-10-28T00:00:00Z', '00000000-0000-4000-8000-000000000000'];

/** Ergebnis je Feld und Eingabe: Wert nach der Prüfung (Anfrage und Antwort) oder Status. */
async function results(nullable: (s: TSchema) => TSchema): Promise<Map<string, unknown>> {
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true } } });
  const Body = Type.Object(Object.fromEntries(Object.entries(TYPES).map(([k, s]) => [k, Type.Optional(nullable(s))])), { additionalProperties: false });
  app.patch('/x', { schema: { body: Body, response: { 200: Body } } }, async req => req.body);
  const out = new Map<string, unknown>();
  for (const field of Object.keys(TYPES)) for (const input of INPUTS) {
    const r = await app.inject({ method: 'PATCH', url: '/x', payload: { [field]: input } });
    out.set(`${field} ← ${JSON.stringify(input)}`, r.statusCode === 200 ? r.json()[field] : r.statusCode);
  }
  await app.close();
  return out;
}

describe('Nullable', () => {
  test('null bleibt null, 0, "" und false bleiben', async () => {
    const r = await results(Nullable);
    for (const field of Object.keys(TYPES)) assert.equal(r.get(`${field} ← null`), null, field);
    assert.equal(r.get('number ← 0'), 0);
    assert.equal(r.get('integer ← 0'), 0);
    assert.equal(r.get('string ← ""'), '');
    assert.equal(r.get('boolean ← false'), false);
  });

  test('Nullable(X) = X und zusätzlich null; Fehler der früheren Formen (bis 5.0.0: null → 0, bis 5.0.2: ungültig → null)', async () => {
    const v500 = await results(s => Type.Union([s, Type.Null()]));
    assert.deepEqual([v500.get('number ← null'), v500.get('string ← null')], [0, ''], 'bis 5.0.0');
    const v502 = await results(s => Type.Union([Type.Unsafe({ [Kind]: 'NullExakt', const: null }), s, Type.Null()]));
    assert.deepEqual([v502.get('number ← ""'), v502.get('object ← ""'), v502.get('uuid ← ""')], [null, null, null], 'bis 5.0.2');
    const plain = await results(s => s);
    const after = await results(Nullable);
    const diff = [...plain].filter(([k, v]) => JSON.stringify(after.get(k)) !== JSON.stringify(k.endsWith('← null') ? null : v))
      .map(([k, v]) => `${k}: ${JSON.stringify(v)} → ${JSON.stringify(after.get(k))}`);
    assert.deepEqual(diff, []);
    assert.deepEqual([after.get('number ← ""'), after.get('object ← ""'), after.get('uuid ← ""')], [400, 400, 400]);
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
