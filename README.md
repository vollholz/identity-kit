# Identity-Kit

Baukasten für Anmeldung und Rechte (authn und authz) von Apps mit Keycloak (ab 26.8, Organisationen als Mandanten).
Ziel: eine replizierbare, app-agnostische Lösung, die sich standardisiert auf Apps ausrollen lässt – Frontend und Backend, für
Personen, Service-Clients, M2M, API und MCP.

> **Neue App anbinden: [docs/neue-app.md](docs/neue-app.md)** – mit `npx @vollholz/create-iam-app init` von den Zugängen über Realm,
> Datenbank, Backend und Oberfläche bis zu Tests, CI und Entra ID.
> **Auf Hetzner in Betrieb nehmen: [docs/hetzner-einrichten.md](docs/hetzner-einrichten.md)** – Playbook für ein neues
> Hetzner-Projekt: Reihenfolge, wer was tut, Entscheide und Stolpersteine.

- **Standard** (dieses Repository): Realm-Soll, Anmeldung (BFF), Token-Prüfung, Mandanten = Keycloak-Organisationen,
  Rechte-Entscheidung, Zugriffsregeln, eigene Rollen, Verwaltung, Datenbank-Schutz (RLS), Oberflächen-Bausteine, Tests.
- **App-lokal** (liefert jede App): Rechtekatalog (Rechte, vordefinierte Rollen, Scopes), Ressourcen, Design-Tokens,
  Texte.

Vertrag und Regeln: **[docs/spezifikation.md](docs/spezifikation.md)**. Woher eine Vorgabe kommt und wer sie ändern
darf, legen die Zonen fest ([1.2](docs/spezifikation.md#12-zonen-fest-einstellbar-app-eigen)): **Fest** (Kit),
**Einstellbar** (`identity.app.json` der App), **App-eigen** (Modell, Ressourcen, Oberfläche). Ob eine App den Vertrag
einhält, zeigt `npx iam-conformity-test`.

## Aufbau

| Verzeichnis | Inhalt | Spezifikation |
|---|---|---|
| `docs/` | Spezifikation (Vertrag), später Entscheide und Migrationshinweise | – |
| `modules/product-realm` | OpenTofu-Modul: Realm einer App nach Soll | Kap. 3 |
| `modules/product-realm-bootstrap` | OpenTofu-Modul: Anlage von Realm und `<produkt>-iac` mit `<produkt>-tofu` | Kap. 2 |
| `packages/iam` | `@vollholz/iam` – Backend (Node 24, TypeScript, Fastify): Token, Principal, BFF, Rechte, Zugriffsregeln, eigene Rollen, Verwaltung, Abgleich, MCP-Austausch, SQL-Migrationen | Kap. 4–10, 12 |
| `packages/iam-web` | `@vollholz/iam-web` – Frontend (React): Sitzung, Organisation je Tab, Rechte-Bausteine, Verwalten-Seiten | Kap. 11 |
| `packages/iam-testkit` | `@vollholz/iam-testkit` – Wegwerf-Datenbank, Mock-IdP, Keycloak-Nachbildung, Isolations-Durchlauf, RLS- und Katalogprüfung, Manifest-Schema, Konformitätstest `iam-conformity-test` | Kap. 14 |
| `packages/create-iam-app` | `@vollholz/create-iam-app` – Gerüst einer App: Manifest `identity.app.json`, verwaltete Dateien mit Lock-Datei, `sync`, Schlüsselpaare | Kap. 15.4 |
| `packages/platform` | `@vollholz/platform` – Querschnitt einer App auf `@vollholz/iam`: Konfiguration, HTTP, Warteschlange und Outbox, Betrieb, MCP-Dienst, Mandanten, Rotation (`definePlatform`, `defineModule`, `defineApp`) | – |

## Stand

| Teil | Stand |
|---|---|
| `packages/iam` | **5.0.3** – Backend: Token, Principal, BFF, Rechte, Zugriffsregeln, Rollen als Tupel in der Datenbank der App, Verwaltung, Abgleich, MCP, Migrationen, Haken der App vor und nach Änderungen (`events`), eigene Rollen der Organisation; Entra ID mit eigener App der Organisation; `iam-org-bootstrap` (mit Einladung «Passwort festlegen», `--manifest`, ohne Datenbank nur ausdrücklich), `iam-reset` ([README](packages/iam/README.md), [Leitfaden](packages/iam/docs/backend.md)) |
| `packages/iam-web` | **2.2.0** – Oberfläche: Sitzung, Organisation je Tab, Rechte-Bausteine, Verwalten-Seiten «Zugang» (mit «Rollen») ([README](packages/iam-web/README.md)) |
| `packages/iam-testkit` | **2.4.5** – Wegwerf-Datenbank, Mock-IdP, Claims, Keycloak- und Entra-Nachbildung, Katalog-, RLS- und Isolationsprüfungen; Konformitätstest `iam-conformity-test` (Repository, Datenbank, Realm) ([README](packages/iam-testkit/README.md)) |
| `modules/product-realm` | **2.0.0** – Realm-Soll als OpenTofu-Modul für jede Keycloak-Instanz (`keycloak_url` Pflicht), ohne Rollen (Rollen stehen nur in der Datenbank der App), Maschinen-Clients als Code (`machine_clients`); gegen Keycloak 26.8.1 ([README](modules/product-realm/README.md)) |
| `modules/product-realm-bootstrap` | **0.1.1** – Anlage von Realm und `<produkt>-iac` |
| `packages/create-iam-app` | **0.5.5** – `init` (mit Vorgaben des Betreibers), `sync`, `check`, `keys`; Vorlagen für `product-realm` 2.0.0 ([README](packages/create-iam-app/README.md)) |
| `packages/platform` | **0.7.0** – herausgelöst aus nachtschicht: Prozesse `api`, `worker`, `mcp`, Befehle `migrate`, `tenant`, `rotate-keys`, Migration `platform_001_core.sql` mit Übernahme ([README](packages/platform/README.md)) |

Prüfen: `npm ci && npm run check` (Datenbank-Tests mit `POSTGRES_SUPERUSER_PASSWORD`, `POSTGRES_PORT`; ohne Datenbank
übersprungen). Veröffentlichen: Version des Pakets erhöhen, Abschnitt in `packages/<paket>/CHANGELOG.md` schreiben und
mergen – der Workflow «Release» veröffentlicht neue Versionen auf GitHub Packages, setzt das Tag `<paket>-v<version>`
und legt dazu ein GitHub Release mit dem Abschnitt aus CHANGELOG.md an. Einbinden in eine App, auch ohne Zugang zur
Registry: [docs/ausrollen.md](docs/ausrollen.md).

Versionierung: je Paket eine semantische Version (Breaking = Major); npm-Pakete über GitHub Packages (`@vollholz/*`),
Module als Git-Quelle mit Tag (`?ref=<modul>-vX.Y.Z`).

**Release Notes: keine neue Version ohne CHANGELOG-Eintrag.** Jedes Paket führt `packages/<paket>/CHANGELOG.md` nach
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/) mit den Abschnitten Breaking (mit Migrationsschritten für
Apps), Hinzugefügt, Geändert, Entfernt, Behoben. Die CI (`node scripts/changelog.ts check`) ist rot, wenn die Version
eines Pakets keinen Abschnitt `## [<version>] – <datum>` zuoberst hat. Jede Änderung, die eine App anpassen muss, steht
unter Breaking mit Migrationshinweis. Module: Hinweise im README des Moduls.

## Lizenz

[Apache License 2.0](LICENSE); Hinweise zu übernommenen Keycloak-Texten in [NOTICE](NOTICE).
