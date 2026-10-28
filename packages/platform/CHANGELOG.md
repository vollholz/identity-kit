# Changelog `@vollholz/platform`

Alle Änderungen dieses Pakets, die eine App betreffen. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Breaking = Major.

Abschnitte je Version: **Breaking** (mit Migrationsschritten für Apps), **Hinzugefügt**, **Geändert**, **Entfernt**,
**Behoben**. Regel: keine neue Version ohne Eintrag hier (Prüfung in der CI, `scripts/changelog.ts`); der Abschnitt
der Version ist der Text des GitHub Release zum Tag `platform-v<version>`.

## [Unveröffentlicht]

## [0.7.0] – 2026-10-28

### Hinzugefügt

- `EmptyAsNull(X)`: wie `Nullable(X)`, dazu `""` als `null`, wo X `""` ablehnt (leere Felder aus Formularen, z. B.
  Datum). Nur `""`, nie 0 oder `false`. OpenAPI: dritter Zweig `{ allOf: [{ const: "" }, { type: "null" }] }`.

### Behoben

- `Nullable(X)` machte mit `coerceTypes` aus **ungültigen** Eingaben `null` statt 400: Der letzte Zweig
  `{ type: 'null' }` (seit 0.6.2, davor `anyOf [X, null]` gleich) wandelt 0, `""` und `false` in null, wenn X sie
  ablehnt. Beispiele: `Nullable(Integer({ minimum: 1 }))` mit 0, `Nullable(Object)` mit `""`, `Nullable(DateTime)` mit
  `""`. In einer App entfernte so `""` einen Eintrag oder hiess «ohne Grenze». Neu `anyOf [{ const: null }, X]`:
  genau X (mit dessen Umwandlung und Ablehnung) und zusätzlich `null`.

  Vorher (0.6.3) → nachher, nur die Abweichungen (alle anderen Eingaben unverändert):

  | X | Eingabe | 0.6.3 | 0.7.0 |
  |---|---|---|---|
  | Number, Integer, Boolean, Literal | `""` | null | 400 |
  | Integer `minimum: 1` | 0, `"0"`, `false`, `""` | null | 400 |
  | String `minLength: 1` | `""` | null | 400 |
  | DateTime, Uuid | `""` | null | 400 |
  | Object | 0, `false`, `""` | null | 400 |

  Migration: Schickt ein Client `""` für «leer» (Formulare, z. B. Datum), dort `EmptyAsNull` statt `Nullable`; dann
  wieder `""` → null, aber 0 und `false` weiterhin 400. Sonst ist nichts zu tun. OpenAPI: der Zweig `{ type: "null" }`
  entfällt (`anyOf [{ enum: [null] }, X]`), erzeugte Typen bleiben `X | null`.

## [0.6.3] – 2026-10-28

### Behoben

- `Nullable` (seit 0.6.2) mit `Value.Check`, `Value.Errors` und dem TypeCompiler von TypeBox: Der Zweig `{ const: null }`
  hatte die Kind «Unsafe», TypeBox warf «Unknown type» (in einer App mit `Value.Check` auf ein Schema mit `Nullable`:
  500). Neu eigene Kind `NullExakt` in der TypeRegistry (prüft `=== null`); TypeBox liefert für jede Eingabe dasselbe
  Ergebnis wie AJV (ohne Umwandlung) und wie vor 0.6.2. OpenAPI unverändert. Voraussetzung: die App
  benutzt dieselbe Kopie von `@sinclair/typebox` wie dieses Paket (0.34.52; `npm ls @sinclair/typebox`), sonst kennt
  ihre TypeRegistry die Kind nicht.

## [0.6.2] – 2026-10-28

### Behoben

- `Nullable(X)` mit `coerceTypes` (Plattform): `anyOf [X, null]` machte aus `null` den Wert von X, wenn er dort
  gültig ist (0, `""`, `false`, `[""]`). Ein PATCH mit `wert: null` speicherte so 0 (CSPAG/ppm #159). Neu
  `anyOf [{ const: null }, X, { type: 'null' }]`: `null` bleibt `null`, alle anderen Eingaben wie bisher (Umwandlung,
  Ablehnung, `""` → `null` bei Zahl und Datum). Achtung: «null zuerst» (`Type.Union([Type.Null(), X])`) hilft nicht.
  AJV wandelt dann 0, `""` und `false` in `null` um. Wer das als lokale Korrektur hat, nimmt stattdessen `Nullable` aus
  diesem Paket.

### Geändert

- OpenAPI: Jedes `Nullable` hat vorne einen Zweig `{ "enum": [null] }` (aus `const: null`), also
  `anyOf [{ enum: [null] }, X, { type: null }]`. Aus der Doku erzeugte Typen bleiben `X | null`.

## [0.6.1] – 2026-10-28

### Behoben

- Start der API wuchs mit Routen × gemeinsamen Schemas (`app.addSchema`): Fastify baut je Route den Antwort-Serialisierer,
  und fast-json-stringify prüfte dabei jedes Mal alle gemeinsamen Schemas neu (in Apps mit vielen Modulen 30 bis 80 s
  bis «Server listening», `/readyz` so lange 503; auch jeder `testApi()` zahlte das). `fastifyOptions` setzt jetzt
  `schemaController.compilersFactory.buildSerializer`: Der erste Serialisierer prüft alle gemeinsamen Schemas wie
  bisher, jeder weitere bekommt nur die Schemas, auf die er über `$ref` (auch mittelbar) verweist; lässt sich ein
  Verweis nicht eindeutig zuordnen, alle wie bisher. Gleicher erzeugter Code, gleiche Antworten und Filterung
  (`additionalProperties`), gleiche Fehler bei ungültigen Schemas. Messung: 100 gemeinsame Schemas und 400 Routen
  19,8 s → 1,8 s; Test-App des Pakets (81 Routen, 19 Schemas) `testApi()` 2,4 s → 1,3 s. Für die App nichts zu tun.

## [0.6.0] – 2026-10-28

### Breaking

- Setzt `@vollholz/iam` 5.0.0 voraus (Peer `^5.0.0`).
  Migration: `@vollholz/iam` auf 5.0.0 anheben und dessen Breaking-Schritte umsetzen (Recht `roles:admin`, Migration
  `iam_019`, Modul `roles`). Eigene Rollen schaltet die App im Modell ab (`definePlatform` mit
  `defineModel({ …, features: { customRoles: false } })`).

## [0.5.0] – 2026-10-28

### Breaking

- Setzt `@vollholz/iam` 4.0.0 voraus (Peer `^4.0.0`).
  Migration: `@vollholz/iam` auf 4.0.0 anheben und dessen Breaking-Schritte umsetzen (`events` als Objekt).

### Hinzugefügt

- `AppSpec.iamEvents`: Haken der App an den Baukasten (`events` von `@vollholz/iam`: `member.removing` darf das
  Entfernen ablehnen, `member.removed`, `access.granted`, `access.revoked`, `access.expired`, `member.left`).
  `defineApp` gibt sie an `createIam` der API, an die Verwaltung im Worker (`JobContext.admin`) und an den Abgleich
  (`MemberSync`); `PlatformApp.iamEvents`. Outbox: `` after: (tx, e) => platform.emit(tx, `iam.${e.type}`, e.subject, e.data) ``.
- `startMemberSync(…, events)`, `RunMigrationsOptions.ssl`, `PlatformApp.migrate(adminUrl, { log, ssl })` (die Form mit
  `log` als Funktion gilt weiter).

### Behoben

- Befehle `migrate`, `tenant` und `rotate-keys` (`runCli`) verbinden mit TLS nach `DATABASE_SSL` (bzw.
  `DATABASE_SSL_FILE`) wie API und Worker; bisher ohne TLS, eine Datenbank nur mit `hostssl` lehnte ab. Ungültiger Wert:
  Exit 78. Hinweis: Mit `verify-full` muss das Zertifikat prüfbar sein.

## [0.4.0] – 2026-10-27

Stand bis 0.4.0, ohne Einzelnachweis. Frühere Versionen: Tags `platform-v*` und Hinweise im README des Pakets.
