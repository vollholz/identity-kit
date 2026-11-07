/**
 * Modul `modules`: Produktmodule je Organisation (modules.ts; Konzept «Module je Organisation», Abschnitt 5). Nur mit
 * `modules` im Modell der App.
 *
 * - /v1/tenant/modules                               eigene Organisation: lesen (`tenant:read`), schalten (`tenant:admin`)
 * - /v1/platform/organizations/{alias}/modules       beliebige Organisation: freigeben und entziehen (Realm-Rolle platform-admin)
 *
 * Version für `If-Match` und `ETag` ist `tenant.acl_version` (ändert sich auch mit Rollen und Freigaben). Die aktiven
 * Module je Sitzung stehen in `GET /v1/me` und `GET /auth/me` (`modules`).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '../audit.ts';
import { schemaName, withTenant, type Tx } from '../db.ts';
import { notFound } from '../errors.ts';
import { MODULE_REF_SQL } from '../model.ts';
import { versionMismatch, type ModuleActing, type ModuleState, type TenantModules } from '../modules.ts';
import { findTenant } from '../tenants.ts';
import { DateTime, etag, ifMatchVersion, Nullable, platformOf, routeSchema, type IamModule, type ModuleContext } from './routes.ts';

const TAG_TENANT = 'Organisation';
const TAG_ORGS = 'Plattform: Organisationen';

const Blocker = Type.Object({
  key: Type.String(), text: Type.String({ description: 'Text der App, z. B. «3 offene Anträge – zuerst entscheiden»' }),
  anzahl: Type.Optional(Type.Integer()),
});

export const TenantModuleSchema = Type.Object({
  key: Type.String({ description: 'Modul oder Teilfunktion `modul.teil`' }),
  label: Type.String(), description: Type.String(),
  core: Type.Boolean({ description: 'Kern: immer aktiv, nicht abschaltbar' }),
  requires: Type.Array(Type.Union([Type.String(), Type.Array(Type.String())]), { description: 'Voraussetzungen: Schlüssel (Pflicht) oder Liste (eines davon); bei Teilfunktionen leer' }),
  module: Nullable(Type.String({ description: 'Modul einer Teilfunktion; null bei Modulen' })),
  allowed: Type.Boolean({ description: 'Für die Organisation freigegeben (setzt der Betrieb)' }),
  active: Type.Boolean({ description: 'In der Organisation aktiv (setzt die Organisation; nur, wenn freigegeben)' }),
  activeSince: Nullable(DateTime),
  blockers: Type.Optional(Type.Array(Blocker, { description: 'Nur mit `tenant:admin` bzw. für die Plattform-Administration, nur bei aktiven Modulen: was ein Deaktivieren verhindert (Haken `hindernisse` der App)' })),
}, { $id: 'TenantModule', title: 'TenantModule' });

const Key = Type.String({ pattern: MODULE_REF_SQL });
const Alias = Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,62}$' });

export const modulesModule: IamModule = {
  name: 'modules',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const svc = iam.modules as TenantModules | null;
    if (!svc) return;
    if (!app.getSchema('TenantModule')) app.addSchema(TenantModuleSchema);
    const S = schemaName(iam.schema);
    const List = Type.Object({ items: Type.Array(Type.Ref('TenantModule')) });

    const actorOf = (req: FastifyRequest, p: { kind: 'user' | 'client'; principalId: string; name: string; clientId: string | null }): Actor => ({
      principal: { kind: p.kind, principalId: p.principalId, name: p.name, clientId: p.clientId }, source: req.source, correlationId: req.id,
    });
    const version = async (tx: Tx, lock = false) => Number((await tx.query<{ v: string }>(`SELECT acl_version::text AS v FROM ${S}.tenant WHERE id = app.tenant_id()${lock ? ' FOR UPDATE' : ''}`)).rows[0]?.v ?? 0);
    const withBlockers = async (tx: Tx, tenantId: string, items: ModuleState[]) => Promise.all(items.map(async s => (
      s.active && !s.core ? { ...s, blockers: await svc.blockers(tx, tenantId, s.key) } : s)));
    const send = (reply: FastifyReply, v: number, body: unknown) => reply.header('ETag', etag(v)).send(body);

    // ---------------------------------------------------------------- eigene Organisation
    const own = `${prefix}/tenant/modules`;
    app.get(own, {
      schema: routeSchema(ctx, 'GET', own, {
        tags: [TAG_TENANT], summary: 'Produktmodule der Organisation',
        description: 'Je Modul und Teilfunktion: freigegeben (Betrieb), aktiv (Organisation), Voraussetzungen. Recht «Organisation lesen» (tenant:read); mit «Organisation verwalten» (tenant:admin) zusätzlich `blockers` aktiver Module. `ETag`: Version für `If-Match` beim Schalten.',
        response: { 200: List },
      }),
    }, async (req, reply) => {
      const p = req.requirePrincipal();
      await req.need('tenant:read');
      const admin = await req.can('tenant:admin');
      const out = await withTenant(iam.db, { tenantId: p.tenantId, principalId: p.principalId }, async tx => {
        const items = await svc.list(tx);
        return { items: admin ? await withBlockers(tx, p.tenantId, items) : items, v: await version(tx) };
      });
      return send(reply, out.v, { items: out.items });
    });

    app.put(`${own}/:key`, {
      schema: routeSchema(ctx, 'PUT', `${own}/:key`, {
        tags: [TAG_TENANT], summary: 'Produktmodul aktivieren oder deaktivieren', params: Type.Object({ key: Key }),
        body: Type.Object({ active: Type.Boolean() }, { additionalProperties: false }),
        description: 'Recht «Organisation verwalten» (tenant:admin). `If-Match` mit dem `ETag` der Liste (412, wenn sich inzwischen etwas geändert hat). Nicht freigegeben: 403 `modul-nicht-erlaubt`. Aktivieren: Voraussetzung inaktiv 409 `voraussetzung-fehlt` (`fehlt`), Teilfunktion ohne aktives Modul 409 `modul-inaktiv`. Deaktivieren: ein aktives Modul braucht es 409 `abhaengig-aktiv` (`module`), Hindernisse der App 409 `hindernisse` (`hindernisse`). Kern: 409 `kern`. Deaktivieren löscht keine Daten.',
        response: { 200: Type.Ref('TenantModule') },
      }),
    }, async (req, reply) => {
      const p = req.requirePrincipal();
      await req.need('tenant:admin');
      const want = ifMatchVersion(req.headers['if-match']);
      const { key } = req.params as { key: string };
      const t: ModuleActing = { tenantId: p.tenantId, actor: actorOf(req, p), platform: false };
      const out = await withTenant(iam.db, { tenantId: p.tenantId, principalId: p.principalId }, async tx => {
        if (want !== undefined && (await version(tx, true)) !== want) throw versionMismatch();
        const s = await svc.setActive(tx, t, key, (req.body as { active: boolean }).active);
        return { s, v: await version(tx) };
      });
      return send(reply, out.v, out.s);
    });

    // ---------------------------------------------------------------- Plattform-Administration
    const plat = `${prefix}/platform/organizations/:alias/modules`;
    const target = async (req: FastifyRequest) => {
      const a = platformOf(req, iam.cfg.tenancy.platformAdminRole);
      const alias = (req.params as { alias: string }).alias;
      const tenant = await findTenant(iam.db, alias);
      if (!tenant) throw notFound(`Organisation «${alias}»`);
      return { tenantId: tenant.id, actor: actorOf(req, a), platform: true } satisfies ModuleActing;
    };
    app.get(plat, {
      schema: routeSchema(ctx, 'GET', plat, {
        tags: [TAG_ORGS], summary: 'Produktmodule einer Organisation', params: Type.Object({ alias: Alias }),
        description: 'Wie `GET /v1/tenant/modules`, mit `blockers` aktiver Module.',
        response: { 200: List },
      }),
    }, async (req, reply) => {
      const t = await target(req);
      const out = await withTenant(iam.db, { tenantId: t.tenantId }, async tx => ({ items: await withBlockers(tx, t.tenantId, await svc.list(tx)), v: await version(tx) }));
      return send(reply, out.v, { items: out.items });
    });

    app.put(`${plat}/:key`, {
      schema: routeSchema(ctx, 'PUT', `${plat}/:key`, {
        tags: [TAG_ORGS], summary: 'Produktmodul freigeben oder entziehen', params: Type.Object({ alias: Alias, key: Key }),
        querystring: Type.Object({ force: Type.Optional(Type.Boolean({ description: 'Hindernisse der App übergehen' })) }, { additionalProperties: false }),
        body: Type.Object({ allowed: Type.Boolean() }, { additionalProperties: false }),
        description: 'Entziehen deaktiviert mit: ein aktives Modul braucht es 409 `abhaengig-aktiv`, Hindernisse der App 409 `hindernisse` (mit `?force=true` übergangen). Kern: 409 `kern`. `If-Match` optional. Protokoll in der Organisation und der Plattform.',
        response: { 200: Type.Ref('TenantModule') },
      }),
    }, async (req, reply) => {
      const t = await target(req);
      const want = ifMatchVersion(req.headers['if-match']);
      const { key } = req.params as { key: string };
      const out = await withTenant(iam.db, { tenantId: t.tenantId }, async tx => {
        if (want !== undefined && (await version(tx, true)) !== want) throw versionMismatch();
        const s = await svc.setAllowed(tx, t, key, (req.body as { allowed: boolean }).allowed, { force: (req.query as { force?: boolean }).force === true });
        return { s, v: await version(tx) };
      });
      return send(reply, out.v, out.s);
    });
  },
};
