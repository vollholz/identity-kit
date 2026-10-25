/**
 * Audit-Schnittstelle (Entwurf Kap. 5.2). Alle Einträge des IAM laufen über einen
 * `AuditPort`, in derselben Transaktion wie die Änderung; `pgAudit` schreibt in `<schema>.audit_log` (iam_007, Hash-Kette
 * per Trigger) mit dem Mandanten aus dem Kontext der Transaktion.
 */
import type pg from 'pg';
import { schemaName } from './db.ts';

export type Source = 'ui' | 'api' | 'mcp' | 'worker' | 'webhook' | 'system';

export interface AuditEntry {
  action: string;
  resourceType?: string;
  resourceId?: string | null;
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

/** Audit in `<schema>.audit_log`. */
export function pgAudit(o: { schema: string }): AuditPort {
  const table = `${schemaName(o.schema)}.audit_log`;
  return {
    async write(tx, who, e) {
      const p = who.principal;
      await tx.query(
        `INSERT INTO ${table} (tenant_id, actor_kind, actor_id, actor_name, client_id, source, action, resource_type, resource_id, correlation_id, data)
         VALUES (app.tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [p?.kind ?? 'system', p?.principalId ?? null, p?.name ?? null, p?.clientId ?? null, who.source, e.action, e.resourceType ?? null, e.resourceId ?? null, who.correlationId ?? null, JSON.stringify(e.data ?? {})],
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
