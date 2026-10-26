/**
 * Plattform einer App: `definePlatform` bindet Kontext (Produkt, Schema, Titel), Modell und Ressourcen an die
 * Bausteine, die Module brauchen (Audit, Ereignisse, Jobs, volle Sicht, Verschlüsselung). Die Module importieren die
 * gebundenen Funktionen aus der Datei der App, die `definePlatform` aufruft (z. B. `src/platform.ts`):
 *
 *   export const platform = definePlatform({ product: 'nachtschicht', title: 'Nachtschicht', model, resources });
 *   export const { record, enqueue, emit, fullTx, seal, unseal } = platform;
 *
 * Die Kompositionswurzel baut daraus mit `defineApp` die Prozesse (api.ts).
 */
import type { Model, ResourceModel } from '@vollholz/iam';
import { fullTxOf, type FullTx } from './authz/view.ts';
import { platformContext, type ContextSpec, type PlatformContext } from './context.ts';
import { auditPort, type Actor, type AuditPort } from './core/audit.ts';
import { createSealer, type Sealer } from './core/crypto.ts';
import { emit, type EventType } from './core/events.ts';
import type { Tx } from './db/pool.ts';
import { record, type RecordEntry } from './http/route-kit.ts';
import { enqueue } from './worker/queue.ts';

export interface PlatformSpec<P extends string = string, S = unknown> extends ContextSpec {
  model: Model<P>;
  /** Ressourcen der App (Kette, Existenz, Klassifizierung); ohne: Typen direkt unter der Organisation. */
  resources?: ResourceModel<S> | null;
}

export interface Platform<P extends string = string, S = unknown> extends Sealer {
  readonly context: PlatformContext;
  readonly model: Model<P>;
  readonly resources: ResourceModel<S> | null;
  readonly audit: AuditPort;
  /** Transaktion im Mandanten mit voller Sicht und ohne Person (Worker, Jobs, Systemaufgaben). */
  readonly fullTx: FullTx;
  /** Ereignis in die Outbox (in der fachlichen Transaktion). */
  emit(tx: Tx, type: EventType, subject: string | null, data: Record<string, unknown>, correlationId?: string | null): Promise<string>;
  /** Job einreihen (in der fachlichen Transaktion); mit `dedupeKey` höchstens ein offener Auftrag je Schlüssel. */
  enqueue(tx: Tx, kind: string, payload?: Record<string, unknown>, o?: { runAt?: Date; dedupeKey?: string }): Promise<string | null>;
  /** Audit und optional Ereignis in derselben Transaktion wie die Änderung. */
  record(tx: Tx, who: Actor, e: RecordEntry): Promise<void>;
}

export function definePlatform<P extends string, S = unknown>(spec: PlatformSpec<P, S>): Platform<P, S> {
  const context = platformContext(spec);
  const audit = auditPort(context);
  const sealer = createSealer(context);
  return Object.freeze({
    context, model: spec.model, resources: spec.resources ?? null, audit,
    fullTx: fullTxOf(spec.model),
    ...sealer,
    emit: (tx, type, subject, data, correlationId = null) => emit(context, tx, type, subject, data, correlationId),
    enqueue: (tx, kind, payload = {}, o = {}) => enqueue(context, tx, kind, payload, o),
    record: (tx, who, e) => record(context, audit, tx, who, e),
  } satisfies Platform<P, S>);
}
