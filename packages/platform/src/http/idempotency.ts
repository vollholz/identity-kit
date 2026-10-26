/**
 * `Idempotency-Key` für alle schreibenden Aufrufe (app-boilerplate 5.5): Die erste Antwort (ausser 5xx) wird je
 * Principal und Schlüssel gespeichert und bei Wiederholung unverändert geliefert (`Idempotent-Replayed: true`).
 * Gleicher Schlüssel mit anderer Anfrage → 409; noch in Bearbeitung → 409. Aufbewahrung `IDEMPOTENCY_TTL`.
 */
import { createHash } from 'node:crypto';
import { requestPath } from '@vollholz/iam';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { conflict, invalid } from '../core/errors.ts';
import { withTenant, type Db } from '../db/pool.ts';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEEP_HEADERS = ['content-type', 'location', 'etag'];

declare module 'fastify' {
  interface FastifyRequest { idempotency?: { tenantId: string; principalId: string; key: string } }
}

/** Pfad der Anfrage, dekodiert: `/%761/x` und `/v1/x` sind dieselbe Anfrage. */
const pathOf = (req: FastifyRequest) => requestPath(req.url);

/** Query bleibt Teil der Anfrage (andere Query = andere Anfrage). */
const queryOf = (req: FastifyRequest) => (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');

const hashOf = (req: FastifyRequest) => createHash('sha256').update(`${req.method} ${pathOf(req)}${queryOf(req)}\n${req.body === undefined ? '' : JSON.stringify(req.body)}`).digest('hex');

export function registerIdempotency(app: FastifyInstance, o: { db: Db; schema: string; ttlMs: number; prefix?: string }): void {
  const prefix = o.prefix ?? '/v1/';

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.headers['idempotency-key'];
    if (raw === undefined || !WRITE.has(req.method) || ![req.routeOptions.url ?? '', pathOf(req)].some(p => p.startsWith(prefix)) || !req.principal) return;
    const key = Array.isArray(raw) ? raw[0]! : raw;
    if (!key || key.length > 255) throw invalid('Idempotency-Key: 1 bis 255 Zeichen.');
    const p = req.principal;
    const hash = hashOf(req);
    const ctx = { tenantId: p.tenantId, principalId: p.principalId };
    const found = await withTenant(o.db, ctx, async tx => {
      const ins = await tx.query(
        `INSERT INTO ${o.schema}.idempotency_key (tenant_id, principal_id, key, method, path, request_hash, expires_at)
         VALUES (app.tenant_id(), $1, $2, $3, $4, $5, now() + make_interval(secs => $6)) ON CONFLICT DO NOTHING`,
        [p.principalId, key, req.method, pathOf(req), hash, o.ttlMs / 1000]);
      if (ins.rowCount) return null;
      return (await tx.query<{ request_hash: string; status_code: number | null; headers: Record<string, string>; body: string | null; expired: boolean }>(
        `SELECT request_hash, status_code, headers, body, expires_at < now() AS expired FROM ${o.schema}.idempotency_key WHERE principal_id = $1 AND key = $2`,
        [p.principalId, key])).rows[0] ?? null;
    });
    if (!found) { req.idempotency = { ...ctx, key }; return; }
    if (found.expired) {
      // Abgelaufen, aber noch nicht aufgeräumt: wie neu behandeln
      await withTenant(o.db, ctx, tx => tx.query(`DELETE FROM ${o.schema}.idempotency_key WHERE principal_id = $1 AND key = $2`, [p.principalId, key]));
      req.idempotency = { ...ctx, key };
      await withTenant(o.db, ctx, tx => tx.query(
        `INSERT INTO ${o.schema}.idempotency_key (tenant_id, principal_id, key, method, path, request_hash, expires_at)
         VALUES (app.tenant_id(), $1, $2, $3, $4, $5, now() + make_interval(secs => $6))`, [p.principalId, key, req.method, pathOf(req), hash, o.ttlMs / 1000]));
      return;
    }
    if (found.request_hash !== hash) throw conflict('Dieser Idempotency-Key wurde schon für eine andere Anfrage verwendet.', { reason: 'idempotency-key-reused' });
    if (found.status_code === null) throw conflict('Eine Anfrage mit diesem Idempotency-Key ist noch in Bearbeitung.', { reason: 'idempotency-in-progress' });
    for (const [k, v] of Object.entries(found.headers)) reply.header(k, v);
    reply.header('idempotent-replayed', 'true');
    return reply.code(found.status_code).send(found.body ?? undefined);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const idem = req.idempotency;
    if (!idem || reply.getHeader('idempotent-replayed')) return payload;
    req.idempotency = undefined;
    const ctx = { tenantId: idem.tenantId, principalId: idem.principalId };
    if (reply.statusCode >= 500) {
      // Serverfehler nicht festschreiben: eine Wiederholung soll es nochmals versuchen
      await withTenant(o.db, ctx, tx => tx.query(`DELETE FROM ${o.schema}.idempotency_key WHERE principal_id = $1 AND key = $2`, [idem.principalId, idem.key]));
      return payload;
    }
    const headers: Record<string, string> = {};
    for (const h of KEEP_HEADERS) { const v = reply.getHeader(h); if (v !== undefined) headers[h] = String(v); }
    const body = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : null;
    await withTenant(o.db, ctx, tx => tx.query(
      `UPDATE ${o.schema}.idempotency_key SET status_code = $3, headers = $4, body = $5 WHERE principal_id = $1 AND key = $2`,
      [idem.principalId, idem.key, reply.statusCode, JSON.stringify(headers), body]));
    return payload;
  });
}
