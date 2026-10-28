# Changelog `@vollholz/platform`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `platform-v<version>`.

## [Unveröffentlicht]

## [0.6.1] – 2026-10-28

### Behoben

- Start der API wuchs mit Routen × gemeinsamen Schemas (`app.addSchema`): Fastify baut je Route den Antwort-Serialisierer,
  und fast-json-stringify prüfte dabei jedes Mal alle gemeinsamen Schemas neu (in Apps mit vielen Modulen 30 bis 80 s
  bis «Server listening», `/readyz` so lange 503; auch jeder `testApi()` zahlte das). `fastifyOptions` setzt jetzt
  `schemaController.compilersFactory.buildSerializer`: Der erste Serialisierer prüft alle gemeinsamen Schemas wie
  bisher, jeder weitere bekommt nur die Schemas, auf die er über `$ref` (auch mittelbar) verweist; lässt sich ein
  Verweis nicht eindeutig zuordnen, alle wie bisher. Gleicher erzeugter Code, gleiche Antworten und Filterung
  (`additionalProperties`), gleiche Fehler bei ungültigen Schemas. Messung: 100 gemeinsame Schemas und 400 Routen
  19,8 s → 1,8 s; Test-App des Pakets (81 Routen, 19 Schemas) `testApi()` 2,4 s → 1,3 s. Für die App nichts zu tun.

## [0.6.0] – 2026-10-28

### Breaking

- Setzt `@vollholz/iam` 5.0.0 voraus (Peer `^5.0.0`).
  Migration: `@vollholz/iam` auf 5.0.0 anheben und dessen Breaking-Schritte umsetzen (Recht `roles:admin`, Migration
  `iam_019`, Modul `roles`). Eigene Rollen schaltet die App im Modell ab (`definePlatform` mit
  `defineModel({ …, features: { customRoles: false } })`).

## [0.5.0] – 2026-10-28

### Breaking

- Setzt `@vollholz/iam` 4.0.0 voraus (Peer `^4.0.0`).
  Migration: `@vollholz/iam` auf 4.0.0 anheben und dessen Breaking-Schritte umsetzen (`events` als Objekt).

### Hinzugefügt

- `AppSpec.iamEvents`: Haken der App an den Baukasten (`events` von `@vollholz/iam`: `member.removing` darf das
  Entfernen ablehnen, `member.removed`, `access.granted`, `access.revoked`, `access.expired`, `member.left`).
  `defineApp` gibt sie an `createIam` der API, an die Verwaltung im Worker (`JobContext.admin`) und an den Abgleich
  (`MemberSync`); `PlatformApp.iamEvents`. Outbox: `` after: (tx, e) => platform.emit(tx, `iam.${e.type}`, e.subject, e.data) ``.
- `startMemberSync(…, events)`, `RunMigrationsOptions.ssl`, `PlatformApp.migrate(adminUrl, { log, ssl })` (die Form mit
  `log` als Funktion gilt weiter).

### Behoben

- Befehle `migrate`, `tenant` und `rotate-keys` (`runCli`) verbinden mit TLS nach `DATABASE_SSL` (bzw.
  `DATABASE_SSL_FILE`) wie API und Worker; bisher ohne TLS, eine Datenbank nur mit `hostssl` lehnte ab. Ungültiger Wert:
  Exit 78. Hinweis: Mit `verify-full` muss das Zertifikat prüfbar sein.

## [0.4.0] – 2026-10-27

Stand bis 0.4.0, ohne Einzelnachweis. Frühere Versionen: Tags `platform-v*` und Hinweise im README des Pakets.
