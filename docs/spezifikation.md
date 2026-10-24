# Spezifikation: IAM-Baukasten für Apps der Identity-Plattform

Stand 2026-10-23 · Status: **Entwurf, Vertrag für Authz neu (Kap. 7–11, 14)** · Ort: vollholz/identity-kit (bis 2026-10-22 vollholz/identity `docs/produkt-iam.md`) · Abgeleitet aus vollholz/assets (`3c11515`) und vollholz/identity (`667e6bf`)

Diese Spezifikation beschreibt die Identitäts- und Rechteverwaltung (IAM), die vollholz/assets umgesetzt und geprüft
hat, so, dass ein **neues Produkt** sie vollständig übernimmt und an `https://identity.project-suite.ch` angehängt
wird: eigener Realm, Anmeldung über ein BFF, Keycloak-Organisationen als Mandanten, Rollen an Orten, Freigaben,
Vertraulichkeit und Scopes, Verwaltung von Mitgliedern und Organisationen in der App, Mandantentrennung bis in die Datenbank.

- **MUSS** / **SOLL** / **KANN** kennzeichnen die Verbindlichkeit. Ohne Kennzeichnung gilt MUSS.
- `<produkt>` steht für den technischen Namen des Produkts (Kleinbuchstaben, z. B. `assets`), `<Produkt>` für den
  Anzeigenamen (z. B. «Assets»). Was in Assets `assets` heisst, heisst im neuen Produkt `<produkt>`.
- **Referenz** nennt die Stelle in vollholz/assets, die das Verhalten heute umsetzt und als Vorlage dient. Bei
  Widersprüchen gilt diese Spezifikation; Abweichungen der Referenz sind Fehler der Spezifikation und werden hier
  nachgetragen.
- Produktneutral (gleich in jedem Produkt) sind Kapitel 2–7 und 9–14. Rechte, Rollen, Scopes und Typen (Orte) definiert
  die App selbst in ihrem Modell; Kapitel 8 legt die Schlüsselregeln und die reservierten Namen fest, die in jedem
  Produkt gleich heissen.
- Grundlage des Rechtemodells ist [authz-konzept.md](authz-konzept.md); Entscheide und offene Punkte in
  [authz-offene-punkte.md](authz-offene-punkte.md). Greenfield: kein Migrationspfad von ACL, eigenen Rollen und
  Rollengruppen.

## Inhalt

1. [Überblick](#1-überblick) · [Standard und App-lokal](#11-standard-und-app-lokal)
2. [Anbindung an die Identity-Plattform](#2-anbindung-an-die-identity-plattform) · [Kommandozeilen](#21-kommandozeilen)
3. [Realm des Produkts](#3-realm-des-produkts)
4. [Mandanten](#4-mandanten)
5. [Anmeldung der Oberfläche (BFF)](#5-anmeldung-der-oberfläche-bff)
6. [Token-Prüfung und Principal](#6-token-prüfung-und-principal)
7. [Rechtemodell](#7-rechtemodell)
8. [Modell des Produkts](#8-modell-des-produkts)
9. [Verwaltung in der App](#9-verwaltung-in-der-app)
10. [Datenbank](#10-datenbank)
11. [Oberfläche](#11-oberfläche)
12. [Maschinen-Clients und MCP](#12-maschinen-clients-und-mcp)
13. [Konfiguration und Geheimnisse](#13-konfiguration-und-geheimnisse)
14. [Mandantentrennung und Tests](#14-mandantentrennung-und-tests)
15. [Baukasten und Ausrollen](#15-baukasten-und-ausrollen)
16. [Abnahme](#16-abnahme)
17. [Grenzen und Restrisiken](#17-grenzen-und-restrisiken)

## 1. Überblick

```
                         identity.project-suite.ch (vollholz/identity)
                         ┌──────────────────────────────────────────────────────────┐
                         │ Realm master: identity-iac, <produkt>-tofu (create-realm)│
                         │ Realm <produkt> (gehört dem Produkt, IaC im Produkt):    │
                         │   Organisationen = Mandanten (ohne Rollen, ohne Gruppen),│
                         │   Clients <produkt>-platform|-api|-admin|-sync|(-mcp…)   │
                         │ Theme «identity» (Login, Konto, E-Mails)                 │
                         └───────▲───────────────▲──────────────────▲───────────────┘
              OIDC Code + PKCE   │  JWKS, Token  │  Admin-API        │ Admin-API (nur lesen)
                                 │               │  (<produkt>-admin)│ (<produkt>-sync)
 Browser ──Cookie──▶ BFF (/auth/*) ──Access Token──▶ API (/v1) ─────┘        Worker
   SPA, X-Tenant je Tab          Principal: Mandant, Gruppen (Entra), Scopes  Abgleich Mitglieder
                                 Rechte: Tupel + Modell ∧ Vertraulichkeit ∧ Scope
                                          │
                                 PostgreSQL: FORCE RLS je Mandant (app.tenant_id), authz_tuple, Lesesicht
```

Grundsätze (aus assets `docs/zielarchitektur.md`, Leitentscheidungen):

1. **Keycloak ist führend** für Konten, Anmeldung, Organisationen und Mitgliedschaften. Die App speichert keine
   Passwörter und setzt keine.
2. **Eigener Realm je Produkt** (assets Nr. 52). Nie `master`, nie ein Realm eines anderen Produkts. Einmalige
   Anmeldung über mehrere Produkte, falls gewünscht, über Identity Brokering, nicht über einen geteilten Realm.
3. **Mandant = Keycloak-Organisation.** Der Mandant kommt nur aus dem geprüften Token, nie aus der Anfrage (ausser der
   Wahl unter den eigenen Organisationen).
4. **Eine Berechtigungslogik** für Oberfläche, API, MCP und Maschinen-Clients.
5. **Die Datenbank erzwingt die Mandantentrennung** (RLS, Laufzeit-Rolle ohne `BYPASSRLS`, besitzt keine Tabelle).
6. **Keine Tokens im Browser** (BFF), **keine Client-Geheimnisse** (alle vertraulichen Clients `private_key_jwt`).
7. **Alles als Code**, idempotent, mit Freigabe (Plan → Freigabe → Apply); Geheimnisse nie im Klartext im Repository.
8. **Ein Baukasten, nicht Kopien.** Authentisierung und Autorisierung kommen als versionierter Baukasten in jede App
   (Backend, Frontend, Realm-IaC, Tests); die App liefert nur ihre lokalen Teile ([1.1](#11-standard-und-app-lokal),
   [Kapitel 15](#15-baukasten-und-ausrollen)).

### 1.1 Standard und App-lokal

Ziel: eine replizierbare, app-agnostische Lösung für Authentisierung (authn) und Autorisierung (authz) auf der
Standard-Instanz `identity.project-suite.ch`, die sich möglichst standardisiert auf Apps ausrollen lässt – Frontend und
Backend, für Personen, Service-Clients, M2M, API und MCP.

| Standard (Baukasten, in jeder App gleich) | App-lokal (liefert die App) |
|---|---|
| Realm-Soll als OpenTofu-Modul: Einstellungen, Client-Richtlinien, Clients, Mapper, Scopes aus dem Modell | Name, Adressen, SMTP-Absender, welche Zugänge die App anbietet (API für Maschinen, MCP) |
| Anmeldung (BFF), Sitzung, Logout, Token-Prüfung (Bearer, DPoP, mTLS), Principal | – |
| Mandanten = Organisationen, Organisation je Tab, Wechsel | – |
| Entscheidung (Tupel + Modell ∧ Vertraulichkeit ∧ Scope), `can`, «Warum?», «Wer hat Zugriff?», 403-Texte, `GET /v1/authz/catalog` | **Modell** (`defineModel`): Rechte, Rollen, Scopes, Rechtegruppen, Typen mit Rollen je Ort ([Kapitel 7.3](#73-modell-der-app-definemodel), [8](#8-modell-des-produkts)) |
| Freigaben (Tupel-Tabelle, Validierung, Lesesicht je Anfrage, Klassifizierung, Break-Glass, Panel «Zugriff») | **Ressourcen**: Kette, Existenz, Vertraulichkeit, Zuständigkeit als SQL (`ResourceModel`, [7.7](#77-resourcemodel-der-app)); RLS-Policies der Fachtabellen |
| Verwaltung: Mitglieder und Clients, Einladungen, Rollen an der Organisation, Freigabestufe, Organisationen, Abgleich | – |
| Anmeldung über den IdP der Organisation (Microsoft Entra ID, KANN) | ob angeboten; Registrierung der App bei Microsoft |
| Datenbank: Rollen, IAM-Tabellen, RLS-Mechanik, Kontext und Lesesicht je Transaktion | Fachtabellen (erhalten RLS automatisch) und ihre Lese-Policies ([7.6](#76-lesesicht-je-anfrage)) |
| Oberflächen-Bausteine (Sitzung, Rechte-Hinweise, Rechte-Übersicht, Rollenmatrix, Zugriff, Vertraulichkeit, Break-Glass, Verwalten-Seiten) | **Design**: Design-Tokens (Farben, Schrift, Abstände), Komponenten-Hülle; Theme-Werte der Anmeldeseiten ([3.2](#32-theme-und-texte)) |
| Texte des Baukastens (de/en, Du-Form): Oberfläche `iam.*`, Anmeldeseiten, Konto und Einladung (`standard_texts` des Realm-Moduls) | **Texte** der App, Labels und Beschreibungen des Katalogs, Theme-Texte der Anmeldeseiten, Übersetzungen weiterer Sprachen |
| Tests: Isolation über alle Routen, RLS, Lesesicht = `can`, Multi-Org, BFF, Verwaltung, Modellregeln, Entscheidung | Fachtests; Eintrag der Fachrouten in den Isolationstest (automatisch über die Routenliste) |

## 2. Anbindung an die Identity-Plattform

Ablauf über zwei Repositories. Referenz: identity `infra/keycloak/products.tf`, `docs/betrieb.md` › Neues Produkt;
Modul `modules/product-realm-bootstrap`; assets `docs/produktion.md` › Keycloak-Anbindung.

| # | Wo | Schritt | Ergebnis |
|---|---|---|---|
| 1 | identity | `deploy/scripts/secrets.sh client-key <produkt>-tofu <ENV-NAME>` | `infra/keycloak/keys/<produkt>-tofu.json` (öffentlich, versioniert); privater Schlüssel in der lokalen `.env`, an die Betriebsverantwortlichen des Produkts übergeben, hier danach löschen |
| 2 | identity | `infra/keycloak/production.tfvars › products`: `<produkt> = { realm = "<produkt>", iac_client_id = "<produkt>-iac", grant_realm_admin = false }`, Workflow «Keycloak» | Service Account `<produkt>-tofu` im Realm `master` mit Rolle `create-realm`, `private_key_jwt` (ES256) |
| 3 | Produkt | Schlüsselpaar für `<produkt>-iac` erzeugen, `infra/keycloak/keys/<produkt>-iac.json` | öffentlicher Schlüssel versioniert; privater in `.env` (`KEYCLOAK_IAC_PRIVATE_KEY_B64`) und GitHub-Secret `KEYCLOAK_IAC_PRIVATE_KEY` |
| 4 | Produkt | `infra/keycloak/kc.sh bootstrap init && kc.sh bootstrap apply` als `<produkt>-tofu` | Realm `<produkt>` (nur Anlage, `admin_permissions_enabled = true`, `prevent_destroy`, `ignore_changes = all`) und Client `<produkt>-iac` (Service Account, `private_key_jwt`) |
| 5 | identity | `grant_realm_admin = true`, Workflow «Keycloak» | identity-iac weist `<produkt>-iac` `realm-management/realm-admin` zu (mit FGAP v2 darf das nur ein Server-Admin) |
| 6 | Produkt | `infra/keycloak/kc.sh init && kc.sh apply` als `<produkt>-iac` mit dem Modul `product-realm`; zweiter `kc.sh plan` zeigt «No changes» | Realm vollständig nach [Kapitel 3](#3-realm-des-produkts) |
| 7 | Produkt | `iam-org-bootstrap --alias <alias> --name … --email … --platform-admin` oder `iam-org-bootstrap --file <init.json>` | erste Organisation, erste Person (ohne Passwort, Pflichtaktion «Passwort festlegen», Einladung per E-Mail) mit `platform-admin`; dazu schreibt das Skript direkt in die Datenbank der App (`DATABASE_ADMIN_URL`, Migrationsrolle) den Mandanten, den Principal, das Tupel `user:<id> org-admin org` und Freigabestufe 2, Audit `tenant.provisioned` (A20); mit `--file` mehrere Organisationen mit je mehreren Admins ([Kommandozeilen](#21-kommandozeilen)) |

Regeln:

- Der Schlüssel von `<produkt>-tofu` wird nur für Bootstrap, Neuaufbau und den Wechsel des Schlüssels von
  `<produkt>-iac` gebraucht. Er liegt nur lokal (Tresor, für den Bootstrap in der `.env`), **nie** als GitHub-Secret
  und nie in einem Workflow (identity `docs/betrieb.md` › Bewusste Restrisiken).
- Im laufenden Betrieb verwaltet das Produkt seinen Realm ausschliesslich mit `<produkt>-iac` aus seinem Repository
  (Workflow `keycloak.yml`: fmt, validate, tflint, Tests → Plan nach Freigabe, verschlüsselt als Artefakt → Apply genau
  dieses Plans nach zweiter Freigabe → Kontrollplan «No changes»). Ein manueller Lauf «abgleich» plant nur und schlägt
  bei Abweichungen fehl.
- OpenTofu mit Provider `keycloak/keycloak` (Version gepinnt, Lockfile), State im S3-Bucket des Produkts, eigener Key
  für `infra/keycloak` und `infra/keycloak/bootstrap`, clientseitig verschlüsselt (`TF_STATE_PASSPHRASE`). Die
  Anmeldung des Providers kommt nur aus der Umgebung (`kc.sh`), nie aus dem gespeicherten Plan.
- Variable `realm` mit Validierung: nicht `master` und nicht der Realm eines anderen Produkts.
- Das Produkt braucht **keinen** Deploy in vollholz/identity (auch nicht für das Theme, [3.2](#32-theme-und-texte)).

**Umstellung einer bestehenden App auf das Modul** (z. B. Assets): Der Aufruf mit `moved`-Blöcken ergibt im ersten
Plan **nur Verschiebungen** (`Plan: 0 to add, 0 to change, 0 to destroy`, Exit 2) – das ist kein «No changes». Der
Apply nach Freigabe schreibt nur den State; erst der Kontrollplan danach zeigt «No changes». Freigegeben wird nur ein
Plan, der ausschliesslich Verschiebungen enthält (Anzahl = Ressourcen im State, keine Zeile `will be …`/`must be …`,
keine Änderung an Outputs). Der `import`-Block für den Realm bleibt beim Aufrufer (in Modulen nicht erlaubt).

### 2.1 Kommandozeilen

Im Backend-Paket `@vollholz/iam` (`npx …`). Anmeldung bei Keycloak mit dem Service Account der Einrichtung
`<produkt>-iac` (`private_key_jwt`): `KEYCLOAK_TF_URL`, `KEYCLOAK_TF_REALM` (nie `master`), `KEYCLOAK_IAC_CLIENT_ID`
(Standard `<realm>-iac`), `KEYCLOAK_IAC_PRIVATE_KEY` bzw. `KEYCLOAK_IAC_PRIVATE_KEY_B64`. Datenbank: `DATABASE_ADMIN_URL`
(Migrationsrolle), Schema `--schema` (Standard der Realm mit «_»). Ausgabe ohne Geheimnisse; Exit-Code ≠ 0 bei Fehler
(64 falscher Aufruf).

| Befehl | Wirkung |
|---|---|
| `iam-org-bootstrap --alias … --email … [--name] [--domain] [--first] [--last] [--platform-admin]` | Organisation und eine Person als org-admin (Schritt 7, A20); idempotent |
| `iam-org-bootstrap --file <init.json>` | dasselbe für alle Organisationen und Admins der Datei (Format `schema/init.schema.json` im Paket, wird geprüft): `{ "organizations": [ { "alias", "name"?, "admins": [ { "email", "first"?, "last"?, "platformAdmin"? } ] } ] }`; nicht zusammen mit den Einzel-Flags |
| beide zusätzlich | `[--schema …] [--initial-password] [--dry-run]` (Probelauf: nur lesen, Schritte melden) |
| Einladung (ab 1.5) | neu angelegte Personen ohne Passwort und ohne Identitätsanbieter erhalten von Keycloak eine E-Mail «Passwort festlegen» (`execute-actions-email`, `UPDATE_PASSWORD`, gültig 7 Tage, `--invite-days <1–30>`, optional `--client-id <client> [--redirect-uri <url>]`). `--no-email`: keine; `--resend`: auch an bestehende Personen ohne Passwort (z. B. nach Abbruch oder eingerichtetem SMTP). Scheitert der Versand (kein SMTP), meldet der Lauf das und endet mit 0. Am Schluss die Zeilen `Einladung gesendet an: …` bzw. `Einladung NICHT gesendet an: …`. `--initial-password` ist die Alternative ohne SMTP (dann keine Einladung; nicht zusammen mit `--resend`, `--invite-days`, `--client-id`, `--redirect-uri`) |
| `iam-reset --keycloak` | im Realm alle Organisationen samt ihrer Identitätsanbieter (`entra-NNN`, `entra-app-<alias>`) und alle Personen löschen; Service-Account-Benutzer der Clients, Realm, Clients, Scopes, übrige Anbieter und Einstellungen bleiben (sie gehören dem Realm-Modul) |
| `iam-reset --database [--keep-table <name> …]` | als Migrationsrolle alle Tabellen im Schema der App leeren (`TRUNCATE … RESTART IDENTITY CASCADE`) ausser `schema_migrations` und `--keep-table`; Struktur, Rollen, Policies bleiben. Abbruch, wenn CASCADE eine ausgenommene Tabelle mitleeren würde |
| `iam-reset` Schutz | Pflicht `--confirm <realm>` (= `KEYCLOAK_TF_REALM`); `--dry-run` zeigt Organisationen, Anbieter, Anzahl Personen und Zeilen je Tabelle; ohne `--keycloak`/`--database` Fehler. Reihenfolge: erst Datenbank, dann Keycloak |

`platform.reset`: Das Audit-Protokoll (`audit_log`) gehört je Mandant (`tenant_id NOT NULL`, Hash-Kette je Mandant)
und ist nach dem Zurücksetzen leer; einen Eintrag ohne Mandanten gibt es nicht. `iam-reset` schreibt deshalb nach dem
Leeren der Datenbank eine Zeile `audit {"action":"platform.reset", …}` (Zeitpunkt, Realm, Schema, Anzahl Tabellen und
Zeilen, ausgenommene Tabellen, `GITHUB_ACTOR`) auf stdout; im Workflow der App bleibt sie im Protokoll des Laufs.

## 3. Realm des Produkts

Umsetzung: Modul `modules/product-realm` (`*.tf`). Alle Werte gelten als Soll; Abweichungen nur mit Begründung in der Doku des
Produkts.

### 3.1 Realm-Einstellungen

| Bereich | Soll |
|---|---|
| Allgemein | `organizations_enabled = true`, `registration_allowed = false`, `login_with_email_allowed = true`, `duplicate_emails_allowed = false`, `reset_password_allowed = true`, `ssl_required = "external"`, `display_name = "<Produkt>"` |
| Passwort | `length(12) and notUsername and notEmail` |
| Tokens und Sitzungen | Access Token 5 min; SSO 1 h inaktiv / 10 h max.; «Angemeldet bleiben» an (14 Tage inaktiv / 30 Tage max.); `revoke_refresh_token = true`, `refresh_token_max_reuse = 0` |
| Offline-Tokens | nur wenn ein öffentlicher MCP-Client es verlangt ([Kapitel 12](#12-maschinen-clients-und-mcp)): 30 Tage inaktiv, 90 Tage max. |
| Admin-Rechte | `admin_permissions_enabled = true` (FGAP v2; schon im Bootstrap, damit `admin-permissions` besteht) |
| Brute-Force | 10 Fehlversuche, Wartezeit wachsend ab 60 s bis 15 min, Rücksetzen nach 12 h, keine dauerhafte Sperre |
| Ereignisse | Admin-Ereignisse (ohne Details) und Anmeldeereignisse, 30 Tage, Listener `jboss-logging` |
| Sprachen | `de` (Standard), `en` |
| SMTP | eigenes Konto des Produkts (assets: Infomaniak, `mail.infomaniak.com:587`, STARTTLS, Absender `noreply@project-suite.ch` mit Anzeigename `<Produkt>`); Passwort nur aus der Umgebung (`TF_VAR_smtp_password`), Precondition: ist SMTP gesetzt und fehlt das Passwort, bricht der Plan ab. `kc.sh smtp-test <empfänger>` |

### 3.2 Theme und Texte

- `login_theme`, `account_theme`, `email_theme` = `identity`. Fehlt das Theme, nimmt Keycloak das Standard-Theme.
- Realm-Lokalisierung je Sprache mit den Theme-Schlüsseln aus identity `docs/betrieb.md` › Anmeldeseiten:
  `themeAccent`, `themeAccentDark`, `themeAccentText`, `themeAccentTextDark` (nur `#RRGGBB`), `themeClaim`,
  `themeClaimSub`, `themeChips`, `themeSub.<Seite>`, `themeMailFooter`. Referenz: assets
  `infra/keycloak/localization-theme.json`; Modul `product-realm`, `localization.tf`.
- SOLL: Texte in Du-Form und Schweizer Rechtschreibung. Umsetzung im Modul `product-realm`: `texts/localization-de.json`
  (nur Schlüssel des Standards mit Sie-Form oder ß) mit `texts/localization-de.source.json` (Originaltexte der
  Keycloak-Version) und Test `test/texts.test.ts` (gleiche Schlüssel, Platzhalter und HTML-Tags, keine Sie-Form);
  ebenso für die Kontoverwaltung (`texts/localization-account-de*.json`). Bei jedem Keycloak-Update die Quelldateien vergleichen.

### 3.3 Client-Richtlinien

Realmweit, gelten auch für Clients, die später jemand in der Konsole anlegt. Umsetzung: Modul `product-realm`, `policies.tf`.

| Richtlinie | Bedingung | Executors |
|---|---|---|
| `<produkt>-code-flow` | `any-client` | `pkce-enforcer`, `reject-implicit-grant`, `reject-ropc-grant` (je `auto-configure`) |
| `<produkt>-confidential` | `client-access-type = confidential` | `secure-client-authenticator`: erlaubt `client-jwt`, `client-x509`, `client-secret`; Standard `client-jwt` |
| `<produkt>-m2m-dpop` | Client-Attribut `<produkt>.m2m = true` | `dpop-bind-enforcer` (ohne Auto-Konfiguration) |

- Die Clients des Produkts setzen die erzwungenen Werte selbst (PKCE S256, kein Implicit, kein Passwort-Grant), damit
  die Auto-Konfiguration keine Abweichung zum OpenTofu-Stand erzeugt; jede Client-Ressource `depends_on` die
  Richtlinien (Keycloak wendet sie schon beim Ändern an).
- DPoP-Pflicht nur über die **positive** Markierung `<produkt>.m2m` (eine Bedingung «alle ausser …» sperrte in Assets
  das Ändern des BFF-Clients).
- `secure-redirect-uris-enforcer` bleibt aus, solange ein öffentlicher MCP-Client Loopback-Platzhalter braucht.

### 3.4 Clients

Alle vertraulichen Clients: `client_authenticator_type = "client-jwt"`, öffentlicher Schlüssel als JWKS in
`infra/keycloak/keys/<client>.json` (`use.jwks.string`, `token.endpoint.auth.signing.alg = ES256`), privater nur
verschlüsselt (sops) beim Dienst, der ihn braucht. Kein Client-Geheimnis im State. Alle Clients des Produkts tragen das
Attribut `<produkt>.platform = true` (Erkennung fremder Clients, [3.8](#38-fremde-clients)). Umsetzung: Modul
`product-realm`, `clients.tf`, `admin.tf`.

| Client | Art | Wofür | Wichtigste Einstellungen |
|---|---|---|---|
| `<produkt>-api` | vertraulich, ohne Flows | Zielgruppe der REST-API, stellt keine Tokens aus | keine Flows, kein Service Account |
| `<produkt>-platform` | vertraulich | BFF der Oberfläche | Code-Flow mit PKCE S256; Redirect `<url>/auth/callback`; Web-Origin `<url>`; Post-Logout `<url>/abgemeldet`, `<url>/`; kein Front-Channel-Logout; Backchannel-Logout `<url>/auth/backchannel-logout` mit Sitzung; Refresh-Tokens an |
| `<produkt>-admin` | Service Account | Verwaltung über die Admin-API (nur API-Prozess) | nur Client Credentials, Token 120 s, keine Refresh-Tokens; Rechte [3.7](#37-rechte-der-service-accounts) |
| `<produkt>-sync` | Service Account | Abgleich der Mitglieder (nur Worker) | wie `-admin`, eigene Schlüssel, weniger Rechte |
| `<produkt>-iac` | Service Account | OpenTofu des Realms | im Bootstrap angelegt, `realm-management/realm-admin` |
| `<produkt>-mcp`, `<produkt>-mcp-cli` | KANN | MCP-Dienst | [Kapitel 12](#12-maschinen-clients-und-mcp) |

Mapper:

| Mapper | An | Konfiguration |
|---|---|---|
| Audience `aud-api` | `-platform` (und `-mcp`) | `included_client_audience = <produkt>-api`, Access Token und Introspektion, nicht ID-Token |
| Gruppen `groups` | `-platform` (und MCP-Clients) | Benutzerattribut `entra_groups` (mehrwertig) → Claim `groups` (Objekt-IDs der Entra-Gruppen, Subjekt `group:<entra-object-id>`, [7.4](#74-tupel)), Access Token, Userinfo, Introspektion; keine Rollen, keine Keycloak-Gruppen |
| Organisation | eingebauter Scope `organization` | `oidc-organization-membership-mapper` mit `addOrganizationId = true`, `multivalued = true`, `jsonType.label = JSON`, Access/ID/Userinfo/Introspektion: Claim `{"<alias>": {"id": "<kc-org-id>"}}` |

Den Organisations-Mapper legt Keycloak beim Anlegen des Realms selbst an; der Provider kann ihn nicht übernehmen.
Referenz: `org-mapper.ts` (Admin-API, idempotent) über `terraform_data` mit der Soll-Konfiguration als Auslöser.

Scopes der Clients als vollständige Listen (was fehlt, entfernt OpenTofu): Standard-Scopes `profile`, `email`, `roles`,
`web-origins`, `acr`, `basic`; `organization` als optionaler Scope. Keycloak 26.8 hängt neuen Clients `organization`
als optionalen Scope an: erst die optionalen, dann die Standard-Scopes setzen (`depends_on`).

IDs eingebauter Clients (`realm-management`, `admin-permissions`) über die Admin-API nachschlagen (Referenz
`lookup.ts`), nicht mit `data "keycloak_openid_client"` (liest das Client-Secret, ab 26.8 403) und ohne `depends_on` auf
den Realm.

### 3.5 Rollen und Gruppen

| Was | Soll |
|---|---|
| Realm-Rolle `platform-admin` | Plattform-Administration über alle Mandanten; vergibt nur eine Keycloak-Administration bzw. `iam-org-bootstrap` |
| Rollen des Modells | **nicht in Keycloak** (D6): keine Client-Rollen an `<produkt>-platform`, keine Gruppe `/orgs`, keine Rollengruppen, kein Mapper für Rollen. Rollen sind Tupel in der Datenbank der App ([7.4](#74-tupel)) |
| Gruppen | nur aus Entra ID der Organisation: je Entra-Anbieter ein IdP-Mapper `entra-groups` (`oidc-user-attribute-idp-mapper`, Claim `groups` → Attribut `entra_groups`, Sync-Modus `FORCE`), angelegt von der App mit dem Anbieter ([9.4](#94-anmeldung-über-den-idp-der-organisation-kann)); Attribut `entra_groups` im User-Profile des Realms (nur Admin, mehrwertig). Die App legt keine Keycloak-Gruppen an. Ohne Entra gibt es keine Gruppen |

### 3.6 Rechte-Scopes

Je Scope des Modells ein Client-Scope (`include_in_token_scope = true`, Text «<Produkt>: <scope>»), optional für MCP-
und Maschinen-Clients. Quelle ist `infra/keycloak/platform.json` (nur `scopes`), erzeugt mit `model.platformJson()`; ein
Test prüft, dass die Datei aktuell ist. Die Modul-Variable `catalog.roles` entfällt, `catalog.scopes` bleibt.

### 3.7 Rechte der Service Accounts

Keycloak 26 kennt in FGAP v2 die Typen *Users*, *Groups*, *Clients*, *Roles*, aber **keine Organisationen**. Alle
Endpunkte unter `/organizations` (auch lesen) verlangen `realm-management/manage-realm`. Daraus (live geprüft mit 26.6):

| Client | Rechte | Bewusst nicht |
|---|---|---|
| `<produkt>-admin` | `realm-management/manage-realm`; FGAP v2 *Users* (alle): `view`, `manage`; Richtlinie «nur dieser Client», Strategie `UNANIMOUS` | FGAP v2 *Groups* und `manage-group-membership` (keine Rollengruppen mehr, A21); `realm-admin`, `manage-users`, `manage-clients`, `create-client`, `impersonation`, `map-roles`, `reset-password`; `manage-identity-providers` nur mit Anmeldung über Entra ID ([9.4](#94-anmeldung-über-den-idp-der-organisation-kann)) |
| `<produkt>-sync` | nur `manage-realm` | Benutzer, Gruppen, Clients (403 geprüft) |

Legt jemand weitere v2-Berechtigungen für *alle Benutzer* an, müssen deren Richtlinien `<produkt>-admin` einschliessen
(`UNANIMOUS`).

### 3.8 Fremde Clients

SOLL: Das Einrichtungsskript für Entwicklung und Test (Referenz `scripts/keycloak-setup.ts`) richtet dasselbe Modell
ein wie OpenTofu und bricht in Produktion ab, wenn der Realm Clients anderer Anwendungen enthält (Liste der
Systemclients + `KEYCLOAK_SYSTEM_CLIENTS` + Heuristik, Referenz `scripts/lib/system-clients.ts`). Clients ohne
`<produkt>.platform` und ohne `<produkt>.m2m` sind verdächtig.

## 4. Mandanten

- Mandant = Keycloak-Organisation. Tabelle `tenant` mit `id` (UUID), `kc_org_id` (eindeutig), `alias`, `name`,
  `status` (`active` | `suspended`), `settings`, `acl_version`, `created_at`.
- **Alias**: `^[a-z0-9][a-z0-9_-]{0,62}$`, nicht änderbar. Vergleich nur nach **ASCII**-Kleinschreibung (A–Z → a–z);
  `toLowerCase()` ist verboten (Kelvin-Zeichen U+212A wird sonst zu «k»). Ungültiger Alias im Claim oder in der Wahl →
  403.
- **Bindung an die Keycloak-ID**: `app.resolve_tenant(alias, kc_org_id, name, create)` (SECURITY DEFINER) liefert den
  Mandanten nur, wenn die ID passt; eine leere `kc_org_id` wird beim ersten Kontakt gebunden. Eine neue Organisation
  mit dem Alias einer gelöschten erhält so nie deren Daten. Organisationen werden **gesperrt statt gelöscht**.
- **Anlage just in time** (`TENANT_AUTO_PROVISION=true`): beim ersten Zugriff einer **Person**. Maschinen-Clients
  legen nie einen Mandanten an.
- **Gesperrt** (`suspended`): keine Anmeldung, keine API-Zugriffe (403 «Organisation nicht verfügbar»), der Worker
  ruht. Sperren wirkt in Keycloak (Organisation deaktiviert) und in der App zugleich; scheitert ein Schritt, wird der
  andere zurückgenommen. Die eigene Organisation lässt sich nicht sperren.
- **Personen in mehreren Organisationen**: Die Anmeldung fordert `organization:*` an, das Token trägt alle
  Organisationen der Person. Je Anfrage gilt **genau eine**: Header `X-Tenant` (muss im Token stehen, sonst 403), sonst
  die Vorgabe der Sitzung, sonst bei nur einer diese; bei mehreren ohne Wahl 400 mit der Liste der **eigenen**
  Organisationen.
- Plattform-Administration: Realm-Rolle `platform-admin`, nur Personen, eigene Endpunkte `/v1/platform/…`, umgeht RLS
  nie stillschweigend (arbeitet im Kontext des Zielmandanten), jede Aktion im Audit des Zielmandanten mit
  `platformAdmin` und `actorTenant`. Auch die Plattform-Administration braucht eine eigene Organisation zum Anmelden.

## 5. Anmeldung der Oberfläche (BFF)

Referenz: assets `src/platform/modules/auth/bff.ts`, `index.ts`, `sealer.ts`; Migrationen `001_core.sql`,
`006_session_bff.sql`.

### 5.1 Endpunkte

| Endpunkt | Verhalten |
|---|---|
| `GET /auth/login?returnTo=&org=&idp=` | Startet den Code-Flow (PKCE S256, `state`, `nonce`), Scopes aus `OIDC_SCOPES` mit `organization` → `organization:*`. Anmeldezustand verschlüsselt im kurzlebigen Cookie (10 min). `org` wählt nur vor. `idp` (nur `^entra-(\d{3}|app-<alias>)$`, sonst ignoriert) wird zu `kc_idp_hint` mit `prompt=login`, damit eine bestehende Keycloak-Sitzung nicht weiter gilt (Testanmeldung, [9.4](#94-anmeldung-über-den-idp-der-organisation-kann)). |
| `GET /auth/entra/{idp}?org=` | Anmeldung über den Entra-Anbieter `idp` (`^entra-(\d{3}|app-<alias>)$`) der Organisation `org`: Ziel des Links in der Einladung aus Entra ID (Redirect-URI `…/auth/entra/*` des Clients) und Link zum Weitergeben (`Mitglied.loginPath`). Rücksprung immer nach `/`; Parameter der Weiterleitung werden nicht weitergegeben. |
| `GET /auth/callback` | Code tauschen, ID-Token prüfen (Signatur, `iss`, `aud`, `nonce`), bestehende Sitzung **beenden und ersetzen** (Session-Fixation), neue Sitzung anlegen, Rücksprung nach `returnTo`. Anmeldezustand unbekannt oder abgelaufen (z. B. «Passwort vergessen» in einem anderen Tab): mit gültiger Sitzung Rücksprung nach `/`, sonst einmal automatisch neue Anmeldung (Cookie `<produkt>_login_retry`, 10 min, Schutz gegen Schleifen; nicht bei `error=` von Keycloak), danach die Fehlerseite (ab 1.5) |
| `GET /auth/me` | Person, Mandant (`id`, `alias`, `name`), `organizations`, `organizationNames`, `selectedOrganization`, `tenantError`, `roles` (an `org`), `permissions` (an `org`), `somewhere`, `clearance`, `breakGlassUntil`, `csrfToken`, `session.expiresAt`, `session.idleTimeoutSeconds` (Typ `Me`, [9.5](#95-zugriff-v1access)). Mandant aus `X-Tenant`, sonst Vorgabe der Sitzung; die Prüfung macht allein der Resolver ([6.2](#62-principal)). 401 ohne Sitzung. |
| `POST /auth/switch` | CSRF; setzt die Vorgabe der Sitzung, wenn das Token die Organisation enthält, sonst neue Anmeldung als Rückfall |
| `POST /auth/logout` | CSRF; Sitzung löschen, RP-initiated Logout mit `id_token_hint` und `post_logout_redirect_uri = <url>/abgemeldet` |
| `POST /auth/backchannel-logout` | OIDC Back-Channel Logout 1.0: Logout-Token prüfen (`iss`, `aud` = BFF-Client, `iat`, `jti`, höchstens 10 min alt, Ereignis `backchannel-logout`, kein `nonce`, `sid` oder `sub`), `jti` gegen Wiederholung, betroffene Sitzungen löschen |
| `/abgemeldet` | öffentliche Seite «Du bist abgemeldet», fragt `/auth/me` nicht ab, meldet nicht automatisch an |

Fehler der Browser-Routen (`GET /auth/login`, `/auth/entra/{idp}`, `/auth/callback`, `/auth/switch`, `POST
/auth/switch`, `/auth/logout`; jeweils ohne `Accept: application/json`) zeigen nie Problem-JSON, sondern eine schlichte
HTML-Seite in Du-Form mit Knopf «Erneut anmelden» (`/auth/login`), Status wie der Fehler, eigene CSP, ohne technische
Details (die stehen im Log). `/auth/me`, Aufrufe mit `Accept: application/json` und die API (`/v1/…`) bleiben bei
Problem-JSON.

### 5.2 Sitzung

- Cookie: zufällige ID (256 Bit), signiert (`SESSION_SECRET`, mehrere für Rotation), `HttpOnly`, `SameSite=Lax`, in
  Produktion `Secure` mit Präfix `__Host-` (`__Host-<produkt>_sid`, `__Host-<produkt>_login`).
- Tabelle `session`: `id` = SHA-256 der Sitzungs-ID, `data` = AES-256-GCM mit AAD = Sitzungs-ID (Schlüssel aus
  `ENCRYPTION_KEYS`, erster verschlüsselt, alle entschlüsseln), `csrf`, `subject`, `idp_sid`, `created_at`,
  `last_seen_at`, `expires_at`. Inhalt: `sub`, `idpSid`, Name, E-Mail, ID-/Access-/Refresh-Token, Ablauf, `org`,
  `orgs`. Ohne `ENCRYPTION_KEYS` startet die API in Produktion nicht.
- `SESSION_TTL` 8 h, `SESSION_IDLE_TIMEOUT` 60 min; `last_seen_at` höchstens einmal je Minute schreiben; abgelaufene
  Sitzungen regelmässig löschen.
- **Erneuerung** 30 s vor Ablauf des Access Tokens, mit Refresh-Token-Rotation; parallele Anfragen teilen sich eine
  Erneuerung (im Prozess per Promise, über Prozesse per `SELECT … FOR UPDATE`). `invalid_grant` oder anderes `sub` →
  Sitzung löschen. Die Liste `orgs` folgt jedem neuen Token; die Vorgabe `org` bleibt nur, solange sie darin steht
  (Austritt).
- **CSRF**: Jeder schreibende Aufruf mit Cookie trägt `X-CSRF-Token` (zeitkonstanter Vergleich).
- `returnTo` nur relative Pfade innerhalb der App, auch nach Normalisierung (kein `//`, keine Steuerzeichen,
  `/.//x` → `/`).
- Tokens verlassen den Server nie. Als `SessionBridge` liefert das BFF der API je Anfrage ein gültiges Access Token;
  Links ohne eigene Header (Downloads) dürfen die Organisation als `?x-tenant=` nennen (nur GET/HEAD, wird vor der
  Schemaprüfung entfernt).

## 6. Token-Prüfung und Principal

Referenz: assets `src/platform/auth/tokens.ts`, `principal.ts`.

### 6.1 Token-Prüfung

- OIDC-Discovery mit Zwischenspeicher (1 h), Issuer muss exakt `OIDC_ISSUER_URL` sein, JWKS mit Rotation.
- Signatur (RS/PS/ES 256–512, EdDSA), `iss`, `aud` (`<produkt>-api` bzw. `<produkt>-mcp`), `exp`, `iat`, `sub` Pflicht,
  Toleranz `OIDC_CLOCK_TOLERANCE`.
- Nur **Access Tokens**: `typ` muss `Bearer` oder `DPoP` sein, falls vorhanden (ID-, Refresh-, Logout-Tokens nie).
- Sendergebunden: `cnf.jkt` → DPoP-Proof Pflicht (RFC 9449: `typ dpop+jwt`, kein privater Schlüssel im `jwk`, `htm`,
  `htu` normalisiert, `iat` höchstens `DPOP_MAX_AGE`, `jti` einmalig über alle Instanzen, `ath`, Thumbprint = `jkt`);
  `cnf.x5t#S256` → Client-Zertifikat aus `MTLS_HEADER` (PEM, URL-kodiert, oder DER base64) muss passen; unbekannte
  Bindung → 401.
- `DPOP_MODE=required-for-clients` (Standard): Maschinen-Clients müssen sendergebundene Tokens verwenden.

### 6.2 Principal

Aus dem geprüften Token entsteht der Principal: `tenantId`, `tenantAlias`, `principalId`, `kind` (`user` | `client`),
`subject`, `name`, `email`, `clientId`, `groups`, `scopes`, `platformAdmin`, `binding`, `scopeBound`, `subjects`
(Subjekte nach [7.5](#75-entscheidung)), `clearance` (wirksam). Rollen stehen nicht im Principal und nie im Token; sie
kommen aus Tupeln.

| Regel | Soll |
|---|---|
| Organisation | aus dem Claim `TENANT_CLAIM` (Liste von Aliassen, Objekt `{alias: {id}}` oder Zeichenkette); Wahl nach [Kapitel 4](#4-mandanten). Fehler: keine Organisation → 403 (mit Hinweis auf den Scope), nicht im Token → 403, mehrere ohne Wahl → 400 mit eigener Liste |
| Person oder Maschine | Person nur, wenn `azp` in `OIDC_PERSON_CLIENT_IDS` (Standard: BFF- und MCP-Client) und kein Service Account (`service-account-…` bzw. `client_id` ohne Personenmerkmale). Alles andere ist Maschinen-Client |
| Rollen | aus Tupeln des gewählten Mandanten ([7.4](#74-tupel)); Client-Rollen (`resource_access`) und Rollengruppen werden nicht gelesen |
| Gruppen | Claim `GROUPS_CLAIM` (Objekt-IDs aus Entra), nur als Subjekte `group:<entra-object-id>` |
| Freigabe | Maschinen-Clients nur mit mindestens einem nicht abgelaufenen Tupel `client:<principal-id> <rolle> org` im Mandanten, sonst 403 «Client nicht freigegeben» mit Hinweis auf die Freigabe. Über Token Exchange zählt der ursprüngliche Client, nicht `azp` |
| Plattform | `platformAdmin` = Realm-Rolle `PLATFORM_ADMIN_ROLE` |
| Scope-Grenze | `scopeBound` für Maschinen-Clients und Zugriffe über den MCP-Dienst |
| Spiegel | `principal` je Mandant (eigene ID je Mandant, `UNIQUE (tenant_id, kind, subject)`), Name/E-Mail/`last_seen_at` aktualisieren; bei Maschinen-Clients zusätzlich `last_scopes`; Principal eines Clients entsteht spätestens mit der Freigabe (A18) |
| Austritt | `removed_at` gesetzt: Token gilt nur, wenn **nach** `removed_at` ausgestellt (`iat`), sonst 403 «Kein Mitglied mehr» |
| Zwischenspeicher | Mandant (Alias + Keycloak-ID) 60 s, Principal 5 min, Tupel bis zur nächsten `acl_version`; alle Schlüssel enthalten den Mandanten; `forget…` nach Sperren, Entzug, Entfernen |

## 7. Rechtemodell

Grundlage: [authz-konzept.md](authz-konzept.md) Abschnitte 3 und 4, Entscheide D1–D7 in
[authz-offene-punkte.md](authz-offene-punkte.md). Dieses Kapitel ist zusammen mit [Kapitel 9](#9-verwaltung-in-der-app),
[10](#10-datenbank) und [11](#11-oberfläche) der **Vertrag** zwischen Backend (`packages/iam`), Oberfläche
(`packages/iam-web`), Realm-Modul und App. Stellen mit **(A*n*)** beruhen auf den Entscheiden vom 2026-10-23 zu Punkten, die
das Konzept offen liess ([Offene Entscheide](#offene-entscheide-zum-baukasten)).

### 7.1 Grundsatz

Keycloak sagt, wer jemand ist; die Datenbank der App sagt mit Tupeln (`authz_tuple`) und dem Modell der App
(`defineModel`), was jemand darf. Kein externer Dienst (D1).

```
erlaubt = Beziehung ergibt Recht  ∧  Klassifizierung ≤ Freigabestufe  ∧  Scope deckt das Recht (nur scopeBound)
```

- Keine Verbote, keine Beschränkungen, kein `blocked`, keine Ausnahme für `org-admin` (D2). `org-admin` hat alle Rechte,
  weil die Rolle alle Rechte enthält; an der Klassifizierung scheitert auch diese Rolle (Break-Glass, [7.8](#78-klassifizierung-freigabestufe-und-break-glass)).
- Keine eigenen Rollen der Organisation (D3); Rollen kommen nur aus dem Modell, Zuweisungen nur aus Tupeln (D6).

| Frage | Backend | Endpunkt |
|---|---|---|
| Darf X das Recht Y auf Z? | `req.need`, `req.can`, `req.needSomewhere`, `req.capabilities(refs?)`, `iam.access.can` (Signaturen unverändert; `refs` optional: Klassifizierung und Zuständigkeit der Ressourcen einer Liste auf einmal laden) | – |
| Was darf X lesen? | Lesesicht je Anfrage ([7.6](#76-lesesicht-je-anfrage)), RLS der App | – |
| Wer hat Zugriff, warum? | `iam.access.whoHasAccess`, `iam.access.explain` | `GET /v1/access`, `GET /v1/access/explain` ([9.5](#95-zugriff-v1access)) |

### 7.2 Begriffe (sichtbar in der Oberfläche, verbindlich)

| Begriff | Bedeutung | Beispiel |
|---|---|---|
| **Rolle** | Name einer Beziehung, die Rechte ergibt | Bearbeiter:in, Leser:in, Schema-Admin |
| **Ort** | Ressource, an der eine Rolle hängt | Organisation, Schema «IT», Objekt «n42» |
| **Freigabe** | Ein Eintrag «Wer – Rolle – Ort», optional mit Ablaufdatum (ein Tupel) | «Anna ist Bearbeiterin am Schema IT bis 31.12.» |
| **Zuständigkeit** | Rechte, die aus Fachdaten folgen: Ressource gehört zu einer Einheit, Person ist Mitglied der Einheit; oder die Person steht selbst in den Fachdaten der Ressource (ab 1.1) | «Mitglieder der Abteilung X lesen alles, was der Abteilung gehört»; «Verantwortliche bearbeiten ihre Objekte» |
| **Vertraulichkeit** | Stufe an der Ressource (`0` intern, `1` vertraulich, `2` streng vertraulich); **Freigabestufe** je Person und Client | «Streng vertraulich sehen nur Personen mit Freigabestufe 2» |
| **Scope** | Obergrenze im Token für Programme, MCP, Assistent («Freigabe im Token») | `assets:read` |
| **Recht** | Was eine Aktion verlangt, Schlüssel `<bereich>:<verb>` | `object:write` |
| **Organisation** | Mandant (nie «Mandant» in der Oberfläche) | – |

Entfallen: «Zugriffsregel», «Verbieten», «Beschränken auf», «eigene Rolle», «Principal», «ACL», «Gruppe» als
Verwaltungsbegriff (Gruppen aus Entra erscheinen nur als Wer einer Freigabe).

### 7.3 Modell der App (`defineModel`)

Das Modell steht an **einer** Stelle im Code der App (`src/authz/model.ts`) und ersetzt `defineCatalog`,
`CatalogInput`, `PERMISSIONS`, `ROLES` usw. Daraus entstehen `GET /v1/authz/catalog`, `infra/keycloak/platform.json`
(nur Scopes), die CHECKs von `authz_tuple` (`syncModelChecks`) und die Typen der Pakete.

```ts
export function defineModel<const P extends string, const R extends string, const T extends string>(
  input: ModelInput<P, R, T>,
): Model<P | ReservedPermission, R | 'org-admin', T | 'org'>;

interface ModelInput<P extends string, R extends string, T extends string> {
  /** Technischer Name des Produkts (Lese-Scope `<product>:read`). */
  product: string;
  /** Reservierte Rechte nur ohne label/group (Beschreibung, resources, Reihenfolge), 8.1. */
  permissions: Record<P, {
    label: string; group: string; description: string;
    /** Typen, an denen das Recht geprüft wird (immer mit `org`); Standard `['org']`. Bestimmt die Rechte von `owner`. */
    resources?: readonly (T | 'org')[];
    /** `false`: nur Personen, in keinem Scope. `members:admin` und `access:admin` immer. */
    scope?: false;
  }>;
  /** Rechtegruppen in Anzeigereihenfolge; reservierte ergänzt der Baukasten. */
  groups: readonly { key: string; label: string; match?: string | RegExp | readonly string[] }[];
  /** Rollen = Beziehungsnamen. `'*'` nur bei `org-admin` (darf fehlen, wird ergänzt). */
  roles: Record<R, { label: string; description: string; permissions: readonly P[] | '*' }>;
  scopes?: Record<string, { text: string; permissions: readonly P[] }>;
  /** Orte. `org` darf fehlen (wird mit `roles: '*'` ergänzt) oder mit `roles` als Liste die Rollen an der Organisation begrenzen (Kit 1.3). Ohne `types` gibt es nur Rollen an `org` (Stufe «einfach»). */
  types?: Record<T, TypeDef<P, R, T>>;
  /** Labels der Stufen 0, 1, 2; Standard «intern», «vertraulich», «streng vertraulich». */
  classifications?: readonly [string, string, string];
  /** Fähigkeit → Recht je Typ (Felder `can` der Antworten). */
  capabilities?: Partial<Record<T | 'org', Record<string, P>>>;
  mcpTools?: Record<string, { title: string; permission: P; readOnly: boolean }>;
  features?: { members?: boolean; tenantSettings?: boolean; audit?: boolean };
}

interface TypeDef<P extends string, R extends string, T extends string> {
  label: string;
  /** Typ darüber in der Kette; Pflicht ausser bei `org`. */
  parent?: T | 'org';
  /** Eigener Schlüssel: Vorfahren desselben Typs zählen zur Kette (Assets: `object_type.parent_id`). */
  self?: T;
  /** Rollen, die hier hängen dürfen; `'*'` nur bei `org` (dort Standard; eine Liste begrenzt die Rollen an der Organisation, `org-admin` wird ergänzt, M5). */
  roles: readonly R[] | '*';
  /** Beziehungen ohne Rechte, die hier hängen dürfen (Assets: `['member']` an Objekten = Einheiten). */
  relations?: readonly 'member'[];
  /** Blatt: kein Typ hat es als `parent`; Lesesicht über `app.read_types()` ([7.6](#76-lesesicht-je-anfrage)). */
  leaf?: true;
  /** Ressource trägt eine Vertraulichkeit (0..2); Regel 3 in 7.5. */
  classified?: true;
  /** Ressource hat Besitzer:in (Relation `owner`); Regel 4 in 7.5. */
  owner?: true;
  /** Rolle des Schalters «Für alle Mitglieder» (`org:members`, 11, A7; Entscheid D10). Nur mit `owner`; Standard `viewer`,
   *  falls am Typ zulässig, sonst kein Schalter (M13). */
  membersRole?: R;
  /** Zuständigkeit über Fachbeziehungen (`ResourceModel.edges`, 7.7); `relation` benennt sie in «Warum?». */
  scope?: { via: 'reference'; relation: string };
  /** Lese- und Schreibrecht des Typs für Lesesicht, Zuständigkeit, «Wer hat Zugriff?» und «Warum?» (A1, A13).
   *  `read` Pflicht bei jedem Typ ausser `org` (dort `tenant:read`); `write` Pflicht bei `leaf` und `scope`. */
  read?: P;
  write?: P;
}
```

Beispiel (Stufe «mittel», [neue-app.md](neue-app.md#4-modell-und-ressourcen)) und Assets: Konzept 3.3 und 5.1.

`defineModel` prüft beim Start und im Test (`checkModel` des Test-Kits) und bricht mit allen Befunden ab
(`ModelError`, Feld `errors: string[]`):

| # | Regel |
|---|---|
| M1 | Schlüssel nach [8.2](#82-regeln-für-das-modell); reservierte Namen nach [8.1](#81-reservierte-namen) mit festem Label und fester Gruppe |
| M2 | Jedes Recht: Label, Beschreibung, Gruppe aus `groups`; `resources` enthält `org` und nur Typen des Modells |
| M3 | Jede Rolle: Label, Beschreibung, mindestens ein Recht, nur Rechte des Modells; Beschreibung nennt jede Rechtegruppe der Rolle (`match`); `'*'` nur bei `org-admin`; `org-admin` steht zuerst |
| M4 | Jeder Typ ausser `org` hat `parent` aus dem Modell; die Kette ist kreisfrei und endet bei `org`; `self` nur gleich dem eigenen Schlüssel |
| M5 | `roles` eines Typs nur Rollen des Modells; `'*'` nur bei `org`; `org-admin` nur an `org`; `org.roles` ist `'*'` (Standard) oder eine Liste ohne Doppelte (`org-admin` wird ergänzt). Rollen, die nicht an `org` hängen dürfen, lehnen `POST /v1/access`, Mitglieder › Rollen, Einladungen und Clients mit 422 ab; `GET /v1/admin/status` und der Katalog (`types[org].roles`) nennen nur die zulässigen. Tupel mit einer am Typ nicht zulässigen Rolle zählen nicht (Entscheidung, Lesesicht, Auskunft); `syncModelChecks` ergänzt den CHECK `authz_tuple_type_relation_check` (`NOT VALID`: bestehende Tupel bleiben, neue werden abgelehnt) |
| M6 | `leaf`: kein Typ hat ihn als `parent`; höchstens **ein** Blatt-Typ je Modell (A2) |
| M7 | Jeder Typ ausser `org` hat `read`; `leaf` und `scope` zusätzlich `write`; `read` und `write` stehen in `resources` ihrer Rechte für diesen Typ |
| M8 | `relations` (Beziehungen ohne Rechte) sind keine Rollenschlüssel; zulässig sind nur reservierte (`member`); der Typ `edges.unit` hat `member` in `relations` |
| M9 | `owner` nicht an `org`; `classified` nicht an `org` |
| M10 | `members:admin` und `access:admin` in keinem Scope; Rechte mit `scope: false` in keinem Scope; jeder Scope hat Text und Rechte |
| M11 | `capabilities` nur für Typen des Modells und Rechte des Modells; `mcpTools` nur Rechte des Modells, mit Titel |
| M12 | `classifications`: drei nicht leere Labels |
| M13 | `membersRole` nur bei Typen mit `owner`; die Rolle ist am Typ zulässig (`roles`) und enthält keine Rechte, die nur `org-admin` hat (`adminOnly`) |

Ergebnis `Model` (Nachfolger von `Catalog`, gleiche Hilfen): `product`, `permissions`, `info`, `groups`, `roles`,
`scopes`, `types` (Kette, Rollen je Ort, Schalter), `classifications`, `capabilities`, `mcpTools`, `adminOnly`,
`warnings`, `isPermission`, `permissionsForRoles(roles)`, `permissionsForScopes(scopes)`, `scopeForPermission`,
`permissionText`, `relationsAt(type)` (Rollen, `relations` und `owner`, wo zulässig), `rolesWith(permission)`, `toJSON()`
(= `GET /v1/authz/catalog`, [9.5](#95-zugriff-v1access)), `platformJson()` (nur `{ "scopes": [...] }`). Typregistrierung:
`declare module '@vollholz/iam' { interface Register { model: typeof model } }`.

### 7.4 Tupel

Ein Tupel ist eine Freigabe: «Subjekt hat Relation an Ort». Tabelle [10.2](#102-tabellen-des-iam).

| Subjekt | Bedeutung | Gesetzt über |
|---|---|---|
| `user:<principal-id>` | Person (`principal.id` in diesem Mandanten) | Mitglieder (Rollen an `org`), `POST /v1/access` |
| `client:<principal-id>` | Maschinen-Client; **nur an `org`** (A3) | `PUT /v1/admin/clients/{clientId}` |
| `group:<entra-object-id>` | Gruppe aus Entra ID (Objekt-ID im Claim `GROUPS_CLAIM`); Anzeigename über die Graph-Anbindung der Entra-Verbindung | `POST /v1/access` |
| `org:members` | alle **Personen** der Organisation («Alle Mitglieder»), nicht Clients (A5) | `POST /v1/access` |

| Relation | Wo | Rechte |
|---|---|---|
| Rolle des Modells | Typen, deren `roles` sie nennt | Rechte der Rolle |
| `member` («Mitglied», reserviert) | Typen mit `member` in `relations` (Einheit, `ResourceModel.edges.unit`) | keine, auch nicht an der Einheit selbst; macht zuständig (Regel 2) |
| `owner` («Besitzer:in», reserviert) | Typen mit `owner`; setzt die App beim Anlegen (`iam.tuples.grant`), nie über `/v1/access` (422), kein Übertragen (O6) | alle Rechte, deren `resources` den Typ enthalten (A7) |

- `object_id` ist leer genau bei `org`. Höchstens ein Tupel je (Subjekt, Relation, Ort); `expires_at` optional, in der
  Zukunft beim Anlegen.
- Fachliche Kanten (Ressource gehört zu Einheit, Einheit ist Teil von Einheit) sind **keine** Tupel; die App liefert sie
  über `ResourceModel.edges` ([7.7](#77-resourcemodel-der-app)).
- Abgelaufene Tupel zählen nie. Ein Job im Worker löscht sie bei jedem Lauf des Abgleichs ([9.3](#93-abgleich-ins-personenverzeichnis))
  und schreibt je Tupel `access.expired` (A8).
- Jede Änderung erhöht `tenant.acl_version` (Trigger; ebenso Freigabestufen, auch beim Anlegen eines Principals mit
  Stufe > 0 oder Break-Glass, `iam_016`); die Entscheidung speichert Tupel und Zustand der Kette je Mandant
  bis zur nächsten Änderung zwischen.

### 7.5 Entscheidung

`can(p, perm, ref)` ist wahr, wenn (1 ∨ 2 ∨ 4) ∧ 3 ∧ 5 ∧ 6 gelten (fest im Baukasten, nicht konfigurierbar):

1. **Rolle am Ort:** Es gibt ein nicht abgelaufenes Tupel mit Subjekt aus `subjects(p)` an `ref` oder an einer Ressource
   der Kette darüber (`ResourceModel.chain`: `org` → … → `ref`, mit `self`-Vorfahren), dessen Relation eine Rolle ist,
   die `perm` enthält.
2. **Zuständigkeit** (nur Typen mit `scope`): `ref` gehört über eine Kante mit `grants ≠ none` zu einer Einheit aus
   `units(p)`. `grants = read` ergibt `read` des Typs, `grants = edit` ergibt `read` und `write`. `units(p)` = Einheiten
   mit Tupel `member` eines Subjekts von `p`, dazu transitiv alle darunter (Kanten mit `inherits_scope`, Tiefe ≤ 16).
   **Über Personen** (ab 1.1, `ResourceModel.edges.persons`): `p` ist eine Person und steht in den Fachdaten von `ref`
   mit `grants ≠ none` (Assets: Attribut «Verantwortlich» der Art `user`); `read` und `edit` wirken wie oben. Es zählt
   nur `principal.id` der Person selbst, solange sie im Mandanten aktiv ist (`kind = 'user'`, nicht entfernt), nie
   Gruppen, «Alle Mitglieder» oder Clients; nur an `ref` selbst, nicht an Ressourcen darunter.
3. **Klassifizierung** (nur Typen mit `classified`): `classification(ref) ≤ clearance(p)`.
4. **Besitz** (nur Typen mit `owner`): Tupel `owner` eines Subjekts von `p` an `ref`.
5. **Scope** (nur `scopeBound`): `perm ∈ permissionsForScopes(p.scopes)`; gilt für jeden Weg 1, 2, 4.
6. **Client freigegeben** (nur `kind = client`): mindestens ein nicht abgelaufenes Tupel `client:<id> <rolle> org`; sonst
   403 «Client nicht freigegeben» schon beim Auflösen des Principals ([6.2](#62-principal)).

- `subjects(p)` = Person: `user:<id>`, `group:<entra-object-id>` je Gruppe im Token, `org:members`; Client: nur
  `client:<id>` (A5).
- `clearance(p)` = `max(principal.clearance, principal.clearance_boost)`, solange `clearance_until > now()`, sonst
  `principal.clearance`.
- **Recht irgendwo** (`canSomewhere`, `needSomewhere`): 1, 2 oder 4 ergibt `perm` an mindestens einem Ort, ∧ 5;
  Zuständigkeit über Personen nur, wenn die App `edges.personGrants` liefert. Damit
  prüfen Listen und Einstiege, die danach je Ressource prüfen oder über die Lesesicht filtern. Anlegen ohne Ressource
  prüft an `org`.
- Rechte an `org` (`permissions` in `/auth/me`) = Rechte der Rollen aus Tupeln an `org` (∧ 5).
- **Niemand gibt mehr, als er hat:** Wer eine Rolle an einem Ort vergibt oder entzieht, braucht dort `access:admin` (an
  `org` über Mitglieder: `members:admin`), und jedes Recht der Rolle muss für ihn an diesem Ort gelten (`can`). Rolle
  `org-admin` vergibt und entzieht nur `platform-admin`; für die Plattform-Administration gilt die Regel nicht (A9).
  Ablauf ändern gilt als Vergeben.
- Rechte, die bei keiner Rolle ausser `org-admin` stehen, heissen `adminOnly` (Katalog), sind aber nichts Besonderes
  mehr: ihre Rolle vergibt nur `platform-admin`.

### 7.6 Lesesicht je Anfrage

Je Anfrage setzt der Baukasten in `withTenant`/`req.tx` (dieselbe Transaktion, `set_config(…, true)`) einmal die
folgenden Einstellungen; die App liest sie in RLS-Policies nur über die Funktionen im Schema `app` (STABLE, ohne
Einstellung: leeres Array, `false` bzw. `0`). `dbContext` der App entfällt.

| Einstellung | Funktion | Typ | Inhalt |
|---|---|---|---|
| `app.subjects` | `app.subjects()` | `text[]` | `subjects(p)` |
| `app.clearance` | `app.clearance()` | `smallint` | `clearance(p)` |
| `app.read_all` | `app.read_all()` | `boolean` | `read` des Blatt-Typs gilt an `org` |
| `app.read_types` | `app.read_types()` | `uuid[]` | IDs der Ressourcen vom `parent`-Typ des Blatts (mit `self`-Nachfahren), an denen `read` des Blatts über Regel 1 gilt (Rolle an diesem Ort, einem Vorfahren oder einer Ressource der Kette darüber) |
| `app.read_units` | `app.read_units()` | `uuid[]` | `units(p)`; leer, wenn 5 `read` nicht deckt |
| `app.write_all` | `app.write_all()` | `boolean` | wie `read_all` für `write` (A10) |
| `app.write_types` | `app.write_types()` | `uuid[]` | wie `read_types` für `write` |
| `app.write_units` | `app.write_units()` | `uuid[]` | `units(p)`; leer, wenn 5 `write` nicht deckt |
| `app.read_person` | `app.read_person()` | `uuid` | `principal.id` der Person für Regel 2 über Personen (ab 1.1, `iam_016`); `NULL` bei Clients, ohne `edges.persons` oder wenn 5 `read` nicht deckt |
| `app.write_person` | `app.write_person()` | `uuid` | wie `read_person` für `write` |
| `app.person`, `app.person_permissions` | `app.person_for(permission text)` | `uuid` | wie `read_person` für ein beliebiges Recht `read` oder `write` eines Typs mit `scope` (`read_person`/`write_person` gelten für den ersten, das Blatt); `NULL`, wenn 5 das Recht nicht deckt |
| `app.org_permissions` | `app.read_all_of(permission text)` | `boolean` | Recht gilt an `org` (∩ Scope); für Typen mit Tupeln ausser dem Blatt (A10) |
| `app.read_relations`, `app.write_relations` | `app.read_relations()`, `app.write_relations()` | `text[]` | Relationen (Rollen, bei `owner`-Typen auch `owner`), die `read` bzw. `write` des Blatts enthalten, **je Anfrage** aus Modell ∩ Scope berechnet: leer, wenn 5 das Recht nicht deckt; nie `member` |
| `app.permission_relations` | `app.relations_of(permission text)` | `text[]` | wie oben für ein beliebiges Recht (Typen ausser dem Blatt) (A10) |
| – | `app.has_tuple(object_type text, object_id uuid, relations text[])` | `boolean` | nicht abgelaufenes Tupel eines Subjekts aus `app.subjects()` mit einer der `relations` an dieser Ressource; `relations` Pflicht, damit jeder Weg über Tupel den Scope beachtet |

Alle Mengen sind mit 5 (Scope) geschnitten. Für interne Prüfungen (`exists`, `hints`, `classification`) setzt der
Baukasten die **volle Sicht** (`read_all`, `write_all` = `on`, `clearance` = 2); was darin gelesen wird, geht nie als
Name oder Wert an die Person zurück. Policies der App (RESTRICTIVE, zusätzlich zu `tenant_isolation`), Muster:

```sql
-- Blatt (Assets: object)
USING (classification <= app.clearance() AND (
  app.read_all() OR type_id = ANY (app.read_types()) OR app.has_tuple('object', id, app.read_relations())
  OR EXISTS (/* Kante mit grants <> 'none' */ … WHERE r.from_id = object.id AND r.to_id = ANY (app.read_units()))
  OR EXISTS (/* Person mit grants <> 'none' (edges.persons) */ … WHERE v.object_id = object.id AND v.principal_id = app.read_person())))
WITH CHECK (classification <= app.clearance() AND (
  app.write_all() OR type_id = ANY (app.write_types()) OR app.has_tuple('object', id, app.write_relations())
  OR EXISTS (/* Kante mit grants = 'edit' */ … AND r.to_id = ANY (app.write_units()))
  OR EXISTS (/* Person mit grants = 'edit' */ … AND v.principal_id = app.write_person())))
-- weitere Ressource mit Tupeln (Assets: view, report, dashboard): Rolle an org über das Recht der App, sonst Tupel
USING (app.read_all_of('view:read') OR app.has_tuple('view', id, app.relations_of('view:read')))
```

Die Lesesicht ersetzt alle App-seitigen Filter verborgener Ressourcen (Assets: `hiddenObjects()`); der Test
«Lesesicht = `can`» ([14](#14-mandantentrennung-und-tests)) hält beide gleich.

### 7.7 `ResourceModel` der App

```ts
interface ResourceRef { type: string; id?: string | null }          // id leer genau bei 'org'

interface ResourceModel<S = unknown> {
  /** Zustand der Kette, geladen mit den Tupeln, zwischengespeichert bis acl_version oder version sich ändert. */
  load?(tx: pg.ClientBase): Promise<S>;
  version?(tx: pg.ClientBase): Promise<string>;
  /** Kette von oben, beginnt mit { type: 'org' }, endet mit ref; mit self-Vorfahren. hint z. B. Typ eines Objekts. */
  chain(state: S, ref: ResourceRef, hint?: string | null): ResourceRef[];
  /** Gibt es die Ressource im Mandanten (volle Sicht)? Sonst 404 bei /v1/access. */
  exists(tx: pg.ClientBase, ref: ResourceRef): Promise<boolean>;
  /** Hinweise für viele Ressourcen (Assets: Typ je Objekt), Schlüssel `<type>:<id>`. */
  hints?(tx: pg.ClientBase, refs: ResourceRef[]): Promise<Map<string, string>>;
  /** Pflicht bei classified-Typen: Stufe je Ressource, Schlüssel `<type>:<id>` (volle Sicht). */
  classification?(tx: pg.ClientBase, refs: ResourceRef[]): Promise<Map<string, 0 | 1 | 2>>;
  /** IDs eines Typs im Zustand (Lesesicht: `app.read_types()` für Typen mit `self` bzw. mehrstufiger Kette unter
   *  einem Blatt). Pflicht, sobald ein Tupel an einem Vorfahren eines Blatt-Elternteils hängen kann. */
  ids?(state: S, type: string): Iterable<string>;
  /** Pflicht bei Typen mit scope: Zuständigkeit als SQL der App (volle Sicht, Parameter $1 uuid[]). */
  edges?: {
    /** Typ der Einheiten; hat `member` in `relations`. */
    unit: string;
    /** Direkt untergeordnete Einheiten von $1 über Kanten mit inherits_scope; Spalte `id uuid`. */
    children: string;
    /** Zugehörigkeit der Ressourcen $1; Spalten `id uuid`, `unit_id uuid`, `grants text` ('read' | 'edit'), `label text` (Name der Kante). */
    belongs: string;
    /** Ab 1.1: zuständige Personen der Ressourcen $1; Spalten `id uuid` (Ressource), `principal_id uuid` (`principal.id`
     *  einer Person), `grants text` ('read' | 'edit' | 'none'), `label text` (Name der Fachbeziehung, z. B. «Verantwortlich»),
     *  optional `type text`. Abfrage je Typ mit den IDs dieses Typs; mit `type` zählen nur Zeilen dieses Typs. */
    persons?: string;
    /** Ab 1.1: Wirkungen der Person $1 (uuid) über alle Ressourcen; Spalten `grants text`, `type text` (ohne: jeder Typ mit
     *  scope; Pflicht bei mehreren). Nur für «Recht irgendwo». */
    personGrants?: string;
  };
}
```

`unit`, `children` und `belongs` stehen nur gemeinsam; ab 1.1 dürfen alle drei fehlen, wenn die App nur `persons`
liefert (`personGrants` nur mit `persons`; Prüfung beim Start). `edges.persons` gilt für Typen mit `scope` (wie `belongs`); dasselbe SQL dient einer und vielen Ressourcen
(`req.can`, `req.need`, `req.capabilities(refs)`, `capabilitiesFor(access, p, refs)`). Fehlt `edges.persons`, gibt es
den Weg nicht. Beispiel Assets: `SELECT v.object_id AS id, v.principal_id, d.grants, d.name AS label FROM
attribute_value v JOIN attribute_def d ON … WHERE v.object_id = ANY($1) AND d.kind = 'user'`.

`version` muss sich mit jeder Änderung der Daten ändern, aus denen `load` die Kette baut (Anlegen, Verschieben; z. B.
`count(*)` und `max(updated_at)` oder ein Zähler per Trigger); ohne `load` und `version` berechnet der Baukasten die
Kette je Anfrage. `fullContext`, `dbContext`, `effectiveExtra`, `effectiveExtraSchema` entfallen (die volle Sicht setzt der Baukasten,
7.6). `flatResources({ tables })` bleibt für Typen direkt unter `org` (Kette `org → r`). `load`, `version` und eine
synchrone `chain` bleiben (A11).

### 7.8 Klassifizierung, Freigabestufe und Break-Glass

| Element | Soll |
|---|---|
| Stufen | `0` intern (Standard), `1` vertraulich, `2` streng vertraulich; Labels aus `classifications` |
| Ressource | Spalte der App (Assets: `object.classification smallint NOT NULL DEFAULT 0`, Vorgabe `object_type.default_classification`); Policy `classification <= app.clearance()` |
| Person, Client | `principal.clearance` (Standard 0), gesetzt über `PUT /v1/admin/members/{id}/clearance` bzw. `PUT /v1/admin/clients/{clientId}` mit `members:admin`: **nie für sich selbst und nie über die eigene Freigabestufe** (wirksam ohne Break-Glass). Die erste Person einer Organisation erhält Stufe 2 von der Plattform-Administration; die eigene Stufe heben geht nur über Break-Glass |
| Stufe an einer Ressource setzen | Endpunkt der App; verlangt `write` des Typs und `clearance(p) ≥` neue **und** bisherige Stufe (niemand klassifiziert über die eigene Stufe hinaus); Audit `object.classified` (`from`, `to`). Hilfe des Baukastens: `req.needClearance(level)` → 403 mit Grund `clearance` (A14) |
| Break-Glass | `POST /v1/break-glass {reason, minutes}` ([9.7](#97-break-glass-v1break-glass)): nur Personen mit Tupel `org-admin` an `org`; setzt `clearance_boost = 2`, `clearance_until = now() + minutes` (1–240); keine Verlängerung ausser durch neuen Aufruf; `DELETE /v1/break-glass` beendet; Audit `break_glass.started`, `break_glass.ended`; Banner in der Oberfläche |

Break-Glass ist die **einzige** Ausnahme: Es hebt nur die Freigabestufe, gibt keine Rechte und gilt nicht für Clients.

### 7.9 Auskunft, Fähigkeiten, Wirkungszeiten

- **403-Text** nennt Label und Schlüssel: «Dir fehlt das Recht «Objekte ändern» (object:write).» Scheitert es an der
  Klassifizierung, bei sichtbarer Ressource: «Die Vertraulichkeit «streng vertraulich» übersteigt deine Freigabestufe.»
  (Grund `clearance`). Unsichtbare Ressourcen: 404 wie unbekannte.
- **Fähigkeiten je Ressource** (E3): Antworten tragen `can`; ETag mit Zugriffsstand (`W/"<version>-<zugriff>"`).
- **Auskunft:** `/auth/me` und `/v1/me` liefern `roles`, `permissions` (an `org`), `somewhere` (irgendwo),
  `clearance`, `breakGlassUntil` ([9.5](#95-zugriff-v1access)). `GET /v1/acl/effective` und die Simulation entfallen;
  «Warum?» beantwortet `GET /v1/access/explain`.
- **Wirkungszeiten** (dokumentiert und in der Oberfläche genannt): Freigabe, Rolle, Freigabestufe, Klassifizierung,
  Break-Glass und Client-Freigabe sofort auf allen Instanzen (Datenbank, Version im Zwischenspeicher); Gruppen aus Entra
  mit dem nächsten Access Token (≤ 5 min); Entfernen einer Person ≤ 5 min (Tokens von davor nie mehr); Sperre einer
  Organisation ≤ 60 s.

## 8. Modell des Produkts

Rechte, Rollen, Scopes und Typen **definiert die App selbst** – Anzahl, Schnitt und Texte. Diese Spezifikation legt nur
fest, **wie** das Modell aufgebaut ist ([7.3](#73-modell-der-app-definemodel)), wie Schlüssel gebildet werden und welche
Namen reserviert sind, weil die produktneutralen Bausteine sie brauchen.

### 8.1 Reservierte Namen

Die App verwendet sie genau in dieser Bedeutung und nie für etwas anderes. Label und Gruppe sind fest und kommen aus
dem Baukasten; die App lässt reservierte Rechte weg und nennt eines nur ohne Label und Gruppe, wenn sie Beschreibung,
`resources` oder Stelle in der Reihenfolge bestimmen will (z. B. `'tenant:admin': { description: '…' }`, ebenso
`{ key: 'access' }` unter `groups`). Fehlende ergänzt `defineModel`.

| Art | Schlüssel | Label | Pflicht | Bedeutung |
|---|---|---|---|---|
| Rolle | `org-admin` | Organisations-Admin | MUSS | `permissions: '*'`, nur an `org`; vergibt und entzieht nur `platform-admin`; die letzte aktive Person mit ihr bleibt ([9.1](#91-regeln)); steht zuerst |
| Relation | `member` | Mitglied | MUSS mit `scope` (in `relations` der Einheit) | Beziehung ohne Rechte, macht zuständig ([7.4](#74-tupel)) |
| Relation | `owner` | Besitzer:in | MUSS mit `owner` | alle Rechte der Ressource ([7.4](#74-tupel)) |
| Recht | `tenant:read` | Organisation lesen | MUSS | Name und Einstellungen der Organisation sehen |
| Recht | `tenant:admin` | Organisation verwalten | MUSS, wenn die Organisation Einstellungen hat | Name und Einstellungen ändern |
| Recht | `members:admin` | Mitglieder und Rollen verwalten | MUSS mit Verwaltung | Mitglieder einladen und entfernen, Rollen an der Organisation vergeben, Freigabestufen setzen, Anmeldung einrichten, Maschinen-Clients freigeben; **in keinem Scope** |
| Recht | `access:admin` | Zugriff verwalten | MUSS mit `types` | Freigaben an einem Ort anlegen, ändern, entfernen, «Warum?» für andere; **in keinem Scope**. «Wer hat Zugriff?» sieht, wer die Ressource lesen darf (A13) |
| Recht | `audit:read` | Protokoll lesen | MUSS, wenn die App das Protokoll zeigt | Audit-Protokoll durchsuchen und prüfen |
| Typ | `org` | Organisation | MUSS | Wurzel jeder Kette, `roles: '*'` oder Liste (M5) |
| Rechtegruppe | `tenant`, `members`, `access`, `audit` | Organisation, Mitglieder und Rollen, Zugriff, Protokoll | MUSS für die genutzten Rechte | Gruppen der reservierten Rechte |
| Realm-Rolle | `platform-admin` | Plattform-Administration | MUSS | keine Rolle des Modells ([3.5](#35-rollen-und-gruppen)) |

Entfallen: `acl:read`, `acl:admin` (kein `access:read`, A13), Typ `tenant` (heisst `org`), Präfix `c-` eigener Rollen.

### 8.2 Regeln für das Modell

- Schlüssel: Rechte und Scopes `<bereich>:<verb>` (`^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$`, Verben bevorzugt `read`,
  `write`, `delete`, `admin`, `use`); Rollen, Typen und Rechtegruppen `^[a-z][a-z0-9-]*$`; Lese-Scope `<produkt>:read`
  (fehlt er: Warnung). Schlüssel sind stabil (umbenennen = neuer Schlüssel); `member`, `owner` und `platform-admin` sind
  keine Rollenschlüssel.
- Jede Rolle hat Label und eine Beschreibung, die alle Rechtegruppen der Rolle nennt (`groups[].match`); jeder Scope
  einen Text.
- Rechte mit `scope: false`, `members:admin`, `access:admin` und Rechte, die Tokens an fremde Hosts schicken, stehen in
  keinem Scope. Scopes nur für Maschinen-Clients und MCP.
- `access:admin` steht in den Rollen, die an ihrem Ort freigeben sollen (Assets: `org-admin`, `schema-admin` an Schemas,
  `editor` an Objekten, Ansichten, Reports); «niemand gibt mehr, als er hat» begrenzt es ([7.5](#75-entscheidung)).
- SOLL: Rollenset minimal, wenige Typen (Stufen [8.3](#83-stufen)). Vorlage für den Schnitt: Modell von Assets
  (`src/authz/model.ts`).
- Rollen aus dem Modell entfernen: zuerst ihre Tupel löschen (Release-Hinweis); `syncModelChecks` bricht sonst ab.

### 8.3 Stufen

| Stufe | App nutzt | Oberfläche zeigt |
|---|---|---|
| einfach | nur `org` mit 2–3 Rollen | Mitglieder, Meine Rechte |
| mittel | Kette `org → bereich → ding` | zusätzlich «Zugriff» an Bereichen |
| komplex (Assets) | Blatt-Freigaben, Zuständigkeit, Klassifizierung, Besitz | alles |

Panel und Endpunkte sind dieselben; die App deklariert nur mehr oder weniger `types`.

## 9. Verwaltung in der App

Organisations-Admins verwalten Mitglieder, Clients, Rollen an der Organisation und Freigabestufen, wer `access:admin`
hat Freigaben an Orten, die Plattform-Administration Organisationen – ohne Keycloak-Konsole. Referenz für Einladen,
Entra und Organisationen: assets `src/platform/modules/admin/*`, `docs/mandantentrennung.md` › Verwaltung; für Rollen,
Freigaben und Break-Glass gilt allein dieses Kapitel.

### 9.1 Regeln

1. Nur **Personen** (`kind = user`, nicht `scopeBound`).
2. Wer `members:admin` oder `access:admin` hat, arbeitet immer in der Organisation **seines Tokens**; sie kommt nie aus
   der Anfrage.
3. Vor jeder Änderung wird die Person als Mitglied (oder offene Einladung) **dieser** Organisation geprüft; fremde oder
   erfundene IDs → 404 ohne Änderung. Ebenso Subjekte und Orte von Freigaben.
4. Rollen sind ausschliesslich Tupel in der Datenbank der App (D6). Keycloak hält nur Konto und Mitgliedschaft; die App
   legt keine Gruppen und keine Rollen in Keycloak an.
5. `org-admin` vergeben und entziehen (über jeden Endpunkt), Organisationen anlegen, ändern, sperren: nur
   `platform-admin`. Tupel `org-admin` haben kein Ablaufdatum (422) (A15).
6. Die letzte aktive Person mit Tupel `org-admin` an `org` lässt sich weder herabstufen noch entfernen (409
   `last-admin`), auch nicht durch die Plattform-Administration; niemand entfernt sich selbst. Aktiv heisst: nicht
   entfernt, keine offene Einladung, Konto in Keycloak nicht gesperrt (geprüft, wenn der Verwaltungs-Client
   eingerichtet ist).
7. **Niemand gibt mehr, als er hat** ([7.5](#75-entscheidung)): Rolle vergeben, entziehen oder ihren Ablauf ändern nur,
   wenn jedes Recht der Rolle für die handelnde Person am Ort gilt; sonst 403 `exceeds-own` mit `missing` (Rechte).
   Freigabestufe: nie für sich selbst (403 `self`), nie über die eigene ohne Break-Glass (403 `exceeds-own`): die
   eigene gespeicherte Stufe muss mindestens so hoch sein wie die neue **und** die bisherige (wer Stufe 1 hat, senkt
   keine Stufe 2); für die Plattform-Administration gilt die Obergrenze nicht.
8. Änderungen derselben Organisation laufen nacheinander (Advisory-Lock in PostgreSQL).
9. Jede Änderung im Audit des betroffenen Mandanten in derselben Transaktion ([9.8](#98-audit-aktionen)). Scheitert
   Keycloak nach erfolgten Schritten: eigener Eintrag `…_failed` mit den Schritten; neu angelegte Konten werden wieder
   gelöscht.
10. Die Verwaltung einer Organisation erfährt **nichts über andere Organisationen** (assets Nr. 56, Nr. 99):
    - Einladen antwortet immer `202 {"result":"invitation-sent"}` mit den Angaben aus der Einladung, gleich ob ein
      Konto bestand; Mindestdauer `KEYCLOAK_MGMT_INVITE_MIN_TIME` (auch für erneut Senden und Zurückziehen); bei
      Kollision eindeutiger Benutzername; E-Mail-Fehler gleich behandelt.
    - Eingeladene Personen erscheinen aus der Tabelle `member_invitation` mit **eigener ID je Einladung**, nie mit der
      Keycloak-ID; `createdAt` = Einladung in diese Organisation; erst nach Annahme im Personenverzeichnis.
    - Protokoll `member.invited` nur mit `email`, `roles`, `emailSent`.
    - `accountDeleted` beim Entfernen ist ausserhalb der Plattform-Administration immer `false`; gelöscht wird nur ein
      Konto, das diese Einladung selbst angelegt hat (`created_account`) und das keiner anderen Organisation angehört.
11. **Einladen**: neue Adresse → Konto ohne Passwort (Pflichtaktion `UPDATE_PASSWORD`), Mitgliedschaft, E-Mail
    «Passwort festlegen» (`execute-actions-email`, Gültigkeit `KEYCLOAK_MGMT_INVITE_LIFESPAN`, Client
    `<produkt>-platform`). Bestehendes Konto → Einladung von Keycloak, Mitglied erst nach Annahme. Rollen werden
    sofort als Tupel gesetzt: Die Einladung legt den Principal an (`subject` = Keycloak-ID) und gibt ihn zurück;
    Zurückziehen löscht seine Tupel (A16). Ohne SMTP entsteht das Konto trotzdem,
    `emailSent: false`, später erneut senden.
12. **Entfernen** einer Person löscht ihre Tupel (alle Orte) in derselben Transaktion; der Abgleich (`removed_at`)
    löscht nichts, eine Rückkehr bringt die Rechte zurück (A17).
13. Ohne `KEYCLOAK_MGMT_CLIENT_ID` sind Mitglieder aus: `GET /v1/admin/status` sagt das, die Endpunkte unter
    `/v1/admin/members` 503 mit Hinweis. `/v1/access`, `/v1/admin/clients` und `/v1/break-glass` brauchen keinen
    Verwaltungs-Client.

### 9.2 Endpunkte

Fehler als `application/problem+json` (RFC 9457) mit `reason` bei 409 und 403-Gründen, `errors[]` (`path`,
`message`) bei 422. Unbekannte Felder → 422. Schreibende Aufrufe mit Cookie tragen `X-CSRF-Token`.

| Endpunkt | Wer | Abschnitt |
|---|---|---|
| `GET /v1/me`, `GET /v1/authz/catalog` | jede angemeldete Person und jeder Client | [9.5](#95-zugriff-v1access) |
| `GET /v1/admin/status` (`enabled`, `reason`, `organization`, `platformAdmin`, `canManageMembers`, `roles`) | jede angemeldete Person | – |
| `GET/POST /v1/admin/members`, `PUT /v1/admin/members/{id}/roles`, `PUT /v1/admin/members/{id}/clearance`, `DELETE /v1/admin/members/{id}`, `POST /v1/admin/members/{id}/invitation` | `members:admin` | [9.6](#96-mitglieder-und-clients) |
| `GET /v1/admin/clients`, `PUT/DELETE /v1/admin/clients/{clientId}` | `members:admin` | [9.6](#96-mitglieder-und-clients) |
| `GET /v1/access`, `GET /v1/access/explain`, `POST /v1/access`, `PATCH/DELETE /v1/access/{id}` | Leserecht der Ressource bzw. `access:admin` am Ort | [9.5](#95-zugriff-v1access) |
| `GET /v1/access/groups` | `access:admin` irgendwo, nur mit Entra-Verbindung | [9.5](#95-zugriff-v1access) |
| `POST/DELETE /v1/break-glass` | Personen mit `org-admin` | [9.7](#97-break-glass-v1break-glass) |
| `GET/POST/PUT/DELETE /v1/admin/entra…` ([9.4](#94-anmeldung-über-den-idp-der-organisation-kann)) | `members:admin` | – |
| `POST /v1/admin/entra/test` (Testanmeldung melden; die Sitzung muss über den Anbieter angemeldet sein) | jede Person der Organisation | – |
| `GET /v1/admin/members/entra-search?q=` (`selectable`, `reason`), `POST /v1/admin/members/entra` (`id`, `roles`, `sendEmail`) | `members:admin`, nur mit Entra-Verbindung | – |
| `GET /v1/people` (Suche `q`, `ids` bis 100 je Aufruf), `GET /v1/people/{id}`: Personenverzeichnis (Mitglieder ohne `removed_at`; `id` = Principal-ID = Subjekt `user:<id>`) | Recht irgendwo eines lesenden Fachrechts bzw. `access:admin` | – |
| `GET/POST /v1/platform/organizations`, `GET/PATCH /v1/platform/organizations/{alias}`, `POST …/{alias}/suspend`, `POST …/{alias}/resume` (Body optional `reason`) | `platform-admin` | – |
| `…/v1/platform/organizations/{alias}/members…` (auch `…/clearance`, `…/members/entra-search`, `…/members/entra`), `…/{alias}/clients…`, `…/{alias}/entra…` (wie oben, gleiche Formen) | `platform-admin` | – |

Entfallen: `/v1/acl…` (auch `/v1/acl/effective`), `/v1/roles…`, `GET /v1/platform/organizations/{alias}/roles`; in
`/v1/admin/status` `rolesManageable` und `groupRolePrefix`.

Organisation: `id` (Keycloak), `alias`, `name`, `description`, `enabled`, `domains`, `tenant` (`id`, `status`,
`createdAt` oder `null`).

### 9.3 Abgleich ins Personenverzeichnis

- Worker gleicht alle Mandanten nach `MEMBER_SYNC_INTERVAL` ab (Standard 1 h, `0` = aus), höchstens ein Lauf über alle
  Instanzen (Advisory-Lock); zusätzlich sofort nach Entfernen und beim Öffnen der Mitgliederliste. Eingeladene
  erscheinen erst nach Annahme im Personenverzeichnis ([9.1](#91-regeln) Nr. 10), Einladen löst deshalb keinen Abgleich aus.
- Zuordnung Organisation ↔ Mandant über Alias **und** `kc_org_id`; Organisationen ohne Mandant und gesperrte Mandanten
  übersprungen; ein Fehler bei einer Organisation hält die anderen nicht auf und markiert dort niemanden als entfernt.
- Wer nicht mehr Mitglied ist, erhält `removed_at` (nicht löschen: Verweise, Tupel und Audit bleiben); Rückkehr hebt es
  auf (gleiche ID). Maschinen-Clients bleiben unberührt. Audit `people.synced`.
- Im selben Lauf: abgelaufene Tupel löschen (`access.expired`), abgelaufenes Break-Glass zurücksetzen
  (`break_glass.ended` mit `expired: true`) (A8).
- Name der Organisation folgt Keycloak (nur bei gleicher `kc_org_id`, Audit `organization.name_synced`).
- Eigener Client `<produkt>-sync` mit eigenem Schlüssel; der Worker kennt den Schlüssel von `<produkt>-admin` nicht.

### 9.4 Anmeldung über den IdP der Organisation (KANN)

Eine Organisation verbindet ihre Anmeldung selbst mit Microsoft Entra ID; Personen ihrer verifizierten Domänen melden
sich danach nur noch über Microsoft an. Referenz: assets Nr. 104, `docs/konzepte/entra-id.md`,
`src/platform/modules/admin/{entra,graph}.ts`, Migrationen `046`, `047`.

- **Eigene App der Organisation (Kit 0.3, Normalfall):** Die Organisation registriert eine App in ihrem eigenen Tenant
  und trägt Tenant, Anwendungs-ID und Geheimnis ein (`PUT …/entra/app`); Kunden haben so nichts mit einer App des
  Betreibers zu tun. Vor dem Speichern prüft die API bei Microsoft: Token der App im Tenant (Client Credentials),
  erteilte Anwendungsberechtigungen (`roles`; Token ohne lesbare Rollen: abgelehnt), Registrierung der App im Tenant
  (`GET /applications(appId=…)`, nur im Heimat-Tenant der App – ein Token allein belegt nur eine Zustimmung, auch für die
  mandantenfähige App eines Herstellers), Organisation und verifizierte Domänen.
  Fehler: 409 `invalid-secret`, `secret-expired`, `wrong-tenant`, `invalid-client`, `missing-permissions` (mit
  `missing`), `app-not-registered-in-tenant`, `tenant-mismatch` (anders verbunden), `domains-taken`; 503
  `encryption-missing`. Kein Nachweis über `wids`:
  Anwendungsberechtigungen mit Administratorzustimmung erteilt nur die Administration des Tenants. Erneut `PUT` wechselt
  Geheimnis bzw. App im selben Tenant; Stufe und Domänen bleiben. Anbieter `entra-app-<alias>` (kein Platz): die
  Redirect-URI steht vorab fest; `GET …/entra` liefert `methods` (`ownApp`, `platformApp`), `ownApp` (Redirect-URI,
  Berechtigungen mit Grund: delegiert `User.Read`, Anwendung `Organization.Read.All`, `User.Read.All`, `Application.Read.All`
  für den Nachweis der Registrierung und den Ablauf des Geheimnisses, `GroupMember.Read.All` für Gruppen in Freigaben) und an der Verbindung
  `method`, `clientId`, `secretExpiresAt`, `secretExpiresSoon` (30 Tage). Das Geheimnis liegt verschlüsselt
  (ENCRYPTION_KEYS, AAD an Mandant und App) in der Datenbank und in Keycloak, nie in Antworten oder im Protokoll.
  Personensuche, Gruppensuche, Vorschau, «Nur Entra» und Aktualisieren laufen mit der App der Verbindung.
  `GroupMember.Read.All` gehört zur Zustimmungsprüfung (`missing-permissions`); fehlt es bei einer bestehenden
  Verbindung, antwortet nur die Gruppensuche mit 409 `entra-consent-missing` (mit Hinweis auf die Berechtigung).
- **App der Plattform (optional):** Eine mandantenfähige App in Entra ID je Produkt (`ENTRA_CLIENT_ID`); Kunden stimmen
  beim Verbinden zu. Ohne `ENTRA_CLIENT_ID` antworten die Zustimmung und Links mit Zustimmung mit 409
  `platform-app-disabled`; eine mit eigener App verbundene Organisation wechselt nur über Trennen (409 `own-app`).
  Berechtigungen in Microsoft Graph (minimal, nach den Aufrufen der App): Anwendung `Organization.Read.All`
  (`GET /organization`: Tenant und verifizierte Domänen), Anwendung `User.Read.All` (`GET /users` mit `$filter` bzw.
  `$search`, `GET /users/{id}`), Anwendung `GroupMember.Read.All` (`GET /groups` mit `$search` bzw. `$filter`,
  `GET /groups/{id}`: Gruppen suchen und Namen auflösen, [9.5](#95-zugriff-v1access)), delegiert `User.Read` (Keycloak
  liest bei der Anmeldung `/me`). Dazu Verzeichnisrollen im
  Gruppen-Claim (`groupMembershipClaims` mit `DirectoryRole`) für den Nachweis der Zustimmung (`wids`).
  Je Organisation ein Identity Provider `entra-NNN` aus einem Pool von Redirect-URIs (`ENTRA_IDP_SLOTS`), mit der
  Organisation und ihren Domänen verbunden (Keycloak ≥ 26.8). `<produkt>-admin` braucht dafür
  `manage-identity-providers`; an jedem Anbieter legt die App genau einen Mapper an: `entra-groups`
  (`oidc-user-attribute-idp-mapper`, Claim `groups` → Attribut `entra_groups`, `FORCE`; [3.5](#35-rollen-und-gruppen)), sonst keine.
- Ablauf zweistufig: verbinden (`pending`, Passwörter gelten weiter) → Testanmeldung über den Anbieter → «Nur Entra»
  (`enforced`) mit bestätigter Liste der Personen, die die Anmeldung verlieren. Nur verifizierte Domänen, die keine
  andere Organisation hat; Gastkonten nie verknüpfen. `state` 15 min, einmalig, an Person, Organisation und Tenant
  gebunden.
- **Zustimmung mit Nachweis:** Verbinden startet einen Code-Flow im Tenant (`/{tid}/oauth2/v2.0/authorize`, Scopes
  `openid profile https://graph.microsoft.com/.default`, `prompt=admin_consent`, PKCE und `nonce` aus `state`). Die API löst den
  Code selbst ein und prüft das ID-Token (Schlüssel des Tenants, `iss` und `tid` = gestarteter Tenant, `aud` = Entra-App,
  `nonce`, kein Gast, `wids` mit «Global Administrator» oder «Privileged Role Administrator»); sonst 409
  `consent-unproven`. `wids` liefert Microsoft nur, wenn die Entra-App Verzeichnisrollen im Gruppen-Claim ausgibt
  (`groupMembershipClaims` mit `DirectoryRole`, Portal: Token configuration › groups claim › Directory roles); fehlt der
  Claim, scheitert die Zustimmung. Ein Tenant, der der App schon früher zugestimmt hat, genügt nie. Wer zugestimmt hat (Objekt-ID,
  Name), steht im Audit von `entra.connected`; Start und Fehlschläge als `entra.consent_started` bzw.
  `entra.consent_failed`.
- Konten der Plattform-Administration (`PLATFORM_ADMIN_ROLE`, auch zusammengesetzt) behalten bei «Nur Entra» Passwort und
  Passkey (Notfallzugang); Vorschau und Ergebnis melden sie mit `passwordKept`.
- Rückkehrseiten der Oberfläche: `<paths.entra>/zustimmung` (Rückkehr von Microsoft, sendet `code`, `state`, `error`,
  `error_description` an `…/entra/consent/complete`) und `<paths.entra>/test` (meldet die Testanmeldung).
- **Link an die Entra-Administration (Kit 0.2):** Darf eine andere Person der Kunden-IT bei Microsoft zustimmen, erzeugt
  die org-admin (bzw. die Plattform) einen Link (`POST …/entra/consent-links` mit `tenant`, optional `validMinutes` 5–1440,
  Standard 15; höchstens 5 offene je Organisation, sonst 409 `too-many-links`). Er ist an Organisation, Mandant und
  Entra-Tenant gebunden, einmal einlösbar, widerrufbar
  (`DELETE …/consent-links/{id}`), nur als SHA-256 gespeichert und steht im Fragment: `<paths.entra>/freigabe#<token>`.
  `GET …/consent-links` zeigt alle offenen und die letzten 20 erledigten Links mit Zustand (`open`, `in-progress` während
  der Einlösung, `expired`, `revoked` – mit `error.reason` `creator-lost-access` bzw. `disconnected`, von Hand ohne
  `error` –, `connected` mit zustimmender Person, `failed` mit Fehler). Offene Links verfallen, wenn die erzeugende Person entfernt
  wird oder `members:admin` verliert (Plattform: die Realm-Rolle) und beim Trennen; geprüft auch beim Start und bei der
  Rückkehr. Gesperrte Organisation: kein Link gilt (404). Die öffentliche Seite braucht keine Sitzung: `POST /v1/entra/handover/info` (Name der Organisation, Produkt,
  `requestedBy` und `tenant` wie bei der Erzeugung angegeben, damit die Entra-Administration fremde Links erkennt, dazu
  `notice`: Die verifizierten Domänen des Verzeichnisses gehen an die Organisation; den Namen des Entra-Tenants kennt die
  App vor der Zustimmung nicht), `…/start` (Adresse zu Microsoft), Rückkehr über `<paths.entra>/zustimmung` mit `state` `h.<alias>.…` an
  `POST /v1/entra/handover/complete`. Gleicher Nachweis wie oben; verbunden wird im Namen der erzeugenden Person, `consentBy` und
  `viaLink` im Audit; eingelöst in derselben Transaktion wie die Verbindung. Unbekannt, abgelaufen, widerrufen oder eingelöst: immer 404; Ratenbegrenzung je IP, `no-store`. Beide ohne Guard; die API prüft selbst. Die Pfade müssen zu den Redirect-URIs der Entra-App und zu
  `ENTRA_UI_PATH` des Servers passen (Standard `/verwalten/anmeldung` wie `paths.entra`). Links haben eine Art (`kind`):
  `consent` wie oben oder `credentials` (Standard ohne App der Plattform): Die Kunden-IT sieht auf der öffentlichen Seite
  die Anleitung (`info.ownApp`) und trägt Anwendungs-ID und Geheimnis selbst ein (`POST /v1/entra/handover/credentials`,
  Tenant fest aus dem Link, Prüfung wie `PUT …/app`, gleiche Schutzmechanismen); niemand gibt das Geheimnis weiter.
  Falsche Art: 409 `link-kind`; `GET …/entra` nennt beide
  (`consentPath`, `testPath`), `testLoginPath` führt mit `returnTo` auf `testPath`. `state` hat das Format `o.<alias>.<zufall>` (eigene Organisation) bzw.
  `p.<alias>.<zufall>` (Plattform-Administration); die Oberfläche öffnet die Zustimmung nur über https bei
  `login.microsoftonline.com` (per Konfiguration erweiterbar).
- Mit «Nur Entra» prüft der Resolver, dass die Sitzung über den Anbieter angemeldet ist (`identity_provider`), sonst 403
  `entra-login-required`; Einladen in die Domänen wird abgelehnt.
- Personen aus Entra suchen, vorab anlegen und verknüpfen, Rollen setzen (Teil 2). Austritte über Graph/SCIM offen
  (assets Nr. 105).
- Weitere IdPs (Google Workspace, SAML) nach demselben Muster als spätere Erweiterung des Baukastens.

### 9.5 Zugriff (`/v1/access`)

Typen in TypeScript-Notation; Zeitpunkte als ISO-8601-Zeichenkette, `Level = 0 | 1 | 2`, `ResourceRef = { type: string;
id: string | null }` (`id` leer genau bei `org`). Querparameter `type`, `id` wie `ResourceRef`.

**Auskunft über sich selbst**

| Endpunkt | Wer | Antwort 200 |
|---|---|---|
| `GET /auth/me` (BFF) | Sitzung, sonst 401 | `Me` |
| `GET /v1/me` | jeder Principal | `ApiMe` |
| `GET /v1/authz/catalog` | jeder Principal, ohne Rechteprüfung; nach `Accept-Language` (`Vary`) | `AuthzCatalog` |

```ts
interface Me {
  person: { subject: string; name: string | null; email: string | null };
  tenant: { id: string; alias: string; name: string; entraConnected: boolean } | null;  // entraConnected: Entra-Verbindung besteht (Gruppen im GrantDialog)
  organizations: string[]; organizationNames: Record<string, string>; selectedOrganization: string | null; tenantError: string | null;
  roles: string[];               // Rollen an org (nicht abgelaufene Tupel eines meiner Subjekte)
  permissions: string[];         // Rechte an org
  somewhere: string[];           // Rechte, die an mindestens einem Ort gelten; Obermenge von permissions
  clearance: Level;              // wirksame Freigabestufe (mit Break-Glass)
  breakGlassUntil: string | null;
  breakGlassAllowed: boolean;    // nur direktes Tupel user:<ich> org-admin an org (nicht über Gruppen oder org:members), 9.7
  csrfToken: string; session: { expiresAt: string; idleTimeoutSeconds: number };
}
interface ApiMe {                // wie bisher, grantedPermissions → somewhere
  tenant: { id: string; alias: string };
  principal: { id: string; kind: 'user' | 'client'; name: string; email: string | null; clientId: string | null };
  roles: string[]; scopes: string[]; permissions: string[]; somewhere: string[];
  clearance: Level; breakGlassUntil: string | null; tokenBinding: string;
}
interface AuthzCatalog {
  permissions: { key: string; label: string; group: string; description: string; resources: string[]; adminOnly: boolean; personOnly?: true }[];
  groups: { key: string; label: string; match?: string }[];
  roles: { key: string; label: string; description: string; permissions: string[]; adminOnly: boolean }[];  // adminOnly: nur platform-admin vergibt
  scopes: { key: string; text: string; permissions: string[] }[];
  types: {                       // ersetzt resourceTypes; org zuerst
    key: string; label: string; parent: string | null; self?: true;
    roles: string[];             // Rollen, die hier hängen dürfen (org: alle)
    relations: string[];         // roles plus Beziehungen ohne Rechte ('member') und 'owner', wo zulässig
    leaf?: true; classified?: true; owner?: true;
    membersRole?: string;        // Rolle des Schalters «Für alle Mitglieder» (nur bei owner; Standard viewer, falls zulässig)
    scope?: { relation: string };
    read?: string; write?: string;
  }[];
  classifications: { level: Level; label: string }[];
  mcpTools: { name: string; title: string; permission: string; scope: string | null; readOnly: boolean }[];
}
```

**Wer hat Zugriff?**

| Endpunkt | Wer | Antwort |
|---|---|---|
| `GET /v1/access?type=&id=` | `read` des Typs an der Ressource (an `org`: `tenant:read`) (A13) | 200 `AccessList` |
| `GET /v1/access?subject=me` | jeder Principal (eigene Freigaben, für «Meine Rechte») (A23) | 200 `{ items: AccessEntry[] }` (nur `via: 'direct'`) |
| `GET /v1/access?subject=<subjekt>` | `members:admin` (Orte eines Mitglieds, «+3 Orte») | 200 `{ items: AccessEntry[] }` (nur `via: 'direct'`) |

```ts
interface AccessList {
  resource: ResourceRef;
  classification: Level | null;  // null: Typ ohne classified
  items: AccessEntry[];          // direkt zuerst, dann geerbt von unten nach oben, dann Zuständigkeit (Einheiten, dann Personen)
  grantable: string[];           // Relationen, die ich hier vergeben darf (7.5); leer ohne access:admin
}
interface AccessEntry {
  id: string | null;             // Tupel-ID; null bei Zuständigkeit ('scope', 'data')
  subject: {
    ref: string;                 // 'user:<id>' | 'client:<id>' | 'group:<entra-object-id>' | 'org:members'
    kind: 'user' | 'client' | 'group' | 'members';
    name: string;                // Name der Person bzw. des Clients, Anzeigename der Gruppe (Graph, sonst Objekt-ID), «Alle Mitglieder»
    scopes?: string[] | null;    // nur Clients: Scopes im letzten Token
  };
  relation: string;              // Rolle, 'member' oder 'owner'; bei 'data' der Name der Fachbeziehung
  place: ResourceRef;            // Ort des Tupels; bei 'data' die Ressource selbst
  via: 'direct' | 'inherited' | 'scope' | 'data';  // 'data' ab 1.1: zuständig als Person über Fachdaten (edges.persons)
  unit?: { ref: ResourceRef; relation: string; grants: 'read' | 'edit' };  // nur bei 'scope': Einheit, zu der die Ressource gehört
  data?: { relation: string; grants: 'read' | 'edit' };                  // nur bei 'data': «zuständig über <relation>»
  expiresAt: string | null; createdAt: string | null; createdBy: string | null;  // createdBy: Name
  removable: boolean;            // ich darf entfernen und den Ablauf ändern (nur 'direct'; 'data' ändert nur die App in ihren Daten)
}
```

Ressource unbekannt, in fremder Organisation oder für mich nicht lesbar: 404. Namen von Orten liefert die Antwort nicht;
die Oberfläche löst sie über `IamResources` auf ([11.4](#114-bausteine-und-schnittstelle-zur-app)).

**Gruppen aus Entra suchen** (A4): `GET /v1/access/groups?q=&ids=` – `access:admin` irgendwo, nur mit Entra-Verbindung
(sonst 409 `entra-not-connected`; ohne erteilte Anwendungsberechtigung `GroupMember.Read.All` 409
`entra-consent-missing` mit Hinweis); sucht über die Graph-Anbindung der Verbindung (`q` ab 2 Zeichen, höchstens 50) bzw.
löst `ids` (bis 100) auf. Antwort 200 `{ items: { id: string; name: string }[] }` (`id` = Objekt-ID, Subjekt
`group:<id>`). Namen werden je Mandant zwischengespeichert (auch für `AccessEntry.subject.name`); eine Organisation hat
höchstens eine Entra-Verbindung, Objekt-IDs sind eindeutig. Überlauf bei mehr als 200 Gruppen: O1. Berechtigung in Graph: `GroupMember.Read.All` (A25, [9.4](#94-anmeldung-über-den-idp-der-organisation-kann)).

**Warum?**

`GET /v1/access/explain?type=&id=&permission=&subject=` – `subject` fehlt: ich selbst (Ressource muss für mich lesbar
sein, sonst 404); für andere `access:admin` am Ort (A13). `permission` fehlt: `read` des Typs (fehlt das: 422).
Gruppen aus Entra ID kennt das Backend nur aus dem Token: Für andere Personen zählen ihre direkten Tupel und
`org:members`, nicht ihre Gruppen. Die Plattform-Administration braucht auf `/v1/access…` kein `access:admin` und ist
von `exceeds-own` ausgenommen (A9), sieht aber nur Orte, die für sie lesbar sind (sonst 404).

```ts
interface Explain {
  allowed: boolean;
  permission: string;
  subject: { ref: string; name: string };
  reasons: {                     // alle Wege, die das Recht ergeben (Regeln 1, 2, 4); leer, wenn keiner
    via: 'direct' | 'inherited' | 'scope' | 'owner' | 'data';
    relation: string; place: ResourceRef; tupleId: string | null;
    matched: string;             // welches Subjekt passt, z. B. 'group:<entra-object-id>' oder 'org:members'
    label: string;               // Anzeigename von matched: Gruppe aus dem Graph-Zwischenspeicher (sonst Objekt-ID), Person, Client, «Alle Mitglieder»
    unit?: { ref: ResourceRef; relation: string; grants: 'read' | 'edit' };
    data?: { relation: string; grants: 'read' | 'edit' };  // nur bei 'data'; matched = 'user:<principal-id>'
  }[];
  blocked:                       // was trotz Weg verhindert; null, wenn allowed oder kein Weg
    | { reason: 'clearance'; classification: Level; clearance: Level }
    | { reason: 'scope'; scope: string | null }   // engster Scope, der fehlt
    | null;
}
```

**Freigeben, ändern, entfernen**

| Endpunkt | Wer | Anfrage | Antwort |
|---|---|---|---|
| `POST /v1/access` | `access:admin` am Ort, 9.1 Nr. 5–7; an `org` auch für Personen (wie Mitglieder › Rollen) (A24) | `{ subject: string; relation: string; type: string; id?: string \| null; expiresAt?: string \| null }` | 201 `AccessEntry` |
| `PATCH /v1/access/{id}` | wie `POST` am Ort des Tupels (A22) | `{ expiresAt: string \| null }` | 200 `AccessEntry` |
| `DELETE /v1/access/{id}` | wie `POST` am Ort des Tupels | – | 204 |

| Status | `reason` / Feld | Wann |
|---|---|---|
| 403 | – | kein `access:admin` am Ort |
| 403 | `exceeds-own` (+ `missing: string[]`) | Rolle enthält Rechte, die ich am Ort nicht habe |
| 403 | `platform-admin-only` | Relation `org-admin` ohne `platform-admin` |
| 404 | – | Ort, Tupel oder Subjekt (`user:`, `client:`) unbekannt, fremd oder nicht lesbar |
| 409 | `duplicate` | gleiches Tupel besteht (auch abgelaufen und noch nicht gelöscht) |
| 409 | `last-admin` | entfernt das letzte `org-admin` einer aktiven Person |
| 422 | `relation` | Relation am Typ nicht zulässig (`types[].relations`); `owner` (setzt nur die App) |
| 422 | `subject` | Muster ungültig; `client:` (nur über [9.6](#96-mitglieder-und-clients)) (A3); `group:` ohne Entra-Verbindung |
| 422 | `expiresAt` | nicht in der Zukunft; gesetzt bei `org-admin` |

### 9.6 Mitglieder und Clients

```ts
interface Member {
  id: string;                    // Person: Keycloak-ID bzw. Einladungs-ID (9.1 Nr. 10); Client: clientId
  kind: 'user' | 'client';
  principalId: string;           // Subjekt user:<id> bzw. client:<id>; nie null, die Einladung legt den Principal an (A16)
  username: string; name: string; email: string | null;
  status: 'active' | 'invited' | 'disabled';
  roles: string[];               // Rollen an org
  clearance: Level;              // gespeicherte Stufe, ohne Break-Glass
  breakGlassUntil: string | null;
  places: number;                // Tupel an anderen Orten als org («+3 Orte»)
  lastSeenAt: string | null; createdAt: string | null;
  loginPath: string | null;      // nur offene Einladung aus Entra ID
  clientId: string | null; scopes: string[] | null;   // nur Clients: Scopes im letzten Token
  description: string | null;    // nur Clients: Beschreibung der Freigabe
}
interface Client {
  clientId: string; principalId: string; description: string;
  roles: string[]; clearance: Level; places: number;
  createdAt: string; createdBy: string | null; lastUsedAt: string | null; lastScopes: string[] | null;
}
```

| Endpunkt | Anfrage | Antwort | Fehler |
|---|---|---|---|
| `GET /v1/admin/members` | – | 200 `{ items: Member[] }` – Personen **und** freigegebene Clients | 503 ohne Verwaltung |
| `POST /v1/admin/members` | wie bisher (`email`, `firstName`, `lastName`, `roles`; kein `sendEmail`) | 202 `{ result: 'invitation-sent', member: Member, … }` | 403 `exceeds-own`, `platform-admin-only`; 422 |
| `PUT /v1/admin/members/{id}/roles` | `{ roles: string[] }` (Rollen an org, vollständige Liste) | 200 `Member` | 403 `exceeds-own`, `platform-admin-only`; 404; 409 `last-admin`; 422 `roles` |
| `PUT /v1/admin/members/{id}/clearance` | `{ clearance: Level }` | 200 `Member` | 403 `exceeds-own`, `self`; 404; 422 |
| `DELETE /v1/admin/members/{id}` | – | wie bisher (`accountDeleted`); löscht alle Tupel der Person | 404; 409 `last-admin`, `self` |
| `POST /v1/admin/members/{id}/invitation` | – | 200 `{ emailSent: boolean }` | 404 |
| `GET /v1/admin/clients` | – | 200 `{ items: Client[] }` | – |
| `PUT /v1/admin/clients/{clientId}` | `{ roles: string[] (≥ 1); description?: string (≤ 500, fehlt: bleibt); clearance?: Level (fehlt: bleibt) }` | 200 `Client` (legt Principal an, falls neu, A18) | 403 `exceeds-own`, `platform-admin-only`; 422 |
| `DELETE /v1/admin/clients/{clientId}` | – | 204; löscht alle Tupel des Clients | 404 |

`PUT …/roles` und `PUT /v1/admin/clients/{clientId}` setzen die Tupel `<subjekt> <rolle> org` auf genau die Liste
(fehlende anlegen, übrige löschen), in einer Transaktion; Regeln [9.1](#91-regeln) Nr. 5–7 je hinzugefügter und
entfernter Rolle.

### 9.7 Break-Glass (`/v1/break-glass`)

| Endpunkt | Wer | Anfrage | Antwort | Fehler |
|---|---|---|---|---|
| `POST /v1/break-glass` | Person (nicht `scopeBound`) mit direktem Tupel `user:<id> org-admin` an `org` (nicht über Gruppen oder `org:members`; `/auth/me` `breakGlassAllowed`) | `{ reason: string (1–500); minutes: integer (1–240) }` | 200 `{ until: string; clearance: 2 }` | 403; 422 |
| `DELETE /v1/break-glass` | dieselbe Person | – | 204 (auch ohne aktives Break-Glass) | 403 |

Ein neuer `POST` während eines aktiven Break-Glass beginnt neu ab jetzt (eigener Eintrag `break_glass.started`).

### 9.8 Audit-Aktionen

| Aktion | Wann | `data` (Kern) |
|---|---|---|
| `access.granted` | `POST /v1/access`, `PATCH` (mit `previousExpiresAt`) | `subject`, `relation`, `type`, `id`, `expiresAt` |
| `access.revoked` | `DELETE /v1/access/{id}`; Tupel beim Entfernen einer Person oder eines Clients | wie oben |
| `access.expired` | Aufräumjob | wie oben |
| `member.invited`, `member.removed`, `member.invitation_resent` | wie bisher | wie bisher |
| `member.roles_changed` | `PUT …/members/{id}/roles` | `added`, `removed` |
| `member.clearance_changed` | `PUT …/members/{id}/clearance` | `from`, `to` |
| `client.granted` | `PUT /v1/admin/clients/{clientId}` | `clientId`, `roles`, `clearance` |
| `client.revoked` | `DELETE /v1/admin/clients/{clientId}` | `clientId` |
| `break_glass.started` | `POST /v1/break-glass` | `reason`, `until` |
| `break_glass.ended` | `DELETE /v1/break-glass`, Ablauf | `expired` |
| `object.classified` | Endpunkt der App | `type`, `id`, `from`, `to` |
| `organization.updated`, `organization.name_synced`, `tenant.provisioned`, `tenant.suspended`, `tenant.resumed`, `people.synced`, `entra.*` | wie bisher | wie bisher |

Entfallen: `acl.*`, `role.created`, `role.updated`, `role.deleted`. Aktionen der Plattform-Administration tragen
zusätzlich `platformAdmin` und `actorTenant`. Filter «Zugriff» im Protokoll der App: `access.*`, `break_glass.*`,
`object.classified`.

## 10. Datenbank

Referenz: assets `db/bootstrap.sql`, `db/migrations/001_core.sql`, `016_org_admin.sql`, `020_tenant_isolation.sql`,
`043_invitation_id.sql`, `src/platform/db/pool.ts`; Tupel und Lesesicht: [authz-konzept.md](authz-konzept.md) 3.2–3.4.

### 10.1 Rollen

| Rolle | Art | Zweck |
|---|---|---|
| `<produkt>_owner` | Login | besitzt alle Objekte, führt Migrationen aus; keine Laufzeitnutzung |
| `<produkt>_app` | Gruppe, `NOBYPASSRLS` | Laufzeit: Zugriff nur über RLS je Mandant |
| `<produkt>_sched` | Gruppe, `NOBYPASSRLS` | Warteschlange/Outbox über Mandanten, nur diese Tabellen, nur lesen/schreiben was nötig |
| `<produkt>_runtime` | Login ∈ `_app` | API (und MCP) |
| `<produkt>_worker` | Login ∈ `_app`, `_sched` | Worker |

`REVOKE ALL ON DATABASE … FROM PUBLIC`, Schemas `app` (Funktionen) und `<produkt>` (Tabellen) ohne USAGE für PUBLIC,
keine SECURITY-DEFINER-Funktion für PUBLIC; neue Funktionen ohne EXECUTE für PUBLIC (`ALTER DEFAULT PRIVILEGES`).
Geprüft mit `publicSchemaProblems`, `publicExecuteProblems` und `securityDefinerProblems` des Test-Kits.

### 10.2 Tabellen des IAM

| Tabelle | Spalten (Kern) | Schutz |
|---|---|---|
| `tenant` | `id`, `kc_org_id` UNIQUE, `alias` UNIQUE CHECK Muster, `name`, `status`, `acl_version` (Konsistenzmarke), `settings`, `created_at` | RLS ohne FORCE (Besitzer-Funktionen), Richtlinie `tenant_self` (nur eigener Mandant) |
| `principal` | `tenant_id`, `id`, `kind`, `subject`, `display_name`, `email`, `client_id`, `last_seen_at` (leer = nie angemeldet), `removed_at`, `last_scopes`, **`clearance`** `smallint NOT NULL DEFAULT 0 CHECK (clearance BETWEEN 0 AND 2)`, **`clearance_until`** `timestamptz`, **`clearance_boost`** `smallint CHECK (clearance_boost BETWEEN 0 AND 2)`, CHECK `(clearance_until IS NULL) = (clearance_boost IS NULL)`; PK `(tenant_id, id)`, UNIQUE `(tenant_id, kind, subject)`; `last_roles` entfällt | FORCE RLS |
| `authz_tuple` | siehe unten | FORCE RLS; Trigger erhöht `acl_version` |
| `entra_connection` u. a. (KANN) | Verbindung je Organisation, Zustand, Domänen, `state` als Hash | FORCE RLS |
| `member_invitation` | `tenant_id`, `id` (eigene ID), `user_id` (Keycloak), `email`, `display_name`, `created_at`, `created_by_name`, `accepted_at`, `created_account`; UNIQUE offene Einladung je E-Mail | FORCE RLS |
| `session` | `id` (Hash), `data` (verschlüsselt), `csrf`, `subject`, `idp_sid`, Zeiten | ohne Mandantendaten, ohne RLS |
| `audit_log` | je Mandant lückenlose Folge `seq`, Hash-Kette | FORCE RLS; nur lesen und anhängen |
| `replay_guard`, `rate_limit` | geteilter Zustand (`SHARED_STATE=postgres`) | ohne Mandantendaten |

Entfallen: `acl_entry`, `tenant_role`, `client_grant` (und ihre Trigger, Funktionen, CHECKs).

```sql
CREATE TABLE <produkt>.authz_tuple (
  tenant_id   uuid NOT NULL REFERENCES <produkt>.tenant (id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  subject     text NOT NULL,          -- 'user:<uuid>' | 'client:<uuid>' | 'group:<entra-object-id>' | 'org:members'
  relation    text NOT NULL,          -- Rolle des Modells, Beziehung ohne Rechte ('member'), 'owner'
  object_type text NOT NULL,          -- Typ des Modells
  object_id   uuid,                   -- leer genau bei 'org'
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,                   -- principal.id; leer bei Plattform-Administration und System
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT authz_tuple_subject_check CHECK (
    subject ~ '^(user|client|group):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR subject = 'org:members'),
  CONSTRAINT authz_tuple_org_check CHECK ((object_type = 'org') = (object_id IS NULL)),
  CONSTRAINT authz_tuple_client_check CHECK (subject NOT LIKE 'client:%' OR object_type = 'org'),
  CONSTRAINT authz_tuple_relation_check CHECK (relation IN (…)),        -- syncModelChecks
  CONSTRAINT authz_tuple_object_type_check CHECK (object_type IN (…)),  -- syncModelChecks
  CONSTRAINT authz_tuple_unique UNIQUE NULLS NOT DISTINCT (tenant_id, subject, relation, object_type, object_id)
);
CREATE INDEX authz_tuple_object_idx  ON <produkt>.authz_tuple (tenant_id, object_type, object_id);
CREATE INDEX authz_tuple_subject_idx ON <produkt>.authz_tuple (tenant_id, subject);
CREATE INDEX authz_tuple_expires_idx ON <produkt>.authz_tuple (expires_at) WHERE expires_at IS NOT NULL;
CREATE TRIGGER authz_tuple_acl_version AFTER INSERT OR UPDATE OR DELETE ON <produkt>.authz_tuple
  FOR EACH STATEMENT EXECUTE FUNCTION app.bump_acl_version();
```

- `syncModelChecks(tx, model)` (Nachfolger von `syncAclChecks`) setzt die beiden CHECKs aus dem Modell (Relationen aller
  Typen, Typen) bei jeder Migration und beim Start im Test; Tupel mit nicht mehr bekannter Relation oder Typ lassen die
  Migration scheitern ([8.2](#82-regeln-für-das-modell)).
- Welche Relation an welchem Typ zulässig ist, prüft die API (422), nicht die Datenbank.
- Migrationen: bestehende IAM-Migrationen bleiben unverändert; `iam_015_authz.sql` legt `authz_tuple`, die Spalten
  der Freigabestufe und die Funktionen der Lesesicht an und entfernt `acl_entry`, `tenant_role`, `client_grant`
  (greenfield: deren Daten werden nicht übernommen; erste Person je Organisation danach mit `iam-org-bootstrap`).

### 10.3 Mechanik

- `app.tenant_id()`, `app.principal_id()` aus `current_setting(…, true)`; die App setzt den Kontext je Transaktion
  (`set_config(…, true)` bzw. `SET LOCAL`, PgBouncer-tauglich) nur über `withTenant`/`req.tx`; dort setzt der Baukasten
  auch die Lesesicht ([7.6](#76-lesesicht-je-anfrage)).
- Funktionen der Lesesicht (`app.subjects()`, `app.clearance()`, `app.read_all()`, `app.read_types()`,
  `app.read_units()`, `app.write_all()`, `app.write_types()`, `app.write_units()`, `app.read_all_of(text)`,
  `app.read_relations()`, `app.write_relations()`, `app.has_tuple(text, uuid, text[])`): `STABLE`, `SECURITY INVOKER`, `search_path` fest, EXECUTE nur für `_app`.
- `app.secure_tenant_tables()` läuft nach **jeder** Migration: jede Tabelle mit `tenant_id` erhält ENABLE + FORCE RLS,
  Richtlinie `tenant_isolation` (`USING` und `WITH CHECK` `tenant_id = app.tenant_id()`) und die Rechte für `_app`.
- Fremdschlüssel zusammengesetzt (`tenant_id, …`): eine fremde ID verhält sich wie eine unbekannte.
- `app.resolve_tenant` (SECURITY DEFINER, `search_path` fest, nur `_app` ausführbar) nach [Kapitel 4](#4-mandanten).
- Eindeutigkeiten je Mandant (kein 409-Orakel über Mandanten).

## 11. Oberfläche

Referenz: assets `web/src/auth/*`, `web/src/shell/*`, `web/src/ui/{MissingRight,RightsOverview,RoleMatrix,AdminHead,
MenuButton,org}.tsx`, `web/src/features/admin/*`, `docs/oberflaeche.md`; Zugriff, Vertraulichkeit und Break-Glass:
[authz-konzept.md](authz-konzept.md) 5.2.

### 11.1 Anmeldung und Organisation

- Start: `GET /auth/me`; 401 → `/auth/login?returnTo=<adresse>`. Mehrere Organisationen ohne Wahl → Auswahlseite.
- `X-CSRF-Token` automatisch bei jedem schreibenden Aufruf.
- Jede 401 öffnet «Sitzung abgelaufen» mit «Erneut anmelden» (Rücksprung an dieselbe Stelle, Eingaben bleiben).
- **Organisation je Tab**: Der Tab merkt sich seine Organisation (`sessionStorage`) und sendet sie als `X-Tenant` an
  `/v1` und `/auth/me`; ein Wechsel ändert keinen anderen Tab. Name der Organisation in der Kopfzeile auf allen
  Breiten; Dialoge und Meldungen der Verwaltung nennen die Organisation, in der sie wirken. Wechsel ohne neue
  Anmeldung im Kontomenü und in der Befehlspalette. 403 für die Organisation des Tabs → Hinweis mit «Neu laden» statt
  Daten einer anderen.
- 404 überall gleich: «Nicht gefunden – gelöscht, für dich nicht sichtbar oder in einer anderen Organisation.»

### 11.2 Rechte sichtbar machen

- Bedienelemente nach `permissions` bzw. `somewhere` aus `/auth/me` und nach `can` der Ressource; Labels nur aus
  `GET /v1/authz/catalog` (`useAuthz()`), Begriffe nach [7.2](#72-begriffe-sichtbar-in-der-oberfläche-verbindlich)
  («Organisation», nie «Mandant», «Principal», «ACL», «Zugriffsregel»).
- **Fehlendes Recht** an der Stelle der Aktion (`MissingRight`): Recht mit Label, Rollen, die es enthalten, wer Rollen
  vergibt («Diese Rolle vergibt die Plattform-Administration» bei `org-admin`), ergänzt um «oder jemand gibt dir am Ort
  … frei» (Rollen, die an diesem Typ hängen dürfen und das Recht enthalten). Scheitert es an der Vertraulichkeit: Stufe
  und eigene Freigabestufe.
- Seiten mit Rechtebedarf: Routen-Guard `requires(…)` zeigt «Recht fehlt» statt eines 403.
- **Meine Rechte** im Kontomenü (`MyRightsDialog`): Rollen an der Organisation als Karten, Rollen an Orten mit Ort
  (`GET /v1/access?subject=me`), Freigabestufe, Rechte-Übersicht, «Rollen vergleichen».
- Baustein **Rechte-Übersicht** (`RightsOverview`) für alle Blickwinkel (ich, Person, Rolle, Client, Assistent):
  «Darf n von m», Gruppen mit Zählung, je Recht Status `role` (erlaubt über Rolle an der Organisation), `place` (nur an
  einzelnen Orten), `scope` (fehlt im Scope) oder fehlt, «Warum?». `org-admin` als ein Satz «Alle Rechte.»
- **Rollenmatrix** Rechtegruppe × Rolle im Rollendialog, ohne waagrechtes Scrollen.
- Vertraulichkeit: `ClassificationBadge` ab Stufe 1 in Listen, Kopf und Suche; Banner bei aktivem Break-Glass auf
  jeder Seite (`BreakGlassBanner`). Starten: im `WhyDialog`, wenn `blocked.reason = 'clearance'` und
  `useBreakGlass().allowed`, mit Begründung und Dauer (A19).

### 11.3 Verwalten

| Seite | Wer | Inhalt |
|---|---|---|
| Mitglieder | `members:admin` | Liste Personen **und** Clients (Spalte Art), Rollen an der Organisation, Freigabestufe, «+n Orte» (Klick zeigt die Orte mit Rolle, `GET /v1/access?subject=`; in der Plattformansicht nur Rollen an der Organisation, ohne «+n Orte»), zuletzt aktiv, bei Clients Scopes aus dem letzten Token; einladen, Client freigeben (Client-ID, Rollen, Freigabestufe), Rollen setzen (Dialog mit Rollenmatrix), Freigabestufe setzen, über «⋯» entfernen bzw. entziehen, Einladung erneut senden oder zurückziehen |
| Anmeldung (KANN) | `members:admin` | Entra ID verbinden, Testanmeldung, Vorschau, «Nur Entra», Domänen, trennen |
| Organisationen | `platform-admin` | anlegen, umbenennen, Domänen, sperren/entsperren, Mitglieder (mit Clients) und Anmeldung der Organisation |

Entfallen: Seiten «Rollen», «Zugriff» (mit «Eintrag hinzufügen», «Prüfen»), «Maschinen-Clients», `AclHint`; Pfade
`paths.roles`, `paths.access`, `paths.clients`. «Zugriff» gibt es nur noch als Seitenleiste an der Ressource (11.4).

Muster: Hauptaktion im Seitenkopf; Zeilenaktionen im Menü «Mehr zu <Name>»; nicht Erlaubtes gesperrt **mit Grund**
statt ausgeblendet; Fehler im Dialog; Prüfung beim Absenden mit Meldung am Feld; unter 760 px gestapelt, kein
waagrechtes Scrollen bei 390 px; hell/dunkel; Tastatur und Screenreader (axe ohne serious/critical); 404 für Unsichtbares.

### 11.4 Bausteine und Schnittstelle zur App

**Zugriff** ist ein Baustein für alle Orte, überall gleich aufgebaut (Konzept 5.2):

```
Zugriff auf «Server srv-042»                                   [Freigeben]
  Vertraulichkeit: vertraulich  ▾                     (nur mit write und Stufe ≥)

  Wer                    Rolle            Über                             Bis
  Anna Muster            Bearbeiterin     direkt                           31.12.2026   [⋯]
  Abteilung X (Gruppe)   Mitglied         Zuständigkeit: gehört zu «Abt X» –            →
  Peter Meier            Leser            Schema «IT»                      –            →
  Alle Mitglieder        Leser            Organisation                     –            →
  sync-1 (Client)        Bearbeiter       Organisation · Scope assets:read –            →

  Warum sehe ich das?  →  «Du liest dieses Objekt über die Rolle Leser:in am Schema IT.»
```

- «Über» nennt den Ort (`via`, `place`, `unit`); der Pfeil ruft `resources.open(place)`. Einträge mit `removable`
  lassen sich ändern (Ablauf, `PATCH`) und entfernen; geerbte nur am Ursprung.
- «Freigeben» (`GrantDialog`): Person (Personenverzeichnis), Gruppe aus Entra (nur mit Entra-Verbindung,
  `me.tenant.entraConnected`, 409 `entra-not-connected` der Suche als Rückfall; Suche über `GET /v1/access/groups?q=`, A4) oder «Alle Mitglieder»; Rolle nur aus `grantable`; Ablaufdatum optional (Ende des gewählten Tages in Ortszeit, als ISO-Zeitpunkt mit Zeitzone). Clients nicht (nur über Mitglieder).
- Bei Ressourcen mit `owner` ist «Für alle Mitglieder» die erste Zeile (Schalter = Tupel `org:members` mit
  `types[].membersRole` des Typs, Standard `viewer`; ohne `membersRole` und ohne Rolle `viewer` am Typ fehlt der
  Schalter; Server < 1.2 liefern das Feld nicht, dann gilt `viewer`) (A7, D10). `/v1/access` nimmt für `org:members`
  jede vergebbare Rolle, die Wahl der Rolle liegt allein beim Schalter.

```ts
// Konfiguration (Props von IamProvider), Änderungen gegenüber 0.x
interface IamFeatures { access?: boolean /* Standard: Modell hat Typen ausser org */; entra?: boolean; platform?: boolean }  // acl entfällt
interface IamPaths { home: string; loggedOut: string; members: string; entra: string; organizations: string }  // roles, clients, access entfallen
interface IamResources {
  /** Name je Ort aus dem Cache der App; undefined = unbekannt oder für mich nicht sichtbar («nicht sichtbar»). */
  useResolver(): { name(ref: ResourceRef): string | undefined };
  /** Öffnet einen Ort (Pfeil «Über», Orte in Meine Rechte und Mitglieder); ohne: keine Pfeile. */
  open?(ref: ResourceRef): void;
}
interface IamConfig { /* … wie bisher ohne groupRolePrefix, roleIcons */ resources?: IamResources }

// Bausteine (Export aus @vollholz/iam-web)
interface AccessSheetProps {
  resource: ResourceRef; label: string;          // Titel «Zugriff auf «label»»
  open: boolean; onClose(): void;
  /** Feld Vertraulichkeit, nur bei classified; speichern über den Endpunkt der App. */
  classification?: { level: Level; onChange?(level: Level): Promise<void>; disabledReason?: string };
}
interface GrantDialogProps { resource: ResourceRef; label: string; grantable: string[]; onClose(): void; onGranted?(entry: AccessEntry): void }
interface WhyDialogProps { resource: ResourceRef; label: string; permission?: string; subject?: string; onClose(): void }
interface ClassificationBadgeProps { level: Level }   // 0: nichts; Label aus catalog.classifications
function BreakGlassBanner(): JSX.Element | null;      // sichtbar bei me.breakGlassUntil; «beenden» → DELETE /v1/break-glass
function useBreakGlass(): { allowed: boolean /* = me.breakGlassAllowed */; until: Date | null; start(reason: string, minutes: number): Promise<void>; end(): Promise<void> };
function MembersPage(): JSX.Element;
interface MemberListProps { alias?: string; platform?: boolean }   // Plattform: Organisation alias
interface RightsOverviewProps { roles?: string[]; permissions: string[]; somewhere?: string[]; scopes?: string[]; admin?: boolean; headingLevel?: 2 | 3 | 4 | 5 | 6 }
function MyRightsDialog(props: { onClose(): void }): JSX.Element;

// Daten (access/api.ts, react-query)
useAccessList(ref: ResourceRef): UseQueryResult<AccessList>;
useMyAccess(): UseQueryResult<{ items: AccessEntry[] }>;
useExplain(ref: ResourceRef, o?: { permission?: string; subject?: string }): UseQueryResult<Explain>;
useGrant(), usePatchAccess(), useRevoke();       // Mutationen, invalidieren useAccessList und /auth/me
```

- `Level`, `ResourceRef`, `AccessList`, `AccessEntry`, `Explain`, `Me`, `Member`, `Client`, `AuthzCatalog` stehen in
  `contract.ts` genau wie in [9.5](#95-zugriff-v1access)–[9.7](#97-break-glass-v1break-glass).
- Wo die App die Bausteine einbindet (Zeilenmenü «Zugriff…», Aktion im Kopf, Feld Vertraulichkeit, «Warum sehe ich
  das?» im Fuss), entscheidet die App; Assets: Konzept 5.2.
- Texte unter `iam.access.*`, `iam.classification.*`, `iam.breakGlass.*`, `iam.members.*` (de/en, Du-Form).

## 12. Maschinen-Clients und MCP

Alle Zugänge laufen über dieselbe Token-Prüfung, denselben Principal und dieselbe Entscheidung; sie unterscheiden sich
nur in Anmeldung, Bindung und Scope-Grenze. Der Baukasten bietet jede Zugangsart als Schalter im Realm-Modul und in der
Konfiguration der App an.

| Zugangsart | Wer | Anmeldung | Token | Organisation | Rechte | Einrichtung |
|---|---|---|---|---|---|---|
| Oberfläche | Person | BFF, Code + PKCE, `private_key_jwt` | bleibt auf dem Server | `organization:*`, Wahl je Tab | Tupel ∧ Vertraulichkeit | Standard |
| API für Personen (Skripte, CLI) | Person | öffentlicher Client, Code + PKCE (Loopback, RFC 8252), DPoP empfohlen | Bearer/DPoP, `aud = <produkt>-api` | `organization:*`, `X-Tenant` | Tupel ∧ Vertraulichkeit ∧ **Scope** | Schalter `person_api`; `azp` in `OIDC_PERSON_CLIENT_IDS`, scope-gebunden. **Neu:** In Assets erreichen Personen die API nur über BFF und MCP; Tokens eines anderen Clients gelten dort als Maschinen-Client |
| Organisations-Client (M2M) | Maschine einer Organisation | Client Credentials, `private_key_jwt` | DPoP Pflicht (mTLS möglich), 5 min, kein Refresh | fester Claim mit einem Alias | Tupel an `org` ∧ Vertraulichkeit ∧ Scope | Realm-Modul `machine_clients` (IaC der App, ohne Rollen); **Freigabe** durch `members:admin` ([12.1](#121-maschinen-clients-muss-sobald-die-api-für-maschinen-offen-ist)) |
| System-Client | Dienst des Betriebs (z. B. Worker eines anderen Produkts, Export, Monitoring) | Client Credentials, `private_key_jwt` | DPoP, 5 min | Claim mit den Aliassen, für die er eingerichtet ist; je Aufruf `X-Tenant`; gilt nur, wo freigegeben | Tupel an `org` ∧ Vertraulichkeit ∧ Scope | im Realm-Modul (`machine_clients` mit mehreren Organisationen), Freigabe je Mandant wie M2M; nie `members:admin` (in keinem Scope) |
| App-zu-App | Dienst von Produkt B ruft API von Produkt A | wie System-Client im Realm von A | wie oben | wie System-Client | wie oben | System-Client in A; B verwahrt nur seinen privaten Schlüssel. Personen-Kontext über Realm-Grenzen nur mit Identity Brokering (offen) |
| MCP | Person über KI-Host | öffentlicher MCP-Client, Code + PKCE; MCP-Dienst tauscht (RFC 8693) | `aud = <produkt>-mcp` → getauscht `<produkt>-api` | `X-Tenant` oder `?org=` | Tupel ∧ Vertraulichkeit ∧ Scope | Schalter `mcp` ([12.2](#122-mcp-dienst-kann)) |
| MCP für Maschinen | Agent ohne Person | Client Credentials an den MCP-Dienst | wie M2M | wie M2M | wie M2M | **offen:** der MCP-Dienst tauscht keine sendergebundenen Tokens und nimmt nur die MCP-Hosts an; `machine_clients` legt deshalb keine Audience `<produkt>-mcp` an, Maschinen nutzen die REST-API |

Regeln für alle Zugänge ausser der Oberfläche: Scope-Grenze (`scopeBound`), keine Rechte ohne Scope
(`members:admin`, `access:admin` nie; Rechteverwaltung über MCP und M2M gibt es nicht), Audit mit Client und Person, Ratenbegrenzung je Mandant und Principal, Tokens höchstens 5 min.

### 12.1 Maschinen-Clients (MUSS, sobald die API für Maschinen offen ist)

- OAuth 2 Client Credentials, ein Keycloak-Client je Integration und Organisation, `private_key_jwt` (Client-Geheimnis
  nur übergangsweise), DPoP-gebundene Tokens (alternativ mTLS), Access Token 5 min, keine Refresh-Tokens.
- Einrichtung als Code im Repository der App: Eingabe `machine_clients` des Realm-Moduls mit Organisationen, Scopes
  und öffentlichem Schlüssel, **ohne Rollen** (Rollen sind Tupel, O4). Das Modul legt an: Service Account, *DPoP bound
  access tokens*, Audience `<produkt>-api`, Hardcoded-Claim `organization = ["<alias>", …]` (JSON), Rechte-Scopes als
  Standard-Scopes, Attribute `<produkt>.platform = true`, `<produkt>.m2m = true`. Freigegeben wird über Plan →
  Freigabe → Apply wie der übrige Realm.
- **Danach Freigabe** durch die Verwaltung der Organisation (`members:admin`) in der App: Rollen an `org`
  (`PUT /v1/admin/clients/{clientId}`, [9.6](#96-mitglieder-und-clients)), die Tupel `client:<id> <rolle> org` ergeben;
  ohne Tupel 403. Ein falscher Mapper öffnet so keine fremde Organisation. Freigaben an einzelnen Orten erhalten
  Clients nicht (A3).
- Die App legt Maschinen-Clients zur Laufzeit nicht selbst an: dafür bräuchte `<produkt>-admin` `manage-clients` bzw.
  `create-client`, womit sich beliebige Mapper (fremde Organisation, `platform-admin`) setzen liessen. Angelegt werden sie
  deshalb nur über das Realm-Modul (`<produkt>-iac`, Code-Review und Freigabe).

### 12.2 MCP-Dienst (KANN)

Referenz: assets `src/platform/mcp/*`, `docs/mcp.md`.

- Eigener Prozess, Streamable HTTP, Protected Resource Metadata (RFC 9728), Keycloak als Authorization Server.
- `<produkt>-mcp` (vertraulich, `private_key_jwt`): Standard Token Exchange (RFC 8693) des MCP-Tokens gegen ein Token mit
  Zielgruppe `<produkt>-api`, ohne Refresh-Token im Exchange; die Person bleibt erhalten, Rechte werden nie erweitert;
  `organization:<alias>` bleibt im Tausch erhalten.
- `<produkt>-mcp-cli` (öffentlich, Code + PKCE, Loopback-Weiterleitungen RFC 8252, feste Port-Weiterleitung, weitere
  Hosts wie `https://claude.ai/api/mcp/auth_callback`), Scope `<produkt>-mcp` mit Zielgruppe `<produkt>-mcp`,
  `organization` als Standard-Scope, `offline_access` und Rechte-Scopes optional.
- Zugriffe über MCP sind `scopeBound`; Organisation über `X-Tenant` oder `?org=`, ohne Wahl Fehler -32602 mit der
  eigenen Liste. Nur MCP-Hosts aus `MCP_HOST_CLIENT_IDS`. Zwischenspeicher mit Schlüssel Token + Mandant.

## 13. Konfiguration und Geheimnisse

Nur Umgebungsvariablen; Geheimnisse auch als `…_FILE`. Referenz: assets `src/platform/config/env.ts`,
`docs/konfiguration.md`.

| Variable | Standard | Zweck |
|---|---|---|
| `PUBLIC_BASE_URL` | — | Adresse der Oberfläche (Redirects) |
| `OIDC_ISSUER_URL` | — | `https://identity.project-suite.ch/realms/<produkt>` |
| `OIDC_API_AUDIENCE` | `<produkt>-api` | erwartete Zielgruppe |
| `OIDC_CLOCK_TOLERANCE` | `30s` | |
| `OIDC_BFF_CLIENT_ID` | `<produkt>-platform` | |
| `OIDC_BFF_PRIVATE_KEY` (geheim) | — | `private_key_jwt` des BFF (Vorrang vor `OIDC_BFF_CLIENT_SECRET`) |
| `OIDC_SCOPES` | `openid profile email organization` | |
| `OIDC_PERSON_CLIENT_IDS` | BFF + MCP | `azp`, deren Tokens als Person gelten |
| `TENANT_CLAIM` | `organization` | |
| `TENANT_AUTO_PROVISION` | `true` | |
| `GROUPS_CLAIM` | `groups` | Gruppen aus Entra ID (Objekt-IDs) als Subjekte `group:<entra-object-id>` |
| `PLATFORM_ADMIN_ROLE` | `platform-admin` | |
| `KEYCLOAK_MGMT_CLIENT_ID` | — | `<produkt>-admin`; leer = Verwaltung aus |
| `KEYCLOAK_MGMT_PRIVATE_KEY` (geheim) | — | nur API |
| `KEYCLOAK_MGMT_URL` | aus Issuer | Admin-API, falls abweichend |
| `KEYCLOAK_MGMT_INVITE_LIFESPAN` | `72h` | 1 h bis 30 d |
| `KEYCLOAK_MGMT_INVITE_MIN_TIME` | `2s` | gleiche Antwortzeit beim Einladen |
| `KEYCLOAK_MGMT_TIMEOUT` | `10s` | |
| `KEYCLOAK_SYNC_CLIENT_ID` | — | `<produkt>-sync`; leer = kein Abgleich im Worker |
| `KEYCLOAK_SYNC_PRIVATE_KEY` (geheim) | — | nur Worker |
| `MEMBER_SYNC_INTERVAL` | `1h` | `0` = aus, sonst ≥ 1 min |
| `DPOP_MODE` | `required-for-clients` | `off` \| `optional` \| `required-for-clients` \| `required` |
| `DPOP_MAX_AGE` | `300s` | |
| `MTLS_HEADER` | — | aktiviert mTLS-gebundene Tokens |
| `SESSION_SECRET` (geheim) | — | Pflicht in Produktion (API), ≥ 32 Zeichen, Rotation kommagetrennt |
| `SESSION_TTL`, `SESSION_IDLE_TIMEOUT` | `8h`, `60m` | |
| `ENCRYPTION_KEYS` (geheim) | — | `id:base64(32 Bytes)`, kommagetrennt, erster verschlüsselt; Pflicht in Produktion |
| `SHARED_STATE` | — | `postgres` bei mehreren Instanzen (Replay-Schutz, Ratenbegrenzung) |
| `RATE_LIMIT_NAMESPACE` | — | Vorsatz der Rate-Limit-Schlüssel (`<namespace>:<produkt>:…`), wenn Umgebungen einen Speicher teilen |
| `DATABASE_URL`, `DATABASE_ADMIN_URL`, `DATABASE_WORKER_URL` (geheim) | — | Laufzeit, Besitzer (Migrationen), Worker ([10.1](#101-rollen)) |
| `MCP_CLIENT_ID`, `MCP_PRIVATE_KEY` (geheim), `MCP_HOST_CLIENT_IDS`, `OIDC_MCP_AUDIENCE` | `<produkt>-mcp`, —, —, `<produkt>-mcp` | MCP-Dienst ([12.2](#122-mcp-dienst-kann)) |
| `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` (geheim), `ENTRA_IDP_SLOTS`, `ENTRA_UI_PATH` | —, —, `100`, `/verwalten/anmeldung` | App der Plattform für Entra ID, optional ([9.4](#94-anmeldung-über-den-idp-der-organisation-kann)); eigene Apps der Organisationen brauchen nur `ENCRYPTION_KEYS`; `ENTRA_UI_PATH` = `paths.entra` der Oberfläche |

Zu jedem `…_PRIVATE_KEY` gibt es übergangsweise `…_CLIENT_SECRET`; dann warnt der Dienst beim Start (P3). Alle
Geheimnisse auch als `…_FILE`.

**Geheimnisse je Dienst** (jeder Dienst erhält nur seine, und nur er verlangt sie):

| Geheimnis | API | Worker | MCP | IaC |
|---|:-:|:-:|:-:|:-:|
| BFF-Schlüssel, `SESSION_SECRET` | ✓ | | | |
| `<produkt>-admin`-Schlüssel | ✓ | | | |
| `<produkt>-sync`-Schlüssel | | ✓ | | |
| `<produkt>-mcp`-Schlüssel | | | ✓ | |
| `ENCRYPTION_KEYS` | ✓ | ✓ | | |
| `<produkt>-iac`-Schlüssel | | | | GitHub-Secret + lokale `.env` |
| `<produkt>-tofu`-Schlüssel | | | | nur lokal (Tresor) |

Schlüssel erzeugen: EC P-256 (`openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256`), öffentlicher Teil als
JWKS (`kid` = JWK-Thumbprint) in `infra/keycloak/keys/<client>.json`, privater verschlüsselt (sops/age). Wechsel:
neues Paar, `keys/<client>.json` ersetzen, `kc.sh apply`, Deploy.

## 14. Mandantentrennung und Tests

Oberstes Ziel: **Eine Organisation sieht weder Daten noch Personen einer anderen Organisation – und erfährt auch
nichts über sie** (nicht über Fehlermeldungen, Zähler, Antwortzeiten, Verwaltungsantworten oder Tokens).
Bedrohungsmodell und Inventar: assets `docs/mandantentrennung.md`; das Produkt führt ein eigenes Inventar nach
demselben Muster (Weg · was preisgegeben werden könnte · Schutz · Test · Befund).

| Angreifer | Grenze |
|---|---|
| Person in Organisation B (auch org-admin) | Mandant nur aus dem Token; `X-Tenant` nur innerhalb der eigenen Organisationen |
| Person in A und B | Tupel, Principal, Freigabestufe, Caches, Idempotenz je Mandant; Gruppen aus dem Token zählen nur über Tupel des gewählten Mandanten |
| Maschinen-Client | Tupel `client:<id> <rolle> org` je Mandant (Freigabe) |
| Ehemaliges Mitglied | Token nach dem Austritt ausgestellt; BFF verwirft die Organisation beim Erneuern |
| Unangemeldete Dritte | gleiche Antwort und gleicher Aufwand für unbekannt und fremd |
| Fehlkonfiguration in Keycloak | eigener Realm, Prüfung fremder Clients, Client-Richtlinien |

Pflichttests (Kit: `packages/*/test`, Konformität über `@vollholz/iam-testkit`; App: `test/*`):

| Test | Prüft |
|---|---|
| `tenant-isolation` | **jede** `/v1`-Route (aus der Routenliste, `onRoute`) mit IDs von A als B, auch `/v1/access…` (Tupel-IDs, Orte, Subjekte von A), `/v1/admin/clients`, `/v1/break-glass`: Antwort wie für eine unbekannte ID, ohne Merkmale von A; Listen, Suche, Zähler; keine Route ohne Eintrag (kein leeres Grün) |
| `multi-org` | Person in A und B: Rollen (Tupel) nur der gewählten Organisation, Gruppen, Freigaben, Freigabestufe, Break-Glass nur in A, Wahl, Austritt, Client-Freigabe, Alias neu vergeben |
| `rls` | jede Tabelle mit `tenant_id` hat FORCE RLS und `tenant_isolation` (auch `authz_tuple`); kein PUBLIC-EXECUTE (auch Funktionen der Lesesicht, mit `read_person`, `write_person`); fremder Mandant sieht nichts |
| `model` | `checkModel`: Regeln M1–M12 ([7.3](#73-modell-der-app-definemodel)), reservierte Namen ([8.1](#81-reservierte-namen)), `platform.json` = `model.platformJson()` |
| `access` | Entscheidung nach [7.5](#75-entscheidung): Rolle an `org`, am Ort, Vererbung über `parent` und `self`, Blatt-Tupel (nur Rollen mit `read`, nie `member`); Gruppen-Subjekte aus `entra_groups`; Zuständigkeit (`grants` read/edit, `inherits_scope`, Tiefe 16, Kreis); Zuständigkeit über Personen (`edges.persons`: read/edit, none, andere Person, Client, nur an der Ressource, `personGrants` für irgendwo; Test-Kit `personCases`); Besitz; Klassifizierung (auch `org-admin` scheitert); Break-Glass (Stufe, Ende, Ablauf); Ablauf von Tupeln (zählt nicht, Aufräumen, `access.expired`); Scope-Grenze für jeden Weg; Client ohne Tupel an `org` → 403; `canSomewhere`; Zwischenspeicher nach `acl_version` |
| `read-view` | Lesesicht = `can`: für ein Modell mit allen Wegen liefert eine Liste unter RLS genau die Ressourcen mit `can(read)`, Schreiben unter `WITH CHECK` genau die mit `can(write)` – auch für `scopeBound` (Tupel, Zuständigkeit über Einheiten und über Personen, `org` ohne passenden Scope ergeben nichts) |
| `access-http` | Formen aus [9.5](#95-zugriff-v1access); Regeln [9.1](#91-regeln) Nr. 5–7: niemand gibt mehr, als er hat (POST, PATCH, DELETE, Mitglieder, Clients, Freigabestufe nie für sich selbst), `org-admin` nur `platform-admin`, letzter Admin, Duplikat, 422 je Feld; 404 für nicht lesbare Ressourcen; `explain` gibt für andere nur mit `access:read` Auskunft; Zuständigkeit über Personen als `via: 'data'` (nicht entfernbar) in «Wer hat Zugriff?» und «Warum?» |
| `admin` | Regeln aus [9.1](#91-regeln) inkl. gleicher Antwort beim Einladen, Clients in der Liste, Tupel beim Entfernen gelöscht, Audit `…_failed` |
| `break-glass` | nur Personen mit `org-admin`, 1–240 min, Neubeginn, Ende, Banner-Daten in `/auth/me`, Audit |
| `auth` / `unit` | Token-Prüfung (Typ, Bindung, DPoP, mTLS), Person/Client, Alias ASCII, Subjekte aus dem Token |
| `bff` | Code-Flow, Fixation, `returnTo`, CSRF, Erneuerung parallel, Austritt, Backchannel-Logout, Wechsel, `/auth/me` nach 9.5 |
| `capabilities` | `can` je Ressource, ETag mit Zugriffsstand |
| `infra-keycloak` / Modul | keine Client-Rollen, keine Gruppe `/orgs`, kein Rollen-Mapper, keine FGAP-Gruppenrechte; Attribut `entra_groups` im User-Profile, Mapper Attribut → Claim `groups`; Scopes aus `platform.json`; Lokalisierung (Schlüssel, Platzhalter, Du-Form); `kc.sh plan` «No changes» |
| Oberfläche | Typ `Permission` = Katalog; Organisation je Tab; `AccessSheet`, `GrantDialog` (nur `grantable`), `WhyDialog`, `ClassificationBadge`, `BreakGlassBanner`, `Members` (Personen und Clients, Freigabestufe, Orte), `RightsOverview` (Status `role`/`place`/`scope`); 390 px, hell/dunkel, axe ohne serious/critical |
| E2E | Anmeldung, Einladen, Rollen, Freigabe am Ort und am Blatt, Zuständigkeit, Klassifizierung, Break-Glass, Organisation je Tab (gegen lokalen Keycloak) |

Für Tests ohne echten Keycloak eine Nachbildung der Admin-API (Referenz `test/platform/keycloak-fake.ts`); für
Entwicklung `npm run dev:setup` (PostgreSQL und Keycloak in Docker, `scripts/keycloak-setup.ts` mit Demo-Organisationen
und Testpersonen).

## 15. Baukasten und Ausrollen

Der Baukasten liegt in diesem Repository (vollholz/identity-kit) und wird aus vollholz/assets herausgelöst; Assets ist danach das erste Produkt, das ihn nutzt. Jede neue App
bindet ihn ein, statt Code zu kopieren. Referenz bleibt Assets, bis der Baukasten dieselben Tests besteht.

### 15.1 Bestandteile

| Teil | Inhalt | Kapitel |
|---|---|---|
| **Vertrag** (sprachneutral) | Claims, Header (`X-Tenant`, `X-CSRF-Token`, `DPoP`), Endpunkte `/auth/*`, `/v1/me`, `/v1/authz/catalog`, `/v1/access…`, `/v1/admin/*`, `/v1/break-glass`, `/v1/platform/*`, Fehlerformat (RFC 9457) und Texte, JSON-Schema des Katalogs, Modell (`defineModel`), Datenbankschema des IAM mit `authz_tuple` und Lesesicht | 4–11 |
| **OpenTofu-Modul** `product-realm` | Realm-Soll aus [Kapitel 3](#3-realm-des-produkts); Eingaben: `product`, `display_name`, `public_base_url`, `catalog` (`platform.json`, nur Scopes), `theme_texts`, `smtp`, Schalter `mcp`, `m2m`, `entra`, Maschinen-Clients `machine_clients` (ohne Rollen; später `person_api`, B4), `standard_texts` des Baukastens; dazu das Bootstrap-Modul `product-realm-bootstrap`. `kc.sh` und der `import`-Block gehören in die Vorlage | 2, 3 |
| **Backend-Paket** `@vollholz/iam` (Node 24, TypeScript, Fastify-Adapter) | Konfiguration, Token-Prüfung, Principal, BFF, `defineModel`, Tupel, Entscheidung, Lesesicht, `explain`/`whoHasAccess`, Verwaltung (Mitglieder, Clients, Freigaben, Freigabestufe), Break-Glass, Abgleich und Aufräumen (Worker-Job), MCP-Token-Austausch, Audit-Schnittstelle, SQL-Migrationen des IAM | 5–7, 9, 10, 12 |
| **Frontend-Paket** `@vollholz/iam-web` (React) | Sitzung und `/auth/me`, Organisation je Tab, `useAuthz()`, `useResourceCan()`, `MissingRight`, Routen-Guard, Rechte-Übersicht, Rollenmatrix, «Meine Rechte», `AccessSheet`, `GrantDialog`, `WhyDialog`, `ClassificationBadge`, `BreakGlassBanner`, Verwalten › Zugang (Mitglieder mit Clients, Anmeldung), Organisationen | 11 |
| **Test-Kit** `@vollholz/iam-testkit` | Wegwerf-Datenbank, Keycloak-Nachbildung, Testpersonen, Prüfung fremder Clients im Realm, Isolations-Durchlauf über die Routenliste, RLS-Prüfung, Modellprüfung (`checkModel`), Standardfälle der Entscheidung, Konformitätstests des Vertrags (auch für Apps in anderen Sprachen) | 14 |
| **Vorlage** `create-iam-app` | legt in einer App `infra/keycloak` (Modulaufruf), Modell-Gerüst (`authz/model.ts`, Stufe «einfach»), Migration, Konfiguration, Workflow `keycloak.yml`, Doku-Gerüst (Inventar der Mandantentrennung) an | 2, 15.3 |

### 15.2 Schnittstelle zur App

**Wo was liegt.** Keycloak kennt nur, was es für Anmeldung und Tokens braucht; alles Übrige führt die App (D6).

| Was | Definiert in | Angelegt bzw. geführt | Wann | Wer ändert |
|---|---|---|---|---|
| Rechte (`note:read` …) | Modell der App (Code) | nur in der App | mit jedem Release | Entwicklung (Code-Review) |
| Rollen (Definition) | Modell der App | nur in der App; nie in Keycloak | mit jedem Release | Entwicklung |
| Typen, Kette, Rollen je Ort | Modell der App | nur in der App; CHECKs von `authz_tuple` über `syncModelChecks` | mit jedem Release | Entwicklung |
| Scopes | Modell der App | Client-Scopes im Realm, über das Realm-Modul aus `platform.json` | `kc.sh apply` bzw. Workflow «Keycloak» nach dem Release | Entwicklung |
| Rollen an der Organisation (Personen, Clients) | – | Tupel an `org` in `authz_tuple` | zur Laufzeit | `members:admin`; `org-admin` nur `platform-admin` |
| Freigaben an Orten | – | Tupel in `authz_tuple` | zur Laufzeit | `access:admin` am Ort, nie mehr als die eigenen Rechte |
| Zuständigkeit (Kanten) | Fachmodell der App | Tabellen der App, gelesen über `ResourceModel.edges` | zur Laufzeit | Personen mit den Fachrechten |
| Freigabestufe | – | `principal.clearance` | zur Laufzeit | `members:admin`; Break-Glass `org-admin` |
| Maschinen-Clients (Konto, Scopes, Organisationen) | Repository der App | Realm-Modul `machine_clients` | mit dem Realm-Plan | Entwicklung bzw. Betrieb (Code-Review, Freigabe); Rollen über `/v1/admin/clients` |
| Organisationen, Mitgliedschaften, Konten | – | Keycloak; Spiegel in `tenant` und `principal` | zur Laufzeit | Plattform-Administration bzw. `members:admin` in der App |
| Gruppen aus Entra | IdP der Organisation | IdP-Mapper → Attribut `entra_groups` → Claim `groups`, nur als Subjekt `group:<entra-object-id>` | mit dem Token | Kunden-IT in Entra |
| Ressourcen | Fachmodell der App | nur in der Datenbank der App | zur Laufzeit | Personen mit den Rechten |

Folgerungen:

- Die App legt zur Laufzeit **nichts** an Rollen, Gruppen, Scopes oder Clients in Keycloak an; sie verwaltet nur
  Mitgliedschaften, Konten (Einladung), Organisationen und – mit Entra ID – Identity Provider der Organisationen.
- Keycloak Authorization Services werden **nicht** verwendet: Ressourcen sind zahlreich, fachlich und mandantengebunden;
  sie gehören in die Datenbank unter RLS. Keycloak bleibt Aussteller der Identität, die Entscheidung trifft die App.
- Eine Rolle aus dem Modell entfernen: zuerst ihre Tupel löschen, dann das Release ([8.2](#82-regeln-für-das-modell)).

Die App liefert genau ihre lokalen Teile ([1.1](#11-standard-und-app-lokal)):

```ts
// src/authz/model.ts – einzige Quelle; daraus platform.json, CHECKs, Typen und GET /v1/authz/catalog
export const model = defineModel({
  product: 'notes',
  permissions: { 'note:read': { label: 'Notizen lesen', group: 'notes', description: '…', resources: ['org', 'folder', 'note'] }, … },
  groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }],          // reservierte Gruppen ergänzt der Baukasten
  roles: { editor: { label: 'Bearbeiter:in', description: '…', permissions: ['tenant:read', 'note:read', 'note:write', 'access:admin'] }, … },
  scopes: { 'notes:read': { text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] }, … },
  types: {
    folder: { label: 'Ordner', parent: 'org', roles: ['editor', 'viewer'], read: 'note:read' },
    note:   { label: 'Notiz', parent: 'folder', roles: ['editor', 'viewer'], leaf: true, read: 'note:read', write: 'note:write' },
  },
});

// Kette der Ressourcen (7.7)
export const resources: ResourceModel = { chain: (state, ref) => …, exists: async (tx, ref) => … };

// Backend: Kern ohne Fastify (Worker, MCP-Dienst, Tests), dann das Plugin
const iam = createIam({ model, resources, db, audit, config: process.env });
await app.register(iamPlugin, { iam });   // /auth/*, /v1/me, /v1/authz/*, /v1/access*, /v1/people, /v1/admin/*, /v1/break-glass, /v1/platform/*
app.get('/v1/notes/:id', { preHandler: iam.need('note:read', r => ({ type: 'note', id: r.params.id })) }, …);

// Frontend (Aussehen über CSS-Variablen --iam-* aus den Design-Tokens der App)
<IamProvider texts={texts} features={{ entra: true }} resources={{ useResolver, open }}><App /></IamProvider>
<AccessSheet resource={{ type: 'folder', id }} label={folder.name} open={open} onClose={close} />
```

- `defineModel` prüft beim Start und im Test die Regeln aus [7.3](#73-modell-der-app-definemodel) und [Kapitel 8](#8-modell-des-produkts)
  und ergänzt die reservierten Namen; `org-admin` erhält automatisch alle Rechte.
- Design: Die Frontend-Bausteine bringen kein eigenes Aussehen mit, nur Struktur und Verhalten; sie nutzen
  CSS-Variablen (`--iam-accent`, `--iam-surface`, `--iam-text`, `--iam-radius`, …), die die App aus ihren Design-Tokens
  setzt (Vorgaben des Pakets in `@layer iam`, damit die Werte der App immer gewinnen), und optional eigene Komponenten für Knopf, Dialog, Tabelle, Menü (`components`-Prop).
- Texte: Baukasten-Texte de/en mit Schlüsseln (`iam.*`); die App überschreibt einzelne Schlüssel und liefert weitere
  Sprachen. Labels des Modells kommen je Sprache: `GET /v1/authz/catalog` richtet sich nach `Accept-Language`
  (`Vary: Accept-Language`), die Oberfläche nimmt die Sprache in den Cache-Schlüssel.
- Apps in anderen Sprachen (nicht Node): Vertrag und Realm-Modul gelten unverändert; Backend nach Kapitel 5–10 selbst
  umsetzen und mit den Konformitätstests des Test-Kits gegen die laufende App abnehmen. KANN später: BFF und
  Token-Prüfung als eigener Dienst (Sidecar) vor der App.

### 15.3 Ausrollen

1. **Anbindung** an identity ([Kapitel 2](#2-anbindung-an-die-identity-plattform), Schritte 1–2, 5).
2. `npx create-iam-app` im Repository der App: Gerüst nach 15.1; danach Modell und Ressourcen füllen.
3. Realm: Bootstrap und `kc.sh apply` mit dem Modul (Schritte 3–6).
4. Pakete einbinden (Backend, Frontend), Migration ausführen, Konfiguration und Geheimnisse ([Kapitel 13](#13-konfiguration-und-geheimnisse)).
5. Erste Organisation mit `iam-org-bootstrap` (im Backend-Paket enthalten): Keycloak und, mit `DATABASE_ADMIN_URL`,
   Principal, Tupel `org-admin` und Freigabestufe 2 in der Datenbank der App (A20). Zurücksetzen und neu aufsetzen:
   `iam-reset`, dann `iam-org-bootstrap --file` ([Kommandozeilen](#21-kommandozeilen)).
6. Abnahme ([Kapitel 16](#16-abnahme)) mit dem Test-Kit.

Versionierung und Pflege:

- Semantische Versionen je Paket und Modul; der Workflow «Release» veröffentlicht nach dem Merge jede neue Version
  (Tag `<paket>-v<version>`). Apps pinnen die Version; Renovate schlägt Updates vor. Brechende Änderungen nur mit
  Migrationshinweis. Einbinden und Bezug ohne Zugang: `docs/ausrollen.md`.
- Datenbank-Migrationen des IAM liefert das Backend-Paket mit eigenem Präfix (`iam_…`); der Migrations-Runner der App
  führt sie vor den eigenen aus; danach `app.secure_tenant_tables()`.
- Das Realm-Modul ist idempotent; ein Update ergibt einen Plan, der vor dem Apply freigegeben wird.
- Sicherheitsupdates (Keycloak, Abhängigkeiten, Befunde der Mandantentrennung) zuerst im Baukasten, dann in allen
  Apps; die Liste der Apps und ihrer Version steht in identity `infra/keycloak/production.tfvars › products`.

### 15.4 Herauslösen aus Assets

| Teil | Aus vollholz/assets | Ziel |
|---|---|---|
| Realm | `infra/keycloak/*.tf`, `org-mapper.ts`, `lookup.ts`, `bootstrap/`, `kc.sh` | Modul `product-realm`, `product-realm-bootstrap`; Assets ruft das Modul auf (`moved`-Blöcke, damit nichts neu angelegt wird) |
| Anmeldung | `src/platform/auth/*`, `modules/auth/*` | `@vollholz/iam` |
| Rechte | `src/platform/authz/{access,capabilities}.ts`, Mechanik aus `permissions.ts` | `@vollholz/iam`; Katalog von Assets bleibt in Assets |
| Verwaltung | `src/platform/modules/admin/*`, `ops/tenants.ts`, `worker/member-sync.ts`, `scripts/{keycloak-setup,org-bootstrap}.ts`, `scripts/lib/system-clients.ts` | `@vollholz/iam` |
| Datenbank | IAM-Teile aus `001`, `006`, `016`, `020`, `043`, `045` | Migrationen `iam_…`; Assets übernimmt sie als bereits angewendet |
| Oberfläche | `web/src/auth/*`, `shell/{UserMenu,MyRights}.tsx`, `ui/{MissingRight,RightsOverview,RoleMatrix,AdminHead,MenuButton,org}.tsx`, `features/{admin,acl}/*` | `@vollholz/iam-web` |
| Tests | `test/platform/{auth,bff,admin,authz,capabilities,multi-org,rls,tenant-isolation}.test.ts`, `keycloak-fake.ts`, `harness.ts` | `@vollholz/iam-testkit` |

Reihenfolge: Vertrag festschreiben → Test-Kit (gegen Assets grün) → Backend-Paket → Realm-Modul → Frontend-Paket →
Vorlage → erste neue App. Nach jedem Schritt läuft Assets auf dem Baukasten, und alle Tests von Assets bleiben grün.

## 16. Abnahme

Ein Prüfpunkt gilt als erfüllt, wenn sein Kriterium nachweisbar (Test, Screenshot oder Codestelle) erfüllt ist.

| # | Prüfpunkt | Kriterium |
|---|---|---|
| P1 | Anbindung | `<produkt>-tofu` nur mit `create-realm`, Schlüssel nicht in GitHub; `<produkt>-iac` mit `realm-admin`; zweiter Plan «No changes» (Umstellung: erster Plan nur Verschiebungen); Workflow mit zwei Freigaben |
| P2 | Realm | Einstellungen, Richtlinien, Clients, Mapper, Scopes nach Kapitel 3 (keine Rollen, keine Rollengruppen); Login, Konto und E-Mails im Theme `identity` mit Name, Claim und Akzent des Produkts |
| P3 | Keine Geheimnisse | alle vertraulichen Clients `private_key_jwt`; kein Client-Geheimnis im State; jeder Dienst nur seine Schlüssel |
| P4 | Anmeldung | Code-Flow mit PKCE, keine Tokens im Browser, CSRF, Fixation, Erneuerung, RP- und Backchannel-Logout, `/abgemeldet` |
| P5 | Mandant | nur aus dem Token; `X-Tenant` nur eigene; Bindung an `kc_org_id`; gesperrt → 403; Alias ASCII |
| P6 | Mehrere Organisationen | `organization:*`, Organisation je Tab, Wechsel ohne Anmeldung, Tupel nur der gewählten Organisation |
| P7 | Rechte | Regeln [7.5](#75-entscheidung) mit Tests (`access`); keine Ausnahme für `org-admin`; Lesesicht = `can` (Test `read-view`); Klassifizierung und Break-Glass; Wirkungszeiten; 403 mit Label; `can` je Ressource; «Warum?» und «Wer hat Zugriff?» |
| P8 | Eine Quelle | `defineModel` mit Regeln M1–M12; `GET /v1/authz/catalog`; Oberfläche ohne eigene Listen (Test); `platform.json` aktuell (Test); CHECKs aus `syncModelChecks` |
| P9 | Verwaltung | Regeln 9.1 (1–13) mit Tests; Einladen gleich für neu und bestehend inkl. Antwortzeit |
| P9a | Freigaben | Endpunkte [9.5](#95-zugriff-v1access)–[9.7](#97-break-glass-v1break-glass) mit Tests, insbesondere «niemand gibt mehr, als er hat», `org-admin` nur `platform-admin`, letzter Admin, Audit [9.8](#98-audit-aktionen) |
| P10 | Abgleich | Worker mit `<produkt>-sync`, `removed_at`, Alias und `kc_org_id` |
| P11 | Datenbank | Rollen ohne `BYPASSRLS`, FORCE RLS auf allen Tabellen mit `tenant_id` (Test), zusammengesetzte Fremdschlüssel |
| P12 | Oberfläche | `MissingRight`, Routen-Guards, «Meine Rechte», Rollenmatrix, Bausteine aus [11.4](#114-bausteine-und-schnittstelle-zur-app), Verwalten-Seiten nach Muster; Begriffe nach 7.2; 390 px, hell/dunkel, axe |
| P13 | Maschinen-Clients | DPoP-Pflicht über `<produkt>.m2m`, Freigabe = Tupel an `org` je Mandant, ohne Freigabe 403 |
| P14 | Isolation | Routen-Durchlauf über alle `/v1`-Routen grün, Inventar der Mandantentrennung vollständig |
| P15 | Baukasten | App nutzt Modul und Pakete in einer gepinnten Version, ohne Kopien; lokal nur Modell, Ressourcen, Policies, Design-Tokens, Texte; Konformitätstests des Test-Kits grün |

## 17. Grenzen und Restrisiken

Übernommen aus vollholz/assets und vollholz/identity; gelten für jedes Produkt, bis sie eigens entschieden werden.

| Thema | Grenze bzw. Restrisiko | Umgang |
|---|---|---|
| `manage-realm` der Service Accounts | Keycloak 26 kennt keine Rechte je Organisation; wer den Schlüssel von `-admin` hat, beherrscht faktisch den Realm des Produkts (nicht andere Realms) | eigener Realm, Schlüssel nur im API-Prozess, kurze Tokens, Admin-Ereignisse, Audit der App; Admin-Ereignisse ausserhalb `organizations`, `users`, `groups` überwachen; ersetzen, sobald FGAP v2 Organisationen kennt |
| `create-realm` von `<produkt>-tofu` | fast Realm-Admin am eigenen Realm, dauerhaft; kann weitere Realms anlegen | Schlüssel nur lokal, Admin-Ereignisse im Realm `master` (identity) |
| `/admin` und `/realms/master` öffentlich | Abweichung von der Empfehlung von Keycloak, nötig für IaC aus GitHub Actions | identity › Bewusste Restrisiken |
| Zwischenspeicher | Entfernen einer Person wirkt nach ≤ 5 min, Gruppen aus Entra mit dem nächsten Token; Tupel sofort (`acl_version`) | kurze Laufzeiten; neue Tokens nach dem Austritt nötig |
| Einladungen an bestehende Konten | Link von Keycloak lässt sich nicht widerrufen; Annahme nach Rückzug ergibt Mitglied ohne Rollen | Verwaltung kann entfernen |
| Gruppen aus Entra | mehr als 200 Gruppen: Entra liefert keinen `groups`-Claim (Überlauf) | O1 in authz-offene-punkte.md |
| Break-Glass | `org-admin` kann sich jederzeit selbst bis 240 min auf Stufe 2 heben | Begründung Pflicht, Audit, Banner; Protokoll-Filter «Zugriff» |
| Maschinen-Clients | nur als Code über das Realm-Modul (`machine_clients`), nicht zur Laufzeit aus der App | Freigabe in der App; Review des Repositorys |
| Sicherheitsfunktionen der Datenbank | `resolve_tenant` und Plattform-Funktionen für die ganze Laufzeit-Rolle ausführbar (Schutz in der API) | kein beliebiges SQL (SQL-Injection geprüft); eigene Rolle als offener Punkt |
| Organisation löschen | Alias könnte neu vergeben werden | sperren statt löschen; Bindung an `kc_org_id` |
| Erste Anmeldung | Bindung einer leeren `kc_org_id` beim ersten Kontakt | bewusst (assets E11) |

### Offene Entscheide zum Baukasten

| # | Frage | Vorschlag |
|---|---|---|
| B1 | Wo liegt der Baukasten? | **entschieden 2026-10-22:** eigenes Repository `vollholz/identity-kit` (Vertrag, Modul, Pakete, Test-Kit, Vorlage); vollholz/identity bleibt Betrieb der Instanz und verweist darauf |
| B2 | Verteilung | **entschieden 2026-10-22:** npm-Pakete über GitHub Packages (`@vollholz/*`), Modul als Git-Quelle mit Tag (`?ref=<modul>-vX.Y.Z`) |
| B3 | Frameworks | Backend zuerst nur Fastify, Frontend nur React; weitere Adapter erst bei Bedarf |
| B4 | Zugänge neu gegenüber Assets | REST-API, Organisations-Clients (M2M, DPoP, Freigabe) und MCP gibt es in Assets bereits und gehen unverändert in den Baukasten. Neu ist nur noch `person_api` (Personen direkt an der API, ohne BFF/MCP), erst mit der ersten App, die ihn braucht. **Umgesetzt 2026-10-23:** Maschinen-Clients als Code (`machine_clients` in `product-realm` 0.2.0) für eine Organisation (Organisations-Client) oder mehrere (System-Client) |
| A1 | Lese- und Schreibrecht je Typ | **entschieden 2026-10-23:** `TypeDef.read`/`write` (7.3, M7); `app.read_relations()`/`write_relations()` je Anfrage aus Modell ∩ Scope (7.6) |
| A2 | Mehrere Blatt-Typen | **entschieden 2026-10-23:** höchstens einer je Modell (M6) |
| A3 | Clients an Orten | **entschieden 2026-10-23:** Tupel `client:` nur an `org`, nur über `/v1/admin/clients` (CHECK, 422) |
| A4 | Gruppen aus Entra | **entschieden 2026-10-23:** Subjekt `group:<entra-object-id>`; Mapper `groups` entfällt, neu `entra-groups` (3.4, 3.5); Auswahl im `GrantDialog` über die Graph-Anbindung, nur mit Entra-Verbindung (`GET /v1/access/groups`), Name aus Graph zwischengespeichert; keine Kollision (eine Verbindung je Organisation). Überlauf: O1 |
| A5 | `org:members` | **entschieden 2026-10-23:** nur Personen, nicht Clients |
| A6 | Relation `member` | **entschieden 2026-10-23:** einzige Beziehung ohne Rechte (`types[].relations`) |
| A7 | Relation `owner` | **entschieden 2026-10-23:** setzt die App beim Anlegen; nicht über `/v1/access`; kein Übertragen (O6); «Für alle Mitglieder» = `org:members` mit `membersRole` des Typs (Standard `viewer`, D10) |
| A8 | Aufräumen | **entschieden 2026-10-23:** im Worker mit dem Abgleich; Ablauf eines Break-Glass als `break_glass.ended` mit `expired: true` |
| A9 | Plattform-Administration | **entschieden 2026-10-23:** von «niemand gibt mehr, als er hat» ausgenommen; die Regel gilt auch für Entziehen und Ablauf |
| A10 | Lesesicht weiterer Typen | **entschieden 2026-10-23:** `app.write_all()`, `app.read_all_of(permission)`, `app.relations_of(permission)` |
| A11 | `ResourceModel` | **entschieden 2026-10-23:** `load`/`version` und synchrone `chain` bleiben; `classification()` neu; `version` folgt den Fachdaten |
| A12 | Klassifizieren | **entschieden 2026-10-23:** Stufe ≥ neue und bisherige |
| A13 | Recht zum Lesen des Panels | **entschieden 2026-10-23:** kein neues Recht. «Wer hat Zugriff?» mit dem Leserecht der Ressource; «Warum?» für sich selbst immer, für andere und Ändern nur mit `access:admin` am Ort |
| A14 | `req.needClearance` | **entschieden 2026-10-23:** ja |
| A15 | `org-admin` mit Ablauf | **entschieden 2026-10-23:** nicht erlaubt (422) |
| A16 | Rollen beim Einladen | **entschieden 2026-10-23:** Principal beim Einladen anlegen und zurückgeben; `principalId` nie null |
| A17 | Tupel beim Entfernen | **entschieden 2026-10-23:** Entfernen löscht alle Tupel; der Abgleich nicht |
| A18 | Principal eines Clients | **entschieden 2026-10-23:** `PUT /v1/admin/clients/{clientId}` legt ihn an (`kind = 'client'`, `subject = client_id = clientId`); UNIQUE `(tenant_id, client_id)` für Clients |
| A19 | Break-Glass starten | **entschieden 2026-10-23:** im `WhyDialog` bei `blocked.reason = 'clearance'` |
| A20 | Erstes `org-admin` | **entschieden 2026-10-23:** `iam-org-bootstrap` schreibt zusätzlich Principal, Tupel `org-admin` an `org` und Freigabestufe 2 in die Datenbank der App (`DATABASE_ADMIN_URL`, Migrationsrolle), Audit `tenant.provisioned` |
| A21 | Rechte von `<produkt>-admin` | **entschieden 2026-10-23:** ohne FGAP *Groups* und `manage-group-membership` (bestätigt in #44) |
| A22 | Ablauf ändern | **entschieden 2026-10-23:** `PATCH /v1/access/{id}`, Audit `access.granted` mit `previousExpiresAt` |
| A23 | Orte einer Person | **entschieden 2026-10-23:** `GET /v1/access?subject=me` bzw. `subject=<subjekt>` (`members:admin`) |
| A25 | Graph-Berechtigung für Gruppen | **entschieden 2026-10-23:** Anwendungsberechtigung `GroupMember.Read.All` (schwächer als `Group.Read.All`) in Anleitung, Zustimmungsprüfung und 9.4; fehlt sie, 409 `entra-consent-missing` bei `GET /v1/access/groups` |
| A24 | Rollen an `org` über `/v1/access` | **entschieden 2026-10-23:** erlaubt für Personen, Gruppen, «Alle Mitglieder» mit denselben Regeln; Audit `access.granted` |

Offen und nicht Teil dieser Spezifikation: Identity Brokering zwischen Produkten (Single Sign-on über Realms),
`full_scope_allowed` der Clients (assets Nr. 101), Kontingente je Mandant, Crypto-Shredding je Mandant.
