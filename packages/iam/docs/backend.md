# `@vollholz/iam` in einer App

Leitfaden für Apps, die Anmeldung, Mandanten und Rechte über `@vollholz/iam` beziehen. Den Vertrag beschreibt die
[Spezifikation](https://github.com/vollholz/identity-kit/blob/main/docs/spezifikation.md), die Festlegungen des Pakets
der [Entwurf](https://github.com/vollholz/identity-kit/blob/main/packages/iam/docs/entwurf.md). Die Beispiele
nutzen das Produkt `notes`.

## 1. Einbinden

`.npmrc` mit `@vollholz:registry=https://npm.pkg.github.com` und einem Zugang mit `read:packages`, dann:

```sh
npm install @vollholz/iam fastify @fastify/cookie pg
npm install -D @vollholz/iam-testkit
```

Node 24, ESM. `@opentelemetry/api` ist optional; ist es installiert, setzt das Plugin das Span-Attribut `iam.tenant`.

## 2. Katalog

Der Katalog ist die einzige Quelle für Rechte, Rollen, Scopes und Zugriffsregeln der App (Spez. Kap. 8):

```ts
import { defineCatalog } from '@vollholz/iam';

export const catalog = defineCatalog({
  product: 'notes',
  permissions: {
    'note:read': { label: 'Notizen lesen', group: 'notes', description: 'Notizen sehen.', resources: ['tenant', 'folder', 'note'] },
    'note:write': { label: 'Notizen ändern', group: 'notes', description: 'Notizen anlegen und ändern.', resources: ['tenant', 'folder', 'note'] },
  },
  groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }],
  roles: { viewer: { label: 'Leser:in', description: 'Liest Notizen der Organisation.', permissions: ['tenant:read', 'note:read'] } },
  scopes: { 'notes:read': { text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] }, 'notes:write': { text: 'Notizen ändern', permissions: ['note:write'] } },
  resources: { folder: { label: 'Ordner' }, note: { label: 'Notiz', leaf: true } },
});
```

- `org-admin` und die reservierten Rechte (`tenant:read`, `members:admin`, `acl:read`, `acl:admin` …) ergänzt das Paket.
- `catalog.platformJson()` ergibt `infra/keycloak/platform.json` für das Realm-Modul und `iam-org-bootstrap`.
- Mit `resources` gibt es Zugriffsregeln (Modul `acl`). Die Kette der Ressourcen liefert die App als `ResourceModel`
  (`flatResources` für einfache Fälle).
- Einen geprüften Katalog sichert der Test `checkCatalog(GET /v1/authz/catalog)` aus dem Test-Kit.

**Eigene Rollen und `members:admin`.** Organisationen legen eigene Rollen mit Rechten aus `customRolePermissions` an,
ohne Teilmengenregel. Wer `members:admin` über eine vordefinierte Rolle ohne org-admin hat, kann deshalb eine eigene
Rolle mit allen diesen Rechten anlegen und sich selbst geben. `members:admin` also nur Rollen geben, denen alle
`customRolePermissions` zustehen dürfen. Ein Recht, das keine vordefinierte Rolle ausser org-admin hat, gilt als
`adminOnly` und ist in eigenen Rollen nie erlaubt.

## 3. Konfiguration

Nur Umgebungsvariablen (Spez. Kap. 13), Geheimnisse auch als `…_FILE`:

```ts
import { iamWarnings, loadIamConfig } from '@vollholz/iam';

const cfg = loadIamConfig(process.env, { product: 'notes', service: 'api' }); // 'api' | 'worker' | 'mcp'
for (const w of iamWarnings(cfg, 'api')) log.warn(w);
```

`IAM_VARS('notes')` liefert alle Variablen mit Standardwerten und Beschreibung (für die Doku der App). Pflicht hängt vom
Dienst ab; Client-Geheimnisse statt Schlüsseln ergeben Warnungen.

## 4. Datenbank

- Rollen nach Spez. 10.1 mit der Vorlage `db/bootstrap.sql` (psql-Variablen `p`, `db`, Passwörter).
- Migrationen: zuerst die des Pakets, dann die der App. Tabellen der App mit `tenant_id` erhalten RLS automatisch.

```ts
import { dirMigrations, iamMigrations, migrate } from '@vollholz/iam';

await migrate(cfg.db.adminUrl!, [
  iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'folder', 'note'], leafTypes: ['note'] }),
  dirMigrations('db/migrations'),
]);
```

**Übernahme bestehender Objekte** (App mit eigenen IAM-Tabellen, z. B. Assets): `adopted` trägt die IAM-Migrationen bis
`IAM_BASELINE` und die zugeordneten späteren nur ein, nach geprüften Vorbedingungen (sonst Abbruch ohne Eintrag). Für
Assets mit 051–053:

```ts
import { ASSETS_ADOPTION } from '@vollholz/iam';

await migrate(cfg.db.adminUrl!, [
  dirMigrations('db/migrations'),
  iamMigrations({ product: 'assets', resourceTypes: […], leafTypes: ['object'], adopted: ASSETS_ADOPTION }),
  // = { after: '053_acl_unique.sql', map: { '051_revoke_public_execute.sql': 'iam_010_revoke_public_execute.sql',
  //     '052_resolve_tenant_strict.sql': 'iam_011_resolve_tenant_strict.sql', '053_acl_unique.sql': 'iam_012_acl_unique.sql' } }
]);
```

Die IAM-Migrationen laufen direkt nach `after`; ausgeführt werden nur `iam_009` und neuere IAM-Migrationen (ab 0.2.0 auch `iam_013`).

## 5. API

```ts
import swagger from '@fastify/swagger';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { createIam, createPool, IAM_API_TAGS, iamPlugin, need, optionalBodies, pgAudit, readinessChecks } from '@vollholz/iam';

const app = Fastify({
  logger: true,
  // Unbekannte Felder ergeben 422 statt still zu verschwinden (die Schemas des Pakets sind `additionalProperties: false`)
  ajv: { customOptions: { removeAdditional: false } },
});
const iam = createIam({ cfg, catalog, db: createPool(cfg.db.url, cfg, 'notes-api'), schema: 'notes', resources, audit: pgAudit({ schema: 'notes' }), events });

await app.register(rateLimit, { global: false });                       // wirkt für Routen mit config.rateLimit
await app.register(swagger, { openapi: { tags: [...IAM_API_TAGS] }, transformObject: optionalBodies });
await app.register(iamPlugin, { iam, publicPaths: ['/v1/openapi.json', '/v1/docs', '/v1/docs/*'], people: { permissions: ['note:read'] } });

app.get('/v1/notes/:id', { preHandler: need('note:read', r => ({ type: 'note', id: (r.params as { id: string }).id })) }, async req =>
  req.tx(tx => notes.get(tx, (req.params as { id: string }).id)));
```

**Einstellungen, die das Paket voraussetzt:**

- **`ajv.customOptions.removeAdditional: false`** (wie Assets; die Tests des Pakets laufen so). Der Fastify-Standard
  entfernt unbekannte Felder still; mit dieser Einstellung ergeben sie 422, und Tippfehler der Oberfläche fallen auf.
  Ohne sie öffnet sich nichts (entfernte Felder geben keine Rechte, die Schemas des Pakets kennen keine Varianten von
  Objekten, bei denen Entfernen den Sinn änderte), aber falsch geschriebene optionale Felder wirken stumm nicht, etwa
  bei `PATCH`. Die erste Anfrage prüft die Einstellung und warnt sonst im Log.
- **`@fastify/rate-limit`** registriert die App, nicht das Paket. Routen des Pakets tragen ihr Limit in `config.rateLimit`
  (Personensuche in Entra ID: 30 je Minute, Schlüssel `<produkt>:entra-search:<mandant>:<person>`). Ohne das Plugin gilt
  kein Limit. Für mehrere Instanzen einen geteilten Speicher verwenden, z. B. `pgRateLimitStore`.
- **`@fastify/swagger` vor dem Plugin** registrieren, mit `transformObject: optionalBodies`, damit optionale Bodies
  (`…/suspend`, `…/resume`) als optional erscheinen.

**Was das Plugin bringt:** Anmeldung je Anfrage (Bearer, DPoP, mTLS, Sitzung mit CSRF), `req.principal`, `req.tx`
(Mandantenkontext, RLS), `req.need`, `req.needSomewhere`, `req.can`, `req.capabilities`, `req.audit`, Fehler als
problem+json und die Module:

| Modul | Routen | Voraussetzung |
|---|---|---|
| `account` | `GET /v1/me`, `GET /v1/authz/catalog` | – |
| `acl` | `/v1/acl…` | Katalog mit `resources` |
| `admin` | `/v1/admin/status`, `/v1/admin/members…`, `/v1/platform/organizations…` | `KEYCLOAK_MGMT_CLIENT_ID`, sonst 503 |
| `entra` | `/v1/admin/entra…`, `…/members/entra…`, öffentlich `/v1/entra/handover/*` | Verwaltung (sonst 503); eigene App der Organisation braucht `ENCRYPTION_KEYS`, die App der Plattform `ENTRA_CLIENT_ID` (optional, sonst 409 `platform-app-disabled`) |
| `roles` | `/v1/roles…` | – (Gruppen und Anzahl Personen nur mit Verwaltung) |
| `bff` | `/auth/*` | `OIDC_BFF_CLIENT_SECRET` bzw. `…_PRIVATE_KEY` |
| `clients` | `/v1/admin/clients…`, `…/organizations/:alias/clients…` | – |
| `people` | `/v1/people…` | ein Recht, das das Verzeichnis öffnet |

- **`people.permissions`**: Rechte, von denen eines irgendwo das Personenverzeichnis öffnet. Standard sind die Fachrechte
  des Lese-Scopes `<produkt>:read` und `acl:read`. Unbekannte Rechte brechen den Start ab; vorbehaltene wie `tenant:read`
  (hat jedes Mitglied) ergeben eine Warnung. Öffnet ohne Option kein Recht das Verzeichnis, fehlt das Modul mit Warnung.
- **`modules`** wählt die Module ausdrücklich, **`openapi`** ersetzt Tags, Texte und Feldbeschreibungen.
- **`events`** (`createIam`): Ereignisse wie `acl.changed` in derselben Transaktion, z. B. für eine Outbox der App.
- **`readinessChecks(iam)`** für `/readyz` (Datenbank, Anmeldedienst).
- **Mehrere Instanzen:** `SHARED_STATE=postgres` (Standard) hält Replay-Schutz für DPoP und Logout-Tokens sowie das
  Rate-Limit (`pgRateLimitStore`) über alle Instanzen; `memory` nur für eine einzelne Instanz. Teilen sich mehrere
  Umgebungen denselben Speicher (z. B. E2E und lokale App), trennt `RATE_LIMIT_NAMESPACE` ihre Zähler: Die Schlüssel
  des Pakets lauten dann `<namespace>:<produkt>:…`.

## 6. Worker

```ts
import { MemberSync } from '@vollholz/iam';

const sync = new MemberSync(cfg, pool, { schema: 'notes', log: (m, d) => log.info(d, m) });
sync.start();                // alle MEMBER_SYNC_INTERVAL, höchstens ein Lauf über alle Instanzen (LOCKS.memberSync)
process.on('SIGTERM', () => void sync.stop());
```

Der Abgleich nutzt den eigenen Lese-Client `KEYCLOAK_SYNC_*`, nicht den Verwaltungs-Client der API.

## 7. MCP-Dienst (KANN)

Das Paket bringt Anmeldung und Token-Tausch; Server und Werkzeuge baut die App (z. B. mit `@modelcontextprotocol/sdk`).

```ts
import Fastify from 'fastify';
import { DpopSigner, loadIamConfig, McpAuth, OidcProvider, registerMcpAuth, TokenExchanger, TokenVerifier } from '@vollholz/iam';

const cfg = loadIamConfig(process.env, { product: 'notes', service: 'mcp' });
const provider = new OidcProvider(cfg.oidc.issuer);
const exchanger = new TokenExchanger(cfg, provider, { dpop: await DpopSigner.create(cfg.mcp.dpopKey), catalog });
const auth = new McpAuth({ cfg, catalog, verifier: new TokenVerifier(provider, cfg), exchanger, allowedOrigins: [] });

// Tokens und Proofs nie ins Log
const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.dpop'] } });
registerMcpAuth(app, auth);                   // Metadaten (RFC 9728); ersetzt den Error-Handler (Fehler als JSON-RPC)
// GET und DELETE mit registrieren: authorize antwortet darauf mit 405 (zustandslos, nur POST) statt 404
app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler: async (req, reply) => {
  const { orgs, scopes } = await auth.authorize(req);   // 401/403 mit Challenge, Organisation(en) mit API-Client und Rechten
  const server = buildServer(orgs, scopes);             // Werkzeuge der App, Aufrufe nur über orgs[i].api (REST-API)
  // … Transport des SDK (reply.hijack(), Antwort über reply.raw)
} });
```

- Nur Tokens der Hosts aus `MCP_HOST_CLIENT_IDS`; gebundene Tokens von Maschinen-Clients ergeben 403.
- Organisation über `X-Tenant` oder `?org=`; ohne Wahl lädt `authorize` alle Organisationen im Token. Verlangt die API
  eine Wahl, entsteht Fehler -32602 mit der eigenen Liste.
- API-Tokens sind DPoP-gebunden an `MCP_DPOP_KEY`. Ohne Schlüssel erzeugt jede Instanz einen eigenen.
- Getauschte Tokens werden bis kurz vor Ablauf zwischengespeichert (höchstens 10 000), die Rechte je Token und
  Mandant 60 s.
- `allowedOrigins`: weitere Browser-Ursprünge neben dem von `MCP_PUBLIC_URL` (Schutz gegen DNS-Rebinding).

## 8. Betrieb

**Ersteinrichtung einer Organisation** (idempotent; danach verwaltet org-admin die Mitglieder in der Oberfläche):

```sh
KEYCLOAK_TF_URL=https://identity.example.ch KEYCLOAK_TF_REALM=notes KEYCLOAK_IAC_PRIVATE_KEY_B64=… \
  npx iam-org-bootstrap --catalog infra/keycloak/platform.json --alias solutions --name "Solutions" \
  --email anna@example.ch --first Anna --last Admin [--roles org-admin] [--platform-admin] [--initial-password] [--dry-run]
```

- Die Anmeldung läuft über den Service Account `<realm>-iac` (`private_key_jwt`, realm-admin).
- `--initial-password` setzt nur ohne bestehendes Passwort ein temporäres und legt es ausschliesslich in
  `~/.identity/initial-password-<realm>-<e-mail>.txt` ab (0600). Programmatisch: `orgBootstrap(keycloakAdmin, …)`.

Mandanten über alle Organisationen: `listTenants`, `createTenant`, `setTenantStatus`, `relinkTenant`. `relinkTenant` ist
nicht atomar (Personen, Organisations-ID und Protokoll in drei Transaktionen): Scheitert das Protokoll, ist der Mandant
umgehängt ohne Eintrag `tenant.relinked` – den Eintrag dann von Hand nachtragen.

**Anmeldung über Microsoft Entra ID mit eigener App der Organisation (Modul `entra`, ab 0.3).** Der Normalfall: Jede
Organisation registriert eine App in ihrem eigenen Tenant und trägt Tenant, Anwendungs-ID und Geheimnis ein
(`PUT …/entra/app`, oder die Kunden-IT über einen Link mit `kind: 'credentials'`, öffentlich
`POST /v1/entra/handover/credentials`). Die Plattform braucht dafür keine eigene Entra-App, nur `ENCRYPTION_KEYS`:

- Vor dem Speichern prüft das Paket bei Microsoft: Token der App im Tenant (Client Credentials), erteilte
  Anwendungsberechtigungen (`roles` im Token), Organisation und verifizierte Domänen. Fehler mit `reason`:
  `invalid-secret`, `secret-expired`, `wrong-tenant`, `invalid-client`, `missing-permissions` (mit `missing`).
- Anleitung für die Kunden-IT im Status (`ownApp`): Umleitungs-URI `<OIDC_ISSUER_URL>/broker/entra-app-<alias>/endpoint`
  (Plattform «Web», Kontotyp «Nur Konten in diesem Organisationsverzeichnis»), delegiert `User.Read`, Anwendung
  `Organization.Read.All`, `User.Read.All` und `Application.Read.All` mit Administratorzustimmung. `Application.Read.All`
  ist Pflicht: Das Paket weist damit nach, dass die App im Tenant registriert ist (`GET /applications(appId=…)` gibt
  sie nur im Heimat-Tenant; die mandantenfähige App eines Herstellers, der der Tenant zugestimmt hat, ergibt 409
  `app-not-registered-in-tenant`), und liest den Ablauf des Geheimnisses (sonst `secretExpiresAt` bei der Eingabe).
  Der Status warnt 30 Tage vorher (`secretExpiresSoon`); Wechsel: erneut `PUT …/app` mit dem neuen Geheimnis, Stufe und
  Domänen bleiben. Nach dem Verbinden verfallen übrige offene Links für die eigene App (`superseded`).
- Das Geheimnis liegt verschlüsselt in `entra_connection.app_secret_enc` (Migration `iam_014`, AAD an Mandant und App)
  und im Anbieter in Keycloak, nie in einer Antwort oder im Protokoll. Beim Wechsel der Hauptschlüssel ruft das
  Rotationsskript der App je Mandant `rewrapEntraSecrets(tx, keys, { schema })` auf.
- Eine Organisation, die mit einer eigenen App verbunden ist, wechselt zur App der Plattform nur über Trennen (409
  `own-app`). Ohne `ENTRA_CLIENT_ID` antworten Zustimmung und Links mit Zustimmung mit 409 `platform-app-disabled`.
- **Neu anbinden statt übernehmen:** Einen von Hand angelegten Entra-Anbieter vor dem Neuverbinden in Keycloak löschen
  (samt Zuordnung der Domänen an der Organisation). Die Konten bleiben; beim Verbinden verknüpft das Paket die Mitglieder
  der gebundenen Domänen über die Objekt-ID mit dem neuen Anbieter. Eine erste Anmeldung ohne Verknüpfung legt nie ein
  Konto an (Erstanmeldung verweigert); wer später dazukommt, über «Person aus Entra ID hinzufügen».

**Anmeldung über die App der Plattform (optional, `ENTRA_CLIENT_ID`).** Einmal je Produkt eine mandantenfähige App in
Entra ID; die Kunden stimmen ihr zu:

- Redirect-URIs: `<PUBLIC_BASE_URL><ENTRA_UI_PATH>/zustimmung` und die Plätze `entra-NNN` des Realms
  (`brokerRedirectUris`, `ENTRA_IDP_SLOTS`).
- Berechtigungen in Microsoft Graph (wie Assets `docs/einrichtung.md`): delegiert `User.Read` (Keycloak liest bei der
  Anmeldung `/me`), Anwendung `Organization.Read.All` (Organisation und verifizierte Domänen, `GET /organization`),
  Anwendung `User.Read.All` (`GET /users` mit `$filter`/`$search`, `GET /users/{id}`: Personen finden und verknüpfen).
  Weitere Aufrufe gibt es nicht (kein `/domains`, die Domänen kommen aus `/organization`). Kunden stimmen beim Verbinden allen zu (`.default`); kommt
  später eine dazu, müssen sie erneut verbinden.
- **Gruppen-Claim mit Verzeichnisrollen** (`groupMembershipClaims` mit `DirectoryRole`; Portal: Token configuration ›
  groups claim › Directory roles). Ohne diesen Claim fehlt `wids` im ID-Token, und Verbinden scheitert mit 409
  `consent-unproven`: Die Zustimmung gilt nur mit Nachweis einer globalen Administration oder «Privileged Role
  Administrator» des Tenants.
- **Link an die Entra-Administration (0.2):** Muss eine andere Person der Kunden-IT zustimmen, erzeugt die org-admin
  einen Link (`POST …/entra/consent-links`). Die Oberfläche braucht dafür die öffentliche Seite
  `<ENTRA_UI_PATH>/freigabe` (Token im Fragment, ruft `/v1/entra/handover/info` und `…/start`); die Rückkehrseite
  `…/zustimmung` ruft bei `state` mit `h.` den öffentlichen `…/handover/complete`. Die Routen sind im Plugin öffentlich;
  `@fastify/rate-limit` der App begrenzt sie auf 20 je Minute und IP (ohne das Plugin warnt der Start). Hinter einem
  Reverse Proxy `trustProxy` von Fastify passend setzen (z. B. Anzahl Proxys), sonst zählt das Limit die Adresse des
  Proxys für alle Anfragen bzw. eine gefälschte `X-Forwarded-For`.
  **Verträglichkeit:** Links funktionieren erst mit `@vollholz/iam-web` ab 0.2 (Seite `…/freigabe`, Rückkehr mit
  `h.`-state). Mit älterer Oberfläche keine Links erzeugen: Die Adresse führte auf eine fehlende Seite, und die
  Rückkehrseite schickte den `state` an `…/consent/complete` (dort 404, nichts verbunden).
  Offene Links verfallen, wenn die erzeugende Person entfernt wird oder `members:admin` verliert (Plattform-Links: die
  Realm-Rolle) und beim Trennen der Verbindung; geprüft auch beim Start und bei der Rückkehr. Solange die Organisation
  gesperrt ist, gilt kein Link (404).

## 9. Tests

`@vollholz/iam-testkit`: Wegwerf-Datenbank (`testDatabases`), Mock-IdP mit Token Exchange und DPoP, `claimsFor`,
`KeycloakFake`, `EntraFake`, RLS-Prüfungen, `checkCatalog` und das Gerüst für den Isolations-Durchlauf über alle Routen
(`routeCollector`, `installProbes`, `leaks` …). Die Tests des Pakets mit der Beispiel-App «notes» zeigen den Einsatz.
