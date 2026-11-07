# Konzept: Module je Organisation (Produktmodule)

Apps auf `@vollholz/platform` bestehen aus Fachmodulen (`defineModule`). Dieses Konzept ergänzt den Baukasten um
**Produktmodule**, die der Betrieb je Organisation freigibt und die die Administration einer Organisation zur Laufzeit
aktiviert und deaktiviert. Erste App: nachtschicht ([docs/modularisierung.md](https://github.com/vollholz/nachtschicht/blob/main/docs/modularisierung.md)).

Stand: Konzept (November 2026), nicht umgesetzt. Verantwortung: identity-kit. Betroffene Pakete: `@vollholz/iam`
(Modell, Tabelle, Rechte, Routen), `@vollholz/platform` (Durchsetzung, Worker, Befehle), `@vollholz/iam-web` (Seite
«Module»).

## Inhalt

1. [Entscheide](#1-entscheide)
2. [Verzeichnis im Modell](#2-verzeichnis-im-modell)
3. [Daten](#3-daten)
4. [Rechte je Organisation](#4-rechte-je-organisation)
5. [Routen](#5-routen)
6. [Durchsetzung in der Plattform](#6-durchsetzung-in-der-plattform)
7. [Lebenszyklus und Pakete](#7-lebenszyklus-und-pakete)
8. [Oberfläche](#8-oberfläche)
9. [Tabellen-Bausteine (CSV, XLSX)](#9-tabellen-bausteine-csv-xlsx)
10. [Versionen, Migration bestehender Apps](#10-versionen-migration-bestehender-apps)
11. [Tests und Abnahme](#11-tests-und-abnahme)
12. [Arbeitspakete](#12-arbeitspakete)

## 1 Entscheide

| Nr. | Entscheid | Begründung |
|---|---|---|
| MK-1 | **Das Verzeichnis der Produktmodule steht im Modell der App** (`defineModel({ modules })`), nicht in `defineApp` | Rechte tragen ihr Modul; der Katalog `GET /v1/authz/catalog` zeigt Module; eine Quelle für Rechte, Rollen, Scopes und Module (Spezifikation 7.3) |
| MK-2 | **Ein Produktmodul ist nicht ein Code-Modul.** `PlatformModule.modul` ordnet ein Code-Modul einem Produktmodul zu; einzelne Routen, Jobs, Aufgaben, Abnehmer und Werkzeuge können eine Teilfunktion `modul.teil` tragen | Der Code-Schnitt folgt Lebenszyklus und Rechten, der Produktschnitt dem, was ein Betrieb einzeln nutzt |
| MK-3 | **Zwei Schalter je Modul und Organisation:** `erlaubt` (Betrieb) und `aktiv` (Administration der Organisation); aktiv nur, wenn erlaubt | Vertrag und Nutzung sind getrennte Entscheide verschiedener Parteien |
| MK-4 | **Rechte inaktiver Module fallen im Modell der Organisation weg** (`Model.withModules`), geladen mit `Access.load` wie die eigenen Rollen | eine Berechtigungslogik für Oberfläche, API, Maschinen und MCP (Leitentscheidung L5 der Apps); kein zweiter Prüfpfad |
| MK-5 | **Routen inaktiver Module antworten 403 `modul-inaktiv`**, auch ohne Recht (Selbstsicht) | innerhalb der eigenen Organisation ist der Umfang kein Geheimnis; Maschinen-Clients brauchen eine klare Ursache; fremde Organisationen sehen weiter 404 |
| MK-6 | **Deaktivieren löscht nie Daten**; Aufbewahrung, Löschläufe und Auskunft der App laufen für alle Module | gesetzliche Pflichten hängen nicht an der Nutzung |
| MK-7 | **Kern** (`kern`) ist ein Produktmodul, das immer aktiv und nicht abschaltbar ist; Rechte ohne `modul` gehören zum Kern | Rechte des Baukastens (`tenant:*`, `members:*`, `access:*`, `audit:*`) bleiben ohne Modul |
| MK-8 | **Pakete** sind benannte Mengen von Modulen und Teilfunktionen als Vorbelegung beim Anlegen (`tenant create --paket`); sie sind kein Zustand der Organisation | Die Organisation ändert danach frei im erlaubten Umfang; kein «Modus» |
| MK-9 | **Recht zum Aktivieren: `tenant:admin`** (Feature `tenantSettings`); Freigeben nur der Betrieb über die Befehlszeile und die Plattform-Administration | besteht schon als reserviertes Recht der Organisation; kein neues Recht |
| MK-10 | **Abhängigkeiten im Verzeichnis** (`requires`, auch «eines von»); die Plattform prüft sie beim Aktivieren und Deaktivieren | die App muss keine Abhängigkeitsprüfung schreiben |

## 2 Verzeichnis im Modell

```ts
defineModel({
  product: 'rightshift',
  modules: [
    { key: 'kern', label: 'Kern', core: true },
    { key: 'schichtplanung', label: 'Schichtplanung', description: '…', requires: ['kern'],
      parts: [{ key: 'disposition', label: 'Disposition' }, { key: 'boerse', label: 'Schichtbörse' }, { key: 'wuensche', label: 'Wünsche' }] },
    { key: 'autoplanung', label: 'Auto-Planung', requires: ['schichtplanung'] },
    { key: 'compliance', label: 'Compliance', requires: [['schichtplanung', 'zeiterfassung']] },   // eines von
    // …
  ],
  packages: [
    { key: 'planung', label: 'Planung', modules: ['kern', 'planpruefung', 'schichtplanung', 'autoplanung', 'abwesenheiten'], off: ['schichtplanung.wuensche', 'schichtplanung.boerse', 'schichtplanung.disposition'] },
    { key: 'gesamt', label: 'Alles', modules: '*' },
  ],
  permissions: {
    'plan:read': { …, modul: 'schichtplanung' },
    'planpruefung:read': { …, modul: 'planpruefung' },
    'team:read': { … },                      // ohne modul: Kern
  },
});
```

| Feld | Bedeutung und Prüfung (`defineModel` wirft) |
|---|---|
| `modules[].key` | `^[a-z][a-z0-9-]{1,30}$`, eindeutig; genau ein Modul mit `core: true`; `kern` ist nur Konvention |
| `requires` | Liste; ein Eintrag ist ein Schlüssel (Pflicht) oder eine Liste von Schlüsseln (eines davon); keine Zyklen; der Kern braucht nichts, alle anderen brauchen (transitiv) den Kern |
| `parts[].key` | eindeutig je Modul; Teilfunktion `modul.teil`; Teilfunktionen haben keine eigenen `requires` |
| `packages` | Schlüssel eindeutig; `modules` nur bekannte Schlüssel oder `'*'`; `off` nur Teilfunktionen aus `modules`; jedes Paket enthält den Kern und erfüllt `requires` (sonst Fehler) |
| `permissions[].modul` | bekannter Schlüssel oder `modul.teil`; reservierte Rechte nie mit Modul |
| `roles` | unverändert: Eine Rolle darf Rechte mehrerer Module nennen; in der Organisation bleibt davon, was aktiv ist |
| `scopes` | unverändert; Prüfung eines Scopes in der Organisation läuft über das Modell der Organisation (inaktive Rechte fehlen) |

Ohne `modules` verhält sich das Modell wie heute (ein stilles Modul `kern`, alle Rechte darin); bestehende Apps
ändern nichts. `Model` erhält `modules` (Verzeichnis, geprüft), `packages`, `moduleOf(permission)`,
`activeModules` (im Modell der Organisation) und `withModules(active: readonly string[])`.

`GET /v1/authz/catalog` erhält `modules: [{ key, label, description, core, requires, parts }]`, `packages` und je
Recht `modul`; im Kontext einer Organisation nur die Rechte aktiver Module (wie `withRoles`).

## 3 Daten

Migration `iam_022_tenant_module.sql` (`@vollholz/iam`), Schema des Produkts:

`tenant_module` — PK `(tenant_id, module)`, RLS `ENABLE` + `FORCE` wie `authz_tuple`; Lesen in der Organisation
(`tenant:read`), Schreiben nur über die Funktionen unten.

| Spalte | Typ | Bemerkung |
|---|---|---|
| `module` | text | Schlüssel des Moduls oder `modul.teil` |
| `allowed` | boolean NOT NULL | setzt der Betrieb |
| `active` | boolean NOT NULL | setzt die Organisation; CHECK `NOT active OR allowed` |
| `active_since` | timestamptz NULL | letztes Aktivieren (für `nachholen`) |
| `inactive_since` | timestamptz NULL | letztes Deaktivieren |
| `changed_at`, `changed_by` | timestamptz, uuid NULL | `changed_by` NULL = Betrieb |

Fehlt eine Zeile, gilt: **nicht erlaubt, nicht aktiv** – ausser für den Kern (immer aktiv) und für Teilfunktionen
(ohne Zeile: aktiv, sobald ihr Modul aktiv ist). Bestehende Organisationen erhalten mit der Migration keine Zeilen;
damit `Access.load` sie nicht als «alles aus» liest, gilt die Übergangsregel in [Abschnitt 10](#10-versionen-migration-bestehender-apps).

Trigger `bump_acl_version` auf `tenant_module` (besteht für Tupel): Jede Änderung erhöht `tenant.acl_version`, damit
`Access.load` das Modell neu lädt (Cache wie bei Rollen).

Funktionen (`SECURITY DEFINER`, wie `set_tenant_status`): `set_module_allowed(tenant, module, allowed)` für die
Besitzer-Rolle (Befehlszeile, Plattform-Administration) und `set_module_active(module, active)` im Kontext der
Organisation (prüft `allowed`). Audit `tenant.module_allowed` bzw. `tenant.module_active` mit `{ module, before,
after }`; Aktivieren protokolliert zusätzlich im Mandanten (`pgAudit`), Freigeben im Protokoll der Plattform.

## 4 Rechte je Organisation

`Access.load(tenantId)` liest zusätzlich `tenant_module` und bildet `model = base.withRoles(roles).withModules(active)`:

- `withModules` entfernt alle Rechte mit `modul` ∉ aktive Menge (Modul oder dessen Teilfunktion inaktiv) aus
  `permissions`, aus den Rollen (`permissionsForRoles`), aus den Scopes und aus `permissionsOf`. Rollen bleiben
  zuweisbar (Tupel bleiben bestehen); eine Rolle ohne verbleibende Rechte ist in der Organisation leer.
- `can`, `check`, `canSomewhere`, `explain` nutzen das Modell der Organisation (schon heute). Damit ist ein
  Recht eines inaktiven Moduls überall `false`: Oberfläche (`can`), API (`need`), Maschinen (Scopes), MCP.
- `TenantAccess.modules` (aktive Menge, mit Teilfunktionen aufgelöst) steht Apps über `iam.access.modulesOf(tenantId)`
  zur Verfügung (zwischengespeichert wie `modelOf`), für Quellen und Brücken in der App.
- Eigene Rollen (`customRoles`): Beim Anlegen darf eine Rolle Rechte inaktiver Module nennen (sie gelten, sobald das
  Modul aktiv ist); `customRoleProblems` prüft gegen das Grundmodell.

## 5 Routen

Im Paket `@vollholz/iam` (Tag «Organisation»), Kontext der Organisation:

| Methode und Pfad | Recht | Hinweis |
|---|---|---|
| `GET /v1/tenant/modules` | `tenant:read` | je Modul und Teilfunktion `{ key, label, description, core, requires, allowed, active, activeSince, blockers?: [...] }`; `blockers` nur mit `tenant:admin` (Hindernisse aus `hindernisse(tx)` der App, [7](#7-lebenszyklus-und-pakete)) |
| `PUT /v1/tenant/modules/{key}` | `tenant:admin` | `{ active: boolean }` mit `If-Match` auf `tenant.acl_version`; 403 `modul-nicht-erlaubt`; 409 `voraussetzung-fehlt` `{ fehlt: [...] }` (Aktivieren), `abhaengig-aktiv` `{ module: [...] }` oder `hindernisse` `{ hindernisse: [...] }` (Deaktivieren); Kern 409 `kern`; Teilfunktion ohne aktives Modul 409 |
| `GET /v1/platform/tenants/{alias}/modules`, `PUT …/{key}` | Plattform-Administration (`platformAdmin`) | `{ allowed: boolean }`; Entziehen deaktiviert mit (Hindernisse werden gemeldet, `?force=true` übergeht sie) |

`GET /v1/me` (Sitzung) erhält `modules: string[]` (aktive Module und Teilfunktionen), damit die Oberfläche
Arbeitsflächen ohne zweiten Aufruf ausblendet.

Ereignisse an die App (`IamEvents`): `module.activated` und `module.deactivated` `{ tenantId, module, by }` –
in der Transaktion der Änderung; die App hängt daran `einrichten`, `nachholen` und die Outbox (`platform.emit`).

## 6 Durchsetzung in der Plattform

`@vollholz/platform`:

| Ort | Ergänzung |
|---|---|
| `PlatformModule` | `modul?: string` (Produktmodul des Code-Moduls; Pflicht, wenn das Modell `modules` hat: `checkModules` wirft sonst) |
| Routen | `config: { modul?: string }` je Route überschreibt das Modul des Code-Moduls (Teilfunktion `modul.teil`). Hook `onRequest` nach dem Principal: Modul der Route gegen `access.modulesOf(tenantId)`; inaktiv → `HttpError` 403, `type …/probleme/modul-inaktiv`, `detail` «Das Modul ‹Schichtplanung› ist in deiner Organisation nicht aktiv.», `extensions.modul`. Öffentliche Routen (`publicRoutes`) prüfen über den Alias der Organisation ebenso |
| `JobDefinition`, `PeriodicTask`, `OutboxConsumer`, `ToolDef` | `modul?: string`; ohne Angabe das Modul des Code-Moduls, in dem sie definiert sind (`defineModule` trägt es ein) |
| Worker: Jobs | Vor dem Ausführen: Modul inaktiv in der Organisation des Auftrags → Auftrag endet `skipped` (`result: { modul: 'inaktiv' }`), kein Fehler, kein neuer Versuch; `nachholen` der App holt die Wirkung nach |
| Worker: Aufgaben | `run` erhält `ctx.tenants(modul)`: aktive Organisationen für das Modul der Aufgabe (statt aller); Aufgaben ohne Modul wie bisher |
| Outbox | Abnehmer mit Modul: Ereignisse einer Organisation mit inaktivem Modul werden für diesen Abnehmer als erledigt markiert (`skipped`), damit die Outbox nicht wächst |
| MCP | `tools/list` je Sitzung ohne Werkzeuge inaktiver Module; Aufruf eines inaktiven → Fehler aus der REST-API (403) unverändert durchgereicht |
| `defineApp` | `checkModules` prüft: jedes `modul` existiert im Verzeichnis des Modells; jedes Modul des Verzeichnisses ausser dem Kern hat mindestens ein Code-Modul, eine Route, einen Job oder ein Recht (sonst Warnung) |
| OpenAPI | je Route `x-modul`; Doku je Tag nennt das Modul |
| Befehle | `tenant create <alias> [--name] [--paket <key>]` (Standard: alle Module erlaubt und aktiv, wie bisher), `tenant modules <alias>` (Liste), `tenant modules <alias> --erlauben a,b --entziehen c`, `tenant modules <alias> --paket <key>` (setzt erlaubt und aktiv wie das Paket; `--nur-erlauben` lässt aktiv unverändert) |
| `identity.app.json` | `organizations[].package` (Paket beim Anlegen über `create-iam-app` bzw. Startdaten) |

Die Prüfung je Anfrage kostet einen Blick in den Cache des Modells (`modulesOf`), keine Abfrage.

## 7 Lebenszyklus und Pakete

Die App registriert je Produktmodul optionale Haken über `defineApp({ moduleHooks })`:

```ts
moduleHooks: {
  abwesenheiten: {
    einrichten: (tx, tenantId) => absenzartenStandard(tx),            // erstes Aktivieren
    hindernisse: (tx, tenantId) => offeneAntraege(tx, ['ferien']),     // vor dem Deaktivieren: [{ key, text, anzahl }]
    nachholen: (tx, tenantId, seit) => tageNeuBerechnen(tx, seit),     // erneutes Aktivieren
  },
}
```

- `einrichten` läuft in der Transaktion des ersten Aktivierens (nur wenn `active_since` vorher NULL war).
- `hindernisse` liefert `GET /v1/tenant/modules` (mit `tenant:admin`) und blockiert `PUT { active: false }` (409).
- `nachholen` wird als Auftrag `platform.module-nachholen` eingereiht (kann lange dauern), mit `seit = inactive_since`.

**Pakete** (`packages` im Modell): `tenant create --paket planung` setzt `allowed` und `active` für die Module des
Pakets und `active = false` für dessen `off`-Teilfunktionen; `einrichten` läuft je Modul. Pakete ändern später nichts;
`tenant modules --paket` wendet ein Paket erneut an (Betrieb).

## 8 Oberfläche

`@vollholz/iam-web`: Seite **«Module»** in der Gruppe «Zugang» (Route `paths.modules`, Standard `/einstellungen/module`),
sichtbar mit `tenant:read`, bearbeitbar mit `tenant:admin`; Seitentyp Liste + Schublade:

- Zeile je Modul: Name, Kurzbeschreibung, Status (Aktiv · Aus · Nicht freigegeben), Teilfunktionen als Schalter
  darunter (eingerückt), Voraussetzungen als Text («braucht Zeiterfassung»).
- Schalter «Aktiv»: Vor dem Deaktivieren Bestätigung mit Wirkung («Arbeitsflächen Zeit und Lohn verschwinden für
  alle; Daten bleiben erhalten») und Hindernissen («3 offene Korrekturanträge – zuerst entscheiden»); vor dem
  Aktivieren Hinweis auf mitzuaktivierende Voraussetzungen («Aktiviert auch Zeiterfassung»).
- Nicht freigegebene Module: Schalter deaktiviert mit Grund («Für deine Organisation nicht freigegeben – wende dich
  an den Betrieb»).
- `useIam()` erhält `modules` und `hasModule(key)`; `useIamNav` blendet nichts ein oder aus (die Gruppe «Zugang» gehört
  zum Kern).
- Plattform-Administration: in der bestehenden Mandantenliste je Organisation «Module» mit Freigeben/Entziehen.

## 9 Tabellen-Bausteine (CSV, XLSX)

Apps importieren und exportieren Tabellen (Treiberdaten, Planimport, Berichte). Dafür liefert `@vollholz/platform`
reine Bausteine ohne Netz und ohne Abhängigkeit:

| Baustein | Inhalt |
|---|---|
| `csvLesen(text, { trennzeichen?: ';' \| ',' \| '\t' \| 'auto', kopfzeile?: boolean })` | RFC 4180 mit Anführungszeichen und Zeilenumbrüchen in Feldern; Erkennung des Trennzeichens aus der ersten Zeile; BOM; `\r\n`; liefert `{ kopf, zeilen: string[][] }` |
| `csvSchreiben(zeilen, { trennzeichen?: ';' })` | mit BOM für Excel (UTF-8), Anführungszeichen wo nötig |
| `xlsxLesen(buffer, { blatt?: string \| number, maxZeilen?, maxBytes? })` | eigener Leser: ZIP (`node:zlib` `inflateRaw`, Zentralverzeichnis, Prüfung der entpackten Grösse ≤ `maxBytes`, Standard 64 MB, keine verschachtelten Archive), `xl/workbook.xml`, `xl/sharedStrings.xml`, `xl/worksheets/sheetN.xml`; Zelltypen `n`, `s`, `str`, `inlineStr`, `b`, `d`; Datumsformate über `styles.xml` (`numFmtId` 14–22, 45–47 und eigene Formate mit `d`/`m`/`y`/`h`) → ISO-Text; keine Formeln (nur gespeicherte Werte), keine Makros, keine externen Verweise; liefert `{ blaetter: string[], kopf, zeilen: (string \| number \| boolean \| null)[][] }` |
| `xlsxSchreiben({ blaetter: [{ name, kopf, zeilen, spalten?: { breite, format: 'text' \| 'zahl' \| 'datum' }[] }] })` | eigener Schreiber (ZIP `deflateRaw`), Inline-Strings, Datumswerte als Serial mit Format, Kopfzeile fett, Autofilter |
| `tabelleLesen(buffer, contentType, o)` | wählt nach Typ (`text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`), prüft Magic Bytes (`PK\x03\x04` bzw. Text ohne Nullbytes) |

Begründung «eigener Leser statt Bibliothek»: Die gängigen Pakete (`exceljs`, `xlsx`) sind gross, ziehen
Abhängigkeiten nach und hatten Sicherheitsmeldungen (Prototype Pollution, ReDoS); die benötigte Teilmenge (Werte eines
Blatts) ist klein und mit Tests abgesichert (Dateien aus Excel, LibreOffice, Google Sheets, Numbers). Grenzen schützen
vor ZIP-Bomben (Verhältnis entpackt/gepackt ≤ 200, absolute Obergrenze) und tiefen XML-Strukturen (kein DTD, keine
Entitäten ausser den fünf vordefinierten). Reicht die Teilmenge nicht (z. B. Formeln), wird der Entscheid in der App
neu bewertet, nicht hier erweitert.

## 10 Versionen, Migration bestehender Apps

| Paket | Version | Breaking |
|---|---|---|
| `@vollholz/iam` | 6.1.0 | nein: `modules` im Modell optional; Migration `iam_022`; Routen und `GET /v1/me.modules` neu; `features.tenantSettings` bleibt Standard `false` |
| `@vollholz/platform` | 0.9.0 | nein, solange das Modell kein `modules` hat; mit `modules` ist `modul` an jedem Code-Modul Pflicht (Fehler beim Start) |
| `@vollholz/iam-web` | 3.1.0 | nein; Seite «Module» nur mit `features.modules` der App |

**Übergangsregel** für Organisationen ohne Zeilen in `tenant_module` (vor dem ersten Lauf von `tenant modules`): Beim
ersten `Access.load` einer Organisation ohne Zeilen legt die Plattform **alle Module erlaubt und aktiv** an (im
Kontext der Organisation, protokolliert als `tenant.module_backfill`). Damit ändert das Anheben der Pakete für keine
Organisation etwas. Alternativ setzt `migrate` die Zeilen für alle bestehenden Organisationen (eine Abfrage) – gewählt
wird die Variante in `migrate`, weil sie deterministisch ist; die Regel beim Laden bleibt als Sicherheitsnetz.

## 11 Tests und Abnahme

| Kriterium | Test |
|---|---|
| Modell: Verzeichnis geprüft | `defineModel` wirft bei Zyklen, unbekannten Voraussetzungen, Paket ohne Kern, Recht mit unbekanntem Modul, zwei Kernen |
| Rechte inaktiver Module fehlen überall | `withModules`: `can`, `canSomewhere`, `permissionsForRoles`, `permissionsForScopes`, `explain`, Katalog; Tupel bleiben; nach erneutem Aktivieren gelten die Rechte sofort (`acl_version`) |
| HTTP | Route eines inaktiven Moduls → 403 `modul-inaktiv` (eigene Organisation), 404 (fremde ID, wie bisher); Teilfunktion je Route; öffentliche Route über den Alias |
| Worker | Auftrag eines inaktiven Moduls `skipped` ohne Fehler; Aufgabe erhält nur aktive Organisationen; Outbox-Abnehmer überspringt und die Outbox wächst nicht |
| MCP | `tools/list` ohne Werkzeuge inaktiver Module |
| Aktivieren und Deaktivieren | Voraussetzung fehlt 409; abhängiges Modul aktiv 409; Hindernisse 409; `einrichten` genau einmal; `nachholen` mit `seit`; Kern nie; nicht erlaubt 403; Audit beide Protokolle |
| Pakete | `tenant create --paket` setzt genau die Menge; `off`-Teilfunktionen aus; unbekanntes Paket Exit 64 |
| Migration bestehender Organisationen | nach `migrate` alle Module erlaubt und aktiv; Verhalten der Fixture-App unverändert |
| Tabellen | CSV: Trennzeichen, Anführungszeichen, BOM, `\r\n`; XLSX: Dateien aus Excel, LibreOffice, Google Sheets, Numbers (Fixtures), Datum und Zeit, leere Zellen, 100 000 Zeilen < 2 s, ZIP-Bombe abgelehnt, DTD abgelehnt; Schreiben → Lesen identisch |
| Mandantentrennung | `tenant_module` in der RLS-Matrix des Pakets; Organisation B sieht und ändert nichts von A |

## 12 Arbeitspakete

| Paket | Branch | Inhalt | Abhängig |
|---|---|---|---|
| **IK-1** Modell und Rechte | `feat/module-modell` | `@vollholz/iam`: `modules`, `packages`, `modul` an Rechten, `withModules`, `moduleOf`; Migration `iam_022_tenant_module.sql` mit Funktionen und Trigger; `Access.load` mit Modulen, `modulesOf`; Routen `GET/PUT /v1/tenant/modules`, Plattform-Routen; `GET /v1/me.modules`; Katalog; Ereignisse `module.*`; Backfill in `migrate`; Tests | – |
| **IK-2** Durchsetzung und Befehle | `feat/module-plattform` | `@vollholz/platform`: `modul` an Modul, Route, Job, Aufgabe, Abnehmer, Werkzeug; Hook 403; Worker (Jobs `skipped`, `ctx.tenants(modul)`, Outbox); MCP-Filter; `moduleHooks` (einrichten, hindernisse, nachholen) mit Auftrag `platform.module-nachholen`; `checkModules`; OpenAPI `x-modul`; Befehle `tenant create --paket`, `tenant modules`; Fixture-App mit zwei Modulen; Tests | IK-1 |
| **IK-3** Seite «Module» | `feat/module-web` | `@vollholz/iam-web`: Seite, `useIam().modules`, `hasModule`; Plattform-Administration; Tests (axe, Tastatur) | IK-1 |
| **IK-4** Tabellen-Bausteine | `feat/tabellen-csv-xlsx` | `@vollholz/platform`: `csvLesen`, `csvSchreiben`, `xlsxLesen`, `xlsxSchreiben`, `tabelleLesen`; Fixtures; Leistungs- und Sicherheitstests | – |
| **IK-5** create-iam-app | `feat/module-startdaten` | `identity.app.json` › `organizations[].package`; Startdaten mit Paket; Doku in `neue-app.md` | IK-2 |

IK-1 ∥ IK-4; dann IK-2 ∥ IK-3; zuletzt IK-5. Jedes Paket mit CHANGELOG-Eintrag; Versionen gemeinsam veröffentlicht
(Renovate-Gruppe «identity-kit» der Apps).
