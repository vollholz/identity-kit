/**
 * Routen der Notizen – das Muster für alle Module (app-boilerplate 5.5, 5.7): Rechte über `req.need`, Lesesicht
 * über `req.tx`, Fähigkeiten `can`, Cursor, ETag/If-Match (412), Idempotenz (Querschnitt), Audit und Ereignis in
 * derselben Transaktion, Folgearbeit als Job.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import {
  invalid, notFound, preconditionFailed, type Deps,
  actorOf, decodeCursor, encodeCursor, etag, IdempotencyHeaders, IdParams, IfMatchHeaders, requireIfMatch,
} from '../../../src/index.ts';
import { enqueue, record } from '../platform.ts';
import { ListQuery, Notiz, NotizCreate, NotizHistory, NotizList, NotizPatch, NotizVersion, type NotizOut } from './schemas.ts';
import * as store from './store.ts';
import { PRUEF_JOB } from './jobs.ts';

const TAG = 'Notizen';
const ref = (id: string) => ({ type: 'notiz', id });

function out(r: store.Row, can: Record<string, boolean>): NotizOut {
  return {
    id: r.id, label: r.label, beginn: r.beginn, ende: r.ende, classification: r.classification, version: r.version,
    createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
    can: { write: !!can.write, delete: !!can.delete },
  };
}

/** Beginn und Ende nur gemeinsam (wie der CHECK der Tabelle), sonst 422 statt eines Datenbankfehlers. */
function checkPair(beginn: string | null | undefined, ende: string | null | undefined): void {
  if ((beginn ?? null) === null !== ((ende ?? null) === null)) {
    throw invalid('Beginn und Ende nur gemeinsam angeben oder beide leer lassen.', [{ path: (beginn ?? null) === null ? '/beginn' : '/ende', message: 'fehlt' }]);
  }
}

/** Daten für Audit und Ereignis (ohne Fähigkeiten). */
const snapshot = (r: store.Row) => ({ id: r.id, label: r.label, beginn: r.beginn, ende: r.ende, classification: r.classification, version: r.version });

export function registerRoutes(app: FastifyInstance, _deps: Deps): void {
  for (const s of [Notiz, NotizList, NotizVersion, NotizHistory, NotizCreate, NotizPatch]) app.addSchema(s);

  app.get('/v1/notizen', {
    schema: { tags: [TAG], summary: 'Notizen auflisten', description: 'Sortiert nach Name, Cursor-Paginierung, Suche im Namen.', querystring: ListQuery, response: { 200: Type.Ref('NotizList') } },
  }, async req => {
    await req.needSomewhere('notiz:read');
    const q = req.query as { q?: string; cursor?: string; limit?: number };
    const limit = q.limit ?? 50;
    const after = decodeCursor<{ l: string; i: string; q: string }>(q.cursor, v => typeof v.l === 'string' && typeof v.i === 'string' && v.q === (q.q ?? ''));
    const rows = await req.tx(tx => store.list(tx, { q: q.q, after: after && { label: after.l, id: after.i }, limit }));
    const page = rows.slice(0, limit);
    const can = await req.capabilities(page.map(r => ref(r.id)));
    const last = page[page.length - 1];
    return { items: page.map(r => out(r, can('notiz', r.id))), nextCursor: rows.length > limit && last ? encodeCursor({ l: last.label, i: last.id, q: q.q ?? '' }) : null };
  });

  app.get('/v1/notizen/:id', {
    schema: { tags: [TAG], summary: 'Notiz lesen', params: IdParams, response: { 200: Type.Ref('Notiz') } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await req.need('notiz:read', ref(id));
    const row = await req.tx(tx => store.get(tx, id));
    if (!row) throw notFound('Notiz');
    const can = await req.capabilities([ref(id)]);
    reply.header('etag', etag(row.version));
    return out(row, can('notiz', id));
  });

  app.post('/v1/notizen', {
    schema: { tags: [TAG], summary: 'Notiz anlegen', headers: IdempotencyHeaders, body: Type.Ref('NotizCreate'), response: { 201: Type.Ref('Notiz') } },
  }, async (req, reply) => {
    await req.need('notiz:write');
    const body = req.body as typeof NotizCreate.static;
    checkPair(body.beginn, body.ende);
    const who = actorOf(req);
    const row = await req.tx(async tx => {
      const r = await store.create(tx, body);
      await record(tx, who, { action: 'notiz.created', resourceType: 'notiz', resourceId: r.id, data: snapshot(r), event: snapshot(r) });
      await enqueue(tx, PRUEF_JOB, { id: r.id, version: r.version }, { dedupeKey: `${r.id}:${r.version}` });
      return r;
    });
    const can = await req.capabilities([ref(row.id)]);
    return reply.code(201).header('location', `/v1/notizen/${row.id}`).header('etag', etag(row.version)).send(out(row, can('notiz', row.id)));
  });

  app.patch('/v1/notizen/:id', {
    schema: { tags: [TAG], summary: 'Notiz ändern', description: 'Nur mit `If-Match` (ETag der gelesenen Version); bei abweichender Version 412.', params: IdParams, headers: IfMatchHeaders, body: Type.Ref('NotizPatch'), response: { 200: Type.Ref('Notiz') } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const version = requireIfMatch(req);
    await req.need('notiz:write', ref(id));
    const who = actorOf(req);
    const row = await req.tx(async tx => {
      const before = await store.get(tx, id);
      if (!before) throw notFound('Notiz');
      if (before.version !== version) throw preconditionFailed(before.version);
      const patch = req.body as typeof NotizPatch.static;
      checkPair(patch.beginn !== undefined ? patch.beginn : before.beginn, patch.ende !== undefined ? patch.ende : before.ende);
      const r = await store.update(tx, id, version, patch);
      if (!r) throw preconditionFailed(before.version);
      await record(tx, who, { action: 'notiz.updated', resourceType: 'notiz', resourceId: id, data: { before: snapshot(before), after: snapshot(r) }, event: snapshot(r) });
      await enqueue(tx, PRUEF_JOB, { id: r.id, version: r.version }, { dedupeKey: `${r.id}:${r.version}` });
      return r;
    });
    const can = await req.capabilities([ref(id)]);
    reply.header('etag', etag(row.version));
    return out(row, can('notiz', id));
  });

  app.delete('/v1/notizen/:id', {
    schema: { tags: [TAG], summary: 'Notiz löschen', description: 'Nur mit `If-Match`; der Verlauf bleibt erhalten.', params: IdParams, headers: IfMatchHeaders, response: { 204: Type.Null({ description: 'Gelöscht' }) } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const version = requireIfMatch(req);
    await req.need('notiz:delete', ref(id));
    const who = actorOf(req);
    await req.tx(async tx => {
      const before = await store.get(tx, id);
      if (!before) throw notFound('Notiz');
      if (before.version !== version || !(await store.remove(tx, id, version))) throw preconditionFailed(before.version);
      await record(tx, who, { action: 'notiz.deleted', resourceType: 'notiz', resourceId: id, data: snapshot(before), event: { id } });
    });
    return reply.code(204).send();
  });

  app.get('/v1/notizen/:id/history', {
    schema: { tags: [TAG], summary: 'Verlauf einer Notiz', description: 'Alle Versionen, neueste zuerst; auch nach dem Löschen.', params: IdParams, response: { 200: Type.Ref('NotizHistory') } },
  }, async req => {
    const { id } = req.params as { id: string };
    await req.need('notiz:read', ref(id));
    const rows = await req.tx(tx => store.history(tx, id));
    if (!rows.length) throw notFound('Notiz');
    return { items: rows.map(v => ({ version: v.version, action: v.action, label: v.label, beginn: v.beginn, ende: v.ende, classification: v.classification, changedAt: v.changed_at, changedBy: v.changed_by })) };
  });
}
