# @vollholz/iam-testkit

Tests für Apps mit dem Baukasten (Spezifikation Kap. 14). Herkunft: vollholz/assets `test/platform/harness.ts`,
`keycloak-fake.ts`, `rls.test.ts`, `tenant-isolation.test.ts`.

| Baustein | Inhalt |
|---|---|
| `testDatabases({ prefix, owner, connect, migrate, runtime, closeRuntime })` | Wegwerf-Datenbank je Testdatei mit den Migrationen der App: `superuserUrl`, `dbAvailable`, `createTestDb`, `testDbName`, `sweepStaleTestDbs`. Umgebung `POSTGRES_SUPERUSER_PASSWORD`/`POSTGRES_PORT` oder `TEST_POSTGRES_URL`, `DATABASE_URL`, `DATABASE_ADMIN_URL`, `DATABASE_WORKER_URL` |
| `startMockIdp({ audience, realm?, exchange? })`, `dpopKey()` | Discovery, JWKS, Tokens, Token Exchange (RFC 8693) mit DPoP, DPoP-Proofs |
| `claimsFor({ personClientId, roleClientId?, groupPrefix? })` | `user()` und `client()`: Claims wie Keycloak (Organisationen, Rollengruppen, Service Accounts) |
| `KeycloakFake` | Admin-API als `fetch`-Ersatz: Organisationen, Konten, Gruppen, Einladungen, Identity Provider; ab 0.3.0 Gruppennamen mit «/» abgelehnt (400), Präfixe mit mehreren Stufen also Stufe für Stufe anlegen |
| `EntraFake` (ab 0.3.0) | Microsoft Entra ID als `fetch`-Ersatz für die Entra-Anbindung: OpenID-Konfiguration je Tenant, Zustimmung mit Anmeldung (`approve`: Code-Flow mit PKCE, ID-Token mit `wids`, Gast, eigenem JWKS), Token mit Client Credentials (Zustimmung, Geheimnis, Verzögerung), Graph `/organization` und `/users` mit `$filter` und `$search` |
| `checkCatalog(GET /v1/authz/catalog, { product?, acl?, members? })` | reservierte Namen, Schlüsselregeln, Vollständigkeit (Kap. 8); ab 0.2.0 Stichwörter der Gruppen in Rollenbeschreibungen (`groups[].match`) und Rechte nur für Personen (`personOnly`), wenn der Katalog sie liefert |
| `tenantTableProblems`, `grantedTableProblems`, `securityDefinerProblems`, `publicSchemaProblems`, `publicExecuteProblems`, `bypassRoleProblems` | allgemeine RLS-Prüfungen; liefern Befunde als Liste |
| `routeCollector`, `installProbes`, `unreached`, `idSource`, `normalize`, `leaks`, `coverageProblems`, `routesOf`, `openApiPath` | Gerüst für den Isolations-Durchlauf über alle Routen |

```ts
import { checkCatalog, tenantTableProblems, testDatabases } from '@vollholz/iam-testkit';

const dbs = testDatabases({ prefix: 'notes_test_', owner: 'notes_owner', connect: ['notes_app'],
  migrate: (url, dir) => migrate(url, dir), runtime: url => createPool(url), closeRuntime: p => p.end() });

test('Katalog', () => assert.deepEqual(checkCatalog(authzCatalog(), { product: 'notes', acl: true }), { errors: [], warnings: [] }));
test('RLS', async () => {
  const t = await dbs.createTestDb();
  assert.deepEqual(await tenantTableProblems(t.inspect, { appRole: 'notes_app' }), []);
  await t.drop();
});
```

## Änderungen

- **0.3.1:** `KeycloakFake` mit `PUT /users/{id}/reset-password` (temporär: Pflichtaktion «Passwort setzen»)
  und `GET /roles/{name}` für die Ersteinrichtung (`orgBootstrap`); `checkCatalog` kennt `resourceTypes[].leaf`.
- **0.3.0:** `EntraFake` (vorher nur in den Tests von `@vollholz/iam`) mit `FakeTenant` und `FakeEntraUser`, dazu
  `approve` für die Zustimmung mit Anmeldung. `KeycloakFake` mit Realm-Rollen (`realmRoles`, `realmRoleMappings`).
  `KeycloakFake` lehnt Gruppennamen mit «/» ab (400): Keycloak legt einen solchen Namen als eine Gruppe an, nie als
  Stufen. Tests, die `POST /groups` mit `a/b` erwarteten, legen die Stufen einzeln an.
- **0.2.0:** `checkCatalog` prüft `groups[].match` und `personOnly`.

Einbinden: `.npmrc` mit `@vollholz:registry=https://npm.pkg.github.com`, Zugang mit `read:packages`.
