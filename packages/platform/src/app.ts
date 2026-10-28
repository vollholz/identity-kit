/**
 * App aus Plattform und Modulen (Kompositionswurzel): `defineApp` liefert Konfiguration, API, Worker, MCP-Dienst,
 * Migrationen, OpenAPI-Export, Doku der Konfiguration, Mandanten und Rotation – je aus denselben Modulen. Die
 * Einstiegspunkte der App sind damit eine Zeile (`await app.startApi()`).
 */
import { createIam, type DbSsl, type IamEvents, type IamOptions, type Keyring, type MigrationResult, type Service, type VarSpec } from '@vollholz/iam';
import type { FastifyServerOptions } from 'fastify';
import { configOrExit, loadPlatformConfig, platformVars, type ConfigCheck, type PlatformConfig } from './config/env.ts';
import { envDocs, type EnvDocsOptions } from './config/docs.ts';
import type { Db } from './db/pool.ts';
import { runMigrations, type RunMigrationsOptions } from './db/migrate.ts';
import { buildApp, type App } from './http/app.ts';
import { checkPublicRoutes } from './http/public-route.ts';
import { exportOpenApi } from './http/openapi-doc.ts';
import { uiModule } from './http/ui.ts';
import { buildMcpApp, checkTools } from './mcp/server.ts';
import type { ToolDef } from './mcp/tools.ts';
import { checkModules, type PlatformModule } from './module.ts';
import { entraRewrapper, rotateKeys } from './ops/rotation.ts';
import { tenantCreate, tenantDelete, tenantList, tenantResume, tenantSuspend, type TenantDbs } from './ops/tenants.ts';
import type { Platform } from './platform.ts';
import { outboxTask } from './worker/outbox.ts';
import { Worker, type Log } from './worker/queue.ts';
import { purgeSharedStateTask, retentionTask } from './worker/retention.ts';

export interface AppSpec {
  platform: Platform<any, any>;
  /** Fachmodule in Reihenfolge (Routen, Tags in der Doku). */
  modules: readonly PlatformModule[];
  /** Variablen der App zusätzlich zu IAM und Plattform. */
  vars?: readonly VarSpec[];
  /** Prüfungen der App über mehrere Variablen. */
  check?: ConfigCheck;
  /** Modul `people` des IAM: Rechte, die das Personenverzeichnis öffnen. */
  people?: { permissions?: string[] };
  /** Oberfläche aus `WEB_DIST_DIR` mit SPA-Fallback (Standard true). */
  ui?: boolean;
  /** Migrationen: Ordner der App (`db/migrations`) und Übernahme bestehender Objekte. */
  migrations?: Omit<RunMigrationsOptions, 'log'>;
  /** Werte der Doku-Umgebung beim OpenAPI-Export (Pflichtvariablen der App, abweichende Adressen). */
  openapiEnv?: Record<string, string>;
  /**
   * Haken der App an den Baukasten (`events` von `createIam`): vor und nach dem Entfernen eines Mitglieds, je Rolle an
   * einem Ort, Austritt und Ablauf aus dem Abgleich. Gilt in API, Worker (Verwaltung im JobContext) und Abgleich
   * (`MemberSync`). Für die Outbox: `after: (tx, e) => platform.emit(tx, 'iam.' + e.type, e.subject, e.data)`.
   */
  iamEvents?: IamEvents;
}

export interface CreateApiOptions {
  ready?: () => boolean;
  fastify?: FastifyServerOptions;
  iam?: Partial<Pick<IamOptions, 'fetch' | 'keycloakFetch' | 'entraFetch' | 'replay'>>;
}

export interface CreateWorkerOptions {
  iam?: Partial<Pick<IamOptions, 'fetch' | 'keycloakFetch' | 'entraFetch'>>;
}

export interface PlatformApp {
  readonly platform: Platform<any, any>;
  /** Module samt Oberfläche (zuletzt). */
  readonly modules: readonly PlatformModule[];
  readonly vars: readonly VarSpec[];
  /** Werkzeuge des MCP-Dienstes aus allen Modulen. */
  readonly tools: Readonly<Record<string, ToolDef>>;
  loadConfig(env: NodeJS.ProcessEnv, service: Service | null): PlatformConfig;
  configOrExit(env: NodeJS.ProcessEnv, service: Service | null): PlatformConfig;
  createApi(cfg: PlatformConfig, db: Db, o?: CreateApiOptions): Promise<{ app: App; iam: ReturnType<typeof createIam> }>;
  /** Worker mit Verwaltung (`JobContext.admin`), sofern `KEYCLOAK_MGMT_CLIENT_ID` samt Schlüssel bzw. Geheimnis gesetzt ist. */
  createWorker(cfg: PlatformConfig, db: Db, log: Log, o?: CreateWorkerOptions): Worker;
  buildMcp(cfg: PlatformConfig, o?: { fetch?: typeof fetch; logger?: boolean }): ReturnType<typeof buildMcpApp>;
  /** Migrationen; `ssl` wie `DATABASE_SSL` (die Befehlszeile liest es aus der Umgebung). */
  migrate(adminUrl: string, o?: ((m: string) => void) | { log?: (m: string) => void; ssl?: DbSsl }): Promise<MigrationResult>;
  /** Haken der App an den Baukasten (AppSpec.iamEvents) oder null. */
  readonly iamEvents: IamEvents | null;
  openApi(): Promise<Record<string, unknown>>;
  envDocs(o?: EnvDocsOptions): { env: string; md: string };
  rotateKeys(o: { db: Db; keys: Keyring; dryRun?: boolean }): Promise<Record<string, number>>;
  readonly tenants: {
    list: typeof tenantList;
    create(d: TenantDbs, alias: string, name?: string): ReturnType<typeof tenantCreate>;
    suspend(d: TenantDbs, alias: string, reason?: string): ReturnType<typeof tenantSuspend>;
    resume(d: TenantDbs, alias: string): ReturnType<typeof tenantResume>;
    delete(d: TenantDbs, alias: string, confirm: string): ReturnType<typeof tenantDelete>;
  };
}

export function defineApp(spec: AppSpec): PlatformApp {
  const { platform } = spec;
  const ctx = platform.context;
  const events = spec.iamEvents ?? null;
  // Verwaltung im Worker über dessen Pool; ohne Zugang zu Keycloak (der Worker bekommt das Geheimnis nur, wenn er es braucht) null
  const workerAdmin = (cfg: PlatformConfig, db: Db, o: CreateWorkerOptions) => {
    const m = cfg.mgmt;
    if (!m.clientId || !(m.privateKey || m.clientSecret)) return null;
    return createIam({ cfg, model: platform.model, resources: platform.resources, db, schema: ctx.schema, audit: platform.audit, events, bff: false, ...o.iam }).admin;
  };
  checkModules(spec.modules);
  checkPublicRoutes(spec.modules.flatMap(m => m.publicRoutes ?? []), platform.model.scopes);
  const modules = spec.ui === false ? [...spec.modules] : [...spec.modules, uiModule];
  const vars = platformVars(ctx.product, spec.vars);
  const tools: Record<string, ToolDef> = Object.assign({}, ...spec.modules.map(m => m.mcpTools ?? {}));
  if (Object.keys(platform.model.mcpTools).length || Object.keys(tools).length) checkTools({ model: platform.model, tools });
  const people = spec.people ? { people: spec.people } : {};

  return {
    platform, modules, vars, tools, iamEvents: events,
    loadConfig: (env, service) => loadPlatformConfig(env, service, vars, spec.check),
    configOrExit: (env, service) => configOrExit(env, service, vars, spec.check),
    async createApi(cfg, db, o = {}) {
      const iam = createIam({ cfg, model: platform.model, resources: platform.resources, db, schema: ctx.schema, audit: platform.audit, events, ...o.iam });
      const app = await buildApp({ platform: ctx, cfg, db, iam, ready: o.ready ?? (() => true) }, { modules, ...people, ...(o.fastify ? { fastify: o.fastify } : {}) });
      return { app, iam };
    },
    createWorker: (cfg, db, log, o = {}) => new Worker({
      platform: ctx, fullTx: platform.fullTx, db, cfg, log, admin: workerAdmin(cfg, db, o),
      jobs: spec.modules.flatMap(m => m.jobs ?? []),
      tasks: [purgeSharedStateTask, retentionTask, outboxTask(spec.modules.flatMap(m => m.consumers ?? [])), ...spec.modules.flatMap(m => m.tasks ?? [])],
    }),
    buildMcp: (cfg, o = {}) => buildMcpApp({ platform: ctx, model: platform.model, tools }, cfg, o),
    migrate: (adminUrl, o = {}) => runMigrations(adminUrl, ctx, platform.model, { ...spec.migrations, ...(typeof o === 'function' ? { log: o } : o) }),
    openApi: () => exportOpenApi({
      platform: ctx, model: platform.model, resources: platform.resources, audit: platform.audit, vars, modules, ...people,
      ...(spec.openapiEnv ? { env: spec.openapiEnv } : {}),
    }),
    envDocs: o => envDocs(vars, o),
    rotateKeys: o => rotateKeys({
      db: o.db, fullTx: platform.fullTx, keys: o.keys,
      // Probelauf: nur die Entra-Geheimnisse zählen (die Module kennen keinen Probelauf)
      rewrappers: [entraRewrapper(ctx, { dryRun: o.dryRun ?? false }), ...(o.dryRun ? [] : spec.modules.flatMap(m => m.rewrappers ?? []))],
    }),
    tenants: {
      list: tenantList,
      create: (d, alias, name) => tenantCreate(ctx, d, alias, name),
      suspend: (d, alias, reason) => tenantSuspend(ctx, d, alias, reason),
      resume: (d, alias) => tenantResume(ctx, d, alias),
      delete: (d, alias, confirm) => tenantDelete(ctx, d, alias, confirm),
    },
  };
}
