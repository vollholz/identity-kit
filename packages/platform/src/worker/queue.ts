/**
 * Warteschlange in PostgreSQL (app-boilerplate 5.9).
 *
 * - `enqueue` in der fachlichen Transaktion (Rolle _app, Mandantenkontext): Was nicht committet wird, läuft nie.
 * - Abholen über alle Mandanten (Rolle _sched), serialisiert über eine Advisory-Lock je App, höchstens
 *   `WORKER_TENANT_LIMIT` laufende Jobs je Mandant, keine Jobs gesperrter Mandanten.
 * - Jeder Job läuft im Kontext seines Mandanten mit voller Sicht und ohne Person (`fullTx`).
 * - Heartbeat jede Minute; ohne Heartbeat seit 15 Minuten gilt ein Job als verwaist und wird neu eingereiht.
 * - Fehler: exponentielles Backoff bis `maxAttempts` der Definition (Standard 5); `PermanentJobError` beendet sofort.
 * - Abschluss nur durch den Worker, der den Job hält (`locked_by`): Wer sein Lebenszeichen verpasst hat und dessen Job
 *   neu vergeben wurde, überschreibt das Ergebnis des neuen Halters nicht.
 * - Beenden wartet auf laufende Jobs und laufende feste Aufgaben.
 * - Feste Aufgaben (`PeriodicTask`) laufen je Intervall höchstens einmal über alle Instanzen (Advisory-Lock).
 * - Produktmodule (mit `modules` im Modell): Ein Job, dessen Modul in der Organisation nicht aktiv ist, endet `skipped`
 *   (`result: { modul: 'inaktiv' }`) ohne Fehler und ohne neuen Versuch; feste Aufgaben erhalten mit `ctx.tenants()`
 *   nur die Organisationen, in denen ihr Modul aktiv ist.
 *
 * Fachjobs liefern die Module als `JobDefinition` (`defineModule({ jobs })`), nicht dieses Paket.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AdminService, Model } from '@vollholz/iam';
import type { PlatformConfig } from '../config/env.ts';
import type { FullTx } from '../authz/view.ts';
import type { PlatformContext } from '../context.ts';
import type { Actor } from '../core/audit.ts';
import { systemActor } from '../core/audit.ts';
import { createMailer, type Mailer } from '../core/mail.ts';
import type { Db, Tx } from '../db/pool.ts';
import { metrics } from '../ops/metrics.ts';
import { activeModulesIn, tenantsWith, type TaskTenant } from './modules.ts';

export interface Log {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

/** Kontext eines Jobs: Transaktion im Mandanten (volle Sicht), Handelnder «worker» mit der Job-ID als Korrelation. */
export interface JobContext {
  tenantId: string;
  jobId: string;
  attempt: number;
  cfg: PlatformConfig;
  log: Log;
  actor: Actor;
  /** Verwaltung von Organisationen und Mitgliedern (`iam.admin`); null ohne `KEYCLOAK_MGMT_CLIENT_ID` samt Schlüssel bzw. Geheimnis. */
  admin: AdminService | null;
  /** Versand nach `MAIL_ADAPTER` (`createMailer`). */
  mailer: Mailer;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface JobDefinition<P extends Record<string, unknown> = Record<string, unknown>> {
  /** `<modul>.<aufgabe>` */
  kind: string;
  /**
   * Produktmodul oder `modul.teil` (Standard: das Modul des Code-Moduls, `defineModule`). Ist es in der Organisation des
   * Auftrags nicht aktiv, endet der Auftrag `skipped` ohne Fehler und ohne neuen Versuch.
   */
  modul?: string;
  /** Versuche insgesamt (Standard 5, höchstens 100). */
  maxAttempts?: number;
  run(ctx: JobContext, payload: P): Promise<void>;
}

/** Aufgabe über alle Mandanten in festem Abstand (z. B. Aufräumen, Verteilung der Outbox). */
export interface PeriodicTask {
  name: string;
  /** Produktmodul oder `modul.teil` (Standard: das Modul des Code-Moduls); bestimmt `ctx.tenants()`. */
  modul?: string;
  intervalMs(cfg: PlatformConfig): number;
  run(ctx: TaskContext): Promise<void>;
}

/** Kontext einer festen Aufgabe (über alle Mandanten, Pool des Workers). */
export interface TaskContext {
  db: Db; cfg: PlatformConfig; log: Log; platform: PlatformContext; admin: AdminService | null; mailer: Mailer;
  /**
   * Nicht gesperrte Organisationen, in denen `modul` (Standard: das Modul der Aufgabe) aktiv ist; ohne Modul bzw. ohne
   * `modules` im Modell alle nicht gesperrten.
   */
  tenants(modul?: string): Promise<TaskTenant[]>;
}

/** Fehler ohne erneuten Versuch. */
export class PermanentJobError extends Error {}

/** Schlüssel der Advisory-Lock für das Abholen (eindeutig je App: `hashtext('<product>:claim')`). */
export const claimLockKey = (ctx: Pick<PlatformContext, 'product'>) => `${ctx.product}:claim`;
const HEARTBEAT_MS = 60_000;
const ORPHAN_AFTER = '15 minutes';

/**
 * Auftrag einreihen (in der fachlichen Transaktion). Mit `dedupeKey` höchstens ein offener Auftrag je Schlüssel. Die
 * Zahl der Versuche steht in der `JobDefinition` (`maxAttempts`), nicht beim Einreihen.
 */
export async function enqueue(ctx: PlatformContext, tx: Tx, kind: string, payload: Record<string, unknown> = {}, o: { runAt?: Date; dedupeKey?: string } = {}): Promise<string | null> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO ${ctx.schema}.job (tenant_id, kind, payload, run_at, dedupe_key)
     VALUES (app.tenant_id(), $1, $2, coalesce($3, now()), $4)
     ON CONFLICT (tenant_id, kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING
     RETURNING id`,
    [kind, JSON.stringify(payload), o.runAt ?? null, o.dedupeKey ?? null]);
  return r.rows[0]?.id ?? null;
}

/** Wartezeit vor dem nächsten Versuch: 10 s · 2^(Versuch−1), höchstens 1 h, mit Streuung. */
export function backoffMs(attempt: number): number {
  const base = Math.min(3_600_000, 10_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export type { TaskTenant };

interface Claimed { tenant_id: string; id: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }

export class Worker {
  readonly id = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly db: Db;
  private readonly platform: PlatformContext;
  private readonly fullTx: FullTx;
  private readonly model: Pick<Model, 'features' | 'modules' | 'activeModules'> | null;
  private readonly cfg: PlatformConfig;
  private readonly log: Log;
  /** Verwaltung für Jobs und feste Aufgaben (`JobContext.admin`) oder null. */
  readonly admin: AdminService | null;
  readonly mailer: Mailer;
  private readonly jobs: Map<string, JobDefinition<any>>;
  private readonly tasks: PeriodicTask[];
  private readonly running = new Set<Promise<void>>();
  private readonly tasksRunning = new Set<Promise<unknown>>();
  private readonly timers: NodeJS.Timeout[] = [];
  private stopped = true;
  private wake: (() => void) | null = null;

  constructor(o: {
    platform: PlatformContext; fullTx: FullTx; db: Db; cfg: PlatformConfig; log: Log; jobs: readonly JobDefinition<any>[]; tasks?: readonly PeriodicTask[];
    /** Standard null (`defineApp` baut sie aus der Konfiguration). */
    admin?: AdminService | null;
    /** Standard `createMailer(cfg, log)`. */
    mailer?: Mailer;
    /** Modell der App: mit `modules` überspringt der Worker Jobs inaktiver Module (`defineApp` setzt es). */
    model?: Pick<Model, 'features' | 'modules' | 'activeModules'> | null;
  }) {
    this.db = o.db; this.cfg = o.cfg; this.log = o.log; this.platform = o.platform; this.fullTx = o.fullTx;
    this.model = o.model?.features.modules ? o.model : null;
    this.admin = o.admin ?? null;
    this.mailer = o.mailer ?? createMailer(o.cfg, o.log);
    this.jobs = new Map(o.jobs.map(j => [j.kind, j]));
    if (this.jobs.size !== o.jobs.length) throw new Error('Worker: doppelte Job-Arten');
    this.tasks = [...(o.tasks ?? [])];
  }

  /** Abholen und feste Aufgaben starten. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
    this.every(HEARTBEAT_MS, () => this.heartbeat());
    for (const t of this.tasks) this.every(t.intervalMs(this.cfg), () => this.runTask(t));
  }

  /** Nichts mehr abholen, laufende Jobs zu Ende führen. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.wake?.();
    await Promise.allSettled([...this.running, ...this.tasksRunning]);
  }

  private every(ms: number, fn: () => Promise<unknown>): void {
    if (ms <= 0) return;
    const t = setInterval(() => {
      if (this.stopped) return;
      const p = fn().catch(err => this.log.error({ err }, 'Worker: Aufgabe gescheitert')).finally(() => { this.tasksRunning.delete(p); });
      this.tasksRunning.add(p);
    }, ms);
    t.unref();
    this.timers.push(t);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let claimed: Claimed | null = null;
      if (this.running.size < this.cfg.app.worker.concurrency) {
        try { claimed = await this.claim(); } catch (err) { this.log.error({ err }, 'Worker: Abholen gescheitert'); }
      }
      if (claimed) {
        // Scheitert schon das Festhalten (z. B. Datenbank weg): melden; die Erkennung verwaister Jobs holt ihn zurück
        const job = claimed;
        const p = this.execute(job).catch(err => this.log.error({ err, job: job.id, kind: job.kind }, 'Worker: Ergebnis nicht festgehalten'))
          .finally(() => { this.running.delete(p); this.wake?.(); });
        this.running.add(p);
        continue;
      }
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, this.cfg.app.worker.pollMs);
        this.wake = () => { clearTimeout(t); resolve(); };
      });
      this.wake = null;
    }
  }

  /** Einen fälligen Job abholen (oder null). */
  async claim(): Promise<Claimed | null> {
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [claimLockKey(this.platform)]);
      const r = await c.query<Claimed>(
        `UPDATE ${this.platform.schema}.job j SET status = 'running', attempts = j.attempts + 1, locked_by = $1, heartbeat_at = now()
          WHERE (j.tenant_id, j.id) = (
            SELECT q.tenant_id, q.id FROM ${this.platform.schema}.job q
             WHERE q.status = 'queued' AND q.run_at <= now() AND q.kind = ANY($2)
               AND NOT (q.tenant_id = ANY (app.suspended_tenants()))
               AND (SELECT count(*) FROM ${this.platform.schema}.job r WHERE r.tenant_id = q.tenant_id AND r.status = 'running') < $3
             ORDER BY q.run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING j.tenant_id, j.id, j.kind, j.payload, j.attempts, j.max_attempts`,
        [this.id, [...this.jobs.keys()], this.cfg.app.worker.tenantLimit]);
      await c.query('COMMIT');
      return r.rows[0] ?? null;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally { c.release(); }
  }

  /** Job ausführen und Ergebnis festhalten. */
  async execute(job: Claimed): Promise<void> {
    const def = this.jobs.get(job.kind)!;
    const started = performance.now();
    const ctx: JobContext = {
      tenantId: job.tenant_id, jobId: job.id, attempt: job.attempts, cfg: this.cfg, log: this.log,
      actor: systemActor('worker', `job:${job.id}`), admin: this.admin, mailer: this.mailer,
      tx: fn => this.fullTx(this.db, job.tenant_id, fn),
    };
    try {
      const modul = def.modul;
      if (modul && this.model && !(await this.fullTx(this.db, job.tenant_id, tx => activeModulesIn(tx, this.platform, this.model!))).has(modul)) {
        await this.settle(job, `status = 'skipped', finished_at = now(), last_error = NULL, result = $4`, [JSON.stringify({ modul: 'inaktiv' })]);
        this.log.info({ job: job.id, kind: job.kind, tenant: job.tenant_id, modul }, 'Job übersprungen: Modul in der Organisation nicht aktiv');
        metrics.jobDone(job.kind, 'skipped', performance.now() - started);
        return;
      }
      await def.run(ctx, job.payload);
      await this.settle(job, `status = 'done', finished_at = now(), last_error = NULL`, []);
      metrics.jobDone(job.kind, 'done', performance.now() - started);
    } catch (err) {
      const permanent = err instanceof PermanentJobError || job.attempts >= (def.maxAttempts ?? job.max_attempts);
      const message = (err as Error).message?.slice(0, 2000) ?? String(err);
      if (permanent) {
        await this.settle(job, `status = 'failed', finished_at = now(), last_error = $4`, [message]);
        this.log.error({ err, job: job.id, kind: job.kind, tenant: job.tenant_id, attempt: job.attempts }, 'Job endgültig gescheitert');
      } else {
        await this.settle(job, `status = 'queued', locked_by = NULL, heartbeat_at = NULL, last_error = $4, run_at = now() + make_interval(secs => $5)`,
          [message, backoffMs(job.attempts) / 1000]);
        this.log.warn({ err, job: job.id, kind: job.kind, attempt: job.attempts }, 'Job gescheitert, neuer Versuch folgt');
      }
      metrics.jobDone(job.kind, permanent ? 'failed' : 'retry', performance.now() - started);
    }
  }

  /** Ergebnis festhalten, nur solange dieser Worker den Job hält (`$1` Mandant, `$2` ID, `$3` Worker, ab `$4` `args`). */
  private async settle(job: Claimed, set: string, args: unknown[]): Promise<void> {
    const r = await this.db.query(
      `UPDATE ${this.platform.schema}.job SET ${set} WHERE tenant_id = $1 AND id = $2 AND status = 'running' AND locked_by = $3`,
      [job.tenant_id, job.id, this.id, ...args]);
    if (!r.rowCount) this.log.warn({ job: job.id, kind: job.kind }, 'Job inzwischen neu vergeben: Ergebnis verworfen');
  }

  /** Lebenszeichen der eigenen laufenden Jobs; verwaiste Jobs anderer Instanzen neu einreihen. */
  async heartbeat(): Promise<void> {
    await this.db.query(`UPDATE ${this.platform.schema}.job SET heartbeat_at = now() WHERE status = 'running' AND locked_by = $1`, [this.id]);
    const r = await this.db.query(
      `UPDATE ${this.platform.schema}.job SET status = 'queued', locked_by = NULL, heartbeat_at = NULL, last_error = 'verwaist (kein Lebenszeichen)'
        WHERE status = 'running' AND heartbeat_at < now() - interval '${ORPHAN_AFTER}'`);
    if (r.rowCount) this.log.warn({ count: r.rowCount }, 'Verwaiste Jobs neu eingereiht');
  }

  /** Feste Aufgabe, höchstens einmal gleichzeitig über alle Instanzen. */
  async runTask(t: PeriodicTask): Promise<boolean> {
    const c = await this.db.connect();
    try {
      const key = `${this.platform.product}:task:${t.name}`;
      const got = (await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key])).rows[0]!.ok;
      if (!got) return false;
      const model = this.model ?? { features: { modules: false }, modules: [], activeModules: new Set<string>() } as never;
      const ctx: TaskContext = {
        db: this.db, cfg: this.cfg, log: this.log, platform: this.platform, admin: this.admin, mailer: this.mailer,
        tenants: (modul = t.modul) => tenantsWith(this.db, this.platform, model, modul),
      };
      try { await t.run(ctx); } finally {
        await c.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      }
      return true;
    } finally { c.release(); }
  }
}
