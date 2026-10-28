/**
 * Modul `roles`: eigene Rollen der Organisation (roles.ts; Recht `roles:admin`, nur Personen). Nur mit
 * `features.customRoles` des Modells (Standard).
 *
 * - /v1/admin/roles                             eigene Organisation
 * - /v1/platform/organizations/{alias}/roles    beliebige Organisation (Realm-Rolle platform-admin)
 *
 * Vergeben werden eigene Rollen wie Rollen des Modells (`PUT …/members/{id}/roles`, `POST /v1/access`); welche es gibt
 * und wo sie hängen dürfen, steht für alle in `GET /v1/authz/catalog` (`custom: true`).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from '../audit.ts';
import { withTenant, type Tx } from '../db.ts';
import { notFound } from '../errors.ts';
import { CUSTOM_ROLE_SQL } from '../model.ts';
import type { CustomRoleInput } from '../roles.ts';
import type { Acting } from '../rules.ts';
import { findTenant } from '../tenants.ts';
import { DateTime, personOf, platformOf, routeSchema, type IamModule, type ModuleContext } from './routes.ts';

const TAG_ROLES = 'Verwaltung: Mitglieder und Rollen';

interface Target extends Acting { tenantId: string }

export const CustomRoleSchema = Type.Object({
  key: Type.String({ description: 'Schlüssel (`c-…`); Relation der Tupel, nie gleich einer Rolle des Modells' }),
  label: Type.String(), description: Type.String(),
  permissions: Type.Array(Type.String(), { description: 'Rechte aus dem Modell der App (keine, die nur org-admin hat)' }),
  places: Type.Array(Type.String(), { description: 'Typen, an denen die Rolle vergeben werden darf (`org` für die Organisation)' }),
  assignments: Type.Integer({ description: 'Vergaben (Tupel); löschen und Orte entfernen erst bei 0 am Ort' }),
  createdAt: DateTime, updatedAt: DateTime,
}, { $id: 'CustomRole', title: 'CustomRole' });

export const rolesModule: IamModule = {
  name: 'roles',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const svc = iam.roles;
    if (!svc) return;
    if (!app.getSchema('CustomRole')) app.addSchema(CustomRoleSchema);
    const model = iam.model;
    const Permission = Type.Unsafe<string>({ type: 'string', enum: model.permissions.filter(p => !model.adminOnly.has(p)) });
    const Place = Type.Unsafe<string>({ type: 'string', enum: [...model.types.keys()] });
    const Body = Type.Object({
      label: Type.String({ minLength: 1, maxLength: 80 }),
      description: Type.Optional(Type.String({ maxLength: 500 })),
      permissions: Type.Array(Permission, { minItems: 1, maxItems: 200, uniqueItems: true }),
      places: Type.Array(Place, { minItems: 1, maxItems: 50, uniqueItems: true }),
    }, { additionalProperties: false });
    const CreateBody = Type.Object({ key: Type.Optional(Type.String({ pattern: CUSTOM_ROLE_SQL })), ...Body.properties }, { additionalProperties: false });
    const Key = { key: Type.String({ pattern: CUSTOM_ROLE_SQL }) };

    const own = async (req: FastifyRequest): Promise<Target> => {
      const p = personOf(req);
      await req.need('roles:admin');
      return { tenantId: p.tenantId, actor: p, platform: false };
    };
    const platform = async (req: FastifyRequest): Promise<Target> => {
      const p = platformOf(req, iam.cfg.tenancy.platformAdminRole);
      const alias = (req.params as { alias: string }).alias;
      const t = await findTenant(iam.db, alias);
      if (!t) throw notFound(`Organisation «${alias}»`);
      return { tenantId: t.id, actor: p, platform: true };
    };
    const inTenant = async <T>(t: Target, fn: (tx: Tx) => Promise<T>, write = false) => {
      const r = await withTenant(iam.db, { tenantId: t.tenantId, principalId: t.platform ? null : t.actor.principalId }, fn);
      if (write) iam.access.invalidate(t.tenantId);
      return r;
    };
    const actorOf = (req: FastifyRequest, t: Target): Actor => ({
      principal: { kind: t.actor.kind, principalId: t.actor.principalId, name: t.actor.name, clientId: t.actor.clientId }, source: req.source, correlationId: req.id,
    });

    const routes = (base: string, scope: (req: FastifyRequest) => Promise<Target>, aliasParam: boolean) => {
      const Alias = { alias: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,62}$' }) };
      const params = Type.Object({ ...(aliasParam ? Alias : {}), ...Key });
      const why = 'Recht «Rollen zusammenstellen» (roles:admin); niemand gibt mehr, als er hat (403 `exceeds-own`).';
      app.get(base, {
        schema: routeSchema(ctx, 'GET', base, {
          tags: [TAG_ROLES], summary: 'Eigene Rollen der Organisation', ...(aliasParam ? { params: Type.Object(Alias) } : {}),
          description: 'Eigene Rollen mit Rechten, Orten und Zahl der Vergaben. Die Rollen des Modells (Vorgabe, nicht änderbar) stehen im Katalog (`GET /v1/authz/catalog`).',
          response: { 200: Type.Object({ items: Type.Array(Type.Ref('CustomRole')) }) },
        }),
      }, async req => { const t = await scope(req); return { items: await inTenant(t, tx => svc.list(tx)) }; });

      app.post(base, {
        schema: routeSchema(ctx, 'POST', base, {
          tags: [TAG_ROLES], summary: 'Eigene Rolle anlegen', ...(aliasParam ? { params: Type.Object(Alias) } : {}), body: CreateBody,
          description: `Stellt eine Rolle aus Rechten des Modells zusammen. Ohne \`key\` entsteht er aus dem Namen (\`c-…\`). Rechte, die nur org-admin hat, und unbekannte Orte ergeben 422; mehr als 50 Rollen 409 \`limit\`, gleicher Name 409 \`duplicate-label\`. ${why}`,
          response: { 201: Type.Ref('CustomRole') },
        }),
      }, async (req, reply) => {
        const t = await scope(req);
        const r = await inTenant(t, tx => svc.create(tx, t, actorOf(req, t), req.body as CustomRoleInput), true);
        return reply.status(201).send(r);
      });

      app.put(`${base}/:key`, {
        schema: routeSchema(ctx, 'PUT', `${base}/:key`, {
          tags: [TAG_ROLES], summary: 'Eigene Rolle ändern', params, body: Body,
          description: `Name, Beschreibung, Rechte und Orte setzen; gilt sofort für alle, die die Rolle haben. Einen Ort entfernen geht nur, wo die Rolle nicht vergeben ist (409 \`in-use\`). Wer ändert, braucht die Rechte vorher und nachher. ${why}`,
          response: { 200: Type.Ref('CustomRole') },
        }),
      }, async req => {
        const t = await scope(req);
        return inTenant(t, tx => svc.update(tx, t, actorOf(req, t), (req.params as { key: string }).key, req.body as Omit<CustomRoleInput, 'key'>), true);
      });

      app.delete(`${base}/:key`, {
        schema: routeSchema(ctx, 'DELETE', `${base}/:key`, {
          tags: [TAG_ROLES], summary: 'Eigene Rolle löschen', params,
          description: `Nur, wenn sie nirgends mehr vergeben ist (409 \`in-use\` mit \`assignments\`). ${why}`,
          response: { 204: Type.Null() },
        }),
      }, async (req, reply) => {
        const t = await scope(req);
        await inTenant(t, tx => svc.remove(tx, t, actorOf(req, t), (req.params as { key: string }).key), true);
        return reply.status(204).send(null);
      });
    };
    routes(`${prefix}/admin/roles`, own, false);
    routes(`${prefix}/platform/organizations/:alias/roles`, platform, true);
  },
};
