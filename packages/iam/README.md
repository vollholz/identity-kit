# @vollholz/iam

Backend-Baustein (Node 24, TypeScript, Fastify-Adapter). Spezifikation Kap. 4–10 und 12; Entwurf und Festlegungen in
[`docs/entwurf.md`](docs/entwurf.md).

Inhalt (Ziel 0.1.0): Konfiguration, Token-Prüfung (Bearer, DPoP, mTLS), Principal, BFF (`/auth/*`), Entscheidung
(Rolle ∨ Freigabe) ∧ Scope ∧ kein Verbot/keine Beschränkung mit dem Katalog der App, Zugriffsregeln (`/v1/acl…`),
eigene Rollen (`/v1/roles`), Verwaltung (`/v1/admin/*`, `/v1/platform/*`), Abgleich der Mitglieder, Freigaben von
Maschinen-Clients, MCP-Token-Austausch, SQL-Migrationen `iam_…`.

Herkunft: vollholz/assets `src/platform/{auth,authz}`, `src/platform/modules/{auth,admin}`, `src/platform/ops/tenants.ts`,
`src/platform/worker/member-sync.ts`, IAM-Teile der Migrationen.

## Stand (Teil-PR 3)

| Baustein | Inhalt |
|---|---|
| `loadIamConfig(env, { product, service })`, `IAM_VARS(product)`, `readVars`, `iamConfigErrors`, `iamConfig`, `iamWarnings` | Variablen nach Kap. 13 mit Standardwerten je Produkt, Pflicht je Dienst, Warnungen bei Client-Geheimnissen |
| `migrate(adminUrl, sources)`, `iamMigrations({ product, schema?, resourceTypes?, leafTypes?, adopted? })`, `dirMigrations(dir)` | Runner (wie Assets) und die Migrationen `iam_001`–`iam_010`; Übernahme bestehender Objekte mit Prüfung der Vorbedingungen |
| `db/bootstrap.sql` | Datenbankrollen nach Kap. 10.1 (psql-Variablen `p`, `db`, Passwörter) |
| `withTx`, `withTenant`, `setContext`, `createPool` | Transaktion im Mandantenkontext (`app.tenant_id`, `app.principal_id`, Einstellungen der App) |
| `pgAudit({ schema })`, `AuditPort` | Audit in derselben Transaktion (Hash-Kette per Trigger) |
| `HttpError`, `problemBody` | Fehler nach RFC 9457 |
| `Sealer`, `box`/`unbox` | AES-256-GCM mit Schlüsselrotation (Sitzungen) |
| `PgReplayStore`, `MemoryReplayStore`, `pgRateLimitStore`, `purgeSharedState` | geteilter Zustand über Instanzen |
| `LOCKS`, `lockKey` | Sperren in PostgreSQL als Vertrag |
| `defineCatalog(input)` | Rechtekatalog der App: reservierte Namen ergänzt, `org-admin` mit allen Rechten, Prüfungen (Kap. 8, Stichwörter je Gruppe, Rechte nur für Personen), `toJSON()` = `GET /v1/authz/catalog`, `platformJson()` |
| `OidcProvider`, `TokenVerifier` | Token-Prüfung: Signatur, Aussteller, Zielgruppe, nur Access Tokens, DPoP mit Replay-Schutz, mTLS |
| `PrincipalResolver` | Principal aus dem Token: Organisation und Wahl, Person oder Client, Rollen und Gruppen der Organisation, Freigabe, Austritt, «Nur Entra», Zwischenspeicher mit `forget…` |
| `AccessService`, `ResourceModel`, `flatResources`, `capabilities`, `canSchema` | Entscheidung (Rolle ∨ Freigabe) ∧ Scope ∧ Zugriffsregeln mit der Kette der App, Fähigkeiten `can`, Zugriffsstand für ETags |

```ts
import { AccessService, defineCatalog, dirMigrations, iamMigrations, loadIamConfig, migrate, PrincipalResolver } from '@vollholz/iam';

export const catalog = defineCatalog({ product: 'notes', permissions: { 'note:read': { label: 'Notizen lesen', group: 'notes', description: '…' } },
  groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }], roles: { viewer: { label: 'Leser:in', description: 'Liest Notizen.', permissions: ['tenant:read', 'note:read'] } },
  scopes: { 'notes:read': { text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] } } });

const cfg = loadIamConfig(process.env, { product: 'notes', service: 'api' });
await migrate(cfg.db.adminUrl!, [
  iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'note'], leafTypes: ['note'] }),
  dirMigrations('db/migrations'),
]);
```

Tests: `npm test` (mit PostgreSQL: `POSTGRES_SUPERUSER_PASSWORD`, `POSTGRES_PORT`; Rollen legen die Tests selbst an).
Den Abzug von Assets für den Gleichheitstest erzeugt `node scripts/assets-schema.ts <assets>/db/migrations <commit>`,
den Katalog von Assets für den Pflichttest `node scripts/assets-catalog.ts <assets> <commit>`.
