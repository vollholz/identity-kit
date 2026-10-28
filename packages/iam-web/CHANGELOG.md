# Changelog `@vollholz/iam-web`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `iam-web-v<version>`.

## [Unveröffentlicht]

## [2.2.0] – 2026-10-28

### Hinzugefügt

- **Seite «Rollen»** (`paths.roles`, Standard `/verwalten/rollen`; Route `roles` in `iamRoutes`, Recht `roles:admin`):
  eigene Rollen der Organisation aus den Rechten der App zusammenstellen, ändern und löschen. Rechte je Gruppe (Rechte
  nur von «Organisations-Admin» fehlen, Rechte, die man selbst nicht hat, sind gesperrt mit Grund), Orte, an denen die
  Rolle vergeben werden darf, Zahl der Vergaben, Löschen erst unvergeben; Rollen der App als Vorgabe. `RolesPage`
  (`alias`, `platform` für die Plattform-Administration), `RolesScreen`.
- `roleApi(alias)`, `useCustomRoles(alias)`, `iamKeys.customRoles(alias)`, Typen `CustomRole`, `CustomRoleInput`,
  `CustomRoleList`; `CatalogRole.custom`, `RoleInfo.custom`; `RESERVED.rolesAdmin`.

### Geändert

- Die Navigation «Zugang» zeigt «Rollen» für Personen mit `roles:admin` (ab `@vollholz/iam` 5.0 hat org-admin das Recht;
  gegen ältere Server erscheint der Eintrag nicht). Eigene Rollen erscheinen in «Rollen setzen», in der Rollenmatrix und
  beim Freigeben an Orten, weil Status und Katalog sie liefern.
  Hinweis für Apps mit eigenem Router: die neue Route `roles` einhängen (wer `iamRoutes` durchläuft, hat sie).

## [2.1.0] – 2026-10-26

Stand bis 2.1.0, ohne Einzelnachweis. Frühere Versionen: Tags `iam-web-v*` und Hinweise im README des Pakets und in docs/ausrollen.md.
