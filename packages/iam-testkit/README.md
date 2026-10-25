# @vollholz/iam-testkit

Tests für Apps mit dem Baukasten (Spezifikation Kap. 14): Testdatenbanken, nachgebildeter Identity Provider, Keycloak-
und Entra-Fakes, Prüfungen von Modell und RLS sowie ein Gerüst für den Isolations-Durchlauf. Produktneutral; die
Beispiele nutzen die Notiz-App `notes`.

| Baustein | Inhalt |
|---|---|
| `testDatabases({ prefix, owner, connect, migrate, runtime, closeRuntime })` | Wegwerf-Datenbank je Testdatei mit den Migrationen der App: `superuserUrl`, `dbAvailable`, `createTestDb`, `testDbName`, `sweepStaleTestDbs`. Umgebung `POSTGRES_SUPERUSER_PASSWORD`/`POSTGRES_PORT` oder `TEST_POSTGRES_URL`, `DATABASE_URL`, `DATABASE_ADMIN_URL`, `DATABASE_WORKER_URL` |
| `startMockIdp({ audience, realm?, exchange? })`, `dpopKey()` | Discovery, JWKS, Tokens, Token Exchange (RFC 8693) mit DPoP, DPoP-Proofs |
| `claimsFor({ personClientId })` | `user()` und `client()`: Claims wie Keycloak (Organisationen, Gruppen aus Entra als Objekt-IDs, Scopes, Service Accounts); nie Rollen – Rollen sind Tupel in der App |
| `KeycloakFake` | Admin-API als `fetch`-Ersatz: Organisationen, Konten, Mitgliedschaft (`member(org, user)` ohne Rollen), Einladungen, Identity Provider mit Mappern, Realm-Rollen |
| `EntraFake` (ab 0.3.0) | Microsoft Entra ID als `fetch`-Ersatz für die Entra-Anbindung: OpenID-Konfiguration je Tenant, Zustimmung mit Anmeldung (`approve`: Code-Flow mit PKCE, ID-Token mit `wids`, Gast, eigenem JWKS), Token mit Client Credentials (Zustimmung, Geheimnis, Verzögerung), Graph `/organization`, `/users` und `/groups` mit `$filter` und `$search`; ab 0.4.0 eigene Apps je Tenant (`app`); ab 1.0.0 Gruppen je Tenant (`FakeTenant.groups`, `GroupMember.Read.All`) |
| `checkModel(GET /v1/authz/catalog, { product?, members?, platformJson? })` | Prüfungen M1–M12 des Modells (Kap. 8) auf dem ausgelieferten Katalog: reservierte Namen, Schlüsselregeln, Typen und Kette, Blätter, Rollen je Typ, Stichwörter der Gruppen, Rechte nur für Personen; `platform.json` nur mit Scopes (O4) |
| `accessCases(model)`, `runAccessCases(cases, decide)` | Standardfälle der Entscheidung je Rolle und Scope (an org, mit und ohne Scope), gegen `can` der App |
| `tenantTableProblems`, `grantedTableProblems`, `securityDefinerProblems`, `publicSchemaProblems`, `publicExecuteProblems`, `bypassRoleProblems`, `readViewProblems`, `READ_VIEW_FUNCTIONS` | allgemeine RLS-Prüfungen, dazu `authz_tuple` (RLS mit FORCE, Mandantentrennung) und die Funktionen der Lesesicht (vorhanden, `SECURITY INVOKER`, `STABLE`, fester `search_path`, ausführbar für die App); liefern Befunde als Liste |
| `routeCollector`, `installProbes`, `unreached`, `idSource`, `normalize`, `leaks`, `coverageProblems`, `routesOf`, `openApiPath` | Gerüst für den Isolations-Durchlauf über alle Routen |

```ts
import { checkModel, readViewProblems, tenantTableProblems, testDatabases } from '@vollholz/iam-testkit';

const dbs = testDatabases({ prefix: 'notes_test_', owner: 'notes_owner', connect: ['notes_app'],
  migrate: (url, dir) => migrate(url, dir), runtime: url => createPool(url), closeRuntime: p => p.end() });

test('Modell', () => assert.deepEqual(checkModel(model.toJSON(), { product: 'notes', platformJson: model.platformJson() }), { errors: [], warnings: [] }));
test('RLS', async () => {
  const t = await dbs.createTestDb();
  assert.deepEqual(await tenantTableProblems(t.inspect, { appRole: 'notes_app' }), []);
  assert.deepEqual(await readViewProblems(t.inspect, { schema: 'notes', appRole: 'notes_app' }), []);
  await t.drop();
});
```

## Änderungen

- **1.3.1:** Lizenz Apache-2.0, Doku ohne App-Bezug; keine Änderung am Code.
- **1.3.0:** `checkModel` (M5) lässt an `org` eine Rollenliste zu: `org-admin` enthalten, nur Rollen des Modells, keine Doppelten (vorher: alle Rollen).
- **1.2.0:** `checkModel` prüft `types[].membersRole` (M13: nur bei Typen mit `owner`, am Typ zulässig, keine Rechte nur von `org-admin`).
- **1.1.0:** `personCases` (Standardfälle der Zuständigkeit über Personen aus Fachdaten je Typ mit `scope`);
  `runAccessCases` nimmt beliebige Fälle; `READ_VIEW_FUNCTIONS` mit `read_person()`, `write_person()`.
- **1.0.0 (brechend, «Authz neu»):** `checkModel` ersetzt `checkCatalog`; neu `accessCases`/`runAccessCases` und
  `readViewProblems`. `claimsFor` ohne Rollen (`roles`, `groupRoles`, `roleClientId`, `groupPrefix` entfallen; Gruppen
  sind Objekt-IDs aus Entra). `KeycloakFake.member(org, user)` ohne Rollen, `rolesOf` und das Gruppenpräfix entfallen,
  Mapper an Identity Providern (`…/identity-provider/instances/{alias}/mappers`). `EntraFake` mit Gruppen
  (`/groups` mit `$search`, `/groups/{id}`) und `GroupMember.Read.All` in den Standardberechtigungen.
- **0.4.0:** `EntraFake.app(tenant, o)`: eigene App einer Organisation in ihrem Tenant (`FakeApp`: eigenes Geheimnis,
  erteilte Anwendungsberechtigungen als `roles` im Token, Graph prüft sie mit 403, `passwordCredentials` unter
  `/applications(appId='…')` nur im Heimat-Tenant und mit Application.Read.All; `consentedIn`: mandantenfähige App mit
  Zustimmung in weiteren Tenants). Wie Microsoft: App ohne Zustimmung im Tenant AADSTS700016,
  falsches Geheimnis AADSTS7000215, abgelaufen AADSTS7000222.
- **0.3.1:** `KeycloakFake` mit `PUT /users/{id}/reset-password` (temporär: Pflichtaktion «Passwort setzen»)
  und `GET /roles/{name}` für die Ersteinrichtung (`orgBootstrap`); `checkCatalog` kennt `resourceTypes[].leaf`.
- **0.3.0:** `EntraFake` (vorher nur in den Tests von `@vollholz/iam`) mit `FakeTenant` und `FakeEntraUser`, dazu
  `approve` für die Zustimmung mit Anmeldung. `KeycloakFake` mit Realm-Rollen (`realmRoles`, `realmRoleMappings`).
  `KeycloakFake` lehnt Gruppennamen mit «/» ab (400): Keycloak legt einen solchen Namen als eine Gruppe an, nie als
  Stufen. Tests, die `POST /groups` mit `a/b` erwarteten, legen die Stufen einzeln an.
- **0.2.0:** `checkCatalog` prüft `groups[].match` und `personOnly`.

Einbinden: `.npmrc` mit `@vollholz:registry=https://npm.pkg.github.com`, Zugang mit `read:packages`.
