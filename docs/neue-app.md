# Neue App mit dem Identity-Kit in 10 Schritten

Für Entwickler:innen, die eine **neue** App an die Identity-Plattform (**https://identity.project-suite.ch**) anbinden:
Anmeldung, Organisationen als Mandanten, Rechte, Verwaltung und Datenbank-Schutz kommen aus dem Baukasten, die App
liefert nur ihren Rechtekatalog, ihre Ressourcen und ihr Aussehen. Die Beispiele nutzen das Produkt `notes`; überall
`notes` durch den technischen Namen der App ersetzen: Kleinbuchstaben, Ziffern und `-`, 3–32 Zeichen, vorn ein
Buchstabe, hinten ein Buchstabe oder eine Ziffer, nicht `master` oder `project-suite` (so prüfen es beide Realm-Module).

Referenz für jeden Schritt ist **vollholz/assets** (läuft vollständig auf dem Baukasten); die Pfade unten zeigen auf
dessen Dateien. Den Vertrag beschreibt die [Spezifikation](spezifikation.md), das Backend im Detail der Leitfaden
[`packages/iam/docs/backend.md`](../packages/iam/docs/backend.md).

| Teil | Version | Bezug |
|---|---|---|
| `@vollholz/iam` (Backend) | 0.3.0 | GitHub Packages |
| `@vollholz/iam-web` (Oberfläche) | 0.4.0 | GitHub Packages |
| `@vollholz/iam-testkit` (Tests) | 0.4.0 | GitHub Packages |
| `product-realm`, `product-realm-bootstrap` (OpenTofu) | 0.1.0 | Git-Tag `<modul>-v0.1.0` |

---

## 1. Zugänge

Das Repository und die Pakete sind nicht öffentlich.

- **Mitglied der Organisation `vollholz`** auf GitHub (Leserecht auf vollholz/identity-kit).
- **Pakete für die App freigeben**, je Paket (`iam`, `iam-web`, `iam-testkit`): *Package settings › Manage Actions
  access › Add repository* mit dem Repository der App (Rolle Read). Ohne diesen Schritt scheitert `npm ci` in GitHub
  Actions mit 403/404, obwohl `GITHUB_TOKEN` gesetzt ist.
- **Lokal** ein persönliches Token (classic) mit `read:packages` in die eigene `~/.npmrc`:
  `//npm.pkg.github.com/:_authToken=<token>`.
- **`.npmrc` der App** (ohne Token, versioniert): `@vollholz:registry=https://npm.pkg.github.com`. Versionen exakt
  pinnen (`npm i -E …`).
- **Module in GitHub Actions** (`tofu init` holt `git::https://github.com/vollholz/identity-kit.git`): `GITHUB_TOKEN`
  gilt nur für das eigene Repository. Lese-Deploy-Key einrichten (Schlüsselpaar `ssh-keygen -t ed25519`, öffentlich als
  Deploy key in identity-kit **ohne** Schreibrecht, privat als Secret `IDENTITY_KIT_DEPLOY_KEY` der App) und vor
  `tofu init` ein Skript wie in Assets aufrufen, das die HTTPS-Adresse auf SSH mit diesem Schlüssel umleitet und danach
  wieder entfernt.

Ohne Registry (z. B. in einer Session): `node scripts/local-registry.ts` in identity-kit, Details in
[ausrollen.md](ausrollen.md#ohne-zugang-sessions-unveröffentlichter-stand).

> Assets: `.npmrc`, `.github/scripts/identity-kit-access.sh`, `docs/einrichtung.md` › Zugang zu vollholz/identity-kit,
> `.github/workflows/keycloak.yml`.

### Repository ausserhalb von `vollholz`

Liegt die App in einer anderen GitHub-Organisation oder bei einem anderen Anbieter (GitLab, Bitbucket, Azure DevOps),
ändert sich nur der Zugang zum Kit; die App spricht mit `identity.project-suite.ch` wie jede andere.

| Zugang | In `vollholz` | Ausserhalb |
|---|---|---|
| Doku und Code lesen | Mitglied der Organisation | *Outside collaborator* mit Read auf vollholz/identity-kit |
| Pakete in der CI | *Manage Actions access* (gilt nur für Repositories in `vollholz`) | Maschinenkonto mit Leserecht auf den drei Paketen, dessen Token (classic) mit nur `read:packages` als Secret `NODE_AUTH_TOKEN` der CI; `.npmrc` unverändert |
| Pakete lokal | eigenes Token (classic) mit `read:packages` | gleich (Outside collaborator oder Maschinenkonto) |
| Realm-Module in der CI | Lese-Deploy-Key, Skript wie in Assets | gleich: der Deploy-Key gilt für das Repository, nicht für die Organisation. Ausserhalb von GitHub Actions die Umleitung aus `assets/.github/scripts/identity-kit-access.sh` (`git config url.<ssh>.insteadOf <https>` mit festem Host-Schlüssel von github.com) in die eigene CI übernehmen |
| PRs in vollholz/identity (Schritt 2) | eigener PR | als *Outside collaborator* mit Read auf vollholz/identity (PR aus einem Fork) – oder nur den öffentlichen Schlüssel `keys/<name>-tofu.json` an die Plattform-Administration geben, die die beiden PRs stellt. Der private Teil bleibt immer bei der App |

Je App ein eigener Deploy-Key und ein eigenes Maschinen-Token, damit sich ein Zugang einzeln widerrufen lässt.

## 2. Realm anlegen (einmalig, als Code)

Keycloak wird vollständig als Code geführt, auch beim Anlegen: niemand legt etwas von Hand in der Konsole an.
Spezifikation [Kap. 2](spezifikation.md#2-anbindung-an-die-identity-plattform), Modul
[product-realm-bootstrap](../modules/product-realm-bootstrap/README.md); Ablauf auf der Plattform-Seite in
vollholz/identity `infra/keycloak/products.tf` und `docs/betrieb.md` › Neues Produkt (Stand vollholz/identity#6). Zwei Repositories sind beteiligt:

1. **Schlüsselpaar für `notes-tofu`** erzeugt die App selbst, z. B. in einem eigenen Checkout von vollholz/identity:
   `deploy/scripts/secrets.sh client-key notes-tofu KEYCLOAK_TF_PRIVATE_KEY_B64`. Den öffentlichen Teil legt das Skript
   als `infra/keycloak/keys/notes-tofu.json` ab, den privaten in die `.env` dieses Checkouts; von dort gehört er in die
   lokale `.env` der App. Er verlässt die App nie.
2. **PR der App in vollholz/identity**, nur mit `infra/keycloak/keys/notes-tofu.json` und dem Eintrag in
   `infra/keycloak/production.tfvars` › `products` (die CI dort prüft, dass unter `keys/` nur öffentliche
   ES256-Schlüssel liegen):

   ```hcl
   products = {
     # …
     notes = {
       realm             = "notes"
       iac_client_id     = "notes-iac"
       grant_realm_admin = false
     }
   }
   ```

   Nach dem Merge wendet der Workflow «Keycloak» an (Plan → Freigabe → Apply → Kontrollplan). Ergebnis: Service
   Account `notes-tofu` im Realm `master`, nur mit `create-realm`, Anmeldung mit `private_key_jwt`.
3. **App-Repository:** Schlüsselpaar für `notes-iac` erzeugen; öffentlich als `infra/keycloak/keys/notes-iac.json` (ein
   EC-P-256-JWK mit `kid`) versionieren, privat in die lokale `.env` und als GitHub-Secret `KEYCLOAK_IAC_PRIVATE_KEY`.
   Dann `infra/keycloak/bootstrap/main.tf` (eigener State-Key) **lokal** als `notes-tofu` anwenden:
   `kc.sh bootstrap init && kc.sh bootstrap apply`. Es legt den Realm `notes` und den IaC-Client `notes-iac` an.

   ```hcl
   provider "keycloak" {
     url             = var.keycloak_url
     base_path       = var.keycloak_base_path
     jwt_signing_alg = "ES256"   # Anmeldung nur aus der Umgebung: KEYCLOAK_REALM=master, KEYCLOAK_CLIENT_ID=notes-tofu, KEYCLOAK_JWT_SIGNING_KEY
   }

   module "bootstrap" {
     source = "git::https://github.com/vollholz/identity-kit.git//modules/product-realm-bootstrap?ref=product-realm-bootstrap-v0.1.0"

     product  = "notes"
     iac_jwks = file("${path.module}/../keys/notes-iac.json")
   }
   ```

   Der Schlüssel von `notes-tofu` bleibt lokal (nur Bootstrap und Neuaufbau), **nie als GitHub-Secret oder in
   Actions**: `create-realm` gibt dem Ersteller dauerhaft fast alle Admin-Rollen an jedem Realm, den er anlegt, und
   erlaubt beliebige weitere Realms (vollholz/identity `docs/betrieb.md` › Bewusste Restrisiken).
4. **Zweiter PR in vollholz/identity:** im Eintrag `notes` `grant_realm_admin = true`; der Workflow «Keycloak» weist danach
   `notes-iac` die Rolle `realm-management/realm-admin` im Realm `notes` zu. Ab dann verwaltet die App ihren Realm mit
   `notes-iac` (Schritt 3).

> Assets: `infra/keycloak/bootstrap/main.tf`, `infra/keycloak/kc.sh` (`bootstrap …` meldet sich als `assets-tofu` mit
> `KEYCLOAK_TF_PRIVATE_KEY_B64` aus der `.env` an), `docs/produktion.md` › Keycloak-Anbindung; in vollholz/identity
> der Eintrag `assets` in `production.tfvars` und `keys/assets-tofu.json`.

## 3. Realm einrichten

Modul [product-realm](../modules/product-realm/README.md) mit dem IaC-Client `notes-iac`. Es legt Clients
(`notes-platform`, `notes-api`, `notes-admin`, `notes-sync`), Rollen aus dem Katalog, Scopes, Texte und Richtlinien an.
Schlüsselpaare für `platform`, `admin` und `sync` wie in Schritt 2 erzeugen (`infra/keycloak/keys/notes-<client>.json`).
Minimales `infra/keycloak/main.tf` (Provider, Backend und Verschlüsselung des States wie im README des Moduls):

```hcl
import {
  to = module.realm.keycloak_realm.this   # den Realm hat product-realm-bootstrap angelegt
  id = "notes"
}

module "realm" {
  source = "git::https://github.com/vollholz/identity-kit.git//modules/product-realm?ref=product-realm-v0.1.0"

  product         = "notes"
  display_name    = "Notes"
  public_base_url = "https://notes.project-suite.ch"
  catalog         = jsondecode(file("${path.module}/platform.json"))   # aus dem Katalog, Schritt 4
  jwks            = { for c in ["platform", "admin", "sync"] : c => file("${path.module}/keys/notes-${c}.json") }

  entra = true   # Anmeldung über Microsoft Entra ID der Kunden (Schritt 10); ohne ENTRA_CLIENT_ID
}

output "issuer" { value = module.realm.issuer }   # = OIDC_ISSUER_URL
```

Angewendet wird per eigenem Workflow `.github/workflows/keycloak.yml` als `notes-iac`, nicht von Hand: ein Pull
Request prüft nur (fmt, validate, tflint, Tests); ein Push auf `main` (oder «Run workflow» mit `apply`) läuft
Plan → Freigabe (Environment `production`) → Apply genau dieses Plans → Kontrollplan, der «No changes» zeigen muss.
Die Aktion `abgleich` meldet Änderungen von Hand. `kc.sh init` und `kc.sh plan` gehen auch lokal. Weitere Schalter
(`smtp`, `m2m`, `mcp`, Texte): README des Moduls.

> Assets: `infra/keycloak/main.tf`, `versions.tf`, `variables.tf`, `infra/keycloak/platform.ts` (schreibt
> `platform.json`), `.github/workflows/keycloak.yml` (Vorlage für den Workflow, mit den Secrets
> `KEYCLOAK_IAC_PRIVATE_KEY`, `KEYCLOAK_TF_URL`, `TF_STATE_PASSPHRASE`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
> `IDENTITY_KIT_DEPLOY_KEY`, mit `smtp` zusätzlich `SMTP_PASSWORD`).

## 4. Rechtekatalog und Ressourcen

Der Katalog ist die einzige Quelle für Rechte, Rollen, Scopes und Zugriffsregeln (Spezifikation Kap. 8). Minimal:

```ts
// src/authz/catalog.ts
import { defineCatalog } from '@vollholz/iam';

export const catalog = defineCatalog({
  product: 'notes',
  permissions: {
    'note:read': { label: 'Notizen lesen', group: 'notes', description: 'Notizen sehen.', resources: ['tenant', 'folder', 'note'] },
    'note:write': { label: 'Notizen ändern', group: 'notes', description: 'Notizen anlegen und ändern.', resources: ['tenant', 'folder', 'note'] },
  },
  groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }],
  roles: {
    editor: { label: 'Bearbeiter:in', description: 'Liest und ändert Notizen der Organisation.', permissions: ['tenant:read', 'note:read', 'note:write'] },
    viewer: { label: 'Leser:in', description: 'Liest Notizen der Organisation.', permissions: ['tenant:read', 'note:read'] },
  },
  scopes: { 'notes:read': { text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] }, 'notes:write': { text: 'Notizen ändern', permissions: ['note:write'] } },
  resources: { folder: { label: 'Ordner' }, note: { label: 'Notiz', leaf: true } },
});
```

- `org-admin` und die reservierten Rechte (`tenant:read`, `members:admin`, `acl:read`, `acl:admin` …) ergänzt das Paket.
- `catalog.platformJson()` ergibt `infra/keycloak/platform.json` (Schritt 3, `iam-org-bootstrap`); nach jeder Änderung
  am Katalog neu schreiben.
- Ressourcen (nur mit `resources`, für Zugriffsregeln): ein `ResourceModel` der App. Für einfache Fälle ohne Kette
  `flatResources({ tables: { folder: 'notes.folder', note: 'notes.note' } })`.

> Assets: `src/platform/authz/catalog.ts`, `src/platform/authz/resources.ts`.

## 5. Datenbank und Migrationen

Rollen nach Spezifikation [10.1](spezifikation.md#101-rollen) mit der Vorlage aus dem Paket (als Superuser, idempotent):

```sh
psql "$SUPERUSER_URL" -v p=notes -v db=notes -v owner_pw=… -v runtime_pw=… -v worker_pw=… \
  -f node_modules/@vollholz/iam/db/bootstrap.sql
```

| Rolle | Wofür | Variable |
|---|---|---|
| `notes_owner` | besitzt alle Objekte, führt Migrationen aus | `DATABASE_ADMIN_URL` |
| `notes_runtime` (Mitglied von `notes_app`) | API und MCP, nur über RLS je Mandant | `DATABASE_URL` |
| `notes_worker` (Mitglied von `notes_app`, `notes_sched`) | Worker | `DATABASE_WORKER_URL` |

Migrationen als eigener Schritt vor dem Start (z. B. Job im Deploy), **zuerst die des Pakets, dann die der App**; Tabellen
der App mit `tenant_id` erhalten RLS automatisch:

```ts
import { dirMigrations, iamMigrations, migrate } from '@vollholz/iam';

await migrate(process.env.DATABASE_ADMIN_URL!, [
  iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'folder', 'note'], leafTypes: ['note'] }),
  dirMigrations('db/migrations'),
]);
```

`resourceTypes` und `leafTypes` entsprechen `resources` im Katalog. Die umgekehrte Reihenfolge mit `adopted` gilt nur für
Apps, die IAM-Tabellen schon aus eigenen Migrationen haben (Assets), nicht für eine neue App. Veröffentlichte Migrationen
nie ändern: Die Prüfsumme steht in jeder Datenbank, Änderungen gehören in eine neue Datei.

> Assets: `db/bootstrap.sql`, `src/platform/db/migrate.ts`, `scripts/db-migrate.ts` (mit Übernahme, darum dort App vor IAM).

## 6. Konfiguration

Nur Umgebungsvariablen (Spezifikation Kap. 13), Geheimnisse auch als `…_FILE`. Alle Variablen mit Standardwert und
Beschreibung liefert `IAM_VARS('notes')` – daraus die Konfigurationsdoku der App erzeugen.

```ts
import { iamWarnings, loadIamConfig } from '@vollholz/iam';

const cfg = loadIamConfig(process.env, { product: 'notes', service: 'api' }); // 'api' | 'worker' | 'mcp'
for (const w of iamWarnings(cfg, 'api')) log.warn(w);
```

| Variable | Wofür |
|---|---|
| `NODE_ENV` | `production` in Betrieb (strengere Prüfungen) |
| `PUBLIC_BASE_URL` | Adresse der App (Pflicht in Produktion, https) |
| `OIDC_ISSUER_URL` | Ausgabe `issuer` aus Schritt 3 (Pflicht) |
| `DATABASE_URL`, `DATABASE_ADMIN_URL`, `DATABASE_WORKER_URL` | Schritt 5 |
| `OIDC_BFF_PRIVATE_KEY` (oder `OIDC_BFF_CLIENT_SECRET`) | Anmeldung der Oberfläche über `notes-platform` (Pflicht in Produktion) |
| `SESSION_SECRET` | Signatur der Sitzungs-Cookies, je Schlüssel mindestens 32 Zeichen (Pflicht in Produktion) |
| `ENCRYPTION_KEYS` | `id:base64(32 Bytes)`, kommagetrennt; Sitzungen und Geheimnisse, auch der Entra-Apps der Kunden (Pflicht in Produktion) |
| `KEYCLOAK_MGMT_CLIENT_ID`, `KEYCLOAK_MGMT_PRIVATE_KEY` | Verwaltung von Organisationen und Mitgliedern (`notes-admin`); ohne: Verwaltung abgeschaltet |
| `KEYCLOAK_SYNC_CLIENT_ID`, `KEYCLOAK_SYNC_PRIVATE_KEY` | Abgleich der Mitglieder im Worker (`notes-sync`) |
| `ENTRA_CLIENT_ID` | **leer lassen**: Kunden verbinden ihre eigene App (Schritt 10) |

Die übrigen (`OIDC_BFF_CLIENT_ID`, `OIDC_API_AUDIENCE` …) haben Standardwerte nach dem Produktnamen, passend zum Realm.

> Assets: `src/platform/config/env.ts`, `docs/konfiguration.md`.

## 7. Backend

Fastify mit dem Plugin des Pakets; es bringt Anmeldung je Anfrage (Bearer, DPoP, Sitzung mit CSRF), `req.tx`
(Mandantenkontext, RLS), `req.need`, Fehler als problem+json und die Module (`account`, `acl`, `admin`, `entra`,
`roles`, `bff`, `clients`, `people`; Übersicht in [backend.md › API](../packages/iam/docs/backend.md#5-api)).

```ts
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import { createIam, createPool, flatResources, IAM_API_TAGS, iamPlugin, need, optionalBodies, pgAudit, pgRateLimitStore, readinessChecks } from '@vollholz/iam';

const app = Fastify({ logger: true, ajv: { customOptions: { removeAdditional: false } } });   // unbekannte Felder → 422
const iam = createIam({
  cfg, catalog, db: createPool(cfg.db.url, cfg, 'notes-api'), schema: 'notes',
  resources: flatResources({ tables: { folder: 'notes.folder', note: 'notes.note' } }), audit: pgAudit({ schema: 'notes' }),
});

// Limits der Routen des Pakets (config.rateLimit); bei mehreren Instanzen über alle gezählt (Tabelle notes.rate_limit)
await app.register(rateLimit, {
  global: false,
  ...(cfg.ops.sharedState === 'postgres' ? { store: pgRateLimitStore(iam.db, 'notes'), skipOnError: true } : {}),
});
await app.register(swagger, { openapi: { tags: [...IAM_API_TAGS] }, transformObject: optionalBodies });
await app.register(iamPlugin, { iam, publicPaths: ['/v1/openapi.json'], people: { permissions: ['note:read'] } });

app.get('/v1/notes/:id', { preHandler: need('note:read', r => ({ type: 'note', id: (r.params as { id: string }).id })) },
  async req => req.tx(tx => notes.get(tx, (req.params as { id: string }).id)));
```

- `readinessChecks(iam)` für `/readyz`.
- **Worker:** `new MemberSync(cfg, pool, { schema: 'notes' }).start()` gleicht die Mitglieder mit Keycloak ab.
- **MCP** (optional): `McpAuth`, `registerMcpAuth`, `TokenExchanger` ([backend.md › MCP](../packages/iam/docs/backend.md#7-mcp-dienst-kann)).
- Mehrere Instanzen: `SHARED_STATE=postgres` (Standard) teilt den Replay-Schutz in `createIam`; das Rate-Limit-Plugin
  braucht dafür ausdrücklich `store: pgRateLimitStore(…)` wie oben, sonst zählt jede Instanz für sich.

> Assets: `src/platform/http/app.ts` (`createIam`, `iamPlugin`), `src/platform/worker/member-sync.ts`,
> `src/platform/main/worker.ts`.

## 8. Frontend

React 19 mit `@tanstack/react-query` 5; `@vollholz/iam-web` 0.4.0, Server an derselben Herkunft (`/auth/*`, `/v1/…`).

```tsx
import { IamProvider } from '@vollholz/iam-web';
import '@vollholz/iam-web/styles.css';

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <IamProvider product="Notes" router={router} features={{ entra: true }} resources={resources}>
      <App />
    </IamProvider>
  </QueryClientProvider>,
);
```

- **Router-Adapter** (`router`): `{ Link, navigate, useSearch, usePathname }`; ohne Angabe die History-API. Beispiel für
  TanStack Router und React Router: [iam-web › Routen](../packages/iam-web/README.md#routen-und-navigation).
- **Seiten einhängen:** `makeIamRoutes(paths, features)` (bzw. `iamRoutes`) liefert je Verwalten-Seite Pfad, Bedarf und
  `load()` mit Guard; `<IamNav>` zeichnet die Gruppe «Zugang» nach Recht.
- **`paths`** (Standard `/verwalten/…`) und **`features`** (`acl`, `entra`, `platform`). `paths.entra` muss zu
  `ENTRA_UI_PATH` des Servers passen (beide Standard `/verwalten/anmeldung`). `features.entra: true` für Schritt 10.
- **Farben:** Das Paket färbt nur über `--iam-*`; die App bildet ihre Tokens ab, z. B.
  `:root { --iam-accent: var(--accent); --iam-surface: var(--surface); }`.
- In der App: `useIam()` (`me`, `can`, `orgName`, `switchOrg` …), `<Can perm>`.

> Assets: `web/src/main.tsx`, `web/src/auth/iam.tsx` (`iamProps`, Router-Adapter, `resources`), `web/src/styles/iam.css`.

## 9. Tests, CI und Image

Mit `@vollholz/iam-testkit` 0.4.0 (Spezifikation Kap. 14):

- **Wegwerf-Datenbank** je Testdatei: `testDatabases({ prefix, owner, connect, migrate, runtime, closeRuntime })`.
- **Katalog:** `checkCatalog(<Antwort von GET /v1/authz/catalog>, { product: 'notes', acl: true })` ergibt keine Fehler.
- **RLS:** `tenantTableProblems`, `grantedTableProblems`, `securityDefinerProblems`, `publicSchemaProblems`,
  `publicExecuteProblems`, `bypassRoleProblems` – je eine leere Liste.
- **Isolations-Durchlauf** über alle Routen (Daten von Mandant A sind für B nie sichtbar): `routeCollector`,
  `installProbes`, `unreached`, `leaks`, `coverageProblems`.
- **Nachbildungen:** `startMockIdp`, `claimsFor`, `KeycloakFake`, `EntraFake`.

CI und Image: GitHub Packages mit `GITHUB_TOKEN` und `packages: read`, im Image über ein Build-Secret (nie im Image),
Vorlagen in [ausrollen.md](ausrollen.md).

> Assets: `test/platform/tenant-isolation.test.ts`, `rls.test.ts`, `iam-catalog.test.ts`, `harness.ts`;
> `.github/workflows/ci.yml`, `Dockerfile`.

## 10. Erste Organisation und Microsoft Entra ID

**Erste Organisation** (idempotent; danach verwaltet die Organisations-Administration in der Oberfläche):

```sh
KEYCLOAK_TF_URL=https://identity.project-suite.ch KEYCLOAK_TF_REALM=notes KEYCLOAK_IAC_PRIVATE_KEY_B64=… \
  npx iam-org-bootstrap --catalog infra/keycloak/platform.json --alias solutions --name "Solutions" \
  --email anna@example.ch --first Anna --last Admin --roles org-admin --platform-admin
```

**Entra ID: beim Betreiber nichts.** Keine Entra-App der Plattform, `ENTRA_CLIENT_ID` bleibt leer. Jede
Kunden-Organisation verbindet sich selbst mit einer **eigenen App-Registrierung** in ihrem Tenant: unter Verwalten ›
Anmeldung «Eigene App verbinden» oder über den Link «Credentials eintragen» an die Kunden-IT. Die Oberfläche zeigt die
Anleitung (Umleitungs-URI `<OIDC_ISSUER_URL>/broker/entra-app-<alias>/endpoint`, Berechtigungen `User.Read` delegiert,
`Organization.Read.All`, `User.Read.All`, `Application.Read.All` als Anwendung mit Administratorzustimmung,
geheimer Clientschlüssel). Voraussetzungen der App: `entra = true` im Realm (Schritt 3), `ENCRYPTION_KEYS`,
Verwaltung (`KEYCLOAK_MGMT_*`) und `features.entra` (Schritt 8). Hintergrund:
[backend.md › Betrieb](../packages/iam/docs/backend.md#8-betrieb).

> Assets: `docs/einrichtung.md` › Microsoft Entra ID › Organisation (Kunden-IT, im eigenen Tenant),
> `docs/konzepte/entra-id.md`.

---

## Fertig, wenn

- [ ] `npm ci` läuft lokal und in GitHub Actions (Pakete für das Repository freigegeben, Deploy-Key für die Module).
- [ ] Eintrag `notes` in vollholz/identity mit `grant_realm_admin = true`; `notes-tofu`-Schlüssel nur lokal.
- [ ] Realm per Workflow «Keycloak» der App eingerichtet; der Kontrollplan zeigt «No changes».
- [ ] `platform.json` aus `catalog.platformJson()` stimmt mit dem Katalog überein.
- [ ] Migrationen laufen als `notes_owner`, IAM vor App; die Laufzeit nutzt `notes_runtime` (ohne BYPASSRLS).
- [ ] `loadIamConfig` ohne Fehler in `production`; `iamWarnings` leer oder bewusst akzeptiert; `ENTRA_CLIENT_ID` leer.
- [ ] Fastify mit `removeAdditional: false`, `@fastify/rate-limit`, Swagger vor dem Plugin; `/readyz` mit `readinessChecks`.
- [ ] Oberfläche: Anmeldung, Auswahl der Organisation, Verwalten-Seiten «Zugang» erreichbar, Farben über `--iam-*`.
- [ ] Tests: Katalog, RLS-Prüfungen und Isolations-Durchlauf grün (jede Route geprüft oder begründet ausgenommen).
- [ ] Erste Organisation mit org-admin angelegt; Anmeldung und Einladung einer zweiten Person funktionieren.
- [ ] Eine Test-Organisation hat sich mit einer eigenen Entra-App verbunden und die Testanmeldung bestanden.
