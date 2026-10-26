/**
 * Abgleich der Mitglieder (app-boilerplate 5.9): `MemberSync` aus dem Baukasten mit dem eigenen Lese-Client
 * `<product>-sync`; räumt im selben Lauf abgelaufene Freigaben und Break-Glass auf. Höchstens ein Lauf über alle
 * Instanzen (Sperre im Baukasten).
 */
import { MemberSync } from '@vollholz/iam';
import type { PlatformConfig } from '../config/env.ts';
import type { PlatformContext } from '../context.ts';
import type { AuditPort } from '../core/audit.ts';
import type { Db } from '../db/pool.ts';
import type { Log } from './queue.ts';

export function startMemberSync(ctx: PlatformContext, audit: AuditPort, cfg: PlatformConfig, db: Db, log: Log): { stop(): Promise<void> } {
  const sync = new MemberSync(cfg, db, { schema: ctx.schema, audit, log: (m: string, d?: Record<string, unknown>) => log.info(d ?? {}, m) });
  sync.start();
  return { stop: async () => { await sync.stop(); } };
}
