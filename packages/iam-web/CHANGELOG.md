# Changelog `@vollholz/iam-web`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `iam-web-v<version>`.

## [3.2.0] – 2026-11-07

### Hinzugefügt

- **Hilfen für eine eigene Modulseite der App** aus `@vollholz/iam-web/pages`:
  - `moduleLockReason(items, m, admin, adminPerm)`: Sperrgrund des Schalters wie in der generischen Seite, sonst
    `null`. Reihenfolge der Gründe: Pflichtmodul, nicht freigegeben, fehlendes Recht, Modul der Teilfunktion aus,
    Voraussetzung nicht freigegeben.
  - `moduleIsOn(m)`: eingeschaltet? Pflichtmodule immer.
  - Typen `TenantModule`, `TenantModuleList`, `ModuleBlocker` und `ModuleRequirement` auch aus `/pages` (wie bisher
    aus dem Haupteinstieg), damit eine eigene Modulseite nur aus `/pages` importieren kann.
- Doku: `docs/module-je-organisation.md` Abschnitt 8 «Eigene Seite statt der generischen» (Zweck → Hilfe →
  Einstieg) und Verweis im README. Die Seite «Module» nutzt dieselben Hilfen.

### Behoben

- Seite «Module» auf Touch-Geräten (`pointer: coarse`) breiter als 520 px: Die vergrösserten Zielflächen der
  Schalter (≥ 44 px) zweier aufeinanderfolgender Zeilen ohne Beschreibung, Voraussetzungen und Sperrgrund überlappten
  sich um rund 12 px. Ein Tippen dazwischen konnte den falschen Schalter treffen. Jede Zeile ist dort jetzt mindestens
  44 px hoch.

## [3.1.2] – 2026-11-07

### Behoben

- **Seite «Module»: ruhiges Layout.** Jede Zeile, Modul wie Teilfunktion, ist dasselbe Raster mit festen Spalten
  Text · Status · Schalter. Status und Schalter stehen in allen Zeilen bündig (bisher sass der Status am Namen und
  sprang je nach Namenslänge; die Schalter der Teilfunktionen waren mit eingerückt). Eingerückt wird nur der Text der
  Teilfunktionen. Name, Beschreibung, Voraussetzungen und Sperrgrund mit einheitlicher Schrift und gleichmässigen
  Abständen; der Schalter steht auf der Höhe der ersten Textzeile. Telefon (bis 520 px): Status unter dem Namen,
  Schalter rechts oben; auf Touch-Geräten (`pointer: coarse`) Zielflächen der Schalter und Namen ≥ 44 px.
- **Pflichtmodule wie alle anderen Module:** Status «Aktiv» (nicht mehr «Immer aktiv»), Schalter sichtbar,
  eingeschaltet und gesperrt (`aria-disabled`, fokussierbar, Grund «Pflichtmodul – immer aktiv» sichtbar und per
  `aria-describedby`; neuer Text `iam.modules.coreWhy`). Ebenso in der Schublade («Deaktivieren» gesperrt mit Grund)
  und im Abschnitt der Plattform-Administration `ModulesSection` (Status «Aktiv», «Entziehen» gesperrt mit Grund).
- Gesperrte Schalter und Knöpfe einheitlich (Pflichtmodul, nicht freigegeben, fehlendes Recht, Voraussetzung, Modul der
  Teilfunktion aus): `aria-disabled` statt `disabled` auch in der Schublade; mit `forced-colors` gesperrt in `GrayText`.
- Die Texte `iam.modules.status.core` und `iam.modules.coreText` werden nicht mehr angezeigt; sie bleiben als Schlüssel,
  damit eigene Texte über `configureTexts` weiter gelten. Für Apps sonst keine Änderung.

## [3.1.1] – 2026-11-07

### Behoben

- **Haupteinstieg wieder so klein wie in 3.0.1:** Seite «Module» samt Plattform-Abschnitt, ihre Hilfen und die Texte
  `iam.modules.*` (de, en) hingen in 3.1.0 am Haupteinstieg und vergrösserten das Start-Bundle der App um rund
  3,5 kB gzip. Sie laden jetzt mit der Seite (`iamRoutes[].load()` bzw. `@vollholz/iam-web/pages`). Im Haupteinstieg
  bleiben `useIam().modules`, `useIam().hasModule`, `modulesChanged`, `useModulesFeature`, `hasModules`, die Route
  `modules` (Pfad, Titel `iam.modules.title`, Recht) und alle Typen. Messung (`node scripts/size.ts`, gzip):
  Haupteinstieg 3.0.1 62,92 kB · 3.1.0 66,45 kB · 3.1.1 62,96 kB.
- `moduleApi`, `useModules`, `activationPlan`, `choiceKey`, `dependentsOf`, `usedBy`, `partsOf`, `moduleRights`,
  `moduleLabel`, `requirementText`, `requiresText` und `moduleErrorText` werden aus `@vollholz/iam-web/pages`
  importiert (nicht mehr aus `@vollholz/iam-web`); Signaturen und Typen unverändert. Migration für Apps, die sie aus dem
  Haupteinstieg importieren (erst seit 3.1.0 vorhanden): Import auf `@vollholz/iam-web/pages` ändern. Eigene Texte
  `iam.modules.*` über `configureTexts` gelten wie bisher.

## [3.1.0] – 2026-11-07

### Hinzugefügt

- **Seite «Module»** (`paths.modules`, Standard `/einstellungen/module`; Route `modules` in `iamRoutes`, Gruppe
  «Zugang»): Produktmodule der Organisation sehen (`tenant:read`) und aktivieren bzw. deaktivieren (`tenant:admin`,
  ab `@vollholz/iam` 6.1). Liste mit Schublade: je Modul Name, Kurzbeschreibung, Status (Aktiv · Aus · Nicht
  freigegeben), Voraussetzungen als Text («Braucht «Zeiterfassung»»), Schalter; Teilfunktionen eingerückt als Schalter
  darunter. Vor dem Aktivieren der Hinweis auf mitzuaktivierende Voraussetzungen («Aktiviert auch …», bei «eines von»
  mit Wahl), aktiviert in der richtigen Reihenfolge; vor dem Deaktivieren eine Rückfrage mit der Wirkung (Teilfunktionen
  und Rechte verschwinden für alle, Daten bleiben) und den Hindernissen der App bzw. den Modulen, die es noch brauchen
  (dann ohne «Deaktivieren»). Nicht freigegebene Module gesperrt mit Grund. Antworten 403/409 des Servers (`reason`)
  in verständlichen Sätzen; `If-Match` mit dem `ETag` der Liste, 412 mit «Neu laden». In `IamNav` nur, wenn das Modell
  Module hat. `ModulesPage`, `ModulesScreen`.
- **Plattform-Administration:** Abschnitt «Module» in der Detailseite einer Organisation (`ModulesSection`): je Modul
  und Teilfunktion freigeben bzw. entziehen; Entziehen mit Rückfrage und Wirkung, Hindernisse mit «Trotzdem entziehen»
  (`?force=true`).
- `useIam().modules` (aktive Module und Teilfunktionen aus `/auth/me`) und `useIam().hasModule(key)` zum Ein- und
  Ausblenden von Arbeitsflächen der App; ältere Server ohne `modules`: `hasModule` immer `true`.
- `features.modules` (Standard: das Modell hat Module laut Katalog; `false` blendet Seite und Abschnitt aus).
- `moduleApi(alias)`, `useModules(alias)`, `useModulesFeature()`, `modulesChanged(qc, alias)` (nach einer Schaltung
  Liste, Sitzung und Katalog neu laden; der Katalog enthält nur Rechte aktiver Module), `iamKeys.modules(alias)`, Regeln für die Anzeige
  (`activationPlan`, `dependentsOf`, `usedBy`, `partsOf`, `moduleRights`, `requiresText`, `moduleErrorText`, …),
  `iamFetchWithEtag`; `useAuthzCatalog(enabled)`.
- Typen `TenantModule`, `TenantModuleList`, `ModuleBlocker`, `ModuleRequirement`, `ModuleActiveInput`,
  `ModuleAllowedInput`, `CatalogModule`, `CatalogModulePart`, `CatalogPackage`; optional `Me.modules`,
  `ApiMe.modules`, `AuthzCatalog.modules`, `AuthzCatalog.packages`, `PermissionInfo.modul`.
- Texte `iam.modules.*` (de, en).

## [3.0.1] – 2026-11-07

### Geändert

- **Verwalten › Rollen:** Die vordefinierten Rollen heissen «Standardrollen» (statt «Rollen der App (Vorgabe)»), mit
  dem Hinweis «Vorgegeben und nicht änderbar.»; je Rolle steht der Name, darunter die Beschreibung (ohne
  Gedankenstrich), die Liste ist auf eine lesbare Breite begrenzt. Texte `iam.roles.page.builtIn`,
  `iam.roles.page.builtInText` und `iam.roles.page.noneText` (de, en) angepasst.

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
