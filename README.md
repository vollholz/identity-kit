# Identity-Kit

Baukasten für Anmeldung und Rechte (authn und authz) der Apps auf der Identity-Plattform
**https://identity.project-suite.ch** ([vollholz/identity](https://github.com/vollholz/identity)). Ziel: eine
replizierbare, app-agnostische Lösung, die sich standardisiert auf Apps ausrollen lässt – Frontend und Backend, für
Personen, Service-Clients, M2M, API und MCP.

- **Standard** (dieses Repository): Realm-Soll, Anmeldung (BFF), Token-Prüfung, Mandanten = Keycloak-Organisationen,
  Rechte-Entscheidung, Zugriffsregeln, eigene Rollen, Verwaltung, Datenbank-Schutz (RLS), Oberflächen-Bausteine, Tests.
- **App-lokal** (liefert jede App): Rechtekatalog (Rechte, vordefinierte Rollen, Scopes), Ressourcen, Design-Tokens,
  Texte.

Vertrag und Regeln: **[docs/spezifikation.md](docs/spezifikation.md)**. Referenzimplementierung, aus der der Baukasten
herausgelöst wird: [vollholz/assets](https://github.com/vollholz/assets).

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
| `packages/iam-testkit` | **0.1.0** – Wegwerf-Datenbank, Mock-IdP, Claims, Keycloak-Nachbildung, Katalog-, RLS- und Isolationsprüfungen; Assets läuft lokal geprüft darauf (757/757 Tests) |
| übrige Pakete, Module, Vorlage | leer |

Prüfen: `npm ci && npm run check` (Datenbank-Tests mit `POSTGRES_SUPERUSER_PASSWORD`, `POSTGRES_PORT`; ohne Datenbank
übersprungen). Veröffentlichen: Version des Pakets erhöhen und mergen – der Workflow «Release» veröffentlicht neue
Versionen auf GitHub Packages und setzt das Tag `<paket>-v<version>`. Einbinden in eine App, auch ohne Zugang zur
Registry: [docs/ausrollen.md](docs/ausrollen.md).

Reihenfolge (Spezifikation Kap. 15.4): Vertrag festschreiben → Test-Kit (gegen Assets grün) →
Backend-Paket → Realm-Modul → Frontend-Paket → Vorlage → erste neue App. Nach jedem Schritt läuft Assets auf dem
Baukasten, und alle Tests von Assets bleiben grün.

Versionierung: je Paket eine semantische Version; npm-Pakete über GitHub Packages (`@vollholz/*`), Module als
Git-Quelle mit Tag (`?ref=<modul>-vX.Y.Z`).
