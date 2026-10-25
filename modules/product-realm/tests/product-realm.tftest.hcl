# Tests ohne Keycloak (tofu test, Provider nachgebildet): Namen aus product, Schalter, Texte, Validierungen. Das
# Verhalten gegen ein echtes Keycloak 26.8.1 prüft modules/test/keycloak.sh.

mock_provider "keycloak" {}

mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = { id = "00000000-0000-0000-0000-000000000001" }
    }
  }
}

variables {
  product         = "beispiel"
  display_name    = "Beispiel"
  keycloak_url    = "https://id.example.ch"
  public_base_url = "https://beispiel.example.ch/"
  catalog = {
    scopes = ["beispiel:read", "notes:write"]
  }
  theme_texts = {
    de = { themeAccent = "#0D6B5B", themeClaim = "Alles an einem Ort." }
  }
  jwks = {
    platform = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"platform\",\"alg\":\"ES256\",\"use\":\"sig\"}]}"
    admin    = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"admin\",\"alg\":\"ES256\",\"use\":\"sig\"}]}"
    sync     = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"sync\",\"alg\":\"ES256\",\"use\":\"sig\"}]}"
  }
}

run "ohne_schalter" {
  command = plan

  assert {
    condition     = keycloak_realm.this.realm == "beispiel" && keycloak_realm.this.display_name == "Beispiel"
    error_message = "Realm und Anzeigename aus product und display_name"
  }
  assert {
    condition = [for c in [keycloak_openid_client.platform, keycloak_openid_client.api, keycloak_openid_client.service["admin"], keycloak_openid_client.service["sync"]] : c.client_id] == [
      "beispiel-platform", "beispiel-api", "beispiel-admin", "beispiel-sync",
    ]
    error_message = "Client-IDs <produkt>-platform, -api, -admin, -sync"
  }
  assert {
    condition     = alltrue([for c in [keycloak_openid_client.platform, keycloak_openid_client.api, keycloak_openid_client.service["admin"]] : c.extra_config["beispiel.platform"] == "true"])
    error_message = "Clients tragen <produkt>.platform = true"
  }
  assert {
    condition     = keycloak_openid_client.platform.extra_config["jwks.string"] == jsonencode(jsondecode(var.jwks.platform)) && keycloak_openid_client.platform.client_authenticator_type == "client-jwt"
    error_message = "private_key_jwt mit dem JWKS aus var.jwks"
  }
  assert {
    condition     = keycloak_openid_client.platform.valid_redirect_uris == toset(["https://beispiel.example.ch/auth/callback"]) && keycloak_openid_client.platform.backchannel_logout_url == "https://beispiel.example.ch/auth/backchannel-logout"
    error_message = "Adressen aus public_base_url (ohne Schrägstrich am Ende), ohne Entra keine /auth/entra/*"
  }
  assert {
    condition     = [keycloak_realm_client_policy_profile_policy.code_flow.name, keycloak_realm_client_policy_profile_policy.confidential.name] == ["beispiel-code-flow", "beispiel-confidential"]
    error_message = "Richtlinien <produkt>-code-flow und <produkt>-confidential"
  }
  assert {
    condition = (length(keycloak_realm_client_policy_profile_policy.m2m_dpop) + length(keycloak_openid_client.mcp) + length(keycloak_openid_client.mcp_cli)
      + length(keycloak_openid_client_scope.mcp) + length(keycloak_authentication_flow.entra_first_login)
      + length(keycloak_openid_client_service_account_role.manage_identity_providers) + length(keycloak_openid_user_session_note_protocol_mapper.identity_provider)
    + length(keycloak_openid_user_attribute_protocol_mapper.entra_groups) + length(keycloak_realm_user_profile.entra)) == 0
    error_message = "Ohne Schalter weder M2M-Richtlinie noch MCP noch Entra"
  }
  assert {
    condition     = keys(keycloak_openid_audience_protocol_mapper.aud_api) == ["platform"]
    error_message = "aud-api nur am BFF-Client"
  }
  assert {
    condition     = keycloak_role.platform_admin.name == "platform-admin"
    error_message = "Realm-Rolle platform-admin; keine Client-Rollen, keine Gruppe /orgs mehr"
  }
  assert {
    condition     = keys(keycloak_openid_client_authorization_permission.admin) == ["users"]
    error_message = "FGAP v2 für <produkt>-admin nur auf Benutzer, nicht auf Gruppen"
  }
  assert {
    condition     = keycloak_openid_client_scope.permission["notes:write"].description == "Beispiel: notes:write"
    error_message = "Rechte-Scopes aus catalog.scopes mit Text «<Produkt>: <scope>»"
  }
  assert {
    condition     = length(keycloak_realm.this.smtp_server) == 0
    error_message = "Ohne smtp kein SMTP"
  }
  assert {
    condition     = keycloak_realm.this.offline_session_idle_timeout == "720h" && keycloak_realm.this.offline_session_max_lifespan_enabled && keycloak_realm.this.offline_session_max_lifespan == "2160h"
    error_message = "Offline-Sitzungen auch ohne MCP begrenzt (30/90 Tage)"
  }
  assert {
    condition     = keys(keycloak_realm_localization.this) == ["de", "en"]
    error_message = "Eine Lokalisierung je Sprache"
  }
  assert {
    condition = (keycloak_realm_localization.this["de"].texts["executeActionsSubject"] == "Einladung zu Beispiel"
      && keycloak_realm_localization.this["en"].texts["executeActionsSubject"] == "Invitation to Beispiel"
    && keycloak_realm_localization.this["de"].texts["themeClaim"] == "Alles an einem Ort.")
    error_message = "Einladung mit display_name, Theme-Texte je Sprache"
  }
  assert {
    condition     = output.issuer == "https://id.example.ch/realms/beispiel" && output.clients.mcp == null
    error_message = "Ausgaben"
  }
}

run "alle_schalter" {
  command = plan

  variables {
    m2m                     = true
    mcp                     = true
    entra                   = true
    mcp_extra_redirect_uris = ["https://claude.ai/api/mcp/auth_callback"]
    smtp                    = { host = "smtp.example.ch", from = "noreply@example.ch", user = "noreply@example.ch" }
    smtp_password           = "nur-fuer-den-test"
    jwks = {
      platform = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"platform\"}]}"
      admin    = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"admin\"}]}"
      sync     = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"sync\"}]}"
      mcp      = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"mcp\"}]}"
    }
  }

  assert {
    condition     = toset([for a in keycloak_realm_user_profile.entra[0].attribute : a.name]) == toset(["username", "email", "firstName", "lastName", "entra_groups"])
    error_message = "User Profile: Standardattribute von Keycloak bleiben, dazu entra_groups"
  }
  assert {
    condition     = one([for a in keycloak_realm_user_profile.entra[0].attribute : a if a.name == "entra_groups"]).multi_valued && one([for a in keycloak_realm_user_profile.entra[0].attribute : a if a.name == "entra_groups"]).permissions[0].edit == toset(["admin"]) && one([for a in keycloak_realm_user_profile.entra[0].attribute : a if a.name == "entra_groups"]).permissions[0].view == toset(["admin"])
    error_message = "entra_groups: mehrwertig, nur admin sieht und ändert"
  }
  assert {
    condition     = keycloak_openid_user_attribute_protocol_mapper.entra_groups[0].user_attribute == "entra_groups" && keycloak_openid_user_attribute_protocol_mapper.entra_groups[0].claim_name == "groups" && keycloak_openid_user_attribute_protocol_mapper.entra_groups[0].multivalued
    error_message = "Mapper entra-groups: Benutzerattribut entra_groups (mehrwertig) → Claim groups am BFF-Client"
  }
  assert {
    condition     = keycloak_openid_client.mcp[0].client_id == "beispiel-mcp" && keycloak_openid_client.mcp_cli[0].client_id == "beispiel-mcp-cli" && keycloak_openid_client_scope.mcp[0].name == "beispiel-mcp"
    error_message = "MCP-Clients und Scope <produkt>-mcp"
  }
  assert {
    condition     = contains(keycloak_openid_client.mcp_cli[0].valid_redirect_uris, "http://localhost:8765/callback") && contains(keycloak_openid_client.mcp_cli[0].valid_redirect_uris, "https://claude.ai/api/mcp/auth_callback")
    error_message = "Weiterleitungen des öffentlichen MCP-Clients"
  }
  assert {
    condition     = keycloak_realm_client_policy_profile_policy.m2m_dpop[0].name == "beispiel-m2m-dpop" && strcontains(keycloak_realm_client_policy_profile_policy.m2m_dpop[0].condition[0].configuration["attributes"], "beispiel.m2m")
    error_message = "DPoP-Pflicht über <produkt>.m2m"
  }
  assert {
    condition     = keys(keycloak_openid_user_session_note_protocol_mapper.identity_provider) == ["mcp", "mcp_cli", "platform"] && keys(keycloak_openid_audience_protocol_mapper.aud_api) == ["mcp", "platform"]
    error_message = "Mapper an allen Personen-Clients"
  }
  assert {
    condition     = contains(keycloak_openid_client.platform.valid_redirect_uris, "https://beispiel.example.ch/auth/entra/*") && keycloak_authentication_flow.entra_first_login[0].alias == "beispiel-entra-first-login"
    error_message = "Entra: Weiterleitung und Ablauf"
  }
  assert {
    condition     = keycloak_realm.this.smtp_server[0].from_display_name == "Beispiel" && keycloak_realm.this.smtp_server[0].host == "smtp.example.ch" && keycloak_realm.this.smtp_server[0].port == "587"
    error_message = "SMTP des Produkts, Absendername = display_name, Port und STARTTLS als Vorgabe"
  }
}

run "ohne_standardtexte" {
  command = plan

  variables {
    standard_texts    = false
    supported_locales = ["de"]
    localization      = { de = { loginAccountTitle = "Anmelden" } }
  }

  assert {
    condition     = keys(keycloak_realm_localization.this) == ["de"] && keycloak_realm_localization.this["de"].texts == tomap({ loginAccountTitle = "Anmelden", themeAccent = "#0D6B5B", themeClaim = "Alles an einem Ort." })
    error_message = "Nur Texte der App und des Themes"
  }
}

run "smtp_ohne_passwort" {
  command = plan

  variables {
    smtp = { host = "smtp.example.ch", from = "noreply@example.ch", user = "noreply@example.ch" }
  }

  expect_failures = [keycloak_realm.this]
}

# Keine Vorgaben für Server und Konto: nie stillschweigend das Postfach einer anderen App
run "smtp_ohne_konto" {
  command = plan

  variables {
    smtp          = { from = "noreply@example.ch" }
    smtp_password = "nur-fuer-den-test"
  }

  expect_failures = [var.smtp]
}

run "mcp_ohne_schluessel" {
  command = plan

  variables {
    mcp = true
  }

  expect_failures = [keycloak_openid_client.mcp]
}

run "realm_master" {
  command = plan

  variables {
    realm = "master"
  }

  expect_failures = [var.realm]
}

# Ohne realm ist product der Realm-Name
run "product_master" {
  command = plan

  variables {
    product = "master"
  }

  expect_failures = [var.product]
}

run "product_beliebiger_name" {
  command = plan

  variables {
    product = "plattform"
  }

  assert {
    condition     = output.issuer == "https://id.example.ch/realms/plattform"
    error_message = "Nur master ist gesperrt; jeder andere gültige Name ist ein eigener Realm."
  }
}

run "keycloak_url_mit_pfad" {
  command = plan

  variables {
    keycloak_url = "https://id.example.ch/auth"
  }

  expect_failures = [var.keycloak_url]
}

run "katalog_scope_ungueltig" {
  command = plan

  variables {
    catalog = { scopes = ["ohne-verb"] }
  }

  expect_failures = [var.catalog]
}

run "jwks_mit_privatem_teil" {
  command = plan

  variables {
    jwks = {
      platform = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"p\",\"d\":\"geheim\"}]}"
      admin    = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"a\"}]}"
      sync     = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"s\"}]}"
    }
  }

  expect_failures = [var.jwks]
}

run "theme_farbe" {
  command = plan

  variables {
    theme_texts = { de = { themeAccent = "teal" } }
  }

  expect_failures = [var.theme_texts]
}

run "maschinen_clients" {
  command = plan

  variables {
    m2m = true
    machine_clients = {
      "acme-export" = {
        organizations = ["acme"]
        scopes        = ["beispiel:read"]
        jwks          = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"acme\"}]}"
      }
      "monitoring" = {
        description   = "System-Client des Betriebs"
        organizations = ["zeta", "acme"]
        scopes        = ["beispiel:read", "notes:write"]
        jwks          = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"mon\"}]}"
      }
    }
  }

  assert {
    condition = alltrue([for c in keycloak_openid_client.machine : c.service_accounts_enabled && !c.standard_flow_enabled && c.require_dpop_bound_tokens
      && c.client_authenticator_type == "client-jwt" && c.access_token_lifespan == "300" && !c.use_refresh_tokens
    && c.extra_config["beispiel.m2m"] == "true" && c.extra_config["beispiel.platform"] == "true"])
    error_message = "Service Account, private_key_jwt, DPoP, 5 min, Markierungen <produkt>.m2m und <produkt>.platform"
  }
  assert {
    condition     = keycloak_openid_client.machine["monitoring"].name == "Beispiel: monitoring" && keycloak_openid_client.machine["monitoring"].extra_config["jwks.string"] == jsonencode(jsondecode(var.machine_clients["monitoring"].jwks))
    error_message = "Name und JWKS"
  }
  assert {
    condition     = keycloak_openid_hardcoded_claim_protocol_mapper.machine_organization["monitoring"].claim_value == "[\"acme\",\"zeta\"]" && keycloak_openid_hardcoded_claim_protocol_mapper.machine_organization["acme-export"].claim_value_type == "JSON"
    error_message = "Claim organization als JSON-Liste der Aliasse"
  }
  assert {
    condition     = keycloak_openid_client_default_scopes.machine["acme-export"].default_scopes == toset(["profile", "email", "roles", "web-origins", "acr", "basic", "beispiel:read"]) && length(keycloak_openid_client_optional_scopes.machine["monitoring"].optional_scopes) == 0
    error_message = "Rechte-Scopes als Standard-Scopes, keine optionalen"
  }
  assert {
    condition     = keys(keycloak_openid_audience_protocol_mapper.machine_api) == ["acme-export", "monitoring"] && keycloak_openid_audience_protocol_mapper.machine_api["monitoring"].included_client_audience == "beispiel-api"
    error_message = "Zielgruppe <produkt>-api"
  }
  assert {
    condition     = join(",", output.machine_clients["monitoring"].organizations) == "acme,zeta"
    error_message = "Ausgabe mit den Organisationen für die Freigabe"
  }
}

run "maschinen_client_ohne_m2m" {
  command = plan

  variables {
    machine_clients = {
      "acme-export" = { organizations = ["acme"], jwks = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"a\"}]}" }
    }
  }

  expect_failures = [keycloak_openid_client.machine]
}

run "maschinen_client_fremder_scope" {
  command = plan

  variables {
    m2m = true
    machine_clients = {
      "acme-export" = { organizations = ["acme"], scopes = ["members:admin"], jwks = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"a\"}]}" }
    }
  }

  expect_failures = [var.machine_clients]
}

run "maschinen_client_reservierte_id" {
  command = plan

  variables {
    m2m = true
    machine_clients = {
      "beispiel-admin" = { organizations = ["acme"], jwks = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"a\"}]}" }
    }
  }

  expect_failures = [var.machine_clients]
}

run "maschinen_client_ohne_organisation" {
  command = plan

  variables {
    m2m = true
    machine_clients = {
      "acme-export" = { organizations = [], jwks = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"a\"}]}" }
    }
  }

  expect_failures = [var.machine_clients]
}
