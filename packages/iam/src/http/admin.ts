/**
 * Modul `admin`: Verwaltung von Organisationen, Mitgliedern, Rollen an der Organisation und Freigabestufen ohne
 * Keycloak-Konsole (Spezifikation Kap. 9.1, 9.2, 9.6). Die Regeln setzen `AdminService` (admin.ts) und rules.ts durch.
 *
 * - /v1/admin/status   für jede angemeldete Person: eingerichtet, was darf ich, Rollen mit Erklärung
 * - /v1/admin/…        Mitglieder und Rollen der eigenen Organisation (Recht `members:admin`, nur Personen)
 * - /v1/platform/…     Organisationen anlegen, ändern, sperren und deren Mitglieder verwalten (Realm-Rolle platform-admin)
 *
 * Ohne KEYCLOAK_MGMT_CLIENT_ID ist die Verwaltung abgeschaltet: GET /v1/admin/status sagt das, alle übrigen Endpunkte
 * antworten mit 503 und einem Hinweis (Kap. 9.1 Nr. 13). Nur Personen: Maschinen-Clients und Zugriffe über den
 * MCP-Dienst erhalten das Recht nie (kein Scope deckt es ab). Clients (`/v1/admin/clients`) brauchen keinen
 * Verwaltungs-Client (Modul `clients`).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AdminService, Scope } from '../admin.ts';
import { forbidden, HttpError } from '../errors.ts';
import { ORG, type Level, type Model } from '../model.ts';
import { DateTime, Nullable, personOf, routeSchema, type IamModule, type ModuleContext } from './routes.ts';

const TAG_MEMBERS = 'Verwaltung: Mitglieder und Rollen';
const TAG_ORGS = 'Plattform: Organisationen';
const LevelT = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]);

const Member = Type.Object({
  id: Type.String({ description: 'Person: ID in Keycloak bzw. bei offener Einladung die ID der Einladung (nie die ID des Kontos); Client: Client-ID' }),
  kind: Type.Union([Type.Literal('user'), Type.Literal('client')]),
  principalId: Type.String({ description: 'Subjekt `user:<id>` bzw. `client:<id>`' }),
  username: Type.String(),
  name: Type.String(),
  email: Nullable(Type.String()),
  status: Type.Unsafe<'active' | 'invited' | 'disabled'>({ type: 'string', enum: ['active', 'invited', 'disabled'], description: '`invited`: Passwort noch nicht gesetzt, noch nie angemeldet (aus Entra ID: noch nie zugegriffen); `disabled`: Konto in Keycloak gesperrt' }),
  roles: Type.Array(Type.String(), { description: 'Rollen an der Organisation (Tupel)' }),
  clearance: LevelT,
  breakGlassUntil: Nullable(DateTime),
  places: Type.Integer({ description: 'Freigaben an anderen Orten als der Organisation («+3 Orte»)' }),
  lastSeenAt: Nullable(DateTime),
  createdAt: Nullable(DateTime),
  loginPath: Nullable(Type.String({ description: 'Nur offene Einladung aus Microsoft Entra ID: Pfad der Anmeldung über Microsoft, zum Weitergeben als Link' })),
  clientId: Nullable(Type.String()),
  scopes: Nullable(Type.Array(Type.String(), { description: 'Nur Clients: Scopes im letzten Token' })),
  description: Nullable(Type.String({ description: 'Nur Clients: Beschreibung der Freigabe' })),
}, { $id: 'Member', title: 'Member', description: '`lastSeenAt`: letzter Zugriff auf die App (nicht die Anmeldung bei Keycloak). `clearance`: gespeicherte Freigabestufe ohne Break-Glass.' });

const Organization = Type.Object({
  id: Type.String({ description: 'ID der Organisation in Keycloak' }),
  alias: Type.String(), name: Type.String(), description: Nullable(Type.String()), enabled: Type.Boolean({ description: 'In Keycloak aktiv' }),
  domains: Type.Array(Type.String()),
  tenant: Nullable(Type.Object({ id: Type.String(), status: Type.String({ description: '`active` oder `suspended`' }), createdAt: DateTime }, { description: 'Mandant der App; `null`, solange die Organisation nie benutzt wurde' })),
}, { $id: 'Organization', title: 'Organization' });

/** Recht aus dem Modell der App, als enum im OpenAPI (Typen für die Apps). */
const permission = (perms: readonly string[]) => Type.Unsafe<string>({ type: 'string', enum: [...perms] });
const statusRole = (model: Model) => Type.Object({ key: Type.String(), label: Type.String(), description: Type.String(), permissions: Type.Array(permission(model.permissions)), adminOnly: Type.Boolean({ description: 'Nur die Plattform-Administration vergibt diese Rolle' }) });
const Roles = Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 20, uniqueItems: true });
const ALIAS = Type.String({ minLength: 1, maxLength: 63, pattern: '^[a-z0-9][a-z0-9_-]{0,62}$' });
const UserParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const AliasParams = Type.Object({ alias: ALIAS });
const AliasUserParams = Type.Object({ alias: ALIAS, id: UserParams.properties.id });
const Invite = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 254 }),
  firstName: Type.Optional(Type.String({ maxLength: 100 })), lastName: Type.Optional(Type.String({ maxLength: 100 })),
  roles: Type.Optional(Roles),
}, { additionalProperties: false });
const InviteResult = Type.Object({
  result: Type.Unsafe<'invitation-sent'>({ type: 'string', enum: ['invitation-sent'], description: 'Immer `invitation-sent` – gleich, ob für die Adresse schon ein Konto bestand (Mandantentrennung)' }),
  emailSent: Type.Boolean({ description: 'false: Keycloak konnte die E-Mail nicht senden (meist kein E-Mail-Versand im Realm); Einladung bleibt offen, in der Liste erneut senden' }),
  member: Type.Ref('Member', { description: 'Eingeladene Person (Status `invited`) mit den Angaben der Einladung' }),
});
const DomainList = Type.Array(Type.String({ minLength: 3, maxLength: 253 }), { maxItems: 50 });
/** Body von suspend/resume: optional (ohne Body gilt `{}`; `optionalBodies` weist `requestBody` als optional aus). */
const StatusBody = Type.Object({ reason: Type.Optional(Type.String({ maxLength: 500, description: 'Grund für das Protokoll' })) }, { additionalProperties: false });

const OFF_DETAIL = 'Die Verwaltung von Organisationen und Mitgliedern ist in dieser Instanz nicht eingerichtet (KEYCLOAK_MGMT_CLIENT_ID). Bis dahin in der Keycloak-Konsole verwalten.';

export const adminModule: IamModule = {
  name: 'admin',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const svc = iam.admin;
    app.addSchema(Member);
    app.addSchema(Organization);

    const on = (): AdminService => {
      if (!svc) throw new HttpError(503, 'Verwaltung nicht eingerichtet', OFF_DETAIL);
      return svc;
    };
    const own = async (req: FastifyRequest): Promise<Scope> => {
      const p = personOf(req);
      await req.need('members:admin');
      on();
      return { alias: p.tenantAlias, actor: p, platform: false, source: req.source, correlationId: req.id };
    };
    const platform = (req: FastifyRequest, alias = ''): Scope => {
      const p = personOf(req);
      if (!p.platformAdmin) throw forbidden(`Nur für die Plattform-Administration (Realm-Rolle ${iam.cfg.tenancy.platformAdminRole}).`);
      on();
      return { alias, actor: p, platform: true, source: req.source, correlationId: req.id };
    };
    const id = (req: FastifyRequest) => (req.params as { id: string }).id;
    const alias = (req: FastifyRequest) => (req.params as { alias: string }).alias;

    const statusUrl = `${prefix}/admin/status`;
    app.get(statusUrl, {
      schema: routeSchema(ctx, 'GET', statusUrl, {
        tags: [TAG_MEMBERS], summary: 'Ist die Verwaltung eingerichtet, was darf ich?',
        description: 'Für jede angemeldete Person. `enabled`: Verwaltungs-Client konfiguriert. `canManageMembers`: Recht `members:admin` in dieser Organisation. `roles`: Rollen des Modells mit Erklärungen.',
        response: { 200: Type.Object({
          enabled: Type.Boolean(), reason: Nullable(Type.String()), organization: Type.String(), platformAdmin: Type.Boolean(), canManageMembers: Type.Boolean(),
          roles: Type.Array(statusRole(iam.model)),
        }) },
      }),
    }, async req => {
      const p = req.requirePrincipal();
      const isPerson = p.kind === 'user' && !p.scopeBound;
      return {
        enabled: !!svc, reason: svc ? null : OFF_DETAIL, organization: p.tenantAlias, platformAdmin: isPerson && p.platformAdmin,
        canManageMembers: !!svc && isPerson && (await req.can('members:admin')),
        roles: iam.model.toJSON().roles.filter(r => iam.model.relationsAt(ORG).includes(r.key)),
      };
    });

    // ---------------------------------------------------------------- Mitglieder: eigene Organisation und Plattform
    const memberRoutes = (base: string, tags: string[], scope: (req: FastifyRequest) => Promise<Scope> | Scope, withAlias: boolean) => {
      const p1 = withAlias ? { params: AliasParams } : {};
      const p2 = withAlias ? AliasUserParams : UserParams;
      app.get(base, {
        schema: routeSchema(ctx, 'GET', base, { tags, summary: 'Mitglieder (Personen und freigegebene Clients) mit Rollen, Freigabestufe, Status und letztem Zugriff', ...p1, response: { 200: Type.Object({ items: Type.Array(Type.Ref('Member')) }) } }),
      }, async req => { const sc = await scope(req); return { items: await on().listMembers(sc) }; });

      app.post(base, {
        schema: routeSchema(ctx, 'POST', base, {
          tags, summary: 'Person einladen', ...p1, body: Invite,
          description: 'Antwortet immer gleich (202, mindestens `KEYCLOAK_MGMT_INVITE_MIN_TIME`), damit niemand erfährt, ob für die Adresse schon ein Konto besteht – etwa in einer anderen Organisation. Ohne Konto legt Keycloak eines ohne Passwort an und sendet «Passwort setzen»; sonst sendet Keycloak eine Einladung. Die Person erscheint als «eingeladen»; die Einladung legt den Principal an und setzt die Rollen als Tupel. Die App sieht und setzt keine Passwörter. Rolle org-admin nur für die Plattform-Administration.',
          response: { 202: InviteResult },
        }),
      }, async (req, reply) => {
        const sc = await scope(req);
        const b = req.body as { email: string; firstName?: string; lastName?: string; roles?: string[] };
        return reply.status(202).send(await on().invite(sc, { ...b, roles: b.roles ?? [] }));
      });

      app.put(`${base}/:id/roles`, {
        schema: routeSchema(ctx, 'PUT', `${base}/:id/roles`, {
          tags, summary: 'Rollen setzen', params: p2, body: Type.Object({ roles: Roles }, { additionalProperties: false }),
          description: 'Setzt die Rollen der Person an der Organisation auf genau diese Liste (Tupel). org-admin vergeben oder entziehen nur die Plattform-Administration (403 `platform-admin-only`); niemand gibt mehr, als er hat (403 `exceeds-own`); die letzte aktive Person mit org-admin bleibt (409 `last-admin`).',
          response: { 200: Type.Ref('Member') },
        }),
      }, async req => { const sc = await scope(req); return on().setRoles(sc, id(req), (req.body as { roles: string[] }).roles); });

      app.put(`${base}/:id/clearance`, {
        schema: routeSchema(ctx, 'PUT', `${base}/:id/clearance`, {
          tags, summary: 'Freigabestufe setzen', params: p2, body: Type.Object({ clearance: LevelT }, { additionalProperties: false }),
          description: 'Nie für sich selbst (403 `self`), nie über die eigene Freigabestufe (403 `exceeds-own`); für die Plattform-Administration gilt die Obergrenze nicht.',
          response: { 200: Type.Ref('Member') },
        }),
      }, async req => { const sc = await scope(req); return on().setClearance(sc, id(req), (req.body as { clearance: Level }).clearance); });

      app.delete(`${base}/:id`, {
        schema: routeSchema(ctx, 'DELETE', `${base}/:id`, {
          tags, summary: 'Mitglied entfernen', params: p2,
          description: 'Entfernt die Mitgliedschaft und alle Freigaben der Person bzw. zieht die Einladung zurück (`id`: Mitglied oder Einladung, wie in der Liste). Hat die Einladung das Konto angelegt, wurde sie nie angenommen und gehört die Person keiner anderen Organisation an, wird das unbenutzte Konto gelöscht. Zurückziehen dauert mindestens `KEYCLOAK_MGMT_INVITE_MIN_TIME` (wie Einladen).',
          response: { 200: Type.Object({ accountDeleted: Type.Boolean({ description: 'Unbenutztes Konto gelöscht. Nur für die Plattform-Administration aussagekräftig, für org-admin immer false (sonst verriete es andere Organisationen)' }) }) },
        }),
      }, async req => { const sc = await scope(req); return on().removeMember(sc, id(req)); });

      app.post(`${base}/:id/invitation`, {
        schema: routeSchema(ctx, 'POST', `${base}/:id/invitation`, { tags, summary: 'Einladung erneut senden', params: p2, description: 'Für offene Einladungen mindestens `KEYCLOAK_MGMT_INVITE_MIN_TIME` (wie Einladen). Einladung aus Entra ID: wieder die E-Mail mit dem Link zur Anmeldung über Microsoft.', response: { 200: Type.Object({ emailSent: Type.Boolean() }) } }),
      }, async req => { const sc = await scope(req); return on().resendInvitation(sc, id(req)); });
    };
    memberRoutes(`${prefix}/admin/members`, [TAG_MEMBERS], own, false);
    memberRoutes(`${prefix}/platform/organizations/:alias/members`, [TAG_ORGS], req => platform(req, alias(req)), true);

    // ---------------------------------------------------------------- Organisationen
    const orgs = `${prefix}/platform/organizations`;
    app.get(orgs, {
      schema: routeSchema(ctx, 'GET', orgs, { tags: [TAG_ORGS], summary: 'Organisationen (Keycloak) mit Mandantenstatus', response: { 200: Type.Object({ items: Type.Array(Type.Ref('Organization')) }) } }),
    }, async req => { platform(req); return { items: await on().listOrganizations(req.id) }; });

    app.post(orgs, {
      schema: routeSchema(ctx, 'POST', orgs, {
        tags: [TAG_ORGS], summary: 'Organisation anlegen', description: 'Legt die Organisation in Keycloak und den Mandanten an. Alias wie beim Mandanten: Kleinbuchstaben, Ziffern, - und _, nicht änderbar.',
        body: Type.Object({ alias: Type.String({ minLength: 1, maxLength: 63 }), name: Type.String({ minLength: 1, maxLength: 200 }), description: Type.Optional(Type.String({ maxLength: 1000 })), domains: Type.Optional(DomainList) }, { additionalProperties: false }),
        response: { 201: Type.Ref('Organization') },
      }),
    }, async (req, reply) => {
      const sc = platform(req);
      const b = req.body as { alias: string; name: string; description?: string; domains?: string[] };
      return reply.status(201).send(await on().createOrganization(sc, { ...b, domains: b.domains ?? [] }));
    });

    app.get(`${orgs}/:alias`, {
      schema: routeSchema(ctx, 'GET', `${orgs}/:alias`, { tags: [TAG_ORGS], summary: 'Organisation lesen', params: AliasParams, response: { 200: Type.Ref('Organization') } }),
    }, async req => { platform(req); return on().organization(alias(req), req.id); });

    app.patch(`${orgs}/:alias`, {
      schema: routeSchema(ctx, 'PATCH', `${orgs}/:alias`, {
        tags: [TAG_ORGS], summary: 'Organisation umbenennen, beschreiben, Domänen setzen', params: AliasParams,
        body: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), description: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))), domains: Type.Optional(DomainList) }, { additionalProperties: false }),
        response: { 200: Type.Ref('Organization') },
      }),
    }, async req => { const sc = platform(req); return on().updateOrganization(sc, alias(req), req.body as { name?: string; description?: string | null; domains?: string[] }); });

    for (const [verb, status] of [['suspend', 'suspended'], ['resume', 'active']] as const) {
      const url = `${orgs}/:alias/${verb}`;
      app.post(url, {
        schema: routeSchema(ctx, 'POST', url, {
          tags: [TAG_ORGS], summary: verb === 'suspend' ? 'Organisation sperren' : 'Organisation entsperren', params: AliasParams, body: StatusBody, 'x-body-optional': true,
          description: `${verb === 'suspend' ? 'Deaktiviert die Organisation in Keycloak und sperrt den Mandanten (keine Anmeldung, keine API-Zugriffe, Worker ruht). Laufende Sitzungen enden spätestens nach einer Minute.' : 'Aktiviert die Organisation in Keycloak und entsperrt den Mandanten.'} Body optional: \`{ "reason": "…" }\` (höchstens 500 Zeichen) für das Protokoll.`,
          response: { 200: Type.Ref('Organization') },
        }),
        // Body freiwillig: ohne Body wie `{}` (Fastify prüft das Schema sonst gegen «kein Body»)
        preValidation: async req => { req.body ??= {}; },
      }, async req => {
        const sc = platform(req);
        return on().setOrganizationStatus(sc, alias(req), status, (req.body as { reason?: string }).reason ?? '');
      });
    }
  },
};
