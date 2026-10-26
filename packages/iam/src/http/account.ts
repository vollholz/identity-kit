/**
 * Modul `account`: angemeldeter Principal (`GET /v1/me`, `ApiMe`) und Katalog des Modells (`GET /v1/authz/catalog`,
 * Spezifikation Kap. 9.5). Der Katalog ist nicht vertraulich und braucht kein Recht.
 *
 * Konto ohne Organisation (Kap. 6.3, Kontext `account`): `GET /v1/account` (Konto, Organisationen,
 * Plattform-Administration, was selbst geht), `POST /v1/account/organizations` (eigene Organisation erstellen) und das
 * öffentliche `POST /v1/signup` (Registrieren mit E-Mail).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../errors.ts';
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
      openWorld: Type.Boolean({ description: 'Werkzeug greift auf fremde Systeme oder das Netz zu (`openWorldHint`)' }),
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

const AccountOut = Type.Object({
  account: Type.Object({ id: Type.String(), subject: Type.String({ description: 'ID der Person in Keycloak (wie `Member.id`)' }), name: Type.String(), email: Nullable(Type.String()), emailVerified: Type.Boolean() }),
  platformAdmin: Type.Boolean({ description: 'Realm-Rolle der Plattform-Administration (Organisationen über alle Mandanten verwalten; keine Rechte in einer Organisation)' }),
  organizations: Type.Array(Type.Object({
    alias: Type.String(), name: Type.String(), status: Type.String({ description: '`active` oder `suspended`; `unavailable`, wenn die Plattform die Organisation nicht kennt' }),
  }), { description: 'Organisationen im Token (Mitgliedschaften laut Keycloak)' }),
  selfService: Type.Object({
    signup: Type.Boolean(), createOrganization: Type.Boolean({ description: 'Eigene Organisationen erstellen ist eingeschaltet' }),
    organizationLimit: Type.Integer(),
  }),
}, { title: 'ApiAccount' });

const ACCOUNT = { iam: { contexts: ['account' as const] } };

export const accountModule: IamModule = {
  name: 'account',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const json = iam.model.toJSON();
    const ss = iam.cfg.selfService;
    const admin = () => {
      if (!iam.admin) throw new HttpError(503, 'Verwaltung nicht eingerichtet', 'Konten und Organisationen legt die Plattform über die Verwaltung in Keycloak an (KEYCLOAK_MGMT_CLIENT_ID).');
      return iam.admin;
    };
    // Registrieren ist öffentlich: ohne Rate-Limit liesse es sich missbrauchen (Konten, E-Mails)
    app.addHook('onReady', async () => {
      if ((ss.signup || ss.orgs) && !app.hasDecorator('rateLimit')) app.log.warn('Modul «account»: @fastify/rate-limit ist nicht registriert, Registrieren und Organisation erstellen sind unbegrenzt');
    });
    const rlPrefix = `${iam.cfg.ops.rateLimitNamespace ? `${iam.cfg.ops.rateLimitNamespace}:` : ''}${iam.model.product}:`;

    app.get(`${prefix}/account`, {
      config: ACCOUNT,
      schema: routeSchema(ctx, 'GET', `${prefix}/account`, {
        tags: [TAG_ACCOUNT], summary: 'Konto, Organisationen und was selbst geht',
        description: 'Für jede angemeldete Person, auch ohne Organisation (Kontext Konto). Nicht für Maschinen-Clients und den MCP-Dienst (403).',
        response: { 200: AccountOut },
      }),
    }, async req => {
      const a = req.requireAccount();
      const known = a.organizations.length
        ? (await iam.db.query<{ alias: string; name: string; status: string }>('SELECT alias, name, status FROM app.platform_tenants() WHERE alias = ANY ($1)', [a.organizations])).rows
        : [];
      return {
        account: { id: a.accountId, subject: a.subject, name: a.name, email: a.email, emailVerified: a.emailVerified }, platformAdmin: a.platformAdmin,
        organizations: a.organizations.map(alias => { const t = known.find(x => x.alias === alias); return { alias, name: t?.name ?? alias, status: t?.status ?? 'unavailable' }; }),
        selfService: { signup: ss.signup && !!iam.admin, createOrganization: ss.orgs && !!iam.admin, organizationLimit: ss.orgLimit },
      };
    });

    app.post(`${prefix}/account/organizations`, {
      config: { ...ACCOUNT, rateLimit: { max: 5, timeWindow: 3_600_000, keyGenerator: (req: FastifyRequest) => `${rlPrefix}own-org:${req.account?.accountId ?? req.ip}` } },
      schema: routeSchema(ctx, 'POST', `${prefix}/account/organizations`, {
        tags: [TAG_ACCOUNT], summary: 'Eigene Organisation erstellen',
        description: 'Nur mit `SELF_SERVICE_ORGS` (sonst 403 `self-service-off`) und bestätigter E-Mail (403 `email-unverified`). Alias frei (409 `alias-taken`) und nicht reserviert (422); höchstens `SELF_SERVICE_ORG_LIMIT` je Konto (409 `org-limit`). Die Person wird Mitglied mit der Rolle org-admin und Freigabestufe 2, sonst erhält sie nichts. Danach das Token erneuern (Oberfläche: neu anmelden bzw. Refresh), damit die Organisation darin steht.',
        body: Type.Object({ alias: Type.String({ minLength: 1, maxLength: 63 }), name: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
        response: { 201: Type.Object({ alias: Type.String(), name: Type.String() }) },
      }),
    }, async (req, reply) => {
      const a = req.requireAccount();
      const r = await admin().createOwnOrganization(a, req.body as { alias: string; name: string }, { source: req.source, correlationId: req.id });
      return reply.status(201).send({ alias: r.alias, name: r.name });
    });

    app.post(`${prefix}/signup`, {
      config: { rateLimit: { max: 5, timeWindow: 3_600_000, keyGenerator: (req: FastifyRequest) => `${rlPrefix}signup:${req.ip}` } },
      schema: routeSchema(ctx, 'POST', `${prefix}/signup`, {
        tags: [TAG_ACCOUNT], summary: 'Registrieren mit E-Mail (ohne Anmeldung)',
        description: 'Nur mit `SELF_SERVICE_SIGNUP` (sonst 403 `self-service-off`). Antwortet immer gleich (202, mindestens `KEYCLOAK_MGMT_INVITE_MIN_TIME`), ob für die Adresse schon ein Konto besteht oder nicht. Ohne Konto sendet Keycloak eine E-Mail «E-Mail bestätigen und Passwort festlegen»; danach meldet sich die Person an und erstellt eine Organisation.',
        body: Type.Object({ email: Type.String({ minLength: 3, maxLength: 254 }), firstName: Type.Optional(Type.String({ maxLength: 100 })), lastName: Type.Optional(Type.String({ maxLength: 100 })) }, { additionalProperties: false }),
        response: { 202: Type.Object({ result: Type.Literal('signup-received') }) },
      }),
    }, async (req, reply) => reply.status(202).send(await admin().signup(req.body as { email: string; firstName?: string; lastName?: string }, { source: req.source, correlationId: req.id })));

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
      // Auch ohne Organisation (Plattform-Administration, Konto): der Katalog gehört zur App, nicht zu einem Mandanten
      config: { iam: { contexts: ['tenant', 'account'] } },
      schema: routeSchema(ctx, 'GET', `${prefix}/authz/catalog`, {
        tags: [TAG_ACCOUNT], summary: 'Rechte, Rollen, Scopes und Orte mit Bezeichnungen',
        description: 'Für jede angemeldete Person und jeden Client, auch ohne Organisation, ohne Rechteprüfung (nicht vertraulich). Einzige Quelle für Labels, Rechtegruppen, Rollenbeschreibungen, Scope-Texte, Orte mit ihren Rollen, Stufen der Vertraulichkeit und die MCP-Werkzeuge mit ihrem Recht.',
        response: { 200: authzCatalogSchema(iam.model) },
      }),
    }, async (req, reply) => {
      if (!req.account) req.requirePrincipal();
      reply.header('Vary', 'Accept-Language');
      return json;
    });
  },
};
