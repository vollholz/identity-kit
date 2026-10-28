# Changelog `@vollholz/create-iam-app`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `create-iam-app-v<version>`.

## [Unveröffentlicht]

## [0.5.5] – 2026-10-28

### Geändert

- Neue Apps mit `@vollholz/iam` 5.0.3 und `@vollholz/iam-testkit` 2.4.5.

## [0.5.4] – 2026-10-28

### Geändert

- Neue Apps mit `@vollholz/iam` 5.0.2 und `@vollholz/iam-testkit` 2.4.4.

## [0.5.3] – 2026-10-28

### Geändert

- Neue Apps mit `@vollholz/iam` 5.0.1 und `@vollholz/iam-testkit` 2.4.3.

## [0.5.2] – 2026-10-28

### Geändert

- Neue Apps mit `@vollholz/iam-testkit` 2.4.2 (`CURRENT` mit `@vollholz/platform` 0.6.2).

## [0.5.1] – 2026-10-28

### Geändert

- Neue Apps mit `@vollholz/iam-testkit` 2.4.1 (`CURRENT` mit `@vollholz/platform` 0.6.1).

## [0.5.0] – 2026-10-28

### Hinzugefügt

- **`--operator-defaults <datei|url>`** für `init`: Vorgaben des Betreibers (Format `OperatorDefaultsSchema` des
  Test-Kits) ergeben im neuen Manifest `realm.smtp` (mit `fromDisplayName` = displayName der App), `realm.theme` und
  `realm.themeTexts` = `infra/keycloak/theme-texts.json`; die Datei (Datei der App, nur angelegt, wenn sie fehlt) enthält
  die Texte des Themes je Sprache der App aus der Vorlage des Betreibers (Platzhalter ersetzt) oder ein Grundgerüst
  (`themeClaim`, `themeMailFooter`; weitere Schlüssel nach dem Theme ergänzen). URL nur https; mit `GITHUB_TOKEN` als Bearer nur an
  `raw.githubusercontent.com` und `api.github.com` (privates Repository des Betreibers), dann ohne Weiterleitung. Ungültige Vorgaben: Abbruch mit Befund, nichts angelegt.
- Bestehendes Manifest (`init`, `sync`, `check`): nie geändert, nur **Hinweise** – `realm.smtp` fehlt, mit
  `--operator-defaults` auch Abweichungen von den Vorgaben (smtp, theme, themeTexts).
- «Nächste Schritte» nach `init` nennen den Stand von `realm.smtp` und das Secret `SMTP_PASSWORD`.
- `loadOperatorDefaults`, `realmFromOperator`, `themeTextsFile`, `operatorHints`, `THEME_TEXTS_FILE`; `InitOptions.operatorDefaults`,
  `appFiles(dir, m, operatorDefaults)`.

### Geändert

- Neue Apps erhalten `@vollholz/iam-testkit` 2.4.0. Bestehende Apps: keine Schritte (Vorgaben nachträglich von Hand
  übernehmen, die Hinweise von `sync --operator-defaults …` nennen die Werte).

## [0.4.0] – 2026-10-28

### Geändert

- Neue Apps erhalten `@vollholz/iam` 5.0.0 und `@vollholz/iam-testkit` 2.3.0 (aus `CURRENT` des Test-Kits); keine
  Änderung an Vorlagen. Bestehende Apps: keine Schritte.

## [0.3.0] – 2026-10-28

### Geändert

- Neue Apps erhalten `@vollholz/iam` 4.0.0 und `@vollholz/iam-testkit` 2.2.0 (aus `CURRENT` des Test-Kits); keine
  Änderung an Vorlagen. Bestehende Apps: keine Schritte (`sync` ändert nichts an den Versionen der App).

## [0.2.3] – 2026-10-27

Stand bis 0.2.3, ohne Einzelnachweis. Frühere Versionen: Tags `create-iam-app-v*` und Hinweise im README des Pakets.
