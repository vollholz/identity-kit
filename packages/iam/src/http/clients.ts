/**
 * Modul `clients`: Freigabe von Maschinen-Clients je Mandant (Spezifikation Kap. 9.6, 12.1; A3, A18).
 *
 * Welche Organisation ein Service-Account-Token trägt, bestimmt ein Mapper in Keycloak. Ein falsch eingerichteter Client
 * hätte damit Zugriff auf eine fremde Organisation. Ein Token gilt deshalb nur in Mandanten, in denen der Client mit
 * mindestens einem nicht abgelaufenen Tupel `client:<id> <rolle> org` freigegeben ist – sonst 403 «Client nicht
 * freigegeben». Die Freigabe legt den Principal des Clients an (A18); Rollen sind Tupel an org, nie an anderen Orten.
 *
 * - /v1/admin/clients                              eigene Organisation (Recht `members:admin`, nur Personen)
 * - /v1/platform/organizations/{alias}/clients     beliebige Organisation (Realm-Rolle platform-admin)
 * Braucht keinen Verwaltungs-Client in Keycloak. Regeln wie bei Mitgliedern (rules.ts); Audit `client.granted`,
 * `client.revoked`, je entferntem Tupel `access.revoked`.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from '../audit.ts';
import { withTenant, type Tx } from '../db.ts';
import { forbidden, notFound } from '../errors.ts';
import type { Level } from '../model.ts';
import { checkRoleChange, setClearance, setOrgRoles, type Acting } from '../rules.ts';
import { findTenant } from '../tenants.ts';
import { DateTime, Nullable, personOf, platformOf, routeSchema, type IamModule, type ModuleContext } from './routes.ts';

const TAG_CLIENTS = 'Verwaltung: Mitglieder und Rollen';
export const CLIENT_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$';
const LevelT = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]);

export const ClientSchema = Type.Object({
  clientId: Type.String({ description: 'Client-ID in Keycloak (`azp` des Service-Account-Tokens)' }),
  principalId: Type.String({ description: 'Subjekt `client:<principalId>`' }),
  description: Type.String(),
  roles: Type.Array(Type.String(), { description: 'Rollen an der Organisation (Tupel)' }),
  clearance: LevelT,
  places: Type.Integer({ description: 'Freigaben an anderen Orten als der Organisation (bei Clients immer 0, A3)' }),
  createdAt: DateTime,
  createdBy: Nullable(Type.String({ description: 'Wer freigegeben hat (Name)' })),
  lastUsedAt: Nullable(DateTime),
  lastScopes: Nullable(Type.Array(Type.String(), { description: 'Scopes im Token beim letzten Zugriff' })),
}, { $id: 'Client', title: 'Client', description: '`lastUsedAt`, `lastScopes`: letzter Zugriff in diesem Mandanten; `null`, solange der Client ihn nie benutzt hat.' });

export interface ClientOut {
  clientId: string; principalId: string; description: string; roles: string[]; clearance: Level; places: number;
  createdAt: Date; createdBy: string | null; lastUsedAt: Date | null; lastScopes: string[] | null;
}
interface Row { id: string; client_id: string; description: string; clearance: Level; created_at: Date; created_by_name: string | null; last_seen_at: Date | null; last_scopes: string[] | null; roles: string[]; places: number }

/** Freigegebene Clients des Mandanten (mit mindestens einem Tupel), Rollen an org in Reihenfolge des Modells. */
export async function listClients(tx: Tx, schema: string, roleOrder: readonly string[], clientId?: string): Promise<ClientOut[]> {
  const rows = (await tx.query<Row>(
    `SELECT p.id, p.client_id, p.description, p.clearance, p.created_at, p.created_by_name, p.last_seen_at, p.last_scopes,
            coalesce(array_agg(t.relation) FILTER (WHERE t.object_type = 'org' AND (t.expires_at IS NULL OR t.expires_at > now())), '{}') AS roles,
            count(t.id) FILTER (WHERE t.object_type <> 'org')::int AS places
       FROM ${schema}.principal p JOIN ${schema}.authz_tuple t ON t.subject = 'client:' || p.id
      WHERE p.kind = 'client' ${clientId ? 'AND p.client_id = $1' : ''}
      GROUP BY p.tenant_id, p.id ORDER BY p.client_id`, clientId ? [clientId] : [])).rows;
  return rows.map(r => ({
    clientId: r.client_id, principalId: r.id, description: r.description, roles: roleOrder.filter(x => r.roles.includes(x)), clearance: r.clearance, places: r.places,
    createdAt: r.created_at, createdBy: r.created_by_name, lastUsedAt: r.last_seen_at, lastScopes: r.last_scopes,
  }));
}

interface Target extends Acting { tenantId: string; alias: string }

export const clientsModule: IamModule = {
  name: 'clients',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const S = iam.schema;
    const roleOrder = [...iam.model.roles.keys()];
    if (!app.getSchema('Client')) app.addSchema(ClientSchema);

    const own = async (req: FastifyRequest): Promise<Target> => {
      const p = personOf(req);
      await req.need('members:admin');
      return { tenantId: p.tenantId, alias: p.tenantAlias, actor: p, platform: false };
    };
    const platform = async (req: FastifyRequest): Promise<Target> => {
      const p = platformOf(req, iam.cfg.tenancy.platformAdminRole);
      const alias = (req.params as { alias: string }).alias;
      const t = await findTenant(iam.db, alias);
      if (!t) throw notFound(`Organisation «${alias}»`);
      return { tenantId: t.id, alias: t.alias, actor: p, platform: true };
    };
    const inTenant = <T>(t: Target, fn: (tx: Tx) => Promise<T>) => withTenant(iam.db, { tenantId: t.tenantId, principalId: t.platform ? null : t.actor.principalId }, fn);
    const actorOf = (req: FastifyRequest, t: Target): Actor & { extra?: Record<string, unknown> } => ({
      principal: { kind: t.actor.kind, principalId: t.actor.principalId, name: t.actor.name, clientId: t.actor.clientId }, source: req.source, correlationId: req.id,
      ...(t.platform ? { extra: { platformAdmin: true } } : {}),
    });
    const record = (req: FastifyRequest, tx: Tx, t: Target, action: string, principalId: string, data: Record<string, unknown>) => {
      const a = actorOf(req, t);
      return iam.audit.write(tx, a, { action, resourceType: 'client', resourceId: principalId, data: { ...data, ...a.extra } });
    };

    const routes = (base: string, scope: (req: FastifyRequest) => Promise<Target>, aliasParam: boolean) => {
      const Alias = { alias: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,62}$' }) };
      const params = Type.Object({ ...(aliasParam ? Alias : {}), clientId: Type.String({ pattern: CLIENT_ID_PATTERN }) });
      app.get(base, {
        schema: routeSchema(ctx, 'GET', base, { tags: [TAG_CLIENTS], summary: 'Freigegebene Maschinen-Clients', ...(aliasParam ? { params: Type.Object(Alias) } : {}), response: { 200: Type.Object({ items: Type.Array(Type.Ref('Client')) }) } }),
      }, async req => { const t = await scope(req); return { items: await inTenant(t, tx => listClients(tx, S, roleOrder)) }; });

      app.put(`${base}/:clientId`, {
        schema: routeSchema(ctx, 'PUT', `${base}/:clientId`, {
          tags: [TAG_CLIENTS], summary: 'Maschinen-Client freigeben, Rollen und Freigabestufe setzen', params,
          body: Type.Object({
            roles: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 20, uniqueItems: true }),
            description: Type.Optional(Type.String({ maxLength: 500, description: 'Fehlt: bleibt' })),
            clearance: Type.Optional(LevelT),
          }, { additionalProperties: false }),
          description: 'Setzt die Rollen des Clients an der Organisation auf genau diese Liste (Tupel `client:<id> <rolle> org`) und legt den Principal an, falls neu. Regeln wie bei Mitgliedern: `org-admin` nur die Plattform-Administration, niemand gibt mehr, als er hat, Freigabestufe nie über die eigene.',
          response: { 200: Type.Ref('Client') },
        }),
      }, async req => {
        const t = await scope(req);
        const { clientId } = req.params as { clientId: string };
        const b = req.body as { roles: string[]; description?: string; clearance?: Level };
        const out = await inTenant(t, async tx => {
          const id = (await tx.query<{ id: string }>(
            `INSERT INTO ${S}.principal AS p (tenant_id, kind, subject, client_id, display_name, description, created_by_name, last_seen_at)
             VALUES (app.tenant_id(), 'client', $1, $1, $1, $2, $3, NULL)
             ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET description = coalesce($4, p.description), removed_at = NULL
             RETURNING id`, [clientId, b.description?.trim() ?? '', t.actor.name, b.description === undefined ? null : b.description.trim()])).rows[0]!.id;
          await setOrgRoles(tx, { access: iam.access, tuples: iam.tuples, schema: S, acting: t, subject: `client:${id}`, roles: b.roles, createdBy: t.platform ? null : t.actor.principalId });
          if (b.clearance !== undefined) await setClearance(tx, { access: iam.access, schema: S, acting: t, principalId: id, clearance: b.clearance });
          const c = (await listClients(tx, S, roleOrder, clientId))[0]!;
          await record(req, tx, t, 'client.granted', id, { clientId, roles: c.roles, clearance: c.clearance });
          return c;
        });
        iam.access.invalidate(t.tenantId);
        return out;
      });

      app.delete(`${base}/:clientId`, {
        schema: routeSchema(ctx, 'DELETE', `${base}/:clientId`, { tags: [TAG_CLIENTS], summary: 'Freigabe entziehen', params, description: 'Löscht alle Tupel des Clients; seine Tokens werden ab sofort abgewiesen.', response: { 204: Type.Null() } }),
      }, async (req, reply) => {
        const t = await scope(req);
        const { clientId } = req.params as { clientId: string };
        await inTenant(t, async tx => {
          const id = (await tx.query<{ id: string }>(`SELECT id FROM ${S}.principal WHERE kind = 'client' AND client_id = $1`, [clientId])).rows[0]?.id;
          if (!id) throw notFound('Freigabe');
          const roles = (await tx.query<{ relation: string }>(`SELECT relation FROM ${S}.authz_tuple WHERE subject = $1 AND object_type = 'org'`, [`client:${id}`])).rows.map(r => r.relation);
          if (!roles.length) throw notFound('Freigabe');
          await checkRoleChange(iam.access, t, roles);
          await iam.tuples.revokeSubject(tx, `client:${id}`, actorOf(req, t));
          await record(req, tx, t, 'client.revoked', id, { clientId });
        });
        iam.access.invalidate(t.tenantId);
        return reply.status(204).send(null);
      });
    };
    routes(`${prefix}/admin/clients`, own, false);
    routes(`${prefix}/platform/organizations/:alias/clients`, platform, true);
  },
};
