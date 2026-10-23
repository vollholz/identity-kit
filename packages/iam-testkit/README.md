# @vollholz/iam-testkit

Tests für Apps mit dem Baukasten (Spezifikation Kap. 14). Herkunft: vollholz/assets `test/platform/harness.ts`,
`keycloak-fake.ts`, `rls.test.ts`, `tenant-isolation.test.ts`.

| Baustein | Inhalt |
|---|---|
| `testDatabases({ prefix, owner, connect, migrate, runtime, closeRuntime })` | Wegwerf-Datenbank je Testdatei mit den Migrationen der App: `superuserUrl`, `dbAvailable`, `createTestDb`, `testDbName`, `sweepStaleTestDbs`. Umgebung `POSTGRES_SUPERUSER_PASSWORD`/`POSTGRES_PORT` oder `TEST_POSTGRES_URL`, `DATABASE_URL`, `DATABASE_ADMIN_URL`, `DATABASE_WORKER_URL` |
| `startMockIdp({ audience, realm?, exchange? })`, `dpopKey()` | Discovery, JWKS, Tokens, Token Exchange (RFC 8693) mit DPoP, DPoP-Proofs |
| `claimsFor({ personClientId, roleClientId?, groupPrefix? })` | `user()` und `client()`: Claims wie Keycloak (Organisationen, Rollengruppen, Service Accounts) |
| `KeycloakFake` | Admin-API als `fetch`-Ersatz: Organisationen, Konten, Gruppen, Einladungen, Identity Provider |
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

Einbinden: `.npmrc` mit `@vollholz:registry=https://npm.pkg.github.com`, Zugang mit `read:packages`.
