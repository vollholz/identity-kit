/**
 * Verteilung der Outbox: Der Worker liest unverteilte Ereignisse über alle Mandanten (Rolle _sched),
 * übergibt sie den Abnehmern der Module (z. B. Webhooks) und markiert sie als verteilt – in einer Transaktion, damit
 * kein Ereignis verloren geht oder doppelt verteilt wird.
 *
 * Abnehmer mit Produktmodul (`modul`): Ereignisse einer Organisation, in der das Modul nicht aktiv ist, erhält der
 * Abnehmer nicht; sie gelten trotzdem als verteilt (die Outbox wächst nicht).
 */
import type { Model } from '@vollholz/iam';
import type { Tx } from '../db/pool.ts';
import { metrics } from '../ops/metrics.ts';
import { activeModulesOf } from './modules.ts';
import type { PeriodicTask } from './queue.ts';

export interface OutboxEvent {
  tenant_id: string; tenant_alias: string; id: string; type: string; subject: string | null; data: Record<string, unknown>; created_at: Date; correlation_id: string | null;
}

/** Abnehmer von Ereignissen; läuft in der Transaktion der Verteilung (Rolle _sched, ohne Mandantenkontext). */
export interface OutboxConsumer {
  name: string;
  /** Produktmodul oder `modul.teil` (Standard: das Modul des Code-Moduls); nur Ereignisse von Organisationen, in denen es aktiv ist. */
  modul?: string;
  accept(tx: Tx, events: OutboxEvent[]): Promise<void>;
}

const BATCH = 200;

/** @param model Modell der App: mit `modules` erhalten Abnehmer mit `modul` nur Ereignisse aktiver Organisationen. */
export function outboxTask(consumers: readonly OutboxConsumer[], model?: Pick<Model, 'features' | 'modules' | 'activeModules'> | null): PeriodicTask {
  const byModule = !!model?.features.modules && consumers.some(c => c.modul);
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
            const active = new Map<string, ReadonlySet<string>>();
            if (byModule) for (const id of new Set(events.map(e => e.tenant_id))) active.set(id, await activeModulesOf(c, platform, model!, id));
            for (const consumer of consumers) {
              const mine = byModule && consumer.modul ? events.filter(e => active.get(e.tenant_id)!.has(consumer.modul!)) : events;
              if (mine.length) await consumer.accept(c, mine);
            }
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
