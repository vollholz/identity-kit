/**
 * Prozesse einer App: `api` (REST-API unter /v1, Doku unter /v1/docs, BFF unter /auth, Webapp), `worker`
 * (Warteschlange, Outbox, Aufräumen, Mitgliederabgleich) und `mcp` (MCP-Dienst unter /mcp, ohne Datenbank). Jeder mit
 * Betriebs-Endpunkt auf OPS_PORT und geordnetem Beenden auf SIGTERM; ungültige Konfiguration: Exit 78.
 */
import { trace } from '@opentelemetry/api';
import { iamWarnings, readinessChecks } from '@vollholz/iam';
import pino from 'pino';
import type { PlatformApp } from '../app.ts';
import { REDACT_PATHS } from '../core/redact.ts';
import { createPool } from '../db/pool.ts';
import { setSpanContext } from '../http/app.ts';
import { createRuntime } from '../ops/runtime.ts';
import { startOpsServer } from '../ops/server.ts';
import { startMemberSync } from '../worker/member-sync.ts';

export async function startApi(a: PlatformApp, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const cfg = a.configOrExit(env, 'api');
  setSpanContext(() => trace.getActiveSpan()?.spanContext());
  const db = createPool(cfg.db.url, cfg, `${a.platform.context.product}-api`);
  let runtime: ReturnType<typeof createRuntime>;
  const { app, iam } = await a.createApi(cfg, db, { ready: () => runtime.ready });
  runtime = createRuntime({ service: 'api', shutdownDelayMs: cfg.app.ops.shutdownDelayMs, shutdownTimeoutMs: cfg.app.ops.shutdownTimeoutMs, log: app.log });
  for (const w of iamWarnings(cfg, 'api')) app.log.warn({}, w);

  const checks = readinessChecks(iam);
  const ops = await startOpsServer({
    port: cfg.app.ops.port, ready: () => runtime.ready, metrics: cfg.app.ops.metrics, log: app.log,
    checks: async () => Object.fromEntries(await Promise.all(checks.map(async c => [c.name, await c.run().then(() => true, () => false)] as const))),
  });
  await app.listen({ host: cfg.app.http.host, port: cfg.app.http.port });

  // Reihenfolge beim Beenden umgekehrt: erst keine Anfragen mehr, dann Pool, zuletzt Betriebs-Endpunkt
  runtime.onShutdown(() => ops.close());
  runtime.onShutdown(() => db.end());
  runtime.onShutdown(() => app.close());
  runtime.markReady();
  app.log.info({ port: cfg.app.http.port, ops: ops.port }, 'api bereit');
}

export async function startWorker(a: PlatformApp, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const cfg = a.configOrExit(env, 'worker');
  const log = pino({ level: cfg.app.logLevel, redact: { paths: REDACT_PATHS, censor: '[entfernt]' }, base: { service: 'worker' } });
  for (const w of iamWarnings(cfg, 'worker')) log.warn({}, w);

  const db = createPool(cfg.db.workerUrl, cfg, `${a.platform.context.product}-worker`);
  const runtime = createRuntime({ service: 'worker', shutdownDelayMs: cfg.app.ops.shutdownDelayMs, shutdownTimeoutMs: cfg.app.ops.shutdownTimeoutMs, log });
  const worker = a.createWorker(cfg, db, log);
  const sync = cfg.memberSync.clientId && cfg.memberSync.intervalMs > 0 ? startMemberSync(a.platform.context, a.platform.audit, cfg, db, log, a.iamEvents) : null;
  const ops = await startOpsServer({
    port: cfg.app.ops.port, ready: () => runtime.ready, metrics: cfg.app.ops.metrics, log,
    checks: async () => ({ datenbank: await db.query('SELECT 1').then(() => true, () => false) }),
  });

  runtime.onShutdown(() => ops.close());
  runtime.onShutdown(() => db.end());
  if (sync) runtime.onShutdown(() => sync.stop());
  runtime.onShutdown(() => worker.stop());
  worker.start();
  runtime.markReady();
  log.info({ jobs: a.modules.flatMap(m => (m.jobs ?? []).map(j => j.kind)), memberSync: !!sync, admin: !!worker.admin, mail: cfg.app.mail.adapter, ops: ops.port }, 'worker bereit');
}

export async function startMcp(a: PlatformApp, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const cfg = a.configOrExit(env, 'mcp');
  const { app } = await a.buildMcp(cfg);
  for (const w of iamWarnings(cfg, 'mcp')) app.log.warn({}, w);
  const runtime = createRuntime({ service: 'mcp', shutdownDelayMs: cfg.app.ops.shutdownDelayMs, shutdownTimeoutMs: cfg.app.ops.shutdownTimeoutMs, log: app.log });
  const ops = await startOpsServer({ port: cfg.app.ops.port, ready: () => runtime.ready, metrics: cfg.app.ops.metrics, log: app.log });
  await app.listen({ host: cfg.app.http.host, port: cfg.app.mcp.port });
  runtime.onShutdown(() => ops.close());
  runtime.onShutdown(() => app.close());
  runtime.markReady();
  app.log.info({ port: cfg.app.mcp.port, ops: ops.port }, 'mcp bereit');
}
