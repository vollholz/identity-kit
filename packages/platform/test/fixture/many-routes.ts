/** Anwendung mit vielen Routen und vielen gemeinsamen Schemas (Startzeit der Serialisierer, `serializer.test.ts`). */
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

/** Gemeinsames Schema `Thing<i>` (verschachtelt, mit Verweisen auf `Owner` und `Problem`). */
function shared(i: number) {
  return Type.Object({
    id: Type.String({ format: 'uuid' }), name: Type.String(), count: Type.Integer(), active: Type.Boolean(),
    tags: Type.Array(Type.String()), createdAt: Type.String({ format: 'date-time' }),
    owner: Type.Object({ id: Type.String(), email: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false }),
    meta: Type.Object({ a: Type.Number(), b: Type.Optional(Type.String()), c: Type.Array(Type.Object({ k: Type.String(), v: Type.String() })) }),
    createdBy: Type.Optional(Type.Ref('Owner')),
    last: Type.Optional(Type.Ref('Problem')),
  }, { $id: `Thing${i}`, additionalProperties: false });
}

export const Problem = Type.Object({ type: Type.String(), title: Type.String(), status: Type.Integer(), detail: Type.Optional(Type.String()) }, { $id: 'Problem' });

const Owner = Type.Object({ id: Type.String(), name: Type.String() }, { $id: 'Owner', additionalProperties: false });

export async function manyRoutes(o: { schemas: number; routes: number; fastify?: FastifyServerOptions }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ...o.fastify });
  app.addSchema(Problem);
  app.addSchema(Owner);
  for (let i = 0; i < o.schemas; i++) app.addSchema(shared(i));
  const errors = { 400: Type.Ref('Problem'), 403: Type.Ref('Problem'), 404: Type.Ref('Problem') };
  for (let r = 0; r < o.routes; r++) {
    const i = r % o.schemas;
    const item = { id: '00000000-0000-4000-8000-000000000000', name: `n${r}`, count: r, active: true, tags: ['x'], createdAt: '2026-10-28T00:00:00.000Z',
      owner: { id: 'o', email: null, secret: 'weg' }, meta: { a: 1, c: [{ k: 'k', v: 'v' }] }, secret: 'weg' };
    app.get(`/r${r}`, { schema: { response: { 200: Type.Ref(`Thing${i}`), ...errors } } }, async () => item);
    app.get(`/r${r}/list`, { schema: { response: { 200: Type.Object({ items: Type.Array(Type.Ref(`Thing${i}`)), next: Type.Union([Type.String(), Type.Null()]) }), ...errors } } },
      async () => ({ items: [item], next: null, extra: 'weg' }));
  }
  return app;
}
