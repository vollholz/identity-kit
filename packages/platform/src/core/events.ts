/**
 * Ereignisse: `emit` schreibt in derselben Transaktion wie die Änderung in `outbox_event`; der Worker verteilt sie
 * danach an die Abnehmer der Module (z. B. Webhooks als CloudEvents 1.0). Was nicht committet wird, wird nie
 * verschickt.
 */
import type { PlatformContext } from '../context.ts';
import type { Tx } from '../db/pool.ts';

/** Ereignistyp `<ding>.<was>` (z. B. `schichtart.created`). */
export type EventType = `${string}.${string}`;

export async function emit(ctx: PlatformContext, tx: Tx, type: EventType, subject: string | null, data: Record<string, unknown>, correlationId: string | null = null): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO ${ctx.schema}.outbox_event (tenant_id, type, subject, data, correlation_id) VALUES (app.tenant_id(), $1, $2, $3, $4) RETURNING id`,
    [type, subject, JSON.stringify(data), correlationId]);
  return r.rows[0]!.id;
}

/** Ereignis als CloudEvent 1.0 (JSON-Format). */
export interface CloudEvent {
  specversion: '1.0'; id: string; source: string; type: string; subject?: string; time: string; datacontenttype: 'application/json';
  data: Record<string, unknown>;
}

/** CloudEvent zu einem Ereignis; `type` mit dem Präfix der App (`ch.nachtschicht.schichtart.created`). */
export function toCloudEvent(ctx: Pick<PlatformContext, 'eventPrefix'>, row: { id: string; type: string; subject: string | null; data: Record<string, unknown>; created_at: Date; tenant_alias: string }, publicBaseUrl: string): CloudEvent {
  return {
    specversion: '1.0', id: row.id, source: `${publicBaseUrl}/organisationen/${row.tenant_alias}`, type: `${ctx.eventPrefix}.${row.type}`,
    ...(row.subject ? { subject: row.subject } : {}), time: row.created_at.toISOString(), datacontenttype: 'application/json', data: row.data,
  };
}
