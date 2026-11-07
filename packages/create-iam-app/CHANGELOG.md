# Changelog `@vollholz/create-iam-app`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `create-iam-app-v<version>`.

## [Unveröffentlicht]

## [0.9.0] – 2026-11-07

### Hinzugefügt

- Manifest: `organizations[].package` (Paket des Modells für die erste Belegung der Organisation; Schema aus
  `@vollholz/iam-testkit` 2.9.3). `npm run identity:first-org` (`iam-org-bootstrap --manifest`, `@vollholz/iam` 6.2)
  übergibt es; der Konformitätstest prüft, dass das Paket im Modell steht. Die verwaltete Datei
  `docs/identity-kit.md` beschreibt das Feld und die Reihenfolge mit dem Befehl der App.

### Geändert

- Vorlagen für `@vollholz/iam` 6.2.0 und `@vollholz/iam-testkit` 2.9.3 (Konformität mit den Produktmodulen aus
  `@vollholz/iam` 6.1); bestehende Apps heben die Pakete an und schreiben die verwalteten Dateien mit
  `npx @vollholz/create-iam-app@0.9.0 sync` neu.

## [0.8.0] – 2026-11-05

### Geändert

- Vorlagen für `@vollholz/iam` 6.0.0 und `@vollholz/iam-testkit` 2.8.0: `init` erzeugt diese Versionen; bestehende Apps
  heben `@vollholz/iam`, `@vollholz/iam-web` (3.0.0) und `@vollholz/platform` (0.8.0) gemeinsam an und schreiben die
  verwalteten Dateien mit `npx @vollholz/create-iam-app@0.8.0 sync` neu.

## [0.7.0] – 2026-11-04

### Hinzugefügt

- `realm.frontendUrl` aus dem Manifest geht an `product-realm` 3.1.0 (`frontend_url`): eigene Domain des Realms
  (Spezifikation 2.2). Vorlagen für `product-realm` 3.1.0 und `@vollholz/iam-testkit` 2.7.0; bestehende Apps:
  `npx @vollholz/create-iam-app@0.7.0 sync`.

## [0.6.0] – 2026-11-04

### Breaking

- Kein Bootstrap mehr: Realm, `<produkt>-iac` und `realm-admin` legt der Betreiber der Keycloak-Instanz an
  (Spezifikation Kap. 2). `infra/keycloak/bootstrap/main.tf` entfällt (`sync` löscht die Datei, wenn sie unverändert
  ist), `kc.sh bootstrap` und `KEYCLOAK_TF_PRIVATE_KEY_B64` ebenso; `keys` erzeugt keinen Schlüssel für `<produkt>-tofu`
  mehr. Bestehende Apps: State von `infra/keycloak/bootstrap` aufgeben (nichts in Keycloak löschen), privaten Schlüssel
  von `<produkt>-tofu` löschen.

### Hinzugefügt

- `keys` gibt am Ende den Eintrag für den Betreiber aus: öffentlicher Schlüssel von `<produkt>-iac`, Name für seine
  Liste der Produkte, `kid` zum Bestätigen über einen zweiten Kanal. `docs/identity-kit.md` beschreibt die Aufteilung.

### Geändert

- Vorlagen für `product-realm` 3.0.0 (Service Accounts ohne `manage-realm`, braucht Keycloak 26.8; Umstieg im README
  des Moduls) und `@vollholz/iam-testkit` 2.6.0. Bestehende Apps: `npx @vollholz/create-iam-app@0.6.0 sync`, dann
  `kc.sh init -upgrade` und den Plan prüfen.

## [0.5.7] – 2026-11-04

### Geändert

- Neue Apps mit `@vollholz/iam-testkit` 2.5.1.

## [0.5.6] – 2026-10-28

### Geändert

- Neue Apps mit `@vollholz/iam-testkit` 2.5.0.

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
