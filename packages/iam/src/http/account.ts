/**
 * Modul `account`: angemeldeter Principal (`GET /v1/me`) und Rechtekatalog (`GET /v1/authz/catalog`), aus Assets
 * `http/app.ts` und `modules/catalog/governance.ts`. Der Katalog ist nicht vertraulich und braucht kein Recht.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Catalog } from '../catalog.ts';
import { Nullable, routeSchema, type IamModule, type ModuleContext } from './routes.ts';

const TAG_ACCOUNT = 'Konto';

/** Schema der Antwort von `GET /v1/authz/catalog` aus dem Katalog der App (Aufzählungen der Schlüssel). */
export function authzCatalogSchema(catalog: Catalog) {
  const PermissionT = Type.Unsafe<string>({ type: 'string', enum: [...catalog.permissions] });
  const ResourceTypeT = Type.Unsafe<string>({ type: 'string', enum: catalog.resourceTypes.map(r => r.key) });
  const GroupKeyT = Type.Unsafe<string>({ type: 'string', enum: catalog.groups.map(g => g.key) });
  return Type.Object({
    permissions: Type.Array(Type.Object({
      key: PermissionT, label: Type.String(), group: GroupKeyT, description: Type.String(),
      resources: Type.Array(ResourceTypeT, { description: 'Ressourcentypen, auf denen ein ACL-Eintrag für dieses Recht wirkt' }),
      adminOnly: Type.Boolean({ description: 'Nur org-admin hat das Recht: nie freigebbar; Verbote und Beschränkungen wirken nur für Maschinen-Clients (Personen mit org-admin sind ausgenommen)' }),
      personOnly: Type.Optional(Type.Boolean({ description: 'Nur für Personen: in keinem Scope, also nie für Maschinen-Clients und MCP (fehlt sonst)' })),
      requires: Type.Optional(Type.Array(PermissionT, { description: 'Rechte, ohne die die Oberfläche die Aktion nicht erreicht (Navigation, Seite, Auswahl); der Rollendialog warnt, wenn sie fehlen. Fehlt ohne Voraussetzungen' })),
    }), { description: 'Alle Rechte in fester Reihenfolge' }),
    groups: Type.Array(Type.Object({
      key: GroupKeyT, label: Type.String(),
      match: Type.Optional(Type.String({ description: 'Stichwörter der Gruppe als regulärer Ausdruck (Gross/klein egal): jede Rolle mit Rechten der Gruppe nennt sie in der Beschreibung (fehlt ohne Prüfung)' })),
    }), { description: 'Rechtegruppen in Anzeigereihenfolge' }),
    roles: Type.Array(Type.Object({
      key: Type.String(), label: Type.String(), description: Type.String({ description: 'Nennt alle Rechtegruppen der Rolle' }),
      permissions: Type.Array(PermissionT), adminOnly: Type.Boolean({ description: 'Nur die Plattform-Administration vergibt diese Rolle' }),
    })),
    scopes: Type.Array(Type.Object({ key: Type.String(), text: Type.String(), permissions: Type.Array(PermissionT) }), { description: 'OAuth-Scopes für Maschinen-Clients und MCP' }),
    resourceTypes: Type.Array(Type.Object({ key: ResourceTypeT, label: Type.String(), leaf: Type.Optional(Type.Boolean({ description: 'Blatt der Kette: keine Freigaben (grant) auf diesem Typ, nur Verbote und Beschränkungen (fehlt sonst)' })) })),
    mcpTools: Type.Array(Type.Object({
      name: Type.String(), title: Type.String(), permission: PermissionT,
      scope: Nullable(Type.String({ description: `Scope, den das Recht im Token braucht; null beim Standard-Scope \`${catalog.product}:read\`` })),
      readOnly: Type.Boolean({ description: 'Werkzeug liest nur (`readOnlyHint`)' }),
    }), { description: 'Werkzeuge des MCP-Dienstes mit dem Recht, das sie brauchen (ohne `organisationen_auflisten`, das kein Recht braucht)' }),
    tasks: Type.Optional(Type.Array(Type.Object({
      key: Type.String(), label: Type.String(), description: Type.String(), permissions: Type.Array(PermissionT),
    }), { description: 'Aufgaben für den Rollendialog: Rechte, die zusammen einen Arbeitsablauf in der Oberfläche ergeben (fehlt ohne Aufgaben)' })),
  }, { title: 'AuthzCatalog' });
}

const MeOut = Type.Object({
  tenant: Type.Object({ id: Type.String(), alias: Type.String() }),
  principal: Type.Object({ id: Type.String(), kind: Type.String(), name: Type.String(), email: Type.Union([Type.String(), Type.Null()]), clientId: Type.Union([Type.String(), Type.Null()]) }),
  roles: Type.Array(Type.String()), scopes: Type.Array(Type.String()), permissions: Type.Array(Type.String({ description: 'Rechte auf Mandantenebene' })),
  grantedPermissions: Type.Array(Type.String(), { description: 'Rechte nur über Freigaben auf einzelnen Ressourcen' }), tokenBinding: Type.String(),
});

export const accountModule: IamModule = {
  name: 'account',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const json = iam.catalog.toJSON();

    app.get(`${prefix}/me`, {
      schema: routeSchema(ctx, 'GET', `${prefix}/me`, { tags: [TAG_ACCOUNT], summary: 'Angemeldeter Principal, Mandant und effektive Rechte', response: { 200: MeOut } }),
    }, async req => {
      const p = req.requirePrincipal();
      return {
        tenant: { id: p.tenantId, alias: p.tenantAlias }, principal: { id: p.principalId, kind: p.kind, name: p.name, email: p.email, clientId: p.clientId }, roles: p.roles, scopes: p.scopes,
        permissions: await iam.access.effective(p), grantedPermissions: await iam.access.granted(p), tokenBinding: p.binding,
      };
    });

    app.get(`${prefix}/authz/catalog`, {
      schema: routeSchema(ctx, 'GET', `${prefix}/authz/catalog`, {
        tags: [TAG_ACCOUNT], summary: 'Rechte, Rollen und Scopes mit Bezeichnungen',
        description: 'Für jede angemeldete Person und jeden Client, ohne Rechteprüfung (nicht vertraulich). Einzige Quelle für Labels, Rechtegruppen, Rollenbeschreibungen, Scope-Texte, die zu jedem Recht passenden Ressourcentypen der ACL und die MCP-Werkzeuge mit ihrem Recht.',
        response: { 200: authzCatalogSchema(iam.catalog) },
      }),
    }, async req => {
      req.requirePrincipal();
      return json;
    });
  },
};
