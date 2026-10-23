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
| 0 Spezifikation (Vertrag) | identity-kit | `authz-p0-spec` | offen |
| 1–3, 5 Backend + Testkit | identity-kit | `authz-p1-backend` | wartet auf 0 |
| 4 Realm-Modul | identity-kit | `authz-p4-realm` | offen |
| 6 Oberfläche Baukasten | identity-kit | `authz-p6-web` | wartet auf 0 |
| 7 Release 1.0 | identity-kit | – | wartet auf 1–6 |
| 8, 9a Assets Backend + Standardschema | assets | `authz-p8-backend` | wartet auf 7 |
| 9, 9b Assets Oberfläche + Attributgruppen | assets | `authz-p9-web` | wartet auf 8 |
| 10 Doku Assets | assets | `authz-p10-docs` | wartet auf 9 |
| 11 identity README | identity | `ccr-4fc410d5-h3g8d6` | offen |

## Offene Punkte

| # | Punkt | Herkunft | Entscheid |
|---|---|---|---|
| O1 | Entra-Gruppen: Überlauf bei mehr als 200 Gruppen (Entra liefert dann keinen `groups`-Claim); ggf. Gruppen-Filter in der App-Registrierung oder Abfrage über Graph | Review #43 | offen, nach P1 |

## Verworfen

| # | Punkt | Grund |
|---|---|---|
| V1 | OpenFGA / SpiceDB | D1 |
| V2 | Folgen-Vorschau, Zugriffsanfragen, Rezertifizierung, verborgene Nachbarn | Konzept Abschnitt 9 |
| V3 | SCIM | Keycloak 26 ohne SCIM-Server |
