/**
 * `Nullable` mit den AJV-Optionen von Fastify (`coerceTypes: 'array'`, auch in der Plattform): null bleibt null, 0, ""
 * und false bleiben, alle anderen Eingaben wie bisher. `anyOf [X, null]` machte aus null den Wert von X (0, "", false).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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

  test('alle anderen Eingaben wie mit anyOf [X, null] (bis 5.0.0)', async () => {
    const before = await results(s => Type.Union([s, Type.Null()]));
    assert.equal(before.get('number ← null'), 0, 'Fehler der bisherigen Form');
    assert.equal(before.get('string ← null'), '', 'Fehler der bisherigen Form');
    const after = await results(Nullable);
    const diff = [...before].filter(([k, v]) => !k.endsWith('← null') && JSON.stringify(after.get(k)) !== JSON.stringify(v))
      .map(([k, v]) => `${k}: ${JSON.stringify(v)} → ${JSON.stringify(after.get(k))}`);
    assert.deepEqual(diff, []);
  });
});
