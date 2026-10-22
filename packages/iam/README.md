# @vollholz/iam

Backend-Baustein (Node 24, TypeScript, Fastify-Adapter). Spezifikation Kap. 4–10 und 12.

Inhalt: Konfiguration, Token-Prüfung (Bearer, DPoP, mTLS), Principal, BFF (`/auth/*`), Entscheidung
(Rolle ∨ Freigabe) ∧ Scope ∧ kein Verbot/keine Beschränkung mit dem Katalog der App, Zugriffsregeln (`/v1/acl…`),
eigene Rollen (`/v1/roles`), Verwaltung (`/v1/admin/*`, `/v1/platform/*`), Abgleich der Mitglieder, Freigaben von
Maschinen-Clients, MCP-Token-Austausch, SQL-Migrationen `iam_…`.

Herkunft: vollholz/assets `src/platform/{auth,authz}`, `src/platform/modules/{auth,admin}`, `src/platform/ops/tenants.ts`,
`src/platform/worker/member-sync.ts`, IAM-Teile der Migrationen.

Stand: leer.
