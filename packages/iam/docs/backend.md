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

## 2. Modell

Das Modell ist die einzige Quelle für Rechte, Rollen, Scopes, Typen und Klassifizierung der App (Spez. Kap. 8):

```ts
import { defineModel } from '@vollholz/iam';

export const model = defineModel({
  product: 'notes',
  permissions: {
    'note:read': { label: 'Notizen lesen', group: 'notes', description: 'Notizen sehen.', resources: ['org', 'folder', 'note'] },
    'note:write': { label: 'Notizen ändern', group: 'notes', description: 'Notizen anlegen und ändern.', resources: ['org', 'folder', 'note'] },
  },
  groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }],
  roles: {
    editor: { label: 'Bearbeiter:in', description: 'Liest und ändert Notizen der Organisation.', permissions: ['tenant:read', 'note:read', 'note:write'] },
    viewer: { label: 'Leser:in', description: 'Liest Notizen der Organisation.', permissions: ['tenant:read', 'note:read'] },
  },
  scopes: { 'notes:read': { text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] }, 'notes:write': { text: 'Notizen ändern', permissions: ['note:write'] } },
  types: {
    folder: { label: 'Ordner', parent: 'org', self: 'folder', roles: ['editor', 'viewer'], read: 'note:read' },
    note: { label: 'Notiz', parent: 'folder', roles: ['editor', 'viewer'], leaf: true, classified: true, read: 'note:read', write: 'note:write' },
  },
  capabilities: { note: { write: 'note:write' } },
});
```

- `org-admin` und die reservierten Rechte (`tenant:read`, `tenant:admin`, `members:admin`, `access:admin`, `audit:read`)
  ergänzt das Paket. `access:admin` gibt es, sobald das Modell Typen ausser `org` hat. Die App führt sie nicht auf; nur
  wenn sie Reihenfolge, Beschreibung oder Ressourcentypen eines reservierten Rechts bestimmen will, nennt sie es ohne
  Label und Gruppe (z. B. `'access:admin': { resources: ['org', 'folder', 'note'] }`). Label und Gruppe kommen immer
  aus dem Baukasten.
- `defineModel` prüft M1–M12 und bricht mit `ModelError` (Liste `errors`) ab. Rollen stehen nie in Keycloak; jede
  Rolle ist ein Tupel `<subjekt> <rolle> <ort>` in `authz_tuple`.
- `model.platformJson()` ergibt `infra/keycloak/platform.json` für das Realm-Modul: nur noch die Scopes (O4).
- Typen ausser `org` brauchen ein `ResourceModel` der App (Kette, Existenz, Klassifizierung, Zuständigkeit über `edges`,
  Spez. 7.7); ohne weitere Typen genügt `flatResources`.
- Ab 1.1 Zuständigkeit über Personen aus Fachdaten: `edges.persons` (SQL, `$1 uuid[]` → `id`, `principal_id`, `grants`,
  `label`), optional `edges.personGrants` (`$1` = `principal.id` → `grants`, für «Recht irgendwo»); in den Policies
  `… v.principal_id = app.read_person()` bzw. `app.write_person()` mit `grants = 'edit'` (Spez. 7.6).
- Einen geprüften Katalog sichert der Test `checkModel(GET /v1/authz/catalog)` aus dem Test-Kit.

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
  iamMigrations({ product: 'notes', model }),
  dirMigrations('db/migrations'),
]);
```

- `iam_015_authz.sql` legt `authz_tuple` (RLS, `acl_version` je Anweisung) und die Funktionen der Lesesicht an
  (`app.read_all()`, `app.read_types()`, `app.read_units()`, `app.has_tuple(type, id, relations)` … Spez. 7.6) und
  entfernt `acl_entry`, `tenant_role` und `client_grant`. `iam_016_person_scope.sql` (1.1) ergänzt `app.read_person()` und
  `app.write_person()`. Bestehende Rollen und Zugriffsregeln werden **nicht**
  übernommen (Greenfield): nach dem Wechsel die erste Person je Organisation mit `iam-org-bootstrap` erneut einrichten.
- Die CHECKs von `authz_tuple` zu Typen und Relationen gleicht der Runner bei jedem Lauf mit dem Modell ab
  (`syncModelChecks`). Eine Relation oder einen Typ entfernen geht erst, wenn keine Tupel mehr darauf zeigen.
- **Lesesicht in den Policies der App** (Spez. 7.6): `req.tx` setzt je Anfrage die Einstellungen; die Policies der
  Fachtabellen fragen nur die Funktionen ab, z. B.

```sql
CREATE POLICY note_read ON notes.note AS RESTRICTIVE FOR SELECT TO notes_app USING (classification <= app.clearance() AND (
  app.read_all() OR folder_id = ANY (app.read_types()) OR app.has_tuple('note', id, app.read_relations())));
```

**Übernahme bestehender Objekte** (nur für eine App, die die IAM-Tabellen schon aus eigenen Migrationen hat; eine neue
App braucht das nicht): `adopted` trägt die IAM-Migrationen bis `IAM_BASELINE` und die zugeordneten späteren nur ein,
nach geprüften Vorbedingungen (sonst Abbruch ohne Eintrag). Beispiel einer App, deren Migrationen 051–053 den
IAM-Migrationen 010–012 entsprechen:

```ts
await migrate(cfg.db.adminUrl!, [
  dirMigrations('db/migrations'),
  iamMigrations({
    product: 'notes', model,
    adopted: {
      after: '053_acl_unique.sql',
      map: { '051_revoke_public_execute.sql': 'iam_010_revoke_public_execute.sql',
             '052_resolve_tenant_strict.sql': 'iam_011_resolve_tenant_strict.sql', '053_acl_unique.sql': 'iam_012_acl_unique.sql' },
    },
  }),
]);
```

Die IAM-Migrationen laufen direkt nach `after`; ausgeführt werden nur die IAM-Migrationen nach der Grundlage, die
nicht zugeordnet sind.

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
const iam = createIam({ cfg, model, db: createPool(cfg.db.url, cfg, 'notes-api'), schema: 'notes', resources, audit: pgAudit({ schema: 'notes' }), events });

await app.register(rateLimit, { global: false });                       // wirkt für Routen mit config.rateLimit
await app.register(swagger, { openapi: { tags: [...IAM_API_TAGS] }, transformObject: optionalBodies });
await app.register(iamPlugin, { iam, publicPaths: ['/v1/openapi.json', '/v1/docs', '/v1/docs/*'], people: { permissions: ['note:read'] } });

app.get('/v1/notes/:id', { preHandler: need('note:read', r => ({ type: 'note', id: (r.params as { id: string }).id })) }, async req =>
  req.tx(tx => notes.get(tx, (req.params as { id: string }).id)));
// Listen: Lesesicht unter RLS, Fähigkeiten mit einmal geladenen Fakten (Klassifizierung, Zuständigkeit)
app.get('/v1/notes', async req => {
  await req.needSomewhere('note:read');
  const rows = await req.tx(tx => notes.list(tx));
  const can = await req.capabilities(rows.map(r => ({ type: 'note', id: r.id })));
  return { items: rows.map(r => ({ ...r, can: can('note', r.id) })) };
});
```

`req.capabilities(refs?)` nimmt optional die Ressourcen der Antwort: Klassifizierung und Zuständigkeit werden dann für
alle auf einmal geladen (ohne `refs` gelten nur Tupel und Kette).

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
| `access` | `/v1/access…` (Wer hat Zugriff?, Warum?, Gruppen aus Entra, freigeben, Ablauf, entfernen) | – (Gruppen nur mit Entra-Verbindung) |
| `break-glass` | `POST/DELETE /v1/break-glass` | – |
| `admin` | `/v1/admin/status`, `/v1/admin/members…`, `/v1/platform/organizations…` | `KEYCLOAK_MGMT_CLIENT_ID`, sonst 503 |
| `entra` | `/v1/admin/entra…`, `…/members/entra…`, öffentlich `/v1/entra/handover/*` | Verwaltung (sonst 503); eigene App der Organisation braucht `ENCRYPTION_KEYS`, die App der Plattform `ENTRA_CLIENT_ID` (optional, sonst 409 `platform-app-disabled`) |
| `bff` | `/auth/*` | `OIDC_BFF_CLIENT_SECRET` bzw. `…_PRIVATE_KEY` |
| `clients` | `/v1/admin/clients…`, `…/organizations/:alias/clients…` (Principal und Tupel an org) | – |
| `people` | `/v1/people…` | ein Recht, das das Verzeichnis öffnet |

- **`people.permissions`**: Rechte, von denen eines irgendwo das Personenverzeichnis öffnet. Standard sind die Fachrechte
  des Lese-Scopes `<produkt>:read` und `access:admin`. Unbekannte Rechte brechen den Start ab; vorbehaltene wie `tenant:read`
  (hat jedes Mitglied) ergeben eine Warnung. Öffnet ohne Option kein Recht das Verzeichnis, fehlt das Modul mit Warnung.
- **`modules`** wählt die Module ausdrücklich, **`openapi`** ersetzt Tags, Texte und Feldbeschreibungen.
- **`events`** (`createIam`): Ereignisse in derselben Transaktion, z. B. für eine Outbox der App.
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

Der Abgleich nutzt den eigenen Lese-Client `KEYCLOAK_SYNC_*`, nicht den Verwaltungs-Client der API. Im selben Lauf
(auch ohne Lese-Client) löscht er abgelaufene Tupel (`access.expired`) und setzt abgelaufenes Break-Glass zurück
(`break_glass.ended` mit `expired: true`); einzeln `expireAccess`, über alle Mandanten `expireAllAccess`. Der Abgleich
löscht keine Tupel: Wer ausserhalb der App die Organisation verlässt, behält sie bis zum Entfernen über die App (A17).

## 7. MCP-Dienst (KANN)

Das Paket bringt Anmeldung und Token-Tausch; Server und Werkzeuge baut die App (z. B. mit `@modelcontextprotocol/sdk`).

```ts
import Fastify from 'fastify';
import { DpopSigner, loadIamConfig, McpAuth, OidcProvider, registerMcpAuth, TokenExchanger, TokenVerifier } from '@vollholz/iam';

const cfg = loadIamConfig(process.env, { product: 'notes', service: 'mcp' });
const provider = new OidcProvider(cfg.oidc.issuer);
const exchanger = new TokenExchanger(cfg, provider, { dpop: await DpopSigner.create(cfg.mcp.dpopKey), model });
const auth = new McpAuth({ cfg, model, verifier: new TokenVerifier(provider, cfg), exchanger, allowedOrigins: [] });

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

**Ersteinrichtung einer Organisation** (idempotent, A20; danach verwaltet org-admin die Mitglieder in der Oberfläche):

```sh
KEYCLOAK_TF_URL=https://identity.example.ch KEYCLOAK_TF_REALM=notes KEYCLOAK_IAC_PRIVATE_KEY_B64=… DATABASE_ADMIN_URL=… \
  npx iam-org-bootstrap --alias solutions --name "Solutions" --email anna@example.ch --first Anna --last Admin \
  [--schema notes] [--platform-admin] [--initial-password | --no-email | --resend] [--dry-run]
```

- In Keycloak: Organisation, Person, Mitgliedschaft (keine Rollengruppen). In der Datenbank der App als Besitzer-Rolle
  (Policies `owner_tenant`): Mandant gebunden an die Organisation, Principal, Tupel `org-admin` an org, Freigabestufe 2,
  Audit `tenant.provisioned`.
- Die Anmeldung läuft über den Service Account `<realm>-iac` (`private_key_jwt`, realm-admin).
- Einladung (ab 1.5): neu angelegte Personen ohne Passwort und ohne Identitätsanbieter erhalten die E-Mail «Passwort
  festlegen» (`execute-actions-email`, `UPDATE_PASSWORD`, 7 Tage; `--invite-days`, `--client-id`, `--redirect-uri`).
  `--no-email` keine, `--resend` auch an bestehende ohne Passwort. Ohne SMTP: Meldung, Lauf geht weiter (Code 0);
  programmatisch `sendEmail`, `resend`, `invite`, Ergebnis `invitation` (`sent`/`failed`/null) und `email`.
- `--initial-password` (Alternative ohne SMTP, dann keine Einladung) setzt nur ohne bestehendes Passwort ein temporäres
  und legt es ausschliesslich in `~/.identity/initial-password-<realm>-<e-mail>.txt` ab (0600). Programmatisch:
  `orgBootstrap(keycloakAdmin, …)`.
- Mehrere Organisationen mit je mehreren Admins: `--file init.json` (Format `schema/init.schema.json`;
  programmatisch `orgBootstrapFile`, Prüfung `initFileErrors`).

**Zurücksetzen** (`iam-reset`, ab 1.4): `--keycloak` löscht alle Organisationen samt ihrer Anbieter und alle Personen
(Service Accounts bleiben), `--database` leert alle Tabellen im Schema ausser `schema_migrations` und `--keep-table`;
Pflicht `--confirm <realm>`, `--dry-run` zählt nur. Programmatisch: `resetKeycloak`, `resetDatabase`. Nach dem Leeren
eine Zeile `audit {"action":"platform.reset", …}` auf stdout (das Audit-Protokoll ist je Mandant und danach leer).

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
  `Organization.Read.All`, `User.Read.All`, `Application.Read.All` und `GroupMember.Read.All` mit
  Administratorzustimmung (fehlt `GroupMember.Read.All`, antwortet `GET /v1/access/groups` 409 `entra-consent-missing`). `Application.Read.All`
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

**Gruppen aus Entra ID als Subjekte (O3).** Beim Verbinden legt das Paket am Anbieter den Mapper `entra-groups` an
(Claim `groups` mit den Objekt-IDs der Gruppen); der Principal nimmt daraus nur GUIDs (`group:<objekt-id>`). Freigaben
an Gruppen gibt es nur mit Verbindung (sonst 422). Für Personen mit sehr vielen Gruppen liefert Entra statt der Liste
einen Verweis (Überlauf); diese Personen erhalten Rechte über Gruppen dann nicht.

**Anmeldung über die App der Plattform (optional, `ENTRA_CLIENT_ID`).** Einmal je Produkt eine mandantenfähige App in
Entra ID; die Kunden stimmen ihr zu:

- Redirect-URIs: `<PUBLIC_BASE_URL><ENTRA_UI_PATH>/zustimmung` und die Plätze `entra-NNN` des Realms
  (`brokerRedirectUris`, `ENTRA_IDP_SLOTS`).
- Berechtigungen in Microsoft Graph (wie Assets `docs/einrichtung.md`): delegiert `User.Read` (Keycloak liest bei der
  Anmeldung `/me`), Anwendung `Organization.Read.All` (Organisation und verifizierte Domänen, `GET /organization`),
  Anwendung `User.Read.All` (`GET /users` mit `$filter`/`$search`, `GET /users/{id}`: Personen finden und verknüpfen),
  Anwendung `GroupMember.Read.All` (`GET /groups` mit `$search`, `GET /groups/{id}`: Gruppen für Freigaben, O3).
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

`@vollholz/iam-testkit`: Wegwerf-Datenbank (`testDatabases`), Mock-IdP mit Token Exchange und DPoP, `claimsFor` (ohne
Rollen), `KeycloakFake`, `EntraFake` (mit Gruppen), RLS-Prüfungen auch für `authz_tuple` und die Funktionen der
Lesesicht (`readViewProblems`), `checkModel`, Standardfälle der Entscheidung (`accessCases`, `runAccessCases`) und das
Gerüst für den Isolations-Durchlauf über alle Routen (`routeCollector`, `installProbes`, `leaks` …). Die Tests des Pakets mit der Beispiel-App «notes» zeigen den Einsatz.
