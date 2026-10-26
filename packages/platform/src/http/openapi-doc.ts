/**
 * OpenAPI-Beschreibung ohne laufende Dienste (Export für den Client der Webapp): baut die Anwendung mit einer festen
 * Konfiguration für die Doku; Datenbank und Anmeldedienst werden dabei nie angesprochen.
 */
import { createIam, type Model, type ResourceModel, type VarSpec } from '@vollholz/iam';
import { loadPlatformConfig } from '../config/env.ts';
import type { PlatformContext } from '../context.ts';
import type { AuditPort } from '../core/audit.ts';
import { createPool } from '../db/pool.ts';
import type { PlatformModule } from '../module.ts';
import { buildApp } from './app.ts';

/** Feste Werte: Die Beschreibung hängt nicht von der Umgebung ab, in der exportiert wird. */
export function docEnv(ctx: PlatformContext, o: { publicBaseUrl?: string; issuer?: string } = {}): Record<string, string> {
  return {
    NODE_ENV: 'test', PUBLIC_BASE_URL: o.publicBaseUrl ?? `https://${ctx.product}.project-suite.ch`,
    OIDC_ISSUER_URL: o.issuer ?? `https://id.project-suite.ch/realms/${ctx.product}`,
    DATABASE_URL: 'postgres://doku@127.0.0.1:1/doku', KEYCLOAK_MGMT_CLIENT_ID: `${ctx.product}-admin`, KEYCLOAK_MGMT_CLIENT_SECRET: 'doku',
    OIDC_BFF_CLIENT_SECRET: 'doku', SESSION_SECRET: 'd'.repeat(32), ENCRYPTION_KEYS: `doku:${Buffer.alloc(32).toString('base64')}`, LOG_LEVEL: 'silent',
  };
}

export interface ExportOpenApiOptions {
  platform: PlatformContext;
  model: Model<string>;
  resources?: ResourceModel<any> | null;
  audit: AuditPort;
  vars: readonly VarSpec[];
  modules: readonly PlatformModule[];
  people?: { permissions?: string[] };
  /** Werte der Doku-Umgebung (Standard `docEnv`), ergänzt um Pflichtvariablen der App. */
  env?: Record<string, string>;
}

export async function exportOpenApi(o: ExportOpenApiOptions): Promise<Record<string, unknown>> {
  const cfg = loadPlatformConfig({ ...docEnv(o.platform), ...o.env }, null, o.vars);
  const db = createPool(cfg.db.url, cfg, `${o.platform.product}-openapi`);
  try {
    const iam = createIam({ cfg, model: o.model, resources: o.resources ?? null, db, schema: o.platform.schema, audit: o.audit });
    const app = await buildApp({ platform: o.platform, cfg, db, iam, ready: () => true }, { modules: o.modules, ...(o.people ? { people: o.people } : {}) });
    await app.ready();
    const doc = app.swagger() as unknown as Record<string, unknown>;
    await app.close();
    return doc;
  } finally { await db.end(); }
}
