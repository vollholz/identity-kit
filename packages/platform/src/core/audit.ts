/**
 * Audit (app-boilerplate 6): jede schreibende Aktion mit Principal, Mandant, Client, Quelle und Korrelations-ID in
 * `<schema>.audit_log`, in derselben Transaktion; die Hash-Kette führt ein Trigger des Baukastens. Den Port je App
 * baut `definePlatform` (`platform.audit`), die Suche `platform.auditSearch` (iam_021).
 */
import {
  pgAudit, pgAuditSearch, type Actor, type AuditEntry, type AuditPage, type AuditPort, type AuditQuery, type AuditRecord, type AuditSearch,
  type AuditSubjectFallback, type Source,
} from '@vollholz/iam';
import type { PlatformContext } from '../context.ts';

export type { Actor, AuditEntry, AuditPage, AuditPort, AuditQuery, AuditRecord, AuditSearch, AuditSubjectFallback, Source };

export const auditPort = (ctx: PlatformContext): AuditPort => pgAudit({ schema: ctx.schema });

/** Suche im Audit der App; `subjectFallback` findet Einträge ohne `subject` (z. B. vor iam_021) über `data` oder das Objekt. */
export const auditSearchOf = (ctx: PlatformContext, subjectFallback?: AuditSubjectFallback): AuditSearch => pgAuditSearch({ schema: ctx.schema, subjectFallback });

/** Handelnder ohne Person: Worker, Systemaufgaben. */
export const systemActor = (source: Extract<Source, 'worker' | 'system'>, correlationId: string | null = null): Actor => ({ principal: null, source, correlationId });
