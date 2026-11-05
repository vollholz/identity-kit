# Changelog `@vollholz/iam-web`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `iam-web-v<version>`.

## [3.0.0] – 2026-11-05

### Breaking

- **`Member.status` um `'not-sent'` erweitert** (Status «nicht versendet», ab `@vollholz/iam` 6 mit Migration
  `iam_020`). Code, der den Status vollständig unterscheidet (z. B. `Record<Member['status'], …>`, `switch` mit
  `never`-Prüfung), kompiliert erst mit `not-sent` wieder.
  Migration: `not-sent` wie eine offene Einladung behandeln (zurückziehen, erneut senden); zusammen mit
  `@vollholz/iam` 6.0.0 anheben (ältere `iam` liefern `not-sent` nie).

### Hinzugefügt

- **Status «nicht versendet»** (`not-sent`, ab `@vollholz/iam` mit Migration `iam_020`) in «Benutzer und Rollen»:
  rote Marke mit Hinweis auf «Mehr» › «Einladung erneut senden», im Kopf «n Einladungen nicht versendet» (zählt nicht
  zu «davon n eingeladen»), Aktionen wie bei offenen Einladungen (erneut senden, zurückziehen). `Member.status` um
  `'not-sent'` ergänzt; Texte `iam.members.status.notSent`, `iam.members.status.notSentWhy`,
  `iam.members.ofNotSent_one`, `iam.members.ofNotSent_other`.
  Hinweis: Eigener Code, der `Member.status` vollständig unterscheidet, ergänzt `not-sent`.

### Geändert

- Einladen ohne versendete E-Mail: Dialog «Einladung nicht versendet» statt «Einladung erfasst», ohne «… ist
  eingeladen» (Texte `iam.invite.doneTitle`, `iam.invite.done`, `iam.invite.doneRole`, `iam.invite.doneRoles`).
- Nach «Einladung erneut senden» einer nicht versendeten Einladung lädt die Liste neu (Status wieder «eingeladen»).
- Ohne versendete E-Mail nennen die Hinweise den Grund des Servers (`emailError` bzw. `reason`): «kein E-Mail-Versand
  eingerichtet» oder «eingerichtet, aber vom Mailserver nicht angenommen» statt immer «meist ist im Realm kein
  E-Mail-Versand eingerichtet» (Einladen, Aus Entra hinzufügen, erneut senden). Ältere Server ohne Grund: neutraler
  Hinweis. «Einladung erneut senden» meldet den Fehler in einem Satz statt «Einladung nicht gesendet: Einladung nicht
  versendet – …». Neue Texte `iam.members.resendNoMailConfig`, `iam.members.resendMailFailed`,
  `iam.invite.noMailConfig`, `iam.invite.mailFailed`, `iam.entraAdd.noMailConfig`, `iam.entraAdd.mailFailed`; Typ
  `EmailError`, `InviteResult.emailError`, `EntraAddResult.emailError` (optional).

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
