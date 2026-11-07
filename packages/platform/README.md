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
| `definePlatform` | Kontext der App (Produkt, Schema, Rollen, Titel, Präfix der Ereignisse) mit Modell und Ressourcen; gebundene Bausteine für die Module: `record` (optional mit `subject`), `auditSearch`, `emit`, `enqueue`, `fullTx`, `seal`/`unseal`/`reseal`, `audit`; Rückfall der Suche nach Person: `audit.subjectFallback` |
| `defineModule` | Fachmodul: Routen, öffentliche Routen mit Token (`publicRoutes`), Tags der API-Doku, Jobs, feste Aufgaben, Abnehmer der Outbox, Rotation eigener Geheimnisse, MCP-Werkzeuge; Produktmodul `modul` (siehe unten) |
| `defineApp` | Kompositionswurzel: Konfiguration (`IAM_VARS` + Plattform + App, Exit 78), API (Fastify, OpenAPI 3.1, Rate-Limit, Idempotenz, CSP, Oberfläche mit SPA-Fallback), Worker, MCP-Dienst, Migrationen, OpenAPI-Export, `.env.example` und Doku der Konfiguration, Mandanten, Rotation |
| `startApi`, `startWorker`, `startMcp`, `runCli` | Prozesse mit Betriebs-Endpunkt (`/healthz`, `/readyz`, `/metrics`) und geordnetem Beenden; Befehle `migrate`, `tenant …`, `rotate-keys` |
| `PublicRoute`, `publicToken`, `publicTokenHash`, `aliasToken`, `publicNotFound` | Öffentliche Routen ohne Sitzung (z. B. Kalender-Abo): Organisation aus dem Alias, Kontext genau dieser Organisation, Lesesicht der Person des Tokens, Rate-Limit je IP, einheitlich 404 (siehe unten) |
| `createMailer`, `smtpMailer`, `protokollMailer`, `MailError` | E-Mail-Versand nach `MAIL_ADAPTER`: SMTP mit TLS-Pflicht, Zeitlimit und Schutz gegen Header-Injection; «protokoll» für Entwicklung und Tests (siehe unten) |
| `safeRequest`, `resolveTarget`, `isPublicAddress` | Abrufe an Adressen aus Daten mit SSRF-Schutz, fester Frist und begrenzter Antwort; Inhalt als Text oder Bytes |
| `migrations/platform_001_core.sql` | Warteschlange (`job`), Idempotenz (`idempotency_key`), Outbox (`outbox_event`) mit RLS; Scheduler liest über alle Mandanten und schreibt mit gesetztem Kontext nur dort |
| `migrations/platform_002_job_skipped.sql` | Status `skipped` und Spalte `result` der Warteschlange (Aufträge inaktiver Produktmodule) |
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
  // Haken an den Baukasten (optional): in API, Worker (ctx.admin) und Abgleich gleich, je in der Transaktion der Änderung
  iamEvents: {
    before: async (tx, e) => { /* member.removing: ablehnen mit throw conflict('…', { reason: '…' }) */ },
    after: (tx, e) => platform.emit(tx, `iam.${e.type}`, e.subject, e.data),   // in die Outbox der App
  },
});
```

`iamEvents` sind die `events` von `@vollholz/iam` ([Ereignisse und Haken](../iam/docs/backend.md#ereignisse-und-haken-events)):
`member.removing` vor dem Entfernen eines Mitglieds (darf ablehnen, 409 als problem+json), danach `member.removed`,
je Rolle an einem Ort `access.granted`/`access.revoked`, aus dem Abgleich `member.left` und `access.expired`.
`defineApp` gibt sie an `createIam` der API und der Verwaltung im Worker sowie an `MemberSync`.

Die Befehle `migrate`, `tenant` und `rotate-keys` verbinden mit TLS nach `DATABASE_SSL` (`disable`, `require`,
`verify-full`) wie API und Worker; ein `sslmode` in der Adresse gilt weiterhin vorrangig.

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

### Produktmodule je Organisation

Mit `modules` im Modell (`defineModel({ modules, packages })`, [Konzept](../../docs/module-je-organisation.md)) setzt
die Plattform durch, was eine Organisation aktiviert hat. Ohne `modules` ändert sich nichts.

```ts
export const schichtplanungModule = defineModule({
  name: 'schichtplanung',
  modul: 'schichtplanung',                    // Pflicht mit modules im Modell (sonst Fehler beim Start)
  register: app => {
    app.get('/v1/plaene', { schema: { … } }, …);                                    // Modul des Code-Moduls
    app.get('/v1/boerse', { config: { modul: 'schichtplanung.boerse' }, schema: { … } }, …);   // Teilfunktion
  },
  jobs: [planJob], tasks: [aufraeumen], consumers: [webhook],  // ohne eigenes modul: das des Code-Moduls
});

export const app = defineApp({
  platform, modules: [kernModule, schichtplanungModule],
  moduleHooks: {
    abwesenheiten: {
      einrichten: (tx, tenantId) => absenzartenStandard(tx),          // erstes Aktivieren, in der Transaktion
      hindernisse: (tx, tenantId) => offeneAntraege(tx),              // vor dem Deaktivieren: [{ key, text, anzahl? }] → 409
      nachholen: (tx, tenantId, seit) => tageNeuBerechnen(tx, seit),  // erneutes Aktivieren: Auftrag im Worker
    },
  },
});
```

| Ort | Wirkung, wenn das Modul in der Organisation nicht aktiv ist |
|---|---|
| Routen | 403 problem+json `reason: 'modul-inaktiv'`, `modul`, `detail` «Das Modul ‹…› ist in deiner Organisation nicht aktiv.» – nach der Anmeldung, vor Rechten und Validierung (Zwischenspeicher `iam.access.modulesOf`) |
| Öffentliche Routen | 404 wie ein unbekannter Link (ein 403 verriete ohne gültiges Token, dass es die Organisation gibt) |
| Jobs | Auftrag endet `skipped` mit `result: { modul: 'inaktiv' }`, ohne Fehler und ohne neuen Versuch |
| Feste Aufgaben | `ctx.tenants()` liefert nur Organisationen, in denen das Modul der Aufgabe aktiv ist (ohne Modul: alle nicht gesperrten) |
| Outbox | Abnehmer mit Modul erhalten Ereignisse solcher Organisationen nicht; verteilt sind sie trotzdem |
| MCP | `tools/list` ohne die Werkzeuge (`modules` aus `GET /v1/me`); Rechte inaktiver Module fehlen ohnehin |
| OpenAPI | je Route `x-modul`; die Beschreibung des Tags nennt das Produktmodul |

- `checkModules(modules, model)` (in `defineApp`): jedes `modul` existiert im Verzeichnis (Modul oder `modul.teil`),
  Routen mit unbekanntem `config.modul` scheitern beim Einhängen; Module ohne Code, Job oder Recht ergeben eine Warnung
  (`app.warnings`, beim Start von API und Worker im Log).
- `moduleHooks` gehen an `createIam` (API, Worker, Befehle). `nachholen` läuft nicht in der Transaktion des Aktivierens:
  dort reiht die Plattform den Auftrag `platform.module-nachholen` ein (höchstens einer offen je Modul), den der Worker
  mit dem Haken der App ausführt (`seit` = letztes Deaktivieren; inzwischen wieder inaktiv: ohne Wirkung).
- Befehle (Betrieb): `tenant create <alias> --paket <key>` legt nur die Module des Pakets erlaubt und aktiv an
  (`einrichten` je Modul, `off`-Teilfunktionen erlaubt und aus; ohne Paket wie bisher alles beim ersten Laden);
  `tenant modules <alias>` listet, `--erlauben a,b` gibt frei (aktiviert nichts), `--entziehen c` entzieht (deaktiviert
  mit; `--force` übergeht Hindernisse), `--paket <key>` wendet ein Paket erneut an (andere Module entzogen),
  `--nur-erlauben` lässt aktiv unverändert. Unbekanntes Paket oder Modul: Exit 64. Alles in einer Transaktion, mit
  Audit (`tenant.module_allowed`, `tenant.module_active`, `tenant.module_package`) und Ereignissen `module.*`.

### Öffentliche Route mit Token

Für Clients, die sich nicht anmelden können (iCal-Abo, Feed): Das Modul deklariert die Route, das Paket übernimmt
den Querschnitt, das Modul nur die Fachlogik (Token suchen, lesen, Antwort formen).

```ts
import { aliasToken, publicToken, type PublicRoute } from '@vollholz/platform';

export const kalenderAbo: PublicRoute = {
  name: 'kalender-abo',
  url: '/kalender/:datei',                                                  // nie unter /v1/ oder /auth/
  credentials: req => aliasToken((req.params as { datei: string }).datei, { suffix: '.ics' }),   // <alias>.<token>.ics
  scopes: ['nachtschicht:read'],                                            // Rechte der Person ∩ Scope
  rateLimit: { max: 30 },                                                   // je IP und Minute (Standard)
  async handler(ctx, _req, reply) {
    const abo = (await ctx.tx.query('SELECT principal_id FROM nachtschicht.kalender_abo WHERE token_hash = $1', [ctx.tokenHash])).rows[0];
    if (!abo || !(await ctx.viewAs(abo.principal_id))) return null;          // null = 404 wie unbekannt
    const schichten = await ladeSchichten(ctx.tx);                          // jetzt in der Lesesicht der Person
    return reply.type('text/calendar; charset=utf-8').send(ical(schichten));
  },
};
export const kalenderModule = defineModule({ name: 'kalender', publicRoutes: [kalenderAbo], register: … });
// Token ausstellen (eigene Route mit Anmeldung): const { token, hash } = publicToken(); nur `hash` speichern
```

- **Organisation:** `app.resolve_tenant(alias)` ohne Anlegen; unbekannt oder gesperrt ergibt dieselbe Antwort wie
  ein falsches Token.
- **Kontext:** `ctx.tx` läuft im Kontext genau dieser Organisation (RLS `tenant_isolation`) und ohne Lesesicht: Lesbar
  sind nur Tabellen ohne Policies der Lesesicht, z. B. die Tokens des Moduls (Spalten `principal_id`, `token_hash`,
  Fremdschlüssel `(tenant_id, principal_id)` auf `principal`). `ctx.viewAs(principalId)` wechselt für den Rest der
  Transaktion in die Lesesicht der Person (aktiv, nicht entfernt; ohne Gruppen aus Entra, Rechte ∩ `scopes`) und
  liefert `false`, wenn sie nicht mehr Mitglied ist. Über Organisationsgrenzen kommt die Route nie.
- **Token:** `publicToken()` liefert 256 Bit (base64url) und den SHA-256 (`hash`); gespeichert wird nur der Hash, die
  Route sieht nur `ctx.tokenHash`. Format geprüft (base64url, 22–128 Zeichen).
- **Antworten:** `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`; Fehler als
  problem+json mit dem Routenmuster als `instance` (nie die URL mit dem Token). Ungültiges Format, unbekannte oder
  gesperrte Organisation, unbekanntes Token und nicht mehr aktive Person: 404 mit demselben Text (`publicNotFound`).
  Die Laufzeit ist nicht konstant; der Alias ist kein Geheimnis.
- **Rate-Limit** je IP und Route (Standard 30 je Minute), auch ausserhalb von `/v1`; auch 429 und Fehler der
  Validierung als problem+json mit dem Routenmuster. **Log:** Routenmuster statt URL. **Telemetrie:** keine Spur für
  diese Pfade (die Instrumentierung sieht die rohe URL mit dem Token). Pfadteile bis 256 Zeichen (`maxParamLength`).
- In der OpenAPI mit `security: []`; `defineApp` prüft Namen, Pfade und Scopes beim Start.

### E-Mail

```ts
import { createMailer, MailError, PermanentJobError } from '@vollholz/platform';

// in einem Job bzw. einer festen Aufgabe: ctx.mailer (= createMailer(ctx.cfg, ctx.log) des Workers)
try {
  await ctx.mailer.send({ to: 'Anna Muster <anna@example.ch>', subject: 'Einladung', text: '…', html: '<p>…</p>' });
} catch (e) {
  if (e instanceof MailError && e.permanent) throw new PermanentJobError(e.message);   // 5xx, ungültig, nicht eingerichtet
  throw e;                                                                            // 4xx, Netz, Zeitlimit: erneut
}
```

| Variable | Bedeutung |
|---|---|
| `MAIL_ADAPTER` | `aus` (Standard: jeder Versand scheitert dauerhaft), `protokoll` (nur ins Log und in `sent`, in Produktion verboten), `smtp` |
| `MAIL_FROM` | Absender, auch im Umschlag, z. B. `Nachtschicht <noreply@nachtschicht.example.ch>`; bei `smtp` im Worker Pflicht |
| `SMTP_URL` | `smtps://user:pass@host:465` (TLS ab dem ersten Byte) oder `smtp://user:pass@host:587` (STARTTLS Pflicht); Benutzer und Passwort URL-kodiert; geheim, auch als `SMTP_URL_FILE`; bei `smtp` im Worker Pflicht |
| `SMTP_TIMEOUT` | Frist für den ganzen Versand (Standard `30s`) |
| `SMTP_ALLOW_INSECURE` | Nur Entwicklung (z. B. Mailpit): Klartext ohne STARTTLS, Zertifikat ungeprüft; in Produktion verboten |

- **Dienste:** Nur der Worker versendet und verlangt `SMTP_URL` und `MAIL_FROM`. API, MCP und Migration starten ohne
  sie und kennen den Adapter trotzdem (`cfg.app.mail.adapter`, z. B. um anzuzeigen, ob E-Mails versendet werden);
  `createMailer` scheitert dort bei `smtp` dauerhaft (`MailError`). Gesetzte Werte prüft jeder Dienst.
- **TLS:** Zertifikat und Name geprüft, mindestens TLS 1.2; ohne STARTTLS bricht `smtp://` ab, bevor Zugangsdaten
  gesendet werden. Antworten, die vor dem TLS-Handshake eingeschleust werden, brechen ab (STARTTLS-Injection).
- **Anmeldung:** `AUTH PLAIN`, sonst `AUTH LOGIN`; ohne Benutzer in `SMTP_URL` keine Anmeldung.
- **Header-Injection:** Zeilenumbrüche und Steuerzeichen in Adressen, Namen, Betreff und `MAIL_FROM` sind ein Fehler
  (`MailError`, dauerhaft); nichts wird still bereinigt. Adressen nur ASCII; Namen und Betreff sonst als Encoded-Word.
- **Inhalt:** Text, optional HTML (`multipart/alternative`), je UTF-8 in Base64; `Message-ID`, `Date`, `Reply-To`.
- **Fehler:** `MailError` mit `permanent` (5xx, ungültige Nachricht, nicht eingerichtet) und `code` (Antwort des Servers).
- **Tests:** `protokollMailer({ from })` hält die letzten 100 Nachrichten in `sent` (mit dem fertigen Text in `data`).
- Eigener Client auf `node:net`/`node:tls`, ohne zusätzliche Abhängigkeit; ein Versand je Verbindung (kein Pool).

### Verwaltung im Worker

```ts
// Job eines Moduls: Verwaltung von Organisationen und Mitgliedern (AdminService von @vollholz/iam) oder null
if (!ctx.admin) throw new PermanentJobError('Verwaltung nicht eingerichtet (KEYCLOAK_MGMT_CLIENT_ID)');
await ctx.admin.removeMember(scope, memberId);
```

- `ctx.admin` in `JobContext` und im Kontext fester Aufgaben (`PeriodicTask`): `iam.admin` über den Pool des Workers
  (`DATABASE_WORKER_URL`), ohne eigenes `createIam` und ohne eigenen Pool.
- Gebaut, wenn der Worker `KEYCLOAK_MGMT_CLIENT_ID` samt `KEYCLOAK_MGMT_PRIVATE_KEY` oder `KEYCLOAK_MGMT_CLIENT_SECRET`
  (bzw. `_FILE`) erhält; sonst `null`. Ein Worker ohne diese Variablen startet unverändert. `worker bereit` im Log nennt
  `admin` und `mail`. Mit `KEYCLOAK_MGMT_CLIENT_SECRET` statt Schlüssel warnt auch der Worker (ab `@vollholz/iam` 3.2.1).
- Tests: `app.createWorker(cfg, db, log, { iam: { keycloakFetch: kc.fetch } })` mit dem `KeycloakFake` des Test-Kits;
  `new Worker({ …, admin, mailer })` setzt beide direkt (Standard `null` bzw. `createMailer(cfg, log)`).

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

`npm test` im Paket: Test-App «probe» mit den Modulen «notiz» und «bericht» (Produktmodule `notizen` mit Teilfunktion
`abo` und `berichte`, `test/fixture/`) – Produktmodule je Organisation, Konfiguration, Warteschlange, RLS-Matrix
und Policies, Mandantentrennung über die API, problem+json, Pfade, Oberfläche und OpenAPI, MCP mit Token Exchange,
Betrieb und Mandanten, Übernahme der Migrationen. Datenbank-Tests brauchen `POSTGRES_SUPERUSER_PASSWORD` (und
`POSTGRES_PORT`) oder `TEST_POSTGRES_URL`; ohne Datenbank übersprungen, in CI nie.

## Änderungen

Ab 0.5.0 stehen alle Änderungen mit Migrationsschritten in [CHANGELOG.md](CHANGELOG.md).

- **0.4.0:** Worker-Bausteine. `SMTP_URL` und `MAIL_FROM` sind bei `MAIL_ADAPTER=smtp` nur im Dienst `worker` Pflicht
  (`services: ['worker']`); API, MCP und Migration starten ohne sie, `cfg.app.mail.adapter` bleibt überall gesetzt,
  `createMailer` scheitert ohne sie mit `MailError` (dauerhaft) statt mit einem leeren Wert. `JobContext` und der Kontext
  fester Aufgaben bieten `admin` (Verwaltung von `@vollholz/iam` über den Pool des Workers, sofern
  `KEYCLOAK_MGMT_CLIENT_ID` samt Schlüssel bzw. Geheimnis gesetzt ist, sonst `null`) und `mailer` (`createMailer` des
  Workers); `createWorker` nimmt optional `{ iam: { keycloakFetch, … } }`, `Worker` optional `admin` und `mailer`.
  Brechend nur für Code, der `JobContext` oder den Kontext von `PeriodicTask.run` selbst baut (z. B. Tests): dort
  `admin` und `mailer` ergänzen.

- **0.3.0:** E-Mail-Versand als Baustein (`createMailer`, `smtpMailer`, `protokollMailer`, `disabledMailer`,
  `buildMail`, `parseAddress`, `smtpUrlProblems`, `MailError`) mit den Variablen `MAIL_ADAPTER`, `MAIL_FROM`,
  `SMTP_URL`, `SMTP_TIMEOUT`, `SMTP_ALLOW_INSECURE` und `cfg.app.mail`; Standard `aus`, bestehende Apps starten
  unverändert. `safeRequest` nimmt als `body` auch Bytes (`Uint8Array`, `Buffer`) unverändert, z. B. für Web Push
  (`aes128gcm`), und setzt `Content-Length`, sofern die Kopfzeilen keine nennen (bisher `Transfer-Encoding: chunked`).
  Abwärtsverträglich.
- **0.2.0:** Öffentliche Routen mit Token je Modul (`publicRoutes`, `PublicRoute`, `publicToken`, `publicTokenHash`,
  `aliasToken`, `publicNotFound`, `checkPublicRoutes`, `registerPublicRoutes`): Organisation aus dem Alias, Kontext
  dieser Organisation, Lesesicht der Person über `viewAs`, Rate-Limit je IP, einheitlich 404, Token nie im Log und nie in Spuren der Telemetrie;
  `maxParamLength` 256
  (nachtschicht FM-OF-21, Kalender-Abo). Abwärtsverträglich.
- **0.1.1:** Die Erweiterung von Fastify durch `@fastify/swagger` (`tags` in Routen-Schemas, `app.swagger()`) kommt mit
  den Typen des Pakets; Apps brauchen `@fastify/swagger` nicht mehr selbst. Beschreibung von `OUTBOX_RETENTION` nennt
  die Zustellungen der Module. Tests des SSRF-Schutzes im Paket.
- **0.1.0:** erste Fassung, herausgelöst aus nachtschicht.
