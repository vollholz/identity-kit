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

## Pakete und Stand

| Paket | Repo | Branch | Stand |
|---|---|---|---|
| 0 Spezifikation (Vertrag) | identity-kit | `authz-p0-spec` | erledigt (#45) |
| 1–3, 5 Backend + Testkit | identity-kit | `authz-p1-backend` | erledigt (#47) |
| 4 Realm-Modul | identity-kit | `authz-p4-realm` | erledigt (#44) |
| 6 Oberfläche Baukasten | identity-kit | `authz-p6-web` | erledigt (#46) |
| 7 Release 1.0 | identity-kit | – | automatisch nach Merge (release.yml): iam-web, product-realm 1.0.0 veröffentlicht, iam/iam-testkit im Lauf |
| 8, 9a Assets Backend + Standardschema (+ Backend von 9b) | assets | `authz-p8-backend` | in Arbeit (session_01UWR9VNXN5ahNpJHagFH6T2) |
| 9, 9b Assets Oberfläche + Attributgruppen | assets | `authz-p9-web` | wartet auf 8 |
| 10 Doku Assets | assets | `authz-p10-docs` | wartet auf 9 |
| 11 identity README | identity | `ccr-4fc410d5-h3g8d6` | erledigt (identity #7) |

## Offene Punkte

| # | Punkt | Herkunft | Entscheid |
|---|---|---|---|
| O1 | Entra-Gruppen: Überlauf bei mehr als 200 Gruppen (Entra liefert dann keinen `groups`-Claim); ggf. Gruppen-Filter in der App-Registrierung oder Abfrage über Graph | Review #43 | offen, nach P1 |
| O2 | Attribut `entra_groups` im Realm-User-Profile | P4 | entschieden: im Modul deklariert, nur admin, mehrwertig |
| O4 | `catalog.platformJson()` ohne `roles`; `machine_clients` im Modul ohne `roles` | P4 | erledigt (#47) |
| O5 | Eigene Rollen der Organisation (D3): Rückfrage der Person offen; später als Rollen aus Tabelle mit derselben API möglich | Person | offen |
| O6 | Besitz (`owner`) übertragen | P0 A7 | offen, nicht in diesem Vorhaben |
| O7 | Release-Hinweis 1.0: neue Symbole `arrow`, `lock` in `IamIconName`; OpenAPI-Auszug in iam-web erneuern, sobald P1 eine OpenAPI liefert | P6 | an P7 |
| O8 | Alte Dateien in packages/iam löschen (Migrationen iam_009…014 bzw. alte Module, Tests, Skripte, Fixtures): Umgebung verweigert `git rm`; Liste im PR von P1 | P1 | wartet auf die Person |
| O9 | «Warum?» für andere Personen kennt deren Entra-Gruppen nicht (nur aus dem eigenen Token); Vorschlag: Gruppen beim Login am Principal speichern | P1 #47 | offen, nach Assets |
| O3 | IdP-Mapper `entra-groups` (oidc-user-attribute-idp-mapper, claim groups → entra_groups, FORCE) muss `idpRepresentation()` in packages/iam/src/entra.ts anlegen | P4 | erledigt (#47) |

## Verworfen

| # | Punkt | Grund |
|---|---|---|
| V1 | OpenFGA / SpiceDB | D1 |
| V2 | Folgen-Vorschau, Zugriffsanfragen, Rezertifizierung, verborgene Nachbarn | Konzept Abschnitt 9 |
| V3 | SCIM | Keycloak 26 ohne SCIM-Server |
