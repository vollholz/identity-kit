# Changelog `@vollholz/iam-testkit`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `iam-testkit-v<version>`.

## [2.9.3] – 2026-11-07

### Hinzugefügt

- Manifest `identity.app.json`: `organizations[].package` (optional, Schlüssel eines Pakets aus `packages` des Modells;
  `schema/identity-app.schema.json`). `iam-org-bootstrap --manifest` (`@vollholz/iam` 6.2) übergibt es beim Anlegen.
- Konformitätstest (Repository, mit Modell): jedes `organizations[].package` existiert in `model.packages`; sonst
  Fehler `/organizations/<i>/package: Paket «…» nicht im Modell (bekannt: …)` in «Modell nach den Regeln M1–M13».
  Funktion `manifestPackageErrors(manifest, paketschlüssel)` für eigene Werkzeuge.

### Geändert

- Kennt `@vollholz/iam` 6.2.0, `@vollholz/iam-testkit` 2.9.3 und `@vollholz/create-iam-app` 0.9.0 (`CURRENT`).

## [2.9.2] – 2026-11-07

### Geändert

- Kennt `@vollholz/iam-web` 3.1.0 und `@vollholz/iam-testkit` 2.9.2 (`CURRENT`). Ändert für Apps nichts: Der
  Konformitätstest vergleicht Hauptversionen und Mindeststände, beide bleiben gleich.

## [2.9.1] – 2026-11-07

### Geändert

- Kennt `@vollholz/platform` 0.9.0 und `@vollholz/iam-testkit` 2.9.1 (`CURRENT`). Ändert für Apps nichts: Der
  Konformitätstest vergleicht Hauptversionen und Mindeststände, beide bleiben gleich.

## [2.9.0] – 2026-11-07

### Hinzugefügt

- Konformitätstest (Datenbank): kennt die SECURITY-DEFINER-Funktionen der Produktmodule aus `@vollholz/iam` 6.1
  (`app.set_module_allowed`, `app.set_module_active`, `app.backfill_modules`, Migration `iam_022_tenant_module.sql`).
  Ältere Test-Kits melden sie bei einer App mit `iam` 6.1 als «SECURITY DEFINER ohne Begründung».

### Geändert

- Kennt `@vollholz/iam` 6.1.0 und `@vollholz/iam-testkit` 2.9.0 (`CURRENT`).
- Kennt `@vollholz/iam-web` 3.0.1 (`CURRENT`). Ändert für Apps nichts: Der Konformitätstest vergleicht Hauptversionen
  und Mindeststände, beide bleiben gleich.

## [2.8.0] – 2026-11-05

### Geändert

- Kennt `@vollholz/iam` 6.0.0, `@vollholz/iam-web` 3.0.0, `@vollholz/platform` 0.8.0 und `@vollholz/create-iam-app`
  0.8.0 (`CURRENT`). Eine App mit `iam` 6 meldet der Konformitätstest damit nicht mehr als «neuer als die
  Hauptversion». Das Mindestfenster (`MINIMUM`) bleibt unverändert.

## [2.7.0] – 2026-11-04

### Hinzugefügt

- Manifest: `realm.frontendUrl` – eigene Domain des Realms (Spezifikation 2.2). Kennt `product-realm` 3.1.0 (`CURRENT`).

## [2.6.0] – 2026-11-04

### Geändert

- Kennt `product-realm` 3.0.0 (`CURRENT`): Service Accounts ohne `manage-realm`, braucht Keycloak 26.8. Unterstützt
  bleiben `product-realm` 2.x und 3.x.
- Konformität (Repository): `product-realm-bootstrap` ist nicht mehr Pflicht – Realm und `<produkt>-iac` legt der
  Betreiber an (Spezifikation Kap. 2). Ist das Modul noch eingebunden, gilt weiter das Fenster der Versionen.

## [2.5.1] – 2026-11-04

### Behoben

- Mock-IdP (`startMockIdp`) antwortet ohne Keep-alive (`Connection: close`). Bisher konnte der erste Abruf der
  Discovery einer neu gebauten App gelegentlich mit `ECONNRESET` und 503 «Anmeldedienst nicht erreichbar» scheitern:
  fetch nahm eine Verbindung wieder auf, die der Server nach 5 s Leerlauf gerade schloss, weil die Ereignisschleife
  (z. B. beim Kompilieren der Routen-Schemas unter Last) länger blockiert war.

### Geändert

- `CURRENT` nennt `@vollholz/iam-testkit` 2.5.1 und `@vollholz/create-iam-app` 0.5.7.

## [2.5.0] – 2026-10-28

### Hinzugefügt

- Datenbank-Tests sichtbar überspringen: `postgresSkip(env?)` (eigenständig) und `testDatabases(…).dbSkip()` liefern
  `false` mit erreichbarer Datenbank, ohne Konfiguration (`TEST_POSTGRES_URL` bzw. `POSTGRES_SUPERUSER_PASSWORD`) den
  Grund `NO_POSTGRES`; konfiguriert, aber nicht erreichbar, werfen sie einen Fehler mit Variable und Adresse
  (`dbSkip` auch, wenn `DATABASE_URL` oder `DATABASE_ADMIN_URL` fehlt). `superuserUrlFrom(env?)`.
- `dbTests(skip)`: `describe`, `test`, `it` und Hooks, mit denen jeder Datenbank-Test einzeln als übersprungen zählt
  (mit Grund) und die Hooks ohne Datenbank nicht laufen. Grund: `describe(…, { skip })` von node:test zählt die Tests
  darin nicht, ein Lauf ohne Datenbank war «grün» mit weniger Tests und «skipped 0».
  Migration (empfohlen): in Testdateien mit Datenbank `import { describe, test, before, after } from 'node:test'`
  ersetzen durch `const { describe, test, before, after } = dbTests(await postgresSkip())` (oder `dbs.dbSkip()`) und
  `{ skip }` an `describe` weglassen. `dbAvailable()` bleibt unverändert.

### Geändert

- `CURRENT` nennt `@vollholz/iam-testkit` 2.5.0 und `@vollholz/create-iam-app` 0.5.6.

## [2.4.5] – 2026-10-28

### Geändert

- `CURRENT` nennt `@vollholz/iam` 5.0.3, `@vollholz/platform` 0.7.0, `@vollholz/iam-testkit` 2.4.5 und
  `@vollholz/create-iam-app` 0.5.5.

## [2.4.4] – 2026-10-28

### Geändert

- `CURRENT` nennt `@vollholz/iam` 5.0.2, `@vollholz/platform` 0.6.3, `@vollholz/iam-testkit` 2.4.4 und
  `@vollholz/create-iam-app` 0.5.4.

## [2.4.3] – 2026-10-28

### Geändert

- `CURRENT` nennt `@vollholz/iam` 5.0.1, `@vollholz/iam-testkit` 2.4.3 und `@vollholz/create-iam-app` 0.5.3.

## [2.4.2] – 2026-10-28

### Geändert

- `CURRENT` nennt `@vollholz/platform` 0.6.2, `@vollholz/iam-testkit` 2.4.2 und `@vollholz/create-iam-app` 0.5.2.

## [2.4.1] – 2026-10-28

### Geändert

- `CURRENT` nennt `@vollholz/platform` 0.6.1, `@vollholz/iam-testkit` 2.4.1 und `@vollholz/create-iam-app` 0.5.1.

## [2.4.0] – 2026-10-28

### Hinzugefügt

- Format der **Vorgaben des Betreibers** (`OperatorDefaultsSchema`, `operatorDefaultsErrors`, `themeTextsFor`,
  `THEME_TEXT_KEY`, `THEME_TEXT_VARS`, Typ `OperatorDefaults`) und JSON Schema
  `@vollholz/iam-testkit/schema/operator-defaults.schema.json`: `smtp` (host, port, starttls, ssl, from, replyTo, user;
  nie ein Passwort), `theme`, `themeTexts` je Sprache mit Platzhaltern `{displayName}`, `{product}`, `{publicBaseUrl}`.
- Konformitätstest: Prüfung «E-Mail-Versand des Realms» (Ebene Repository) warnt, wenn `realm.smtp` fehlt (ohne SMTP
  keine Einladung «Passwort festlegen»). Nur eine Warnung, kein Fehler; mit `--strict` zählt sie wie jede Warnung.

### Geändert

- `CURRENT` nennt `@vollholz/iam-testkit` 2.4.0 und `@vollholz/create-iam-app` 0.5.0.

## [2.3.0] – 2026-10-28

### Geändert

- `CURRENT` nennt `@vollholz/iam` 5.0.0, `@vollholz/iam-web` 2.2.0, `@vollholz/platform` 0.6.0 und
  `@vollholz/create-iam-app` 0.4.0.
- Fenster der unterstützten Versionen rückt nach (Spezifikation 15.5): `MINIMUM` für `@vollholz/iam` ist 4.0.0.
  Migration (nur Apps auf `@vollholz/iam` 3.x): auf 4.0.0 oder 5.0.0 anheben (docs/ausrollen.md).

## [2.2.0] – 2026-10-28

### Geändert

- `CURRENT` nennt `@vollholz/iam` 4.0.0, `@vollholz/platform` 0.5.0 und `@vollholz/create-iam-app` 0.3.0.
- Fenster der unterstützten Versionen rückt mit der neuen Hauptversion nach (Spezifikation 15.5): `MINIMUM` für
  `@vollholz/iam` ist 3.0.0. Eine App auf `@vollholz/iam` 2.x meldet der Konformitätstest als Fehler.
  Migration (nur Apps auf 2.x): auf `@vollholz/iam` 4.0.0 anheben (Hinweise in docs/ausrollen.md).

## [2.1.3] – 2026-10-27

Stand bis 2.1.3, ohne Einzelnachweis. Frühere Versionen: Tags `iam-testkit-v*` und Hinweise im README des Pakets.
