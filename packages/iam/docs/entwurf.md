# @vollholz/iam – Entwurf

Stand 2026-10-22 · Status: **freigegeben mit Auflagen** (Hauptsession, 2026-10-22; Festlegungen in [Kapitel 13](#13-festlegungen-nach-der-freigabe)) · Vertrag: `docs/spezifikation.md` (Kap. 1.1, 4–10, 12–15) ·
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
   die Reihenfolge bleibt ihre. So bleibt der Katalog von Assets gleich (ergänzt nur um `match` und `personOnly`, 13.1).
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
| `iam_009_tenant_role_key.sql` | Primärschlüssel von `tenant_role` = `(tenant_id, id)` (A6); läuft auch in Assets normal | – (neu) |
| `iam_010_revoke_public_execute.sql` | kein EXECUTE für PUBLIC auf Funktionen in `app` und `<schema>`; `app.audit_hash` ausdrücklich für `_app` und `_sched` | 051 (vollholz/assets#24) |
| `iam_011_resolve_tenant_strict.sql` | `app.resolve_tenant`: Alias roh gegen das ASCII-Muster prüfen, nur A–Z falten (kein `lower()`, Kelvin-Zeichen); scheitert das Binden der Organisations-ID, kein Mandant | 052 (vollholz/assets#26) |
| `iam_012_acl_unique.sql` | keine doppelten Zugriffsregeln: eindeutiger Index über Ressource, Subjekt, Recht und Wirkung (`NULLS NOT DISTINCT`); bestehende Duplikate entfernt (der älteste bleibt) | 053 (vollholz/assets#28) |

Bis `iam_008` entsprechen die Rechte der Funktionen genau Assets 049, auch wo PUBLIC noch ausführen darf
(`app.tenant_id()`, `app.principal_id()`, `app.secure_tenant_tables()`, `app.audit_hash()`, `app.audit_chain()`);
`iam_010` entzieht das wie Assets 051. Danach gilt `publicExecuteProblems(…, { strict: true })` = [] (Test `rls`).

Die Entra-Tabellen kommen immer mit (leer, ohne Wirkung ohne `ENTRA_CLIENT_ID`), weil der Resolver
`app.entra_login_alias` immer fragt; so braucht es keine bedingten Migrationen.

### 6.2 Parameter

`iamMigrations({ product, schema, resourceTypes, leafTypes })` setzt in die Platzhalter ein: Schema der Tabellen und
Datenbankrollen `<ident>_owner`, `<ident>_app` und `<ident>_sched`. Alle Werte werden gegen Bezeichner-Muster geprüft
(nur `[a-z0-9_-]`), unbekannte Platzhalter sind ein Fehler; nichts wird roh eingesetzt.

**Ressourcentypen und Blätter** stehen in keiner Migration: Sie hängen am Katalog der App, und ein neuer Ressourcentyp
ist ein normaler Fall. Nach den IAM-Migrationen gleicht der Runner bei jedem Lauf die Bedingungen
`acl_entry_resource_type_check` und `acl_entry_grant_resource_check` mit `resourceTypes` und `leafTypes` ab
(`syncAclChecks`, in einer Transaktion): unverändert → nichts; sonst neu anlegen, mit Meldung. Widersprechen bestehende
Zugriffsregeln (Typ entfernt, Freigabe auf neuem Blatt), bricht er mit Hinweis ab. Die Prüfsummen hängen so nie an
den Typen.
Eine Regel für den Namen des Produkts (`PRODUCT_PATTERN`): Kleinbuchstaben, Ziffern, Teile mit «-» (Realm, Clients);
Schema und Rollen leiten sich mit «_» ab (`productIdent('my-app')` = `my_app`), in Konfiguration, Migrationen und
`db/bootstrap.sql` gleich. Eine Vorlage für die Datenbankrollen nach Kap. 10.1 liefert das Paket als `db/bootstrap.sql` (psql-Variablen `p`,
`db`, Passwörter; aus Assets `db/bootstrap.sql`). Die Prüfsumme gilt für den
eingesetzten Text; dieselben Parameter ergeben dieselbe Prüfsumme.

### 6.3 Runner

`migrate(adminUrl, sources, log?)` ist der Runner von Assets (`db/migrate.ts`): Advisory-Lock, Tabelle
`public.schema_migrations (name, checksum, applied_at)`, jede Migration in einer Transaktion, danach
`app.secure_tenant_tables()`, Abbruch bei geänderter Prüfsumme. Neu: mehrere Quellen in fester Reihenfolge, Namen
eindeutig über alle Quellen (`iam_…` kollidiert nicht mit `NNN_…`); er läuft nur als `<ident>_owner` (sonst Abbruch),
weil Rechte, Standardrechte und die Policy `entra_scan` an dieser Rolle hängen.

**Reihenfolge** (Auflage 10): Neue Apps geben `[iamMigrations(…), dirMigrations(…)]` – alle IAM-Migrationen laufen vor
denen der App, jede Migration der App darf jede IAM-Migration voraussetzen. Bei der Übernahme (Assets) laufen die
IAM-Migrationen direkt nach der Marke der App (`after`, z. B. `049_tenant_roles.sql`), spätere Migrationen der App
danach – auch auf einer frischen Datenbank. Eine Migration der App, die eine IAM-Migration voraussetzt, die neuer ist
als die installierte Version des Pakets, gibt es nicht: Die App hebt zuerst die Version des Pakets.

### 6.4 Übernahme in Assets

Assets hat dieselben Objekte schon aus 001–049 und darf diese Dateien nicht ändern (Prüfsummen). Deshalb:

- `iamMigrations({ …, adopted: { after: '049_tenant_roles.sql' } })`: Der Runner trägt `iam_001`–`iam_008`
  (`IAM_BASELINE`) mit ihrer Prüfsumme als angewendet ein, **ohne** sie auszuführen – nach der Quelle der App
  (direkt nach der Marke, 6.3). Vorher prüft er in derselben Transaktion die Vorbedingungen (`adoptionProblems`): die
  Marke `after` ist angewendet; alle IAM-Tabellen, die Spalten der späteren Schritte (`principal.last_roles`,
  `member_invitation.entra`, `audit_log.seq` …) und alle IAM-Funktionen bestehen; jede Mandantentabelle hat RLS mit
  FORCE und die Policy `tenant_isolation` für `<ident>_app` mit `app.tenant_id()`; `tenant` hat `tenant_self`; keine
  IAM-Tabelle gibt PUBLIC Rechte; die SECURITY-DEFINER-Funktionen haben `search_path=<schema>, pg_temp`. Die
  Bedingungen zu Ressourcentypen stellt danach der Abgleich her (6.2). Sonst bricht er ab und trägt nichts ein
  (Auflage 4).
- **Spätere Entsprechungen (0.1.1):** Assets hat 051–053 schon angewendet (= `iam_010`–`iam_012`). Mit `after: '049…'`
  liefe `iam_012` danach erneut und scheiterte am bestehenden Index `acl_entry_unique`. `adopted.map` ordnet sie zu;
  `ASSETS_ADOPTION` = `{ after: '053_acl_unique.sql', map: { '051…': 'iam_010…', '052…': 'iam_011…', '053…': 'iam_012…' } }`.
  Eingetragen wird nur, wenn die Migration der App angewendet ist und der Zustand der IAM-Migration nachgewiesen ist
  (`laterObjectProblem`): `iam_010` kein EXECUTE für PUBLIC und EXECUTE auf `app.audit_hash` für App- und
  Scheduler-Rolle; `iam_011` Verhaltensprobe von `resolve_tenant` in einer zurückgerollten Teiltransaktion (ungültiger
  Alias, fremde Organisations-ID beim Anlegen und Binden → NULL); `iam_012` Index über `pg_index` (eindeutig, gültig,
  ohne Bedingung und Ausdrücke, NULLS NOT DISTINCT, Spalten in dieser Reihenfolge). Assets 051 vergibt dieselben Rechte
  wie `iam_010` (geprüft am Quelltext). In Assets läuft dann nur `iam_009`.
  `iam_010`–`iam_012` bleiben unverändert: idempotent umgeschrieben änderten sie ihre Prüfsummen, und jede Datenbank,
  die 0.1.0 schon angewendet hat, bräche ab.
- **Gleichheitstest** in der CI des Pakets (`test/assets-schema.test.ts`): Der Abzug der IAM-Objekte von Assets nach
  001–053 (`4a3574d`) liegt als Fixture bei (`test/fixtures/assets-schema.json`, erzeugt mit `scripts/assets-schema.ts` aus einem
  Checkout von Assets). Eine frische Datenbank aus `iam_001`–`iam_008`, `iam_010`–`iam_012` (= Assets 051–053) mit den Parametern von Assets muss für alle
  IAM-Tabellen und -Funktionen genau diesen Abzug ergeben (`schemaSnapshot`, exportiert): Besitzer, Spalten, Typen,
  Standardwerte, Sequenzen, Bedingungen mit Namen,
  Indizes, Policies, Trigger, RLS, Rechte von Tabellen, Spalten, Schemas und Funktionen, Funktionsrümpfe, Standardrechte.
  Ausgenommen sind nur die Trigramm-Indizes des Personenverzeichnisses auf `principal` (gehören zur App, Assets 014).
  Ändert Assets eine IAM-Tabelle, wird der Abzug neu erzeugt; Abweichungen werden im Paket behoben, nicht in Assets.

## 7. Module

| Modul | Endpunkte / Inhalt | Voraussetzung | aus Assets |
|---|---|---|---|
| `account` | `GET /v1/me`, `GET /v1/authz/catalog` | immer | `http/app.ts`, `catalog/governance.ts` |
| `bff` | `/auth/login`, `/auth/entra/:idp`, `/auth/callback`, `/auth/me`, `/auth/switch`, `/auth/logout`, `/auth/backchannel-logout`; `SessionBridge` | `OIDC_BFF_CLIENT_ID` + Schlüssel | `modules/auth/{index,bff,sealer}.ts` |
| `acl` | `GET/POST /v1/acl`, `DELETE /v1/acl/:id`, `GET /v1/acl/effective` (echt und Simulation) | `resources` | `catalog/governance.ts`, `member-access.ts` |
| `admin` | `/v1/admin/status`, `/v1/admin/members…`, `/v1/platform/organizations…` | `KEYCLOAK_MGMT_CLIENT_ID` (sonst 503 nach 9.1 Nr. 11) | `modules/admin/{index,service,sync}.ts`, `ops/tenants.ts` |
| `roles` | `GET/POST /v1/roles`, `GET/PATCH/DELETE /v1/roles/:key` | immer lesbar und änderbar; Gruppen und Anzahl Personen nur mit Verwaltung | `modules/admin/roles.ts` |
| `people` | `GET /v1/people`, `GET /v1/people/:id` (Personenverzeichnis, Vertrag der Oberflächen-Bausteine) | Option `people.permissions` (Standard: Fachrechte von `<produkt>:read`, `acl:read`) | `modules/catalog/people.ts` |
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
- Audit-Protokoll lesen und prüfen (`GET /v1/audit`, Anker) bis zum Modul `audit` in 0.2 (A3); Outbox und Warteschlange.
- `GET/PATCH /v1/tenant` (Name und Einstellungen, `tenant:read`/`tenant:admin`): bleibt in 0.1.0 in der App, weil die
  Einstellungen fachlich sind (Assets: Assistent); Kandidat für 0.2 zusammen mit `audit` (Auflage 5). Schutz bleibt
  die Richtlinie `tenant_self` und die Spaltenrechte aus `iam_002` (Test `rls`).
- Mandantendaten löschen (`purgeTenantData` kennt die Fachtabellen).
- Entwicklungsumgebung (`scripts/keycloak-setup.ts`, Demo-Organisationen, Testpersonen) und die Prüfung fremder
  Clients (Kap. 3.8, `scripts/lib/system-clients.ts`) gehören nicht ins Backend-Paket, sondern ins Test-Kit bzw. ins
  Realm-Modul (Entscheid der Hauptsession; Kapitel 11, A8).

## 8. Mandantentrennung: was mitkommt

Jede Prüfung aus Assets `docs/mandantentrennung.md` › Inventar (Abschnitte Katalog, soweit IAM: `/v1/acl…`,
`/v1/acl/effective`, `/v1/tenant`, Audit; Verwaltung; Anmeldung, Tokens, Sitzungen, MCP; Keycloak; Personen in
mehreren Organisationen) bleibt im Code und kommt mit dem Test in das Paket. Die Tests
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
| `migrations`, `assets-schema`, `locks` | – (neu) | Platzhalter, Prüfsummen, Übernahme mit Vorbedingungen, Reihenfolge der Quellen; Gleichheit mit Assets 001–049; Sperren als Vertrag |

Inventar «Katalog» von Assets, soweit IAM:

| Weg | Was A preisgeben könnte | Schutz | Test im Paket |
|---|---|---|---|
| `GET/POST /v1/acl`, `DELETE /v1/acl/{id}` | Einträge, `principalRef` | RLS; Gruppen fremder Organisationen 422 | `acl`, `tenant-isolation`, `multi-org` |
| `GET /v1/acl/effective` | Gruppen und Rollen der Person, echte Rollen anderer Personen aus Keycloak | Gruppen je Mandant gefiltert (`tenantGroups`, `rolesFromClaims`); Keycloak nur für Mitglieder der eigenen Organisation | `acl`, `multi-org` |
| Audit (`audit_log`, `audit_anchor`) | Einträge, Folgenummern | RLS; `seq` lückenlos je Mandant; nur lesen und anhängen | `rls` (Routen bleiben bis 0.2 in der App) |
| `GET/PATCH /v1/tenant` | Name, Einstellungen | Richtlinie `tenant_self`, Spaltenrechte | `rls` (Route bleibt in der App) |

Die Fachrouten von Assets bleiben in deren Isolationstest; der Test der App deckt nach Phase 2 weiterhin **alle**
`/v1`-Routen ab, auch die des Pakets.

## 9. Teil-PRs

Jeder Teil-PR ist für sich grün (typecheck, build, Tests mit PostgreSQL) und bringt seine Tests mit.

| # | Inhalt | Tests |
|---|---|---|
| 1 | **Dieser Entwurf** | – |
| 2 | Paketgerüst (`package.json` 0.1.0 `private`, tsconfig, Workspace), `config`, `errors`, `crypto`, `state`, `db`, `audit` (`pgAudit`), `locks`, `migrations` (iam_001–010, Runner, Übernahme), `db/bootstrap.sql`; Nachführung dieses Entwurfs | `config`, `core`, `locks`, `migrations`, `assets-schema`, `rls` |
| 3 | `catalog` (`defineCatalog`, Register-Typen), `tokens`, `principal`, `access` (API nach 13.2), Fähigkeiten, Zwischenspeicher (13.6); Test-Kit 0.2.0 (`groups[].match`) | `catalog` (mit Katalog von Assets), `tokens`, `principal`, `access`, `capabilities`, `cache`, `multi-org` (ohne Verwaltung) |
| 4 | Fastify-Plugin (Anmeldung je Anfrage, Dekorationen, `need` als preHandler, Fehler, OpenAPI nach 13.4), `readinessChecks`, Module `account`, `acl` | `acl`, `tenant-isolation` (Gerüst), `openapi`, Beispiel-App `notes` im Test |
| 5 | Modul `bff` | `bff` |
| 6a | `keycloak`, `tenants`, Modul `clients` | `clients`, `tenants`, `tenant-isolation` |
| 6b | Modul `admin`, `sync` mit Worker-Job `MemberSync` | `admin`, `sync`, `multi-org` vollständig, `tenant-isolation` |
| 6c | Modul `roles` | `roles`, `tenant-isolation` für alle Routen |
| 7 | Modul `entra` | `entra` |
| 8 | MCP (`McpAuth`, `TokenExchanger`, `DpopSigner`), `org-bootstrap`, Doku `docs/backend.md`; `private` entfernt → Release veröffentlicht 0.1.0 | `mcp`, `org-bootstrap` |

Zwischen den Teil-PRs lässt sich der Zwischenstand gegen Assets prüfen (lokale Registry, `docs/ausrollen.md`), bevor
der letzte Teil veröffentlicht.

## 10. Phase 2: Assets stellt um

Ziel: Assets nutzt `@vollholz/iam@0.1.0`, ohne Verhaltensänderung; alle Tests von Assets bleiben unverändert grün.

1. `@vollholz/iam` gepinnt einbinden; `authz/permissions.ts` wird `defineCatalog({ product: 'assets', … })` mit
   Assets-Katalog, Reihenfolge und Texten (Antwort von `GET /v1/authz/catalog` gleich bis auf die ergänzten Felder
   `groups[].match` und `permissions[].personOnly`, `platform.json` byte-gleich; der Pflichttest im Paket vergleicht
   mit dem Abzug von Assets (`test/fixtures/assets-catalog.json`), Test vergleicht mit dem
   Stand vor der Umstellung).
2. `ResourceModel` für Assets: Kette `tenant → schema → type… → object`, `connection`, `credential`; Lesesicht als
   `dbContext`; `exists` und `hints` wie `governance.ts`.
3. `config/env.ts`: `PlatformConfig` erbt von `IamConfig`, Variablen unverändert; `http/errors.ts` exportiert die
   Klasse des Pakets; `core/audit.ts` setzt `pgAudit` ein, `emit` bleibt für die Outbox (`events`).
4. `http/app.ts`: Anmeldung, Dekorationen und `/v1/me` aus dem Plugin; Rate-Limit, Idempotenz, OpenAPI bleiben.
5. Module `auth` (ohne `ui.ts`), `admin`, ACL-Teil von `catalog/governance.ts` entfallen zugunsten der Module des
   Pakets; Worker und MCP-Dienst nutzen `MemberSync` bzw. `TokenExchanger`.
6. Migrationen: `migrate(…, [dirMigrations('db/migrations'), iamMigrations({ product: 'assets', resourceTypes: […],
   leafTypes: ['object'], adopted: ASSETS_ADOPTION })])`; ausgeführt werden nur `iam_009` und neuere (6.4). Gleichheit nach
   [6.4](#64-übernahme-in-assets) prüft schon die CI des Pakets.
7. Tests von Assets, die in das Paket gewandert sind, bleiben in Assets **zusätzlich** bestehen, bis die Umstellung
   gemerged ist; danach entfernt Assets nur Duplikate, nie Prüfungen der Fachrouten oder des eigenen Katalogs.

## 11. Abweichungen und Fragen zum Vertrag

| # | Stelle | Abweichung bzw. Frage | Entscheid (Hauptsession, 2026-10-22) |
|---|---|---|---|
| A1 | 15.2 `resolveChain: async (tx, ref)` | Kette synchron über einen mit der ACL geladenen Zustand (`ResourceModel`), damit `can` über Listen ohne Abfrage je Zeile bleibt (so arbeitet Assets) | angenommen; Spezifikation 15.2 wird umgestellt |
| A2 | 15.2 `iam({ catalog, resolveChain, db, audit })` | Zwei Schritte: `createIam(…)` (ohne Fastify, auch für Worker, MCP, Tests) und `app.register(iamPlugin, { iam })` | angenommen; zusätzlich `need(perm, ref?)` als preHandler-Fabrik (13.4) |
| A3 | 10.2 `audit_log` | Tabelle und Hash-Kette im IAM, Lesen/Prüfen (`GET /v1/audit`) vorerst in der App | angenommen; Modul `audit` mit `GET /v1/audit` in 0.2 |
| A4 | 15.3 Migrationen «vor den eigenen» | Für Assets gelten die IAM-Migrationen als übernommen und laufen nach den eigenen (frische Datenbank) | angenommen mit Prüfung der Vorbedingungen (6.4) |
| A5 | 8.1 Reservierte Rechte | `defineCatalog` ergänzt sie je nach `features`; nennt die App sie selbst, darf sie die **Beschreibung** anpassen (Assets `tenant:admin`) | angenommen; ebenso Reihenfolge von Rollen (`org-admin` zuerst wie Assets), Gruppen und Ressourcentypen (13.1) |
| A6 | 10.2 `tenant_role` | In Assets ist der Primärschlüssel `(id)`, nicht `(tenant_id, id)` wie bei den übrigen Tabellen | `iam_009` mit `(tenant_id, id)` schon in 0.1.0; Assets wendet sie in Phase 2 normal an |
| A7 | 13 Variablen | Das Paket liest zusätzlich `MCP_*`, `ENTRA_*`, `KEYCLOAK_*_CLIENT_SECRET` (Übergang) und `DATABASE_*` wie Assets; Kap. 13 nennt sie nicht | angenommen; Client-Geheimnisse nur mit Warnung beim Start (`iamWarnings`, P3); Kap. 13 wird ergänzt |
| A8 | 3.8 Prüfung fremder Clients | Nicht im Backend-Paket, obwohl Kap. 15.4 `scripts/lib/system-clients.ts` und `keycloak-setup.ts` dem Backend zuordnet | Test-Kit bzw. Realm-Modul (Entscheid der Hauptsession) |

## 12. Offene Punkte

- **`person_api`, `system_clients`** (B4): nicht Teil von 0.1.0; der Resolver bleibt dafür offen (`OIDC_PERSON_CLIENT_IDS`).
- **Lesen des Audit-Protokolls** als Modul (A3).
- **Abhängigkeiten** (exakt, wie Assets): `jose` 6.2.12, `openid-client` 6.8.8, `@sinclair/typebox` 0.34.52;
  `fastify` ^5, `@fastify/cookie` ^11 und `pg` ^8 als Peer. Das Plugin registriert `@fastify/cookie`
  nur, wenn die App es nicht schon getan hat.

## 13. Festlegungen nach der Freigabe

Auflagen der Hauptsession zur Freigabe (2026-10-22). Was hier steht, gilt vor den Kapiteln 3–10, wo sie abweichen.

### 13.1 Katalog (Auflagen 1, 8; A5)

- **Rollenbeschreibungen** prüft `defineCatalog` über Stichwörter je Rechtegruppe statt über Labels: Jede Gruppe kann
  `match` tragen (regulärer Ausdruck, Text oder Liste), und die Beschreibung jeder Rolle muss für jede ihrer Gruppen
  passen (wie Assets `test/platform/authz.test.ts`, A7). Ohne `match` keine Prüfung dieser Gruppe. Die reservierten
  Gruppen bringen Stichwörter mit (`tenant`: beliebig, `members`: «mitglieder», `access`: «zugriff», `audit`:
  «protokoll»). `checkCatalog` im Test-Kit prüft dasselbe, wenn der Katalog `match` liefert (Test-Kit 0.2.0,
  abwärtskompatibel). Pflichttest: Der Katalog von Assets besteht `defineCatalog` und `checkCatalog`.
- **Reihenfolge**: Die App bestimmt die Reihenfolge von Rechten, Rollen, Gruppen und Ressourcentypen; `org-admin` steht
  zuerst unter den Rollen (wie Assets). Fehlt etwas Reserviertes, hängt `defineCatalog` es an der Stelle an, die Kap. 8.1
  vorgibt (Rechte: `tenant:*` vorne, die übrigen hinten; Gruppen ebenso).
- **Nur für Personen** (Auflage 8): Ein Recht trägt `scope: false`, wenn es in keinem Scope stehen darf (Assets:
  `members:admin`, `assistant:use`, `connector:activate`). `defineCatalog` bricht ab, wenn ein Scope es enthält;
  `members:admin` ist immer `scope: false`. Im Katalog (`GET /v1/authz/catalog`) erscheint es als `personOnly: true`.
- **Ergänzte Felder** der Antwort: `groups[].match` (Quelle des regulären Ausdrucks, Gross/klein egal; Texte werden
  maskiert) und `permissions[].personOnly` (nur wo wahr). Beide sind zusätzlich zu den Feldern von Assets; Clients,
  die sie nicht kennen, ignorieren sie. Das Test-Kit prüft sie ab 0.2.0, wenn vorhanden. Entschieden: die Felder sind
  zulässig und stehen in Spez. 7.2/8.2 (Assets = bisherige Antwort plus diese Felder); das OpenAPI-Schema der Route
  (Teil 4, Modul `account`) führt sie als optionale Felder.

### 13.2 Entscheidung: öffentliche API des `AccessService` (Auflage 2)

```ts
class AccessService<P extends string = string> {
  load(tenantId): Promise<TenantAccess>;             // ACL, eigene Rollen, Zustand der Kette, Version; zwischengespeichert
  invalidate(tenantId): void;
  decide(p, acl, perm, ref?, hint?): boolean;        // (Rolle ∨ Freigabe) ∧ Scope ∧ kein Verbot/keine Beschränkung
  somewhere(p, acl, perm): boolean;                  // Recht irgendwo (canSomewhere)
  isExempt(p): boolean;                              // Person mit org-admin: von deny/restrict ausgenommen
  stepAllows(p, acl, perm, ref): boolean;            // nur eine Stufe (Assets: objectStepAllows, Objekte in Listen)
  basePermissions(p, acl): Set<P>;                   // Rechte aus Rollen, bei Scope-Grenze geschnitten mit den Scopes
  can / require / canSomewhere / requireSomewhere / effective / granted / accessTag;
}
interface TenantAccess<S> { version: string; entries: readonly AclRow[]; roles: ReadonlyMap<string, readonly string[]>; state: S }
```

`entries` und `state` sind lesbar (Assets: Lesesicht `readTypes` aus Einträgen und Zustand). `GET /v1/acl/effective`
nimmt über `resources.effectiveExtra(target, acl, access)` zusätzliche Felder der App auf, mit Schema-Erweiterung
(`resources.effectiveExtraSchema`, Assets: `readTypes`).

### 13.3 Kontext von `load`, `exists`, `hints` (Auflage 3)

`ResourceModel.load`, `exists` und `hints` laufen in einer Transaktion im Mandantenkontext **mit voller Lesesicht der
App**: `resources.fullContext` (Einstellungen wie `dbContext`, Assets: `{ 'app.read_all': 'on' }`). Sonst sähe
`POST /v1/acl` auf ein Objekt, das der Person verborgen ist, 404. Was darin gelesen wird, geht nie als Name oder Wert
an die Person zurück (nur `exists` = 404 bzw. Zustand der Kette).

### 13.4 Fastify und OpenAPI (A2, Auflage 7)

- `need(perm, ref?)` gibt es zusätzlich als preHandler-Fabrik: `{ preHandler: need('note:read', r => ({ type: 'note',
  id: r.params.id })) }`.
- Tags, Zusammenfassungen und Beschreibungen der Routen sind überschreibbar (`openapi: { tags, routes: { '<METHOD>
  <url>': { summary, description, tags } }, fields }`); die Standardtexte des Pakets sind produktneutral. Ziel und Test
  in Phase 2: `openapi.json` von Assets bleibt gleich.
- `readinessChecks` (Datenbank, Anmeldedienst) kommt mit dem Plugin (Teil-PR 4).
- Span-Attribut der Organisation heisst `iam.tenant` (Assets kann umbenennen lassen: Option `spanAttribute`).
- Ist `@fastify/cookie` schon registriert, prüft das Plugin, dass es mit `SESSION_SECRET` signiert (sonst Abbruch beim
  Start); ohne registriertes Rate-Limit warnt das Modul `entra` beim Start (die Suche ist sonst nicht begrenzt).

### 13.5 MCP-Anmeldung (Auflage 9)

`McpAuth` kommt ins Paket (Teil-PR 8): nur Tokens der Hosts aus `MCP_HOST_CLIENT_IDS` (sonst 403), `exchangeScopes`
mit `organization:<alias>` (eine Organisation bleibt im API-Token festgelegt), Protected Resource Metadata (RFC 9728)
mit den Scopes des Katalogs, Fehler `-32602` mit der eigenen Liste der Organisationen bei fehlender Wahl,
Zwischenspeicher der getauschten Tokens je Token, der Rechte (`GET /v1/me`) je Token + Mandant (13.6). Katalog bzw.
`SCOPES` sind Parameter.

### 13.6 Zwischenspeicher und Wirkungszeiten (Auflage 10)

| Zwischenspeicher | Schlüssel | Dauer | Vergessen | Wirkung (Kap. 7.1) | Test |
|---|---|---|---|---|---|
| Mandant | Alias + Keycloak-ID | 60 s | `forgetTenant(alias)` nach Sperren/Entsperren | Sperre ≤ 60 s auf anderen Instanzen | `cache` |
| Freigabe eines Clients | Mandant + Client-ID | 60 s | `forgetClient(tenant, client)` | Entzug ≤ 60 s | `cache`, `clients` |
| Principal | Mandant + Art + Subject (+ Rollen/Scopes bei Clients) | 5 min | `forgetPrincipal(tenant, subject)` | Entfernen ≤ 5 min, Tokens von davor nie mehr | `cache`, `admin` |
| «Nur Entra» je Domäne | Domäne | 60 s | `forgetEntra()` | ≤ 60 s | `cache`, `entra` |
| ACL und eigene Rollen | Mandant, gültig solange `acl_version` (+ `ResourceModel.version`) gleich | bis zur Änderung | `invalidate(tenant)` | sofort auf allen Instanzen | `access` |
| Getauschte MCP-Tokens | Hash des Tokens | bis kurz vor Ablauf | `forget(token)` bei 401 der API | – | `mcp` |
| Rechte im MCP-Dienst (`GET /v1/me`) | Token + Mandant | 60 s | – | Rechteänderung ≤ 60 s im MCP-Dienst | `mcp` |

Die Tests setzen die Uhr (`Date.now`) und prüfen Treffer vor und Neuladen nach Ablauf.

### 13.7 ETag mit Zugriffsstand (Auflage 12)

`accessTag(p)` = die ersten 10 Zeichen (base64url) von SHA-256 über `version | kind | principalId | subject | clientId
| s (bei Scope-Grenze) | Rollen | Gruppen | Scopes` (Listen sortiert, kommagetrennt), wobei `version` =
`<acl_version>:<ResourceModel.version>` (Assets: `<acl_version>:<max(object_type.updated_at)>`). ETag einer Ressource:
`W/"<version der Ressource>-<accessTag>"`; `If-Match` vergleicht nur die Version der Ressource (wie Assets).

### 13.8 Sperren als Vertrag (Auflage 6)

`src/locks.ts` mit Test: `LOCKS.migrate` = 727001 (Runner), `LOCKS.memberSync` = 727016 (Abgleich im Worker);
Texte `audit:<tenant>` (Audit-Kette, geteilt mit `outbox_sequence` in Assets 044 – sonst Verklemmung),
`admin:<alias>`, `people-sync:<tenant>`, `entra:platform`. Der Test hält jede Sperre und zeigt, dass Runner bzw.
Audit-Trigger darauf warten.

### 13.9 Datenbankrollen (Auflage 12)

`db/bootstrap.sql` im Paket ist die Vorlage für Kap. 10.1 (psql-Variablen `p`, `db`, `owner_pw`, `runtime_pw`,
`worker_pw`; idempotent, ungültiger Name bricht ab). `create-iam-app` ruft sie auf, statt eine Kopie anzulegen.

### 13.10 Plugin und Module `account`, `acl` (Teil-PR 4)

- **`createIam`** liefert zusätzlich `tx(p, fn)` (Mandantenkontext mit `resources.dbContext`), `fullTx(p, fn)` (mit
  `resources.fullContext`) und `memberAccess` (echte Rollen und Gruppen anderer Personen; setzt das Modul `admin` in
  Teil 6b, bis dahin Simulation).
- **Optionen des Plugins** zusätzlich zu 3.2: `publicPaths` (`*` am Ende = Präfix), `sessions` (`SessionBridge` des Moduls
  `bff`), `openapi`, `spanAttribute`, `problemSchemas` (Standard `true`: Fehlerschemas als Komponenten und übliche
  Fehlerantworten je Route unter `apiPrefix`, wie Assets). Standard für `problemTypeBase`: `<PUBLIC_BASE_URL>/probleme/`;
  `WWW-Authenticate` nennt `realm="<product>"`.
- **`openapi.fields`**: Schlüssel `'<Titel des Schemas>.<pfad>'` oder `'<METHOD> <url> <Status|body|querystring>.<pfad>'`,
  Listen mit `[]`. Standard-Tags des Pakets: `Konto`, `Verwaltung: Zugriff` (Assets ersetzt durch `Verwaltung: ACL`).
- **Dekorationen**: `req.can(perm, ref?, hint?)` lädt die Zugriffsregeln einmal je Anfrage; `req.capabilities()` liefert
  eine Funktion `(kind, id, hint?) => Fähigkeiten` für Listen. `/readyz` bleibt in der App (`readinessChecks(iam)`).
- **Cookies**: Ohne `@fastify/cookie` registriert es das Plugin mit `SESSION_SECRET`; ist es schon registriert, muss es
  mit denselben Geheimnissen signieren (sonst Abbruch beim Start). Das Plugin lädt `@fastify/cookie` erst beim
  Registrieren; Worker und Skripte nutzen das Paket ohne Fastify. Telemetrie (`@opentelemetry/api`) ist ein optionaler
  Peer: ohne fehlt nur das Span-Attribut.
- **Modul `acl`**: Existenz der Ressource über `ResourceModel.exists` mit voller Lesesicht (13.3), Hinweise für viele
  Ressourcen über `hints` (Schlüssel `<type>:<id>`), Zusatzfelder über `effectiveExtra`/`effectiveExtraSchema` (13.2).
  Die Meldung zu Freigaben auf Blättern lautet produktneutral «Freigaben gelten für Bereiche (…), nicht für einzelne
  Ressourcen vom Typ «…».» (Assets: «… nicht für einzelne Objekte.»; der Pfad `/effect` bleibt gleich). Ereignis
  `acl.changed` über `events`.
- **Getauschte Tokens** (Entscheid der Hauptsession zu Teil 3): Regeln vom Typ `client` – `deny` wirkt für `clientId`
  (MCP-Dienst) oder `grantId` (ursprünglicher Client), `grant` und `restrict` nur für `grantId`; die Simulation in
  `/v1/acl/effective?client=` setzt beide auf die angefragte Client-ID.
- **Prüfung von #17** (Entscheide der Hauptsession):
  - Keine Duplikate: `POST /v1/acl` lehnt einen gleichen Eintrag (Ressource, Subjekt, Recht, Wirkung) mit 422 ab;
    `iam_012` setzt dafür einen eindeutigen Index `NULLS NOT DISTINCT` (gleichzeitige Anfragen → 409).
  - `acl:admin` gilt auf der Ressource des Eintrags (Anlegen und Löschen): Ein Verbot von `acl:admin` auf X sperrt das
    Verwalten der Zugriffsregeln von X und darunter. Wirkt nur, wenn der Katalog `acl:admin` auf weiteren
    Ressourcentypen führt. Entschieden (Hauptsession, 2026-10-23): Das reservierte `acl:admin` bleibt bei
    `resources: ['tenant']` (wie Assets); die Prüfung je Ressource ist der Mechanismus für Apps, die es erweitern.
  - `/v1/acl/effective`: Maschinen-Clients, die entfernt sind oder keine Freigabe mehr haben, gelten als Simulation;
    `scopes` begrenzen auch eine simulierte Person mit `principal`.
  - Cookies: `@fastify/cookie` muss mit dem ersten Geheimnis von `SESSION_SECRET` signieren und jedes annehmen
    (Rotation). `DPOP_MODE` wird vor dem Resolver geprüft (abgewiesene Tokens schreiben nichts); alle 401 tragen
    `WWW-Authenticate`.

### 13.11 Modul `bff` (Teil-PR 5)

- **`createIam`** baut `bff`, wenn `OIDC_BFF_CLIENT_SECRET` oder `OIDC_BFF_PRIVATE_KEY` gesetzt ist (dann ist
  `SESSION_SECRET` Pflicht, in Produktion auch `ENCRYPTION_KEYS`; sonst `ConfigError` beim Start); Option `bff: false`
  schaltet es ab (MCP-Dienst), `bff: { now, log, cleanupIntervalMs }` für Tests. Das Plugin nimmt `iam.bff` als
  `SessionBridge` und registriert das Modul `bff`, wenn es vorhanden ist.
- **Cookies** heissen `<product>_sid` und `<product>_login`, in Produktion mit Präfix `__Host-` (Assets: `assets_sid`,
  unverändert). Sitzungen in `<schema>.session` wie Assets (Hash der ID, Inhalt verschlüsselt, Erneuerung über
  Zeilensperre, Backchannel-Logout mit Replay-Schutz aus `iam.replay`).
- **Routen** wie Assets: `GET /auth/login`, `GET /auth/entra/:idp`, `GET /auth/callback` (versteckt), `GET /auth/switch`
  (405), `POST /auth/switch`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/backchannel-logout` (versteckt); Tag
  `Anmeldung (Oberfläche)`. Die Beschreibung von `/auth/me` nennt Freigaben «auf einzelnen Ressourcen» (Assets setzt
  seinen Text über `openapi`). Die Auslieferung der Oberfläche (`/`, `/abgemeldet`, CSP) bleibt in der App.
- **Prüfung von #19** (Hauptsession): `switchOrg` liest die Sitzung frisch und gesperrt und ändert nur `org` (sonst
  schriebe ein Wechsel ein von einer anderen Instanz rotiertes Refresh Token zurück); der Name des Produkts im Cookie
  wird beim Start geprüft (`checkProduct`); beim Backchannel-Logout muss `events[…backchannel-logout]` ein Objekt sein,
  und scheitert das Löschen, gibt `ReplayStore.release` die `jti` wieder frei (Keycloak wiederholt). Sitzungscookies
  nimmt das Plugin nur mit Modul `bff` oder ausdrücklicher `sessions` an.
- **Bekannte Grenze** (wie Assets, entschieden): Es gibt ein Login-Cookie je Browser; starten zwei Tabs gleichzeitig
  eine Anmeldung, gilt nur die zuletzt gestartete, die andere endet mit «Anmeldung abgelaufen».

### 13.12 `keycloak`, `tenants`, Modul `clients` (Teil-PR 6a)

- **`KeycloakAdmin(cfg, tokenEndpoint, fetch?, creds?)`** wie Assets (`private_key_jwt` bevorzugt, sonst Geheimnis;
  Admin-URL aus `KEYCLOAK_MGMT_URL` oder dem Issuer; Listen seitenweise mit Obergrenze). Fehlermeldungen nennen statt
  `npm run keycloak:setup` die Variablen und das Realm-Modul.
  Jedes Pfadsegment läuft über `seg()`: leer, `.`, `..` und Segmente mit `/` werden vor der Anfrage abgewiesen (422),
  weil `encodeURIComponent` Punkte nicht kodiert und `fetch` Punkt-Segmente auflöst (`DELETE /users/..` träfe den
  Realm). Nach 401 wird einmal mit neuem Token wiederholt. Die Meldung von Keycloak (`errorMessage`) steht nur in
  `KeycloakError.kcMessage` (fürs Log), nie in der Antwort. Abweichung von Assets (dort dieselben drei Punkte offen).
- **`tenants`**: `listTenants`, `findTenant`, `createTenant`, `setTenantStatus`, `relinkTenant` mit `{ schema, audit }` als
  erstem Parameter (Protokoll über den `AuditPort`). `findTenant` vergleicht den Alias nur ASCII klein geschrieben
  (Assets: `lower()`, das in PostgreSQL das Kelvin-Zeichen zu «k» faltet); ebenso die E-Mail in `relinkTenant`.
  Optional `resolver` im Kontext (`iam.resolver`): `setTenantStatus` und `relinkTenant` vergessen den Mandanten dann
  selbst (sonst wirkt die Änderung nach spätestens 60 s). Gleicher Status: nichts geändert, kein Protokolleintrag.
  `createTenant` meldet einen bestehenden Mandanten mit anderer Organisations-ID ausdrücklich. `purgeTenantData`
  bleibt in der App.
- **Modul `clients`** wie Assets (`/v1/admin/clients…` mit `members:admin`, nur Personen; `/v1/platform/organizations/
  :alias/clients…` nur platform-admin), standardmässig aktiv; Tag `Verwaltung: Maschinen-Clients`. `personOf(req)`
  (nur Personen, nicht über MCP) ist exportiert und dient auch dem Modul `admin`.


### 13.13 Modul `admin`, `sync` mit `MemberSync` (Teil-PR 6b)

- **`AdminService`** (`src/admin.ts`, aus Assets `modules/admin/service.ts`, ohne Fastify) baut `createIam` als
  `iam.admin`, wenn `KEYCLOAK_MGMT_CLIENT_ID` gesetzt ist (sonst `null`); der Abruf der Admin-API lässt sich mit
  `keycloakFetch` ersetzen (Tests: `KeycloakFake.fetch`). Protokoll über den `AuditPort`, Mandanten über `tenants`
  mit `resolver` (Sperren wirkt sofort in dieser Instanz).
- **Modul `admin`** (`src/http/admin.ts`, aus Assets `modules/admin/index.ts`): `GET /v1/admin/status`,
  `…/admin/members…`, `…/platform/organizations/:alias/members…`, `…/platform/organizations…` mit Sperren und
  Entsperren; standardmässig aktiv (ohne Verwaltungs-Client 503 nach Spez. 9.1 Nr. 11). Tags
  `Verwaltung: Mitglieder und Rollen` und `Plattform: Organisationen` (in `IAM_API_TAGS`). Setzt `iam.memberAccess`
  (echte Rollen für `GET /v1/acl/effective`), wenn `ROLE_SOURCE=groups`. Die Routen der Entra-Anbindung (`…/entra…`,
  `addFromEntra`) folgen mit Teil-PR 7, die Rollen (`/v1/roles`) mit 6c.
- **Vertragszusätze** (Hauptsession, 2026-10-23):
  - `GET /v1/admin/status` liefert `groupRolePrefix` (aus `GROUP_ROLE_PREFIX`, mit führendem und ohne abschliessenden
    `/`, z. B. `/orgs`) für den Gruppenhinweis der Oberfläche (iam-web #18).
  - `POST …/suspend` und `…/resume` erklären den Body `{ reason?: string (≤ 500) }` im Schema; ohne Body gilt `{}`.
    `@fastify/swagger` schreibt für jede Route mit Body `requestBody.required: true`; `optionalBodies` (als
    `transformObject`) weist die mit `'x-body-optional': true` markierten Routen als optional aus.
  - Letzte Person mit org-admin (Spez. 9.1 Nr. 6): Es zählen nur **aktive** – Mitglied, Konto nicht gesperrt, keine
    offene Einladung und nicht «Passwort setzen» offen ohne Zugriff (wie `status: 'active'` in der Liste). Assets
    (`service.ts:232` `activeAdmins`, `:664` `lastAdminGuard`) zählt auch eine nie angenommene Einladung mit angelegtem
    Konto, weil das neue Konto ab der Einladung Mitglied ist.
  - `GET /v1/platform/organizations/{alias}/roles` (Frontend #21): Rollen einer anderen Organisation für die
    Plattform-Administration, nur lesend, im Format von `GET /v1/roles` (Schema `Role`, `roleList`, `MAX_CUSTOM_ROLES`
    im Kern; das Modul `roles` in 6c nutzt dieselben Bausteine). Mit Anzahl Personen je Rolle; Organisation ohne
    Mandant: nur vordefinierte Rollen, kein Mandant angelegt. Auch im Auszug `iam-web/test/fixtures/openapi-iam.json`
    (zusammen mit `groupRolePrefix` und dem Body von suspend/resume).
- **Codex zu #24**: `createTenant` und `setTenantStatus` schreiben Mandant bzw. Status und Protokoll in einer
  Transaktion der Laufzeit (scheitert das Protokoll, bleibt kein verwaister Mandant bzw. kein ungeprüfter Status).
  Sperren und Entsperren laufen unter der Sperre der Organisation (`admin:<alias>`) und lesen die Organisation darunter
  neu. Niemand entfernt sich selbst, auch nicht über die Plattform-Route. (Assets: `ops/tenants.ts` und
  `service.ts:622/795` gleich wie vorher im Paket.)
- **Unabhängige Review zu #24**: (A) Der Schutz des letzten Admins greift nur, wenn die Zielperson selbst aktiv ist –
  eine feststeckende einzige Einladung mit org-admin lässt sich zurückziehen. (B) Ein gesperrter Mandant ohne
  `kc_org_id` gilt nicht als die Organisation mit gleichem Alias (`orgMatches` false); die Verwaltung antwortet 409
  `unbound-suspended` mit Hinweis auf `relinkTenant` und bindet nichts. (C) `GROUP_ROLE_PREFIX` wird beim Laden
  einheitlich mit führendem und ohne abschliessenden `/` geführt (`normalizeGroupPrefix`); leere Teile und Leerzeichen
  sind ein Konfigurationsfehler. (D) `optionalBodies` gibt bei Swagger 2 (`swaggerObject`) das Dokument unverändert
  zurück.
- **Alias nur ASCII klein** auch in der Verwaltung und im Abgleich (Zwischenspeicher der Organisationen, Zuordnung zum
  Mandanten, Anlegen): Assets nutzt `toLowerCase()` (`service.ts:152/154/695/697/698/736`, `sync.ts:144`), das das
  Kelvin-Zeichen zu «k» faltet.
- **`sync`** (`src/sync.ts`, aus Assets `modules/admin/sync.ts` und `worker/member-sync.ts`): `orgMatches`,
  `syncTenantName`, `syncTenantMembers`, `syncAllMembers` mit `{ schema, audit }` als erstem Parameter;
  `new MemberSync(cfg, db, { schema, audit?, log?, fetch? })` wie 3.1 (Sperre `LOCKS.memberSync`).
- `GET /v1/people`, `GET /v1/people/{id}` (Spez. 9.2 und 15.2) kommen mit Teil-PR 6c (entschieden 2026-10-23); die Tests
  hier prüfen das Personenverzeichnis über die Tabelle `principal`.

### 13.14 Module `roles` und `people` (Teil-PR 6c)

- **Modul `roles`** (`src/http/roles.ts`, aus Assets `modules/admin/roles.ts`): `GET/POST /v1/roles`,
  `GET/PATCH/DELETE /v1/roles/:key` mit `If-Match` (412), Grabstein (`deleted_at`, Schlüssel nie wieder vergeben),
  Anlegen, Ändern und Löschen unter der Sperre `admin:<alias>` (Zeile mit `FOR UPDATE`), damit `If-Match` auch bei
  gleichzeitigen Anfragen gilt. Löschen prüft unter dieser Sperre, entfernt dann die Gruppe in Keycloak (über
  `iam.admin`, wenn eingerichtet) und die ACL-Einträge der Rolle und ihrer Gruppe `<prefix>/<alias>/<key>` (je Eintrag
  `acl.changed`). Lesen mit `tenant:read`, Ändern nur Personen mit `members:admin`; Rechte eigener Rollen aus
  `customRolePermissions` des Katalogs (Schema mit den Rechten der App als `enum`). Standardmässig aktiv, Tag
  `Verwaltung: Rollen`. Liste und Rolle im selben Format wie `…/platform/organizations/{alias}/roles` (`roleList`).
- **Modul `people`** (`src/http/people.ts`, aus Assets `modules/catalog/people.ts`): Liste mit Suche, Cursor und
  Sammelabfrage `ids` (höchstens 100), einzeln auch Clients und entfernte Personen; Sicht auf E-Mail (Personen,
  Verwaltende) und letzten Zugriff (nur `acl:read` oder `tenant:admin`) wie Assets. Recht: eines aus der Plugin-Option
  `people.permissions` irgendwo (`canSomewhere`); Standard (`defaultPeoplePermissions`) die Fachrechte des Lese-Scopes
  `<produkt>:read` ohne reservierte, dazu `acl:read` (Spez. 9.2 «lesendes Fachrecht bzw. acl:read»). Assets übergibt
  `['object:read']` (dort heute nur dieses Recht). Standardmässig aktiv, Tag `Personen`; öffnet ohne Option kein Recht
  das Verzeichnis, fehlt das Modul mit Warnung (nur ausdrücklich in `modules` ein Fehler). Unbekannte Rechte in
  `people.permissions` sind ein Fehler beim Start, vorbehaltene (z. B. `tenant:read`, hat jedes Mitglied) eine Warnung.
- **Bausteine** in `routes.ts`: `Limit`, `Cursor`, `NextCursor`, `encodeCursor`, `decodeCursor`, `likePattern`, `etag`,
  `ifMatchVersion` (aus Assets `http/route-kit.ts`).
- **Fehlerantworten je Route** (`registerProblemSchemas`): Der Hook ergänzte bisher das Antwortobjekt der Route selbst;
  geteilte Objekte wie `Deleted` erhielten so die Fehler aller Routen (z. B. 412 für jedes `DELETE`, sobald eine Route
  `If-Match` kennt). Jetzt eine Kopie je Route. Assets: `http/app.ts:452`, gleich betroffen (16 Routen mit `Deleted`).
- Die Isolationstests decken damit alle Routen des Pakets ausser der Entra-Anbindung (Teil 7) ab.
- **Rollenänderungen ohne Ereignis** (wie Assets, entschieden): Kein Zwischenspeicher hält die Rechte einer Rolle über
  eine Änderung hinaus – die Entscheidung lädt neu, sobald `acl_version` steigt (Trigger auf `tenant_role` und
  `acl_entry`, auch für andere Instanzen; Test mit zweiter Instanz), der Resolver hält nur die Rollen aus dem Token,
  die Schlüssel eigener Rollen der Verwaltung leert `forgetRoles`. Beim Vergeben (Einladen, Rollen setzen) prüft die
  Verwaltung die Rollen unter der Sperre `admin:<alias>` erneut ohne Zwischenspeicher; sonst legte eine andere Instanz
  die Gruppe einer gelöschten Rolle neu an. `POST /v1/acl` sperrt eine eigene Rolle (direkt oder als Gruppe) in der
  Transaktion (`FOR SHARE`).
- **Review zu #24, E und F**: Aliase in Keycloak, die sich nur in der Gross-/Kleinschreibung unterscheiden, ergeben
  409 `ambiguous-alias` statt stillschweigend der letzten. Anlegen einer Organisation mit dem Alias einer früher
  gelöschten: Rollengruppen `<prefix>/<alias>/<rolle>` (vordefinierte Rollen) mit Personen → 409
  `leftover-role-groups`, leere werden übernommen. Spez. 9.3: Einladen löst keinen Abgleich aus (Eingeladene erst nach
  Annahme im Verzeichnis); präzisiert statt `syncNow` nach dem Einladen.
- **Review zu #25**: Client-Rollen `c-…` eines Service Accounts zählen nie (Spez. 8.3: Clients nur vordefinierte
  Rollen). Mehrstufiges `GROUP_ROLE_PREFIX` (`/kunden/orgs`): jede fehlende Stufe einzeln angelegt (der `KeycloakFake`
  lehnt Namen mit «/» jetzt ab). Cursor von `GET /v1/people` mit echter UUID-Prüfung (422 statt 500).
- **Hinweis für den Katalog** (später `docs/backend.md`): Eigene Rollen dürfen jedes Recht aus
  `customRolePermissions`, es gibt keine Teilmengenregel. Wer `members:admin` über eine vordefinierte Rolle ohne
  org-admin hat, kann eine eigene Rolle mit allen diesen Rechten anlegen und sich selbst geben. `members:admin` also
  nur Rollen geben, denen alle `customRolePermissions` zustehen dürfen.

### 13.15 Modul `entra` (Teil-PR 7)

- **`EntraGraph`** (`src/graph.ts`) und **`EntraService`** (`src/entra.ts`) aus Assets `modules/admin/{graph,entra}.ts`;
  `createIam` baut den Dienst als `iam.entra`, wenn die Verwaltung eingerichtet ist (`entra.graph` null ohne
  `ENTRA_CLIENT_ID`); `entraFetch` und `entraRetryMs` für Tests. `AdminService.addFromEntra`, `entraAddress` und
  `EntraLink` kommen nach `admin.ts`.
- **Modul `entra`** (`src/http/entra.ts`): `…/admin/entra…`, `…/platform/organizations/:alias/entra…`,
  `…/members/entra-search`, `…/members/entra`, `/v1/admin/entra/test`, `/v1/platform/entra/refresh`; standardmässig
  aktiv (braucht das Modul `admin` davor). Ratenbegrenzung der Personensuche über `config.rateLimit` der Route (30 je
  Minute, Schlüssel Mandant und Person); sie wirkt, wenn die App `@fastify/rate-limit` registriert.
- **Rückkehrpfade konfigurierbar** (Hauptsession, 2026-10-23): `ENTRA_UI_PATH` (Standard `/verwalten/anmeldung`, wie
  `paths.entra` in `@vollholz/iam-web`) statt der festen Pfade in Assets; Zustimmung `<pfad>/zustimmung` (Redirect-URI),
  Testanmeldung `<pfad>/test` (`returnTo` in `testLoginPath`). `GET …/entra` nennt beide (`consentPath`, `testPath`).
  Spez. 9.4 und 13 nachgeführt, ebenso der OpenAPI-Auszug von `@vollholz/iam-web`.
- **Ablauf der Erstanmeldung** `<produkt>-entra-first-login` (Realm-Modul `entra.tf`) statt `assets-entra-first-login`.
- **Review zu #26 (Hauptsession)**, Abweichungen von Assets:
  - F1, Sicherheit: Die Admin-Zustimmung (`…/adminconsent`) bewies nichts. Microsoft stellt Client-Credentials-Tokens aus,
    sobald der Tenant irgendwann zugestimmt hat; eine org-admin hätte mit dem `state` aus der Adresse `complete` direkt
    aufrufen und einen fremden Tenant samt Domänen und Verzeichnis übernehmen können. Jetzt Code-Flow mit PKCE und
    `nonce` (beide per HMAC mit `ENTRA_CLIENT_SECRET` aus `state` abgeleitet, keine neue Spalte), Einlösen auf dem
    Server und Prüfung des ID-Tokens (`EntraGraph.verifyConsent`, Spez. 9.4). `consentBy` im Audit.
    `prompt=admin_consent` (Zustimmung für den Tenant). `wids` nur mit `groupMembershipClaims` «DirectoryRole» in der
    Entra-App; fehlt der Claim, 409 mit Hinweis darauf (fail-closed; «Default User» b79fbf4d-… genügt nie).
    Vertragsänderung: `POST …/entra/consent/complete` nimmt `code` statt `tenant` und `adminConsent`.
  - F2: «Nur Entra» lässt Konten mit `PLATFORM_ADMIN_ROLE` (zusammengesetzt gelesen) Passwort und Passkey
    (`removeFirstFactor`, auch beim Hinzufügen aus Entra ID); Vorschau und Ergebnis mit `passwordKept`.
  - F3–F6: Schlüssel der Ratenbegrenzung mit Produkt (`<produkt>:entra-search:…`), `POST /v1/platform/entra/refresh`
    prüft das Recht vor «nicht eingerichtet», `ENTRA_UI_PATH` ohne `.`/`..`, Audit `entra.consent_started` und
    `entra.consent_failed`.
- **Tests**: Die Nachbildung von Microsoft ist `EntraFake` im Test-Kit (0.3.0), mit `approve` für die Anmeldung im
  Browser und ID-Tokens mit eigenem JWKS.

### 13.16 MCP, `org-bootstrap`, Doku (Teil-PR 8)

- **MCP** (`src/mcp/`, aus Assets `mcp/{dpop,exchange,api,server}.ts`): `DpopSigner`, `TokenExchanger` (Scopes nur aus dem
  Katalog der App und `organization…`), `ApiClient` und `McpAuth` mit `registerMcpAuth`. `McpAuth` ist die Anmeldung aus
  `buildMcpApp` ohne MCP-SDK (Ursprung, Token, Scope, nur POST, keine gebundenen Tokens, `MCP_HOST_CLIENT_IDS`, Tausch,
  Organisation(en) mit Rechten, Fehler als JSON-RPC). Server und Werkzeuge baut die App; das Paket hängt nicht vom SDK
  ab. `DEFAULT_SCOPES` wird `McpAuth.defaultScopes` (`openid`, `organization:*`, `<produkt>:read`).
- **`org-bootstrap`** (`src/bootstrap.ts`, Kommandozeile `iam-org-bootstrap`, aus Assets `scripts/org-bootstrap.ts`):
  über `KeycloakAdmin` mit dem Service Account `<realm>-iac`; Rollen aus `--catalog` (platform.json) statt `ROLES`,
  Präfix Stufe für Stufe, Alias nach `ALIAS_PATTERN`. Der `KeycloakFake` kennt dafür Realm-Rollen und
  `reset-password`.
- **Doku** `docs/backend.md`: Einbinden, Katalog (Hinweis zu `members:admin`), Konfiguration, Datenbank, API mit den
  vorausgesetzten Einstellungen (`removeAdditional: false`, `@fastify/rate-limit`, Swagger), Module und Optionen,
  Worker, MCP, Betrieb (Ersteinrichtung, Entra-App mit Verzeichnisrollen im Gruppen-Claim), Tests.
- `private` entfernt: Der Release-Workflow veröffentlicht `@vollholz/iam` 0.1.0 nach dem Merge.

- **Review zu #29 (Hauptsession)**:
  - S1: `WWW-Authenticate` nur mit druckbarem ASCII (`headerText`), sonst scheiterte der Header an «…» oder CR/LF.
  - S2: Passwortdatei nur in einem eigenen, für andere geschlossenen Verzeichnis (`lstat`), neu mit `O_EXCL|O_NOFOLLOW`
    und 0600; scheitert das Setzen in Keycloak, wird sie gelöscht.
  - S3: Test-Kit 0.3.1 (0.3.0 ist mit #26 veröffentlicht).
  - S4, S9: MCP-Beispiel mit GET/POST/DELETE, `redact`, `allowedOrigins`; absolute Links; `SHARED_STATE`; Export
    `./package.json`.
  - S5–S8: `GROUP_ROLE_PREFIX` geprüft (`GROUP_PREFIX_RE`), Realm im Dateinamen bereinigt; kein Passwort für Konten mit
    Identitätsanbieter; `X-Tenant`/`?org=` nach `ALIAS_PATTERN` (400); `TokenExchanger` tauscht nie ohne Scope des
    Katalogs, höchstens 10 000 Tokens im Zwischenspeicher.

### 13.17 Link an die Entra-Administration (Kit 0.2)

- Ziel: org-admins richten SSO selbst ein, auch wenn eine andere Person der Kunden-IT bei Microsoft zustimmen muss.
  Bisher galt die Rückkehr nur in der Sitzung der startenden Person (`entra_consent.subject`).
- `iam_013`: `entra_consent_link` (Mandant, Token-Hash, Entra-Tenant, erzeugende Person, Ablauf höchstens 24 Std.,
  eingelöst, widerrufen, zustimmende Person, Fehler); `entra_consent.link_id`, `subject` dafür optional (genau eines).
- Token `<alias>.<zufall>`: der Alias findet den Mandanten (`findTenant`), danach alles unter RLS über den Hash – keine
  neue Funktion ohne Mandantenkontext. `state` des Links `h.<alias>.<zufall>`; PKCE und `nonce` wie bisher aus `state`.
- Einlösen belegt den Link vor dem Nachweis (gleichzeitige Rückkehren: eine verbindet, die andere 404) und gibt ihn bei
  einem Fehlschlag mit dem Fehler wieder frei. Verbunden wird mit einem Akteur aus der erzeugenden Person (ohne Token);
  `entra.connected` mit `consentBy`, `viaLink`, `linkCreatedBy`.
- `info` nennt neben Organisation und Produkt die erzeugende Person (`requestedBy`) und das Verzeichnis wie angegeben
  (`tenant`, `entraTenantId`): Schutz gegen Phishing mit fremden Links. Höchstens 5 offene Links je Organisation (unter
  der Sperre `admin:<alias>` gezählt), Erzeugen 10 pro Minute und Person. Das `tid` des ID-Tokens muss der Tenant des
  Links sein (`verifyConsent`); ein Code aus einem anderen Tenant lässt sich am Token-Endpunkt nicht einlösen.
- Öffentliche Routen `/v1/entra/handover/{info,start,complete}`: im Plugin immer öffentlich (Schutz über Token, `state`
  und PKCE, kein CSRF nötig ohne Sitzung), `config.rateLimit` 20 je Minute und IP, `Cache-Control: no-store`.
- Review #31: Eingelöst (`used_at`, zustimmende Person) in der Transaktion der Verbindung (Hook `onConnected` in
  `connect`); ein während des Nachweises widerrufener Link bricht die Verbindung ab. Fehlschlag gibt den Link nur frei,
  solange nicht verbunden. Beim Start und bei der Rückkehr prüft `requireCreator`, ob die erzeugende Person noch darf
  (Mitglied mit `members:admin` bzw. Realm-Rolle; mit ROLE_SOURCE=client/both nur die Mitgliedschaft, die Rollen stehen
  dort im Token) und ob die Organisation aktiv ist; sonst widerrufen (`creator-lost-access`). Entfernen und Zurückstufen über
  die App widerrufen sofort (`revokeConsentLinksOf`), Trennen widerruft alle offenen Links. Liste: alle offenen, dazu 20
  erledigte; erledigte Links nach 90 Tagen gelöscht (beim Erzeugen). `entra_consent` zeigt mit `(tenant_id, link_id)`
  auf den Link. `entra.consent_failed` nur für abgelehnte oder nicht nachgewiesene Zustimmung (Fehler beim Verbinden:
  `entra.connect_failed`). `info.notice`: den Namen des Entra-Tenants kennt die App vor der Zustimmung nicht (Graph
  braucht die Zustimmung); angezeigt wird das Verzeichnis wie angegeben.


### 13.18 Eigene App der Organisation (Kit 0.3)

- Entscheid des Owners: Kunden haben mit einer Entra-App des Betreibers nichts zu tun. Jede Organisation verbindet mit
  einer eigenen App in ihrem Tenant; die App der Plattform (ENTRA_CLIENT_ID) bleibt optional und ist ohne die Variable
  aus. Portiert aus Assets #22 (dort Migration 050, nicht gemergt), angepasst ans Paket.
- `iam_014`: `entra_connection.app_client_id`, `app_secret_enc` (AES-256-GCM `v1.<keyId>.<iv>.<tag>.<ct>`, AAD
  `entra_connection:<mandant>:<anwendungs-id>`), `app_secret_expires_at`; Alias `entra-app-<alias>` zusätzlich zu den
  Plätzen; `entra_consent_link.kind`. Rotation: `rewrapEntraSecrets` (Aufruf aus dem Rotationsskript der App).
- `EntraGraph` mit `own`: Fehler bei Microsoft mit `reason` für die Eingaben der Organisation; `checkApp` prüft die
  Rollen im Token (Graph-Tokens sind JWTs, gelesen ohne Signaturprüfung, sie kommen direkt von Microsoft), liest die
  Organisation und – nur mit Application.Read.All o. ä. – den Ablauf über `passwordCredentials.hint` (erste drei Zeichen;
  mehrere passende: das früheste Ende). Fehlende Berechtigung und fehlende Administratorzustimmung sind im Token nicht
  unterscheidbar (keine Rolle) und ergeben beide `missing-permissions`.
- `connect` nimmt die App als Parameter (`graphFor` für die übrigen Wege); `connectApp` und der Link mit
  `kind: 'credentials'` (`handoverApp`) teilen sich Belegen, Einlösen in der Transaktion der Verbindung und Freigeben mit
  der Zustimmung über einen Link (`claim`, `redeem`). Der Tenant des Credentials-Links ist bei der Erzeugung fest:
  sonst könnte, wer den Link hat, ein beliebiges Verzeichnis anhängen.
- Tenant suchen geht ohne App (OpenID-Konfiguration); `directory` ist ein `EntraGraph` ohne Zugangsdaten.
- Bestehende, von Hand angelegte Anbieter übernimmt das Paket nicht (Entscheid Hauptsession): vor dem Neuverbinden in
  Keycloak löschen; verknüpft wird beim Verbinden über die Objekt-ID.
