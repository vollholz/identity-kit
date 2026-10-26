/**
 * Audit (app-boilerplate 6): jede schreibende Aktion mit Principal, Mandant, Client, Quelle und Korrelations-ID in
 * `<schema>.audit_log`, in derselben Transaktion; die Hash-Kette führt ein Trigger des Baukastens. Den Port je App
 * baut `definePlatform` (`platform.audit`).
 */
import { pgAudit, type Actor, type AuditEntry, type AuditPort, type Source } from '@vollholz/iam';
import type { PlatformContext } from '../context.ts';

export type { Actor, AuditEntry, AuditPort, Source };

export const auditPort = (ctx: PlatformContext): AuditPort => pgAudit({ schema: ctx.schema });

/** Handelnder ohne Person: Worker, Systemaufgaben. */
export const systemActor = (source: Extract<Source, 'worker' | 'system'>, correlationId: string | null = null): Actor => ({ principal: null, source, correlationId });
