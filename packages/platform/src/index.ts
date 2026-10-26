/**
 * @vollholz/platform – Querschnitt für Apps auf der Identity-Plattform: Konfiguration, HTTP (Fastify, OpenAPI,
 * Idempotenz, Rate-Limit, Oberfläche), Warteschlange und Outbox in PostgreSQL, Betrieb (Telemetrie, Metriken,
 * geordnetes Beenden), MCP-Dienst, Mandanten und Rotation. Anmeldung, Rechte und Mandantentrennung kommen aus
 * @vollholz/iam.
 *
 * Telemetrie: `node --import @vollholz/platform/preload …` (vor allen anderen Modulen).
 */
export { definePlatform, type Platform, type PlatformSpec } from './platform.ts';
export { defineApp, type AppSpec, type CreateApiOptions, type PlatformApp } from './app.ts';
export { defineModule, checkModules, type ApiTag, type PlatformModule } from './module.ts';
export { platformContext, type ContextSpec, type PlatformContext } from './context.ts';

// Konfiguration
export {
  ConfigError, EXIT_CONFIG, PLATFORM_VARS, platformVars, loadPlatformConfig, configOrExit,
  type AppConfig, type ConfigCheck, type PlatformConfig, type RawVars, type Service, type VarSpec,
} from './config/env.ts';
export { envDocs, type EnvDocsOptions } from './config/docs.ts';

// Kern
export { auditPort, systemActor, type Actor, type AuditEntry, type AuditPort, type Source } from './core/audit.ts';
export { createSealer, sealedKeyId, type Keyring, type Sealer } from './core/crypto.ts';
export { conflict, forbidden, HttpError, invalid, notFound, preconditionFailed, preconditionRequired } from './core/errors.ts';
export { emit, toCloudEvent, type CloudEvent, type EventType } from './core/events.ts';
export { REDACT_PATHS, redact } from './core/redact.ts';
export { isPublicAddress, resolveTarget, safeRequest, SsrfError, type SafeResponse } from './core/ssrf.ts';

// Datenbank
export { createPool, withTenant, withTx, type Db, type Tx } from './db/pool.ts';
export { platformMigrations, runMigrations, PLATFORM_MIGRATIONS_DIR, type PlatformMigrationOptions, type RunMigrationsOptions } from './db/migrate.ts';
export { fullTxOf, type FullTx } from './authz/view.ts';

// HTTP
export { API_CSP, DOCS_CSP, apiPaths, apiTags, buildApp, fastifyOptions, setSpanContext, type App, type BuildOptions, type Deps } from './http/app.ts';
export { registerIdempotency } from './http/idempotency.ts';
export { docEnv, exportOpenApi, type ExportOpenApiOptions } from './http/openapi-doc.ts';
export {
  Cursor, DateTime, IdempotencyHeaders, IdParams, IfMatchHeaders, Limit, NextCursor, Nullable, Uuid,
  actorOf, decodeCursor, encodeCursor, etag, record, requireIfMatch, type RecordEntry,
} from './http/route-kit.ts';
export { registerUi, safePath, uiCsp, uiModule } from './http/ui.ts';

// Worker
export { Worker, PermanentJobError, backoffMs, claimLockKey, enqueue, type JobContext, type JobDefinition, type Log, type PeriodicTask } from './worker/queue.ts';
export { outboxTask, type OutboxConsumer, type OutboxEvent } from './worker/outbox.ts';
export { purgeSharedStateTask, retentionTask } from './worker/retention.ts';
export { startMemberSync } from './worker/member-sync.ts';

// Betrieb
export { metrics, metricsText } from './ops/metrics.ts';
export { createRuntime, type Runtime, type RuntimeLog, type RuntimeOptions } from './ops/runtime.ts';
export { startOpsServer, type OpsServerOptions } from './ops/server.ts';
export { meter, shutdownTelemetry, startTelemetry, telemetryEnabled, tracer, TRACER_NAME, type TelemetryOptions } from './ops/telemetry.ts';
export { entraRewrapper, rotateKeys, type Rewrapper } from './ops/rotation.ts';
export { tenantCreate, tenantDelete, tenantList, tenantResume, tenantSuspend, type TenantDbs } from './ops/tenants.ts';

// MCP
export { buildMcpApp, buildToolServer, checkTools, type McpOptions } from './mcp/server.ts';
export { organisationArg, type ToolDef } from './mcp/tools.ts';

// Prozesse und Befehle
export { startApi, startMcp, startWorker } from './main/start.ts';
export { runCli } from './main/cli.ts';
