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
  public_base_url = "https://beispiel.example.ch/"
  catalog = {
    roles  = { "org-admin" = "Organisations-Admin", viewer = "Leser:in" }
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
    + length(keycloak_openid_client_service_account_role.manage_identity_providers) + length(keycloak_openid_user_session_note_protocol_mapper.identity_provider)) == 0
    error_message = "Ohne Schalter weder M2M-Richtlinie noch MCP noch Entra"
  }
  assert {
    condition     = keys(keycloak_openid_group_membership_protocol_mapper.groups) == ["platform"] && keys(keycloak_openid_audience_protocol_mapper.aud_api) == ["platform"]
    error_message = "Mapper nur am BFF-Client"
  }
  assert {
    condition     = keys(keycloak_role.platform) == ["org-admin", "viewer"] && keycloak_role.platform["viewer"].description == "Leser:in"
    error_message = "Client-Rollen aus catalog.roles mit Beschreibung"
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
    condition     = output.issuer == "https://identity.project-suite.ch/realms/beispiel" && output.clients.mcp == null
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

run "product_project_suite" {
  command = plan

  variables {
    product = "project-suite"
  }

  expect_failures = [var.product]
}

run "katalog_ohne_org_admin" {
  command = plan

  variables {
    catalog = { roles = { viewer = "Leser:in" }, scopes = [] }
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
