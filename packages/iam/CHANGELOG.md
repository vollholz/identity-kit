# Changelog `@vollholz/iam`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `iam-v<version>`.

## [Unveröffentlicht]

## [5.0.2] – 2026-10-28

### Behoben

- `Nullable` (seit 5.0.1) mit `Value.Check`, `Value.Errors` und dem TypeCompiler von TypeBox: Der Zweig `{ const: null }`
  hatte die Kind «Unsafe», TypeBox warf «Unknown type» (in einer App mit `Value.Check` auf ein Schema mit `Nullable`:
  500). Neu eigene Kind `NullExakt` in der TypeRegistry (prüft `=== null`); TypeBox liefert für jede Eingabe dasselbe
  Ergebnis wie AJV (ohne Umwandlung) und wie vor 5.0.1. OpenAPI unverändert. Voraussetzung: die App
  benutzt dieselbe Kopie von `@sinclair/typebox` wie dieses Paket (0.34.52; `npm ls @sinclair/typebox`), sonst kennt
  ihre TypeRegistry die Kind nicht.

## [5.0.1] – 2026-10-28

### Behoben

- `Nullable(X)` mit `coerceTypes` (Standard von Fastify, auch in `@vollholz/platform`): `anyOf [X, null]` machte aus
  `null` den Wert von X, wenn er dort gültig ist (0, `""`, `false`). Neu `anyOf [{ const: null }, X, { type: 'null' }]`
  wie in `@vollholz/platform` 0.6.2: `null` bleibt `null`, alle anderen Eingaben wie bisher. In den Routen des Pakets
  war der Fehler nicht sichtbar (Uuid und Datum lehnen `""` ab; die Beschreibung der Organisation wird mit `null` ohnehin
  geleert); betroffen waren eigene Routen der App mit `Nullable` aus diesem Paket.

### Geändert

- OpenAPI: Jedes `Nullable` hat vorne einen Zweig `{ "enum": [null] }` (aus `const: null`). Aus der Doku erzeugte
  Typen bleiben `X | null` (openapi-typescript).

## [5.0.0] – 2026-10-28

### Breaking

- **Eigene Rollen der Organisation sind Standard** (`features.customRoles`, Standard true mit `features.members`): Das
  Modell erhält das reservierte Recht **`roles:admin`** «Rollen zusammenstellen» (Gruppe `members`, nur Personen, ohne
  Rolle der App nur bei org-admin). Kataloge, `adminOnly` und Rechte von org-admin ändern sich dadurch.
  Migration: Tests der App, die Rechtelisten von org-admin, `adminOnly` oder den Katalog genau vergleichen, um
  `roles:admin` ergänzen – oder eigene Rollen mit `features: { customRoles: false }` in `defineModel` abschalten (dann
  ändert sich nichts ausser der Migration `iam_019`).
- **Migration `iam_019_custom_roles.sql`** (läuft mit dem nächsten `migrate`): Tabelle `<schema>.authz_role` (RLS ENABLE
  + FORCE, `tenant_isolation`, Policy `owner_tenant` für die Besitzer-Rolle), Trigger `authz_role_guard`,
  `authz_role_acl_version` und `authz_tuple_custom_role`.
  Migration: Prüfungen der App, die alle Tabellen bzw. Policies aufzählen (RLS-Matrix), um `authz_role` (Tabelle des
  Baukastens) und `authz_role.owner_tenant` ergänzen.
- **CHECK `authz_tuple_relation_check`** lässt mit eigenen Rollen zusätzlich Relationen `c-…` zu und trägt wie
  `authz_tuple_type_relation_check` eine Marke im Kommentar (`syncModelChecks` passt beide beim nächsten Lauf an).
  Migration: Tests, die die Definition des CHECKs mit `pg_get_constraintdef` vergleichen, auf die Relationen prüfen.
- **Neues Modul `roles`** mit den Routen `GET/POST /v1/admin/roles`, `PUT/DELETE /v1/admin/roles/{key}` und denselben unter
  `/v1/platform/organizations/{alias}/roles` (Standard geladen, wenn eigene Rollen an sind).
  Migration: im Isolations-Durchlauf der App (`coverageProblems`) aufnehmen oder ausnehmen; wer `modules` ausdrücklich
  angibt, ergänzt `'roles'`, um sie anzubieten.
- **Rollen des Modells mit Schlüssel `c-…`** sind ein Fehler im Modell (`ModelError`, der Präfix gehört eigenen Rollen).
  Migration: solche Rollen umbenennen (Tupel mit Migration nachführen).
- **`TenantAccess`** hat die Felder `model` (Modell der Organisation) und `roles` (eigene Rollen).
  Migration: nur Tests, die `TenantAccess` von Hand bauen: `model: <modell>, roles: []` ergänzen.

### Hinzugefügt

- **Rollen zur Laufzeit** (docs/authz-offene-punkte.md O17, PPM UC-016 A2): `model.withRoles(defs)` (Modell der
  Organisation), `model.customRoleProblems(def)`, `CUSTOM_ROLE_KEY`, `CUSTOM_ROLE_LIMIT` (50), Typ `CustomRoleDef`;
  `iam.roles` (`CustomRoles`: `list`, `get`, `create`, `update`, `remove`), `customRoleKey(label)`,
  `loadCustomRoles(tx, schema)`, `access.modelOf(tenantId)`, `access.modelIn(tx)`.
- Entscheidung, Lesesicht (RLS), «Wer hat Zugriff?», «Warum?», Rollen setzen, Einladen, Freigaben an Orten und Clients
  lösen eigene Rollen wie Rollen des Modells auf. `GET /v1/authz/catalog` liefert in einer Organisation ihre eigenen
  Rollen mit (`custom: true`, nach den Rollen des Modells, in `types[].roles` an ihren Orten); `GET /v1/admin/status`
  ebenso.
- Regeln: nur Rechte des Modells, keine nur von org-admin (422); niemand gibt mehr, als er hat (403 `exceeds-own`, beim
  Ändern vorher und nachher); Name eindeutig (409 `duplicate-label`); höchstens 50 (409 `limit`); löschen und Orte
  entfernen nur unvergeben (409 `in-use`, auch per Trigger in der Datenbank); Audit `role.created`, `role.updated`,
  `role.deleted` (`data.key`). Vergaben melden die Haken wie jede Rolle (`access.granted`, `access.revoked`).
- Gleichzeitiges Vergeben und Löschen bzw. Orte entfernen: Der Trigger `authz_tuple_custom_role` sperrt die Zeile der
  Rolle (`FOR SHARE`), das Löschen wartet und lehnt dann ab (`in-use`); ein Schlüssel, unter dem noch Vergaben ohne
  Rolle stehen, wird nicht neu vergeben (409 `in-use`). So erbt nie jemand ungeprüft die Rechte einer neuen Rolle.
- `checkRoles(…, model)`, `checkRoleChange(…, model)`, `TupleStore.check(t, model)`, `TupleStore.modelFor(tx, relation)`:
  optionales Modell der Organisation.

### Geändert

- Eigene Rollen wieder abschalten (`customRoles: false`, nachdem es schon Vergaben gab): zuerst alle Tupel mit
  Relation `c-…` löschen, sonst bricht `syncModelChecks` beim nächsten `migrate` ab (wie bei entfernten Rollen).
- Eine eigene Rolle überschreibt nie eine Rolle des Modells (Schlüssel immer `c-…`); ändert sich das Modell, fallen
  Rechte und Orte, die es nicht mehr gibt oder die nur org-admin hat, aus eigenen Rollen weg (nie mehr Rechte).

## [4.0.0] – 2026-10-28

### Breaking

- **`IamEvents` ist ein Objekt mit zwei Haken** statt einer Funktion: `events: { before?(tx, e), after?(tx, e) }` in
  `createIam` (bisher `(tx, type, subject, data) => Promise<void>`, vom Paket nie aufgerufen). Jedes Ereignis
  `e = { type, tenantId, subject, actor, data }`.
  Migration: Wer `events` übergab, schreibt `events: { after: async (tx, e) => alt(tx, e.type, e.subject, e.data) }`
  oder lässt die Option weg. Typen `IamEvent`, `IamEventMap`, `IamEventType`, `AccessEventData`, `MemberEventData`,
  `MemberLeftEventData` aus `@vollholz/iam`.
- **`after` erhält jetzt Ereignisse** (bisher keine): je Rolle an einem Ort `access.granted` (auch neuer Ablauf, mit
  `previousExpiresAt`), `access.revoked` und `access.expired`, auch für Rollen an `org` aus «Rollen setzen», Einladen,
  Clients und für Aufrufe der App über `iam.tuples` (ohne `actor`: `principal: null`, `source: 'system'`); dazu
  `member.removed` und `member.left`.
  Migration: Erzeugt die App `access.changed` selbst (offener Punkt O10), diese Stellen entfernen oder aus `after`
  bilden, sonst doppelt. Wer `after` an eine Outbox hängt, filtert nach `e.type`.
- **`TupleStore`-Methoden** nehmen `TupleActor` (`Actor` mit `extra` und `audit?: false`); `audit: false` meldet das
  Ereignis ohne Audit je Tupel. Aufrufe mit `actor` wie bisher bleiben gültig.
  Migration: nur wer `new TupleStore(…)` selbst baut und Ereignisse will, gibt `events` mit.

### Hinzugefügt

- **Haken beim Entfernen eines Mitglieds** (`AdminService.removeMember`, damit `DELETE /v1/admin/members/{id}`,
  `DELETE /v1/platform/organizations/{alias}/members/{id}`, «Benutzer und Rollen» in `@vollholz/iam-web` und Aufrufe der
  App über `iam.admin`): `before` mit `member.removing` nach den Prüfungen des Pakets, unter der Sperre der
  Organisation und vor jeder Änderung in Keycloak; wirft er, unterbleibt das Entfernen, ein `HttpError` (z. B.
  `conflict(detail, { reason })`) geht als application/problem+json mit allen Zusatzfeldern zurück. `after` mit
  `member.removed` (vorher je Tupel `access.revoked`) in derselben Transaktion; wirft er, wird zurückgerollt, die in
  Keycloak entfernte Mitgliedschaft bleibt und steht als `member.remove_failed` im Audit. Daten `MemberEventData`:
  `memberId`, `userId`, `principalId`, `email`, `roles`, `invitation`, `platform`. Gilt auch für das Zurückziehen
  einer Einladung (`invitation: true`).
- **Abgleich und Aufräumen melden** `member.left` (Austritt ausserhalb der App, Tupel bleiben) und `access.expired`:
  `MemberSync(…, { events })`, `SyncContext.events`.
- `setOrgRoles(…, { actor })`: wer handelt, für die Ereignisse (kein Audit je Tupel).
- `migrate(adminUrl, sources, { log, ssl })`: TLS nach `DATABASE_SSL` (`MigrateOptions`); die bisherige Form mit `log`
  als drittem Argument gilt weiter. `pgSsl(mode)`, `dbSslFromEnv(env)`, `DB_SSL_MODES`, Typ `DbSsl`.
- `orgBootstrap`/`orgBootstrapFile` (`database.ssl`) und `resetDatabase` (`ssl`) mit TLS.

### Behoben

- `migrate` öffnete `pg.Client` nur mit der Adresse: Eine Datenbank, die nur `hostssl` zulässt, lehnte ab. Jetzt TLS
  wie die übrigen Verbindungen; ein `sslmode` in der Adresse hat weiterhin Vorrang.
- `iam-org-bootstrap` und `iam-reset` halten `DATABASE_SSL` ein (bisher ohne TLS). Hinweis: Mit `verify-full` muss das
  Zertifikat der Datenbank prüfbar sein (wie für API und Worker).
- Beschreibung von `DELETE …/members/{id}` in der OpenAPI nennt die mögliche Ablehnung durch die App.

## [3.2.1] – 2026-10-27

Stand bis 3.2.1, ohne Einzelnachweis. Frühere Versionen: Tags `iam-v*` und Hinweise im README des Pakets und in docs/ausrollen.md.
