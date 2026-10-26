# @vollholz/platform

Querschnitt für Apps auf der Identity-Plattform, herausgelöst aus nachtschicht: Konfiguration, HTTP, Warteschlange und
Outbox in PostgreSQL, Betrieb, MCP-Dienst, Mandanten und Rotation. Anmeldung, Rechte und Mandantentrennung kommen aus
[@vollholz/iam](../iam/README.md); dieses Paket setzt darauf auf und baut daraus die Prozesse einer App.

Konzept: `docs/app-plattform-konzept.md` (Form «Paket», Entscheid E1). Verweise «app-boilerplate N» in den Quellen
meinen Abschnitte der Vorgabe `docs/konzepte/app-boilerplate.md` (Repository vollholz/assets).

> **0.1 – erste Fassung.** Die API kann sich bis 1.0 noch ändern. Webhooks bleiben bis zum eigenen Modul
> (`@vollholz/webhooks`) in der App; ihre Variablen (`WEBHOOK_*`) liefert das Paket schon.

## Inhalt

| Teil | Was |
|---|---|
| `definePlatform` | Kontext der App (Produkt, Schema, Rollen, Titel, Präfix der Ereignisse) mit Modell und Ressourcen; gebundene Bausteine für die Module: `record`, `emit`, `enqueue`, `fullTx`, `seal`/`unseal`/`reseal`, `audit` |
| `defineModule` | Fachmodul: Routen, Tags der API-Doku, Jobs, feste Aufgaben, Abnehmer der Outbox, Rotation eigener Geheimnisse, MCP-Werkzeuge |
| `defineApp` | Kompositionswurzel: Konfiguration (`IAM_VARS` + Plattform + App, Exit 78), API (Fastify, OpenAPI 3.1, Rate-Limit, Idempotenz, CSP, Oberfläche mit SPA-Fallback), Worker, MCP-Dienst, Migrationen, OpenAPI-Export, `.env.example` und Doku der Konfiguration, Mandanten, Rotation |
| `startApi`, `startWorker`, `startMcp`, `runCli` | Prozesse mit Betriebs-Endpunkt (`/healthz`, `/readyz`, `/metrics`) und geordnetem Beenden; Befehle `migrate`, `tenant …`, `rotate-keys` |
| `migrations/platform_001_core.sql` | Warteschlange (`job`), Idempotenz (`idempotency_key`), Outbox (`outbox_event`) mit RLS; Scheduler liest über alle Mandanten und schreibt mit gesetztem Kontext nur dort |
| `@vollholz/platform/preload` | OpenTelemetry (Traces, Metriken über OTLP und/oder Prometheus) vor allen anderen Modulen |

## Verwendung

```ts
// src/platform.ts – von den Modulen importiert
import { definePlatform } from '@vollholz/platform';
import { model } from './authz/model.ts';
import { resources } from './authz/resources.ts';

export const platform = definePlatform({ product: 'nachtschicht', title: 'Nachtschicht', model, resources });
export const { record, enqueue, emit, fullTx, seal, unseal } = platform;
```

```ts
// src/app.ts – Kompositionswurzel
import { join } from 'node:path';
import { defineApp } from '@vollholz/platform';
import { platform } from './platform.ts';
import { schichtartModule } from './modules/schichtart/index.ts';

export const app = defineApp({
  platform,
  modules: [schichtartModule],
  people: { permissions: ['schichtart:read'] },
  migrations: { dir: join(import.meta.dirname, '..', 'db', 'migrations') },
});
```

```ts
// src/cli.ts – Startbefehl des Images: node --import @vollholz/platform/preload src/cli.ts api|worker|mcp|migrate|tenant|rotate-keys
import { runCli } from '@vollholz/platform';
import { app } from './app.ts';

await runCli(app);
```

Ein Modul:

```ts
import { defineModule, type Deps } from '@vollholz/platform';

export const schichtartModule = defineModule({
  name: 'schichtart',
  tags: [{ name: 'Schichtarten', description: 'Wiederverwendbare Schichten mit Zeiten und Klassifizierung.' }],
  register: (app, deps: Deps) => { /* Routen mit req.need, req.tx, record(…), enqueue(…) */ },
  jobs: [nachtarbeitJob],
  mcpTools: { list_schichtarten: { description: '…', input: { … }, call: async (org, a) => … } },
});
```

## Datenbank

Reihenfolge der Migrationen: `@vollholz/iam` (`iam_*`), Plattform (`platform_*`), App (`NNN_*.sql`). Eine App, die
Warteschlange, Idempotenz und Outbox schon aus eigenen Migrationen hat, übernimmt `platform_001_core.sql` mit
`migrations: { dir, adopted: { after: '<letzte eigene Migration dazu>' } }`: Der Runner trägt die Migration nur ein,
wenn Tabellen, RLS (`ENABLE` + `FORCE`) und Policies in der Endform bestehen – eine verbliebene `sched_all`-Policy
(Schreiben über alle Mandanten) bricht ab.

Namen aus dem Kontext statt fest eingebaut: Schema und Rollen (`<ident>_app`, `_sched`, `_owner`), Advisory-Locks
(`hashtext('<product>:claim')`, `<product>:task:<name>`), Namensraum des Rate-Limits (`<product>:api:`), Ableitung der
Datenschlüssel (`<product>/data-key/v1`), CloudEvent-Typ (`ch.<product>.<ding>.<was>`), Dienstname der Telemetrie.
Metriken heissen `platform.job.duration` und `platform.outbox.dispatched` (die App unterscheidet `service.name`).

## Tests

`npm test` im Paket: Test-App «probe» mit Modul «notiz» (`test/fixture/`) – Konfiguration, Warteschlange, RLS-Matrix
und Policies, Mandantentrennung über die API, problem+json, Pfade, Oberfläche und OpenAPI, MCP mit Token Exchange,
Betrieb und Mandanten, Übernahme der Migrationen. Datenbank-Tests brauchen `POSTGRES_SUPERUSER_PASSWORD` (und
`POSTGRES_PORT`) oder `TEST_POSTGRES_URL`; ohne Datenbank übersprungen, in CI nie.

## Änderungen

- **0.1.1:** Die Erweiterung von Fastify durch `@fastify/swagger` (`tags` in Routen-Schemas, `app.swagger()`) kommt mit
  den Typen des Pakets; Apps brauchen `@fastify/swagger` nicht mehr selbst. Beschreibung von `OUTBOX_RETENTION` nennt
  die Zustellungen der Module. Tests des SSRF-Schutzes im Paket.
- **0.1.0:** erste Fassung, herausgelöst aus nachtschicht.
