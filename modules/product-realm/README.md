# Modul product-realm

OpenTofu-Modul für den Realm einer App auf **https://identity.project-suite.ch** (Keycloak 26.8.1): Realm-Einstellungen,
Client-Richtlinien, Clients, Mapper, Scopes, Rechte der Service Accounts, Texte. Jede App
ruft es auf, statt IaC zu kopieren. Spezifikation [Kap. 2, 3, 12, 15](../../docs/spezifikation.md#3-realm-des-produkts).
Herausgelöst aus vollholz/assets `infra/keycloak` (`3a148ae`); für Assets ergibt der Aufruf denselben Realm
([Nachweis](#nachweis)).

Anlage des Realms und des IaC-Clients: Modul [product-realm-bootstrap](../product-realm-bootstrap/README.md).

**Version** in [`VERSION`](VERSION) (1.0.0); Git-Quelle mit Tag `product-realm-v<version>` (Spezifikation B2).

## Voraussetzungen

- OpenTofu `~> 1.13.1`, Provider `keycloak/keycloak` **5.9.0** und `hashicorp/external` **2.4.2** (Lockfile im
  Repository der App).
- Node 24 beim Plan und Apply: `scripts/lookup.ts` (IDs eingebauter Clients) und `scripts/org-mapper.ts`
  (Organisations-Mapper) sprechen die Admin-API an, ohne Abhängigkeiten.
- Anmeldung als IaC-Client `<produkt>-iac` (Service Account mit `realm-management/realm-admin`, Spezifikation Kap. 2
  Schritt 5) nur aus der Umgebung, wie `kc.sh` in Assets sie setzt: `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`,
  `KEYCLOAK_JWT_SIGNING_KEY` für den Provider und `KEYCLOAK_IAC_PRIVATE_KEY` (PEM) für die Hilfsskripte. Nichts davon
  steht in der Konfiguration oder im gespeicherten Plan.
- Backend, State-Verschlüsselung (`TF_STATE_PASSPHRASE`) und Provider-Block gehören dem Aufrufer.

## Eingaben

| Eingabe | Typ | Vorgabe | Bedeutung |
|---|---|---|---|
| `product` | string | – | technischer Name `<produkt>` (`^[a-z][a-z0-9-]{1,30}[a-z0-9]$`); alle Namen folgen daraus (unten) |
| `display_name` | string | – | Anzeigename `<Produkt>`: Realm, Theme, Namen der Clients, Texte der Scopes, SMTP-Absender, Betreff der Einladung |
| `public_base_url` | string | – | Adresse der Oberfläche (`PUBLIC_BASE_URL`); daraus Redirect, Web-Origin, Logout-Adressen von `<produkt>-platform` |
| `catalog` | object | – | Scopes aus dem Modell der App: `scopes = [<scope>, …]`. Rollen gibt es hier nicht mehr (Rollen liegen in der App-Datenbank) |
| `jwks` | map(string) | – | öffentliche Schlüssel (Inhalt von `keys/<produkt>-<client>.json`) für `platform`, `admin`, `sync` und mit `mcp` auch `mcp`; je genau ein EC-P-256-Schlüssel mit `kid`, ohne privaten Teil |
| `theme_texts` | map(map(string)) | `{}` | Werte des Themes `identity` je Sprache (`themeAccent…` nur `#RRGGBB`, `themeClaim`, `themeClaimSub`, `themeChips`, `themeSub.<Seite>`, `themeMailFooter`, kurze Login-Titel); überschreiben alle anderen Texte |
| `localization` | map(map(string)) | `{}` | weitere Realm-Texte der App je Sprache; überschreiben die Standardtexte |
| `standard_texts` | bool | `true` | Texte des Baukastens ([texts/](texts/README.md)): Login, E-Mails und Kontoverwaltung in Du-Form (de), Einladungs-E-Mail (de, en) |
| `supported_locales` | list(string) | `["de", "en"]` | Sprachen; die erste ist die Standardsprache. Je Sprache eine Lokalisierung |
| `smtp` | object | `null` | ausgehende Mails über das **eigene Konto des Produkts**: `host`, `from`, `user` Pflicht (keine Vorgaben, damit keine App stillschweigend das Postfach einer anderen nutzt); `port` 587, `starttls` an, `ssl` aus, `reply_to` leer, `from_display_name` = `display_name` als Vorgaben. `null`: kein SMTP |
| `smtp_password` | string, sensitiv | `""` | nur aus der Umgebung (`TF_VAR_smtp_password`); ist SMTP gesetzt und fehlt das Passwort, bricht der Plan ab |
| `m2m` | bool | `false` | Maschinen-Clients der Organisationen (Kap. 12.1): Richtlinie `<produkt>-m2m-dpop` |
| `mcp` | bool | `false` | MCP-Dienst (Kap. 12.2): `<produkt>-mcp`, `<produkt>-mcp-cli`, Scope `<produkt>-mcp`, `offline_access` für `<produkt>-mcp-cli` |
| `mcp_cli_callback_port` | number | `8765` | fester Loopback-Port von `<produkt>-mcp-cli` |
| `mcp_extra_redirect_uris` | list(string) | `[]` | weitere Weiterleitungen von `<produkt>-mcp-cli`, z. B. `https://claude.ai/api/mcp/auth_callback` |
| `entra` | bool | `false` | Anmeldung über Entra ID (Kap. 9.4): `manage-identity-providers` für `<produkt>-admin`, Ablauf `<produkt>-entra-first-login`, Claim `identity_provider`, Weiterleitung `/auth/entra/*` |
| `entra_deny_message` | string | Du-Form | Meldung für nicht vorab verknüpfte Microsoft-Konten |
| `realm` | string | `product` | Realm, falls er anders heisst als das Produkt (nie `master`, `project-suite`) |
| `iac_client_id` | string | `<produkt>-iac` | IaC-Client, mit dem die Hilfsskripte sich anmelden |
| `keycloak_url`, `keycloak_base_path` | string | `https://identity.project-suite.ch`, `""` | Instanz für Issuer und Hilfsskripte (wie der Provider) |

Noch nicht: `person_api` und `system_clients` (Spezifikation B4, erst mit der ersten App, die sie braucht).

## Ausgaben

| Ausgabe | Inhalt |
|---|---|
| `realm` | Name des Realms |
| `issuer` | `OIDC_ISSUER_URL` der App |
| `clients` | `{ bff, api, admin, sync, mcp, mcp_cli }` (Client-IDs; `mcp`, `mcp_cli` ohne `mcp` = `null`) |
| `service_account_user_ids` | `{ admin, sync }` – Benutzer-IDs der Service Accounts |

## Was angelegt wird

Namen aus `product`; ✓ immer, sonst mit dem Schalter.

| Bereich | Inhalt |
|---|---|
| Realm ✓ | Einstellungen nach Kap. 3.1 (Organisationen, Passwort-Richtlinie, Token und Sitzungen, «Angemeldet bleiben», Offline-Sitzungen 30/90 Tage (immer), Brute-Force, `admin_permissions_enabled`, Theme `identity`, Sprachen, SMTP), Ereignisse 30 Tage |
| Richtlinien | `<produkt>-code-flow` ✓, `<produkt>-confidential` ✓, `<produkt>-m2m-dpop` (`m2m`; Bedingung Attribut `<produkt>.m2m = true`) |
| Clients | `<produkt>-api` ✓, `<produkt>-platform` ✓, `<produkt>-admin` ✓, `<produkt>-sync` ✓, `<produkt>-mcp` und `<produkt>-mcp-cli` (`mcp`); alle mit `<produkt>.platform = true`, vertrauliche mit `private_key_jwt` (ES256, JWKS aus `jwks`) |
| Mapper | `aud-api` an den Personen-Clients, `entra-groups` an `<produkt>-platform` (`entra`; Benutzerattribut `entra_groups` → Claim `groups`, siehe [Gruppen aus Entra](#gruppen-aus-entra)), `aud-mcp` am Scope `<produkt>-mcp`, `identity-provider` (`entra`); Organisations-Mapper über `org-mapper.ts` |
| Scopes | je Scope des Katalogs ein Client-Scope «<Produkt>: <scope>» ✓; vollständige Listen der Standard- und optionalen Scopes je Client |
| Rollen ✓ | nur die Realm-Rolle `platform-admin`; keine Client-Rollen, keine Gruppe `/orgs` (Rollen der App: App-Datenbank) |
| Service Accounts ✓ | `manage-realm` für `-admin` und `-sync`; FGAP v2 «`<produkt>-admin`: Benutzer» (Mitgliederverwaltung; keine Rechte auf Gruppen) mit Richtlinie «`<produkt>-admin`: Service Account» (`UNANIMOUS`); `manage-identity-providers` (`entra`) |
| Texte ✓ | eine Lokalisierung je Sprache: Standardtexte, dann `localization`, dann `theme_texts` |

Assets (alle Schalter an, 17 Scopes): 57 Ressourcen. Ohne Schalter mit 2 Scopes: 23. (Vor 1.0.0 mit Rollen, Gruppe `/orgs` und Gruppenrecht: 68 bzw. 29.)

## Aufruf

`infra/keycloak` einer neuen App (die Vorlage `create-iam-app` legt das an):

```hcl
# versions.tf
terraform {
  required_version = "~> 1.13.1"
  required_providers {
    keycloak = { source = "keycloak/keycloak", version = "5.9.0" }
    external = { source = "hashicorp/external", version = "2.4.2" }
  }
  backend "s3" {}
  encryption { … wie in Assets infra/keycloak/versions.tf (TF_STATE_PASSPHRASE) … }
}

# Anmeldung nur aus der Umgebung (kc.sh): KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID=<produkt>-iac, KEYCLOAK_JWT_SIGNING_KEY
provider "keycloak" {
  url             = var.keycloak_url
  base_path       = var.keycloak_base_path
  jwt_signing_alg = "ES256"
}
```

```hcl
# main.tf
# Den Realm hat product-realm-bootstrap angelegt; hier wird er übernommen (ohne Wirkung, wenn er schon im State ist).
# import-Blöcke gehen nur im Root, nicht im Modul.
import {
  to = module.realm.keycloak_realm.this
  id = "notes"
}

module "realm" {
  source = "git::https://github.com/vollholz/identity-kit.git//modules/product-realm?ref=product-realm-v1.0.0"

  product            = "notes"
  display_name       = "Notes"
  public_base_url    = "https://notes.project-suite.ch"
  keycloak_url       = var.keycloak_url
  keycloak_base_path = var.keycloak_base_path

  catalog     = jsondecode(file("${path.module}/platform.json"))
  theme_texts = jsondecode(file("${path.module}/localization-theme.json"))
  jwks        = { for c in ["platform", "admin", "sync"] : c => file("${path.module}/keys/notes-${c}.json") }

  smtp = {
    host = "mail.infomaniak.com"
    from = "noreply@notes.project-suite.ch"
    user = "noreply@notes.project-suite.ch"
  }
  smtp_password = var.smtp_password

  m2m = true
}

output "issuer" {
  value = module.realm.issuer
}
```

Danach `kc.sh init && kc.sh apply`; ein zweiter `kc.sh plan` zeigt «No changes».

`kc.sh` wie in Assets, mit einer Änderung: Der SMTP-Test liegt nach `tofu init` im Modul. Alle Hilfsskripte lesen
dieselben Angaben (`KEYCLOAK_URL` mit Basispfad, `KEYCLOAK_REALM`, `KEYCLOAK_IAC_CLIENT_ID`,
`KEYCLOAK_IAC_PRIVATE_KEY`); `lookup.ts` und `org-mapper.ts` erhalten die ersten drei vom Modul, den SMTP-Test ruft
`kc.sh` so auf:

```bash
smtp-test) login_iac
  KEYCLOAK_URL="$KEYCLOAK_TF_URL" KEYCLOAK_IAC_CLIENT_ID="$KEYCLOAK_CLIENT_ID" \
    exec node .terraform/modules/realm/modules/product-realm/scripts/smtp-test.ts "$@" ;;
```

Neue Version des Moduls: `ref` erhöhen, `kc.sh init -upgrade`, Plan prüfen und freigeben.

## Umstellung einer bestehenden App

Eine App, deren Realm schon mit eigener IaC nach Assets-Muster läuft, stellt ohne Neuanlage um:

1. `infra/keycloak/*.tf` mit Realm-Inhalt durch den Modulaufruf ersetzen; `versions.tf` (Backend, Verschlüsselung,
   Provider) und den State-Key behalten. Den `import`-Block auf `module.realm.keycloak_realm.this` umstellen.
2. `moved`-Blöcke für jede Ressource (Liste für Assets unten). Schlüssel, die sich ändern: Service Accounts
   `service["<produkt>-admin"]` → `service["admin"]`, Schalter-Ressourcen erhalten `[0]`, Lokalisierungen
   `keycloak_realm_localization.<sprache>` → `keycloak_realm_localization.this["<sprache>"]`.
3. Entfällt in der App: `lookup.ts`, `org-mapper.ts`, `localization-de*.json`, `localization-account-de*.json`,
   `localization-invite.json` (im Modul), die Tests dieser Texte. Es bleiben `platform.json`, `platform.ts`,
   `localization-theme.json`, `keys/`, `kc.sh` (SMTP-Test aus dem Modul, [Aufruf](#aufruf)), Test für `platform.json` und
   Schlüssel.
4. `kc.sh init` (Modul holen), `kc.sh plan`: nur Verschiebungen (`# … has moved to module.realm…`) und
   «Plan: 0 to add, 0 to change, 0 to destroy.» – OpenTofu meldet Verschiebungen nicht als «No changes» (Exit 2). Jede
   andere Zeile (`will be updated`, `must be replaced`, `will be created`) ist ein Unterschied und vor dem Apply zu klären.
   Ab 1.0.0 neu und gewollt: Gelöscht werden die Client-Rollen von `<produkt>-platform`, die Gruppe `/orgs`, der Mapper `groups` und das
   Gruppenrecht «`<produkt>-admin`: Gruppen» (Rollen liegen in der App-Datenbank); der Plan zeigt dafür `will be destroyed`, und mit `entra` entsteht `entra-groups`.
5. Apply nach Freigabe (schreibt nur den State), Kontrollplan: «No changes». Ebenso für `bootstrap/`.

### Assets

Die Liste prüft `modules/test/keycloak.sh` gegen Keycloak 26.8.1 (`modules/test/roots/assets/moved.tf`); ein Test hält
sie hier gleich. Für die Client-Rollen, die Gruppe `/orgs`, den Mapper `groups` und das Gruppenrecht gibt es seit 1.0.0 keinen `moved`-Block;
sie entfallen mit dem Apply.

`infra/keycloak/moved.tf` (Aufruf als `module "realm"` mit `m2m`, `mcp`, `entra` = `true`,
`mcp_extra_redirect_uris = ["https://claude.ai/api/mcp/auth_callback"]`, `smtp = { host = "mail.infomaniak.com",
from = "noreply@project-suite.ch", user = "noreply@project-suite.ch" }`):

```hcl
moved {
  from = keycloak_realm.assets
  to   = module.realm.keycloak_realm.this
}
moved {
  from = keycloak_realm_events.assets
  to   = module.realm.keycloak_realm_events.this
}

# policies.tf
moved {
  from = keycloak_realm_client_policy_profile.code_flow
  to   = module.realm.keycloak_realm_client_policy_profile.code_flow
}
moved {
  from = keycloak_realm_client_policy_profile.confidential
  to   = module.realm.keycloak_realm_client_policy_profile.confidential
}
moved {
  from = keycloak_realm_client_policy_profile.m2m_dpop
  to   = module.realm.keycloak_realm_client_policy_profile.m2m_dpop[0]
}
moved {
  from = keycloak_realm_client_policy_profile_policy.code_flow
  to   = module.realm.keycloak_realm_client_policy_profile_policy.code_flow
}
moved {
  from = keycloak_realm_client_policy_profile_policy.confidential
  to   = module.realm.keycloak_realm_client_policy_profile_policy.confidential
}
moved {
  from = keycloak_realm_client_policy_profile_policy.m2m_dpop
  to   = module.realm.keycloak_realm_client_policy_profile_policy.m2m_dpop[0]
}

# clients.tf
moved {
  from = keycloak_openid_client.api
  to   = module.realm.keycloak_openid_client.api
}
moved {
  from = keycloak_openid_client.platform
  to   = module.realm.keycloak_openid_client.platform
}
moved {
  from = keycloak_openid_client.mcp
  to   = module.realm.keycloak_openid_client.mcp[0]
}
moved {
  from = keycloak_openid_client.mcp_cli
  to   = module.realm.keycloak_openid_client.mcp_cli[0]
}
moved {
  from = keycloak_openid_audience_protocol_mapper.aud_api
  to   = module.realm.keycloak_openid_audience_protocol_mapper.aud_api
}
moved {
  from = keycloak_openid_client_default_scopes.platform
  to   = module.realm.keycloak_openid_client_default_scopes.platform
}
moved {
  from = keycloak_openid_client_optional_scopes.platform
  to   = module.realm.keycloak_openid_client_optional_scopes.platform
}
moved {
  from = keycloak_openid_client_default_scopes.mcp
  to   = module.realm.keycloak_openid_client_default_scopes.mcp[0]
}
moved {
  from = keycloak_openid_client_optional_scopes.mcp
  to   = module.realm.keycloak_openid_client_optional_scopes.mcp[0]
}
moved {
  from = keycloak_openid_client_default_scopes.mcp_cli
  to   = module.realm.keycloak_openid_client_default_scopes.mcp_cli[0]
}
moved {
  from = keycloak_openid_client_optional_scopes.mcp_cli
  to   = module.realm.keycloak_openid_client_optional_scopes.mcp_cli[0]
}
moved {
  from = keycloak_role.platform_admin
  to   = module.realm.keycloak_role.platform_admin
}

# admin.tf (Schlüssel der Service Accounts: admin, sync statt der Client-ID)
moved {
  from = keycloak_openid_client.service["assets-admin"]
  to   = module.realm.keycloak_openid_client.service["admin"]
}
moved {
  from = keycloak_openid_client.service["assets-sync"]
  to   = module.realm.keycloak_openid_client.service["sync"]
}
moved {
  from = keycloak_openid_client_service_account_role.manage_realm["assets-admin"]
  to   = module.realm.keycloak_openid_client_service_account_role.manage_realm["admin"]
}
moved {
  from = keycloak_openid_client_service_account_role.manage_realm["assets-sync"]
  to   = module.realm.keycloak_openid_client_service_account_role.manage_realm["sync"]
}
moved {
  from = keycloak_openid_client_client_policy.admin_service_account
  to   = module.realm.keycloak_openid_client_client_policy.admin_service_account
}
moved {
  from = keycloak_openid_client_authorization_permission.admin
  to   = module.realm.keycloak_openid_client_authorization_permission.admin
}

# scopes.tf
moved {
  from = keycloak_openid_client_scope.permission
  to   = module.realm.keycloak_openid_client_scope.permission
}
moved {
  from = keycloak_openid_client_scope.mcp
  to   = module.realm.keycloak_openid_client_scope.mcp[0]
}
moved {
  from = keycloak_openid_audience_protocol_mapper.mcp_scope_audience
  to   = module.realm.keycloak_openid_audience_protocol_mapper.mcp_scope_audience[0]
}
moved {
  from = terraform_data.organization_mapper
  to   = module.realm.terraform_data.organization_mapper
}

# entra.tf
moved {
  from = keycloak_openid_client_service_account_role.manage_identity_providers
  to   = module.realm.keycloak_openid_client_service_account_role.manage_identity_providers[0]
}
moved {
  from = keycloak_authentication_flow.entra_first_login
  to   = module.realm.keycloak_authentication_flow.entra_first_login[0]
}
moved {
  from = keycloak_authentication_execution.entra_first_login_deny
  to   = module.realm.keycloak_authentication_execution.entra_first_login_deny[0]
}
moved {
  from = keycloak_authentication_execution_config.entra_first_login_deny
  to   = module.realm.keycloak_authentication_execution_config.entra_first_login_deny[0]
}
moved {
  from = keycloak_openid_user_session_note_protocol_mapper.identity_provider
  to   = module.realm.keycloak_openid_user_session_note_protocol_mapper.identity_provider
}

# localization.tf
moved {
  from = keycloak_realm_localization.de
  to   = module.realm.keycloak_realm_localization.this["de"]
}
moved {
  from = keycloak_realm_localization.en
  to   = module.realm.keycloak_realm_localization.this["en"]
}
```

`infra/keycloak/bootstrap/main.tf` (Aufruf als `module "bootstrap"`, `product = "assets"`,
`iac_jwks = file("${path.module}/../keys/assets-iac.json")`):

```hcl
moved {
  from = keycloak_realm.assets
  to   = module.bootstrap.keycloak_realm.this
}
moved {
  from = keycloak_openid_client.iac
  to   = module.bootstrap.keycloak_openid_client.iac
}
```

Der vollständige Aufruf für Assets steht in `modules/test/roots/assets/main.tf` (dort mit Testschlüsseln und
lokalem Backend). In Assets heissen die Werte `catalog = jsondecode(file("${path.module}/platform.json"))`,
`theme_texts = jsondecode(file("${path.module}/localization-theme.json"))`, `jwks` aus `keys/assets-<client>.json`.

### Unterschiede zu Assets infra/keycloak

Ergebnis in Keycloak gleich (Nachweis unten); anders ist nur der Aufbau:

- Teile hinter Schaltern: `m2m` (DPoP-Richtlinie), `mcp` (MCP-Clients, -Scope), `entra` (inkl. Weiterleitung
  `/auth/entra/*` am BFF-Client). Offline-Sitzungen (30/90 Tage) setzt das Modul immer.
- SMTP ist ohne Angabe aus (`smtp = null`); Assets nennt Server, Absender und Konto im Aufruf (oben), Anzeigename ist
  `display_name`.
- `lookup.ts` und `org-mapper.ts` erhalten Instanz, Realm und IaC-Client aus dem Modul; aus der Umgebung kommt nur der
  private Schlüssel (`KEYCLOAK_IAC_PRIVATE_KEY`). Am `kc.sh` von Assets ändert sich nur der Aufruf des SMTP-Tests
  ([Aufruf](#aufruf)).
- Der Betreff der Einladungs-E-Mail nennt `display_name` statt fest «Assets».

### Gruppen aus Entra

Keycloak kennt keine Rollen der App; Gruppen kommen nur aus Entra (Subjekt `group:<objekt-id>`). Mit `entra` legt das
Modul am Client `<produkt>-platform` den Mapper `entra-groups` an (Typ Benutzerattribut, `user_attribute = entra_groups`,
`claim_name = groups`, mehrwertig, Access Token, Userinfo, Introspection). Die Anbieter `entra-NNN` legt zur Laufzeit die
App an (`packages/iam` `idpRepresentation()`); sie legt dazu je Anbieter den Mapper `entra-groups` an:

| Feld | Wert |
|---|---|
| `name` | `entra-groups` |
| `identityProviderMapper` | `oidc-user-attribute-idp-mapper` |
| `identityProviderAlias` | Alias des Anbieters (`entra-NNN`) |
| `config.claim` | `groups` |
| `config.user.attribute` | `entra_groups` |
| `config.syncMode` | `FORCE` (bei jeder Anmeldung überschreiben) |

Voraussetzungen ausserhalb des Moduls: In der Entra-App-Registrierung muss der Gruppen-Claim im ID-Token stehen
(Objekt-IDs); das Benutzerattribut `entra_groups` muss im User Profile des Realms zulässig sein.

## Hilfsskripte

| Skript | Wofür |
|---|---|
| `scripts/lookup.ts` | interne ID von `realm-management` und `admin-permissions` (data `external`), ohne das Client-Secret zu lesen (ab 26.8 403) |
| `scripts/org-mapper.ts` | gleicht den von Keycloak angelegten Mapper im Scope `organization` an (`terraform_data`, idempotent) |
| `scripts/smtp-test.ts` | Testmail über die gespeicherten SMTP-Einstellungen (`<empfänger> [--env-password] [--user=<name>]`) |
| `scripts/admin-api.ts` | gemeinsame Anmeldung als IaC-Client (`private_key_jwt`, ES256) |

## Nachweis

| Prüfung | Befehl | Keycloak |
|---|---|---|
| Format, Validierung, tflint | `tofu fmt -check -recursive modules`, je Modul `tofu init -backend=false && tofu validate`, `tflint --config ../.tflint.hcl` | nein |
| Modultests (Namen, Schalter, Texte, Validierungen; Provider nachgebildet) | je Modul `tofu test` | nein |
| Texte, Hilfsskripte, `moved`-Liste | `node --test modules/product-realm/test/*.test.ts modules/test/*.test.ts` | nein |
| **gleiches Ergebnis wie Assets, frische Anlage** | `modules/test/keycloak.sh` | Docker, 26.8.1 |

`keycloak.sh` legt in einer Wegwerf-Instanz Assets wie in Produktion an (`assets-tofu` nur mit `create-realm` →
Bootstrap → `realm-admin` für `assets-iac` → `infra/keycloak` von `3a148ae` aus `modules/test/fixtures`), plant dann
denselben State mit dem Modul und den `moved`-Blöcken (Verschiebungen; zusätzlich entfallen die Rollen, die Gruppe `/orgs`, der Mapper `groups` und das Gruppenrecht; neu `entra-groups`), wendet sie an und plant erneut («No
changes»). Danach zwei frische Produkte mit beiden Modulen, einmal mit allen Schaltern, einmal ohne; der zweite Plan
zeigt je «No changes». Workflow: `.github/workflows/modules.yml`.
