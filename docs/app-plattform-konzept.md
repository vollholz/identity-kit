# Konzept: App-Plattform als Bausteine statt Gerüst aus Prosa

Stand 2026-10-26, Entwurf, mit Inventar (Abschnitt 13). Grundlage: erste Anwendung der Boilerplate-Spezifikation (`vollholz/assets` ›
`docs/konzepte/app-boilerplate.md`) auf die App `nachtschicht` (vollholz/nachtschicht#1) und die Zonen des
identity-kit (Spezifikation [1.2](spezifikation.md#12-zonen-fest-einstellbar-app-eigen)).

## Inhalt

1. [Entscheid in einem Satz](#1-entscheid-in-einem-satz)
2. [Ausgangslage](#2-ausgangslage)
3. [Zielbild: vier Formen](#3-zielbild-vier-formen)
4. [Pakete](#4-pakete)
5. [Fertige Module](#5-fertige-module)
6. [Verwaltete Dateien](#6-verwaltete-dateien)
7. [OpenTofu-Module](#7-opentofu-module)
8. [Was in der App bleibt](#8-was-in-der-app-bleibt)
9. [Versionen und Qualität](#9-versionen-und-qualität)
10. [Umsetzungsplan](#10-umsetzungsplan)
11. [Offene Entscheidungen](#11-offene-entscheidungen)
12. [Bewusst nicht gebaut](#12-bewusst-nicht-gebaut)
13. [Inventar Assets – nachtschicht](#13-inventar-assets--nachtschicht)

---

## 1. Entscheid in einem Satz

**Was in jeder App gleich ist, kommt wie Anmeldung und Rechte aus dem Kit – als Paket, fertiges Modul, verwaltete Datei
oder OpenTofu-Modul; die App enthält nur ihr Modell, ihre Fachmodule und deren Oberfläche.**

Eine neue App entsteht dann mit einem Befehl und ist sofort grün:

```sh
npx @vollholz/create-app init --product vertraege --name Verträge --url https://vertraege.project-suite.ch \
    --keycloak https://id.project-suite.ch --profile mcp,outbox,hetzner
```

## 2. Ausgangslage

Die Boilerplate-Spezifikation beschreibt das Gerüst in Prosa; Claude baut es je App neu. Bei `nachtschicht` ergab das
226 Dateien, rund 45 000 Zeilen (davon gut 9 700 erzeugt). Fachlich ist davon wenig:

| Bereich (nachtschicht) | Zeilen | Art |
|---|---:|---|
| `src/platform/` ohne Fachmodul (config, core, db, http, worker, ops, mcp, main, Auslieferung) | ~1 800 | gleich in jeder App |
| `scripts/` (dev-env, keycloak-setup, Prüfskripte, Export, Rotation …) | ~770 | gleich |
| `test/platform/` ohne Fachtest | ~1 100 | gleich (bis auf Matrix und Fälle) |
| `web/src/` shell, ui, api, auth, styles (ohne erzeugtes Schema) | ~900 | gleich |
| Dockerfile, `deploy/`, `infra/hetzner`, `infra/dns`, Workflows, dependency-cruiser | ~2 450 | gleich bis auf Namen |
| Modul `webhooks` mit Migration | ~290 | fachneutral, optional |
| **Fachlich:** Modell, Ressourcen, Modul `schichtart`, Migration, Feature der Webapp, Fachtest | **~1 100** | app-eigen |

Folgen des heutigen Wegs:

- **Teuer und uneinheitlich:** Jede App ist eine neue Auslegung derselben Prosa.
- **Keine Updates:** Ein Fehler im Gerüst muss in jeder App einzeln behoben werden. Beispiele aus der ersten
  Anwendung: feste Frist bei Webhook-Abrufen, `apk upgrade` gegen Trivy-Befunde, `COPY --chmod` nur oktal,
  `NODE_EXTRA_CA_CERTS` in Kubernetes, `@types/node` im Webapp-Paket. Fast alle CI-Fehler des ersten Laufs lagen im
  Gerüst, nicht im Fachlichen.
- **Doppelte Arbeit zum Kit:** Vieles im Gerüst umhüllt nur `@vollholz/iam` (Konfiguration, Pool, Fehler, Audit).

## 3. Zielbild: vier Formen

Die Form richtet sich danach, wie stark eine App den Teil anpasst – dieselbe Logik wie die Zonen des Kits.

| Form | Für | Zone | Aktualisierung |
|---|---|---|---|
| **Paket** (npm) | Code, den die App aufruft | Fest | Renovate, Gruppe «identity-kit» |
| **Fertiges Modul** (npm, mit Migrationen) | fachneutrale Funktion, nicht in jeder App | Fest, eingeschaltet je App | Renovate |
| **Verwaltete Datei** (Generator) | Dateien, die nicht importierbar sind (Dockerfile, CI, Compose …) | Fest, Werte aus dem Manifest | `create-app sync` mit Lock-Datei |
| **OpenTofu-Modul** | Infrastruktur je App | Fest, Variablen je App | Git-Tag |

Einstellungen gehören ins Manifest (heute `identity.app.json`, künftig um `app` erweitert), App-Eigenes ins Repository
der App – wie heute beim Realm.

## 4. Pakete

### 4.1 `@vollholz/platform` (Backend)

Baut auf `@vollholz/iam` auf und ersetzt `src/platform/` der Apps bis auf die Fachmodule. Unterpfade statt eines
grossen Einstiegs, damit die Modulgrenzen der App weiter prüfbar bleiben:

| Unterpfad | Inhalt (Herkunft nachtschicht) | Was die App liefert |
|---|---|---|
| `/config` | Variablenliste auf `IAM_VARS`, Prüfungen, `configOrExit` (Exit 78), Generator für `.env.example` und `docs/konfiguration.md` | `APP_VARS` |
| `/http` | `buildApp` (Logger, Request-ID, Helmet, CSP, Rate-Limit, OpenAPI 3.1, IAM-Plugin, Idempotenz, Problem-JSON, Metriken), route-kit, Auslieferung der Webapp, OpenAPI-Export | Module, Tags |
| `/worker` | Warteschlange (`enqueue`, `Worker`, `JobDefinition`, `PeriodicTask`), Outbox-Verteilung, Aufbewahrung, Mitgliederabgleich | Jobs, Abnehmer |
| `/core` | Umschlagverschlüsselung (`seal`/`unseal`/`reseal`), `safeRequest` mit SSRF-Schutz und fester Frist, Redaction, `emit` | – |
| `/ops` | Preload für OpenTelemetry, Betriebs-Endpunkt, geordnetes Beenden, Metriken, Mandanten-CLI, Schlüsselrotation | Rewrapper der Module |
| `/mcp` | MCP-Dienst (Streamable HTTP, Anmeldung und Token Exchange aus `@vollholz/iam`) | Werkzeuge |
| `/migrations` | `001_core` (Warteschlange, Idempotenz, Outbox) als Quelle wie `iamMigrations`: Grundform nachtschicht (uuid, CHECKs, `expires_at`, `correlation_id`), dazu aus Assets 044 Folgenummer je Mandant (`tenant_seq`, `outbox_sequence`), getrennte Rechte von `_sched` (lesen über alle, schreiben nur im Kontext), Indizes für Fairness, aus 011 die Purge-Policies | eigene Migrationen ab `002`; Assets eine Übernahmemarke |

Einstiegspunkte der App:

```ts
// src/main/api.ts
import { startApi } from '@vollholz/platform/http';
import { app } from '../app.ts';
await startApi(app);

// src/app.ts – die einzige Beschreibung der App für alle Prozesse
import { defineApp } from '@vollholz/platform';
import { webhooks } from '@vollholz/webhooks';
import { model, resources } from './authz/index.ts';
import { vertrag } from './modules/vertrag/index.ts';
export const app = defineApp({
  product: 'vertraege', model, resources, vars: APP_VARS,
  modules: [vertrag, webhooks()],            // Routen, Jobs, Migrationen, MCP-Werkzeuge, Rewrapper je Modul
  tags: [{ name: 'Verträge', description: '…' }],
});
```

`defineApp` prüft beim Start, was heute Tests und Reviews fanden: jede Route genau ein Tag, jedes MCP-Werkzeug des
Modells mit Umsetzung, jede Tabelle mit `tenant_id` im RLS-Inventar.

Ein Modul der App beschreibt sich selbst (heute verteilt auf `modules/index.ts`, `modules/jobs.ts`, Migrationen):

```ts
export const vertrag = defineModule({
  name: 'vertrag', tag: 'Verträge',
  routes: registerRoutes, jobs: [fristJob], migrations: dirMigrations(new URL('./sql', import.meta.url)),
  mcpTools: { list_vertraege: listTool }, rls: { vertrag: seedVertrag },     // Testdaten für die RLS-Matrix
});
```

### 4.2 `@vollholz/platform-testkit`

Baut auf `@vollholz/iam-testkit` auf; fertige Suiten statt kopierter Tests:

| Baustein | Ersetzt (nachtschicht) | Was die App liefert |
|---|---|---|
| `createTestDb(app)`, `testApi(app)` | `harness.ts`, `api.ts` | – |
| `rlsSuite(app)` | `rls.test.ts` (Vollständigkeit, Matrix, entfernte Policy, Prüfungen des Test-Kits) | Testdaten je Tabelle (aus `defineModule`) |
| `isolationSuite(app, cases)` | `tenant-isolation.test.ts` | Fälle je Route |
| `httpSuite(app)` | `problems.test.ts`, `webui.test.ts`, `csp.test.ts`, `config.test.ts`, `ops.test.ts`, `worker.test.ts` | – |
| `mcpSuite(app)` | `mcp.test.ts` (Assets auch `mcp-dpop.test.ts`) | Werkzeuge und erwartete Rechte aus dem Modell |
| `retentionSuite(app)` | `retention.test.ts` (Assets) | Aufbewahrungsziele der Module |

### 4.3 `@vollholz/app-web` (Oberfläche)

Neben `@vollholz/iam-web`: AppShell mit Rail und Befehlspalette, Schublade und Dialog mit Fokusfalle, Zustände,
API-Client (CSRF, Problem-JSON, 401, Idempotency-Key, `If-Match`), Farb-Tokens hell/dunkel mit `--iam-*`, `theme.js`,
Textprüfung (Du-Form, ohne ß, «Organisation»), ESLint-Konfiguration, Playwright-Hilfen mit axe. Die App liefert
`features/`, Routen und Texte.

## 5. Fertige Module

Fachneutrale Funktionen, die nicht jede App braucht, als Paket mit Routen, Migrationen, Rechten, Worker-Aufgaben,
Tests und Teilen für die Oberfläche. Eingebunden mit einer Zeile in `defineApp`.

| Modul | Inhalt | Belegt durch |
|---|---|---|
| `@vollholz/webhooks` | Funktionsumfang und Schema aus Assets (Pausieren, Gesundheit, Rotation mit Vorgänger, Test-Ping, Zustellprotokoll, Wiederzustellung, Reihenfolge je Objekt, Ereignisdaten in der Zustellung), Struktur aus nachtschicht (`OutboxConsumer`, `Rewrapper`, `seal` mit Zweck, UNIQUE je Abo und Ereignis); die App liefert Ereigniskatalog, Filter-Hook und Ordering-Key | nachtschicht, Assets |
| später `@vollholz/attachments` | Dateischicht aus Assets `discussion` (BlobStore FS/S3, Stromverschlüsselung, Typerkennung, Viren-Scan, verwaiste Dateien) mit generischem Bezug `(resource_type, resource_id)` | nur Assets – wartet auf eine zweite App |
| später `@vollholz/assistant` | KI-Kern aus Assets (LLM-Port, Agent, Budget und Limits, Gespräche); Werkzeuge liefert die App | nur Assets – wartet auf eine zweite App |
| nicht | Reports, Ansichten, Katalog, Integrationen, Konnektoren, Credentials: an den Katalog gebunden | bleiben in Assets |

Regel: Ein Modul wandert erst ins Kit, wenn zwei Apps es gleich brauchen. Fachliches bleibt immer in der App.

## 6. Verwaltete Dateien

Ein Generator `@vollholz/create-app` (Erweiterung von `create-iam-app`, gleicher Mechanismus: Kopf «Verwaltet von
identity-kit», `.identity-kit.lock`, `sync`, `check`) legt an und hält aktuell:

| Datei | Werte aus dem Manifest |
|---|---|
| `Dockerfile`, `deploy/docker-entrypoint.sh` | Produkt, Profile (`mcp`) |
| `deploy/compose.dev.yaml`, `compose.prod.yaml`, `compose.image.yaml`, `caddy/Caddyfile` | Domain, Ports, Profile |
| `deploy/k8s/` (Kustomize-Basis) | Produkt, Profile; Umgebung im Overlay der App |
| `.github/workflows/ci.yml`, `deploy.yml`, `infra.yml` | Profile, Registry |
| `renovate.json`, `.dependency-cruiser.cjs` (Basisregeln, App-Regeln per `extends`), `tsconfig.base.json` | – |
| `scripts/` als `bin` von `@vollholz/platform` (`platform dev-env`, `platform keycloak-setup`, `platform check-network` …) | – |

Damit werden die Lehren der ersten Anwendung einmal behoben und mit `sync` überall wirksam.

## 7. OpenTofu-Module

| Modul | Inhalt | Variablen der App |
|---|---|---|
| `modules/hetzner-app` | Basis Assets: Netz, Firewalls, Primary IPs v4/v6, rDNS, Placement Group, App-VM, DB-VM (eigenes PG-Image, pgBackRest/PITR, Restore-Test), Buckets mit Versionierung und Kopie, Cloud-Init mit Prüfsummen; dazu `delete_protection` aus nachtschicht. Rollout-Skript mit cosign-Prüfung auf der VM als verwaltete Datei | Produkt, Standort, Grössen, SSH-Schlüssel, Domains, Bucket-Präfix, Backup-Plan |
| `modules/dns` | A, AAAA, CAA (und `www`) der Domain bei Hostpoint (E7) | Zone, Name, Adressen |

Versioniert wie `product-realm` (`?ref=<modul>-vX.Y.Z`); die App hat nur `infra/hetzner/main.tf` mit dem Aufruf.

## 8. Was in der App bleibt

```text
<app>/
├── identity.app.json  .identity-kit.lock     Manifest (Profile, Domain, Keycloak, Betrieb) und Lock-Datei
├── src/
│   ├── app.ts                                defineApp
│   ├── main/api.ts, worker.ts, (mcp.ts)      je drei Zeilen
│   ├── authz/model.ts, resources.ts          Modell und Kette der Orte
│   └── modules/<x>/                          Fachmodule mit sql/, routes, store, jobs, mcp
├── test/                                     Fachtests, Fälle der Isolation, Testdaten der RLS-Matrix
├── web/src/features/<x>/, routes.ts, texts   Fachliche Oberfläche
├── infra/keycloak, infra/hetzner             Aufrufe der Module
└── docs/                                     Fachliche Doku, offene Punkte
```

Für nachtschicht wären das rund 1 100 Zeilen fachlich plus wenige Dutzend Zeilen Verdrahtung.

## 9. Versionen und Qualität

- **Semantische Versionen** je Paket und Modul, Migrationshinweise im README (wie `@vollholz/iam`). Unterstützt werden
  aktuelle und vorherige Hauptversion; `iam-conformity-test` meldet ältere.
- **Test-App im Kit:** Ein Workflow erzeugt nächtlich und in jedem PR des Kits mit `create-app init` eine App mit allen
  Profilen und führt `npm run check`, Image-Build mit Rauchtest, Trivy, OSV und `iam-conformity-test --all` aus. Ein
  Fehler im Gerüst fällt so im Kit auf, nicht in einer App.
- **Konformität erweitert:** `iam-conformity-test` prüft zusätzlich verwaltete Dateien von `create-app`, Versionen der
  Plattform-Pakete und `defineApp` (Tags, Werkzeuge, RLS-Inventar).
- Pakete exakt gepinnt, Mindestalter 14 Tage, Gruppe «identity-kit» in Renovate ohne Automerge.

## 10. Umsetzungsplan

| # | Schritt | Ergebnis |
|---|---|---|
| 1 | Inventar Assets gegen nachtschicht (nur lesend, siehe 11) – **erledigt, Abschnitt 13** | Liste je Baustein: Paket, Modul, verwaltet, App |
| 1a | Sofort-Korrekturen in beiden Apps (13.6), unabhängig vom Kit | je App ein PR |
| 2 | `@vollholz/platform` 0.1 aus nachtschicht herauslösen (`/config`, `/core`, `/http`, `/worker`, `/ops`, `/mcp`, `/migrations`); nachtschicht stellt um | nachtschicht nur noch Fachliches, CI grün |
| 3 | `@vollholz/platform-testkit` mit den Suiten; nachtschicht stellt um | Tests der App auf Fachliches reduziert |
| 4 | `create-app` mit verwalteten Dateien und Test-App im Kit | neue App mit einem Befehl, nächtlich geprüft |
| 5 | `@vollholz/app-web` | Oberfläche der App nur Features |
| 6 | `@vollholz/webhooks` als erstes fertiges Modul | Profil `outbox` ohne Code in der App |
| 7 | OpenTofu-Module `hetzner-app`, `dns` | Infrastruktur je App als Aufruf |
| 8 | Assets schrittweise umstellen (je Teil ein PR, Reihenfolge nach Nutzen) | eine Codebasis für beide |
| 9 | Boilerplate-Spezifikation ersetzen durch Doku von `create-app` und `defineApp` | keine Prosa-Generierung mehr |

Schritt 2 bis 4 sind der Kern; danach lohnt sich jede weitere App sofort.

## 11. Offene Entscheidungen

| Nr. | Frage | Stand |
|---|---|---|
| E1 | Eigene Pakete oder Teil von `@vollholz/iam`? | **Entschieden (2026-10-26): eigenes Paket.** `iam` bleibt Anmeldung und Rechte, `platform` baut darauf auf |
| E2 | Ein Generator oder `create-iam-app` erweitern? | **Entschieden (2026-10-26): Nachfolger.** `create-app` ersetzt `create-iam-app`; Apps nur mit IAM nutzen `create-app` ohne Plattform-Profil |
| E3 | Welche Module aus Assets sind fachneutral genug (Anhänge, Diskussion, Reports, Integrationen)? | Inventar in Schritt 1 (nur lesender Zugriff auf Assets, siehe unten); Regel «zwei Apps» |
| E4 | Wie weit darf eine App vom Gerüst abweichen? | Abweichung nur über Manifest oder `extends`; sonst Änderung im Kit |
| E5 | Wo liegt die Webapp-Shell: im Kit oder als Vorlage der App? | Kit (`app-web`), Branding über Tokens und Texte |
| E6 | Bleibt die Lizenz Apache-2.0 auch für `platform`? | ja, wie die übrigen Pakete |
| E7 | DNS-Anbieter des Moduls `dns` | **Entschieden (2026-10-26): Hostpoint** für die Domains der Apps; die Domain der Identität (Keycloak) bleibt wie gehabt. Offen: ob Hostpoint eine API für DNS-Einträge bietet – sonst verwaltetes Skript bzw. Anleitung statt OpenTofu-Modul |
| E8 | Namen der Variablen und Tokens vereinheitlichen | **Entschieden (2026-10-26):** CSS-Tokens nach Assets (grösserer Satz), Variablen nach nachtschicht (kürzer, nach `IAM_VARS`); Assets liest während des Übergangs alte und neue Namen und warnt bei alten |
| E9 | Bleibt If-Match Pflicht (428, nachtschicht) oder optional (Assets)? | Pflicht für neue Routen; Assets per Option je Route, bis die Oberfläche überall ETags mitschickt |

**Inventar (Schritt 1):** Vergleich des Codes von Assets mit nachtschicht, Datei für Datei, nur lesend – in Assets
ändert sich dabei nichts. Ergebnis ist eine Tabelle in diesem Dokument (neuer Abschnitt «Inventar»):

| Spalte | Inhalt |
|---|---|
| Datei bzw. Baustein | z. B. `src/platform/http/app.ts`, `modules/attachments/` |
| Gleich / abweichend / nur in einer App | mit Begründung der Abweichung (Fachbezug, ältere Lösung, bewusste Ausnahme) |
| Form im Kit | Paket (Unterpfad), fertiges Modul, verwaltete Datei, OpenTofu-Modul, bleibt in der App |
| Aufwand und Risiko der Umstellung je App | klein / mittel / gross |

Daraus folgen die Grenzen von `@vollholz/platform` 0.1 und die Kandidaten für fertige Module (E3). Geschrieben wird in
Assets erst in Schritt 8, je Teil ein PR.

## 12. Bewusst nicht gebaut

- Kein Framework, das Fachlogik vorgibt: Module der App bleiben gewöhnliche Fastify-Routen mit `req.need`, `req.tx`.
- Keine Laufzeit-Plugins oder Modul-Registry über Netzwerk; Module sind Pakete zur Build-Zeit.
- Kein Monorepo der Apps: jede App behält ihr Repository, ihre Releases und ihren Betrieb.
- Kein automatisches Umstellen bestehender Apps: Assets wechselt schrittweise per PR.

## 13. Inventar Assets – nachtschicht

Stand 2026-10-26, gelesen in `vollholz/assets` (`cf5b8f6`) und `vollholz/nachtschicht` (`main`), ohne Änderungen.

### 13.1 Mengen

| Bereich | Assets | nachtschicht | Bemerkung |
|---|---:|---:|---|
| `src/platform` ohne Module | 4 136 | 1 754 | in Assets rund 1 300 Zeilen Kopien aus `@vollholz/iam` und 320 fachlich (`core/objects.ts`) |
| `src/platform/modules` | 19 984 | 640 | fachlich bis auf Webhooks und Auslieferung der Webapp |
| `db/migrations` | 2 680 (49 Dateien) | 197 | in Assets viel Übernahme-Geschichte |
| `test` | 25 093 | 1 246 | in Assets ~3 500 Zeilen plattformbezogen, ~2 000 durch Suiten ersetzbar |
| `scripts` | 3 356 | 770 | |
| `web/src` ohne erzeugtes Schema | ~18 500 | ~900 | in Assets ~2 700 Zeilen Shell, UI, Stile |
| Lieferung (`deploy`, `infra`, Workflows) | 6 217 | 3 092 | |

### 13.2 Backend-Plattform

| Baustein | Status | Form im Kit (Basis) | Aufwand Assets |
|---|---|---|---|
| Konfiguration | abweichend: Assets führt die ~55 IAM-Variablen selbst (schon auseinandergelaufen: Prüfung von `ENTRA_UI_PATH` fehlt) | `/config` mit `IAM_VARS` + `APP_VARS` (nachtschicht); `serviceOf()`, `OPS_HOST`, `MCP_HOST`, `CORS_ORIGINS`, `OTEL_EXPORTER_OTLP_HEADERS` aus Assets | gross (Namen, Form `cfg.app`) |
| Pool, `withTx`, `withTenant`, Audit, Verschlüsselung, geteilter Zustand, Problem-JSON, `requestPath`, `readinessChecks`, Cursor/ETag | in Assets Kopien aus `@vollholz/iam` (Pool ohne Verwerfen bei gescheitertem ROLLBACK) | entfällt – direkt `@vollholz/iam`; `readingAll` aus Assets ins Kit | klein bis mittel (78 Aufrufe `full: true/false`) |
| `buildApp` | abweichend | `/http` (nachtschicht) plus aus Assets: Prüfung am dekodierten Pfad, 429 als problem+json, `securitySchemes`, Doku-CSP, Span-Attribute | gross |
| Idempotenz | abweichend: Assets mit Wettlauf (SELECT dann INSERT), ohne Ablauf und ohne `ETag`/`Location` bei Wiederholung | `/http` (nachtschicht) plus `oneTimeSecret` (Assets) | mittel (Tabelle) |
| SSRF | abweichend: Assets breiter (Weiterleitungen, erlaubte Hosts, private Hosts je Mandant, NAT64/6to4), nachtschicht mit Gesamtfrist | `/core`: Umfang Assets plus Gesamtfrist nachtschicht | mittel |
| Warteschlange | abweichend: Assets reifer (Stapel mit fairem CTE, Timeout und AbortSignal je Job, Freigabe beim Beenden, Span je Job, `drain()`) | `/worker`: Kern Assets plus `PeriodicTask`, Streuung, `JobContext` aus nachtschicht | gross (Tabelle `job`, Vertrag der Handler) |
| Outbox-Verteilung | Assets im Modul Webhooks, nachtschicht generisch (`OutboxConsumer`) | `/worker` (nachtschicht) | mittel |
| Aufbewahrung | Assets in Stapeln mit SKIP LOCKED, aber mit fachlichen Tabellen | `/worker` mit Zielen, die Module anmelden | mittel |
| Telemetrie, Metriken | Assets mit `import-in-the-middle`, Warteschlangen-Gauges; nachtschicht mit Semconv-Namen | `/ops` aus beiden | mittel |
| Betriebs-Endpunkt, Beenden | nachtschicht mit Frist für Prüfungen, injizierbarem Exit | `/ops` (nachtschicht) | klein |
| Rotation, Mandanten-CLI | Assets zentral mit Modul-Importen, nachtschicht mit `Rewrapper` je Modul | `/ops` (nachtschicht) plus `dryRun`, `relinkTenant`, Löschen unter RLS (Assets) | mittel |
| MCP | Assets-Rahmen reifer (`organisationen_auflisten`, Enum der Organisation, `toolError`, `outputSchema`, `instructions`, `/readyz`) | `/mcp`: Rahmen Assets, Prüfung «Werkzeug ohne Umsetzung» und leere Liste aus nachtschicht | mittel |

### 13.3 Module und Daten

- **Fertiges Modul jetzt:** nur Webhooks (Abschnitt 5). Assets fachlich stärker, nachtschicht in der Struktur besser.
- **Später (eine App):** Anhänge, Assistent. **Nicht:** Reports, Ansichten, Katalog, Integrationen, Konnektoren, Credentials
  (Ziel immer `assets.object`). `seal` aus Credentials entspricht `/core`.
- **Auslieferung der Webapp:** in `/http`; aus Assets CSP-Hashes, Prüfung am dekodierten Pfad, CORP, problem+json; aus
  nachtschicht `safePath`, `webDistDir`, 503 in Produktion.
- **Migrationen:** Kern siehe 4.1; Assets braucht eine Übernahme-Migration (`bigint`→`uuid`, `fanned_out_at`→`dispatched_at`),
  kein reines Eintragen.
- **Tests:** Suiten siehe 4.2; die App behält Testdaten der RLS-Matrix, Fälle der Isolation und erwartete Policies.
- **Skripte:** als `bin` von `@vollholz/platform` (dev-env, keycloak-setup, check-network mit AST aus Assets,
  check-address mit AST aus Assets und Regeln aus nachtschicht, env-docs, openapi-export, smoke, tenant, rotate-keys,
  e2e-db, migrate, schema-compare); Demo-Daten und Übernahme-Skripte bleiben in der App.

### 13.4 Oberfläche

| Baustein | Basis fürs Kit | Aufwand Assets |
|---|---|---|
| Overlay mit Fokusfalle, Zustände, `MenuButton`, `Picker`, `Markdown`, `format`, `prefs`, `useClearanceCache`, `requires()`, Router-Adapter | Assets | klein |
| AppShell, Rail, Befehlspalette | Assets-Darstellung, nachtschicht-Generik (Slots, `nav`, `sources`) | mittel |
| Farb-Tokens | Namenssatz Assets (grösser), Marke über Werte | mittel bis gross (E8) |
| Toasts | eine API in iam-web mit `action` und `error()` | klein |
| API-Client | gemeinsamer Kern (`iamMiddleware`), Helfer aus beiden | klein |
| Textprüfung | AST aus Assets, Regeln (ß, Sie-Form, «Organisation») aus nachtschicht – Assets prüft heute weder ß noch Sie-Form | klein |
| ESLint, Vite, tsconfig | Basis nachtschicht (`--max-warnings 0`, fetch nur gleiche Herkunft) plus a11y-Ausnahmen aus Assets | klein |
| Playwright | Projekte hell/dunkel/schmal (nachtschicht), eigene E2E-DB, `webServer`, Anmeldung je Person (Assets) | mittel |
| Weitere generische Bausteine aus Assets-Features | `PanelFrame`/`StepBar`/`Act`, Copy/Code/Cards, barrierefreie Diagramme, `FilterBar`, später `DataGrid` | klein je Baustein |

### 13.5 Lieferung

| Baustein | Basis fürs Kit | Aufwand Assets |
|---|---|---|
| Dockerfile, Entrypoint | nachtschicht (`--chmod=0555`, Benutzer `app`, Exit 64 für Unbekanntes, Preload für alle) plus Assets (`$BUILDPLATFORM`, `--ignore-scripts`) | klein |
| Compose dev/image/prod, Caddy | **eine** Produktionsdatei (Assets hat zwei, die Referenz ist veraltet); Caddy aus beiden | mittel |
| k8s-Basis | Assets (HPA, topologySpread, DNS-Egress) plus nachtschicht (Secret je Dienst, `private_key_jwt`, `NODE_EXTRA_CA_CERTS`) | mittel |
| Hetzner | Assets als Basis von `hetzner-app` (7) | gross, wenn vereinheitlicht |
| CI | Jobs aus beiden: arm64-Rauchtest, DinD-Test (Assets); Konformität mit `db/ci-org.sql`, shellcheck, strenger Rauchtest (nachtschicht) | mittel |
| Renovate | Preset im Kit: Modul-Tags (Assets), `hostRules`, `ARG NODE_IMAGE`, OSV (nachtschicht) | klein |
| Keycloak | Assets nutzt noch eigene Dateien: Umstellung auf `identity.app.json` und `sync`, `moved.tf` bleibt App-Datei; der Plan darf nichts ändern | klein bis mittel |

### 13.6 Sofort-Korrekturen (unabhängig vom Kit)

| App | Befund | Quelle |
|---|---|---|
| nachtschicht | Rate-Limit und Idempotenz prüfen den rohen `req.url`: `/%761/…` erreicht die Route, gilt aber als Oberfläche (weder begrenzt noch idempotent) | Vergleich mit Assets `isUiRequest` und IAM `requestPath` |
| nachtschicht | Aufbewahrung löscht verteilte Outbox-Ereignisse; `ON DELETE CASCADE` löscht offene Zustellungen mit, wenn `OUTBOX_RETENTION` kürzer ist als das Fenster der Wiederholungen | Assets 011 |
| nachtschicht | `_sched` darf in allen Mandanten schreiben (`sched_all`); Folgenummer je Mandant fehlt | Assets 044 |
| Assets | Idempotenz: Wettlauf, abgelaufene Schlüssel, stilles `.catch()` | nachtschicht `http/idempotency.ts` |
| Assets | `guardedFetch` begrenzt die Zeit nur bis zu den Headern; Webhook-Versand kann einen Abbruch im Body als Erfolg werten (`send.ts`) – prüfen | nachtschicht `core/ssrf.ts` |
| Assets | eigene `@fastify/cookie`-Registrierung, fehlendes `iamWarnings`, Worker-Logs ohne Redaction | nachtschicht `main/*.ts` |
| Assets | k8s und Referenz-Compose noch mit Client-Secrets und ohne `NODE_EXTRA_CA_CERTS`; Textprüfung ohne ß und Sie-Form | nachtschicht |
