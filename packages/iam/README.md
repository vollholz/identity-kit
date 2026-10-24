# @vollholz/iam

Backend-Baustein (Node 24, TypeScript, Fastify-Adapter). Spezifikation Kap. 4–10 und 12; Entwurf und Festlegungen in
[`docs/entwurf.md`](docs/entwurf.md).

Inhalt: Konfiguration, Token-Prüfung (Bearer, DPoP, mTLS), Principal, BFF (`/auth/*`), Modell (`defineModel`),
Tupel (`authz_tuple`), Entscheidung nach Spez. 7.5 (Rolle am Ort ∨ Zuständigkeit ∨ Besitz) ∧ Klassifizierung ∧ Scope ∧
Client-Freigabe, Lesesicht je Anfrage (RLS-Funktionen `app.*`), «Wer hat Zugriff?» und «Warum?» (`/v1/access…`),
Verwaltung (`/v1/admin/*`, `/v1/platform/*`) mit Freigabestufe und Clients, Break-Glass, Abgleich und Aufräumen,
MCP-Token-Austausch, SQL-Migrationen `iam_…`.

Herkunft: vollholz/assets `src/platform/{auth,authz}`, `src/platform/modules/{auth,admin}`, `src/platform/ops/tenants.ts`,
`src/platform/worker/member-sync.ts`, IAM-Teile der Migrationen.

## Änderungen

- **1.1.0:** Zuständigkeit über Personen aus Fachdaten (Spez. 7.5 Regel 2, 7.7): `ResourceModel.edges.persons` (SQL mit
  `$1 uuid[]`, Spalten `id`, `principal_id`, `grants`, `label`) und optional `edges.personGrants` (für «Recht
  irgendwo»); `can`, `need`, `capabilities(refs)` berücksichtigen sie (∧ Klassifizierung ∧ Scope). Migration
  `iam_016_person_scope`: `app.read_person()`, `app.write_person()` für die Lesesicht. «Wer hat Zugriff?» und «Warum?»
  mit `via: 'data'` und `data: { relation, grants }` (nicht entfernbar).
- **1.0.0 (brechend, «Authz neu»):** ReBAC in PostgreSQL statt Rollen im Token und Zugriffsregeln.
  - `defineModel` ersetzt `defineCatalog` (Typen, Kette, Blätter, Klassifizierung, Besitz, Zuständigkeit; Prüfungen
    M1–M12); `platformJson()` nur noch mit Scopes (O4); reservierte Rechte `access:admin`, `audit:read` statt `acl:*`.
  - Migration `iam_015_authz`: Tabelle `authz_tuple`, Spalten der Freigabestufe am Principal, Funktionen der Lesesicht;
    entfernt `acl_entry`, `tenant_role`, `client_grant` (Daten werden nicht übernommen). `iamMigrations({ model })`
    statt `resourceTypes`/`leafTypes`; `syncModelChecks` statt `syncAclChecks`.
  - Rollen nie mehr aus dem Token oder aus Keycloak-Gruppen: `ROLE_SOURCE`, `ROLE_CLIENT_ID`, `GROUP_ROLE_PREFIX`
    entfallen. Gruppen aus Entra ID (Objekt-IDs, Mapper `entra-groups`) und «Alle Mitglieder» sind Subjekte.
  - Neue Module `access` (`/v1/access…`) und `break-glass`; entfernt `acl` (`/v1/acl…`) und `roles` (`/v1/roles…`).
    Mitgliederliste mit Clients, Freigabestufe (`PUT …/members/{id}/clearance`), Clients mit Rollen als Tupel
    (`PUT /v1/admin/clients/{clientId}` mit `roles`), `/v1/me` und `/auth/me` mit `clearance`, `breakGlassUntil`.
  - `ResourceModel` mit `classification`, `edges` (Zuständigkeit) und `ids` (Lesesicht von Typen mit `self`);
    `req.capabilities(refs?)` lädt Fakten für Listen auf einmal. Signaturen von `need`, `needSomewhere`, `can`, `tx`
    unverändert.
  - `iam-org-bootstrap`: Mandant, Principal, Tupel `org-admin` und Freigabestufe 2 in der Datenbank der App
    (`DATABASE_ADMIN_URL`); keine Rollengruppen, keine Optionen `--catalog`/`--roles` mehr.
  - Entra: Anwendungsberechtigung `GroupMember.Read.All` zusätzlich (Gruppensuche).
- **0.4.0:** `org-admin` kommt aus dem Baukasten bis in den Realm: `catalog.platformJson()` führt `org-admin` nicht mehr
  (das Realm-Modul `product-realm` ≥ 0.2.0 legt die Rolle an; **brechend**: zusammen mit dem Modul anheben),
  `iam-org-bootstrap` ergänzt die Gruppe `org-admin` selbst. Reservierte Rechte und Gruppen darf die App ohne Label und
  Gruppe aufführen (nur Reihenfolge, Beschreibung, Ressourcentypen); Label und Gruppe kommen aus dem Baukasten.
  Rollen, Scopes, Fähigkeiten und MCP-Werkzeuge bestimmen den Typ der Rechte nicht mehr mit (`NoInfer`). Die erzeugte
  Beschreibung von `org-admin` nennt die Rechtegruppen in Anzeigereihenfolge («A, B und C»).
- **0.3.0:** Entra mit eigener App der Organisation (`PUT …/entra/app`, Migration `iam_014`): Tenant, Anwendungs-ID
  und Geheimnis der Kunden-App, geprüft bei Microsoft vor dem Speichern, Geheimnis verschlüsselt (`ENCRYPTION_KEYS`,
  Rotation `rewrapEntraSecrets`), Anbieter `entra-app-<alias>`, Ablauf des Geheimnisses mit Warnung. Link
  `kind: 'credentials'` mit öffentlichem `POST /v1/entra/handover/credentials`. `ENTRA_CLIENT_ID` ist optional (ohne:
  Zustimmung 409 `platform-app-disabled`). Status mit `methods`, `ownApp`; Verbindung mit `method`, `clientId`,
  `secretExpiresAt`, `secretExpiresSoon`, `redirectUri`. Fehler mit `reason` `tenant-mismatch`.
- **0.2.2:** `RATE_LIMIT_NAMESPACE`: Vorsatz vor den Rate-Limit-Schlüsseln des Pakets (`<namespace>:<produkt>:…`),
  damit Umgebungen mit demselben geteilten Speicher (z. B. E2E und lokale App) getrennt zählen.
- **0.2.1:** Rechte im OpenAPI wieder als `enum` aus dem Katalog (`Role.permissions`, `customPermissions` von
  `GET /v1/roles` und der Plattformroute, Rollen im Status). Warnung im Log, wenn Fastify unbekannte Felder still
  entfernt (`removeAdditional`); die Tests des Pakets laufen mit `removeAdditional: false`.
  Entra: Token und `state` mit kanonischem Alias (klein), auch wenn Keycloak die Organisation mit Grossbuchstaben
  führt (vorher war ein solcher Link unbrauchbar).
- **0.2.0:** Link an die Entra-Administration (`…/entra/consent-links`, öffentlich `/v1/entra/handover/*`, Migration
  `iam_013`): Eine andere Person der Kunden-IT stimmt ohne Sitzung in der App bei Microsoft zu.
- **0.1.1:** Übernahme späterer IAM-Migrationen (`adopted.map`, `ASSETS_ADOPTION`): Assets mit 051–053 lässt sich
  umstellen, ohne dass `iam_012` am bestehenden Index scheitert.
- **0.1.0:** erste Veröffentlichung.

## Inhalt

Leitfaden für Apps: [`docs/backend.md`](docs/backend.md).

| Baustein | Inhalt |
|---|---|
| `loadIamConfig(env, { product, service })`, `IAM_VARS(product)`, `readVars`, `iamConfigErrors`, `iamConfig`, `iamWarnings` | Variablen nach Kap. 13 mit Standardwerten je Produkt, Pflicht je Dienst, Warnungen bei Client-Geheimnissen |
| `migrate(adminUrl, sources)`, `iamMigrations({ product, schema?, model?, adopted? })`, `dirMigrations(dir)`, `syncModelChecks` | Runner (wie Assets) und die Migrationen `iam_001`–`iam_015`; Abgleich der CHECKs von `authz_tuple` mit dem Modell; Übernahme bestehender Objekte mit Prüfung der Vorbedingungen |
| `db/bootstrap.sql` | Datenbankrollen nach Kap. 10.1 (psql-Variablen `p`, `db`, Passwörter) |
| `withTx`, `withTenant`, `setContext`, `createPool` | Transaktion im Mandantenkontext (`app.tenant_id`, `app.principal_id`, Einstellungen der App) |
| `pgAudit({ schema })`, `AuditPort` | Audit in derselben Transaktion (Hash-Kette per Trigger) |
| `HttpError`, `problemBody` | Fehler nach RFC 9457 |
| `Sealer`, `box`/`unbox` | AES-256-GCM mit Schlüsselrotation (Sitzungen) |
| `PgReplayStore`, `MemoryReplayStore`, `pgRateLimitStore`, `purgeSharedState` | geteilter Zustand über Instanzen |
| `LOCKS`, `lockKey` | Sperren in PostgreSQL als Vertrag |
| `defineModel(input)`, `ModelError` | Modell der App: reservierte Namen ergänzt, `org-admin` mit allen Rechten, Typen und Relationen, Prüfungen M1–M12 (Kap. 8), `toJSON()` = `GET /v1/authz/catalog`, `platformJson()` (nur Scopes) |
| `TupleStore` (`iam.tuples`), `AccessInfo` (`iam.info`) | Tupel lesen und schreiben mit Audit (`access.granted`, `access.revoked`), Ablauf; «Wer hat Zugriff?», «Warum?», was ich vergeben darf |
| `setOrgRoles`, `setClearance`, `checkRoleChange`, `lastAdminGuard` | Regeln der Verwaltung (Kap. 9.1): `org-admin` nur Plattform, niemand gibt mehr, als er hat, letzte aktive Person mit org-admin, Freigabestufe nie für sich und nie über die eigene |
| `OidcProvider`, `TokenVerifier` | Token-Prüfung: Signatur, Aussteller, Zielgruppe, nur Access Tokens, DPoP mit Replay-Schutz, mTLS |
| `PrincipalResolver` | Principal aus dem Token: Organisation und Wahl, Person oder Client, Subjekte (Person, Gruppen aus Entra, «Alle Mitglieder»), Client-Freigabe über Tupel, Austritt, «Nur Entra» |
| `AccessService`, `ResourceModel`, `flatResources`, `capabilities`, `canSchema`, `fullView` | Entscheidung nach 7.5 mit der Kette der App, Lesesicht je Anfrage, Fähigkeiten `can`, Zugriffsstand für ETags |
| `createIam(…)`, `readinessChecks(iam)` | Abhängigkeiten einmal gebaut (Verifier, Resolver, Entscheidung, Replay-Schutz, Audit); Prüfungen für `/readyz` der App |
| `iamPlugin`, `need(perm, ref?)` | Fastify-Plugin: Anmeldung je Anfrage (Bearer, DPoP, mTLS, Sitzung mit CSRF), `req.principal`, `req.tx`, `req.need`, `req.needSomewhere`, `req.can`, `req.capabilities`, `req.audit`; Fehler als problem+json; `need` als preHandler |
| Module `account`, `access`, `break-glass` | `GET /v1/me`, `GET /v1/authz/catalog`; `GET /v1/access` (Ort oder Subjekt), `GET /v1/access/explain`, `GET /v1/access/groups`, `POST /v1/access`, `PATCH/DELETE /v1/access/:id`; `POST/DELETE /v1/break-glass` |
| `KeycloakAdmin`, `listTenants`, `createTenant`, `setTenantStatus`, `relinkTenant` | Keycloak-Admin-API (Organisationen, Konten, Anbieter und ihre Mapper) und Mandanten über alle hinweg (Betrieb, Plattform-Administration) |
| Modul `clients`, `listClients` | Freigabe von Maschinen-Clients je Mandant mit Rollen als Tupel an org (`/v1/admin/clients…`, `/v1/platform/organizations/:alias/clients…`) |
| `AdminService` (`iam.admin`), Modul `admin` | Verwaltung ohne Keycloak-Konsole: `GET /v1/admin/status`, Mitglieder und Clients auflisten, einladen, entfernen (löscht die Tupel), Rollen und Freigabestufe setzen (`/v1/admin/members…`, `/v1/platform/organizations/:alias/members…`), Organisationen anlegen, ändern, sperren (`/v1/platform/organizations…`); ohne `KEYCLOAK_MGMT_CLIENT_ID` 503 |
| `EntraService` (`iam.entra`), `EntraGraph`, Modul `entra` | Anmeldung über Microsoft Entra ID je Organisation: Admin-Zustimmung, Domänen, «Nur Entra», Personen aus Entra ID hinzufügen, Gruppen suchen (Mapper `entra-groups`); Rückkehrpfade aus `ENTRA_UI_PATH` |
| Modul `people` | Personenverzeichnis `/v1/people…` mit Suche, Cursor und `ids`; Recht über die Option `people.permissions` |
| `MemberSync`, `syncAllMembers`, `syncTenantMembers`, `expireAccess`, `expireAllAccess` | Abgleich der Mitglieder ins Personenverzeichnis (Worker, `KEYCLOAK_SYNC_*`, `MEMBER_SYNC_INTERVAL`), Name der Organisation, Aufräumen abgelaufener Tupel und Break-Glass |
| `optionalBodies` | `transformObject` für `@fastify/swagger`: optionale Bodies (`POST …/suspend`, `…/resume`) als optional ausweisen |
| `Bff`, Modul `bff` | Anmeldung der Oberfläche unter `/auth/*`: Code-Flow mit PKCE, verschlüsselte Sitzung, CSRF, Erneuerung, Organisation je Tab, Abmeldung und Backchannel-Logout |
| `McpAuth`, `registerMcpAuth`, `TokenExchanger`, `DpopSigner`, `ApiClient` | MCP-Dienst der App: Anmeldung (RFC 9728, nur Hosts aus `MCP_HOST_CLIENT_IDS`), Token Exchange DPoP-gebunden, Organisation über `X-Tenant`/`?org=`, Aufrufe der REST-API |
| `orgBootstrap`, `iam-org-bootstrap` | Ersteinrichtung einer Organisation: Organisation und erste Person in Keycloak, Mandant, Tupel `org-admin` und Freigabestufe 2 in der Datenbank (idempotent, Probelauf) |
| `IAM_API_TAGS`, Option `openapi` | Tags der Routen; Tags, Texte und Feldbeschreibungen der App ersetzen die produktneutralen Standardtexte |

```ts
import { createIam, createPool, defineModel, dirMigrations, IAM_API_TAGS, iamMigrations, iamPlugin, loadIamConfig, migrate, need, pgAudit } from '@vollholz/iam';

export const model = defineModel({ product: 'notes', permissions: { 'note:read': { label: 'Notizen lesen', group: 'notes', description: '…' } },
  groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }], roles: { viewer: { label: 'Leser:in', description: 'Liest Notizen.', permissions: ['tenant:read', 'note:read'] } },
  scopes: { 'notes:read': { text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] } } });

const cfg = loadIamConfig(process.env, { product: 'notes', service: 'api' });
await migrate(cfg.db.adminUrl!, [
  iamMigrations({ product: 'notes', model }),
  dirMigrations('db/migrations'),
]);

// API: OpenAPI der App zuerst (sie sieht dann die Routen des Pakets), danach das Plugin, dann die Fachrouten
const iam = createIam({ cfg, model, db: createPool(cfg.db.url, cfg, 'notes-api'), schema: 'notes', resources, audit: pgAudit({ schema: 'notes' }) });
await app.register(swagger, { openapi: { tags: [...IAM_API_TAGS, …] } });
await app.register(iamPlugin, { iam, publicPaths: ['/v1/openapi.json', '/v1/docs', '/v1/docs/*'] });
app.get('/v1/notes/:id', { preHandler: need('note:read', r => ({ type: 'note', id: r.params.id })) }, …);
```

Tests: `npm test` (mit PostgreSQL: `POSTGRES_SUPERUSER_PASSWORD`, `POSTGRES_PORT`; Rollen legen die Tests selbst an).
Pflichttests nach Spez. Kap. 14: `model`, `access`, `read-view`, `access-http`, `break-glass`, `admin`,
`tenant-isolation`, `multi-org`, `rls`.
