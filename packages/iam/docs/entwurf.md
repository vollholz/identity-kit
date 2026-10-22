# @vollholz/iam – Entwurf

Stand 2026-10-22 · Status: **Entwurf zur Freigabe** · Vertrag: `docs/spezifikation.md` (Kap. 1.1, 4–10, 12–15) ·
Referenz: vollholz/assets `main` (`3a148ae`)

Dieser Entwurf legt fest, wie das Backend-Paket aussieht, bevor Code entsteht: öffentliche API, Katalog, Schnittstellen
zur App, Migrationen, Module, was in der App bleibt, Reihenfolge der Teil-PRs und wie Assets in Phase 2 umstellt.

## 1. Leitlinien

1. **Verhalten = Assets.** Das Paket ist Code aus Assets, herausgelöst und produktneutral gemacht – kein Neuentwurf.
   Jede Abweichung vom Verhalten von Assets steht in [Kapitel 11](#11-abweichungen-und-fragen-zum-vertrag). Assets
   stellt in Phase 2 um, ohne dass sich eine Antwort, ein Statuscode, ein Audit-Eintrag oder ein Datenbankobjekt ändert.
2. **Mandantentrennung zuerst** (Kap. 14). Jede Prüfung, die Assets hat, kommt mit: im Code und als Test. Kein
   Teil-PR übernimmt Code ohne die zugehörigen Tests ([Kapitel 8](#8-mandantentrennung-was-mitkommt)).
3. **Produktneutral.** Kein `assets` im Code: Schema, Datenbankrollen, Cookie-Namen, Realm-Text im
   `WWW-Authenticate`, Ablauf «Erstanmeldung» von Entra, Attribute der Clients kommen aus `product` bzw. den Optionen.
4. **Kern ohne Fastify, Adapter für Fastify.** Token-Prüfung, Principal, Entscheidung, Katalog, Keycloak-Zugang und
   Migrationen hängen nicht von Fastify ab (Worker, MCP-Dienst, Skripte nutzen sie ohne HTTP-Server). Routen und
   Request-Dekorationen liefert ein Fastify-Plugin (Spezifikation B3: zuerst nur Fastify).
5. **Aufbau wie das Test-Kit**: Node 24, TypeScript mit `rewriteRelativeImportExtensions`, Build nach `dist`,
   `node --test`, exakte Versionen, deutsche Kommentare in der Dichte von Assets.

## 2. Überblick

```
@vollholz/iam
├─ Kern (ohne Fastify)
│   config      loadIamConfig, IAM_VARS                         ← assets config/env.ts (IAM-Teil)
│   catalog     defineCatalog, Catalog                          ← assets authz/permissions.ts (Mechanik)
│   tokens      OidcProvider, TokenVerifier, parseClientCert    ← assets auth/tokens.ts
│   principal   PrincipalResolver, Alias- und Claim-Helfer      ← assets auth/principal.ts
│   access      AccessService, Fähigkeiten                      ← assets authz/{access,capabilities}.ts
│   db          withTx, withTenant, setContext                  ← assets db/pool.ts (IAM-Teil)
│   state       Replay-Schutz, Rate-Limit-Speicher, Bereinigung ← assets core/shared-state.ts
│   crypto      Sealer (Sitzung), box/unbox                     ← assets core/crypto.ts, modules/auth/sealer.ts
│   errors      HttpError, problem                              ← assets http/errors.ts, Teil von app.ts
│   keycloak    KeycloakAdmin (Admin-API, private_key_jwt)      ← assets modules/admin/keycloak.ts
│   tenants     listTenants, createTenant, setTenantStatus …    ← assets ops/tenants.ts (ohne Fachdaten)
│   sync        syncAllMembers, MemberSync (Worker-Job)         ← assets modules/admin/sync.ts, worker/member-sync.ts
│   mcp         TokenExchanger, DpopSigner                      ← assets mcp/{exchange,dpop}.ts
│   migrations  iamMigrations, migrate                          ← assets db/migrate.ts, IAM-Teile der Migrationen
└─ Fastify (Plugin `iam`)
    Anmeldung je Anfrage (Bearer, DPoP, mTLS, Sitzung), req.principal/tx/need/…, Fehler als RFC 9457
    Module: account · bff · acl · admin · roles · clients · entra
```

## 3. Öffentliche API

### 3.1 Einbinden

```ts
// src/authz/catalog.ts der App – einzige Quelle des Katalogs
export const catalog = defineCatalog({ product: 'notes', permissions: { … }, groups: [ … ], roles: { … }, scopes: { … },
  resources: { note: { label: 'Notiz', parent: 'tenant' } } });

// API
const cfg = loadIamConfig(process.env, { product: 'notes', service: 'api' });
const db = createPool(cfg.db.url, cfg, 'notes-api');
const iamCore = createIam({ cfg, catalog, db, schema: 'notes', resources, audit: pgAudit({ schema: 'notes' }) });
await app.register(iamPlugin, { iam: iamCore, modules: ['account', 'bff', 'acl', 'admin', 'roles', 'clients'] });
app.get('/v1/notes/:id', async req => { await req.need('note:read', { type: 'note', id: req.params.id }); … });

// Worker
const sync = new MemberSync(cfg, workerDb, { schema: 'notes' });   // KEYCLOAK_SYNC_*, MEMBER_SYNC_INTERVAL
sync.start(); …; await sync.stop();

// Migrationen (Besitzer-Rolle)
await migrate(cfg.db.adminUrl, [iamMigrations({ schema: 'notes', product: 'notes' }), dirMigrations('db/migrations')]);
```

`createIam` baut die Abhängigkeiten einmal (Verifier, Resolver, AccessService, Replay-Speicher, Bff, AdminService) und
ist das, was in Assets heute `Deps` ist; das Plugin registriert damit Hooks, Dekorationen und Routen. So kann die App
dieselbe Instanz auch ausserhalb von Fastify nutzen (Tests, MCP-Dienst, Skripte).

### 3.2 Optionen von `createIam`

| Option | Pflicht | Inhalt |
|---|---|---|
| `cfg` | ✓ | `IamConfig` aus `loadIamConfig` ([3.5](#35-konfiguration)) |
| `catalog` | ✓ | Ergebnis von `defineCatalog` ([Kapitel 4](#4-katalog-definecatalog)) |
| `db` | ✓ | `pg.Pool` der Laufzeit-Rolle (`<produkt>_runtime`) |
| `schema` | ✓ | Schema der Tabellen (`<produkt>`), geprüft `^[a-z][a-z0-9_]{0,62}$` |
| `resources` | mit Zugriffsregeln | `ResourceModel` ([5.4](#54-ressourcen-resourcemodel)) |
| `audit` | ✓ | `AuditPort` ([5.2](#52-audit)); Standard-Umsetzung `pgAudit({ schema })` |
| `events` | – | `(tx, type, subject, data) => Promise<void>`: Ereignis zu einer IAM-Änderung (Assets: Outbox `acl.changed`) |
| `replay` | – | `ReplayStore`; sonst nach `SHARED_STATE` (`postgres` → Tabelle `replay_guard`) |
| `fetch`, `entraFetch` | – | Abruf der Keycloak-Admin-API bzw. von Microsoft (Tests: `KeycloakFake` aus dem Test-Kit) |
| `entraRetryMs` | – | Wartezeiten nach der Admin-Zustimmung (Tests: `[0]`) |

Optionen des Plugins: `iam`, `modules` (Liste, Standard alle, die die Konfiguration erlaubt), `errorHandler`
(Standard `true`: Fehlerbehandlung und 404 als `application/problem+json`; `false`, wenn die App eigene hat),
`problemTypeBase` (URI-Präfix für `type`, Assets: `https://assets.example.ch/probleme/`), `apiPrefix` (`/v1`).

### 3.3 Anfrage

Das Plugin ist nicht gekapselt (`skip-override`, wirkt auf die ganze App) und registriert in `onRequest` die Anmeldung
wie Assets `http/app.ts`: Token aus `Authorization` (`Bearer`/`DPoP`) oder aus der Sitzung (BFF, mit CSRF für
schreibende Aufrufe), Prüfung, Principal, `DPOP_MODE`, `source` (`ui` | `api` | `mcp`). Pfade unter `apiPrefix`
brauchen ein Token, ausser die App nimmt sie aus (`publicPaths`, Assets: `/v1/openapi.json`, `/v1/docs*`); entschieden
am Routenmuster **und** am dekodierten Pfad (wie Assets `needsToken`).

| Dekoration | Verhalten |
|---|---|
| `req.principal`, `req.source` | wie Assets |
| `req.requirePrincipal()` | 401 ohne Anmeldung |
| `req.tx(fn)` | Transaktion im Mandantenkontext (`app.tenant_id`, `app.principal_id`, dazu der Kontext der App aus `resources.dbContext`) |
| `req.need(perm, ref?, hint?)` | (Rolle ∨ Freigabe) ∧ Scope ∧ Zugriffsregel, sonst 403 mit Label |
| `req.needSomewhere(perm)` | Recht irgendwo (Kap. 7.1) |
| `req.can(perm, ref?, hint?)`, `req.capabilities()` | Entscheidung ohne Wurf; `can` für viele Ressourcen mit einmal geladener ACL |
| `req.audit(tx, entry)` | Audit über den `AuditPort` in derselben Transaktion |

Hooks und Plugins der App (Rate-Limit, Idempotenz, OpenAPI, Telemetrie, CSP) bleiben in der App; sie sehen
`req.principal`, weil der Hook des Plugins vor ihren Routen-Hooks läuft (wie heute).

### 3.4 Typen

Rechte sind im Paket `string`. Damit `req.need('objekt:schreiben')` in der App zur Übersetzungszeit scheitert, erweitert
die App eine Register-Schnittstelle:

```ts
declare module '@vollholz/iam' { interface Register { catalog: typeof catalog } }
```

Danach sind `Permission`, `ResourceType` und die Rollen in allen Signaturen des Pakets die Typen des Katalogs der App.
Ohne Erweiterung gilt `string`.

### 3.5 Konfiguration

`loadIamConfig(env, { product, service })` liest genau die Variablen aus Kap. 13 (dazu `MCP_*` für den Austausch,
`ENTRA_*`, `DATABASE_*` für Pool und SSL) mit den Standardwerten der Spezifikation; `<produkt>` in Standardwerten
(`<produkt>-api`, `<produkt>-platform` …) setzt `product` ein. Geheimnisse auch als `…_FILE`. Regeln wie Assets: in
Produktion ohne `SESSION_SECRET` oder `ENCRYPTION_KEYS` kein Start der API; jeder Dienst verlangt nur seine Geheimnisse
(`service`: `api` | `worker` | `mcp`). `IAM_VARS` ist die Liste der Variablen mit Beschreibung, damit die App sie in
ihre eigene Liste (Doku, `.env.example`) übernimmt. Fehler: `ConfigError` mit allen Fehlern zugleich.

`IamConfig` hat dieselbe Form wie die Teile `oidc`, `tenancy`, `mgmt`, `memberSync`, `entra`, `m2m`, `session`,
`encryptionKeys`, `mcp`, `ops.sharedState`, `db` von Assets `PlatformConfig`; Assets lässt `PlatformConfig` davon
erben und ändert seine Variablen nicht.

## 4. Katalog: `defineCatalog`

Eingabe wie im Beispiel der Spezifikation (15.2), dazu:

- `product`: technischer Name (Lese-Scope `<product>:read`, Prüfung der Scopes).
- `capabilities`: Fähigkeit → Recht je Ressourcentyp (Assets `CAPABILITIES`), für `can` und `canSchema(type)`.
- `mcpTools` (KANN): Werkzeug → Titel, Recht, Lese-/Schreibart (Assets `MCP_TOOLS`); erscheint im Katalog.
- `features`: `members` (Standard `true`), `tenantSettings`, `audit`; `acl` folgt aus `resources`.

Was `defineCatalog` selbst tut:

1. **Reservierte Namen (Kap. 8.1) ergänzen**: `tenant:read` immer; `members:admin` mit `members`; `tenant:admin` mit
   `tenantSettings`; `acl:read`, `acl:admin` und Ressourcentyp `tenant` mit `resources`; `audit:read` mit `audit`; die
   Gruppen `tenant`, `members`, `access`, `audit` für genutzte Rechte. Führt die App ein reserviertes Recht selbst auf,
   müssen Label und Gruppe stimmen; die Beschreibung darf sie anpassen (Assets: `tenant:admin` nennt den Assistenten),
   die Reihenfolge bleibt ihre. So bleibt der Katalog von Assets byte-gleich.
2. **`org-admin`** erhält alle Rechte. Label fest, Beschreibung erzeugt («Verwaltet die Organisation vollständig:
   <Gruppen>. Enthält alle anderen Rollen.») oder von der App gesetzt (muss alle Gruppen nennen).
3. **Prüfen** und bei Verstoss mit `CatalogError` (alle Befunde) abbrechen: Schlüsselmuster, keine Kollision mit
   reservierten Namen, kein Präfix `c-`, kein `/` in Rollen, jede Rolle mit Label und einer Beschreibung, die alle
   Rechtegruppen der Rolle nennt, jeder Scope mit Text und nur bekannten Rechten, `members:admin` in keinem Scope, jedes
   Recht mit Label, Gruppe, Beschreibung und Ressourcentypen aus dem Katalog, Fähigkeiten und MCP-Werkzeuge nur mit
   bekannten Rechten. Die Regeln sind dieselben wie `checkCatalog` des Test-Kits; ein Test prüft, dass beide auf
   denselben Beispielkatalogen gleich urteilen.
4. **Berechnen**: `adminOnly`, `customRolePermissions`, `permissionsForRoles(roles, custom)` (eigene Rollen auf
   `customRolePermissions` begrenzt), `permissionsForScopes`, `scopeForPermission`, `permissionText`, `toJSON()` (=
   Antwort von `GET /v1/authz/catalog`), `platformJson()` (= `infra/keycloak/platform.json` für das Realm-Modul).

Eigene Rollen (Kap. 8.3) sind keine Eingabe: Die Mechanik liegt im Modul `roles`, die Höchstzahl ist eine Option
(`maxCustomRoles`, Standard 50).

## 5. Schnittstellen zur App

### 5.1 Datenbank und Kontext

- `withTx(db, fn)`, `withTenant(db, ctx, fn)`, `setContext(tx, ctx)` wie Assets; der Kontext setzt `app.tenant_id` und
  `app.principal_id` je Transaktion (`set_config(…, true)`, PgBouncer-tauglich).
- App-eigener Kontext (Assets: Lesesicht `app.read_all`, `app.read_types`) kommt aus `resources.dbContext(principal,
  access)` als zusätzliche Einstellungen derselben `set_config`-Abfrage. Das Paket kennt keine Lesesicht.
- Kein Weg ohne Mandantenkontext auf Mandantentabellen, ausser den SECURITY-DEFINER-Funktionen der Migrationen.

### 5.2 Audit

```ts
interface AuditPort { write(tx: Tx, who: Actor, e: AuditEntry): Promise<void> }
```

`pgAudit({ schema })` schreibt wie Assets `core/audit.ts` in `<schema>.audit_log` (Tabelle und Hash-Kette aus den
IAM-Migrationen). Alle Einträge des IAM (Kap. 9.1 Regel 8, `role.*`, `acl.*`, `client.*`, `people.synced`,
`organization.*`, `tenant.*`, `entra.*`) laufen über den Port, in derselben Transaktion wie die Änderung. Lesen des
Protokolls (`GET /v1/audit`, Anker, Prüfung der Kette) bleibt vorerst in der App ([Kapitel 7](#7-was-in-der-app-bleibt)).

### 5.3 Fehler

`HttpError(status, title, detail?, headers?, extra?)` und die Helfer `notFound`, `forbidden`, `conflict`, `invalid`
sind die von Assets. `problem(reply, err)` schreibt RFC 9457 (`type` = `problemTypeBase` + Status). Die Texte der Fehler
sind die von Assets (de, Du-Form). Hat die App einen eigenen Fehlerbehandler, erkennt sie `HttpError` aus dem Paket;
Assets exportiert in Phase 2 die Klasse des Pakets aus `http/errors.ts`, damit es nur eine gibt.

### 5.4 Ressourcen: `ResourceModel`

Die Kette der Zugriffsregeln definiert die App (Kap. 7.1). Damit `decide` synchron bleibt (Fähigkeiten über Listen ohne
Datenbankabfrage je Zeile, wie Assets), lädt das Paket den Zustand der Kette zusammen mit der ACL und fragt die App nur
synchron nach der Kette:

```ts
interface ResourceModel<S = unknown> {
  /** Zusatz zur Version des Zwischenspeichers (Assets: max(object_type.updated_at)); leer = nur acl_version. */
  version?(tx: Tx): Promise<string>;
  /** Zustand für die Kette, geladen mit der ACL im Mandantenkontext (Assets: Schema und Eltern je Objekttyp). */
  load?(tx: Tx): Promise<S>;
  /** Kette von oben nach unten, beginnt mit { type: 'tenant' }; `hint` z. B. Typ eines Objekts. */
  chain(state: S, ref: ResourceRef, hint?: string | null): ResourceRef[];
  /** Gibt es die Ressource im Mandanten? (POST /v1/acl, 404 sonst) */
  exists(tx: Tx, ref: ResourceRef): Promise<boolean>;
  /** Hinweise für viele Ressourcen auf einmal (GET /v1/acl/effective; Assets: Typ je Objekt). */
  hints?(tx: Tx, refs: ResourceRef[]): Promise<Map<string, string>>;
  /** Zusätzlicher Datenbank-Kontext je Anfrage (Assets: Lesesicht nach ACL). */
  dbContext?(p: Principal, access: AccessService): Promise<Record<string, string>>;
}
```

`flatResources(catalog)` ist die Standard-Umsetzung für Ressourcen direkt unter dem Mandanten (Kette `tenant → r`,
`exists` über eine Tabelle je Typ aus der Option `tables`). Die Spezifikation skizziert `resolveChain: async (tx, ref)`;
die synchrone Form ist eine bewusste Abweichung ([Kapitel 11](#11-abweichungen-und-fragen-zum-vertrag), A1).

Blätter der Kette (Freigabe `grant` nie auf dem Blatt, Kap. 7.1) nennt der Katalog: `resources.<typ>.leaf = true`
(Assets: `object`). Validierung beim Anlegen und die CHECK-Bedingung der Tabelle ([6.2](#62-parameter)) folgen daraus.

### 5.5 Keycloak, Microsoft, Zeit

Alle Aufrufe nach aussen über injizierbares `fetch` (Tests: `KeycloakFake` des Test-Kits, Entra-Nachbildung aus
Assets). Zeitabhängiges (Mindestdauer beim Einladen, Zwischenspeicher) wie Assets über `Date.now()` und
`timers/promises`.

## 6. Datenbank

### 6.1 Migrationen des IAM

Die Migrationen liegen als SQL mit Platzhaltern im Paket (`migrations/iam_NNN_*.sql`) und entsprechen dem **Stand von
Assets nach Migration 049**, aufgeteilt nach Thema statt nach Entstehung (Zwischenschritte wie `allow` → `restrict`
entfallen):

| Datei | Inhalt | aus Assets |
|---|---|---|
| `iam_001_core.sql` | Schemas `app` und `<schema>`, `REVOKE … FROM PUBLIC`, Standardrechte für Funktionen, `app.tenant_id()`, `app.principal_id()`, `app.secure_tenant_tables()` | 001, 044 (Funktionsrechte) |
| `iam_002_tenant.sql` | `tenant` (ohne FORCE, `tenant_self`), `app.resolve_tenant` mit Bindung an `kc_org_id`, `app.suspended_tenants`, `app.platform_tenants`, `app.set_tenant_status`, `app.bump_acl_version` | 001, 008, 016, 020 |
| `iam_003_principal.sql` | `principal` mit `removed_at`, `last_roles`, `last_scopes` | 001, 016, 045 |
| `iam_004_access.sql` | `acl_entry` (`restrict` \| `deny` \| `grant`, kein `grant` auf Blättern), `tenant_role` mit Grabstein; Trigger auf `acl_version` | 001, 048, 049 |
| `iam_005_members.sql` | `member_invitation` (eigene ID, `created_account`, `entra`), `client_grant` | 020, 043, 047 |
| `iam_006_session.sql` | `session` (Hash, verschlüsselt, `subject`, `idp_sid`), `replay_guard`, `rate_limit` (UNLOGGED) | 001, 006, 007 |
| `iam_007_audit.sql` | `audit_log` mit Hash-Kette v2 und Folgenummer, `audit_anchor`, nur lesen und anhängen | 001, 009 |
| `iam_008_entra.sql` | `entra_connection`, `entra_consent`, `app.entra_login_alias`, `app.entra_free_slot`, `app.entra_domains_taken` | 046 |

Die Entra-Tabellen kommen immer mit (leer, ohne Wirkung ohne `ENTRA_CLIENT_ID`), weil der Resolver
`app.entra_login_alias` immer fragt; so braucht es keine bedingten Migrationen.

### 6.2 Parameter

`iamMigrations({ schema, product, leafTypes })` setzt in die Platzhalter ein: Schema der Tabellen, Datenbankrollen
`<product>_app` und `<product>_sched`, Blatt-Typen für die CHECK-Bedingung von `grant` (Assets: `object`). Alle Werte
werden gegen Bezeichner-Muster geprüft und als `%I`/Literal eingesetzt, nie roh. Die Prüfsumme gilt für den
eingesetzten Text; dieselben Parameter ergeben dieselbe Prüfsumme.

### 6.3 Runner

`migrate(adminUrl, sources, log?)` ist der Runner von Assets (`db/migrate.ts`): Advisory-Lock, Tabelle
`public.schema_migrations (name, checksum, applied_at)`, jede Migration in einer Transaktion, danach
`app.secure_tenant_tables()`, Abbruch bei geänderter Prüfsumme. Neu: mehrere Quellen in fester Reihenfolge (IAM vor
App, Kap. 15.3), Namen eindeutig über alle Quellen (`iam_…` kollidiert nicht mit `NNN_…`).

### 6.4 Übernahme in Assets

Assets hat dieselben Objekte schon aus 001–049 und darf diese Dateien nicht ändern (Prüfsummen). Deshalb:

- `iamMigrations({ …, adopted: true })`: Der Runner trägt `iam_001`–`iam_008` mit ihrer Prüfsumme als angewendet ein,
  **ohne** sie auszuführen – erst, nachdem die Quelle der App gelaufen ist (frische Datenbank) bzw. sofort (bestehende
  Datenbank, 049 schon angewendet). Spätere IAM-Migrationen (`iam_009` …) laufen in Assets normal.
- **Gleichheitstest** (in Assets, Phase 2): eine frische Datenbank aus den Migrationen von Assets und eine aus
  `iam_001`–`iam_008` mit `schema: 'assets'` haben für alle IAM-Tabellen und -Funktionen dieselben Spalten, Typen,
  Standardwerte, CHECK-, UNIQUE- und Fremdschlüssel, Indizes, Policies, Trigger, Rechte und Funktionsrümpfe (Vergleich
  über `pg_catalog`). Erst wenn er grün ist, gilt die Übernahme. Abweichungen werden im Paket behoben, nicht in Assets.

## 7. Module

| Modul | Endpunkte / Inhalt | Voraussetzung | aus Assets |
|---|---|---|---|
| `account` | `GET /v1/me`, `GET /v1/authz/catalog` | immer | `http/app.ts`, `catalog/governance.ts` |
| `bff` | `/auth/login`, `/auth/entra/:idp`, `/auth/callback`, `/auth/me`, `/auth/switch`, `/auth/logout`, `/auth/backchannel-logout`; `SessionBridge` | `OIDC_BFF_CLIENT_ID` + Schlüssel | `modules/auth/{index,bff,sealer}.ts` |
| `acl` | `GET/POST /v1/acl`, `DELETE /v1/acl/:id`, `GET /v1/acl/effective` (echt und Simulation) | `resources` | `catalog/governance.ts`, `member-access.ts` |
| `admin` | `/v1/admin/status`, `/v1/admin/members…`, `/v1/platform/organizations…` | `KEYCLOAK_MGMT_CLIENT_ID` (sonst 503 nach 9.1 Nr. 11) | `modules/admin/{index,service,sync}.ts`, `ops/tenants.ts` |
| `roles` | `GET/POST /v1/roles`, `GET/PATCH/DELETE /v1/roles/:key` | immer lesbar; Ändern mit Verwaltung | `modules/admin/roles.ts` |
| `clients` | `/v1/admin/clients…`, `/v1/platform/organizations/:alias/clients…` | ohne Verwaltungs-Client nutzbar | `modules/admin/clients.ts` |
| `entra` (KANN) | `/v1/admin/entra…`, `/v1/platform/organizations/:alias/entra…`, `/v1/platform/entra/refresh` | `ENTRA_CLIENT_ID` + Verwaltung | `modules/admin/{entra,graph}.ts` |
| Worker-Job | `MemberSync` (Advisory-Lock, `MEMBER_SYNC_INTERVAL`, Client `-sync`) | `KEYCLOAK_SYNC_CLIENT_ID` | `worker/member-sync.ts`, `modules/admin/sync.ts` |
| MCP | `TokenExchanger` (RFC 8693, DPoP-gebunden, Zwischenspeicher je Token), `DpopSigner` | MCP-Dienst der App | `mcp/{exchange,dpop}.ts` |
| Betrieb | `org-bootstrap` (bin), `listTenants`, `createTenant`, `setTenantStatus`, `relinkTenant` | Skripte | `scripts/org-bootstrap.ts`, `ops/tenants.ts` |

Die Routen tragen dieselben Schemas (TypeBox), Tags und Beschreibungen wie in Assets; `IAM_API_TAGS` liefert die Tags
für die OpenAPI-Beschreibung der App. Ratenbegrenzung einzelner Routen (Entra-Suche) über `config.rateLimit` der
Route; sie wirkt, wenn die App `@fastify/rate-limit` registriert.

Was in Assets eine Umkehr der Abhängigkeit war (`provideMemberAccess` vom Verwaltungs- in das Katalogmodul), ist im
Paket eine interne Verbindung zwischen `admin` und `acl`.

### 7.1 Was in der App bleibt

- Rechtekatalog, Ressourcen-Modell (Kette, Existenz, Lesesicht), Fähigkeiten und MCP-Werkzeuge als Daten.
- Fachtabellen, ihre Migrationen und RLS-Policies über `app.secure_tenant_tables()` hinaus (Assets: Lesesicht).
- Querschnitt der HTTP-App: Fastify-Instanz, Helmet/CSP, OpenAPI, Ratenbegrenzung, Idempotenz, Telemetrie,
  `/healthz`, `/readyz` (das Paket liefert die Prüfung `readinessChecks` für Datenbank und Anmeldedienst).
- Oberfläche (`/`, `/abgemeldet`): Auslieferung bleibt in der App (Assets `modules/auth/ui.ts`); Bausteine liefert
  `@vollholz/iam-web`.
- Audit-Protokoll lesen und prüfen (`GET /v1/audit`, Anker), Outbox und Warteschlange.
- Mandantendaten löschen (`purgeTenantData` kennt die Fachtabellen).
- Entwicklungsumgebung: `scripts/keycloak-setup.ts` (Demo-Organisationen, Testpersonen) und Prüfung fremder Clients
  (Kap. 3.8) bleiben vorerst in Assets ([Kapitel 12](#12-offene-punkte)).

## 8. Mandantentrennung: was mitkommt

Jede Prüfung aus Assets `docs/mandantentrennung.md` › Inventar (Abschnitte Verwaltung; Anmeldung, Tokens, Sitzungen,
MCP; Keycloak; Personen in mehreren Organisationen) bleibt im Code und kommt mit dem Test in das Paket. Die Tests
werden produktneutral (Katalog eines Beispielprodukts `notes`, Schema `notes`), Aussagen und Fälle bleiben gleich:

| Test im Paket | aus Assets `test/platform/` | prüft u. a. |
|---|---|---|
| `tokens`, `principal` | `auth.test.ts`, `unit.test.ts` (IAM-Teil) | Tokentyp, DPoP, mTLS, unbekannte Bindung, Person/Client, Alias ASCII (Kelvin), `ROLE_SOURCE`, Gruppen nur der gewählten Organisation |
| `catalog` | `authz.test.ts` | Regeln Kap. 8, `org-admin` alle Rechte, Beschreibungen, Scope-Texte, Gleichheit mit `checkCatalog` |
| `access`, `capabilities` | `authz.test.ts`, `capabilities.test.ts`, `acl-grants.test.ts` | Entscheidung, `grant`/`restrict`/`deny`, Ausnahme `org-admin` nur Personen, Scope-Grenze, `can`, ETag-Zugriffsstand |
| `acl` | `acl-write-path.test.ts`, `acl-grants.test.ts` | Validierung (422 am Feld), Gruppen anderer Organisationen, Simulation, `source` |
| `bff` | `bff.test.ts` | Code-Flow, Fixation, `returnTo`, CSRF, Erneuerung parallel, Austritt, Backchannel-Logout, Wechsel |
| `admin` | `admin.test.ts` | Regeln 9.1 (1–11), gleiche Antwort und Mindestdauer beim Einladen, letzter Admin, `…_failed` |
| `roles` | `roles.test.ts` | Kap. 8.3, keine Rechte nur von `org-admin`, Grabstein, `If-Match` |
| `entra` | `entra.test.ts`, `entra-members.test.ts`, `graph.test.ts` | Domänen, `state`, Gäste, «Nur Entra» im Resolver |
| `multi-org` | `multi-org.test.ts` | Person in A und B, Austritt, Client-Freigabe, Alias neu vergeben |
| `rls` | `rls.test.ts` (IAM-Teil), `iam-kit.test.ts` | FORCE RLS, Policies, SECURITY DEFINER, PUBLIC, mit den Prüfungen des Test-Kits |
| `tenant-isolation` | `tenant-isolation.test.ts` (IAM-Routen) | jede Route des Pakets mit IDs von A als B; keine Route ohne Eintrag (Werkzeuge des Test-Kits) |
| `sync`, `mcp` | `admin.test.ts` (Abgleich), `mcp-dpop.test.ts`, `mcp.test.ts` (Austausch) | Alias **und** `kc_org_id`, `removed_at`, Fehler je Organisation; DPoP-gebundener Tausch |
| `migrations` | – (neu) | Platzhalter, Prüfsummen, Übernahme (`adopted`), Reihenfolge der Quellen |

Die Fachrouten von Assets bleiben in deren Isolationstest; der Test der App deckt nach Phase 2 weiterhin **alle**
`/v1`-Routen ab, auch die des Pakets.

## 9. Teil-PRs

Jeder Teil-PR ist für sich grün (typecheck, build, Tests mit PostgreSQL) und bringt seine Tests mit.

| # | Inhalt | Tests |
|---|---|---|
| 1 | **Dieser Entwurf** | – |
| 2 | Paketgerüst (`package.json` 0.1.0 `private`, tsconfig, Workspace), `config`, `errors`, `crypto`, `state`, `db`, `migrations` (iam_001–008, Runner, Übernahme) | `config`, `migrations`, `rls` (Test-Kit-Prüfungen gegen eine Wegwerf-Datenbank) |
| 3 | `catalog` (`defineCatalog`, Register-Typen), `tokens`, `principal`, `access`, Fähigkeiten | `catalog`, `tokens`, `principal`, `access`, `capabilities`, `multi-org` (ohne Verwaltung) |
| 4 | Fastify-Plugin (Anmeldung je Anfrage, Dekorationen, Fehler), Module `account`, `acl` | `acl`, `tenant-isolation` (Gerüst), Beispiel-App `notes` im Test |
| 5 | Modul `bff` | `bff` |
| 6 | `keycloak`, `tenants`, `sync`, Module `admin`, `roles`, `clients`, Worker-Job | `admin`, `roles`, `sync`, `multi-org` vollständig, `tenant-isolation` für alle Routen |
| 7 | Modul `entra` | `entra` |
| 8 | MCP (`TokenExchanger`, `DpopSigner`), `org-bootstrap`, Doku `docs/backend.md`; `private` entfernt → Release veröffentlicht 0.1.0 | `mcp`, `org-bootstrap` |

Zwischen den Teil-PRs lässt sich der Zwischenstand gegen Assets prüfen (lokale Registry, `docs/ausrollen.md`), bevor
der letzte Teil veröffentlicht.

## 10. Phase 2: Assets stellt um

Ziel: Assets nutzt `@vollholz/iam@0.1.0`, ohne Verhaltensänderung; alle Tests von Assets bleiben unverändert grün.

1. `@vollholz/iam` gepinnt einbinden; `authz/permissions.ts` wird `defineCatalog({ product: 'assets', … })` mit
   Assets-Katalog, Reihenfolge und Texten (Antwort von `GET /v1/authz/catalog` byte-gleich, Test vergleicht mit dem
   Stand vor der Umstellung).
2. `ResourceModel` für Assets: Kette `tenant → schema → type… → object`, `connection`, `credential`; Lesesicht als
   `dbContext`; `exists` und `hints` wie `governance.ts`.
3. `config/env.ts`: `PlatformConfig` erbt von `IamConfig`, Variablen unverändert; `http/errors.ts` exportiert die
   Klasse des Pakets; `core/audit.ts` setzt `pgAudit` ein, `emit` bleibt für die Outbox (`events`).
4. `http/app.ts`: Anmeldung, Dekorationen und `/v1/me` aus dem Plugin; Rate-Limit, Idempotenz, OpenAPI bleiben.
5. Module `auth` (ohne `ui.ts`), `admin`, ACL-Teil von `catalog/governance.ts` entfallen zugunsten der Module des
   Pakets; Worker und MCP-Dienst nutzen `MemberSync` bzw. `TokenExchanger`.
6. Migrationen: `migrate(…, [dirMigrations('db/migrations'), iamMigrations({ schema: 'assets', product: 'assets',
   leafTypes: ['object'], adopted: true })])`; Gleichheitstest nach [6.4](#64-übernahme-in-assets).
7. Tests von Assets, die in das Paket gewandert sind, bleiben in Assets **zusätzlich** bestehen, bis die Umstellung
   gemerged ist; danach entfernt Assets nur Duplikate, nie Prüfungen der Fachrouten oder des eigenen Katalogs.

## 11. Abweichungen und Fragen zum Vertrag

| # | Stelle | Abweichung bzw. Frage | Vorschlag |
|---|---|---|---|
| A1 | 15.2 `resolveChain: async (tx, ref)` | Kette synchron über einen mit der ACL geladenen Zustand (`ResourceModel`), damit `can` über Listen ohne Abfrage je Zeile bleibt (so arbeitet Assets) | Spezifikation an `ResourceModel` anpassen |
| A2 | 15.2 `iam({ catalog, resolveChain, db, audit })` | Zwei Schritte: `createIam(…)` (ohne Fastify, auch für Worker, MCP, Tests) und `app.register(iamPlugin, { iam })` | Beispiel anpassen |
| A3 | 10.2 `audit_log` | Tabelle und Hash-Kette im IAM, Lesen/Prüfen (`GET /v1/audit`) vorerst in der App | später eigenes Modul `audit` |
| A4 | 15.3 Migrationen «vor den eigenen» | Für Assets gelten die IAM-Migrationen als übernommen und laufen nach den eigenen (frische Datenbank) | Übernahme als Sonderfall nennen |
| A5 | 8.1 Reservierte Rechte | `defineCatalog` ergänzt sie je nach `features`; nennt die App sie selbst, darf sie die **Beschreibung** anpassen (Assets `tenant:admin`) | Spezifikation: Beschreibung frei, Label und Gruppe fest |
| A6 | 10.2 `tenant_role` | In Assets ist der Primärschlüssel `(id)`, nicht `(tenant_id, id)` wie bei den übrigen Tabellen | für die Übernahme unverändert lassen; Angleichung als spätere Migration `iam_009` (Frage an die Hauptsession) |
| A7 | 13 Variablen | Das Paket liest zusätzlich `MCP_*`, `ENTRA_*`, `KEYCLOAK_*_CLIENT_SECRET` (Übergang) und `DATABASE_*` wie Assets; Kap. 13 nennt sie nicht | Kap. 13 ergänzen |

## 12. Offene Punkte

- **Prüfung fremder Clients** und Einrichtung für Entwicklung (Kap. 3.8, `keycloak-setup.ts`,
  `scripts/lib/system-clients.ts`): gehören eher zum Realm-Modul bzw. Test-Kit als ins Backend-Paket; vorerst in Assets.
- **`person_api`, `system_clients`** (B4): nicht Teil von 0.1.0; der Resolver bleibt dafür offen (`OIDC_PERSON_CLIENT_IDS`).
- **Lesen des Audit-Protokolls** als Modul (A3).
- **Advisory-Locks**: Schlüssel bleiben die Texte von Assets (`admin:<alias>`, `people-sync:<tenant>`,
  `entra:platform`), damit alte und neue Instanzen während des Deploys dieselben Sperren nehmen.
- **Abhängigkeiten** (exakt, wie Assets): `jose` 6.2.12, `openid-client` 6.8.8, `@sinclair/typebox` 0.34.52;
  `fastify` ^5, `@fastify/cookie` ^11 und `pg` ^8 als Peer. Das Plugin registriert `@fastify/cookie`
  nur, wenn die App es nicht schon getan hat.
