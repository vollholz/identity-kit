/**
 * Modul `clients`: Freigabe von Maschinen-Clients je Mandant (aus Assets `modules/admin/clients.ts`).
 *
 * Welche Organisation ein Service-Account-Token trägt, bestimmt ein Mapper in Keycloak (Hardcoded-Claim). Ein falsch
 * eingerichteter Client hätte damit Zugriff auf eine fremde Organisation. Das Paket nimmt ein Token deshalb nur für
 * Mandanten an, in denen die Client-ID hier freigegeben ist – sonst 403 «Client nicht freigegeben».
 *
 * - /v1/admin/clients                              eigene Organisation (Recht `members:admin`, nur Personen)
 * - /v1/platform/organizations/{alias}/clients     beliebige Organisation (Realm-Rolle platform-admin)
 * Braucht keinen Verwaltungs-Client in Keycloak. Jede Änderung steht im Protokoll des Mandanten.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenant, type Tx } from '../db.ts';
import { forbidden, notFound } from '../errors.ts';
import type { Principal } from '../principal.ts';
import { findTenant } from '../tenants.ts';
import { DateTime, Nullable, personOf, routeSchema, type IamModule, type ModuleContext } from './routes.ts';

const TAG_CLIENTS = 'Verwaltung: Maschinen-Clients';
const CLIENT_ID = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$';
const ClientGrant = Type.Object({
  clientId: Type.String({ description: 'Client-ID in Keycloak (`azp` des Service-Account-Tokens)' }),
  description: Type.String(),
  createdAt: DateTime,
  createdBy: Nullable(Type.String({ description: 'Wer freigegeben hat (Name)' })),
  lastUsedAt: Nullable(DateTime),
  lastRoles: Nullable(Type.Array(Type.String(), { description: 'Rollen im Token beim letzten Zugriff (Rollen verwaltet Keycloak)' })),
  lastScopes: Nullable(Type.Array(Type.String(), { description: 'Scopes im Token beim letzten Zugriff' })),
}, { $id: 'ClientGrant', title: 'ClientGrant', description: '`lastUsedAt`, `lastRoles`, `lastScopes`: letzter Zugriff dieses Clients in diesem Mandanten; `null`, solange der Client ihn nie benutzt hat.' });

interface Row { client_id: string; description: string; created_at: Date; created_by_name: string | null; last_used_at: Date | null; last_roles: string[] | null; last_scopes: string[] | null }
const out = (r: Row) => ({
  clientId: r.client_id, description: r.description, createdAt: r.created_at, createdBy: r.created_by_name, lastUsedAt: r.last_used_at,
  lastRoles: r.last_roles, lastScopes: r.last_scopes,
});

interface Target { tenantId: string; alias: string; actor: Principal; platform: boolean }

export const clientsModule: IamModule = {
  name: 'clients',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const S = iam.schema;
    app.addSchema(ClientGrant);

    const own = async (req: FastifyRequest): Promise<Target> => {
      const p = personOf(req);
      await req.need('members:admin');
      return { tenantId: p.tenantId, alias: p.tenantAlias, actor: p, platform: false };
    };
    const platform = async (req: FastifyRequest): Promise<Target> => {
      const p = personOf(req);
      if (!p.platformAdmin) throw forbidden(`Nur für die Plattform-Administration (Realm-Rolle ${iam.cfg.tenancy.platformAdminRole}).`);
      const alias = (req.params as { alias: string }).alias;
      const t = await findTenant(iam.db, alias);
      if (!t) throw notFound(`Organisation «${alias}» (noch nie benutzt – zuerst eine Person einladen oder anmelden lassen)`);
      return { tenantId: t.id, alias: t.alias, actor: p, platform: true };
    };
    const inTenant = <T>(t: Target, fn: (tx: Tx) => Promise<T>) => withTenant(iam.db, { tenantId: t.tenantId }, fn);
    const record = (req: FastifyRequest, tx: Tx, t: Target, action: string, data: Record<string, unknown>) => iam.audit.write(tx, {
      principal: { kind: t.actor.kind, principalId: t.actor.principalId, name: t.actor.name, clientId: t.actor.clientId }, source: req.source, correlationId: req.id,
    }, { action, resourceType: 'client', resourceId: null, data: { ...data, ...(t.platform ? { platformAdmin: true, actorTenant: t.actor.tenantAlias } : {}) } });
    const list = (t: Target) => inTenant(t, async tx => (await tx.query<Row>(
      `SELECT g.client_id, g.description, g.created_at, g.created_by_name, p.last_seen_at AS last_used_at, p.last_roles, p.last_scopes
       FROM ${S}.client_grant g
       LEFT JOIN LATERAL (SELECT last_seen_at, last_roles, last_scopes FROM ${S}.principal p
         WHERE p.kind = 'client' AND p.client_id = g.client_id ORDER BY p.last_seen_at DESC NULLS LAST LIMIT 1) p ON true
       ORDER BY g.client_id`)).rows.map(out));

    const routes = (base: string, scope: (req: FastifyRequest) => Promise<Target>, aliasParam: boolean) => {
      const Alias = { alias: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,62}$' }) };
      const params = Type.Object({ ...(aliasParam ? Alias : {}), clientId: Type.String({ pattern: CLIENT_ID }) });
      app.get(base, {
        schema: routeSchema(ctx, 'GET', base, { tags: [TAG_CLIENTS], summary: 'Freigegebene Maschinen-Clients', ...(aliasParam ? { params: Type.Object(Alias) } : {}), response: { 200: Type.Object({ items: Type.Array(Type.Ref('ClientGrant')) }) } }),
      }, async req => ({ items: await list(await scope(req)) }));

      app.put(`${base}/:clientId`, {
        schema: routeSchema(ctx, 'PUT', `${base}/:clientId`, {
          tags: [TAG_CLIENTS], summary: 'Maschinen-Client freigeben', params, body: Type.Object({ description: Type.Optional(Type.String({ maxLength: 500 })) }, { additionalProperties: false }),
          description: 'Erlaubt Service-Account-Tokens dieses Clients den Zugriff auf diese Organisation (zusätzlich zum Claim `organization` aus Keycloak). Rechte bleiben Client-Rollen ∩ Scopes. Idempotent; ändert nur die Beschreibung, wenn schon freigegeben.',
          response: { 200: Type.Ref('ClientGrant'), 201: Type.Ref('ClientGrant') },
        }),
      }, async (req, reply) => {
        const t = await scope(req);
        const { clientId } = req.params as { clientId: string };
        const description = (req.body as { description?: string } | undefined)?.description?.trim() ?? '';
        const r = await inTenant(t, async tx => {
          const row = (await tx.query<Row & { inserted: boolean }>(
            `INSERT INTO ${S}.client_grant AS g (tenant_id, client_id, description, created_by_name) VALUES (app.tenant_id(), $1, $2, $3)
             ON CONFLICT (tenant_id, client_id) DO UPDATE SET description = excluded.description
             RETURNING client_id, description, created_at, created_by_name, NULL::timestamptz AS last_used_at, NULL::text[] AS last_roles, NULL::text[] AS last_scopes, (xmax = 0) AS inserted`, [clientId, description, t.actor.name])).rows[0]!;
          await record(req, tx, t, row.inserted ? 'client.granted' : 'client.grant_updated', { clientId, description });
          return row;
        });
        iam.resolver.forgetClient(t.tenantId, clientId);
        return reply.status(r.inserted ? 201 : 200).send(out(r));
      });

      app.delete(`${base}/:clientId`, {
        schema: routeSchema(ctx, 'DELETE', `${base}/:clientId`, { tags: [TAG_CLIENTS], summary: 'Freigabe entziehen', params, description: 'Tokens dieses Clients werden ab sofort abgewiesen (andere API-Instanzen nach spätestens einer Minute).', response: { 204: Type.Null() } }),
      }, async (req, reply) => {
        const t = await scope(req);
        const { clientId } = req.params as { clientId: string };
        await inTenant(t, async tx => {
          if (!(await tx.query(`DELETE FROM ${S}.client_grant WHERE client_id = $1`, [clientId])).rowCount) throw notFound('Freigabe');
          await record(req, tx, t, 'client.revoked', { clientId });
        });
        iam.resolver.forgetClient(t.tenantId, clientId);
        return reply.status(204).send(null);
      });
    };
    routes(`${prefix}/admin/clients`, own, false);
    routes(`${prefix}/platform/organizations/:alias/clients`, platform, true);
  },
};
