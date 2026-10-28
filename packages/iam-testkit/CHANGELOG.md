# Changelog `@vollholz/iam-testkit`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `iam-testkit-v<version>`.

## [Unveröffentlicht]

## [2.2.0] – 2026-10-28

### Geändert

- `CURRENT` nennt `@vollholz/iam` 4.0.0, `@vollholz/platform` 0.5.0 und `@vollholz/create-iam-app` 0.3.0.
- Fenster der unterstützten Versionen rückt mit der neuen Hauptversion nach (Spezifikation 15.5): `MINIMUM` für
  `@vollholz/iam` ist 3.0.0. Eine App auf `@vollholz/iam` 2.x meldet der Konformitätstest als Fehler.
  Migration (nur Apps auf 2.x): auf `@vollholz/iam` 4.0.0 anheben (Hinweise in docs/ausrollen.md).

## [2.1.3] – 2026-10-27

Stand bis 2.1.3, ohne Einzelnachweis. Frühere Versionen: Tags `iam-testkit-v*` und Hinweise im README des Pakets.
