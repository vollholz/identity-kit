/**
 * App aus Plattform und Modulen (Kompositionswurzel): `defineApp` liefert Konfiguration, API, Worker, MCP-Dienst,
 * Migrationen, OpenAPI-Export, Doku der Konfiguration, Mandanten und Rotation – je aus denselben Modulen. Die
 * Einstiegspunkte der App sind damit eine Zeile (`await app.startApi()`).
 */
import { createIam, type DbSsl, type IamEvents, type IamOptions, type Keyring, type MigrationResult, type ModuleHooks, type Service, type VarSpec } from '@vollholz/iam';
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
import { tenantCreate, tenantDelete, tenantList, tenantModules, tenantResume, tenantSuspend, type TenantDbs, type TenantModulesChange, type TenantModulesResult } from './ops/tenants.ts';
import { moduleHooksFor, nachholenJob } from './worker/module-hooks.ts';
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
  /**
   * Haken der App je Produktmodul bzw. Teilfunktion `modul.teil` (nur mit `modules` im Modell), alle in der Transaktion
   * der Änderung im Kontext der Organisation: `einrichten` beim ersten Aktivieren, `hindernisse` vor dem Deaktivieren
   * (409 mit den Hindernissen), `nachholen` beim erneuten Aktivieren – als Auftrag `platform.module-nachholen` im Worker
   * (mit `seit` = letztes Deaktivieren). Gilt in API, Worker und Befehlen (`tenant create --paket`, `tenant modules`).
   */
  moduleHooks?: ModuleHooks;
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
  /**
   * Haken je Produktmodul, wie `createIam` sie erhält (`nachholen` reiht den Auftrag `platform.module-nachholen` ein), oder
   * null ohne `moduleHooks`.
   */
  readonly moduleHooks: ModuleHooks | null;
  /** Hinweise aus der Prüfung der Module (z. B. Produktmodul ohne Code); API und Worker melden sie beim Start. */
  readonly warnings: readonly string[];
  openApi(): Promise<Record<string, unknown>>;
  envDocs(o?: EnvDocsOptions): { env: string; md: string };
  rotateKeys(o: { db: Db; keys: Keyring; dryRun?: boolean }): Promise<Record<string, number>>;
  readonly tenants: {
    list: typeof tenantList;
    /** Anlegen; mit `paket` nur dessen Module erlaubt und aktiv (sonst wie bisher: alle beim ersten Laden). */
    create(d: TenantDbs, alias: string, name?: string, o?: { paket?: string }): ReturnType<typeof tenantCreate>;
    /** Module einer Organisation lesen bzw. freigeben, entziehen oder ein Paket anwenden (Betrieb). */
    modules(d: TenantDbs, alias: string, change?: TenantModulesChange): Promise<TenantModulesResult>;
    suspend(d: TenantDbs, alias: string, reason?: string): ReturnType<typeof tenantSuspend>;
    resume(d: TenantDbs, alias: string): ReturnType<typeof tenantResume>;
    delete(d: TenantDbs, alias: string, confirm: string): ReturnType<typeof tenantDelete>;
  };
}

/** Teil eines Code-Moduls mit dessen `modul`, sofern der Teil keines nennt. */
const withModul = <T extends { modul?: string }>(x: T, modul: string | undefined): T => (x.modul === undefined && modul !== undefined ? { ...x, modul } : x);

export function defineApp(spec: AppSpec): PlatformApp {
  const { platform } = spec;
  const ctx = platform.context;
  const events = spec.iamEvents ?? null;
  if (spec.moduleHooks && Object.keys(spec.moduleHooks).length && !platform.model.features.modules) throw new Error('moduleHooks ohne modules im Modell');
  const hooks = moduleHooksFor(ctx, spec.moduleHooks ?? null);
  const hookOpts = hooks ? { moduleHooks: hooks } : {};
  // Verwaltung im Worker über dessen Pool; ohne Zugang zu Keycloak (der Worker bekommt das Geheimnis nur, wenn er es braucht) null
  const workerAdmin = (cfg: PlatformConfig, db: Db, o: CreateWorkerOptions) => {
    const m = cfg.mgmt;
    if (!m.clientId || !(m.privateKey || m.clientSecret)) return null;
    return createIam({ cfg, model: platform.model, resources: platform.resources, db, schema: ctx.schema, audit: platform.audit, events, bff: false, ...hookOpts, ...o.iam }).admin;
  };
  const warnings = checkModules(spec.modules, platform.model);
  checkPublicRoutes(spec.modules.flatMap(m => m.publicRoutes ?? []), platform.model.scopes);
  const modules = spec.ui === false ? [...spec.modules] : [...spec.modules, uiModule];
  const vars = platformVars(ctx.product, spec.vars);
  const tools: Record<string, ToolDef> = Object.assign({}, ...spec.modules.map(m => Object.fromEntries(Object.entries(m.mcpTools ?? {}).map(([k, t]) => [k, withModul(t, m.modul)]))));
  const modulesCtx = () => ({ model: platform.model, audit: platform.audit, events, hooks });
  if (Object.keys(platform.model.mcpTools).length || Object.keys(tools).length) checkTools({ model: platform.model, tools });
  const people = spec.people ? { people: spec.people } : {};

  return {
    platform, modules, vars, tools, iamEvents: events, moduleHooks: hooks, warnings,
    loadConfig: (env, service) => loadPlatformConfig(env, service, vars, spec.check),
    configOrExit: (env, service) => configOrExit(env, service, vars, spec.check),
    async createApi(cfg, db, o = {}) {
      const iam = createIam({ cfg, model: platform.model, resources: platform.resources, db, schema: ctx.schema, audit: platform.audit, events, ...hookOpts, ...o.iam });
      const app = await buildApp({ platform: ctx, cfg, db, iam, ready: o.ready ?? (() => true) }, { modules, ...people, ...(o.fastify ? { fastify: o.fastify } : {}) });
      return { app, iam };
    },
    createWorker: (cfg, db, log, o = {}) => new Worker({
      platform: ctx, fullTx: platform.fullTx, db, cfg, log, admin: workerAdmin(cfg, db, o), model: platform.model,
      // Teile ohne eigenes modul erhalten das des Code-Moduls (auch ohne defineModule)
      jobs: [...spec.modules.flatMap(m => (m.jobs ?? []).map(j => withModul(j, m.modul))), ...(hooks ? [nachholenJob(ctx, spec.moduleHooks ?? {}, platform.model)] : [])],
      tasks: [
        purgeSharedStateTask, retentionTask,
        outboxTask(spec.modules.flatMap(m => (m.consumers ?? []).map(c => withModul(c, m.modul))), platform.model),
        ...spec.modules.flatMap(m => (m.tasks ?? []).map(t => withModul(t, m.modul))),
      ],
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
      create: (d, alias, name, o = {}) => tenantCreate(ctx, d, alias, name, { ...modulesCtx(), ...(o.paket ? { paket: o.paket } : {}) }),
      modules: (d, alias, change = {}) => tenantModules(ctx, d, alias, modulesCtx(), change),
      suspend: (d, alias, reason) => tenantSuspend(ctx, d, alias, reason),
      resume: (d, alias) => tenantResume(ctx, d, alias),
      delete: (d, alias, confirm) => tenantDelete(ctx, d, alias, confirm),
    },
  };
}
