/**
 * Verteilung der Outbox: Der Worker liest unverteilte Ereignisse über alle Mandanten (Rolle _sched),
 * übergibt sie den Abnehmern der Module (z. B. Webhooks) und markiert sie als verteilt – in einer Transaktion, damit
 * kein Ereignis verloren geht oder doppelt verteilt wird.
 */
import type { Tx } from '../db/pool.ts';
import { metrics } from '../ops/metrics.ts';
import type { PeriodicTask } from './queue.ts';

export interface OutboxEvent {
  tenant_id: string; tenant_alias: string; id: string; type: string; subject: string | null; data: Record<string, unknown>; created_at: Date; correlation_id: string | null;
}

/** Abnehmer von Ereignissen; läuft in der Transaktion der Verteilung (Rolle _sched, ohne Mandantenkontext). */
export interface OutboxConsumer {
  name: string;
  accept(tx: Tx, events: OutboxEvent[]): Promise<void>;
}

const BATCH = 200;

export function outboxTask(consumers: readonly OutboxConsumer[]): PeriodicTask {
  return {
    name: 'outbox.dispatch',
    intervalMs: () => 2_000,
    async run({ db, platform }) {
      for (;;) {
        const c = await db.connect();
        let n = 0;
        try {
          await c.query('BEGIN');
          const events = (await c.query<OutboxEvent>(
            `SELECT e.tenant_id, t.alias AS tenant_alias, e.id, e.type, e.subject, e.data, e.created_at, e.correlation_id
               FROM ${platform.schema}.outbox_event e JOIN LATERAL (SELECT alias FROM app.platform_tenants() p WHERE p.id = e.tenant_id) t ON true
              WHERE e.dispatched_at IS NULL ORDER BY e.created_at LIMIT $1 FOR UPDATE OF e SKIP LOCKED`, [BATCH])).rows;
          n = events.length;
          if (n) {
            for (const consumer of consumers) await consumer.accept(c, events);
            await c.query(`UPDATE ${platform.schema}.outbox_event SET dispatched_at = now() WHERE (tenant_id, id) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))`,
              [events.map(e => e.tenant_id), events.map(e => e.id)]);
          }
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw e;
        } finally { c.release(); }
        metrics.outboxDispatched(n);
        if (n < BATCH) return;
      }
    },
  };
}
