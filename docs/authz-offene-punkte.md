# Authz neu: Steuerung, Entscheide und offene Punkte

Begleitliste zu [authz-konzept.md](authz-konzept.md). Gepflegt von der Master-Session; Subsessions melden neue
Punkte im Abschlussbericht ihres PRs, nicht durch Bauen.

## Regeln für Subsessions

1. Gebaut wird nur, was das Konzept und der Auftrag des Pakets verlangen.
2. Alles andere: Notiz im PR unter «Offene Punkte» – die Master-Session übernimmt es hierher oder verwirft es.
3. Unklarheiten, die Vertrag oder Abnahme betreffen: im PR als Frage, nicht selbst entscheiden.
4. Greenfield: Bestehendes darf ersetzt werden, kein Migrationspfad, keine Kompatibilitätsschichten.

## Entscheide

| # | Datum | Entscheid |
|---|---|---|
| D1 | 2026-10-23 | Engine in PostgreSQL (Tupel + deklaratives Modell), kein OpenFGA, kein neues Repository |
| D2 | 2026-10-23 | Keine Verbote, keine Beschränkungen, kein `blocked`, keine Ausnahme für org-admin; Break-Glass nur als befristete Freigabestufe |
| D3 | 2026-10-23 | Eigene Rollen der Organisation (`tenant_role`, `c-*`) entfallen |
| D4 | 2026-10-23 | Ansichten, Reports, Dashboards: Teilen über das Panel «Zugriff» statt Schalter `shared` |
| D5 | 2026-10-23 | Organisationseinheiten, Verantwortliche, Attributgruppen, Klassifizierung in Assets; im Baukasten nur das Generische |
| D6 | 2026-10-23 | Rollen nur noch in der App-Datenbank; Keycloak ohne Rollengruppen und Client-Rollen |
| D7 | 2026-10-23 | PRs werden nach grüner CI automatisch gemergt (Squash) |
| D8 | 2026-10-24 | Assets: geteilte Inhalte (Ansicht, Report, Dashboard) mit eigenen Rollen `share-viewer`/`share-editor` und Rechten `content:read`/`content:write`, damit private Inhalte nicht über org-weite Rollen lesbar sind |
| D10 | 2026-10-24 | «Für alle Mitglieder» setzt die Rolle aus `types[].membersRole` des Modells (Standard `viewer`), damit Apps mit eigenen Teilen-Rollen (D8) den Schalter behalten; Kit 1.2 |
| D11 | 2026-10-24 | org-admin sieht auch private Inhalte anderer (konsequent zu D2); Teilen-Rollen nie an org vergebbar (Kit 1.3: `types.org.roles` als Liste) |
| D12 | 2026-10-24 | Zurücksetzen und frisch Aufsetzen automatisiert: alles (App-Datenbank, Organisationen und Personen in Keycloak); Init aus Datei oder Workflow-Eingaben, optional mit Demo-Inhalten; GitHub-Workflow mit Freigabe; generisch im Kit (`iam-reset`, `iam-org-bootstrap --file`), Aufruf in Assets |
| D9 | 2026-10-24 | Zuständigkeit über Personen aus Fachdaten generisch im Baukasten (Kit 1.1, P1b), nicht als Sonderlösung in Assets |

## Pakete und Stand

| Paket | Repo | Branch | Stand |
|---|---|---|---|
| 0 Spezifikation (Vertrag) | identity-kit | `authz-p0-spec` | erledigt (#45) |
| 1–3, 5 Backend + Testkit | identity-kit | `authz-p1-backend` | erledigt (#47) |
| 4 Realm-Modul | identity-kit | `authz-p4-realm` | erledigt (#44) |
| 6 Oberfläche Baukasten | identity-kit | `authz-p6-web` | erledigt (#46) |
| 1b Kit 1.1: Zuständigkeit über Personen | identity-kit | `authz-p1b-persons` | erledigt (#48), Release 1.1.0 |
| 1c Kit 1.2: `membersRole` | identity-kit | `authz-p1c-members-role` | erledigt (#50), Release 1.2.0 |
| 1d Kit 1.3: Rollen an org begrenzen | identity-kit | `authz-p1d-org-roles` | erledigt (#51), Release 1.3.0 |
| 7 Release 1.0 | identity-kit | – | automatisch nach Merge (release.yml): iam-web, product-realm 1.0.0 veröffentlicht, iam/iam-testkit im Lauf |
| 8, 9a Assets Backend + Standardschema (+ Backend von 9b) | assets | `authz-p8-backend` | erledigt (assets#43, enthält P9) |
| 9, 9b Assets Oberfläche + Attributgruppen | assets | `authz-p9-web` | erledigt (assets#44 → #43) |
| 10 Doku Assets | assets | `authz-p10-docs` | erledigt (assets#45) |
| 8b Nachtrag: Diskussions-Webhooks maskieren (Codex auf #45) | assets | `authz-p8b-discussion-webhooks` | erledigt (assets#46) |
| 12 Kit: `iam-reset`, Init aus Datei (1.4.0) | identity-kit | `authz-p12-reset` | erledigt (#55), Release 1.4.0 |
| 13 Assets: Reset-Workflow | assets | `authz-p13-reset` | in Arbeit (session_01LwdURy7pBDnkanZzdBfxXc) |
| 11 identity README | identity | `ccr-4fc410d5-h3g8d6` | erledigt (identity #7) |

## Offene Punkte

| # | Punkt | Herkunft | Entscheid |
|---|---|---|---|
| O1 | Entra-Gruppen: Überlauf bei mehr als 200 Gruppen (Entra liefert dann keinen `groups`-Claim); ggf. Gruppen-Filter in der App-Registrierung oder Abfrage über Graph | Review #43 | offen, nach P1 |
| O2 | Attribut `entra_groups` im Realm-User-Profile | P4 | entschieden: im Modul deklariert, nur admin, mehrwertig |
| O4 | `catalog.platformJson()` ohne `roles`; `machine_clients` im Modul ohne `roles` | P4 | erledigt (#47) |
| O5 | Eigene Rollen der Organisation (D3): später als Rollen aus Tabelle mit derselben API möglich | Person | zurückgestellt: entscheidet die Person später |
| O6 | Besitz (`owner`) übertragen | P0 A7 | offen, nicht in diesem Vorhaben |
| O7 | Release-Hinweis 1.0: neue Symbole `arrow`, `lock` in `IamIconName`; OpenAPI-Auszug in iam-web erneuern, sobald P1 eine OpenAPI liefert | P6 | an P7 |
| O8 | Alte Dateien in packages/iam löschen (alte Module, Tests, Skripte, Fixtures; Liste in #47); bestehende Migrationen bleiben | P1 | erledigt (identity-kit#54) |
| O9 | «Warum?» für andere Personen kennt deren Entra-Gruppen nicht (nur aus dem eigenen Token); Vorschlag: Gruppen beim Login am Principal speichern | P1 #47 | offen, nach Assets |
| O10 | Baukasten ruft `events` bei Zugriffsänderungen nicht auf; Assets erzeugt `access.changed` übergangsweise über einen Audit-Wrapper | P8 assets#43 | offen, Kit-Folgearbeit |
| O11 | Alte Dateien in Assets löschen (Liste in assets#43) | P8 | erledigt (assets#47) |
| O12 | E2E-Tests (Playwright) gegen lokalen Stack für Zugriff/Klassifizierung in Assets nicht ausgeführt (CI-Umgebung ohne Docker) | P9 assets#44 | offen, vor produktivem Einsatz |
| O13 | `iam-reset --keycloak` entfernt keine Entra-Anbieter, die nach einem abgebrochenen Lauf an keiner Organisation mehr hängen | P12 #55 | offen, klein |
| O14 | `platform.reset` nur im Workflow-Protokoll (stdout), nicht in der Datenbank; bei Bedarf Plattform-Audit ohne Mandant (eigene Tabelle) | P12 #55 | offen, nur bei Bedarf |
| O15 | Versionstabelle in docs/neue-app.md veraltet | P12 #55 | offen, klein |
| O3 | IdP-Mapper `entra-groups` (oidc-user-attribute-idp-mapper, claim groups → entra_groups, FORCE) muss `idpRepresentation()` in packages/iam/src/entra.ts anlegen | P4 | erledigt (#47) |

## Verworfen

| # | Punkt | Grund |
|---|---|---|
| V1 | OpenFGA / SpiceDB | D1 |
| V2 | Folgen-Vorschau, Zugriffsanfragen, Rezertifizierung, verborgene Nachbarn | Konzept Abschnitt 9 |
| V3 | SCIM | Keycloak 26 ohne SCIM-Server |
