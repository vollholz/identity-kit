/**
 * Modul `entra`: Anmeldung über Microsoft Entra ID je Organisation (Spezifikation Kap. 9.4; aus Assets
 * `modules/admin/index.ts`, Teil «Entra»). Die Regeln setzen `EntraService` (entra.ts) und `AdminService.addFromEntra`
 * (admin.ts) durch.
 *
 * - /v1/admin/entra…                               eigene Organisation (Recht `members:admin`, nur Personen)
 * - /v1/platform/organizations/{alias}/entra…      beliebige Organisation (Realm-Rolle platform-admin)
 * - …/members/entra-search, …/members/entra         Personen aus Entra ID suchen und hinzufügen
 * - /v1/admin/entra/test                           Testanmeldung festhalten (jede Person der Organisation)
 * - /v1/platform/entra/refresh                     alle Verbindungen nachführen (z. B. neues ENTRA_CLIENT_SECRET)
 * - /v1/entra/handover/*                           öffentliche Seite eines Links (ohne Anmeldung)
 *
 * Verbinden über eine eigene App der Organisation (`PUT …/entra/app`, braucht ENCRYPTION_KEYS) oder über die App der
 * Plattform (Zustimmung, ENTRA_CLIENT_ID). Ohne Verwaltungs-Client 503 wie das Modul `admin`; ohne ENTRA_CLIENT_ID sagt
 * der Status das (`methods`), die Zustimmung antwortet mit 409 `platform-app-disabled`. Die Personensuche ist je Person auf 30 Anfragen pro Minute begrenzt, wenn die App
 * `@fastify/rate-limit` registriert (`config.rateLimit` der Route).
 */
import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AdminService, Scope } from '../admin.ts';
import { consentPath, handoverPath } from '../entra.ts';
import type { EntraService } from '../entra.ts';
import { forbidden, HttpError } from '../errors.ts';
import { DateTime, Deleted, Nullable, personOf, routeSchema, type IamModule, type ModuleContext } from './routes.ts';

const TAG = 'Verwaltung: Anmeldung über Microsoft Entra ID';
const OFF_DETAIL = 'Die Verwaltung von Organisationen und Mitgliedern ist in dieser Instanz nicht eingerichtet (KEYCLOAK_MGMT_CLIENT_ID). Bis dahin in der Keycloak-Konsole verwalten.';

const ALIAS = Type.String({ minLength: 1, maxLength: 63, pattern: '^[a-z0-9][a-z0-9_-]{0,62}$' });
const AliasParams = Type.Object({ alias: ALIAS });
const Roles = Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 20, uniqueItems: true });

const EntraAdd = Type.Object({
  id: Type.String({ format: 'uuid', description: 'Objekt-ID der Person in Entra ID (aus der Suche)' }),
  roles: Type.Optional(Roles),
  sendEmail: Type.Optional(Type.Boolean({ description: 'false: keine E-Mail; die Person erhält den Link (`member.loginPath`) auf anderem Weg. Standard true' })),
}, { additionalProperties: false });
const EntraAddResult = Type.Object({
  result: Type.Unsafe<'added'>({ type: 'string', enum: ['added'], description: 'Immer `added` – gleich, ob für die Adresse schon ein Konto bestand (Mandantentrennung)' }),
  emailSent: Type.Boolean({ description: 'false: keine E-Mail verlangt oder Versand gescheitert; in der Liste erneut senden oder den Link weitergeben' }),
  member: Type.Ref('Member', { description: 'Hinzugefügte Person (Status `invited` bis zum ersten Zugriff), mit `loginPath`' }),
});
const EntraCandidates = Type.Object({
  items: Type.Array(Type.Object({
    id: Type.String({ description: 'Objekt-ID in Entra ID' }), name: Type.String(),
    email: Type.String({ description: 'Adresse, unter der das Konto angelegt würde (`mail` in einer gebundenen Domäne, sonst UPN)' }),
    userPrincipalName: Type.String(), department: Nullable(Type.String()), jobTitle: Nullable(Type.String()),
    selectable: Type.Boolean(), reason: Nullable(Type.String({ description: 'Warum nicht wählbar (Gast, deaktiviert, Domäne nicht gebunden, schon Mitglied oder eingeladen)' })),
  })),
  more: Type.Boolean({ description: 'Es gäbe weitere Treffer: Suche verfeinern' }),
});
const Permission = Type.Object({
  name: Type.String({ description: 'Berechtigung in Microsoft Graph, z. B. User.Read.All' }),
  type: Type.Unsafe<'Application' | 'Delegated'>({ type: 'string', enum: ['Application', 'Delegated'], description: '`Application`: Anwendungsberechtigung, braucht die Administratorzustimmung im Tenant' }),
  why: Type.String({ description: 'Wofür die Plattform sie braucht (für die Anleitung)' }),
  optional: Type.Boolean({ description: 'true: nicht nötig (zurzeit sind alle nötig)' }),
});
const OwnAppGuide = Type.Object({
  redirectUri: Type.String({ description: 'In der App einzutragende Umleitungs-URI, Plattform «Web» (Broker-Endpunkt des Anbieters in Keycloak); fest je Organisation' }),
  permissions: Type.Array(Permission),
}, { description: 'Anleitung für die App-Registrierung im eigenen Tenant (Kontotyp «Nur Konten in diesem Organisationsverzeichnis»)' });
const EntraConnection = Type.Object({
  entraTenantId: Type.String({ description: 'Tenant-ID in Microsoft Entra ID' }),
  method: Type.Unsafe<'platform' | 'own'>({ type: 'string', enum: ['platform', 'own'], description: '`own`: eigene App der Organisation; `platform`: App der Plattform (Zustimmung)' }),
  clientId: Nullable(Type.String({ description: 'Anwendungs-ID der eigenen App (nur `own`); das Geheimnis gibt die API nie aus' })),
  secretExpiresAt: Nullable(DateTime), // Ablauf des Geheimnisses der eigenen App (aus Graph oder angegeben), sonst null
  secretExpiresSoon: Type.Boolean({ description: 'Geheimnis läuft in höchstens 30 Tagen ab oder ist abgelaufen: in der App ein neues anlegen und eintragen' }),
  redirectUri: Type.String({ description: 'Redirect-URI des Anbieters (bei eigener App in der App eingetragen)' }),
  entraName: Type.String({ description: 'Name der Organisation in Entra ID' }),
  domains: Type.Array(Type.String(), { description: 'Gebundene Domänen: Personen mit diesen Adressen melden sich nur noch über Entra ID an' }),
  availableDomains: Type.Array(Type.String(), { description: 'Weitere im Tenant verifizierte Domänen (beim letzten Aktualisieren), nicht gebunden' }),
  stage: Type.Unsafe<'pending' | 'enforced'>({ type: 'string', enum: ['pending', 'enforced'], description: '`pending`: verbunden, Anmeldung mit Passwort wie bisher; `enforced`: «Nur Entra» aktiv' }),
  testedAt: Nullable(DateTime), // letzte erfolgreiche Testanmeldung über Microsoft (Voraussetzung für «Nur Entra»)
  testedBy: Nullable(Type.String()),
  enforcedAt: Nullable(DateTime), enforcedBy: Nullable(Type.String()),
  testLoginPath: Type.String({ description: 'Testanmeldung über Microsoft (Navigation im Browser, auch als Link für andere Personen der Domänen); führt auf `testPath` zurück' }),
  status: Type.Unsafe<'active' | 'error'>({ type: 'string', enum: ['active', 'error'], description: '`error`: letztes Aktualisieren gescheitert (`lastError`); die Anmeldung läuft trotzdem weiter' }),
  lastError: Nullable(Type.String()),
  connectedAt: DateTime, connectedBy: Type.String(), refreshedAt: DateTime,
}, { $id: 'EntraConnection', title: 'EntraConnection' });
const EntraStatus = Type.Object({
  enabled: Type.Boolean({ description: 'App der Plattform eingerichtet (ENTRA_CLIENT_ID); ohne sie geht nur die eigene App (`methods`)' }),
  reason: Nullable(Type.String()),
  methods: Type.Object({
    platformApp: Type.Boolean({ description: 'Verbinden über die App der Plattform (Zustimmung bei Microsoft)' }),
    ownApp: Type.Boolean({ description: 'Verbinden mit einer eigenen App der Organisation (`PUT …/app`)' }),
  }),
  ownAppReason: Nullable(Type.String({ description: 'Warum die eigene App nicht geht (z. B. ENCRYPTION_KEYS fehlt)' })),
  ownApp: Nullable(OwnAppGuide),
  consentPath: Type.String({ description: 'Pfad der Oberfläche, auf den Microsoft nach der Admin-Zustimmung zurückleitet (ENTRA_UI_PATH + `/zustimmung`; Redirect-URI der Entra-App)' }),
  testPath: Type.String({ description: 'Pfad der Oberfläche nach der Testanmeldung (ENTRA_UI_PATH + `/test`)' }),
  connection: Nullable(Type.Ref('EntraConnection')),
});
const EntraResult = Type.Object({
  connection: Type.Ref('EntraConnection'),
  members: Type.Array(Type.Object({
    email: Type.String(), name: Type.String(), linked: Type.Boolean({ description: 'Mit der Person in Entra ID verknüpft (über die Objekt-ID)' }),
    reason: Nullable(Type.String({ description: 'Warum nicht verknüpft; bei «Nur Entra» kann sich die Person nicht mehr anmelden' })),
    passwordKept: Type.Optional(Type.String({ description: 'Warum Passwort und Passkey bei «Nur Entra» bleiben (Konto der Plattform-Administration)' })),
  }), { description: 'Mitglieder mit Adresse in einer betroffenen Domäne; bei «Nur Entra» wurde ihr Passwort entfernt' }),
  rejectedDomains: Type.Array(Type.String(), { description: 'Verifizierte Domänen, die bereits einer anderen Organisation zugeordnet sind (welcher, bleibt verborgen)' }),
});
const LinkKind = Type.Unsafe<'consent' | 'credentials'>({ type: 'string', enum: ['consent', 'credentials'], description: '`consent`: Zustimmung bei Microsoft (App der Plattform); `credentials`: die Kunden-IT trägt die eigene App ein' });
const ConsentLink = Type.Object({
  id: Type.String({ format: 'uuid' }), kind: LinkKind, entraTenantId: Type.String({ format: 'uuid' }), createdByName: Type.String(), createdAt: DateTime, expiresAt: DateTime,
  status: Type.Union(['open', 'in-progress', 'expired', 'revoked', 'connected', 'failed'].map(x => Type.Literal(x)), { description: '`in-progress`: Rückkehr von Microsoft wird gerade eingelöst (Frist 5 Minuten). `revoked` mit `error.reason` `creator-lost-access` (erzeugende Person darf nicht mehr) bzw. `disconnected` (Verbindung getrennt), von Hand widerrufen ohne `error`; `failed` mit dem Fehler des letzten Versuchs' }),
  usedAt: Nullable(DateTime), approverName: Nullable(Type.String({ description: 'Person, die bei Microsoft zugestimmt hat' })),
  error: Nullable(Type.Object({ reason: Type.String(), detail: Type.String() })),
}, { $id: 'EntraConsentLink', title: 'EntraConsentLink' });
const ConsentComplete = Type.Object({
  state: Type.String({ minLength: 10, maxLength: 200 }),
  code: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: 'Code der Anmeldung (Nachweis der Zustimmung)' })),
  error: Type.Optional(Type.String({ maxLength: 200 })),
  errorDescription: Type.Optional(Type.String({ maxLength: 2000 })),
}, { additionalProperties: false, description: 'Parameter der Rückkehr von Microsoft (`code`, `state`, `error`, `error_description`)' });
const AppCredentials = {
  clientId: Type.String({ minLength: 36, maxLength: 36, description: 'Anwendungs-ID (Client-ID) der App im eigenen Tenant' }),
  clientSecret: Type.String({ minLength: 1, maxLength: 1000, description: 'Wert des geheimen Clientschlüssels (verschlüsselt gespeichert, nie ausgegeben)' }),
  secretExpiresAt: Type.Optional(Nullable(Type.String({ format: 'date-time', description: 'Ablauf des Geheimnisses, falls er in der Registrierung nicht zu finden ist (Graph liest ihn sonst selbst)' }))),
};
const APP_ERRORS = '409 mit `reason`: `invalid-secret`, `secret-expired`, `wrong-tenant` (keine App mit dieser ID im Tenant), `invalid-client`, `missing-permissions` (mit `missing`; auch ohne Administratorzustimmung), `app-not-registered-in-tenant` (App nicht in diesem Tenant registriert, z. B. die eines Herstellers), `domains-taken`, `tenant-mismatch` (anders verbunden); 503 `encryption-missing`.';
const NotLinked = Type.Array(Type.String({ maxLength: 254 }), { maxItems: 10_000, description: 'Bestätigt: Diese Mitglieder verlieren die Anmeldung (Adressen aus der Vorschau)' });

export const entraModule: IamModule = {
  name: 'entra',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    if (!app.getSchema('Member')) throw new Error('Modul «entra» braucht das Modul «admin» (davor registriert)');
    app.addSchema(EntraConnection);
    app.addSchema(ConsentLink);
    // Öffentliche Routen ohne Limit wären ungeschützt: deutlich warnen (das Plugin registriert die App)
    app.addHook('onReady', async () => {
      if (iam.entra && !app.hasDecorator('rateLimit')) app.log.warn('Modul «entra»: @fastify/rate-limit ist nicht registriert, die öffentlichen Routen /entra/handover/* sind unbegrenzt');
    });

    const on = (): { svc: AdminService; ent: EntraService } => {
      if (!iam.admin || !iam.entra) throw new HttpError(503, 'Verwaltung nicht eingerichtet', OFF_DETAIL);
      return { svc: iam.admin, ent: iam.entra };
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
    const byAlias = (req: FastifyRequest) => platform(req, (req.params as { alias: string }).alias);
    /** Personensuche in Entra ID: je Person 30 Anfragen pro Minute (jede Suche ruft Microsoft Graph und Keycloak). */
    // Schlüssel der Rate-Limits: `<RATE_LIMIT_NAMESPACE>:<produkt>:…` (Vorsatz nur, wenn gesetzt)
    const rlPrefix = `${iam.cfg.ops.rateLimitNamespace ? `${iam.cfg.ops.rateLimitNamespace}:` : ''}${iam.model.product}:`;
    const searchLimit = { max: 30, timeWindow: 60_000, keyGenerator: (req: FastifyRequest) => `${rlPrefix}entra-search:${req.principal?.tenantId ?? ''}:${req.principal?.subject ?? req.ip}` };

    // ---------------------------------------------------------------- Personen aus Entra ID
    const memberRoutes = (base: string, tags: string[], scope: (req: FastifyRequest) => Promise<Scope> | Scope, withAlias: boolean) => {
      const p = withAlias ? { params: AliasParams } : {};
      app.get(`${base}/entra-search`, {
        schema: routeSchema(ctx, 'GET', `${base}/entra-search`, {
          tags, summary: 'Personen in Entra ID suchen', ...p,
          querystring: Type.Object({ q: Type.String({ minLength: 2, maxLength: 100, description: 'Name, Adresse oder UPN (Wortanfang)' }) }),
          description: 'Nur im Entra-Tenant der eigenen Organisation (verbunden, Stufe `pending` oder `enforced`), höchstens 20 Treffer, 30 Suchen pro Minute und Person. Wählbar sind nur Mitglieder des Tenants (keine Gäste), aktiv, mit Adresse in einer gebundenen Domäne, noch nicht Mitglied oder eingeladen. Ob eine Person ein Konto in einer anderen Organisation hat, sagt die Antwort nicht.',
          response: { 200: EntraCandidates },
        }),
        config: { rateLimit: searchLimit },
      }, async req => { const sc = await scope(req); return on().ent.search(sc, (req.query as { q: string }).q); });

      app.post(`${base}/entra`, {
        schema: routeSchema(ctx, 'POST', `${base}/entra`, {
          tags, summary: 'Person aus Entra ID hinzufügen', ...p, body: EntraAdd,
          description: 'Liest die Person neu aus Entra ID und prüft, ob sie verknüpfbar ist. Nimmt ein bestehendes Konto mit ihrer Adresse oder legt eines ohne Passwort an, trägt es als Mitglied ein, verknüpft es über die Objekt-ID und setzt die Rollen – vor der ersten Anmeldung. Die E-Mail von Keycloak führt nach «E-Mail bestätigen» zur Anmeldung über Microsoft. Die Person bleibt «eingeladen» bis zum ersten Zugriff. Antwortet immer gleich (202, mindestens `KEYCLOAK_MGMT_INVITE_MIN_TIME`). 409: nicht verknüpfbar (`not-linkable`), Objekt-ID mit einem anderen Konto verknüpft (`entra-linked`), schon Mitglied oder eingeladen, nicht verbunden (`entra-not-connected`).',
          response: { 202: EntraAddResult },
        }),
      }, async (req, reply) => {
        const sc = await scope(req);
        const { svc, ent } = on();
        const b = req.body as { id: string; roles?: string[]; sendEmail?: boolean };
        return reply.status(202).send(await svc.addFromEntra(sc, ent, { ...b, roles: b.roles ?? [] }));
      });
    };
    memberRoutes(`${prefix}/admin/members`, ['Verwaltung: Mitglieder und Rollen'], own, false);
    memberRoutes(`${prefix}/platform/organizations/:alias/members`, ['Plattform: Organisationen'], byAlias, true);

    // ---------------------------------------------------------------- Verbindung
    const entraRoutes = (base: string, scope: (req: FastifyRequest) => Promise<Scope> | Scope, withAlias: boolean) => {
      const p = withAlias ? { params: AliasParams } : {};
      app.get(base, {
        schema: routeSchema(ctx, 'GET', base, { tags: [TAG], summary: 'Status der Anmeldung über Microsoft Entra ID', ...p, response: { 200: EntraStatus } }),
      }, async req => { const sc = await scope(req); return on().ent.status(sc); });

      app.post(`${base}/consent`, {
        schema: routeSchema(ctx, 'POST', `${base}/consent`, {
          tags: [TAG], summary: 'Verbinden: Admin-Zustimmung starten', ...p,
          body: Type.Object({ tenant: Type.String({ minLength: 3, maxLength: 253, description: 'Tenant-ID (GUID) oder eine Domäne des Tenants' }) }, { additionalProperties: false }),
          description: `Sucht den Tenant und liefert die Adresse der Admin-Zustimmung bei Microsoft (Navigation im Browser, 15 Minuten gültig). Microsoft leitet danach auf \`${consentPath(iam.cfg)}\` der Oberfläche zurück (ENTRA_UI_PATH), die \`…/consent/complete\` aufruft. Zustimmen kann eine globale Administration oder «Privileged Role Administrator» des Tenants.`,
          response: { 200: Type.Object({ url: Type.String(), entraTenantId: Type.String() }) },
        }),
      }, async req => { const sc = await scope(req); return on().ent.startConsent(sc, req.body as { tenant: string }); });

      app.post(`${base}/consent/complete`, {
        schema: routeSchema(ctx, 'POST', `${base}/consent/complete`, {
          tags: [TAG], summary: 'Verbinden: Rückkehr von der Admin-Zustimmung', ...p, body: ConsentComplete,
          description: 'Prüft `state` (einmal gültig, an Person, Organisation und Tenant gebunden) und weist die Zustimmung über `code` nach (ID-Token einer globalen Administration oder «Privileged Role Administrator» des Tenants, sonst 409 `consent-unproven`), liest Organisation und verifizierte Domänen im Tenant, legt den Identitätsanbieter in Keycloak an, bindet die Domänen (ohne die einer anderen Organisation), verknüpft bestehende Mitglieder dieser Domänen über ihre Objekt-ID. Passwörter bleiben bis «Nur Entra».',
          response: { 200: EntraResult },
        }),
      }, async req => { const sc = await scope(req); return on().ent.completeConsent(sc, req.body as { state: string }); });

      app.put(`${base}/app`, {
        schema: routeSchema(ctx, 'PUT', `${base}/app`, {
          tags: [TAG], summary: 'Verbinden mit eigener App', ...p,
          body: Type.Object({ tenant: Type.String({ minLength: 3, maxLength: 253, description: 'Tenant-ID (GUID) oder eine Domäne des Tenants' }), ...AppCredentials }, { additionalProperties: false }),
          description: `Ohne Zustimmung über die Plattform und ohne ENTRA_CLIENT_ID: Die Organisation registriert eine App in ihrem Tenant (Anleitung \`ownApp\` im Status). Vor dem Speichern prüft die Plattform bei Microsoft: Token der App im Tenant (die App liegt dort, das Geheimnis stimmt), erteilte Anwendungsberechtigungen, Organisation und verifizierte Domänen; dann verbindet sie wie nach der Zustimmung. Bei bestehender Verbindung (gleicher Tenant): Geheimnis bzw. App wechseln, Stufe und Domänen bleiben. ${APP_ERRORS}`,
          response: { 200: EntraResult },
        }),
      }, async req => { const sc = await scope(req); return on().ent.connectApp(sc, req.body as { tenant: string; clientId: string; clientSecret: string; secretExpiresAt?: string | null }); });

      app.get(`${base}/preview`, {
        schema: routeSchema(ctx, 'GET', `${base}/preview`, { tags: [TAG], summary: '«Nur Entra»: Vorschau', ...p, description: 'Welche Mitglieder der gebundenen Domänen verknüpft sind bzw. werden und welche die Anmeldung verlieren (in Entra nicht verknüpfbar, mit Grund). Ändert nichts.', response: { 200: Type.Object({ members: EntraResult.properties.members }) } }),
      }, async req => { const sc = await scope(req); return on().ent.preview(sc); });

      app.post(`${base}/enforce`, {
        schema: routeSchema(ctx, 'POST', `${base}/enforce`, {
          tags: [TAG], summary: '«Nur Entra» aktivieren', ...p, body: Type.Object({ notLinked: Type.Optional(NotLinked) }, { additionalProperties: false }),
          description: 'Erst nach einer Testanmeldung (`testedAt`). `notLinked`: genau die Adressen der Vorschau, die die Anmeldung verlieren (Bestätigung); weicht die Liste ab, 409 `confirm-not-linked` mit der aktuellen Liste. Verknüpft die übrigen Mitglieder, entfernt Passwörter aller Mitglieder der Domänen und schaltet die Weiterleitung zu Microsoft ein; ab dann gelten Tokens dieser Personen nur nach einer Anmeldung über Microsoft.',
          response: { 200: EntraResult },
        }),
      }, async req => { const sc = await scope(req); return on().ent.enforce(sc, req.body as { notLinked?: string[] }); });

      app.put(`${base}/domains`, {
        schema: routeSchema(ctx, 'PUT', `${base}/domains`, {
          tags: [TAG], summary: 'Gebundene Domänen wählen', ...p,
          body: Type.Object({ domains: Type.Array(Type.String({ minLength: 3, maxLength: 253 }), { minItems: 1, maxItems: 50 }), notLinked: Type.Optional(NotLinked) }, { additionalProperties: false }),
          description: 'Teilmenge der verifizierten Domänen des Tenants. Neue Domänen: Mitglieder verknüpfen; bei «Nur Entra» auch Passwörter entfernen, mit Bestätigung `notLinked` wie beim Aktivieren. Personen entfernter Domänen melden sich danach wieder mit Passwort an («Passwort vergessen»).',
          response: { 200: EntraResult },
        }),
      }, async req => {
        const sc = await scope(req);
        const b = req.body as { domains: string[]; notLinked?: string[] };
        return on().ent.setDomains(sc, b.domains, b.notLinked);
      });

      app.post(`${base}/refresh`, {
        schema: routeSchema(ctx, 'POST', `${base}/refresh`, { tags: [TAG], summary: 'Aktualisieren', ...p, description: 'Liest Organisation und verifizierte Domänen neu, löst nicht mehr verifizierte Domänen und führt den Identitätsanbieter in Keycloak nach (z. B. neues ENTRA_CLIENT_SECRET).', response: { 200: EntraResult } }),
      }, async req => { const sc = await scope(req); return on().ent.refresh(sc); });

      app.delete(base, {
        schema: routeSchema(ctx, 'DELETE', base, {
          tags: [TAG], summary: 'Trennen', ...p,
          description: 'Löscht den Identitätsanbieter samt Verknüpfungen und hebt die Weiterleitung der Domänen auf. Die Konten bleiben; ihre Anmeldung geht danach nicht mehr, bis die Personen über «Passwort vergessen» ein Passwort setzen.',
          response: { 204: Type.Null() },
        }),
      }, async (req, reply) => { const sc = await scope(req); await on().ent.disconnect(sc); return reply.status(204).send(null); });
    };
    entraRoutes(`${prefix}/admin/entra`, own, false);
    entraRoutes(`${prefix}/platform/organizations/:alias/entra`, byAlias, true);

    // ---------------------------------------------------------------- Link an die Entra-Administration
    /** Links erzeugen: je Person 10 pro Minute (dazu höchstens 5 offene je Organisation). */
    const linkLimit = { max: 10, timeWindow: 60_000, keyGenerator: (req: FastifyRequest) => `${rlPrefix}entra-link:${req.principal?.tenantId ?? ''}:${req.principal?.subject ?? req.ip}` };
    const linkRoutes = (base: string, scope: (req: FastifyRequest) => Promise<Scope> | Scope, withAlias: boolean) => {
      const p = withAlias ? { params: AliasParams } : {};
      app.post(`${base}/consent-links`, {
        schema: routeSchema(ctx, 'POST', `${base}/consent-links`, {
          tags: [TAG], summary: 'Verbinden: Link an die Entra-Administration erzeugen', ...p,
          body: Type.Object({
            tenant: Type.String({ minLength: 3, maxLength: 253, description: 'Tenant-ID (GUID) oder eine Domäne des Tenants' }),
            validMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 1440, description: 'Gültigkeit in Minuten (Standard 15, höchstens 24 Stunden)' })),
            kind: Type.Optional(LinkKind),
          }, { additionalProperties: false }),
          description: `Für eine andere Person der Kunden-IT, die bei Microsoft zustimmen darf (höchstens 5 offene je Organisation, sonst 409 \`too-many-links\`; 10 pro Minute und Person): \`url\` führt ohne Anmeldung in der App auf die öffentliche Seite \`${handoverPath(iam.cfg)}\` der Oberfläche (Token im Fragment). Einmal einlösbar, an Organisation und Tenant gebunden, widerrufbar. \`kind\` (Standard: \`consent\` mit App der Plattform, sonst \`credentials\`): Zustimmung mit Nachweis wie beim eigenen Verbinden (ID-Token einer globalen Administration oder «Privileged Role Administrator») bzw. eigene App eintragen (Tenant fest aus dem Link).`,
          response: { 201: Type.Object({ id: Type.String({ format: 'uuid' }), kind: LinkKind, url: Type.String(), entraTenantId: Type.String({ format: 'uuid' }), expiresAt: DateTime }) },
        }),
        config: { rateLimit: linkLimit },
      }, async (req, reply) => { const sc = await scope(req); return reply.status(201).send(await on().ent.createConsentLink(sc, req.body as { tenant: string; validMinutes?: number; kind?: 'consent' | 'credentials' })); });

      app.get(`${base}/consent-links`, {
        schema: routeSchema(ctx, 'GET', `${base}/consent-links`, {
          tags: [TAG], summary: 'Verbinden: Links an die Entra-Administration', ...p,
          description: 'Alle offenen und die letzten 20 erledigten Links mit Art und Zustand: `open`, `in-progress`, `expired`, `revoked`, `connected` (mit zustimmender Person, bei `credentials` ohne), `failed` (letzter Versuch mit Fehler, Link noch offen bis zum Ablauf).',
          response: { 200: Type.Object({ items: Type.Array(Type.Ref('EntraConsentLink')) }) },
        }),
      }, async req => { const sc = await scope(req); return { items: await on().ent.consentLinks(sc) }; });

      app.delete(`${base}/consent-links/:id`, {
        schema: routeSchema(ctx, 'DELETE', `${base}/consent-links/:id`, {
          tags: [TAG], summary: 'Verbinden: Link widerrufen', params: Type.Object({ ...(withAlias ? AliasParams.properties : {}), id: Type.String({ format: 'uuid' }) }),
          description: 'Offene Zustimmungen über den Link verfallen mit. Schon eingelöst: 409.', response: Deleted,
        }),
      }, async (req, reply) => { const sc = await scope(req); await on().ent.revokeConsentLink(sc, (req.params as { id: string }).id); return reply.status(204).send(); });
    };
    linkRoutes(`${prefix}/admin/entra`, own, false);
    linkRoutes(`${prefix}/platform/organizations/:alias/entra`, byAlias, true);

    // Öffentlich (ohne Anmeldung, siehe plugin.ts): Seite der Entra-Administration. Je IP 20 Anfragen pro Minute; keine
    // Daten ausser Name der Organisation und Produkt; nie zwischengespeichert
    const handoverLimit = { max: 20, timeWindow: 60_000, keyGenerator: (req: FastifyRequest) => `${rlPrefix}entra-handover:${req.ip}` };
    const publicRoute = (path: string, summary: string, description: string, body: TSchema, response: TSchema, fn: (b: any) => Promise<unknown>) =>
      app.post(`${prefix}/entra/handover/${path}`, {
        schema: routeSchema(ctx, 'POST', `${prefix}/entra/handover/${path}`, { tags: [TAG], summary, description, body, security: [], response: { 200: response } }),
        config: { rateLimit: handoverLimit },
      }, async (req, reply) => { reply.header('cache-control', 'no-store'); return fn(req.body); });
    const Token = Type.Object({ token: Type.String({ maxLength: 107, pattern: '^[a-z0-9][a-z0-9_-]{0,62}\\.[A-Za-z0-9_-]{43}$', description: 'Token aus dem Fragment des Links: `<alias>.<43 Zeichen base64url>`' }) }, { additionalProperties: false });
    publicRoute('info', 'Link der Entra-Administration: Angaben', 'Ohne Anmeldung. Name der Organisation, Produkt, wer fragt, Verzeichnis und Hinweis für die Seite. Unbekannt, abgelaufen, widerrufen oder eingelöst: immer 404.',
      Token, Type.Object({
        kind: LinkKind, organization: Type.String(), product: Type.String(),
        requestedBy: Type.String({ description: 'Name der Person, die den Link erzeugt hat' }),
        tenant: Type.String({ description: 'Verzeichnis (Domäne bzw. Tenant-ID) wie bei der Erzeugung angegeben' }),
        entraTenantId: Type.String({ format: 'uuid', description: 'Tenant-ID, in dem zugestimmt werden muss' }), expiresAt: DateTime,
        notice: Type.String({ description: 'Hinweis für die Seite: Was die Zustimmung bewirkt (verifizierte Domänen gehen an die Organisation)' }),
        ownApp: Nullable(OwnAppGuide),
      }), b => on().ent.handoverInfo(b.token));
    publicRoute('start', 'Link der Entra-Administration: Zustimmung starten', 'Ohne Anmeldung. Adresse der Zustimmung bei Microsoft (Code-Flow mit PKCE, `prompt=admin_consent`); Rückkehr auf dieselbe Seite wie beim eigenen Verbinden, `state` mit `h.`. Wiederholbar, solange der Link offen ist.',
      Token, Type.Object({ url: Type.String() }), b => on().ent.handoverStart(b.token));
    publicRoute('complete', 'Link der Entra-Administration: Rückkehr von Microsoft', 'Ohne Anmeldung. Gleicher Nachweis wie `…/consent/complete` (sonst 409 `consent-unproven` bzw. `consent-error`); verbindet im Namen der Person, die den Link erzeugt hat. Erfolg löst den Link ein; ein Fehlschlag verbraucht nur den `state`.',
      ConsentComplete, Type.Object({ organization: Type.String(), connected: Type.Literal(true) }), b => on().ent.handoverComplete(b));
    publicRoute('credentials', 'Link der Entra-Administration: eigene App eintragen', `Ohne Anmeldung, nur für Links mit \`kind: credentials\` (sonst 409 \`link-kind\`). Tenant fest aus dem Link; gleiche Prüfung wie \`PUT …/entra/app\`, verbunden im Namen der Person, die den Link erzeugt hat. Erfolg löst den Link ein, ein Fehlschlag gibt ihn mit dem Fehler wieder frei. ${APP_ERRORS}`,
      Type.Object({ token: Token.properties.token, ...AppCredentials }, { additionalProperties: false }), Type.Object({ organization: Type.String(), connected: Type.Literal(true) }),
      b => on().ent.handoverApp(b.token, b));

    // Testanmeldung: jede Person der Organisation, deren Sitzung über den Anbieter angemeldet ist (nicht nur org-admin)
    app.post(`${prefix}/admin/entra/test`, {
      schema: routeSchema(ctx, 'POST', `${prefix}/admin/entra/test`, {
        tags: [TAG], summary: 'Testanmeldung über Microsoft festhalten',
        description: 'Nach der Anmeldung über `testLoginPath`: Die Sitzung muss über den Anbieter der Organisation angemeldet sein (Claim `identity_provider`) und die Adresse in einer gebundenen Domäne liegen, sonst 409. Voraussetzung für «Nur Entra».',
        response: { 200: Type.Ref('EntraConnection') },
      }),
    }, async req => {
      const p = personOf(req);
      return on().ent.test({ alias: p.tenantAlias, actor: p, platform: false, source: req.source, correlationId: req.id });
    });
    app.post(`${prefix}/platform/entra/refresh`, {
      schema: routeSchema(ctx, 'POST', `${prefix}/platform/entra/refresh`, {
        tags: [TAG], summary: 'Alle Entra-Verbindungen aktualisieren', description: 'Z. B. nach einem neuen ENTRA_CLIENT_SECRET: führt die Identitätsanbieter aller Organisationen nach.',
        response: { 200: Type.Object({ refreshed: Type.Array(Type.String()), failed: Type.Array(Type.Object({ alias: Type.String(), detail: Type.String() })) }) },
      }),
    }, async req => { const sc = platform(req); return on().ent.refreshAll(sc); }); // erst das Recht (403), dann eingerichtet (503)
  },
};
