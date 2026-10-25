<!-- {{MARK}} -->

# Anmeldung und Rechte: was vom Identity-Kit kommt

Diese App nutzt das [Identity-Kit](https://github.com/vollholz/identity-kit) (Gerüst `create-iam-app` {{KIT}}) für
Anmeldung, Organisationen, Rechte und Datenbank-Schutz. Jede Vorgabe gehört zu genau einer **Zone**; daran sieht man,
woher sie kommt und wer sie ändern darf.

| Zone | Wer bestimmt | Wo | Ändern |
|---|---|---|---|
| **Fest** | Identity-Kit | Realm-Modul, Pakete `@vollholz/*`, verwaltete Dateien (unten) | nur mit einer neuen Version des Kits |
| **Einstellbar** | diese App | `identity.app.json` | Pull Request; der Workflow «Keycloak» wendet es an |
| **App-eigen** | diese App | Modell, Ressourcen, Policies, Oberfläche, Texte | frei, innerhalb der Prüfregeln des Kits |

Was in keiner Zone «Einstellbar» oder «App-eigen» steht, ist **Fest**.

## Verwaltete Dateien (nicht von Hand ändern)

Diese Dateien schreibt `npx @vollholz/create-iam-app sync`; ihre Prüfsummen stehen in `.identity-kit.lock`. Eine
Änderung von Hand meldet der Konformitätstest als Fehler.

{{MANAGED_FILES}}

Sie lesen ihre Werte aus `identity.app.json`: Eine geänderte Einstellung braucht kein neues Gerüst.

## Einstellbar: `identity.app.json`

| Feld | Wirkung |
|---|---|
| `product`, `displayName`, `publicBaseUrl`, `keycloakUrl` | Name, Realm, Clients `<produkt>-*`, Datenbankrollen `<produkt>_*`, Adressen |
| `realm.entra`, `realm.m2m`, `realm.mcp`, `realm.smtp` | Anmeldung über Entra ID je Organisation, Maschinen-Clients, MCP-Dienst, Mailkonto |
| `realm.machineClients` | Maschinen-Clients als Code (öffentlicher Schlüssel in `infra/keycloak/keys/<client>.json`) |
| `realm.theme`, `realm.themeTexts`, `realm.localization`, `realm.supportedLocales` | Aussehen und Texte der Anmeldeseiten |
| `state` | S3-Backend des OpenTofu-States |
| `organizations` | erste Organisationen mit ihren Admins (`npx iam-org-bootstrap --manifest identity.app.json`) |
| `exceptions` | begründete Abweichungen (eigene Dateien, Tabellen ohne `tenant_id`, SECURITY DEFINER); jede erscheint im Konformitätstest |

Schema mit allen Feldern: `node_modules/@vollholz/iam-testkit/schema/identity-app.schema.json`.

## App-eigen

- Modell (`defineModel`): Rechte, Rollen, Scopes, Typen – Regeln M1–M13 prüft der Konformitätstest.
- Ressourcen (`ResourceModel`) und die RLS-Policies der eigenen Tabellen (Migrationen der App, nach denen des Kits).
- Oberfläche (Design-Tokens über `--iam-*`), Texte.

## Prüfen

| Was | Wie |
|---|---|
| Repository (jeder Pull Request) | `npx iam-conformity-test` (Workflow «Konformität Identity-Kit») |
| Datenbank (nach den Migrationen) | `npx iam-conformity-test --db --no-repo` mit `DATABASE_ADMIN_URL` |
| Realm (live, nur lesend) | `npx iam-conformity-test --realm --no-repo` mit `KEYCLOAK_IAC_PRIVATE_KEY`; zentral jede Nacht beim Betreiber |

Unterstützt sind die aktuelle und die vorherige Hauptversion jedes Teils (enger, wo Teile nur zusammen funktionieren);
ausserhalb meldet der Test einen Fehler. Upgrade: Version der Pakete erhöhen (Renovate), dann
`npx @vollholz/create-iam-app@<version> sync` für die verwalteten Dateien.
