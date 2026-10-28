# Changelog `@vollholz/iam-testkit`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `iam-testkit-v<version>`.

## [Unveröffentlicht]

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
