/**
 * Aufbewahrung und Aufräumen (app-boilerplate 5.9): geteilter Zustand alle 5 Minuten; erledigte Jobs, abgelaufene
 * Idempotenz und verteilte Ereignisse stündlich. Das Audit-Protokoll bleibt (nur anhängen).
 */
import { purgeExpired } from '../core/shared-state.ts';
import type { PeriodicTask } from './queue.ts';

export const purgeSharedStateTask: PeriodicTask = {
  name: 'shared-state.purge',
  intervalMs: () => 5 * 60_000,
  run: async ({ db, platform }) => { await purgeExpired(platform, db); },
};

export const retentionTask: PeriodicTask = {
  name: 'retention',
  intervalMs: () => 60 * 60_000,
  async run({ db, cfg, log, platform }) {
    const jobs = await db.query(`DELETE FROM ${platform.schema}.job WHERE status IN ('done', 'failed') AND finished_at < now() - make_interval(secs => $1)`, [cfg.app.worker.jobRetentionMs / 1000]);
    const idem = await db.query(`DELETE FROM ${platform.schema}.idempotency_key WHERE expires_at < now()`);
    const events = await db.query(`DELETE FROM ${platform.schema}.outbox_event WHERE dispatched_at < now() - make_interval(secs => $1)`, [cfg.app.events.outboxRetentionMs / 1000]);
    log.info({ jobs: jobs.rowCount, idempotency: idem.rowCount, events: events.rowCount }, 'Aufbewahrung: gelöscht');
  },
};
