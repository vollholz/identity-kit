/**
 * Modul `account`: angemeldeter Principal (`GET /v1/me`, `ApiMe`) und Katalog des Modells (`GET /v1/authz/catalog`,
 * Spezifikation Kap. 9.5). Der Katalog ist nicht vertraulich und braucht kein Recht.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Model } from '../model.ts';
import { Nullable, routeSchema, type IamModule, type ModuleContext } from './routes.ts';

const TAG_ACCOUNT = 'Konto';
const LevelT = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]);

/** Schema der Antwort von `GET /v1/authz/catalog` aus dem Modell der App (Aufzählungen der Schlüssel). */
export function authzCatalogSchema(model: Model) {
  const PermissionT = Type.Unsafe<string>({ type: 'string', enum: [...model.permissions] });
  const TypeT = Type.Unsafe<string>({ type: 'string', enum: [...model.types.keys()] });
  const GroupKeyT = Type.Unsafe<string>({ type: 'string', enum: model.groups.map(g => g.key) });
  return Type.Object({
    permissions: Type.Array(Type.Object({
      key: PermissionT, label: Type.String(), group: GroupKeyT, description: Type.String(),
      resources: Type.Array(TypeT, { description: 'Typen, an denen das Recht geprüft wird (immer mit org); bestimmen die Rechte von owner' }),
      adminOnly: Type.Boolean({ description: 'Steht bei keiner Rolle ausser org-admin (deren Rolle vergibt nur die Plattform-Administration)' }),
      personOnly: Type.Optional(Type.Boolean({ description: 'Nur für Personen: in keinem Scope, also nie für Maschinen-Clients und MCP (fehlt sonst)' })),
    }), { description: 'Alle Rechte in fester Reihenfolge' }),
    groups: Type.Array(Type.Object({
      key: GroupKeyT, label: Type.String(),
      match: Type.Optional(Type.String({ description: 'Stichwörter der Gruppe als regulärer Ausdruck (Gross/klein egal)' })),
    }), { description: 'Rechtegruppen in Anzeigereihenfolge' }),
    roles: Type.Array(Type.Object({
      key: Type.String(), label: Type.String(), description: Type.String({ description: 'Nennt alle Rechtegruppen der Rolle' }),
      permissions: Type.Array(PermissionT), adminOnly: Type.Boolean({ description: 'Nur die Plattform-Administration vergibt diese Rolle' }),
    })),
    scopes: Type.Array(Type.Object({ key: Type.String(), text: Type.String(), permissions: Type.Array(PermissionT) }), { description: 'OAuth-Scopes für Maschinen-Clients und MCP' }),
    types: Type.Array(Type.Object({
      key: TypeT, label: Type.String(), parent: Nullable(TypeT), self: Type.Optional(Type.Literal(true)),
      roles: Type.Array(Type.String(), { description: 'Rollen, die hier hängen dürfen (org: alle)' }),
      relations: Type.Array(Type.String(), { description: 'roles plus Beziehungen ohne Rechte (member) und owner, wo zulässig' }),
      leaf: Type.Optional(Type.Literal(true)), classified: Type.Optional(Type.Literal(true)), owner: Type.Optional(Type.Literal(true)), membersRole: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Object({ relation: Type.String() })),
      read: Type.Optional(PermissionT), write: Type.Optional(PermissionT),
    }), { description: 'Orte des Modells, org zuerst' }),
    classifications: Type.Array(Type.Object({ level: LevelT, label: Type.String() })),
    mcpTools: Type.Array(Type.Object({
      name: Type.String(), title: Type.String(), permission: PermissionT,
      scope: Nullable(Type.String({ description: `Scope, den das Recht im Token braucht; null beim Standard-Scope \`${model.product}:read\`` })),
      readOnly: Type.Boolean({ description: 'Werkzeug liest nur (`readOnlyHint`)' }),
    }), { description: 'Werkzeuge des MCP-Dienstes mit dem Recht, das sie brauchen' }),
  }, { title: 'AuthzCatalog' });
}

const MeOut = Type.Object({
  tenant: Type.Object({ id: Type.String(), alias: Type.String() }),
  principal: Type.Object({ id: Type.String(), kind: Type.Union([Type.Literal('user'), Type.Literal('client')]), name: Type.String(), email: Nullable(Type.String()), clientId: Nullable(Type.String()) }),
  roles: Type.Array(Type.String(), { description: 'Rollen an der Organisation (Tupel eines meiner Subjekte)' }),
  scopes: Type.Array(Type.String()),
  permissions: Type.Array(Type.String({ description: 'Rechte an der Organisation' })),
  somewhere: Type.Array(Type.String(), { description: 'Rechte, die an mindestens einem Ort gelten (Obermenge von permissions)' }),
  clearance: LevelT,
  breakGlassUntil: Nullable(Type.String({ format: 'date-time' })),
  tokenBinding: Type.String(),
}, { title: 'ApiMe' });

export const accountModule: IamModule = {
  name: 'account',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const json = iam.model.toJSON();

    app.get(`${prefix}/me`, {
      schema: routeSchema(ctx, 'GET', `${prefix}/me`, { tags: [TAG_ACCOUNT], summary: 'Angemeldeter Principal, Organisation, Rollen und Rechte', response: { 200: MeOut } }),
    }, async req => {
      const p = req.requirePrincipal();
      const acl = await iam.access.load(p.tenantId);
      return {
        tenant: { id: p.tenantId, alias: p.tenantAlias }, principal: { id: p.principalId, kind: p.kind, name: p.name, email: p.email, clientId: p.clientId },
        roles: iam.access.rolesAtOrg(p, acl), scopes: p.scopes, permissions: iam.access.orgPermissions(p, acl), somewhere: iam.access.somewherePermissions(p, acl, await iam.access.personGrants(p, p.tenantId)),
        clearance: iam.access.clearanceOf(p, acl), breakGlassUntil: iam.access.breakGlassUntil(acl, p.principalId)?.toISOString() ?? null,
        tokenBinding: p.binding,
      };
    });

    app.get(`${prefix}/authz/catalog`, {
      schema: routeSchema(ctx, 'GET', `${prefix}/authz/catalog`, {
        tags: [TAG_ACCOUNT], summary: 'Rechte, Rollen, Scopes und Orte mit Bezeichnungen',
        description: 'Für jede angemeldete Person und jeden Client, ohne Rechteprüfung (nicht vertraulich). Einzige Quelle für Labels, Rechtegruppen, Rollenbeschreibungen, Scope-Texte, Orte mit ihren Rollen, Stufen der Vertraulichkeit und die MCP-Werkzeuge mit ihrem Recht.',
        response: { 200: authzCatalogSchema(iam.model) },
      }),
    }, async (req, reply) => {
      req.requirePrincipal();
      reply.header('Vary', 'Accept-Language');
      return json;
    });
  },
};
