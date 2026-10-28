# Changelog `@vollholz/iam`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `iam-v<version>`.

## [Unveröffentlicht]

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
