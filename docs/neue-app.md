# Neue App mit dem Identity-Kit in 10 Schritten

Für Entwickler:innen, die eine **neue** App an die Identity-Plattform (**https://identity.project-suite.ch**) anbinden:
Anmeldung, Organisationen als Mandanten, Rechte, Verwaltung und Datenbank-Schutz kommen aus dem Baukasten, die App
liefert nur ihr Modell (Rechte, Rollen, Orte), ihre Ressourcen und ihr Aussehen. Die Beispiele nutzen das Produkt `notes`; überall
`notes` durch den technischen Namen der App ersetzen: Kleinbuchstaben, Ziffern und `-`, 3–32 Zeichen, vorn ein
Buchstabe, hinten ein Buchstabe oder eine Ziffer, nicht `master` oder `project-suite` (so prüfen es beide Realm-Module).

Referenz für jeden Schritt ist **vollholz/assets** (läuft vollständig auf dem Baukasten); die Pfade unten zeigen auf
dessen Dateien. Den Vertrag beschreibt die [Spezifikation](spezifikation.md), das Backend im Detail der Leitfaden
[`packages/iam/docs/backend.md`](../packages/iam/docs/backend.md).

| Teil | Version | Bezug |
|---|---|---|
| `@vollholz/iam` (Backend) | 1.5.0 | GitHub Packages |
| `@vollholz/iam-web` (Oberfläche) | 1.2.0 | GitHub Packages |
| `@vollholz/iam-testkit` (Tests) | 1.3.0 | GitHub Packages |
| `product-realm` (OpenTofu) | 1.0.0 | Git-Tag `product-realm-v1.0.0` |
| `product-realm-bootstrap` (OpenTofu) | 0.1.0 | Git-Tag `product-realm-bootstrap-v0.1.0` |

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
(`notes-platform`, `notes-api`, `notes-admin`, `notes-sync`), Scopes aus dem Modell, Texte und Richtlinien an – **keine**
Rollen, keine Rollengruppen: Rollen stehen nur in der Datenbank der App (Spezifikation [3.5](spezifikation.md#35-rollen-und-gruppen)).
Schlüsselpaare für `platform`, `admin` und `sync` wie in Schritt 2 erzeugen (`infra/keycloak/keys/notes-<client>.json`).
Minimales `infra/keycloak/main.tf` (Provider, Backend und Verschlüsselung des States wie im README des Moduls):

```hcl
import {
  to = module.realm.keycloak_realm.this   # den Realm hat product-realm-bootstrap angelegt
  id = "notes"
}

module "realm" {
  source = "git::https://github.com/vollholz/identity-kit.git//modules/product-realm?ref=product-realm-v1.0.0"

  product         = "notes"
  display_name    = "Notes"
  public_base_url = "https://notes.project-suite.ch"
  catalog         = jsondecode(file("${path.module}/platform.json"))   # nur Scopes, aus dem Modell (Schritt 4)
  jwks            = { for c in ["platform", "admin", "sync"] : c => file("${path.module}/keys/notes-${c}.json") }

  entra = true   # Anmeldung über Microsoft Entra ID der Kunden (Schritt 10); ohne ENTRA_CLIENT_ID
}

output "issuer" { value = module.realm.issuer }   # = OIDC_ISSUER_URL
```

Angewendet wird per eigenem Workflow `.github/workflows/keycloak.yml` als `notes-iac`, nicht von Hand: ein Pull
Request prüft nur (fmt, validate, tflint, Tests); ein Push auf `main` (oder «Run workflow» mit `apply`) läuft
Plan → Freigabe (Environment `production`) → Apply genau dieses Plans → Kontrollplan, der «No changes» zeigen muss.
Die Aktion `abgleich` meldet Änderungen von Hand. `kc.sh init` und `kc.sh plan` gehen auch lokal. Weitere Schalter
(`smtp`, `m2m`, `mcp`, Texte) und Maschinen-Clients als Code (`machine_clients`, statt in der Konsole): README des Moduls.

> Assets: `infra/keycloak/main.tf`, `versions.tf`, `variables.tf`, `infra/keycloak/platform.ts` (schreibt
> `platform.json` aus `model.platformJson()`), `.github/workflows/keycloak.yml` (Vorlage für den Workflow, mit den Secrets
> `KEYCLOAK_IAC_PRIVATE_KEY`, `KEYCLOAK_TF_URL`, `TF_STATE_PASSPHRASE`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
> `IDENTITY_KIT_DEPLOY_KEY`, mit `smtp` zusätzlich `SMTP_PASSWORD`).

## 4. Modell und Ressourcen

Das Modell ist die einzige Quelle für Rechte, Rollen, Scopes und Orte (Spezifikation [7.3](spezifikation.md#73-modell-der-app-definemodel),
[Kap. 8](spezifikation.md#8-modell-des-produkts)). Beispiel Stufe «mittel» (Ordner mit Notizen, Freigaben an Ordnern und
Notizen):

```ts
// src/authz/model.ts
import { defineModel } from '@vollholz/iam';

export const model = defineModel({
  product: 'notes',
  permissions: {
    'note:read': { label: 'Notizen lesen', group: 'notes', description: 'Notizen sehen.', resources: ['org', 'folder', 'note'] },
    'note:write': { label: 'Notizen ändern', group: 'notes', description: 'Notizen anlegen und ändern.', resources: ['org', 'folder', 'note'] },
  },
  groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }],
  roles: {
    editor: { label: 'Bearbeiter:in', description: 'Liest und ändert Notizen und gibt Zugriff darauf frei.', permissions: ['tenant:read', 'note:read', 'note:write', 'access:admin'] },
    viewer: { label: 'Leser:in', description: 'Liest Notizen.', permissions: ['tenant:read', 'note:read'] },
  },
  scopes: { 'notes:read': { text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] }, 'notes:write': { text: 'Notizen ändern', permissions: ['note:write'] } },
  types: {
    folder: { label: 'Ordner', parent: 'org', roles: ['editor', 'viewer'], read: 'note:read' },
    note: { label: 'Notiz', parent: 'folder', roles: ['editor', 'viewer'], leaf: true, read: 'note:read', write: 'note:write' },
  },
});
```

- `org-admin` (alle Rechte, `org` mit allen Rollen) und die reservierten Rechte (`tenant:read`, `members:admin`,
  `access:admin` …) und Gruppen ergänzt das Paket. Die Rollenbeschreibung nennt jede Rechtegruppe der
  Rolle (hier «Notiz», «Zugriff»), sonst bricht `defineModel` ab. Die App führt reservierte Rechte unter `permissions`
  nicht auf; nur um Reihenfolge, Beschreibung oder `resources` zu bestimmen, nennt sie eines ohne Label und Gruppe
  (z. B. `'access:admin': {}`, ebenso `{ key: 'access' }` unter `groups`).
- Stufe «einfach»: `types` weglassen; dann gibt es nur Rollen an der Organisation und kein Panel «Zugriff».
- `model.platformJson()` ergibt `infra/keycloak/platform.json` (nur Scopes, Schritt 3); nach jeder Änderung neu
  schreiben.
- Ressourcen (`ResourceModel`, Spezifikation [7.7](spezifikation.md#77-resourcemodel-der-app)): Kette, Existenz und bei
  Bedarf Vertraulichkeit und Zuständigkeit (`edges`). Kette `org → folder → note`:

```ts
// src/authz/resources.ts
export const resources: ResourceModel<Map<string, string>> = {
  load: async tx => new Map((await tx.query('SELECT id, folder_id FROM notes.note')).rows.map(r => [r.id, r.folder_id])),
  chain: (folderOf, ref) => ref.type === 'org' ? [{ type: 'org' }]
    : ref.type === 'folder' ? [{ type: 'org' }, ref]
    : [{ type: 'org' }, { type: 'folder', id: folderOf.get(ref.id!) ?? null }, ref],
  // Zwischenspeicher der Kette: version muss sich mit jedem Anlegen und Verschieben ändern (updated_at per Trigger)
  version: async tx => (await tx.query(`SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') AS v FROM notes.note`)).rows[0].v,
  exists: async (tx, ref) => ((await tx.query(`SELECT 1 FROM notes.${ref.type} WHERE id = $1`, [ref.id])).rowCount ?? 0) > 0,
};
```

- Policies der Blatt-Tabelle (Spezifikation [7.6](spezifikation.md#76-lesesicht-je-anfrage)), als Migration der App –
  lesen **und** schreiben, sonst schützt die Datenbank nur die Mandantengrenze:

```sql
CREATE POLICY note_read ON notes.note AS RESTRICTIVE FOR SELECT USING (
  app.read_all() OR folder_id = ANY (app.read_types()) OR app.has_tuple('note', id, app.read_relations()));
CREATE POLICY note_insert ON notes.note AS RESTRICTIVE FOR INSERT WITH CHECK (
  app.write_all() OR folder_id = ANY (app.write_types()));
CREATE POLICY note_update ON notes.note AS RESTRICTIVE FOR UPDATE
  USING (app.write_all() OR folder_id = ANY (app.write_types()) OR app.has_tuple('note', id, app.write_relations()))
  WITH CHECK (app.write_all() OR folder_id = ANY (app.write_types()) OR app.has_tuple('note', id, app.write_relations()));
CREATE POLICY note_delete ON notes.note AS RESTRICTIVE FOR DELETE USING (
  app.write_all() OR folder_id = ANY (app.write_types()) OR app.has_tuple('note', id, app.write_relations()));
```

  Die Einstellungen sind je Anfrage mit den Scopes des Tokens geschnitten; Tupel zählen nur mit passender Rolle und
  passendem Scope.

- Nur Typen direkt unter der Organisation: `flatResources({ tables: { folder: 'notes.folder' } })`.

> Assets: `src/authz/model.ts`, `src/authz/resources.ts` (mit Zuständigkeit und Vertraulichkeit).

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
  iamMigrations({ product: 'notes', model }),   // authz_tuple mit CHECKs aus dem Modell (syncModelChecks)
  dirMigrations('db/migrations'),
]);
```

Die umgekehrte Reihenfolge mit `adopted` gilt nur für
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
(Mandantenkontext, RLS), `req.need`, `req.can`, die Lesesicht je Anfrage ([7.6](spezifikation.md#76-lesesicht-je-anfrage)), Fehler als problem+json und die Module
(`account`, `access`, `admin`, `break-glass`, `bff`, `clients`, `entra`, `people`; Übersicht in [backend.md › API](../packages/iam/docs/backend.md#5-api)).

```ts
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import { createIam, createPool, IAM_API_TAGS, iamPlugin, need, optionalBodies, pgAudit, pgRateLimitStore, readinessChecks } from '@vollholz/iam';
import { model } from './authz/model.ts';
import { resources } from './authz/resources.ts';

const app = Fastify({ logger: true, ajv: { customOptions: { removeAdditional: false } } });   // unbekannte Felder → 422
const iam = createIam({
  cfg, model, resources, db: createPool(cfg.db.url, cfg, 'notes-api'), schema: 'notes', audit: pgAudit({ schema: 'notes' }),
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
// Listen ohne Prüfung je Zeile: die Lesesicht (RLS) liefert nur lesbare Notizen
app.get('/v1/notes', { preHandler: req => req.needSomewhere('note:read') }, async req => req.tx(tx => notes.list(tx)));
```

- `readinessChecks(iam)` für `/readyz`.
- **Worker:** `new MemberSync(cfg, pool, { schema: 'notes', model }).start()` gleicht die Mitglieder mit Keycloak ab und
  räumt abgelaufene Freigaben und Break-Glass auf.
- Freigaben, Mitglieder, Clients und Break-Glass sind fertige Endpunkte (Spezifikation [9.5](spezifikation.md#95-zugriff-v1access)–[9.7](spezifikation.md#97-break-glass-v1break-glass));
  die App schreibt nur ihren Endpunkt zum Klassifizieren (`req.needClearance`, Audit `object.classified`), falls sie
  `classified` nutzt.
- **MCP** (optional): `McpAuth`, `registerMcpAuth`, `TokenExchanger` ([backend.md › MCP](../packages/iam/docs/backend.md#7-mcp-dienst-kann)).
- Mehrere Instanzen: `SHARED_STATE=postgres` (Standard) teilt den Replay-Schutz in `createIam`; das Rate-Limit-Plugin
  braucht dafür ausdrücklich `store: pgRateLimitStore(…)` wie oben, sonst zählt jede Instanz für sich.

> Assets: `src/platform/http/app.ts` (`createIam` mit `model`, `iamPlugin`), `src/platform/worker/member-sync.ts`,
> `src/platform/main/worker.ts`.

## 8. Frontend

React 19 mit `@tanstack/react-query` 5; `@vollholz/iam-web` ab 1.0.0, Server an derselben Herkunft (`/auth/*`, `/v1/…`).

```tsx
import { AccessSheet, IamProvider } from '@vollholz/iam-web';
import '@vollholz/iam-web/styles.css';

// Namen der Orte aus dem Cache der App, Sprung zum Ort (Spezifikation 11.4)
const resources = { useResolver: () => ({ name: ref => names.get(`${ref.type}:${ref.id}`) }), open: ref => router.navigate(urlOf(ref)) };

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <IamProvider product="Notes" router={router} features={{ entra: true }} resources={resources}>
      <App />
    </IamProvider>
  </QueryClientProvider>,
);

// an jeder Ressource mit Freigaben, z. B. im Kopf eines Ordners
<AccessSheet resource={{ type: 'folder', id: folder.id }} label={folder.name} open={open} onClose={() => setOpen(false)} />
```

- **Router-Adapter** (`router`): `{ Link, navigate, useSearch, usePathname }`; ohne Angabe die History-API. Beispiel für
  TanStack Router und React Router: [iam-web › Routen](../packages/iam-web/README.md#routen-und-navigation).
- **Seiten einhängen:** `makeIamRoutes(paths, features)` (bzw. `iamRoutes`) liefert je Verwalten-Seite Pfad, Bedarf und
  `load()` mit Guard; `<IamNav>` zeichnet die Gruppe «Zugang» (Mitglieder, Anmeldung, Organisationen) nach Recht.
- **`paths`** (`members`, `entra`, `organizations`, Standard `/verwalten/…`) und **`features`** (`access`, `entra`,
  `platform`). `paths.entra` muss zu `ENTRA_UI_PATH` des Servers passen (beide Standard `/verwalten/anmeldung`).
  `features.entra: true` für Schritt 10.
- **Zugriff:** `AccessSheet` (Seitenleiste «Zugriff» mit Freigeben, Ablauf, Entfernen), `WhyDialog` («Warum sehe ich
  das?»), `ClassificationBadge` und `BreakGlassBanner` (in die Shell, bei Klassifizierung) bindet die App dort ein, wo
  ihre Ressourcen stehen; `resources.open` macht die Orte im Panel, in «Meine Rechte» und in «Mitglieder» anklickbar.
- **Farben:** Das Paket färbt nur über `--iam-*`; die App bildet ihre Tokens ab, z. B.
  `:root { --iam-accent: var(--accent); --iam-surface: var(--surface); }`.
- In der App: `useIam()` (`me` mit `permissions`, `somewhere`, `clearance`, `can`, `orgName`, `switchOrg` …),
  `<Can perm>`, `useResourceCan()`.

> Assets: `web/src/main.tsx`, `web/src/features/access/*` (Adapter für `AccessSheet`), `web/src/styles/iam.css`.

## 9. Tests, CI und Image

Mit `@vollholz/iam-testkit` 1.3.0 (Spezifikation Kap. 14):

- **Wegwerf-Datenbank** je Testdatei: `testDatabases({ prefix, owner, connect, migrate, runtime, closeRuntime })`.
- **Modell:** `checkModel(model)` und `checkCatalog(<Antwort von GET /v1/authz/catalog>)` ergeben keine Fehler;
  dazu die Standardfälle der Entscheidung aus dem Test-Kit (Spezifikation 14, `access`).
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
DATABASE_ADMIN_URL=postgres://notes_owner:…@…/notes \
  npx iam-org-bootstrap --alias solutions --name "Solutions" \
  --email anna@example.ch --first Anna --last Admin --platform-admin
```

In Keycloak entstehen Organisation und Konto (Pflichtaktion «Passwort festlegen», Realm-Rolle `platform-admin`); ab
`@vollholz/iam` 1.5 erhält die neue Person von Keycloak eine E-Mail «Passwort festlegen» (gültig 7 Tage; SMTP im Realm
nötig, sonst meldet der Lauf «Einladung NICHT gesendet an: …» und läuft weiter – dann SMTP einrichten und mit `--resend`
wiederholen oder `--initial-password`). `--no-email` schaltet die Einladung ab. In der
Datenbank der App schreibt das Skript mit der Migrationsrolle Mandant, Principal, das Tupel `org-admin` an der
Organisation und Freigabestufe 2 (Audit `tenant.provisioned`). Rollen stehen nicht mehr in Keycloak (Spezifikation
[9.1](spezifikation.md#91-regeln)).

**Entra ID: beim Betreiber nichts.** Keine Entra-App der Plattform, `ENTRA_CLIENT_ID` bleibt leer. Jede
Kunden-Organisation verbindet sich selbst mit einer **eigenen App-Registrierung** in ihrem Tenant: unter Verwalten ›
Anmeldung «Eigene App verbinden» oder über den Link «Credentials eintragen» an die Kunden-IT. Die Oberfläche zeigt die
Anleitung (Umleitungs-URI `<OIDC_ISSUER_URL>/broker/entra-app-<alias>/endpoint`, Berechtigungen `User.Read` delegiert,
`Organization.Read.All`, `User.Read.All`, `Application.Read.All`, `GroupMember.Read.All` (Gruppen in Freigaben) als
Anwendung mit Administratorzustimmung,
geheimer Clientschlüssel). Voraussetzungen der App: `entra = true` im Realm (Schritt 3), `ENCRYPTION_KEYS`,
Verwaltung (`KEYCLOAK_MGMT_*`) und `features.entra` (Schritt 8). Hintergrund:
[backend.md › Betrieb](../packages/iam/docs/backend.md#8-betrieb).

> Assets: `docs/einrichtung.md` › Microsoft Entra ID › Organisation (Kunden-IT, im eigenen Tenant),
> `docs/konzepte/entra-id.md`.

## Zurücksetzen und neu aufsetzen

Ab `@vollholz/iam` 1.4.0 lässt sich eine App automatisiert vollständig zurücksetzen und frisch aufsetzen, etwa für
eine Test- oder Vorführumgebung (Workflow der App mit `KEYCLOAK_IAC_PRIVATE_KEY` und `DATABASE_ADMIN_URL` als
Secrets). Realm, Clients, Scopes und Einstellungen gehören weiter dem Realm-Modul; Struktur, Rollen und Policies der
Datenbank den Migrationen.

```sh
export KEYCLOAK_TF_URL=https://identity.project-suite.ch KEYCLOAK_TF_REALM=notes KEYCLOAK_IAC_PRIVATE_KEY_B64=… \
       DATABASE_ADMIN_URL=postgres://notes_owner:…@…/notes
npx iam-reset --keycloak --database --confirm notes --dry-run     # zeigt nur, was gelöscht würde
npx iam-reset --keycloak --database --confirm notes [--keep-table <tabelle> …]
npx iam-org-bootstrap --file init.json
```

- `iam-reset --database` leert als Migrationsrolle alle Tabellen im Schema der App ausser der Migrationsbuchhaltung
  (`schema_migrations`) und den mit `--keep-table` genannten (z. B. Stammdaten der App). Verweist eine ausgenommene
  Tabelle per Fremdschlüssel auf eine zu leerende, bricht der Befehl ab, statt sie mitzuleeren.
- `iam-reset --keycloak` löscht alle Organisationen samt ihrer Entra-Anbieter und alle Personen im Realm; die Service
  Accounts der Clients bleiben.
- `--confirm` muss dem Realm entsprechen. Die Zeile `audit {"action":"platform.reset", …}` der Ausgabe ist der
  Nachweis (das Audit-Protokoll der App ist danach leer).
- `init.json` (Format `node_modules/@vollholz/iam/schema/init.schema.json`), je Organisation alle Admins wie Schritt 10
  (Konto, Mitgliedschaft, `org-admin`, Freigabestufe 2, Einladung per E-Mail an neue Konten), idempotent, mit
  `--dry-run` als Probelauf. Nach dem Zurücksetzen sind alle Konten neu: ohne Einladung (bis 1.4) konnte sich niemand
  anmelden. Die Zeilen `Einladung gesendet an: …` / `Einladung NICHT gesendet an: …` gehören in die Zusammenfassung des
  Workflows:

```json
{
  "$schema": "./node_modules/@vollholz/iam/schema/init.schema.json",
  "organizations": [
    { "alias": "solutions", "name": "Solutions",
      "admins": [ { "email": "anna@example.ch", "first": "Anna", "last": "Admin", "platformAdmin": true } ] }
  ]
}
```

---

## Fertig, wenn

- [ ] `npm ci` läuft lokal und in GitHub Actions (Pakete für das Repository freigegeben, Deploy-Key für die Module).
- [ ] Eintrag `notes` in vollholz/identity mit `grant_realm_admin = true`; `notes-tofu`-Schlüssel nur lokal.
- [ ] Realm per Workflow «Keycloak» der App eingerichtet; der Kontrollplan zeigt «No changes».
- [ ] `platform.json` aus `model.platformJson()` stimmt mit dem Modell überein.
- [ ] Migrationen laufen als `notes_owner`, IAM vor App; die Laufzeit nutzt `notes_runtime` (ohne BYPASSRLS).
- [ ] `loadIamConfig` ohne Fehler in `production`; `iamWarnings` leer oder bewusst akzeptiert; `ENTRA_CLIENT_ID` leer.
- [ ] Fastify mit `removeAdditional: false`, `@fastify/rate-limit`, Swagger vor dem Plugin; `/readyz` mit `readinessChecks`.
- [ ] Oberfläche: Anmeldung, Auswahl der Organisation, Verwalten-Seiten «Zugang» erreichbar, Farben über `--iam-*`.
- [ ] Tests: Katalog, RLS-Prüfungen und Isolations-Durchlauf grün (jede Route geprüft oder begründet ausgenommen).
- [ ] Erste Organisation mit org-admin angelegt; Anmeldung und Einladung einer zweiten Person funktionieren.
- [ ] Eine Test-Organisation hat sich mit einer eigenen Entra-App verbunden und die Testanmeldung bestanden.
