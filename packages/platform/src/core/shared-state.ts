/**
 * Geteilter Zustand (app-boilerplate 6): `SHARED_STATE=postgres` hält Rate-Limit und Replay-Schutz über alle Instanzen.
 * Den Replay-Schutz wählt `createIam` selbst; hier der Speicher des Rate-Limits und das Aufräumen.
 */
import { pgRateLimitStore, purgeSharedState } from '@vollholz/iam';
import type { PlatformConfig } from '../config/env.ts';
import type { PlatformContext } from '../context.ts';
import type { Db } from '../db/pool.ts';

/** Optionen für `@fastify/rate-limit`: geteilt in PostgreSQL oder im Prozess. */
export function rateLimitStore(ctx: PlatformContext, cfg: PlatformConfig, db: Db): Record<string, unknown> {
  return cfg.ops.sharedState === 'postgres' ? { store: pgRateLimitStore(db, ctx.schema), skipOnError: true } : {};
}

/** Abgelaufene Zähler und Replay-Einträge löschen (Worker, alle 5 Minuten). */
export function purgeExpired(ctx: PlatformContext, db: Db): Promise<unknown> {
  return purgeSharedState(db, ctx.schema);
}
