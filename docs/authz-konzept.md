# Konzept: Berechtigungen als Beziehungen (ReBAC) für identity-kit und Assets

Stand 2026-10-23, Entwurf. Greenfield: kein Migrationspfad, bestehende Realms und Daten dürfen neu entstehen.
Grundlage: Inventar der drei Repositories (Abschnitt 8), Spezifikation Kap. 7–12, Assets `src/platform/authz/*`,
`db/migrations`, `web/src`.

## Inhalt

1. [Entscheid in einem Satz](#1-entscheid-in-einem-satz)
2. [Validierung der bisherigen Aussagen](#2-validierung-der-bisherigen-aussagen)
3. [Das Modell](#3-das-modell)
4. [Architektur](#4-architektur)
5. [Assets: Modell und Oberfläche](#5-assets-modell-und-oberfläche)
6. [Was in den drei Repositories entsteht, ändert, entfällt](#6-was-in-den-drei-repositories-entsteht-ändert-entfällt)
7. [Umsetzungsplan](#7-umsetzungsplan)
8. [Inventar (Ist)](#8-inventar-ist)
9. [Bewusst nicht gebaut](#9-bewusst-nicht-gebaut)

---

## 1. Entscheid in einem Satz

**Keycloak sagt, wer jemand ist; PostgreSQL sagt mit einer Tupel-Tabelle und einem deklarativen Modell je App, was
die Person darf; kein OpenFGA, kein neuer Dienst, kein neues Repository.**

Formel für jede Entscheidung:

```
erlaubt = Beziehung ergibt Recht  ∧  Klassifizierung ≤ Freigabestufe  ∧  Scope deckt das Recht (nur Clients, MCP)
```

Drei Fragen an die Engine, alle in SQL beantwortbar:

| Frage | API | Wofür |
|---|---|---|
| Darf X das Recht Y auf Z? | `can` / `need` | Aktionen, `can`-Felder, Knöpfe |
| Was darf X lesen? | RLS-Lesesicht aus Session-Einstellungen | Listen, Suche, Reports, Graph, Zähler – ohne Lücken, ohne N+1 |
| Warum? Wer? | `explain` / `whoHasAccess` | Freigabe-Panel, «Warum sehe ich das?» |

## 2. Validierung der bisherigen Aussagen

### 2.1 Meine früheren Antworten in diesem Gespräch

| Aussage | Befund |
|---|---|
| OpenFGA als Engine, in `identity` betrieben, ein Store je Produkt | **Verworfen.** Für ein EA-Werkzeug ist List/Filter die entscheidende Frage (Suche, Reports, Graph über Zehntausende Objekte, heute 13 Report-Routen + 10 View-Routen mit `needSomewhere('object:read')`). OpenFGA beantwortet Check gut, List/Filter nur über `ListObjects` oder Doppelbuchführung. Die Mandantentrennung liegt ohnehin zwingend in RLS. Ein externer Dienst würde zwei Wahrheiten (App-DB und FGA), Outbox, HA und Backup verlangen, ohne dass eine App davon etwas gewinnt. Die bestehende Architektur (Lesesicht aus Session-Einstellungen + RESTRICTIVE-Policies) ist bereits das richtige Muster und wird beibehalten. |
| Keycloak = «wer», Engine = «was»; Rollen nicht im Token | **Bleibt.** Rollen, Freigaben und Client-Freigaben werden Tupel in der App-Datenbank; Keycloak hält nur Realm, Organisationen, Mitgliedschaft, Clients, Scopes, `platform-admin`. Rollengruppen `/orgs/<alias>/<rolle>` und Client-Rollen entfallen. |
| Scopes schneiden nur, geben nichts; MCP-Agent nie mehr als die Person | **Bleibt** (heute schon so, `access.ts:91-106`). |
| Gemeinsame Bibliothek, App bringt eigenes Modell; drei Stufen einfach/mittel/komplex | **Bleibt**, umgesetzt als `defineModel()` im Baukasten. |
| GUI verwaltet Daten (Beziehungen), Regeln liegen im Code | **Bleibt.** |
| Rechteverwaltung über MCP und M2M gibt es nicht | **Bleibt** (`members:admin`, `access:admin` in keinem Scope). |

### 2.2 Der Auszug (sechs Bausteine) und die Screenshots

| Baustein | Befund | Anpassung |
|---|---|---|
| 1 Alles ist eine Beziehung; Rolle = Beziehung an einem Ort | Richtig und tragfähig. Rolle org-weit = Tupel an `org`, Rolle im Bereich = dasselbe Tupel an Schema, Typ oder Organisationseinheit. Ersetzt heutige drei Konzepte (Rolle, `grant`, «Rechte einer Rolle im Bereich» = n grants). | Keine. |
| 2 Rechte deklarativ aus Beziehungen | Richtig. Die DSL bleibt bewusst klein: Vereinigung direkter Beziehungen plus Vererbung über genau benannte Kanten (`parent->`, `owned_by->`). Keine Ausschlüsse, keine Schnittmengen in der DSL. | DSL in TypeScript (`defineModel`), nicht als eigene Sprache. |
| 3 Metamodell sagt, welche Beziehungen zählen | Richtig und der eigentliche Gewinn für Assets. Heute: `reference_type` je Schema mit `name`/`inverse_name`, keine Semantik. | `reference_type` erhält `grants` (`none` \| `read` \| `edit`) und `inherits_scope` (Kante, über die Zuständigkeit weitergereicht wird, z. B. «übergeordnete Einheit»). |
| 4 Vertraulichkeit als Klassifizierung, von keiner Beziehung übersteuert; dazu höchstens `blocked` | Klassifizierung: richtig, günstig (eine Spalte, eine Policy). Attributgruppen gibt es in Assets nicht (nur `position`). `blocked`: **weglassen**. Jede Ausnahme macht «Wer hat Zugriff?» und die Lesesicht wieder zweiteilig, und der einzige echte Fall («X soll dieses eine Objekt nicht sehen») wird mit Klassifizierung oder Zuständigkeit gelöst. | Klassifizierung am Objekt (und am Typ als Vorgabe), Freigabestufe je Principal. Attributgruppen nicht Teil des Vorhabens. |
| 5 Scopes schränken nur ein; Programm mit Admin-Rolle nicht ausgenommen | Richtig, heute schon so. | Keine. |
| 6 Organisation harte Grenze (RLS), Admins nicht ausgenommen, Break-Glass | Richtig. Ohne Verbote und Beschränkungen gibt es nur eine Sache, an der ein org-admin scheitern kann: die Klassifizierung. Break-Glass ist deshalb nur **eine** Funktion: Freigabestufe zeitlich begrenzt auf die höchste Stufe heben, mit Begründung, im Protokoll, mit Banner. | Keine weitere Ausnahme. |
| Engine in Postgres: Tupel-Tabelle + materialisierte Mitgliedschaften + `EXISTS` + Konsistenzmarke | Richtig. Materialisierung aber nicht als Tabelle, sondern **je Anfrage**: die Menge der Subjekte (ich, meine Gruppen, meine Organisationseinheiten transitiv) und die Menge der lesbaren Container werden einmal berechnet und als Session-Einstellungen gesetzt, wie heute `app.read_types`. Konsistenzmarke = `tenant.acl_version` (Trigger auf der Tupel-Tabelle), wie heute. | Keine materialisierte Tabelle (kein Refresh-Problem, keine Stale-Daten). |
| UX: Freigabe-Panel, Folgen beim Ändern, verborgene Nachbarn, Lebenszyklus (Ablauf, Anfrage, Rezertifizierung), SCIM | Freigabe-Panel und «Warum/Wer»: Kern. Ablaufdatum: günstig (eine Spalte `expires_at`). **Folgen-Vorschau, Zugriffsanfragen, Genehmigung, Rezertifizierung, verborgene Nachbarn: nicht Teil des Vorhabens** (Abschnitt 9). SCIM: Keycloak 26 hat keinen SCIM-Server; Gruppen kommen wie heute aus Entra (IdP-Mapper) als `groups`-Claim. | Lebenszyklus auf `expires_at` begrenzt. |
| Vokabular: Rolle, Ort, Zuständigkeit, Vertraulichkeit | Übernommen, plus **Freigabe** (ein Tupel, das jemand im Panel anlegt). | – |

## 3. Das Modell

### 3.1 Begriffe (sichtbar in der Oberfläche, verbindlich)

| Begriff | Bedeutung | Beispiel |
|---|---|---|
| **Rolle** | Name einer Beziehung, die Rechte ergibt | Bearbeiter:in, Leser:in, Schema-Admin |
| **Ort** | Ressource, an der eine Rolle hängt | Organisation, Schema «IT», Typ «Server», Organisationseinheit «Abteilung X», Objekt «n42» |
| **Freigabe** | Ein Eintrag «Wer – Rolle – Ort», optional mit Ablaufdatum | «Anna ist Bearbeiterin am Schema IT bis 31.12.» |
| **Zuständigkeit** | Rechte, die aus Fachdaten folgen: Objekt gehört zu Einheit, Person ist Mitglied der Einheit | «Mitglieder der Abteilung X lesen alles, was der Abteilung gehört» |
| **Vertraulichkeit** | Stufe am Objekt (intern, vertraulich, streng vertraulich); Freigabestufe je Person | «Streng vertraulich sehen nur Personen mit Freigabestufe 2» |
| **Scope** | Obergrenze im Token für Programme, MCP, Assistent | `assets:read` |
| **Recht** | Was eine Aktion verlangt, Schlüssel `<bereich>:<verb>` | `object:write` |

Entfallen: «Zugriffsregel», «Verbieten», «Beschränken auf», «eigene Rolle», «Principal», «Gruppe» als Verwaltungsbegriff.

### 3.2 Ein Eintrag

```
authz_tuple(tenant_id, subject, relation, object_type, object_id, expires_at, created_at, created_by)

  subject     'user:<principal-id>' | 'client:<principal-id>' | 'group:<name>' | 'org:members'
  relation    Rollenname des Modells (editor, viewer, …) oder Fachbeziehung (member, owned_by)
  object_type Ressourcentyp des Modells ('org', 'schema', 'type', 'object', 'connection', 'credential', 'view', 'report')
  object_id   uuid, NULL genau bei 'org'
```

Beispiele:

```
user:anna      editor    org       –          Anna ist org-weit Bearbeiterin
user:anna      viewer    schema    IT         Anna liest das Schema IT (Rolle im Bereich)
group:abt-x    member    object    ou-42      Entra-Gruppe ist Mitglied der Organisationseinheit ou-42 (ein Objekt)
org:members    viewer    view      v-7        Ansicht v-7 ist mit der ganzen Organisation geteilt
client:sync-1  editor    org       –          Maschinen-Client ist freigegeben als Bearbeiter
```

Fachliche Kanten («Objekt n42 gehört zu ou-42», «ou-42 ist Teil von ou-1») sind **keine** Tupel, sondern bleiben
`object_reference` – das Modell deklariert, welche Referenztypen zählen.

### 3.3 Modell je App (DSL in TypeScript)

```ts
export const model = defineModel({
  product: 'assets',
  roles: {                       // Rollen = Beziehungsnamen, mit Label und Beschreibung (wie heute ROLES)
    'org-admin': { label: 'Organisations-Admin', permissions: '*' },
    'schema-admin': { … }, 'integration-admin': { … }, reviewer: { … }, editor: { … }, viewer: { … }, auditor: { … },
  },
  permissions: { 'object:read': { label, group, description }, … },   // wie heute
  scopes: { 'assets:read': ['object:read', …], … },                   // wie heute
  types: {
    org:        { roles: '*' },                                        // jede Rolle darf hier hängen
    schema:     { parent: 'org',    roles: ['schema-admin', 'editor', 'viewer', 'reviewer'] },
    type:       { parent: 'schema', roles: ['editor', 'viewer', 'reviewer'], self: 'type' /* parent_id */ },
    object:     { parent: 'type',   roles: ['editor', 'viewer'], leaf: true,
                  classified: true,
                  scope: { via: 'reference', relation: 'owned_by' } },   // Zuständigkeit über markierte Referenzen
    connection: { parent: 'org', roles: ['integration-admin', 'viewer'] },
    credential: { parent: 'org', roles: ['integration-admin'] },
    view:       { parent: 'org', roles: ['editor', 'viewer'], owner: true },
    report:     { parent: 'org', roles: ['editor', 'viewer'], owner: true },
  },
});
```

Regeln der Auswertung (fest im Baukasten, nicht konfigurierbar):

1. `can(p, perm, ref)` ist wahr, wenn auf `ref` oder einer Ressource der Kette darüber (`parent`, bei Typen auch
   `parent_id`-Vorfahren) ein Tupel mit einer Rolle liegt, die `perm` enthält, und das Subjekt zu den Subjekten von `p`
   gehört (`user:me`, `client:me`, `group:*` aus dem Token, `org:members`).
2. Zusätzlich bei `scope`: das Objekt gehört (über einen Referenztyp mit `grants ≠ none`) zu einer Einheit, in deren
   Zuständigkeitsbereich `p` ist (Mitglied der Einheit oder einer übergeordneten, über Referenztypen mit
   `inherits_scope`). `grants = read` ergibt `object:read`, `grants = edit` ergibt `object:read` + `object:write`.
3. Bei `classified`: `classification(ref) ≤ clearance(p)`.
4. Bei `owner`: Besitzer:in hat alle Rechte der Ressource.
5. Bei `scopeBound`: `perm ∈ scopes(p)`.
6. Abgelaufene Tupel (`expires_at < now()`) zählen nicht; ein Aufräumjob löscht sie und protokolliert.

Keine Verbote, keine Beschränkungen, keine Ausnahme für org-admin: ein org-admin hat alle Rechte, weil die Rolle alle
Rechte enthält, nicht weil er von etwas ausgenommen wäre. An der Klassifizierung scheitert auch er (Break-Glass).

### 3.4 Subjekte und Lesesicht je Anfrage

Je Anfrage (unter `withTenant`, in derselben Transaktion) berechnet der Baukasten einmal:

| Einstellung | Inhalt | Verwendung |
|---|---|---|
| `app.subjects` | `text[]`: `user:<id>`, `client:<id>`, `group:<name>…`, `org:members` | `EXISTS`-Prüfungen auf Blatt-Tupeln (Objekt, Ansicht, Report) |
| `app.read_all` | `on`, wenn `object:read` org-weit | wie heute |
| `app.read_types` | `uuid[]` der Typen mit `object:read` (Rolle an Org, Schema, Typ oder Vorfahr) | wie heute |
| `app.read_units` | `uuid[]` der Organisationseinheiten im Zuständigkeitsbereich (transitiv, rekursive CTE, Tiefe ≤ 16) | Objekte, die über markierte Referenzen dazugehören |
| `app.clearance` | `0..2` | Policy `classification <= app.clearance()` |

RLS-Policy für Objekte (RESTRICTIVE, zusätzlich zu `tenant_isolation`):

```sql
USING (
  classification <= app.clearance()
  AND (
    app.read_all()
    OR type_id = ANY (app.read_types())
    OR EXISTS (SELECT 1 FROM assets.authz_tuple t WHERE t.tenant_id = object.tenant_id AND t.object_type = 'object'
               AND t.object_id = object.id AND t.subject = ANY (app.subjects()) AND (t.expires_at IS NULL OR t.expires_at > now()))
    OR EXISTS (SELECT 1 FROM assets.object_reference r JOIN assets.reference_type rt ON …
               WHERE r.from_id = object.id AND rt.grants <> 'none' AND r.to_id = ANY (app.read_units()))
  )
)
```

Damit entfallen `hiddenObjects()` und alle `NOT (o.id = ANY($hidden))`-Stellen in Listen, Suche, Graph, Reports,
Zählern und Schreibpfad-Sichtbarkeit: Die Datenbank liefert nur, was lesbar ist. Schreiben prüft die App vorab mit
`need()` und die Policy mit `WITH CHECK` (Schreibrecht analog mit `app.write_types`, `app.write_units`).

### 3.5 Klassifizierung und Break-Glass

| Element | Umsetzung |
|---|---|
| Stufen | `0` intern (Standard), `1` vertraulich, `2` streng vertraulich; Labels im Baukasten, App kann umbenennen |
| Objekt | `object.classification smallint NOT NULL DEFAULT 0`; Vorgabe je Typ `object_type.default_classification` |
| Person / Client | `principal.clearance smallint NOT NULL DEFAULT 0`; setzt `members:admin` in der Mitgliederliste |
| Setzen der Stufe am Objekt | `object:write` und eigene Freigabestufe ≥ neue Stufe (niemand klassifiziert über die eigene Stufe hinaus) |
| Break-Glass | `POST /v1/break-glass {reason, minutes ≤ 240}` nur für `org-admin`-Personen: `principal.clearance_until`, `clearance_boost = 2`; Audit `break_glass.started` / `.ended`; Banner in der Oberfläche; keine Verlängerung ohne neuen Aufruf |

### 3.6 Maschinen-Clients, MCP, Assistent

Unverändert gegenüber Kap. 12, mit einer Vereinfachung: Die Freigabe eines Clients (`client_grant`) **ist** das Tupel
`client:<id> <rolle> org`. Die Tabelle `client_grant` entfällt; die Seite «Maschinen-Clients» zeigt Clients als
Zeilen der Mitgliederliste mit Art «Client». Client-Rollen in Keycloak entfallen; Rollen kommen nur noch aus Tupeln.

## 4. Architektur

### 4.1 Verteilung

| Ebene | Verantwortung | Repository |
|---|---|---|
| Identität | Realm, Organisationen, Mitgliedschaft, Clients, Scopes, Entra, `platform-admin` | `identity` (Betrieb, unverändert), `identity-kit/modules/product-realm` (vereinfacht) |
| Engine | Tupel-Tabelle, `defineModel`, Subjekte, Lesesicht-Einstellungen, `can`/`need`/`explain`/`whoHasAccess`, Verwaltung (Freigaben, Mitglieder, Clients), Klassifizierung, Break-Glass, Audit | `identity-kit/packages/iam` |
| Oberfläche | Freigabe-Panel, «Wer hat Zugriff?», «Warum?», Mitglieder mit Rolle und Ort, Klassifizierungs-Badge, Break-Glass-Banner, «Meine Rechte» | `identity-kit/packages/iam-web` |
| Tests | Modellprüfung, RLS-Prüfung, Isolation, Konformität | `identity-kit/packages/iam-testkit` |
| App | Modell (`authz/model.ts`), Kanten (`parent`, `parent_id`, Referenztypen), RLS-Policies, Felder in den Views | `assets` |

### 4.2 Schnittstelle des Baukastens zur App

| Heute | Neu |
|---|---|
| `defineCatalog({permissions, groups, roles, scopes, resources, capabilities, mcpTools})` | `defineModel({…, types})` – gleiche Teile plus `types` (Kette, Rollen je Ort, `scope`, `classified`, `owner`, `leaf`) |
| `ResourceModel {chain, exists, hints, dbContext, load, version}` | `ResourceModel {chain, exists, hints, edges}`; `dbContext` berechnet der Baukasten selbst aus dem Modell; `edges` liefert die rekursive Zuständigkeit (SQL-Fragment der App) |
| `req.need`, `req.needSomewhere`, `req.can`, `req.capabilities`, `req.tx` | **unverändert** (114 + 39 + 20 + 10 Aufrufstellen in Assets bleiben) |
| `GET /v1/acl`, `POST /v1/acl`, `DELETE /v1/acl/:id`, `GET /v1/acl/effective` | `GET /v1/access?type=&id=` (wer hat Zugriff, mit Herkunft), `POST /v1/access` (Freigabe), `DELETE /v1/access/:id`, `GET /v1/access/explain?type=&id=&permission=&subject=` |
| `GET/POST/PATCH/DELETE /v1/roles` (eigene Rollen) | entfällt |
| `PUT /v1/admin/members/:id/roles` (Keycloak-Gruppen) | `PUT /v1/admin/members/:id/roles` (Tupel an `org`); gleiche Antwort |
| `PUT /v1/admin/clients/:clientId` (`client_grant`) | `PUT /v1/admin/clients/:clientId {roles}` (Tupel an `org`) |
| – | `PUT /v1/admin/members/:id/clearance`, `POST /v1/break-glass`, `DELETE /v1/break-glass` |
| `/auth/me` → `permissions`, `grantedPermissions` | `/auth/me` → `permissions` (org-weit), `somewhere` (Rechte, die irgendwo gelten), `clearance`, `breakGlassUntil` |
| `GET /v1/authz/catalog` | gleich, plus `types[].roles`, `classifications` |

Wer darf freigeben (`POST /v1/access`)? Wer am Ort das Recht `access:admin` hat **und** die vergebene Rolle keine Rechte
enthält, die die Person dort selbst nicht hat (niemand gibt mehr, als er hat). `org-admin` an `org` vergibt nur
`platform-admin` (wie heute). `access:admin` ist in `org-admin`, `schema-admin` (an Schemas) und `editor` (an Objekten,
Ansichten, Reports) enthalten – das legt das Modell der App fest.

### 4.3 Tabellen des Baukastens

| Tabelle | Neu / geändert / entfällt |
|---|---|
| `authz_tuple` | **neu** (3.2); Index `(tenant_id, object_type, object_id)`, `(tenant_id, subject)`; Trigger `bump_acl_version`; CHECK `relation` und `object_type` aus dem Modell (`syncModelChecks`, wie heute `syncAclChecks`) |
| `principal` | `+ clearance`, `+ clearance_until`, `+ clearance_boost`; `last_roles` entfällt (Rollen stehen in Tupeln) |
| `acl_entry`, `tenant_role`, `client_grant` | **entfallen** |
| `tenant.acl_version` | bleibt (Konsistenzmarke) |
| `audit_log` | Aktionen: `access.granted`, `access.revoked`, `access.expired`, `member.roles_changed`, `member.clearance_changed`, `client.granted`, `client.revoked`, `break_glass.started`, `break_glass.ended`, `object.classified` |

### 4.4 Keycloak (Realm-Modul)

Entfällt: Client-Rollen von `<p>-platform`, Gruppe `/orgs`, Mapper `groups` für Rollen, FGAP-Rechte auf Gruppen für
`<p>-admin`, `catalog.roles` als Variable, `platformJson().roles`. Bleibt: Clients, Scopes (aus dem Modell), Organisationen,
`platform-admin`, Entra, Richtlinien. Der `groups`-Claim bleibt nur für Gruppen aus Entra (Subjekt `group:<name>`).

Repository `identity`: **keine Änderung** (betreibt Keycloak, kennt kein Produkt).

### 4.5 Wirkungszeiten

Freigabe, Rolle, Klassifizierung, Freigabestufe, Break-Glass: sofort auf allen Instanzen (Datenbank, Version im Cache).
Gruppen aus Entra: mit dem nächsten Token (≤ 5 min). Entfernen einer Person: ≤ 5 min (wie heute).

## 5. Assets: Modell und Oberfläche

### 5.1 Modell

| Ort | Rollen, die dort hängen dürfen | Vererbung |
|---|---|---|
| Organisation | alle sieben | – |
| Schema | schema-admin, editor, viewer, reviewer | → alle Typen und Objekte des Schemas |
| Objekttyp | editor, viewer, reviewer | → Untertypen (`parent_id`) und Objekte |
| Objekt | editor, viewer | – (Blatt) |
| Verbindung, Credential | integration-admin, viewer (Credential nur integration-admin) | – |
| Ansicht, Report, Dashboard | editor, viewer; `owner` | – |

Zuständigkeit: Jeder Referenztyp im Schema trägt zwei Schalter, sichtbar als Satz im Schema-Editor:

| Feld | Werte | Satz in der Oberfläche |
|---|---|---|
| `grants` | `none` (Standard), `read`, `edit` | «Wer für das Ziel zuständig ist, darf dieses Objekt **lesen** / **bearbeiten**.» |
| `inherits_scope` | `false`, `true` | «Zuständigkeit für das Ziel gilt auch für dieses Objekt.» (für «übergeordnete Einheit») |

Zuständig für ein Objekt (typisch: Organisationseinheit, Team, Standort) ist, wer ein Tupel `member` daran hat – Person
oder Entra-Gruppe. Das ist dieselbe Freigabe-Oberfläche mit der Rolle «Mitglied».

Entfernt aus Assets: `acl_entry`, `tenant_role`, `client_grant`, `hiddenObjects()` und alle `hidden`-Filter
(`objects.ts`, `structure.ts`, `reports/filter.ts`, `integrations/visibility.ts`, `catalog/unique.ts`), Seite «Zugriff»,
Seite «Rollen», Simulator, `AclHint`, `report.shared` / `saved_view.shared` (werden Tupel `org:members viewer`).

### 5.2 Oberfläche: wo was erscheint

Ein Baustein für alles: **«Zugriff»** als Seitenleiste (Sheet) an jeder Ressource, überall gleich aufgebaut:

```
Zugriff auf «Server srv-042»                                   [Freigeben]
  Vertraulichkeit: vertraulich  ▾                     (nur mit object:write und Stufe ≥)

  Wer                    Rolle            Über                             Bis
  Anna Muster            Bearbeiterin     direkt                           31.12.2026   [⋯]
  Abteilung X (Gruppe)   Mitglied         Zuständigkeit: gehört zu «Abt X» –            →
  Peter Meier            Leser            Schema «IT»                      –            →
  Alle Mitglieder        Leser            Organisation                     –            →
  sync-1 (Client)        Bearbeiter       Organisation · Scope assets:read –            →

  Warum sehe ich das?  →  «Du liest dieses Objekt über die Rolle Leser:in am Schema IT.»
```

- «Über» nennt den Ort; der Pfeil springt dorthin. Einträge am eigenen Ort lassen sich ändern (Ablauf) und entfernen,
  geerbte nur am Ursprung.
- «Freigeben»: Person, Gruppe (aus Entra) oder «Alle Mitglieder», Rolle (nur die, die hier hängen dürfen und die ich
  selbst habe), Ablaufdatum optional.

| View | Was erscheint |
|---|---|
| Übersicht (`/`) | Zahlen nur aus lesbaren Objekten (RLS). Banner «Notfallzugang aktiv bis 14:30 – beenden» bei Break-Glass. |
| Suche, Typansicht, Tabellen | Nur lesbare Objekte (RLS). Spalte/Badge «Vertraulichkeit» ab Stufe 1. Zeilenmenü «Zugriff…». Knöpfe nach `can` (wie heute). |
| Objekt-Drawer | Kopf: Badge Vertraulichkeit; Aktion «Zugriff» öffnet die Seitenleiste; Feld «Vertraulichkeit» im Bearbeiten (gesperrt mit Grund, wenn Stufe > eigene). «Warum sehe ich das?» im Fuss. |
| Neues Objekt | Vorgabe Vertraulichkeit vom Typ; Klassifizieren nur bis zur eigenen Stufe. |
| Beziehungen (Graph) | Nur lesbare Knoten (RLS, wie heute ohne Platzhalter). |
| Dashboards, Reports, Ansichten | Statt Schalter «mit der Organisation teilen»: dieselbe Seitenleiste «Zugriff» (Besitzer:in, geteilt mit …). Der Schnellschalter «Für alle Mitglieder» bleibt als erste Zeile im Panel. |
| Schema-Editor | Am Schema und am Typ: Aktion «Zugriff» (Rollen im Bereich), Vorgabe Vertraulichkeit am Typ. Am Referenztyp: die zwei Sätze zur Zuständigkeit. |
| Verwalten › Integrationen, Credentials | Aktion «Zugriff» an Verbindung und Credential. |
| Verwalten › Mitglieder | Liste Personen **und** Clients: Rolle(n) org-weit, Freigabestufe, Bereichsrollen als Zahl «+3 Orte» (Klick zeigt sie), zuletzt aktiv. Einladen, Rollen setzen, Freigabestufe setzen, entfernen. |
| Verwalten › Maschinen-Clients | entfällt als eigene Seite; Clients stehen in «Mitglieder» mit Art «Client», Scopes aus dem letzten Token. |
| Verwalten › Zugriff, Rollen | entfallen. |
| Verwalten › Protokoll | zusätzlich Filter «Zugriff» (alle `access.*`, `break_glass.*`, `object.classified`). |
| Kontomenü › Meine Rechte | Rollen org-weit, Bereichsrollen mit Ort, Freigabestufe, Rechte-Übersicht wie heute; Rollenvergleich bleibt. |
| Verwalten › API, KI-Assistenten | Rechte-Übersicht «Rolle ∧ Scope» wie heute. |
| Fehlendes Recht | `MissingRight` wie heute, ergänzt um «oder jemand gibt dir am Ort … frei». |

Muster bleiben: Hauptaktion im Seitenkopf, nicht Erlaubtes gesperrt mit Grund, 404 für Unsichtbares, kein waagrechtes
Scrollen bei 390 px, hell/dunkel, axe ohne serious/critical.

### 5.3 Neue Konzepte im EA-Modell (Entscheid 2026-10-23)

Alle vier werden eingeführt – **in Assets**, als Bestandteile des EA-Katalogs. Der Baukasten kennt davon nur das
Generische (Klassifizierungsstufe, Freigabestufe, Ressource mit Mitgliedern, Vererbung über `edges`); andere Apps
beantworten «woher kommen Kanten und Zuständigkeit» mit ihren eigenen Tabellen oder gar nicht (5.4).

| Konzept | Umsetzung | Wirkung auf Rechte |
|---|---|---|
| **Organisationseinheit** | Mitgelieferter Objekttyp im Standardschema «Organisation» (jede neue Organisation erhält es beim Anlegen); Referenz «übergeordnete Einheit» mit `inherits_scope`; Mitglieder = Personen oder Entra-Gruppen mit Rolle «Mitglied» im Panel «Zugriff» | Zuständigkeit (3.3 Regel 2) |
| **Eigentümer / Verantwortliche** | Keine feste Spalte. Attribute der Art `user` oder `ref` tragen `grants` (`none` \| `read` \| `edit`) – der Schalter liegt an `attribute_def`, nicht nur am `reference_type`. Standardschema: «Verantwortlich» (Person, `edit`), «Gehört zu» (Einheit, `read`) | Person oder Einheit im Attribut erhält das Recht; mehrere Verantwortliche mit verschiedener Wirkung möglich |
| **Attributgruppen** | Tabelle `attribute_group` je Typ (`name`, `position`, `classification`), `attribute_def.group_id`; Gruppe «Allgemein» implizit | Attribute einer Gruppe über der eigenen Freigabestufe fehlen in API, MCP, Reports, Export und sind nicht schreibbar; Oberfläche zeigt die Gruppe als Abschnitt mit Schloss |
| **Klassifizierung** | Wie 3.5, zusätzlich Stufe je Attributgruppe | Objekt-Policy (RLS) und Attribut-Maskierung (App) |

Kein separates Personen-Objekt: Das Attribut `user` (Principal) bleibt der Anker. Personen als EA-Objekte
(Rolleninhaber, Stellen) wären ein eigenes Vorhaben.

### 5.4 Stufen für andere Apps

| Stufe | App nutzt | Oberfläche zeigt |
|---|---|---|
| einfach | nur `org` mit 2–3 Rollen | Mitglieder, Meine Rechte |
| mittel | Kette `org → bereich → ding` | zusätzlich «Zugriff» an Bereichen |
| komplex (Assets) | Blatt-Freigaben, Zuständigkeit, Klassifizierung | alles |

Das Panel und die Endpunkte sind dieselben; die App deklariert nur mehr oder weniger `types`.

## 6. Was in den drei Repositories entsteht, ändert, entfällt

### 6.1 identity-kit

| Bereich | Entsteht | Ändert | Entfällt |
|---|---|---|---|
| `packages/iam/src` | `model.ts` (`defineModel`, Validierung, `toJSON`, `platformJson` nur Scopes); `tuples.ts` (Lesen/Schreiben, Ablauf); `subjects.ts` (Subjekte, Lesesicht-Einstellungen, Zuständigkeit via `edges`); `explain.ts`; `http/access.ts`; `http/break-glass.ts` | `access.ts` (Entscheidung ohne deny/restrict/exempt, Tupel statt ACL+Rollen), `catalog.ts` → in `model.ts` aufgehen, `resources.ts` (`edges`, kein `dbContext` mehr), `principal.ts` (keine Rollen aus Gruppen/Client-Rollen, `groups` nur noch Subjekte), `admin.ts` (Rollen = Tupel; Keycloak nur noch Mitgliedschaft), `http/admin.ts`, `http/clients.ts`, `http/account.ts`, `http/plugin.ts` (Session-Einstellungen), `migrations.ts` (`syncModelChecks`), `bootstrap.ts`, `sync.ts` (keine Rollengruppen) | `http/acl.ts`, `http/roles.ts`, `tenant_role`, `acl_entry`, `client_grant`, `ROLE_SOURCE`, `GROUP_ROLE_PREFIX` |
| `packages/iam/migrations` | `iam_015_tuples.sql`, `iam_016_clearance.sql` | Baseline neu (greenfield: Migrationen zusammenfassen zu `iam_001…`) | 004, 009, 012 (ACL, Rollen) |
| `packages/iam-web/src` | `access/AccessSheet.tsx`, `access/GrantDialog.tsx`, `access/WhyDialog.tsx`, `access/ClassificationBadge.tsx`, `access/BreakGlassBanner.tsx`, `access/api.ts` | `pages/Members.tsx` (Clients, Freigabestufe, Bereichsrollen), `rights/*` (Status `role \| scope \| place`), `session.tsx` (`somewhere`, `clearance`), `config.tsx` (`features.access`, `resources.open`), `routes.tsx`, `texts/*`, `contract.ts`, `testing/*` | `acl/*`, `pages/Access.tsx`, `AddEntry.tsx`, `Check.tsx`, `Roles.tsx`, `Clients.tsx`, `AclHint.tsx` |
| `packages/iam-testkit/src` | `model.ts` (Prüfung des Modells: Rollen je Ort, `access:admin`-Regel, Scopes), `access.ts` (Standardfälle: Rolle am Ort, Vererbung, Ablauf, Klassifizierung, Scope-Grenze, nie-mehr-als-ich) | `claims.ts` (keine Rollengruppen), `catalog.ts` → `model.ts`, `rls.ts` (Policies auf `authz_tuple`) | – |
| `modules/product-realm` | – | `clients.tf` (keine Client-Rollen, keine Gruppe `/orgs`, kein `groups`-Mapper für Rollen), `admin.tf` (keine Gruppenrechte), `variables.tf` (`catalog.scopes` bleibt, `catalog.roles` entfällt), Tests | – |
| `docs` | `authz-konzept.md` (dieses) | `spezifikation.md` Kap. 3.5, 3.7, 7, 8, 9, 10, 11, 12.1, 14; `neue-app.md` Schritte 3, 4, 7, 8 | – |
| `templates/create-iam-app` | Gerüst mit `authz/model.ts` einfachster Stufe | – | – |

### 6.2 assets

| Bereich | Entsteht | Ändert | Entfällt |
|---|---|---|---|
| `src/platform/authz` | `model.ts` (5.1) | `resources.ts` (Kette + `edges` für Zuständigkeit), `capabilities.ts` (+ `object.access`, `object.classify`, `view.access`, `report.access`) | `catalog.ts`, `permissions.ts` (geht in `model.ts` auf), `ROLES`-Export nach Keycloak |
| `db/migrations` | `classification` an `object` und `object_type`; `grants`, `inherits_scope` an `reference_type`; Policies neu (3.4) für `object`, `object_version`, `object_reference`, `object_comment*`, `object_attachment`, `report`, `dashboard*`, `saved_view*`; `authz_tuple` via Baukasten | greenfield: Migrationen neu nummerieren | `acl_entry`, `tenant_role`, `client_grant`, `shared`-Spalten |
| `src/platform/modules` | – | `catalog/objects.ts` (ohne `hiddenObjects`, `readable`, `visibility`; Klassifizierung setzen), `catalog/structure.ts` (ohne hidden-Zähler, Referenztyp-Felder), `reports/filter.ts`, `reports/index.ts`, `views/index.ts` (Sichtbarkeit über RLS statt `owner_id OR shared`), `integrations/visibility.ts`, `catalog/unique.ts`, `discussion/shared.ts`, `webhooks/events.ts` (`access.changed` statt `acl.changed`), `mcp/tools.ts` (unverändert, Rechte aus `/v1/me`) | – |
| `web/src` | `features/access/*` (App-Adapter für `AccessSheet`: Öffnen je Ressource), Feld und Badge Vertraulichkeit | `ObjectDrawer`, `RowMenus`, `TypeView`, `SchemaEditor` (Referenztyp-Sätze, Vorgabe-Stufe, Zugriff), `ConnectionView`, Credentials, `ViewBar` (SaveDialog), `DashboardView`, `ReportEditor`, `DashboardList`, `Rail.tsx`, `router.tsx`, `Audit.tsx` (Filter), `auth/*` | `auth/iam.tsx` (ACL-Ressourcenwahl), Routen `/verwalten/zugriff`, `/verwalten/rollen`, `/verwalten/maschinen-clients` |
| `scripts` | – | `keycloak-setup.ts` (keine Rollen/Gruppen), `seed:demo` (Tupel, eine Organisationseinheit, Klassifizierungen), `openapi-export.ts` | – |
| `test` | `access.test.ts` (Rolle am Ort, Zuständigkeit, Klassifizierung, Ablauf, Panel-Endpunkte, nie-mehr-als-ich), `break-glass.test.ts` | `rls.test.ts` (Allowlists), `tenant-isolation.test.ts` (neue Routen), `catalog.test.ts`, `graph.test.ts`, `reports.test.ts`, `views.test.ts`, `multi-org.test.ts`, `capabilities.test.ts`, `authz.test.ts`, `iam-catalog.test.ts`, E2E (Freigabe am Objekt, Zuständigkeit, Klassifizierung) | `acl-grants.test.ts`, `acl-write-path.test.ts`, `roles.test.ts`, `integrations-visibility.test.ts` (Teile) |
| `docs` | – | `zielarchitektur.md` (Abschnitt Rollen/Rechte/ACL neu, veraltete Tabellen raus), `oberflaeche.md` (Routen, Bereiche), `api.md`, `mcp.md`, `konzepte/rollen-und-rechte*.md` (als abgelöst markieren) | – |
| `infra/keycloak` | – | Modulaufruf ohne `catalog.roles`; `platform.json` nur Scopes | – |

### 6.3 identity

Keine Änderung. README-Satz: «Rechte der Apps liegen in der App-Datenbank (identity-kit); Keycloak hält nur Identität,
Organisationen, Clients und Scopes.»

## 7. Umsetzungsplan

Reihenfolge so, dass jeder Schritt für sich prüfbar ist (`npm run check` grün) und Assets erst umgestellt wird, wenn der
Baukasten steht. Grösse: S ≤ 1 Tag, M 2–3 Tage, L ≥ 4 Tage.

| # | Paket | Repo | Inhalt | Grösse | Abnahme |
|---|---|---|---|---|---|
| 0 | Spezifikation | identity-kit | Kap. 7–12, 14 nach diesem Konzept; `neue-app.md` | M | Review |
| 1 | Modell und Tupel | identity-kit/iam | `defineModel`, `authz_tuple`, `syncModelChecks`, `tuples.ts`, Ablauf-Aufräumen | M | Unit-Tests Modellvalidierung, Tupel-CRUD |
| 2 | Entscheidung | identity-kit/iam | `access.ts` neu (Kette, Subjekte, Zuständigkeit via `edges`, Klassifizierung, Scope), Session-Einstellungen in `plugin.ts`, `explain`, `whoHasAccess` | L | `access.test.ts` des Baukastens: alle Fälle aus 3.3 |
| 3 | Verwaltung | identity-kit/iam | `http/access.ts`, `admin.ts`/`http/admin.ts` (Rollen = Tupel, Clients in Mitgliedern, Freigabestufe), `http/break-glass.ts`, `/auth/me`, Audit-Aktionen; `acl`, `roles`, `client_grant` entfernen; `principal.ts` ohne Rollen aus Claims | L | `admin.test.ts`, `access-http.test.ts`, `tenant-isolation` des Kits |
| 4 | Realm-Modul | identity-kit/modules | Rollen, Gruppen, Mapper, FGAP-Gruppenrechte entfernen; Tests; `keycloak.sh` «No changes» | S | `modules.yml` grün |
| 5 | Testkit | identity-kit/iam-testkit | `model.ts`, `access.ts`, `claims.ts`, `rls.ts` anpassen | S | Kit-Tests grün |
| 6 | Oberfläche Baukasten | identity-kit/iam-web | `AccessSheet`, `GrantDialog`, `WhyDialog`, `ClassificationBadge`, `BreakGlassBanner`; `Members` neu; `rights/*`; alte Seiten entfernen; Texte de/en; vitest + Playwright + axe | L | Tests der Seiten, E2E gegen Testapp |
| 7 | Release | identity-kit | Versionen `iam 1.0.0`, `iam-web 1.0.0`, `iam-testkit 1.0.0`, Modul `v1.0.0` (Breaking) | S | `release.yml` |
| 8 | Assets Backend | assets | `authz/model.ts`, `resources.ts`, Migrationen (greenfield neu), Policies, `hidden*` entfernen, Views/Reports über Tupel, Klassifizierung setzen, Referenztyp-Felder, Webhook-Ereignis, Seed, keycloak-setup | L | `npm run check`; `rls`, `tenant-isolation`, `access`, `reports`, `graph`, `views`, `catalog` grün |
| 9 | Assets Oberfläche | assets | Adapter `features/access`, alle Stellen aus 5.2, Routen und Rail, Audit-Filter, Texte | L | Webapp-Tests, E2E (Freigabe am Objekt, Zuständigkeit, Klassifizierung, Break-Glass), axe |
| 9a | Standardschema «Organisation» | assets | Objekttyp Organisationseinheit, Referenz «übergeordnete Einheit», Attribute «Verantwortlich» und «Gehört zu» mit `grants`; Anlage beim Provisionieren einer Organisation; Seed | S | Test: neue Organisation hat das Schema; Zuständigkeit greift |
| 9b | Attributgruppen | assets | `attribute_group`, `group_id`, Stufe je Gruppe; Maskierung in Objekt-Antworten, MCP, Reports, Export; Schema-Editor (Gruppen anlegen, Attribute zuordnen, Stufe); Objekt-Drawer (Abschnitte, Schloss) | M | Tests Maskierung je Stufe, Schreibschutz, Oberfläche |
| 10 | Doku Assets | assets | `zielarchitektur.md`, `oberflaeche.md`, `api.md`, `mcp.md`, Konzepte ablösen, README-Formel | S | Review |
| 11 | identity | identity | README-Satz | S | – |

Abhängigkeiten: 1 → 2 → 3 → 6; 4 und 5 parallel zu 3; 8 nach 7; 9, 9a nach 8; 9b nach 9. Pakete 1–3 können in einem Branch von
`identity-kit` laufen, 8–9 in einem Branch von `assets`, der die lokal gepackten Pakete nutzt
(`scripts/local-registry.ts`).

Jedes Paket: eigener Commit je abgeschlossenem Teil, Tests im selben Commit, kein Paket beginnt vor grünem Vorgänger.

## 8. Inventar (Ist)

Kurzfassung der Analyse vom 2026-10-23; Details in den Dateien selbst.

| Thema | Ist |
|---|---|
| Entscheidung | `identity-kit/packages/iam/src/access.ts`: (Rolle ∨ grant) ∧ Scope ∧ kein deny/restrict; org-admin-Personen ausgenommen; Cache je `acl_version` + `ResourceModel.version` |
| Rollen | Keycloak-Gruppen `/orgs/<alias>/<rolle>` und Client-Rollen von `<p>-platform`; `principal.ts:rolesFromClaims`; eigene Rollen `c-*` in `tenant_role` |
| Freigaben | `acl_entry` (grant/restrict/deny, Principal user/group/role/client), `http/acl.ts`, Simulator `/v1/acl/effective` |
| Lesesicht | Session-Einstellungen `app.read_all`, `app.read_types`; RESTRICTIVE-Policies auf `object`, `object_version`, `object_reference`, Kommentare, Anhänge; Objekt-Verbote App-seitig (`hiddenObjects()`, 10+ Stellen) |
| Aufrufstellen in Assets | `req.need` 114, `req.needSomewhere` 39, `access.decide` 20, `access.can` 17, `capabilitiesFor` 10 – bleiben unverändert |
| Katalog Assets | 32 Rechte, 7 Rollen, 17 Scopes, 22 MCP-Werkzeuge, 6 Ressourcentypen |
| Datenmodell Assets | keine Organisationseinheiten, kein Eigentümer am Objekt, keine Attributgruppen, keine Klassifizierung; Referenzen = `ref`-Attribute mit `reference_type` (name/inverse_name); Personen = `principal`, Attributart `user` |
| Ansichten/Reports | `owner_id` + `shared` (boolean = ganze Organisation), kein Panel |
| Oberfläche | Kit-Seiten Mitglieder, Rollen, Zugriff (+AddEntry, Check), Maschinen-Clients, Organisationen, Entra; lokal `AclHint` an Schema und Verbindung, Share-Schalter an View/Dashboard/Report |
| Realm-Modul | Client-Rollen aus `var.catalog.roles`, Gruppe `/orgs`, Mapper `groups`, FGAP auf Users und Groups |
| Tests | Kit 31 Testdateien; Assets u. a. `acl-grants` 13, `acl-write-path` 6, `rls` 17, `tenant-isolation` 7, `catalog` 15, `graph` 5, `reports` 15, `roles` 7, `multi-org` 12 |
| identity | Compose: Caddy, Keycloak 26.8, PostgreSQL 17; kennt kein Produkt |

## 9. Bewusst nicht gebaut

| Nicht Teil des Vorhabens | Warum | Später möglich? |
|---|---|---|
| OpenFGA / SpiceDB | kein Gewinn bei List/Filter, zweite Wahrheit, Betrieb | ja, hinter derselben API, falls eine App Check-Last jenseits von Postgres braucht |
| Verbote, Beschränkungen, `blocked` | brechen «Wer hat Zugriff?» und die Lesesicht; Klassifizierung und Zuständigkeit decken die Fälle | nein, bewusst |
| Eigene Rollen der Organisation | «Rolle am Ort» + Freigaben ersetzen den Bedarf; Rollensatz bleibt klein (E4) | ja, als App-Modellerweiterung |
| Personen als EA-Objekte (Stellen, Rolleninhaber) | Attribut `user` bleibt der Anker | ja |
| Folgen-Vorschau beim Ändern («12 mehr, 30 weniger») | teuer (Vorher/Nachher-Mengen), UX-Nutzen erst mit Zuständigkeit im Alltag belegt | ja, Panel zeigt Folgen nachher |
| Zugriff anfragen, Genehmigung, Rezertifizierung, verborgene Nachbarn im Graph | Workflow-Produkt für sich; verborgene Platzhalter geben Existenz preis | ja |
| SCIM | Keycloak 26 ohne SCIM-Server; Entra-Gruppen kommen über den IdP-Mapper | – |
| Maschinen-Clients in der App anlegen | unverändert Kap. 12.1 (Keycloak-Konsole nach Vorlage) | – |
| Neue Rechte, neue Scopes, neue MCP-Werkzeuge | Rechte- und Scope-Katalog von Assets bleibt wie heute | – |
