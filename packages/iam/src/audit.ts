/**
 * Audit-Schnittstelle (Entwurf Kap. 5.2). Alle Einträge des IAM laufen über einen
 * `AuditPort`, in derselben Transaktion wie die Änderung; `pgAudit` schreibt in `<schema>.audit_log` (iam_007, Hash-Kette
 * per Trigger) mit dem Mandanten aus dem Kontext der Transaktion. Lesen: `pgAuditSearch` (iam_021).
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { schemaName } from './db.ts';
import { invalid } from './errors.ts';
import { decodeCursor, encodeCursor } from './http/routes.ts';

export type Source = 'ui' | 'api' | 'mcp' | 'worker' | 'webhook' | 'system';

export interface AuditEntry {
  action: string;
  resourceType?: string;
  resourceId?: string | null;
  /**
   * Betroffene Person (iam_021, Spalte `subject_id`): Kennung nach Wahl der App, z. B. die ID einer Person; höchstens
   * 200 Zeichen. Ohne Angabe wie bisher (der Eintrag hashet unverändert, Version 2 der Kette).
   */
  subject?: string | null;
  data?: Record<string, unknown>;
}

/** Wer handelt: der Principal (oder niemand, z. B. Worker), Quelle und Korrelation (Request-ID, Job). */
export interface Actor {
  principal: { kind: 'user' | 'client'; principalId: string; name: string; clientId: string | null } | null;
  source: Source;
  correlationId?: string | null;
}

export interface AuditPort {
  write(tx: pg.ClientBase, who: Actor, e: AuditEntry): Promise<void>;
}

const SUBJECT_MAX = 200;

/** Audit in `<schema>.audit_log`. */
export function pgAudit(o: { schema: string }): AuditPort {
  const table = `${schemaName(o.schema)}.audit_log`;
  return {
    async write(tx, who, e) {
      const p = who.principal;
      const params: unknown[] = [p?.kind ?? 'system', p?.principalId ?? null, p?.name ?? null, p?.clientId ?? null, who.source, e.action, e.resourceType ?? null, e.resourceId ?? null, who.correlationId ?? null, JSON.stringify(e.data ?? {})];
      // subject_id nur mit Person: Aufrufe ohne `subject` laufen so auch vor der Migration iam_021
      const subject = e.subject ?? null;
      if (subject !== null) {
        if (typeof subject !== 'string' || subject === '' || subject.length > SUBJECT_MAX) throw new TypeError(`Audit: subject muss 1–${SUBJECT_MAX} Zeichen haben`);
        params.push(subject);
      }
      await tx.query(
        `INSERT INTO ${table} (tenant_id, actor_kind, actor_id, actor_name, client_id, source, action, resource_type, resource_id, correlation_id, data${subject !== null ? ', subject_id' : ''})
         VALUES (app.tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10${subject !== null ? ', $11' : ''})`,
        params,
      );
    },
  };
}

/** Eintrag im Protokoll der Plattform (iam_017): `orgId` = betroffener Mandant, falls einer. */
export interface PlatformAuditEntry extends AuditEntry { orgId?: string | null }

/**
 * Protokoll der Plattform (Konto, Plattform-Administration; Spezifikation Kap. 6.3, eine Hash-Kette über alle
 * Mandanten). Nur anhängen über `app.platform_audit()`. `org: 'current'` nimmt den Mandanten der Transaktion.
 */
export async function writePlatformAudit(q: Pick<pg.ClientBase, 'query'>, who: Actor, e: PlatformAuditEntry & { org?: 'current' }): Promise<void> {
  const p = who.principal;
  await q.query(
    `SELECT app.platform_audit($1, $2, $3, $4, $5, $6, $7, ${e.org === 'current' ? 'coalesce($8::uuid, app.tenant_id())' : '$8::uuid'}, $9, $10)`,
    [p?.kind ?? 'system', p?.principalId ?? null, p?.name ?? null, who.source, e.action, e.resourceType ?? null, e.resourceId ?? null, e.org === 'current' ? null : e.orgId ?? null, who.correlationId ?? null, JSON.stringify(e.data ?? {})],
  );
}

/**
 * Hülle um den Audit-Port der App: Einträge der Plattform-Administration (`data.platformAdmin`) stehen zusätzlich, in
 * derselben Transaktion, im Protokoll der Plattform. So sieht die Organisation, was die Plattform an ihr getan hat, und
 * die Plattform hat ihr vollständiges Protokoll an einem Ort.
 */
export function withPlatformAudit(inner: AuditPort): AuditPort {
  return {
    async write(tx, who, e) {
      await inner.write(tx, who, e);
      if (e.data?.platformAdmin === true) await writePlatformAudit(tx, who, { ...e, org: 'current' });
    },
  };
}

/**
 * Rückfall der Suche nach Person für Einträge ohne `subject_id` (vor iam_021 oder ohne Angabe): die Kennung in einem
 * Feld von `data` (`dataKeys`, z. B. `personId`) oder als Objekt (`resourceTypes`, z. B. `person`, dann
 * `resource_id` = Kennung). Je App festgelegt; das Paket kennt die Namen der App nicht.
 */
export interface AuditSubjectFallback {
  dataKeys?: readonly string[];
  resourceTypes?: readonly string[];
}

/** Filter der Suche; `from` (einschliesslich) bis `to` (ausschliesslich) ist Pflicht. */
export interface AuditQuery {
  /** Betroffene Person (`subject_id`, mit Rückfall). */
  subject?: string;
  resourceType?: string;
  /** Kennung des Objekts (UUID). */
  resourceId?: string;
  /** Handelnde Person oder Client (`principalId`, UUID). */
  actor?: string;
  from: Date | string;
  to: Date | string;
  /** `nextCursor` der vorherigen Seite. */
  cursor?: string | null;
  /** Seitengrösse 1–200, Standard 50. */
  limit?: number;
  /** Reihenfolge nach (ts, seq): `desc` (Standard, neueste zuerst) oder `asc`. */
  order?: 'asc' | 'desc';
}

export interface AuditRecord {
  seq: number;
  ts: Date;
  actor: { kind: string; id: string | null; name: string | null; clientId: string | null };
  source: Source;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  /** `subject_id`; null bei Einträgen ohne Person, auch wenn der Rückfall sie gefunden hat. */
  subject: string | null;
  correlationId: string | null;
  data: Record<string, unknown>;
}

export interface AuditPage { items: AuditRecord[]; nextCursor: string | null }

export type AuditSearch = (tx: Pick<pg.ClientBase, 'query'>, q: AuditQuery) => Promise<AuditPage>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function instant(v: Date | string, name: string): Date {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw invalid(`${name}: kein gültiger Zeitpunkt.`);
  return d;
}

/**
 * Suche im Audit des Mandanten der Transaktion (iam_021): Filter nach Person, Objekt, Akteur und Zeitraum, Seiten über
 * (ts, seq) mit opakem Cursor. Rechte prüft die Route (und, falls gewählt, die Policy `audit_read`); die Suche selbst
 * liefert, was die Transaktion sehen darf. Ungültige Eingaben (keine UUID, leerer Zeitraum, Cursor einer anderen
 * Abfrage) → 422.
 *
 *   const search = pgAuditSearch({ schema: 'notes', subjectFallback: { dataKeys: ['personId'] } });
 *   const page = await search(tx, { subject: id, from, to, cursor });
 */
export function pgAuditSearch(o: { schema: string; subjectFallback?: AuditSubjectFallback }): AuditSearch {
  const table = `${schemaName(o.schema)}.audit_log`;
  const dataKeys = [...(o.subjectFallback?.dataKeys ?? [])];
  const resourceTypes = [...(o.subjectFallback?.resourceTypes ?? [])];
  for (const k of dataKeys) if (!DATA_KEY.test(k)) throw new TypeError(`Audit: Feld «${k}» für den Rückfall ungültig`);
  for (const r of resourceTypes) if (typeof r !== 'string' || r === '') throw new TypeError('Audit: Objektart für den Rückfall leer');
  return async (tx, q) => {
    const from = instant(q.from, 'from'), to = instant(q.to, 'to');
    if (from >= to) throw invalid('Zeitraum: from muss vor to liegen.');
    const limit = q.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('limit: 1 bis 200.');
    const order = q.order ?? 'desc';
    if (order !== 'asc' && order !== 'desc') throw invalid('order: asc oder desc.');
    for (const [k, v] of [['resourceId', q.resourceId], ['actor', q.actor]] as const) if (v !== undefined && !UUID.test(v)) throw invalid(`${k}: keine UUID.`);
    if (q.subject !== undefined && (q.subject === '' || q.subject.length > SUBJECT_MAX)) throw invalid(`subject: 1–${SUBJECT_MAX} Zeichen.`);

    // Fingerabdruck der Abfrage: Ein Cursor gilt nur für dieselben Filter und dieselbe Reihenfolge
    const filters = [q.subject ?? null, q.resourceType ?? null, q.resourceId?.toLowerCase() ?? null, q.actor?.toLowerCase() ?? null, from.toISOString(), to.toISOString(), order];
    const fp = createHash('sha256').update(JSON.stringify(filters)).digest('base64url').slice(0, 16);
    const cursor = decodeCursor<{ ts: string; seq: number; fp: string }>(q.cursor ?? undefined,
      v => v.fp === fp && typeof v.ts === 'string' && !Number.isNaN(Date.parse(v.ts)) && Number.isSafeInteger(v.seq));

    const params: unknown[] = [from, to];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = ['tenant_id = app.tenant_id()', 'ts >= $1', 'ts < $2'];
    if (q.subject !== undefined) {
      const s = p(q.subject);
      const fallback = [
        ...dataKeys.map(k => `data->>${p(k)} = ${s}`),
        // eigener Parameter: derselbe als text und uuid ergäbe widersprüchliche Typen
        ...(UUID.test(q.subject) ? resourceTypes.map(r => `(resource_type = ${p(r)} AND resource_id = ${p(q.subject)}::uuid)`) : []),
      ];
      where.push(fallback.length ? `(subject_id = ${s} OR (subject_id IS NULL AND (${fallback.join(' OR ')})))` : `subject_id = ${s}`);
    }
    if (q.resourceType !== undefined) where.push(`resource_type = ${p(q.resourceType)}`);
    if (q.resourceId !== undefined) where.push(`resource_id = ${p(q.resourceId)}::uuid`);
    if (q.actor !== undefined) where.push(`actor_id = ${p(q.actor)}::uuid`);
    if (cursor) where.push(`(ts, seq) ${order === 'desc' ? '<' : '>'} (${p(cursor.ts)}::timestamptz, ${p(cursor.seq)}::bigint)`);
    const dir = order === 'desc' ? 'DESC' : 'ASC';
    const rows = (await tx.query<{
      seq: string; ts: Date; tkey: string; actor_kind: string; actor_id: string | null; actor_name: string | null; client_id: string | null; source: Source;
      action: string; resource_type: string | null; resource_id: string | null; subject_id: string | null; correlation_id: string | null; data: Record<string, unknown>;
    }>(
      `SELECT seq, ts, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS tkey, actor_kind, actor_id, actor_name, client_id, source,
              action, resource_type, resource_id, subject_id, correlation_id, data
         FROM ${table} WHERE ${where.join(' AND ')}
        ORDER BY ts ${dir}, seq ${dir} LIMIT ${p(limit + 1)}`, params)).rows;
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map(r => ({
        seq: Number(r.seq), ts: r.ts, actor: { kind: r.actor_kind, id: r.actor_id, name: r.actor_name, clientId: r.client_id }, source: r.source,
        action: r.action, resourceType: r.resource_type, resourceId: r.resource_id, subject: r.subject_id, correlationId: r.correlation_id, data: r.data,
      })),
      nextCursor: more && last ? encodeCursor({ ts: last.tkey, seq: Number(last.seq), fp }) : null,
    };
  };
}
