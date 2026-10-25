# Identity-Kit

Baukasten für Anmeldung und Rechte (authn und authz) von Apps mit Keycloak (ab 26.8, Organisationen als Mandanten).
Ziel: eine replizierbare, app-agnostische Lösung, die sich standardisiert auf Apps ausrollen lässt – Frontend und Backend, für
Personen, Service-Clients, M2M, API und MCP.

> **Neue App anbinden: [docs/neue-app.md](docs/neue-app.md)** – in 10 Schritten von den Zugängen über Realm,
> Datenbank, Backend und Oberfläche bis zu Tests, CI und Entra ID.

- **Standard** (dieses Repository): Realm-Soll, Anmeldung (BFF), Token-Prüfung, Mandanten = Keycloak-Organisationen,
  Rechte-Entscheidung, Zugriffsregeln, eigene Rollen, Verwaltung, Datenbank-Schutz (RLS), Oberflächen-Bausteine, Tests.
- **App-lokal** (liefert jede App): Rechtekatalog (Rechte, vordefinierte Rollen, Scopes), Ressourcen, Design-Tokens,
  Texte.

Vertrag und Regeln: **[docs/spezifikation.md](docs/spezifikation.md)**.

## Aufbau

| Verzeichnis | Inhalt | Spezifikation |
|---|---|---|
| `docs/` | Spezifikation (Vertrag), später Entscheide und Migrationshinweise | – |
| `modules/product-realm` | OpenTofu-Modul: Realm einer App nach Soll | Kap. 3 |
| `modules/product-realm-bootstrap` | OpenTofu-Modul: Anlage von Realm und `<produkt>-iac` mit `<produkt>-tofu` | Kap. 2 |
| `packages/iam` | `@vollholz/iam` – Backend (Node 24, TypeScript, Fastify): Token, Principal, BFF, Rechte, Zugriffsregeln, eigene Rollen, Verwaltung, Abgleich, MCP-Austausch, SQL-Migrationen | Kap. 4–10, 12 |
| `packages/iam-web` | `@vollholz/iam-web` – Frontend (React): Sitzung, Organisation je Tab, Rechte-Bausteine, Verwalten-Seiten | Kap. 11 |
| `packages/iam-testkit` | `@vollholz/iam-testkit` – Wegwerf-Datenbank, Mock-IdP, Keycloak-Nachbildung, Isolations-Durchlauf, RLS- und Katalogprüfung; später Konformitätstests | Kap. 14 |
| `templates/create-iam-app` | Gerüst für eine neue App | Kap. 15.3 |

## Stand

| Teil | Stand |
|---|---|
| `packages/iam` | **2.0.0** – Backend: Token, Principal, BFF, Rechte, Zugriffsregeln, Rollen als Tupel in der Datenbank der App, Verwaltung, Abgleich, MCP, Migrationen; Entra ID mit eigener App der Organisation; `iam-org-bootstrap` (mit Einladung «Passwort festlegen»), `iam-reset` ([README](packages/iam/README.md), [Leitfaden](packages/iam/docs/backend.md)) |
| `packages/iam-web` | **1.2.1** – Oberfläche: Sitzung, Organisation je Tab, Rechte-Bausteine, Verwalten-Seiten «Zugang» ([README](packages/iam-web/README.md)) |
| `packages/iam-testkit` | **1.3.1** – Wegwerf-Datenbank, Mock-IdP, Claims, Keycloak- und Entra-Nachbildung, Katalog-, RLS- und Isolationsprüfungen ([README](packages/iam-testkit/README.md)) |
| `modules/product-realm` | **2.0.0** – Realm-Soll als OpenTofu-Modul für jede Keycloak-Instanz (`keycloak_url` Pflicht), ohne Rollen (Rollen stehen nur in der Datenbank der App), Maschinen-Clients als Code (`machine_clients`); gegen Keycloak 26.8.1 ([README](modules/product-realm/README.md)) |
| `modules/product-realm-bootstrap` | **0.1.1** – Anlage von Realm und `<produkt>-iac` |
| `templates/create-iam-app` | leer; bis dahin [docs/neue-app.md](docs/neue-app.md) |

Prüfen: `npm ci && npm run check` (Datenbank-Tests mit `POSTGRES_SUPERUSER_PASSWORD`, `POSTGRES_PORT`; ohne Datenbank
übersprungen). Veröffentlichen: Version des Pakets erhöhen und mergen – der Workflow «Release» veröffentlicht neue
Versionen auf GitHub Packages und setzt das Tag `<paket>-v<version>`. Einbinden in eine App, auch ohne Zugang zur
Registry: [docs/ausrollen.md](docs/ausrollen.md).

Versionierung: je Paket eine semantische Version; npm-Pakete über GitHub Packages (`@vollholz/*`), Module als
Git-Quelle mit Tag (`?ref=<modul>-vX.Y.Z`). Brechende Änderungen: Hinweise im README des jeweiligen Pakets bzw. Moduls.

## Lizenz

[Apache License 2.0](LICENSE); Hinweise zu übernommenen Keycloak-Texten in [NOTICE](NOTICE).
