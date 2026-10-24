/**
 * Tupel lesen und schreiben (Spezifikation Kap. 7.4, 9.8): Freigaben «Subjekt hat Relation an Ort». Alle Funktionen
 * laufen in einer Transaktion im Mandantenkontext (RLS); jede Änderung erhöht `acl_version` (Trigger). Die Regeln, wer
 * was vergeben darf, prüfen die Aufrufer (http/access.ts, admin.ts); hier nur Form und Audit.
 *
 * Für die App: `iam.tuples.grant(tx, …)` setzt z. B. `owner` beim Anlegen einer Ressource (A7).
 */
import type { AuditPort, Actor } from './audit.ts';
import { TUPLE_COLS, type Tuple } from './access.ts';
import { schemaName, type Tx } from './db.ts';
import { conflict, invalid } from './errors.ts';
import { ORG, type Model } from './model.ts';
import type { ResourceRef } from './resources.ts';

/** Muster gültiger Subjekte (wie der CHECK in der Datenbank). */
export const SUBJECT_PATTERN = /^((user|client|group):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|org:members)$/;

export interface TupleInput { subject: string; relation: string; place: ResourceRef; expiresAt?: Date | null; createdBy?: string | null }

/** Daten der Audit-Aktionen `access.*` (Kap. 9.8). */
export const accessData = (t: Pick<Tuple, 'subject' | 'relation' | 'object_type' | 'object_id' | 'expires_at'>) =>
  ({ subject: t.subject, relation: t.relation, type: t.object_type, id: t.object_id, expiresAt: t.expires_at ? t.expires_at.toISOString() : null });

export class TupleStore {
  private readonly S: string;
  private readonly model: Model;
  private readonly audit: AuditPort | null;

  constructor(o: { schema: string; model: Model; audit?: AuditPort | null }) {
    this.S = schemaName(o.schema); this.model = o.model; this.audit = o.audit ?? null;
  }

  /** Form prüfen: Subjekt, Relation am Typ (ohne Regeln, wer vergeben darf). */
  check(t: TupleInput) {
    if (!SUBJECT_PATTERN.test(t.subject)) throw invalid('Subjekt ungültig', [{ path: '/subject', message: 'user:<id>, client:<id>, group:<id> oder org:members' }]);
    if (!this.model.types.has(t.place.type as never)) throw invalid('Typ unbekannt', [{ path: '/type', message: `«${t.place.type}» ist kein Typ des Modells` }]);
    if (!this.model.relationsAt(t.place.type).includes(t.relation)) throw invalid('Relation am Typ nicht zulässig', [{ path: '/relation', message: `«${t.relation}» darf an «${t.place.type}» nicht hängen` }]);
    if ((t.place.type === ORG) !== !t.place.id) throw invalid('Ort ungültig', [{ path: '/id', message: 'id leer genau bei org' }]);
    if (t.subject.startsWith('client:') && t.place.type !== ORG) throw invalid('Clients nur an der Organisation', [{ path: '/subject', message: 'Clients erhalten Rollen nur an org (A3)' }]);
  }

  /** Tupel anlegen; gleiches Tupel (auch abgelaufen) → 409 `duplicate`. Mit `actor` Audit `access.granted`. */
  async grant(tx: Tx, t: TupleInput, actor?: Actor & { extra?: Record<string, unknown> }): Promise<Tuple> {
    this.check(t);
    const r = await tx.query<Tuple>(
      `INSERT INTO ${this.S}.authz_tuple (tenant_id, subject, relation, object_type, object_id, expires_at, created_by)
       VALUES (app.tenant_id(), $1, $2, $3, $4, $5, $6) ON CONFLICT ON CONSTRAINT authz_tuple_unique DO NOTHING RETURNING ${TUPLE_COLS}`,
      [t.subject, t.relation, t.place.type, t.place.type === ORG ? null : t.place.id, t.expiresAt ?? null, t.createdBy ?? null]);
    const row = r.rows[0];
    if (!row) throw conflict('Diese Freigabe besteht bereits.', { reason: 'duplicate' });
    if (actor && this.audit) await this.audit.write(tx, actor, { action: 'access.granted', resourceType: 'tuple', resourceId: row.id, data: { ...accessData(row), ...actor.extra } });
    return row;
  }

  /** Ablauf ändern; Audit `access.granted` mit `previousExpiresAt` (A22). */
  async setExpiry(tx: Tx, id: string, expiresAt: Date | null, actor?: Actor & { extra?: Record<string, unknown> }): Promise<Tuple | null> {
    const before = await this.get(tx, id);
    if (!before) return null;
    const row = (await tx.query<Tuple>(`UPDATE ${this.S}.authz_tuple SET expires_at = $2 WHERE id = $1 RETURNING ${TUPLE_COLS}`, [id, expiresAt])).rows[0]!;
    if (actor && this.audit) await this.audit.write(tx, actor, { action: 'access.granted', resourceType: 'tuple', resourceId: id, data: { ...accessData(row), previousExpiresAt: before.expires_at?.toISOString() ?? null, ...actor.extra } });
    return row;
  }

  /** Tupel löschen; Audit `action` (Standard `access.revoked`). */
  async revoke(tx: Tx, id: string, actor?: Actor & { extra?: Record<string, unknown> }, action = 'access.revoked'): Promise<Tuple | null> {
    const row = (await tx.query<Tuple>(`DELETE FROM ${this.S}.authz_tuple WHERE id = $1 RETURNING ${TUPLE_COLS}`, [id])).rows[0] ?? null;
    if (row && actor && this.audit) await this.audit.write(tx, actor, { action, resourceType: 'tuple', resourceId: id, data: { ...accessData(row), ...actor.extra } });
    return row;
  }

  /** Alle Tupel eines Subjekts löschen (Entfernen einer Person oder eines Clients), je Tupel `access.revoked`. */
  async revokeSubject(tx: Tx, subject: string, actor?: Actor & { extra?: Record<string, unknown> }): Promise<Tuple[]> {
    const rows = (await tx.query<Tuple>(`DELETE FROM ${this.S}.authz_tuple WHERE subject = $1 RETURNING ${TUPLE_COLS}`, [subject])).rows;
    if (actor && this.audit) for (const row of rows) await this.audit.write(tx, actor, { action: 'access.revoked', resourceType: 'tuple', resourceId: row.id, data: { ...accessData(row), ...actor.extra } });
    return rows;
  }

  async get(tx: Tx, id: string): Promise<Tuple | null> {
    return (await tx.query<Tuple>(`SELECT ${TUPLE_COLS} FROM ${this.S}.authz_tuple WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** Tupel eines Subjekts (alle Orte), nach Ort sortiert. */
  async ofSubject(tx: Tx, subject: string): Promise<Tuple[]> {
    return (await tx.query<Tuple>(`SELECT ${TUPLE_COLS} FROM ${this.S}.authz_tuple WHERE subject = $1 ORDER BY object_type <> 'org', object_type, object_id, relation`, [subject])).rows;
  }

  /** Rollen eines Subjekts an org (nicht abgelaufen). */
  async rolesAtOrg(tx: Tx, subject: string): Promise<string[]> {
    return (await tx.query<{ relation: string }>(`SELECT relation FROM ${this.S}.authz_tuple WHERE subject = $1 AND object_type = 'org' AND (expires_at IS NULL OR expires_at > now())`, [subject])).rows.map(r => r.relation);
  }

  /** Abgelaufene Tupel löschen, je Tupel `access.expired` (Worker, A8). */
  async expire(tx: Tx, actor: Actor): Promise<Tuple[]> {
    const rows = (await tx.query<Tuple>(`DELETE FROM ${this.S}.authz_tuple WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING ${TUPLE_COLS}`)).rows;
    if (this.audit) for (const row of rows) await this.audit.write(tx, actor, { action: 'access.expired', resourceType: 'tuple', resourceId: row.id, data: accessData(row) });
    return rows;
  }
}
