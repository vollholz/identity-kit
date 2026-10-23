# Spezifikation: IAM-Baukasten für Apps der Identity-Plattform

Stand 2026-10-22 · Status: **Entwurf** · Ort: vollholz/identity-kit (bis 2026-10-22 vollholz/identity `docs/produkt-iam.md`) · Abgeleitet aus vollholz/assets (`3c11515`) und vollholz/identity (`667e6bf`)

Diese Spezifikation beschreibt die Identitäts- und Rechteverwaltung (IAM), die vollholz/assets umgesetzt und geprüft
hat, so, dass ein **neues Produkt** sie vollständig übernimmt und an `https://identity.project-suite.ch` angehängt
wird: eigener Realm, Anmeldung über ein BFF, Keycloak-Organisationen als Mandanten, Rollen, Scopes und Zugriffsregeln,
Verwaltung von Mitgliedern und Organisationen in der App, Mandantentrennung bis in die Datenbank.

- **MUSS** / **SOLL** / **KANN** kennzeichnen die Verbindlichkeit. Ohne Kennzeichnung gilt MUSS.
- `<produkt>` steht für den technischen Namen des Produkts (Kleinbuchstaben, z. B. `assets`), `<Produkt>` für den
  Anzeigenamen (z. B. «Assets»). Was in Assets `assets` heisst, heisst im neuen Produkt `<produkt>`.
- **Referenz** nennt die Stelle in vollholz/assets, die das Verhalten heute umsetzt und als Vorlage dient. Bei
  Widersprüchen gilt diese Spezifikation; Abweichungen der Referenz sind Fehler der Spezifikation und werden hier
  nachgetragen.
- Produktneutral (gleich in jedem Produkt) sind Kapitel 2–7 und 9–14. Rechte, Rollen, Scopes und Ressourcen der
  Zugriffsregeln definiert die App selbst; Kapitel 8 legt die Schlüsselregeln und die wenigen
  reservierten Namen fest, die in jedem Produkt gleich heissen.

## Inhalt

1. [Überblick](#1-überblick) · [Standard und App-lokal](#11-standard-und-app-lokal)
2. [Anbindung an die Identity-Plattform](#2-anbindung-an-die-identity-plattform)
3. [Realm des Produkts](#3-realm-des-produkts)
4. [Mandanten](#4-mandanten)
5. [Anmeldung der Oberfläche (BFF)](#5-anmeldung-der-oberfläche-bff)
6. [Token-Prüfung und Principal](#6-token-prüfung-und-principal)
7. [Rechtemodell](#7-rechtemodell)
8. [Rechtekatalog des Produkts](#8-rechtekatalog-des-produkts)
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
                         │   Organisationen = Mandanten, Gruppen /orgs/<alias>/<r>, │
                         │   Clients <produkt>-platform|-api|-admin|-sync|(-mcp…)   │
                         │ Theme «identity» (Login, Konto, E-Mails)                 │
                         └───────▲───────────────▲──────────────────▲───────────────┘
              OIDC Code + PKCE   │  JWKS, Token  │  Admin-API        │ Admin-API (nur lesen)
                                 │               │  (<produkt>-admin)│ (<produkt>-sync)
 Browser ──Cookie──▶ BFF (/auth/*) ──Access Token──▶ API (/v1) ─────┘        Worker
   SPA, X-Tenant je Tab          Principal: Mandant, Rollen, Gruppen, Scopes   Abgleich Mitglieder
                                 Rechte: Rolle ∧ Scope ∧ Zugriffsregel
                                          │
                                 PostgreSQL: FORCE RLS je Mandant (app.tenant_id)
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
| Realm-Soll als OpenTofu-Modul: Einstellungen, Client-Richtlinien, Clients, Mapper, Scopes, Rollen aus dem Katalog | Name, Adressen, SMTP-Absender, welche Zugänge die App anbietet (API für Maschinen, MCP) |
| Anmeldung (BFF), Sitzung, Logout, Token-Prüfung (Bearer, DPoP, mTLS), Principal | – |
| Mandanten = Organisationen, Organisation je Tab, Wechsel | – |
| Entscheidung Rolle ∧ Scope ∧ Zugriffsregel, `can`, Simulation, 403-Texte, `GET /v1/authz/catalog` | **Rechtekatalog**: Rechte, Rollen, Scopes, Rechtegruppen ([Kapitel 8](#8-rechtekatalog-des-produkts)) |
| Zugriffsregeln (Mechanik, Tabelle, Validierung, Seite «Zugriff») | **Ressourcen**: Ressourcentypen, Kette, Auflösung einer Ressource zu ihren Eltern |
| Verwaltung: Mitglieder, Einladungen, Rollen-Vergabe, Organisationen, Freigaben von Clients, Abgleich | – |
| **Eigene Rollen der Organisation** (Mechanik, Tabelle, Seite «Rollen», Vergabe über Gruppen) | welche Rechte sie enthalten dürfen (alle ausser denen nur von `org-admin`), Höchstzahl |
| Anmeldung über den IdP der Organisation (Microsoft Entra ID, KANN) | ob angeboten; Registrierung der App bei Microsoft |
| Datenbank: Rollen, IAM-Tabellen, RLS-Mechanik, Kontext je Transaktion | Fachtabellen (erhalten RLS automatisch) |
| Oberflächen-Bausteine (Sitzung, Rechte-Hinweise, Rechte-Übersicht, Rollenmatrix, Verwalten-Seiten) | **Design**: Design-Tokens (Farben, Schrift, Abstände), Komponenten-Hülle; Theme-Werte der Anmeldeseiten ([3.2](#32-theme-und-texte)) |
| Texte des Baukastens (de/en, Du-Form): Oberfläche `iam.*`, Anmeldeseiten, Konto und Einladung (`standard_texts` des Realm-Moduls) | **Texte** der App, Labels und Beschreibungen des Katalogs, Theme-Texte der Anmeldeseiten, Übersetzungen weiterer Sprachen |
| Tests: Isolation über alle Routen, RLS, Multi-Org, BFF, Verwaltung, Katalogregeln | Fachtests; Eintrag der Fachrouten in den Isolationstest (automatisch über die Routenliste) |

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
| 7 | Produkt | `scripts/org-bootstrap.ts --alias <alias> --name … --email … --roles org-admin --platform-admin` | erste Organisation, Rollengruppen, erste Person (ohne Passwort, Pflichtaktion «Passwort festlegen») |

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
| `<produkt>-platform` | vertraulich | BFF der Oberfläche; trägt die Client-Rollen | Code-Flow mit PKCE S256; Redirect `<url>/auth/callback`; Web-Origin `<url>`; Post-Logout `<url>/abgemeldet`, `<url>/`; kein Front-Channel-Logout; Backchannel-Logout `<url>/auth/backchannel-logout` mit Sitzung; Refresh-Tokens an |
| `<produkt>-admin` | Service Account | Verwaltung über die Admin-API (nur API-Prozess) | nur Client Credentials, Token 120 s, keine Refresh-Tokens; Rechte [3.7](#37-rechte-der-service-accounts) |
| `<produkt>-sync` | Service Account | Abgleich der Mitglieder (nur Worker) | wie `-admin`, eigene Schlüssel, weniger Rechte |
| `<produkt>-iac` | Service Account | OpenTofu des Realms | im Bootstrap angelegt, `realm-management/realm-admin` |
| `<produkt>-mcp`, `<produkt>-mcp-cli` | KANN | MCP-Dienst | [Kapitel 12](#12-maschinen-clients-und-mcp) |

Mapper:

| Mapper | An | Konfiguration |
|---|---|---|
| Audience `aud-api` | `-platform` (und `-mcp`) | `included_client_audience = <produkt>-api`, Access Token und Introspektion, nicht ID-Token |
| Gruppen `groups` | `-platform` (und MCP-Clients) | Claim `groups`, **voller Pfad**, Access Token, Userinfo, Introspektion |
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
| Realm-Rolle `platform-admin` | Plattform-Administration über alle Mandanten; vergibt nur eine Keycloak-Administration bzw. `org-bootstrap.ts` |
| Client-Rollen von `<produkt>-platform` | genau die Rollen des Rechtekatalogs ([Kapitel 8](#8-rechtekatalog-des-produkts)), mit Beschreibung; Quelle `infra/keycloak/platform.json` |
| Gruppe `/orgs` | Basis; darunter legt die App `/orgs/<alias>/<rolle>` an |

Für Personen wirken die Rollen über die Gruppen `/orgs/<alias>/<rolle>` (je Organisation). Die Client-Rollen gelten
nur für Service Accounts von Maschinen-Clients ([6.2](#62-principal)).

### 3.6 Rechte-Scopes

Je Scope des Rechtekatalogs ein Client-Scope (`include_in_token_scope = true`, Text «<Produkt>: <scope>»), optional für
MCP- und Maschinen-Clients. Quelle ist `infra/keycloak/platform.json` (Rollen mit Beschreibung, Scopes), erzeugt aus dem
Rechtekatalog im Code; ein Test prüft, dass die Datei aktuell ist (Referenz: assets `infra/keycloak/platform.ts`,
`test/infra-keycloak.test.ts`).

### 3.7 Rechte der Service Accounts

Keycloak 26 kennt in FGAP v2 die Typen *Users*, *Groups*, *Clients*, *Roles*, aber **keine Organisationen**. Alle
Endpunkte unter `/organizations` (auch lesen) verlangen `realm-management/manage-realm`. Daraus (live geprüft mit 26.6):

| Client | Rechte | Bewusst nicht |
|---|---|---|
| `<produkt>-admin` | `realm-management/manage-realm`; FGAP v2 *Users* (alle): `view`, `manage`, `manage-group-membership`; FGAP v2 *Groups* (alle): `view`, `view-members`, `manage`, `manage-membership`; Richtlinie «nur dieser Client», Strategie `UNANIMOUS` | `realm-admin`, `manage-users`, `manage-clients`, `create-client`, `impersonation`, `map-roles`, `reset-password`; `manage-identity-providers` nur mit Anmeldung über Entra ID ([9.4](#94-anmeldung-über-den-idp-der-organisation-kann)) |
| `<produkt>-sync` | nur `manage-realm` | Benutzer, Gruppen, Clients (403 geprüft) |

Gruppenrechte auf `/orgs` gelten in v2 nicht für Untergruppen; deshalb gelten sie für alle Gruppen und die **App**
beschränkt sich auf die Rollengruppen ([9.1](#91-regeln)). Legt jemand weitere v2-Berechtigungen für *alle Benutzer*
oder *alle Gruppen* an, müssen deren Richtlinien `<produkt>-admin` einschliessen (`UNANIMOUS`).

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
| `GET /auth/login?returnTo=&org=&idp=` | Startet den Code-Flow (PKCE S256, `state`, `nonce`), Scopes aus `OIDC_SCOPES` mit `organization` → `organization:*`. Anmeldezustand verschlüsselt im kurzlebigen Cookie (10 min). `org` wählt nur vor. `idp` (nur `^entra-\d{3}$`, sonst ignoriert) wird zu `kc_idp_hint` mit `prompt=login`, damit eine bestehende Keycloak-Sitzung nicht weiter gilt (Testanmeldung, [9.4](#94-anmeldung-über-den-idp-der-organisation-kann)). |
| `GET /auth/entra/{idp}?org=` | Anmeldung über den Entra-Anbieter `idp` (`^entra-\d{3}$`) der Organisation `org`: Ziel des Links in der Einladung aus Entra ID (Redirect-URI `…/auth/entra/*` des Clients) und Link zum Weitergeben (`Mitglied.loginPath`). Rücksprung immer nach `/`; Parameter der Weiterleitung werden nicht weitergegeben. |
| `GET /auth/callback` | Code tauschen, ID-Token prüfen (Signatur, `iss`, `aud`, `nonce`), bestehende Sitzung **beenden und ersetzen** (Session-Fixation), neue Sitzung anlegen, Rücksprung nach `returnTo` |
| `GET /auth/me` | Person, Mandant (`id`, `alias`, `name`), `organizations`, `organizationNames`, `selectedOrganization`, `tenantError`, `roles`, `permissions` (effektiv), `grantedPermissions` (immer, leer ohne Freigaben; [7.1](#71-entscheidung)), `csrfToken`, `session.expiresAt`, `session.idleTimeoutSeconds`. Mandant aus `X-Tenant`, sonst Vorgabe der Sitzung; die Prüfung macht allein der Resolver ([6.2](#62-principal)). 401 ohne Sitzung. |
| `POST /auth/switch` | CSRF; setzt die Vorgabe der Sitzung, wenn das Token die Organisation enthält, sonst neue Anmeldung als Rückfall |
| `POST /auth/logout` | CSRF; Sitzung löschen, RP-initiated Logout mit `id_token_hint` und `post_logout_redirect_uri = <url>/abgemeldet` |
| `POST /auth/backchannel-logout` | OIDC Back-Channel Logout 1.0: Logout-Token prüfen (`iss`, `aud` = BFF-Client, `iat`, `jti`, höchstens 10 min alt, Ereignis `backchannel-logout`, kein `nonce`, `sid` oder `sub`), `jti` gegen Wiederholung, betroffene Sitzungen löschen |
| `/abgemeldet` | öffentliche Seite «Du bist abgemeldet», fragt `/auth/me` nicht ab, meldet nicht automatisch an |

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
`subject`, `name`, `email`, `clientId`, `roles`, `groups`, `scopes`, `platformAdmin`, `binding`, `scopeBound`.

| Regel | Soll |
|---|---|
| Organisation | aus dem Claim `TENANT_CLAIM` (Liste von Aliassen, Objekt `{alias: {id}}` oder Zeichenkette); Wahl nach [Kapitel 4](#4-mandanten). Fehler: keine Organisation → 403 (mit Hinweis auf den Scope), nicht im Token → 403, mehrere ohne Wahl → 400 mit eigener Liste |
| Person oder Maschine | Person nur, wenn `azp` in `OIDC_PERSON_CLIENT_IDS` (Standard: BFF- und MCP-Client) und kein Service Account (`service-account-…` bzw. `client_id` ohne Personenmerkmale). Alles andere ist Maschinen-Client |
| Rollen von Personen | nur Gruppen `<GROUP_ROLE_PREFIX>/<alias>/<rolle>` der **gewählten** Organisation (`ROLE_SOURCE=groups`, Standard). `client`/`both` nur, wenn niemand mehreren Organisationen angehört; dann Warnung beim Start |
| Rollen von Service Accounts | Client-Rollen von `ROLE_CLIENT_ID` (`resource_access`), da der Client je Mandant freigegeben ist |
| Gruppen | für Zugriffsregeln nur Gruppen ohne `/orgs/<anderer-alias>/…` |
| Freigabe | Maschinen-Clients nur, wenn ihre Client-ID im Mandanten freigegeben ist (`client_grant`), sonst 403 «Client nicht freigegeben» mit Hinweis auf die Freigabe. Über Token Exchange zählt der ursprüngliche Client, nicht `azp` |
| Plattform | `platformAdmin` = Realm-Rolle `PLATFORM_ADMIN_ROLE` |
| Scope-Grenze | `scopeBound` für Maschinen-Clients und Zugriffe über den MCP-Dienst |
| Spiegel | `principal` je Mandant (eigene ID je Mandant, `UNIQUE (tenant_id, kind, subject)`), Name/E-Mail/`last_seen_at` aktualisieren; bei Maschinen-Clients zusätzlich `last_roles`, `last_scopes` |
| Austritt | `removed_at` gesetzt: Token gilt nur, wenn **nach** `removed_at` ausgestellt (`iat`), sonst 403 «Kein Mitglied mehr» |
| Zwischenspeicher | Mandant (Alias + Keycloak-ID) 60 s, Freigabe 60 s, Principal 5 min; alle Schlüssel enthalten den Mandanten; `forget…` nach Sperren, Entzug, Entfernen |

## 7. Rechtemodell

Referenz: assets `src/platform/authz/permissions.ts`, `access.ts`, `capabilities.ts`; Konzept
`docs/konzepte/rollen-und-rechte.md` (Entscheide E1–E6).

### 7.1 Entscheidung

Erlaubt ist eine Aktion, wenn **(Rolle ∨ Freigabe) ∧ Scope ∧ kein Verbot und keine Beschränkung** sie zulassen
(Referenz: assets `docs/konzepte/rollen-und-rechte.md` § 8):

1. Eine Rolle des Principals – vordefiniert (Katalog) oder eigene Rolle der Organisation ([8.3](#83-eigene-rollen-der-organisation)) –
   enthält das Recht, **oder** eine Zugriffsregel `grant` gibt es ihm auf der Ressource oder einer darüber.
2. Nur bei `scopeBound` (Maschinen-Clients, MCP): ein Scope im Token deckt das Recht (auch für Freigaben).
3. Keine Zugriffsregel der Kette verbietet oder beschränkt es:
   - Die Ressourcen bilden eine Kette ab dem Mandanten (`tenant` → … → Blatt; Kette von der App definiert).
   - `deny` («Verbieten») auf irgendeiner Stufe entzieht das Recht; gewinnt.
   - `restrict` («Beschränken auf», früher `allow`): gibt es auf einer Stufe solche Einträge für ein Recht, behalten
     es nur passende Principals (aus Rolle oder Freigabe).
   - `grant` («Freigeben») gibt das Recht auf der Ressource und allem darunter, auch ohne Rolle; nie auf dem Blatt der
     Kette, wenn die Lesesicht der Datenbank je Typ arbeitet (Assets: nie auf Objekten), nie für Rechte nur von
     `org-admin`. «Rechte einer Rolle im Bereich» = je Recht der Rolle ein `grant`.
   - **Personen** mit `org-admin` sind von `deny` und `restrict` ausgenommen, damit sich niemand aussperrt;
     Maschinen-Clients mit `org-admin` nicht.
4. Principals einer Zugriffsregel: `user` (Principal-ID oder Subject), `client` (Client-ID), `role`, `group`.

- **«Recht irgendwo»** (`canSomewhere`, `needSomewhere`): Recht auf Mandantenebene oder über eine Freigabe auf
  irgendeiner Ressource; damit prüfen Listen und Einstiege, die danach je Ressource prüfen oder filtern. Anlegen ohne
  Ressource prüft auf Mandantenebene.
- Zugriffsregeln und eigene Rollen je Mandant zwischengespeichert, Version `tenant.acl_version` (Trigger bei jeder
  Änderung), Index je Recht und Ressource.
- Lesen filtert zusätzlich die Datenbank (RLS-Lesesicht, z. B. `app.read_types`, mit Freigaben); Schreiben prüft die App
  vorab und RLS mit `WITH CHECK`.
- **403-Text** nennt Label und Schlüssel: «Dir fehlt das Recht «Objekte ändern» (object:write).»
- **Fähigkeiten je Ressource** (E3): Antworten tragen `can`; ETag mit Zugriffsstand (`W/"<version>-<zugriff>"`), damit
  `can` nach einer Änderung an Rechten nicht veraltet aus einem Cache kommt.
- **Auskunft:** `/auth/me` liefert `permissions` und `grantedPermissions` (nur über Freigaben, ohne Bereiche).
  `GET /v1/acl/effective` liefert echte Rechte (`source`: `token`, `keycloak` für Personen, `last-token` für
  Maschinen-Clients) und simuliert, sobald `roles`, `groups` oder `scopes` gesetzt sind (`simulated`).
- Validierung beim Anlegen (422 am Feld): nur Rechte, die auf dem Ressourcentyp wirken; nichts, was wirkungslos wäre
  (Rechte nur von `org-admin` nie freigeben, verbieten oder beschränken nur für `client`); nicht die Rolle `org-admin`
  als Principal; keine Gruppen anderer Organisationen; keine Duplikate. Einträge werden nicht bearbeitet.
- **Wirkungszeiten** (dokumentiert und in der Oberfläche genannt): Zugriffsregel und eigene Rolle sofort auf allen
  Instanzen; Entzug einer Client-Freigabe ≤ 60 s; Entfernen einer Person ≤ 5 min (Tokens von davor nie mehr); Rolle
  oder Gruppe in Keycloak mit dem nächsten Access Token (≤ 5 min); Sperre einer Organisation ≤ 60 s.

### 7.2 Eine Quelle (E1)

Der Rechtekatalog steht an **einer** Stelle im Code (`authz/permissions.ts`) und enthält:

| Teil | Inhalt |
|---|---|
| `PERMISSIONS` | Schlüssel `<bereich>:<verb>` |
| `PERMISSION_INFO` | je Recht Label, Gruppe, Beschreibung, Ressourcentypen, auf denen eine Zugriffsregel wirkt |
| `PERMISSION_GROUPS` | Gruppen in Anzeigereihenfolge |
| `ROLES` | je Rolle Label, Beschreibung (nennt alle Rechtegruppen der Rolle), Rechte |
| `ADMIN_ONLY` | Rechte, die nur `org-admin` hat (berechnet) |
| `SCOPES`, `SCOPE_TEXT` | Scope → Rechte, Klartext je Scope |
| `RESOURCE_TYPES`, `RESOURCE_LABELS` | Ressourcen der Zugriffsregeln |

- `GET /v1/authz/catalog`: Rechte (mit `adminOnly`), Gruppen, Rollen (mit Rechten, `adminOnly`), Scopes,
  Ressourcentypen (und MCP-Werkzeuge), für jede angemeldete Person und jeden Client, ohne Rechteprüfung. Ergänzt um
  `groups[].match` (Stichwörter der Gruppe als regulärer Ausdruck, [8.2](#82-regeln-für-den-katalog)) und
  `permissions[].personOnly` (`true` für Rechte, die Personen vorbehalten sind) und `resourceTypes[].leaf` (`true` für
  Blätter der Kette: dort keine Freigaben), jeweils nur, wo gesetzt; für Assets
  ist die Antwort die bisherige plus diese Felder.
- Die Oberfläche hat **keine** eigenen Listen und Labels; ein Test prüft, dass ihr Typ `Permission` genau dem Katalog
  entspricht.
- `infra/keycloak/platform.json` wird aus dem Katalog erzeugt und vom Test auf Aktualität geprüft.

## 8. Rechtekatalog des Produkts

Rechte, Rollen, Scopes und Ressourcentypen **definiert die App selbst** – Anzahl, Schnitt und Texte. Diese
Spezifikation legt nur fest, **wie** der Katalog aufgebaut ist ([7.2](#72-eine-quelle-e1)), wie Schlüssel gebildet
werden und welche wenigen Namen reserviert sind, weil die produktneutralen Bausteine (Verwaltung, Zugriffsregeln,
Oberfläche) sie brauchen ([8.1](#81-reservierte-namen)).

### 8.1 Reservierte Namen

Was die Bausteine brauchen, heisst in **jedem** Produkt gleich. Die Schlüssel sind reserviert: Die App verwendet sie
genau in dieser Bedeutung und nie für etwas anderes; die Bausteine verwenden sie direkt als Konstanten, ohne
Zuordnung. Die Namen stammen aus Assets, damit Assets unverändert bleibt.

| Art | Schlüssel | Label | Pflicht | Bedeutung |
|---|---|---|---|---|
| Rolle | `org-admin` | Organisations-Admin | MUSS | hat alle Rechte des Katalogs, ist als Person von Verboten und Beschränkungen ausgenommen, wird nur von der Plattform-Administration vergeben und entzogen, die letzte aktive Person mit ihr bleibt ([9.1](#91-regeln)) |
| Recht | `tenant:read` | Organisation lesen | MUSS | Name und Einstellungen der Organisation sehen |
| Recht | `members:admin` | Mitglieder und Rollen verwalten | MUSS mit Verwaltung | Mitglieder einladen und entfernen, Rollen vergeben, eigene Rollen anlegen, Anmeldung der Organisation einrichten, Maschinen-Clients freigeben; **in keinem Scope** |
| Recht | `tenant:admin` | Organisation verwalten | MUSS, wenn die Organisation Einstellungen hat | Name und Einstellungen ändern |
| Recht | `acl:read` | Zugriff lesen | MUSS mit Zugriffsregeln | Zugriffsregeln und wirksame Rechte sehen |
| Recht | `acl:admin` | Zugriff verwalten | MUSS mit Zugriffsregeln | Zugriffsregeln anlegen und löschen |
| Recht | `audit:read` | Protokoll lesen | MUSS, wenn die App das Audit-Protokoll zeigt | Audit-Protokoll durchsuchen und prüfen |
| Ressourcentyp | `tenant` | Organisation | MUSS mit Zugriffsregeln | Wurzel der Kette der Zugriffsregeln |
| Rechtegruppe | `tenant`, `members`, `access`, `audit` | Organisation, Mitglieder und Rollen, Zugriff, Protokoll | MUSS für die genutzten Rechte | Gruppen der reservierten Rechte |
| Realm-Rolle | `platform-admin` | Plattform-Administration | MUSS | keine Rolle des Katalogs ([3.5](#35-rollen-und-gruppen)) |

Ausserdem reserviert: der Präfix `c-` für Schlüssel eigener Rollen ([8.3](#83-eigene-rollen-der-organisation)); keine
Rolle des Katalogs beginnt damit.

Label und Gruppe der reservierten Namen sind fest; die **Beschreibung** darf die App an ihren Fachbereich anpassen
(z. B. was «Organisation verwalten» umfasst). Reihenfolge: `org-admin` steht als erste Rolle im Katalog.

Ein Test prüft: jede reservierte Rolle und jedes reservierte Recht, das die App nutzt, hat Schlüssel, Label und Gruppe
wie oben; `org-admin` enthält alle Rechte; `members:admin` steht in keinem Scope; eigene Schlüssel der App folgen
[8.2](#82-regeln-für-den-katalog) und kollidieren nicht mit reservierten.

### 8.2 Regeln für den Katalog

- Jedes Recht hat Label, Gruppe, Beschreibung und die Ressourcentypen, auf denen eine Zugriffsregel wirkt.
- Schlüssel der App: Rechte `<bereich>:<verb>` (`^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$`, Verben bevorzugt `read`, `write`,
  `delete`, `admin`, `use`), Rollen `^[a-z][a-z0-9-]*$` (Funktion als Substantiv, Verwalter `<bereich>-admin`), Scopes
  `<bereich>:<verb>` mit Lese-Scope `<produkt>:read`, Ressourcentypen und Rechtegruppen `^[a-z][a-z0-9-]*$`; Schlüssel
  sind stabil (umbenennen = neues Recht bzw. neue Rolle mit Übergang).
- Jede Rolle hat Label und eine Beschreibung, die alle Rechtegruppen der Rolle nennt (Test); jeder Scope einen Text
  (Test).
- Rollen werden als Client-Rollen von `<produkt>-platform` und als Gruppen `/orgs/<alias>/<rolle>` angelegt; ihre
  Schlüssel enthalten deshalb nie `/`.
- Rollenbeschreibungen nennen alle Rechtegruppen der Rolle; geprüft über Stichwörter je Gruppe (`groups[].match`, ein
  regulärer Ausdruck), nicht über das Label.
- Rechte mit `scope: false` sind Personen vorbehalten (`personOnly` im Katalog, [7.2](#72-eine-quelle-e1)) und stehen
  in keinem Scope (geprüft). Scopes nur für
  Maschinen-Clients und MCP; Rechte, die Personen vorbehalten sind (`members:admin`, In-App-Assistent
  u. Ä.) oder Tokens an fremde Hosts schicken, in keinem Scope.
- SOLL: Rollenset minimal; Rechte, die zusammen gebraucht werden, in denselben Rollen (Assets E4). Als Vorlage für den
  Schnitt dient der Katalog von Assets (`src/platform/authz/permissions.ts`: 32 Rechte, 7 Rollen, 15 Scopes).
- KANN: keine Zugriffsregeln. Dann entfallen `acl:read`, `acl:admin`, die Kette der Ressourcen, die Seite «Zugriff» und die
  Tabelle `acl_entry`; die Entscheidung ist Rolle ∧ Scope.
- Der Katalog wird im Code gepflegt und über `infra/keycloak/platform.json` nach Keycloak gebracht; Rollen, die
  Personen in Gruppen haben, nicht ersatzlos entfernen (Gruppen und Zuweisungen vorher bereinigen).

### 8.3 Eigene Rollen der Organisation

Neben den vordefinierten Rollen des Katalogs legt die Verwaltung einer Organisation eigene Rollen an – Name,
Beschreibung und eine Auswahl von Rechten (wie bei GitHub). Standard des Baukastens. Referenz: assets Nr. 110,
`src/platform/modules/admin/roles.ts`, Migration `049_tenant_roles.sql`, `web/src/features/admin/Roles.tsx`.

| Regel | Soll |
|---|---|
| Wer | Personen mit `members:admin` (nie Maschinen-Clients oder MCP); lesen alle mit `tenant:read` |
| Schlüssel | `c-<kurzname>` aus dem Namen (Umlaute umschrieben, höchstens 32 Zeichen, bei Kollision `-2` …), unveränderlich; zugleich Name der Gruppe `/orgs/<alias>/<key>` und Principal in Zugriffsregeln |
| Rechte | 1–100 Rechte des Katalogs, **nie** Rechte nur von `org-admin` (422) – sonst umginge eine eigene Rolle die Grenze zu `org-admin`; beim Auswerten zusätzlich gefiltert |
| Namen | eindeutig unter den aktiven Rollen der Organisation, nicht der Name einer vordefinierten Rolle |
| Höchstzahl | 50 je Organisation (409) |
| Ändern | `If-Match` (412); neue Rechte wirken sofort (Rechte kommen aus der Datenbank, nicht aus dem Token) |
| Löschen | zuerst die Gruppe in Keycloak (alle verlieren die Rolle), dann ihre Zugriffsregeln; die Zeile bleibt als **Grabstein**, der Schlüssel wird nie wieder vergeben (noch gültige Tokens mit der alten Gruppe erben so nie eine spätere Rolle) |
| Vergabe | wie vordefinierte Rollen über `PUT /v1/admin/members/{id}/roles` (Gruppe bei der ersten Vergabe angelegt) |
| Maschinen-Clients | erhalten nur vordefinierte Rollen (Client-Rollen am Service Account); eigene Rollen nur für Personen |
| Vordefinierte Rollen | nur lesbar (409 `builtin-role`); Ausgangspunkt «eigene Rolle mit diesen Rechten anlegen» |
| Audit | `role.created`, `role.updated`, `role.deleted` |

## 9. Verwaltung in der App

Organisations-Admins verwalten Mitglieder und Rollen, die Plattform-Administration Organisationen – ohne
Keycloak-Konsole. Referenz: assets `src/platform/modules/admin/*`, `docs/zielarchitektur.md` › Verwaltung von
Organisationen und Mitgliedern, `docs/mandantentrennung.md` › Verwaltung.

### 9.1 Regeln

1. Nur **Personen** (`kind = user`, nicht `scopeBound`).
2. Wer `members:admin` hat, arbeitet immer in der Organisation **seines Tokens**; sie kommt nie aus der
   Anfrage.
3. Vor jeder Änderung wird die Person als Mitglied (oder offene Einladung) **dieser** Organisation geprüft; fremde oder
   erfundene IDs → 404 ohne Änderung.
4. Rollen sind ausschliesslich die Gruppen `<prefix>/<alias>/<rolle>` des Katalogs; andere Gruppen, Realm- und
   Client-Rollen bleiben unberührt. Fehlende Rollengruppen legt die App an.
5. `org-admin` vergeben und entziehen, Organisationen anlegen, ändern, sperren: nur `platform-admin`.
6. Die letzte aktive Person mit `org-admin` lässt sich weder herabstufen noch entfernen (409), auch nicht durch die
   Plattform-Administration; niemand entfernt sich selbst.
7. Änderungen derselben Organisation laufen nacheinander (Advisory-Lock in PostgreSQL).
8. Jede Änderung im Audit des betroffenen Mandanten in derselben Transaktion (`member.invited`,
   `member.roles_changed`, `member.removed`, `member.invitation_resent`, `organization.updated`, `tenant.provisioned`,
   `tenant.suspended`, `tenant.resumed`). Scheitert Keycloak nach erfolgten Schritten: eigener Eintrag `…_failed` mit
   den Schritten; neu angelegte Konten werden wieder gelöscht.
9. Die Verwaltung einer Organisation erfährt **nichts über andere Organisationen** (assets Nr. 56, Nr. 99):
   - Einladen antwortet immer `202 {"result":"invitation-sent"}` mit den Angaben aus der Einladung, gleich ob ein
     Konto bestand; Mindestdauer `KEYCLOAK_MGMT_INVITE_MIN_TIME` (auch für erneut Senden und Zurückziehen); bei
     Kollision eindeutiger Benutzername; E-Mail-Fehler gleich behandelt.
   - Eingeladene Personen erscheinen aus der Tabelle `member_invitation` mit **eigener ID je Einladung**, nie mit der
     Keycloak-ID; `createdAt` = Einladung in diese Organisation; erst nach Annahme im Personenverzeichnis.
   - Protokoll `member.invited` nur mit `email`, `roles`, `emailSent`.
   - `accountDeleted` beim Entfernen ist ausserhalb der Plattform-Administration immer `false`; gelöscht wird nur ein Konto, das diese Einladung
     selbst angelegt hat (`created_account`) und das keiner anderen Organisation angehört.
10. **Einladen**: neue Adresse → Konto ohne Passwort (Pflichtaktion `UPDATE_PASSWORD`), Mitgliedschaft, Rollen, E-Mail
    «Passwort festlegen» (`execute-actions-email`, Gültigkeit `KEYCLOAK_MGMT_INVITE_LIFESPAN`, Client
    `<produkt>-platform`). Bestehendes Konto → Einladung von Keycloak, Mitglied erst nach Annahme. Rollen sofort
    gesetzt. Ohne SMTP entsteht das Konto trotzdem, `emailSent: false`, später erneut senden.
11. Ohne `KEYCLOAK_MGMT_CLIENT_ID` ist die Verwaltung aus: `GET /v1/admin/status` sagt das, alle anderen Endpunkte 503
    mit Hinweis.

### 9.2 Endpunkte

| Endpunkt | Wer |
|---|---|
| `GET /v1/admin/status` (`enabled`, `reason`, `organization`, `platformAdmin`, `canManageMembers`, `rolesManageable`, `groupRolePrefix`, `roles`) | jede angemeldete Person |
| `GET/POST /v1/admin/members`, `PUT /v1/admin/members/{id}/roles`, `DELETE /v1/admin/members/{id}`, `POST /v1/admin/members/{id}/invitation` | `members:admin` |
| `GET /v1/roles`, `GET /v1/roles/{key}` (vordefinierte und eigene, `memberCount` nur mit `members:admin`, `maxCustom`, `customPermissions`) | `tenant:read` |
| `POST /v1/roles`, `PATCH /v1/roles/{key}`, `DELETE /v1/roles/{key}` | `members:admin`, nur Personen |
| `GET/POST/PUT/DELETE /v1/admin/entra…` ([9.4](#94-anmeldung-über-den-idp-der-organisation-kann)) | `members:admin` |
| `POST /v1/admin/entra/test` (Testanmeldung melden; die Sitzung muss über den Anbieter angemeldet sein) | jede Person der Organisation |
| `GET /v1/admin/members/entra-search?q=` (Personen im Verzeichnis, `selectable` und `reason`), `POST /v1/admin/members/entra` (`id`, `roles`, `sendEmail`; vorab anlegen und verknüpfen) | `members:admin`, nur mit Entra-Verbindung |
| `GET /v1/admin/clients`, `PUT/DELETE /v1/admin/clients/{clientId}` (Freigabe von Maschinen-Clients, ohne Verwaltungs-Client nutzbar) | `members:admin` |
| `GET /v1/people` (Suche `q`, `ids` bis 100 je Aufruf), `GET /v1/people/{id}`: Personenverzeichnis der Organisation (Mitglieder ohne `removed_at`, für Auswahlen und Zugriffsregeln) | Recht irgendwo (`canSomewhere`) eines lesenden Fachrechts bzw. `acl:read`; Vertrag für die Oberflächen-Bausteine |
| `GET/POST /v1/platform/organizations`, `GET/PATCH /v1/platform/organizations/{alias}`, `POST …/{alias}/suspend`, `POST …/{alias}/resume` (Body optional `reason`) | `platform-admin` |
| `…/v1/platform/organizations/{alias}/members…` (auch `…/members/entra-search`, `…/members/entra`), `…/{alias}/clients…`, `…/{alias}/entra…` (wie oben) | `platform-admin` |
| `GET /v1/platform/organizations/{alias}/roles` (nur lesend, Format wie `GET /v1/roles`: vordefinierte und eigene Rollen der Organisation, `memberCount`, `maxCustom`, `customPermissions`; noch nie benutzt: nur vordefinierte) | `platform-admin` |

Datentyp Mitglied: `id`, `principalId`, `username`, `name`, `email`, `status` (`active` | `invited` | `disabled`),
`roles`, `lastSeenAt` (letzter Zugriff auf die App), `createdAt`, `loginPath` (nur bei einer offenen Einladung aus
Entra ID: `/auth/entra/{idp}?org=…`, sonst `null`; die Oberfläche übernimmt nur Pfade unter `/auth/` der eigenen
Herkunft). Organisation: `id` (Keycloak), `alias`, `name`,
`description`, `enabled`, `domains`, `tenant` (`id`, `status`, `createdAt` oder `null`).

### 9.3 Abgleich ins Personenverzeichnis

- Worker gleicht alle Mandanten nach `MEMBER_SYNC_INTERVAL` ab (Standard 1 h, `0` = aus), höchstens ein Lauf über alle
  Instanzen (Advisory-Lock); zusätzlich sofort nach Entfernen und beim Öffnen der Mitgliederliste. Eingeladene
  erscheinen erst nach Annahme im Personenverzeichnis ([9.1](#91-regeln) Nr. 9), Einladen löst deshalb keinen Abgleich aus.
- Zuordnung Organisation ↔ Mandant über Alias **und** `kc_org_id`; Organisationen ohne Mandant und gesperrte Mandanten
  übersprungen; ein Fehler bei einer Organisation hält die anderen nicht auf und markiert dort niemanden als entfernt.
- Wer nicht mehr Mitglied ist, erhält `removed_at` (nicht löschen: Verweise und Audit bleiben); Rückkehr hebt es auf
  (gleiche ID). Maschinen-Clients bleiben unberührt. Audit `people.synced`.
- Name der Organisation folgt Keycloak (nur bei gleicher `kc_org_id`, Audit `organization.name_synced`).
- Eigener Client `<produkt>-sync` mit eigenem Schlüssel; der Worker kennt den Schlüssel von `<produkt>-admin` nicht.

### 9.4 Anmeldung über den IdP der Organisation (KANN)

Eine Organisation verbindet ihre Anmeldung selbst mit Microsoft Entra ID; Personen ihrer verifizierten Domänen melden
sich danach nur noch über Microsoft an. Referenz: assets Nr. 104, `docs/konzepte/entra-id.md`,
`src/platform/modules/admin/{entra,graph}.ts`, Migrationen `046`, `047`.

- **Eine** mandantenfähige App in Entra ID je Produkt (Betreiber registriert einmal); Kunden stimmen beim Verbinden zu.
  Berechtigungen in Microsoft Graph (minimal, nach den Aufrufen der App): Anwendung `Organization.Read.All`
  (`GET /organization`: Tenant und verifizierte Domänen), Anwendung `User.Read.All` (`GET /users` mit `$filter` bzw.
  `$search`, `GET /users/{id}`), delegiert `User.Read` (Keycloak liest bei der Anmeldung `/me`). Dazu Verzeichnisrollen im
  Gruppen-Claim (`groupMembershipClaims` mit `DirectoryRole`) für den Nachweis der Zustimmung (`wids`).
  Je Organisation ein Identity Provider `entra-NNN` aus einem Pool von Redirect-URIs (`ENTRA_IDP_SLOTS`), mit der
  Organisation und ihren Domänen verbunden (Keycloak ≥ 26.8). `<produkt>-admin` braucht dafür
  `manage-identity-providers`; Mapper an Anbietern legt die App nie an.
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
  `GET …/consent-links` zeigt alle offenen und die letzten 20 erledigten Links mit Zustand (`open`, `expired`, `revoked`,
  `connected` mit zustimmender Person, `failed` mit Fehler). Offene Links verfallen, wenn die erzeugende Person entfernt
  wird oder `members:admin` verliert (Plattform: die Realm-Rolle) und beim Trennen; geprüft auch beim Start und bei der
  Rückkehr. Gesperrte Organisation: kein Link gilt (404). Die öffentliche Seite braucht keine Sitzung: `POST /v1/entra/handover/info` (Name der Organisation, Produkt,
  `requestedBy` und `tenant` wie bei der Erzeugung angegeben, damit die Entra-Administration fremde Links erkennt, dazu
  `notice`: Die verifizierten Domänen des Verzeichnisses gehen an die Organisation; den Namen des Entra-Tenants kennt die
  App vor der Zustimmung nicht), `…/start` (Adresse zu Microsoft), Rückkehr über `<paths.entra>/zustimmung` mit `state` `h.<alias>.…` an
  `POST /v1/entra/handover/complete`. Gleicher Nachweis wie oben; verbunden wird im Namen der erzeugenden Person, `consentBy` und
  `viaLink` im Audit; eingelöst in derselben Transaktion wie die Verbindung. Unbekannt, abgelaufen, widerrufen oder eingelöst: immer 404; Ratenbegrenzung je IP, `no-store`. Beide ohne Guard; die API prüft selbst. Die Pfade müssen zu den Redirect-URIs der Entra-App und zu
  `ENTRA_UI_PATH` des Servers passen (Standard `/verwalten/anmeldung` wie `paths.entra`); `GET …/entra` nennt beide
  (`consentPath`, `testPath`), `testLoginPath` führt mit `returnTo` auf `testPath`. `state` hat das Format `o.<alias>.<zufall>` (eigene Organisation) bzw.
  `p.<alias>.<zufall>` (Plattform-Administration); die Oberfläche öffnet die Zustimmung nur über https bei
  `login.microsoftonline.com` (per Konfiguration erweiterbar).
- Mit «Nur Entra» prüft der Resolver, dass die Sitzung über den Anbieter angemeldet ist (`identity_provider`), sonst 403
  `entra-login-required`; Einladen in die Domänen wird abgelehnt.
- Personen aus Entra suchen, vorab anlegen und verknüpfen, Rollen setzen (Teil 2). Austritte über Graph/SCIM offen
  (assets Nr. 105).
- Weitere IdPs (Google Workspace, SAML) nach demselben Muster als spätere Erweiterung des Baukastens.

## 10. Datenbank

Referenz: assets `db/bootstrap.sql`, `db/migrations/001_core.sql`, `016_org_admin.sql`, `020_tenant_isolation.sql`,
`043_invitation_id.sql`, `045_principal_last_roles.sql`, `src/platform/db/pool.ts`.

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
| `tenant` | `id`, `kc_org_id` UNIQUE, `alias` UNIQUE CHECK Muster, `name`, `status`, `acl_version`, `settings`, `created_at` | RLS ohne FORCE (Besitzer-Funktionen), Richtlinie `tenant_self` (nur eigener Mandant) |
| `principal` | `tenant_id`, `id`, `kind`, `subject`, `display_name`, `email`, `client_id`, `last_seen_at` (leer = nie angemeldet), `removed_at`, `last_roles`, `last_scopes`; PK `(tenant_id, id)`, UNIQUE `(tenant_id, kind, subject)` | FORCE RLS |
| `acl_entry` | `tenant_id`, `id`, `resource_type`, `resource_id` (leer genau bei `tenant`), `principal_type`, `principal_ref`, `permission`, `effect` (`grant` \| `restrict` \| `deny`; `grant` nicht auf dem Blatt), `created_at`, `created_by` | FORCE RLS; Trigger erhöht `acl_version` |
| `tenant_role` | `tenant_id`, `id` (PK `(tenant_id, id)`), `key` (`^c-[a-z0-9][a-z0-9-]{0,40}$`, UNIQUE je Mandant), `label`, `description`, `permissions` (1–100), `version`, `created_*`, `updated_*`, `deleted_at` (Grabstein); Name eindeutig unter aktiven | FORCE RLS; Trigger erhöht `acl_version` |
| `entra_connection` u. a. (KANN) | Verbindung je Organisation, Zustand, Domänen, `state` als Hash | FORCE RLS |
| `member_invitation` | `tenant_id`, `id` (eigene ID), `user_id` (Keycloak), `email`, `display_name`, `created_at`, `created_by_name`, `accepted_at`, `created_account`; UNIQUE offene Einladung je E-Mail | FORCE RLS |
| `client_grant` | `tenant_id`, `client_id` (Muster), `description`, `created_at`, `created_by_name`; PK `(tenant_id, client_id)` | FORCE RLS |
| `session` | `id` (Hash), `data` (verschlüsselt), `csrf`, `subject`, `idp_sid`, Zeiten | ohne Mandantendaten, ohne RLS |
| `audit_log` | je Mandant lückenlose Folge `seq`, Hash-Kette | FORCE RLS; nur lesen und anhängen |
| `replay_guard`, `rate_limit` | geteilter Zustand (`SHARED_STATE=postgres`) | ohne Mandantendaten |

### 10.3 Mechanik

- `app.tenant_id()`, `app.principal_id()` aus `current_setting(…, true)`; die App setzt den Kontext je Transaktion
  (`set_config(…, true)` bzw. `SET LOCAL`, PgBouncer-tauglich) nur über `withTenant`/`req.tx`.
- `app.secure_tenant_tables()` läuft nach **jeder** Migration: jede Tabelle mit `tenant_id` erhält ENABLE + FORCE RLS,
  Richtlinie `tenant_isolation` (`USING` und `WITH CHECK` `tenant_id = app.tenant_id()`) und die Rechte für `_app`.
- Fremdschlüssel zusammengesetzt (`tenant_id, …`): eine fremde ID verhält sich wie eine unbekannte.
- `app.resolve_tenant` (SECURITY DEFINER, `search_path` fest, nur `_app` ausführbar) nach [Kapitel 4](#4-mandanten).
- Eindeutigkeiten je Mandant (kein 409-Orakel über Mandanten).

## 11. Oberfläche

Referenz: assets `web/src/auth/*`, `web/src/shell/*`, `web/src/ui/{MissingRight,RightsOverview,RoleMatrix,AdminHead,
MenuButton,org}.tsx`, `web/src/features/{admin,acl}/*`, `docs/oberflaeche.md`, Konzept
`docs/konzepte/rollen-und-rechte-ux.md`.

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

- Bedienelemente nach `permissions` aus `/auth/me` und nach `can` der Ressource; Labels nur aus
  `GET /v1/authz/catalog` (`useAuthz()`).
- **Fehlendes Recht** an der Stelle der Aktion, ein Baustein (`MissingRight`): Recht mit Label, Rollen, die es
  enthalten, wer Rollen vergibt («Diese Rolle vergibt die Plattform-Administration» bei Rechten nur von `org-admin`).
- Seiten mit Rechtebedarf: Routen-Guard `requires(…)` zeigt «Recht fehlt» statt eines 403.
- **Meine Rollen und Rechte** im Kontomenü: Rollen als Karten, Rechte-Übersicht, Hinweis auf mögliche
  Zugriffsregeln (keine Liste einzelner Regeln, sie gäbe verborgene Ressourcen preis), «Rollen vergleichen».
- Baustein **Rechte-Übersicht** für alle Blickwinkel (ich, Person, Rolle, Maschinen-Client mit Rolle ∧ Scope,
  Assistent): «Darf n von m», Gruppen mit Zählung, je Recht erlaubt / fehlt (Rolle) / fehlt (Scope), «Warum?»;
  `org-admin` als ein Satz «Alle Rechte. Zugriffsregeln gelten nicht.»
- **Rollenmatrix** Rechtegruppe × Rolle im Rollendialog, ohne waagrechtes Scrollen.
- Begriffe (sichtbar, verbindlich): **Rolle**, **Recht**, **Scope** («Freigabe im Token»), **Zugriffsregel** (nicht
  «ACL», nicht «Principal»), **Organisation** (nicht «Mandant»).

### 11.3 Verwalten

| Seite | Wer | Inhalt |
|---|---|---|
| Mitglieder | `members:admin` | Liste mit Status, Rollen, zuletzt aktiv; einladen, Rollen setzen (Dialog mit Rollenmatrix), über «⋯» entfernen, Einladung erneut senden oder zurückziehen |
| Maschinen-Clients | `members:admin` | Freigaben mit Rollen und Scopes aus dem letzten Token, freigeben, entziehen |
| Zugriff (falls genutzt) | `acl:read` / `acl:admin` | Zugriffsregeln gruppiert nach Ressource, Filter in der URL, Dialog nur mit passenden Rechten, Personen- und Client-Auswahl, Vorschau der Folgen, «wirkungslos», Simulation; Hinweis «Zugriff eingeschränkt (n)» an den Ressourcen |
| Rollen | Seite und Navigation `members:admin`; die API liest mit `tenant:read` | vordefinierte (nur lesbar) und eigene Rollen; anlegen, bearbeiten, löschen mit Rechte-Auswahl nach Gruppen, Zahl der Personen |
| Anmeldung (KANN) | `members:admin` | Entra ID verbinden, Testanmeldung, Vorschau, «Nur Entra», Domänen, trennen |
| Organisationen | `platform-admin` | anlegen, umbenennen, Domänen, sperren/entsperren, Mitglieder, Clients und Anmeldung der Organisation |

Muster: Hauptaktion im Seitenkopf; Zeilenaktionen im Menü «Mehr zu <Name>»; nicht Erlaubtes gesperrt **mit Grund**
statt ausgeblendet; Fehler im Dialog; Prüfung beim Absenden mit Meldung am Feld; unter 760 px gestapelt, kein
waagrechtes Scrollen bei 390 px; hell/dunkel; Tastatur und Screenreader (axe ohne serious/critical).

## 12. Maschinen-Clients und MCP

Alle Zugänge laufen über dieselbe Token-Prüfung, denselben Principal und dieselbe Entscheidung; sie unterscheiden sich
nur in Anmeldung, Bindung und Scope-Grenze. Der Baukasten bietet jede Zugangsart als Schalter im Realm-Modul und in der
Konfiguration der App an.

| Zugangsart | Wer | Anmeldung | Token | Organisation | Rechte | Einrichtung |
|---|---|---|---|---|---|---|
| Oberfläche | Person | BFF, Code + PKCE, `private_key_jwt` | bleibt auf dem Server | `organization:*`, Wahl je Tab | Rolle ∧ Zugriffsregel | Standard |
| API für Personen (Skripte, CLI) | Person | öffentlicher Client, Code + PKCE (Loopback, RFC 8252), DPoP empfohlen | Bearer/DPoP, `aud = <produkt>-api` | `organization:*`, `X-Tenant` | Rolle ∧ **Scope** ∧ Zugriffsregel | Schalter `person_api`; `azp` in `OIDC_PERSON_CLIENT_IDS`, scope-gebunden. **Neu:** In Assets erreichen Personen die API nur über BFF und MCP; Tokens eines anderen Clients gelten dort als Maschinen-Client |
| Organisations-Client (M2M) | Maschine einer Organisation | Client Credentials, `private_key_jwt` | DPoP Pflicht (mTLS möglich), 5 min, kein Refresh | fester Claim mit einem Alias | Client-Rollen ∧ Scope ∧ Zugriffsregel | Vorlage, Konsole; **Freigabe** durch `members:admin` ([12.1](#121-maschinen-clients-muss-sobald-die-api-für-maschinen-offen-ist)) |
| System-Client | Dienst des Betriebs (z. B. Worker eines anderen Produkts, Export, Monitoring) | Client Credentials, `private_key_jwt` | DPoP, 5 min Claim mit den Aliassen, für die er eingerichtet ist; je Aufruf `X-Tenant`; gilt nur, wo freigegeben | Client-Rollen ∧ Scope ∧ Zugriffsregel | im Realm-Modul (`system_clients`), Freigabe je Mandant wie M2M; nie `members:admin`. **Neu:** In Assets ist ein Maschinen-Client an genau eine Organisation gebunden und wird von Hand angelegt |
| App-zu-App | Dienst von Produkt B ruft API von Produkt A | wie System-Client im Realm von A | wie oben | wie System-Client | wie oben | System-Client in A; B verwahrt nur seinen privaten Schlüssel. Personen-Kontext über Realm-Grenzen nur mit Identity Brokering (offen) |
| MCP | Person über KI-Host | öffentlicher MCP-Client, Code + PKCE; MCP-Dienst tauscht (RFC 8693) | `aud = <produkt>-mcp` → getauscht `<produkt>-api` | `X-Tenant` oder `?org=` | Rolle ∧ Scope ∧ Zugriffsregel | Schalter `mcp` ([12.2](#122-mcp-dienst-kann)) |
| MCP für Maschinen | Agent ohne Person | Client Credentials an den MCP-Dienst | wie M2M | wie M2M | wie M2M | wie Organisations-Client, Audience `<produkt>-mcp` |

Regeln für alle Zugänge ausser der Oberfläche: Scope-Grenze (`scopeBound`), keine Rechte ohne Scope
(`members:admin` nie), Audit mit Client und Person, Ratenbegrenzung je Mandant und Principal, Tokens höchstens 5 min.

### 12.1 Maschinen-Clients (MUSS, sobald die API für Maschinen offen ist)

- OAuth 2 Client Credentials, ein Keycloak-Client je Integration und Organisation, `private_key_jwt` (Client-Geheimnis
  nur übergangsweise), DPoP-gebundene Tokens (alternativ mTLS), Access Token 5 min, keine Refresh-Tokens.
- Einrichtung in der Keycloak-Konsole nach Vorlage: Service Account, *DPoP bound access tokens*, Audience
  `<produkt>-api`, Hardcoded-Claim `organization = ["<alias>"]` (JSON), Client-Rollen von `<produkt>-platform`,
  passende Rechte-Scopes, Attribute `<produkt>.platform = true`, `<produkt>.m2m = true`.
- **Danach Freigabe** durch die Verwaltung der Organisation (`members:admin`) in der App; ohne Freigabe 403. Ein falscher Mapper öffnet so keine fremde
  Organisation.
- Die App legt Maschinen-Clients (noch) nicht selbst an: dafür bräuchte `<produkt>-admin` `manage-clients` bzw.
  `create-client`, womit sich beliebige Mapper (fremde Organisation, `platform-admin`) setzen liessen.

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
| `ROLE_SOURCE` | `groups` | `groups` \| `client` \| `both` |
| `ROLE_CLIENT_ID` | `<produkt>-platform` | |
| `GROUPS_CLAIM` | `groups` | |
| `GROUP_ROLE_PREFIX` | `/orgs` | |
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
| `DATABASE_URL`, `DATABASE_ADMIN_URL`, `DATABASE_WORKER_URL` (geheim) | — | Laufzeit, Besitzer (Migrationen), Worker ([10.1](#101-rollen)) |
| `MCP_CLIENT_ID`, `MCP_PRIVATE_KEY` (geheim), `MCP_HOST_CLIENT_IDS`, `OIDC_MCP_AUDIENCE` | `<produkt>-mcp`, —, —, `<produkt>-mcp` | MCP-Dienst ([12.2](#122-mcp-dienst-kann)) |
| `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` (geheim), `ENTRA_IDP_SLOTS`, `ENTRA_UI_PATH` | —, —, `100`, `/verwalten/anmeldung` | Anmeldung über Entra ID ([9.4](#94-anmeldung-über-den-idp-der-organisation-kann)); `ENTRA_UI_PATH` = `paths.entra` der Oberfläche |

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
| Person in A und B | Rollen, Gruppen, Zugriffsregeln, Principal, Caches, Idempotenz je Mandant |
| Maschinen-Client | Freigabe der Client-ID je Mandant |
| Ehemaliges Mitglied | Token nach dem Austritt ausgestellt; BFF verwirft die Organisation beim Erneuern |
| Unangemeldete Dritte | gleiche Antwort und gleicher Aufwand für unbekannt und fremd |
| Fehlkonfiguration in Keycloak | eigener Realm, Prüfung fremder Clients, Client-Richtlinien |

Pflichttests (Referenz: assets `test/platform/*`):

| Test | Prüft |
|---|---|
| `tenant-isolation` | **jede** `/v1`-Route (aus der Routenliste, `onRoute`) mit IDs von A als B: Antwort wie für eine unbekannte ID, ohne Merkmale von A; Listen, Suche, Zähler; keine Route ohne Eintrag (kein leeres Grün) |
| `multi-org` | Person in A und B: Rollen, Gruppen, Zugriffsregeln, Wahl, Austritt, Client-Freigabe, Alias neu vergeben |
| `rls` | jede Tabelle mit `tenant_id` hat FORCE RLS und `tenant_isolation`; kein PUBLIC-EXECUTE; fremder Mandant sieht nichts |
| `auth` / `unit` | Token-Prüfung (Typ, Bindung, DPoP, mTLS), Person/Client, Alias ASCII, `ROLE_SOURCE` |
| `bff` | Code-Flow, Fixation, `returnTo`, CSRF, Erneuerung parallel, Austritt, Backchannel-Logout, Wechsel |
| `admin` | Regeln aus [9.1](#91-regeln) inkl. gleicher Antwort beim Einladen, letzter Admin, Audit `…_failed` |
| `authz` / `capabilities` | Katalog vollständig (jede Rolle mit Beschreibung, jeder Scope mit Text), Entscheidung, `can` |
| `infra-keycloak` | `platform.json` aktuell, Lokalisierung (Schlüssel, Platzhalter, Du-Form) |
| Oberfläche | Typ `Permission` = Katalog; Organisation je Tab; Rechte-Bausteine |
| E2E | Anmeldung, Einladen, Rollen, Zugriffsregel ressourcengenau, Organisation je Tab (gegen lokalen Keycloak) |

Für Tests ohne echten Keycloak eine Nachbildung der Admin-API (Referenz `test/platform/keycloak-fake.ts`); für
Entwicklung `npm run dev:setup` (PostgreSQL und Keycloak in Docker, `scripts/keycloak-setup.ts` mit Demo-Organisationen
und Testpersonen).

## 15. Baukasten und Ausrollen

Der Baukasten liegt in diesem Repository (vollholz/identity-kit) und wird aus vollholz/assets herausgelöst; Assets ist danach das erste Produkt, das ihn nutzt. Jede neue App
bindet ihn ein, statt Code zu kopieren. Referenz bleibt Assets, bis der Baukasten dieselben Tests besteht.

### 15.1 Bestandteile

| Teil | Inhalt | Kapitel |
|---|---|---|
| **Vertrag** (sprachneutral) | Claims, Header (`X-Tenant`, `X-CSRF-Token`, `DPoP`), Endpunkte `/auth/*`, `/v1/authz/catalog`, `/v1/acl…`, `/v1/admin/*`, `/v1/platform/*`, Fehlerformat (RFC 9457) und Texte, JSON-Schema des Katalogs, Datenbankschema des IAM | 4–11 |
| **OpenTofu-Modul** `product-realm` | Realm-Soll aus [Kapitel 3](#3-realm-des-produkts); Eingaben: `product`, `display_name`, `public_base_url`, `catalog` (`platform.json`), `theme_texts`, `smtp`, Schalter `mcp`, `m2m`, `entra` (später `person_api`, `system_clients`, B4), `standard_texts` des Baukastens; dazu das Bootstrap-Modul `product-realm-bootstrap`. `kc.sh` und der `import`-Block gehören in die Vorlage | 2, 3 |
| **Backend-Paket** `@vollholz/iam` (Node 24, TypeScript, Fastify-Adapter) | Konfiguration, Token-Prüfung, Principal, BFF, Entscheidung mit App-Katalog, Zugriffsregeln, Verwaltung, Abgleich (Worker-Job), Freigaben, MCP-Token-Austausch, Audit-Schnittstelle, SQL-Migrationen des IAM | 5–7, 9, 10, 12 |
| **Frontend-Paket** `@vollholz/iam-web` (React) | Sitzung und `/auth/me`, Organisation je Tab, `useAuthz()`, `useResourceCan()`, `MissingRight`, Routen-Guard, Rechte-Übersicht, Rollenmatrix, «Meine Rollen und Rechte», Verwalten › Zugang (Mitglieder, Rollen, Anmeldung, Maschinen-Clients), Zugriff, Organisationen | 11 |
| **Test-Kit** `@vollholz/iam-testkit` | Wegwerf-Datenbank, Keycloak-Nachbildung, Testpersonen, Prüfung fremder Clients im Realm, Isolations-Durchlauf über die Routenliste, RLS-Prüfung, Katalogregeln, Konformitätstests des Vertrags (auch für Apps in anderen Sprachen) | 14 |
| **Vorlage** `create-iam-app` | legt in einer App `infra/keycloak` (Modulaufruf), Katalog-Gerüst, Migration, Konfiguration, Workflow `keycloak.yml`, Doku-Gerüst (Inventar der Mandantentrennung) an | 2, 15.3 |

### 15.2 Schnittstelle zur App

**Wo was liegt.** Keycloak kennt nur, was es für Anmeldung und Tokens braucht; alles Übrige führt die App.

| Was | Definiert in | Angelegt bzw. geführt | Wann | Wer ändert |
|---|---|---|---|---|
| Rechte (`note:read` …) | Katalog der App (Code) | nur in der App; nie in Keycloak | mit jedem Release | Entwicklung (Code-Review) |
| Vordefinierte Rollen (Definition) | Katalog der App | Client-Rollen von `<produkt>-platform` im Realm, über das Realm-Modul aus `platform.json` | `kc.sh apply` bzw. Workflow «Keycloak» nach dem Release | Entwicklung; nie die App zur Laufzeit |
| **Eigene Rollen** (Definition: Name, Rechte) | Organisation in der App | nur in der Datenbank der App (`tenant_role`); in Keycloak nur als Gruppe `/orgs/<alias>/c-…` für die Vergabe, **keine** Client-Rolle | zur Laufzeit | `members:admin` |
| Scopes | Katalog der App | Client-Scopes im Realm, über das Realm-Modul | wie Rollen | Entwicklung |
| Rollen-**Zuweisung** an Personen | – | Gruppen `/orgs/<alias>/<rolle>` im Realm; die App legt sie bei Bedarf an und setzt Mitglieder über die Admin-API (`<produkt>-admin`) | zur Laufzeit | `members:admin` in der App; `org-admin` nur `platform-admin` |
| Rollen-Zuweisung an Maschinen-Clients | – | Client-Rollen am Service Account | beim Einrichten des Clients (Konsole bzw. IaC bei System-Clients) | Keycloak-Administration |
| Organisationen, Mitgliedschaften, Konten | – | Keycloak; Spiegel in `tenant` und `principal` | zur Laufzeit | Plattform-Administration bzw. `members:admin` in der App |
| Ressourcentypen und Kette | Katalog der App | nur in der App | mit jedem Release | Entwicklung |
| Ressourcen (Objekte) | Fachmodell der App | nur in der Datenbank der App | zur Laufzeit | Personen mit den Rechten |
| Zugriffsregeln | – | nur in der Datenbank der App (`acl_entry`) | zur Laufzeit | `acl:admin` |
| Freigaben von Maschinen-Clients | – | nur in der Datenbank der App (`client_grant`) | zur Laufzeit | `members:admin` |

Folgerungen:

- Die App legt zur Laufzeit **keine** Client-Rollen, Scopes oder Clients in Keycloak an; sie verwaltet nur Gruppen unter
  `/orgs` (auch für eigene Rollen), Mitgliedschaften, Konten (Einladung), Organisationen und – mit Entra ID –
  Identity Provider der Organisationen. Die **Rechte** eigener Rollen kennt Keycloak nie; das Token trägt nur die
  Gruppe, die App liest die Rechte aus ihrer Datenbank. Neue oder geänderte Rollen kommen über den Katalog,
  den Test (`platform.json` aktuell) und das Realm-Modul.
- Für Personen wirken die Rollen über die Gruppen, nicht über die Client-Rollen (`ROLE_SOURCE=groups`); die
  Client-Rollen bestehen für Maschinen-Clients und als Verzeichnis der Rollen im Realm.
- Keycloak Authorization Services (Ressourcen, Richtlinien in Keycloak) werden **nicht** verwendet: Ressourcen sind
  zahlreich, fachlich und mandantengebunden; sie gehören in die Datenbank unter RLS. Keycloak bleibt Aussteller der
  Identität, die Entscheidung trifft die App.
- Wird eine Rolle aus dem Katalog entfernt, bereinigt der Abgleich ihre Gruppen und Zuweisungen, bevor das Realm-Modul
  die Client-Rolle löscht (Reihenfolge im Release).


Die App liefert genau ihre lokalen Teile ([1.1](#11-standard-und-app-lokal)):

```ts
// src/authz/catalog.ts – einzige Quelle; daraus platform.json, Typen und GET /v1/authz/catalog
export const catalog = defineCatalog({
  permissions: { 'note:read': { label: 'Notizen lesen', group: 'notes', description: '…', resources: ['tenant', 'note'] }, … },
  groups: [{ key: 'notes', label: 'Notizen' }, …],          // reservierte Gruppen ergänzt der Baukasten
  roles: { editor: { label: 'Bearbeiter:in', description: '…', permissions: ['note:read', 'note:write'] }, … },
  scopes: { '<produkt>:read': ['tenant:read', 'note:read'], 'notes:write': ['note:write'] },
  resources: { note: { label: 'Notiz', parent: 'tenant' } },  // Kette der Zugriffsregeln
});

// Ressourcen der Zugriffsregeln: Zustand wird mit der ACL geladen, die Kette danach synchron berechnet
// (so prüft `can` ganze Listen ohne Abfrage je Zeile)
export const resources: ResourceModel = { load: async tx => …, chain: (state, ref) => …, version: async tx => … };

// Backend: Kern ohne Fastify (Worker, MCP-Dienst, Tests), dann das Plugin
const iam = createIam({ catalog, resources, db, audit, config: process.env });
await app.register(iamPlugin, { iam });   // /auth/*, /v1/authz/*, /v1/acl*, /v1/roles, /v1/people, /v1/admin/*, /v1/platform/*
app.get('/v1/notes/:id', { preHandler: iam.need('note:read', r => ({ type: 'note', id: r.params.id })) }, …);

// Frontend (Aussehen über CSS-Variablen --iam-* aus den Design-Tokens der App)
<IamProvider texts={texts} features={{ entra: true }}><App /></IamProvider>
<Route path="/verwalten/mitglieder" element={<Requires perm="members:admin"><MembersPage /></Requires>} />
```

- `defineCatalog` prüft beim Start und im Test die Regeln aus [Kapitel 8](#8-rechtekatalog-des-produkts) und ergänzt
  die reservierten Namen; `org-admin` erhält automatisch alle Rechte.
- Design: Die Frontend-Bausteine bringen kein eigenes Aussehen mit, nur Struktur und Verhalten; sie nutzen
  CSS-Variablen (`--iam-accent`, `--iam-surface`, `--iam-text`, `--iam-radius`, …), die die App aus ihren Design-Tokens
  setzt (Vorgaben des Pakets in `@layer iam`, damit die Werte der App immer gewinnen), und optional eigene Komponenten für Knopf, Dialog, Tabelle, Menü (`components`-Prop).
- Texte: Baukasten-Texte de/en mit Schlüsseln (`iam.*`); die App überschreibt einzelne Schlüssel und liefert weitere
  Sprachen. Labels des Katalogs kommen aus dem Katalog je Sprache: `GET /v1/authz/catalog` richtet sich nach
  `Accept-Language` (`Vary: Accept-Language`), die Oberfläche nimmt die Sprache in den Cache-Schlüssel.
- `/auth/me` liefert `grantedPermissions` immer (leer ohne Freigaben), weil «Recht irgendwo» davon abhängt.
- Apps in anderen Sprachen (nicht Node): Vertrag und Realm-Modul gelten unverändert; Backend nach Kapitel 5–10 selbst
  umsetzen und mit den Konformitätstests des Test-Kits gegen die laufende App abnehmen. KANN später: BFF und
  Token-Prüfung als eigener Dienst (Sidecar) vor der App.

### 15.3 Ausrollen

1. **Anbindung** an identity ([Kapitel 2](#2-anbindung-an-die-identity-plattform), Schritte 1–2, 5).
2. `npx create-iam-app` im Repository der App: Gerüst nach 15.1; danach Katalog und Ressourcen füllen.
3. Realm: Bootstrap und `kc.sh apply` mit dem Modul (Schritte 3–6).
4. Pakete einbinden (Backend, Frontend), Migration ausführen, Konfiguration und Geheimnisse ([Kapitel 13](#13-konfiguration-und-geheimnisse)).
5. Erste Organisation mit `org-bootstrap` (im Backend-Paket enthalten).
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
| P2 | Realm | Einstellungen, Richtlinien, Clients, Mapper, Scopes, Rollen nach Kapitel 3; Login, Konto und E-Mails im Theme `identity` mit Name, Claim und Akzent des Produkts |
| P3 | Keine Geheimnisse | alle vertraulichen Clients `private_key_jwt`; kein Client-Geheimnis im State; jeder Dienst nur seine Schlüssel |
| P4 | Anmeldung | Code-Flow mit PKCE, keine Tokens im Browser, CSRF, Fixation, Erneuerung, RP- und Backchannel-Logout, `/abgemeldet` |
| P5 | Mandant | nur aus dem Token; `X-Tenant` nur eigene; Bindung an `kc_org_id`; gesperrt → 403; Alias ASCII |
| P6 | Mehrere Organisationen | `organization:*`, Organisation je Tab, Wechsel ohne Anmeldung, Rollen nur der gewählten Organisation |
| P7 | Rechte | (Rolle ∨ Freigabe) ∧ Scope ∧ kein Verbot/keine Beschränkung, Personen mit `org-admin` ausgenommen, Wirkungszeiten, 403 mit Label, `can` je Ressource, Simulation |
| P8 | Eine Quelle | `GET /v1/authz/catalog`; Oberfläche ohne eigene Listen (Test); `platform.json` aktuell (Test); reservierte Namen und Schlüsselregeln eingehalten (Test) |
| P9 | Verwaltung | Regeln 9.1 (1–11) mit Tests; Einladen gleich für neu und bestehend inkl. Antwortzeit |
| P9a | Eigene Rollen | Regeln aus [8.3](#83-eigene-rollen-der-organisation) mit Tests, insbesondere keine Rechte nur von `org-admin` und Grabstein beim Löschen |
| P10 | Abgleich | Worker mit `<produkt>-sync`, `removed_at`, Alias und `kc_org_id` |
| P11 | Datenbank | Rollen ohne `BYPASSRLS`, FORCE RLS auf allen Tabellen mit `tenant_id` (Test), zusammengesetzte Fremdschlüssel |
| P12 | Oberfläche | `MissingRight`, Routen-Guards, «Meine Rollen und Rechte», Rollenmatrix, Verwalten-Seiten nach Muster; 390 px, hell/dunkel, axe |
| P13 | Maschinen-Clients | DPoP-Pflicht über `<produkt>.m2m`, Freigabe je Mandant, ohne Freigabe 403 |
| P14 | Isolation | Routen-Durchlauf über alle `/v1`-Routen grün, Inventar der Mandantentrennung vollständig |
| P15 | Baukasten | App nutzt Modul und Pakete in einer gepinnten Version, ohne Kopien; lokal nur Katalog, Ressourcen, Design-Tokens, Texte; Konformitätstests des Test-Kits grün |

## 17. Grenzen und Restrisiken

Übernommen aus vollholz/assets und vollholz/identity; gelten für jedes Produkt, bis sie eigens entschieden werden.

| Thema | Grenze bzw. Restrisiko | Umgang |
|---|---|---|
| `manage-realm` der Service Accounts | Keycloak 26 kennt keine Rechte je Organisation; wer den Schlüssel von `-admin` hat, beherrscht faktisch den Realm des Produkts (nicht andere Realms) | eigener Realm, Schlüssel nur im API-Prozess, kurze Tokens, Admin-Ereignisse, Audit der App; Admin-Ereignisse ausserhalb `organizations`, `users`, `groups` überwachen; ersetzen, sobald FGAP v2 Organisationen kennt |
| `create-realm` von `<produkt>-tofu` | fast Realm-Admin am eigenen Realm, dauerhaft; kann weitere Realms anlegen | Schlüssel nur lokal, Admin-Ereignisse im Realm `master` (identity) |
| `/admin` und `/realms/master` öffentlich | Abweichung von der Empfehlung von Keycloak, nötig für IaC aus GitHub Actions | identity › Bewusste Restrisiken |
| Zwischenspeicher | Entzug einer Client-Freigabe wirkt auf anderen Instanzen nach ≤ 60 s, Entfernen einer Person nach ≤ 5 min | kurze Laufzeiten; neue Tokens nach dem Austritt nötig |
| Einladungen an bestehende Konten | Link von Keycloak lässt sich nicht widerrufen; Annahme nach Rückzug ergibt Mitglied ohne Rollen | Verwaltung kann entfernen |
| Maschinen-Clients | nur über die Keycloak-Konsole nach Vorlage | Freigabe in der App |
| Sicherheitsfunktionen der Datenbank | `resolve_tenant` und Plattform-Funktionen für die ganze Laufzeit-Rolle ausführbar (Schutz in der API) | kein beliebiges SQL (SQL-Injection geprüft); eigene Rolle als offener Punkt |
| Organisation löschen | Alias könnte neu vergeben werden | sperren statt löschen; Bindung an `kc_org_id` |
| Erste Anmeldung | Bindung einer leeren `kc_org_id` beim ersten Kontakt | bewusst (assets E11) |

### Offene Entscheide zum Baukasten

| # | Frage | Vorschlag |
|---|---|---|
| B1 | Wo liegt der Baukasten? | **entschieden 2026-10-22:** eigenes Repository `vollholz/identity-kit` (Vertrag, Modul, Pakete, Test-Kit, Vorlage); vollholz/identity bleibt Betrieb der Instanz und verweist darauf |
| B2 | Verteilung | **entschieden 2026-10-22:** npm-Pakete über GitHub Packages (`@vollholz/*`), Modul als Git-Quelle mit Tag (`?ref=<modul>-vX.Y.Z`) |
| B3 | Frameworks | Backend zuerst nur Fastify, Frontend nur React; weitere Adapter erst bei Bedarf |
| B4 | Zugänge neu gegenüber Assets | REST-API, Organisations-Clients (M2M, DPoP, Freigabe) und MCP gibt es in Assets bereits und gehen unverändert in den Baukasten. Neu sind nur `person_api` (Personen direkt an der API, ohne BFF/MCP) und `system_clients` (ein Client für mehrere Organisationen, per IaC); beide erst mit der ersten App, die sie braucht |

Offen und nicht Teil dieser Spezifikation: Identity Brokering zwischen Produkten (Single Sign-on über Realms),
`full_scope_allowed` der Clients (assets Nr. 101), Kontingente je Mandant, Crypto-Shredding je Mandant.
