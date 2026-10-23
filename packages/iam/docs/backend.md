# `@vollholz/iam` in einer App

Leitfaden für Apps, die Anmeldung, Mandanten und Rechte über `@vollholz/iam` beziehen. Den Vertrag beschreibt die
[Spezifikation](../../../docs/spezifikation.md), die Festlegungen des Pakets der [Entwurf](entwurf.md). Die Beispiele
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

- **`ajv.customOptions.removeAdditional: false`** (wie Assets). Der Fastify-Standard entfernt unbekannte Felder still; mit
  dieser Einstellung ergeben sie 422, und Tippfehler der Oberfläche fallen auf.
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
| `entra` | `/v1/admin/entra…`, `…/members/entra…` | Verwaltung und `ENTRA_CLIENT_ID`, sonst 503 |
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
import { DpopSigner, McpAuth, OidcProvider, registerMcpAuth, TokenExchanger, TokenVerifier } from '@vollholz/iam';

const cfg = loadIamConfig(process.env, { product: 'notes', service: 'mcp' });
const provider = new OidcProvider(cfg.oidc.issuer);
const exchanger = new TokenExchanger(cfg, provider, { dpop: await DpopSigner.create(cfg.mcp.dpopKey), catalog });
const auth = new McpAuth({ cfg, catalog, verifier: new TokenVerifier(provider, cfg), exchanger });

const app = Fastify();
registerMcpAuth(app, auth);                   // Metadaten (RFC 9728) und Fehler als JSON-RPC
app.post('/mcp', async (req, reply) => {
  const { orgs, scopes } = await auth.authorize(req);   // 401/403 mit Challenge, Organisation(en) mit API-Client und Rechten
  const server = buildServer(orgs, scopes);             // Werkzeuge der App, Aufrufe nur über orgs[i].api (REST-API)
  // … Transport des SDK
});
```

- Nur Tokens der Hosts aus `MCP_HOST_CLIENT_IDS`; gebundene Tokens von Maschinen-Clients ergeben 403.
- Organisation über `X-Tenant` oder `?org=`; ohne Wahl lädt `authorize` alle Organisationen im Token. Verlangt die API
  eine Wahl, entsteht Fehler -32602 mit der eigenen Liste.
- API-Tokens sind DPoP-gebunden an `MCP_DPOP_KEY`. Ohne Schlüssel erzeugt jede Instanz einen eigenen.
- Getauschte Tokens werden bis kurz vor Ablauf zwischengespeichert, die Rechte je Token und Mandant 60 s.

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

Mandanten über alle Organisationen: `listTenants`, `createTenant`, `setTenantStatus`, `relinkTenant`.

**Anmeldung über Microsoft Entra ID (Modul `entra`).** Einmal je Produkt eine mandantenfähige App in Entra ID:

- Redirect-URIs: `<PUBLIC_BASE_URL><ENTRA_UI_PATH>/zustimmung` und die Plätze `entra-NNN` des Realms
  (`brokerRedirectUris`, `ENTRA_IDP_SLOTS`).
- Berechtigungen in Microsoft Graph (wie Assets `docs/einrichtung.md`): delegiert `User.Read` (Keycloak liest bei der
  Anmeldung `/me`), Anwendung `Organization.Read.All` (Organisation und verifizierte Domänen, `GET /organization`),
  Anwendung `User.Read.All` (Personen finden und verknüpfen). Kunden stimmen beim Verbinden allen zu (`.default`); kommt
  später eine dazu, müssen sie erneut verbinden.
- **Gruppen-Claim mit Verzeichnisrollen** (`groupMembershipClaims` mit `DirectoryRole`; Portal: Token configuration ›
  groups claim › Directory roles). Ohne diesen Claim fehlt `wids` im ID-Token, und Verbinden scheitert mit 409
  `consent-unproven`: Die Zustimmung gilt nur mit Nachweis einer globalen Administration oder «Privileged Role
  Administrator» des Tenants.

## 9. Tests

`@vollholz/iam-testkit`: Wegwerf-Datenbank (`testDatabases`), Mock-IdP mit Token Exchange und DPoP, `claimsFor`,
`KeycloakFake`, `EntraFake`, RLS-Prüfungen, `checkCatalog` und das Gerüst für den Isolations-Durchlauf über alle Routen
(`routeCollector`, `installProbes`, `leaks` …). Die Tests des Pakets mit der Beispiel-App «notes» zeigen den Einsatz.
