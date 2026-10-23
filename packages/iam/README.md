# @vollholz/iam

Backend-Baustein (Node 24, TypeScript, Fastify-Adapter). Spezifikation Kap. 4–10 und 12; Entwurf und Festlegungen in
[`docs/entwurf.md`](docs/entwurf.md).

Inhalt: Konfiguration, Token-Prüfung (Bearer, DPoP, mTLS), Principal, BFF (`/auth/*`), Entscheidung
(Rolle ∨ Freigabe) ∧ Scope ∧ kein Verbot/keine Beschränkung mit dem Katalog der App, Zugriffsregeln (`/v1/acl…`),
eigene Rollen (`/v1/roles`), Verwaltung (`/v1/admin/*`, `/v1/platform/*`), Abgleich der Mitglieder, Freigaben von
Maschinen-Clients, MCP-Token-Austausch, SQL-Migrationen `iam_…`.

Herkunft: vollholz/assets `src/platform/{auth,authz}`, `src/platform/modules/{auth,admin}`, `src/platform/ops/tenants.ts`,
`src/platform/worker/member-sync.ts`, IAM-Teile der Migrationen.

## Änderungen

- **0.1.1:** Übernahme späterer IAM-Migrationen (`adopted.map`, `ASSETS_ADOPTION`): Assets mit 051–053 lässt sich
  umstellen, ohne dass `iam_012` am bestehenden Index scheitert.
- **0.1.0:** erste Veröffentlichung.

## Inhalt

Leitfaden für Apps: [`docs/backend.md`](docs/backend.md).

| Baustein | Inhalt |
|---|---|
| `loadIamConfig(env, { product, service })`, `IAM_VARS(product)`, `readVars`, `iamConfigErrors`, `iamConfig`, `iamWarnings` | Variablen nach Kap. 13 mit Standardwerten je Produkt, Pflicht je Dienst, Warnungen bei Client-Geheimnissen |
| `migrate(adminUrl, sources)`, `iamMigrations({ product, schema?, resourceTypes?, leafTypes?, adopted? })`, `dirMigrations(dir)` | Runner (wie Assets) und die Migrationen `iam_001`–`iam_012`; Übernahme bestehender Objekte mit Prüfung der Vorbedingungen |
| `db/bootstrap.sql` | Datenbankrollen nach Kap. 10.1 (psql-Variablen `p`, `db`, Passwörter) |
| `withTx`, `withTenant`, `setContext`, `createPool` | Transaktion im Mandantenkontext (`app.tenant_id`, `app.principal_id`, Einstellungen der App) |
| `pgAudit({ schema })`, `AuditPort` | Audit in derselben Transaktion (Hash-Kette per Trigger) |
| `HttpError`, `problemBody` | Fehler nach RFC 9457 |
| `Sealer`, `box`/`unbox` | AES-256-GCM mit Schlüsselrotation (Sitzungen) |
| `PgReplayStore`, `MemoryReplayStore`, `pgRateLimitStore`, `purgeSharedState` | geteilter Zustand über Instanzen |
| `LOCKS`, `lockKey` | Sperren in PostgreSQL als Vertrag |
| `defineCatalog(input)` | Rechtekatalog der App: reservierte Namen ergänzt, `org-admin` mit allen Rechten, Prüfungen (Kap. 8, Stichwörter je Gruppe, Rechte nur für Personen), `toJSON()` = `GET /v1/authz/catalog`, `platformJson()` |
| `OidcProvider`, `TokenVerifier` | Token-Prüfung: Signatur, Aussteller, Zielgruppe, nur Access Tokens, DPoP mit Replay-Schutz, mTLS |
| `PrincipalResolver` | Principal aus dem Token: Organisation und Wahl, Person oder Client, Rollen und Gruppen der Organisation, Freigabe, Austritt, «Nur Entra», Zwischenspeicher mit `forget…` |
| `AccessService`, `ResourceModel`, `flatResources`, `capabilities`, `canSchema` | Entscheidung (Rolle ∨ Freigabe) ∧ Scope ∧ Zugriffsregeln mit der Kette der App, Fähigkeiten `can`, Zugriffsstand für ETags |
| `createIam(…)`, `readinessChecks(iam)` | Abhängigkeiten einmal gebaut (Verifier, Resolver, Entscheidung, Replay-Schutz, Audit); Prüfungen für `/readyz` der App |
| `iamPlugin`, `need(perm, ref?)` | Fastify-Plugin: Anmeldung je Anfrage (Bearer, DPoP, mTLS, Sitzung mit CSRF), `req.principal`, `req.tx`, `req.need`, `req.needSomewhere`, `req.can`, `req.capabilities`, `req.audit`; Fehler als problem+json; `need` als preHandler |
| Module `account`, `acl` | `GET /v1/me`, `GET /v1/authz/catalog`; `GET/POST /v1/acl`, `DELETE /v1/acl/:id`, `GET /v1/acl/effective` (echt und Simulation) |
| `KeycloakAdmin`, `listTenants`, `createTenant`, `setTenantStatus`, `relinkTenant` | Keycloak-Admin-API (Organisationen, Konten, Gruppen, Anbieter) und Mandanten über alle hinweg (Betrieb, Plattform-Administration) |
| Modul `clients` | Freigabe von Maschinen-Clients je Mandant (`/v1/admin/clients…`, `/v1/platform/organizations/:alias/clients…`) |
| `AdminService` (`iam.admin`), Modul `admin` | Verwaltung ohne Keycloak-Konsole: `GET /v1/admin/status`, Mitglieder einladen, entfernen, Rollen setzen (`/v1/admin/members…`, `/v1/platform/organizations/:alias/members…`), Organisationen anlegen, ändern, sperren (`/v1/platform/organizations…`); ohne `KEYCLOAK_MGMT_CLIENT_ID` 503 |
| `EntraService` (`iam.entra`), `EntraGraph`, Modul `entra` | Anmeldung über Microsoft Entra ID je Organisation: Admin-Zustimmung, Domänen, «Nur Entra», Personen aus Entra ID hinzufügen; Rückkehrpfade aus `ENTRA_UI_PATH` |
| Modul `roles` | Vordefinierte und eigene Rollen (`/v1/roles…`): anlegen, ändern mit `If-Match`, löschen (Gruppe in Keycloak und ACL-Einträge weg, Grabstein) |
| Modul `people` | Personenverzeichnis `/v1/people…` mit Suche, Cursor und `ids`; Recht über die Option `people.permissions` |
| `MemberSync`, `syncAllMembers`, `syncTenantMembers` | Abgleich der Mitglieder ins Personenverzeichnis (Worker, `KEYCLOAK_SYNC_*`, `MEMBER_SYNC_INTERVAL`) und Name der Organisation |
| `optionalBodies` | `transformObject` für `@fastify/swagger`: optionale Bodies (`POST …/suspend`, `…/resume`) als optional ausweisen |
| `Bff`, Modul `bff` | Anmeldung der Oberfläche unter `/auth/*`: Code-Flow mit PKCE, verschlüsselte Sitzung, CSRF, Erneuerung, Organisation je Tab, Abmeldung und Backchannel-Logout |
| `McpAuth`, `registerMcpAuth`, `TokenExchanger`, `DpopSigner`, `ApiClient` | MCP-Dienst der App: Anmeldung (RFC 9728, nur Hosts aus `MCP_HOST_CLIENT_IDS`), Token Exchange DPoP-gebunden, Organisation über `X-Tenant`/`?org=`, Aufrufe der REST-API |
| `orgBootstrap`, `iam-org-bootstrap` | Ersteinrichtung einer Organisation mit Rollengruppen und erster Person (idempotent, Probelauf) |
| `IAM_API_TAGS`, Option `openapi` | Tags der Routen; Tags, Texte und Feldbeschreibungen der App ersetzen die produktneutralen Standardtexte |

```ts
import { createIam, createPool, defineCatalog, dirMigrations, IAM_API_TAGS, iamMigrations, iamPlugin, loadIamConfig, migrate, need, pgAudit } from '@vollholz/iam';

export const catalog = defineCatalog({ product: 'notes', permissions: { 'note:read': { label: 'Notizen lesen', group: 'notes', description: '…' } },
  groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }], roles: { viewer: { label: 'Leser:in', description: 'Liest Notizen.', permissions: ['tenant:read', 'note:read'] } },
  scopes: { 'notes:read': { text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] } } });

const cfg = loadIamConfig(process.env, { product: 'notes', service: 'api' });
await migrate(cfg.db.adminUrl!, [
  iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'note'], leafTypes: ['note'] }),
  dirMigrations('db/migrations'),
]);

// API: OpenAPI der App zuerst (sie sieht dann die Routen des Pakets), danach das Plugin, dann die Fachrouten
const iam = createIam({ cfg, catalog, db: createPool(cfg.db.url, cfg, 'notes-api'), schema: 'notes', resources, audit: pgAudit({ schema: 'notes' }) });
await app.register(swagger, { openapi: { tags: [...IAM_API_TAGS, …] } });
await app.register(iamPlugin, { iam, publicPaths: ['/v1/openapi.json', '/v1/docs', '/v1/docs/*'] });
app.get('/v1/notes/:id', { preHandler: need('note:read', r => ({ type: 'note', id: r.params.id })) }, …);
```

Tests: `npm test` (mit PostgreSQL: `POSTGRES_SUPERUSER_PASSWORD`, `POSTGRES_PORT`; Rollen legen die Tests selbst an).
Den Abzug von Assets für den Gleichheitstest erzeugt `node scripts/assets-schema.ts <assets>/db/migrations <commit>`,
den Katalog von Assets für den Pflichttest `node scripts/assets-catalog.ts <assets> <commit>`.
