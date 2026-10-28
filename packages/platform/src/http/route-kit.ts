/**
 * Bausteine für Routen aller Module (app-boilerplate 5.5): Schemas, Cursor, ETag/If-Match, Handelnder. Audit mit
 * Ereignis in derselben Transaktion: `platform.record`.
 */
import { Kind, Type, TypeRegistry, type TSchema } from '@sinclair/typebox';
import { decodeCursor, encodeCursor, etag, ifMatchVersion } from '@vollholz/iam';
import type { FastifyRequest } from 'fastify';
import type { Actor, AuditPort } from '../core/audit.ts';
import { preconditionRequired } from '../core/errors.ts';
import { emit, type EventType } from '../core/events.ts';
import type { PlatformContext } from '../context.ts';
import type { Tx } from '../db/pool.ts';

export { decodeCursor, encodeCursor, etag };

export const Uuid = Type.String({ format: 'uuid' });
export const DateTime = Type.Unsafe<string | Date>({ type: 'string', format: 'date-time' });
/**
 * Genau null, ohne Umwandlung durch AJV (`const` wandelt nicht um, `type: 'null'` schon: 0, "" und false → null). Eigene
 * Kind `NullExakt` in der TypeRegistry: `Value.Check`, `Value.Errors` und der TypeCompiler von TypeBox prüfen `=== null`
 * (dieselbe Kopie von TypeBox wie dieses Paket), AJV liest nur `const`.
 */
TypeRegistry.Set('NullExakt', (_s, v) => v === null);
const ExactlyNull = Type.Unsafe<null>({ [Kind]: 'NullExakt', const: null });
/**
 * Wert oder `null`: `anyOf [null (genau), X]`, also X und zusätzlich `null`. Mit `coerceTypes` (Fastify) wandelt
 * nur X um; was X ablehnt, ergibt 400. Bis 0.6.3 machte ein Zweig `{ type: 'null' }` auch ungültige Eingaben
 * (0, "", false) zu null, davor `anyOf [X, null]` null zu 0, "" oder false. Leere Formularfelder: `EmptyAsNull`.
 * Gleich wie in @vollholz/iam.
 */
export const Nullable = <T extends TSchema>(s: T) => Type.Union([ExactlyNull, s]);
/**
 * Genau "", als `null` weitergegeben: AJV prüft `const ""`, dann wandelt `type: 'null'` "" in null (andere Werte scheitern
 * schon an `const`). Ohne Umwandlung (TypeBox `Value`, AJV ohne `coerceTypes`) trifft der Zweig nie zu.
 */
TypeRegistry.Set('LeerAlsNull', () => false);
const EmptyToNull = Type.Unsafe<null>({ [Kind]: 'LeerAlsNull', allOf: [{ const: '' }, { type: 'null' }] });
/**
 * Wie `Nullable`, dazu "" als `null` (leere Felder aus Formularen, z. B. Datum). Nur "", nicht 0 oder false.
 * `Value.Check` von TypeBox wandelt nicht um und lehnt "" ab.
 */
export const EmptyAsNull = <T extends TSchema>(s: T) => Type.Union([ExactlyNull, s, EmptyToNull]);

/** Zweig von `EmptyAsNull` in der OpenAPI (nach @fastify/swagger: `const` als `enum`). */
function isEmptyToNull(n: Record<string, unknown>): boolean {
  const all = n.allOf;
  if (!Array.isArray(all) || all.length !== 2 || Object.keys(n).length !== 1) return false;
  const [a, b] = all as Array<Record<string, unknown>>;
  const empty = a && (a.const === '' || (Array.isArray(a.enum) && a.enum.length === 1 && a.enum[0] === ''));
  return !!empty && Object.keys(a).length === 1 && b?.type === 'null' && Object.keys(b).length === 1;
}
/**
 * OpenAPI: Zweig von `EmptyAsNull` als gültige Eingabe "" beschreiben. Im Schema ist er `allOf [{ const: "" }, { type:
 * null }]` (AJV wandelt "" in null), das kein Wert erfüllt; Validatoren und Clients nach der Doku lehnten "" sonst ab.
 * Für `transformObject` von @fastify/swagger (nach `optionalBodies`).
 */
export function emptyAsNullDocs<T>(doc: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const n = v as Record<string, unknown>;
    if (isEmptyToNull(n)) return { enum: [''], description: 'Leer (""), gilt als `null`.' };
    for (const k of Object.keys(n)) n[k] = walk(n[k]);
    return n;
  };
  return walk(doc) as T;
}
export const IdParams = Type.Object({ id: Uuid }, { additionalProperties: false });
export const Limit = Type.Integer({ minimum: 1, maximum: 200, default: 50, description: 'Seitengrösse (höchstens 200).' });
export const Cursor = Type.String({ maxLength: 512, description: 'Opaker Cursor aus `nextCursor` der vorherigen Seite.' });
export const NextCursor = Nullable(Type.String({ description: 'Cursor der nächsten Seite; `null` auf der letzten Seite.' }));
export const IfMatchHeaders = Type.Object({ 'if-match': Type.Optional(Type.String({ description: 'ETag der gelesenen Version (Pflicht).' })) });
export const IdempotencyHeaders = Type.Object({ 'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 255, description: 'Schlüssel für sichere Wiederholung (empfohlen).' })) });

/** Version aus `If-Match` (Pflicht; 428 ohne, 412 bei falschem Format). */
export function requireIfMatch(req: FastifyRequest): number {
  const v = ifMatchVersion(req.headers['if-match']);
  if (v === undefined) throw preconditionRequired();
  return v;
}

/** Handelnder der Anfrage für Audit und Ereignisse. */
export function actorOf(req: FastifyRequest): Actor {
  const p = req.requirePrincipal();
  return { principal: { kind: p.kind, principalId: p.principalId, name: p.name, clientId: p.clientId }, source: req.source, correlationId: req.id };
}

/** Eintrag für `record`: Aktion, betroffene Ressource, Daten des Audits und optional das Ereignis. */
export interface RecordEntry {
  action: EventType; resourceType: string; resourceId: string; data?: Record<string, unknown>; event?: Record<string, unknown>;
}

/**
 * Änderung festhalten: Audit-Eintrag (Hash-Kette) und, falls `event` angegeben, Ereignis in der Outbox – beides in
 * derselben Transaktion wie die Änderung. Gebunden an die App als `platform.record`.
 */
export async function record(ctx: PlatformContext, audit: AuditPort, tx: Tx, who: Actor, e: RecordEntry): Promise<void> {
  await audit.write(tx, who, { action: e.action, resourceType: e.resourceType, resourceId: e.resourceId, ...(e.data ? { data: e.data } : {}) });
  if (e.event) await emit(ctx, tx, e.action, `${e.resourceType}/${e.resourceId}`, e.event, who.correlationId ?? null);
}
