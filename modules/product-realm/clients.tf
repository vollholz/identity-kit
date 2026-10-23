# Clients des Produkts (Spezifikation 3.4). Alle vertraulichen Clients melden sich mit private_key_jwt an (kein
# gemeinsames Geheimnis, keines im State): Der öffentliche Schlüssel kommt als JWKS über var.jwks (in der App
# infra/keycloak/keys/<client>.json), der private liegt nur verschlüsselt beim Dienst, der ihn braucht.

locals {
  ui = trimsuffix(var.public_base_url, "/")

  # Attribute für private_key_jwt mit hinterlegtem JWKS (kid = JWK-Thumbprint, wie die App ihn berechnet)
  jwt_auth = {
    for c, jwks in var.jwks : c => {
      "use.jwks.url"                    = "false"
      "use.jwks.string"                 = "true"
      "jwks.string"                     = jsonencode(jsondecode(jwks))
      "token.endpoint.auth.signing.alg" = "ES256"
    }
  }
}

# Zielgruppe der REST-API; stellt selbst keine Tokens aus
resource "keycloak_openid_client" "api" {
  realm_id                     = local.realm
  client_id                    = "${var.product}-api"
  name                         = "${var.display_name} API (Zielgruppe)"
  description                  = "Ressourcenserver; stellt keine Tokens aus."
  access_type                  = "CONFIDENTIAL"
  client_authenticator_type    = "client-jwt"
  standard_flow_enabled        = false
  implicit_flow_enabled        = false
  direct_access_grants_enabled = false
  service_accounts_enabled     = false
  pkce_code_challenge_method   = "S256"
  extra_config                 = local.platform_mark

  depends_on = [keycloak_realm_client_policy_profile_policy.code_flow, keycloak_realm_client_policy_profile_policy.confidential]
}

# Oberfläche (Backend for Frontend): Code-Flow mit PKCE, trägt die Rollen des Produkts.
# Mit Entra ID zusätzlich /auth/entra/*: Weiterleitung nach der Einladung aus Entra ID (E-Mail von Keycloak). Die Route
# startet nur die Anmeldung über den Anbieter und gibt keine Parameter weiter (auch keinen Code).
resource "keycloak_openid_client" "platform" {
  realm_id                            = local.realm
  client_id                           = "${var.product}-platform"
  name                                = "${var.display_name} Plattform"
  description                         = "Oberfläche (Backend for Frontend, Code-Flow mit PKCE). Trägt die Rollen der Plattform."
  access_type                         = "CONFIDENTIAL"
  client_authenticator_type           = "client-jwt"
  standard_flow_enabled               = true
  implicit_flow_enabled               = false
  direct_access_grants_enabled        = false
  service_accounts_enabled            = false
  pkce_code_challenge_method          = "S256"
  root_url                            = local.ui
  base_url                            = "/"
  valid_redirect_uris                 = concat(["${local.ui}/auth/callback"], var.entra ? ["${local.ui}/auth/entra/*"] : [])
  web_origins                         = [local.ui]
  valid_post_logout_redirect_uris     = ["${local.ui}/abgemeldet", "${local.ui}/"]
  frontchannel_logout_enabled         = false
  backchannel_logout_url              = "${local.ui}/auth/backchannel-logout"
  backchannel_logout_session_required = true
  use_refresh_tokens                  = true
  extra_config                        = merge(local.platform_mark, local.jwt_auth["platform"])

  depends_on = [keycloak_realm_client_policy_profile_policy.code_flow, keycloak_realm_client_policy_profile_policy.confidential]
}

# MCP-Dienst: tauscht Tokens der MCP-Hosts gegen API-Tokens (Standard Token Exchange, RFC 8693)
resource "keycloak_openid_client" "mcp" {
  count                                          = var.mcp ? 1 : 0
  realm_id                                       = local.realm
  client_id                                      = "${var.product}-mcp"
  name                                           = "${var.display_name} MCP-Dienst"
  description                                    = "Tauscht MCP-Tokens gegen API-Tokens (RFC 8693)."
  access_type                                    = "CONFIDENTIAL"
  client_authenticator_type                      = "client-jwt"
  standard_flow_enabled                          = false
  implicit_flow_enabled                          = false
  direct_access_grants_enabled                   = false
  service_accounts_enabled                       = false
  pkce_code_challenge_method                     = "S256"
  standard_token_exchange_enabled                = true
  allow_refresh_token_in_standard_token_exchange = "NO"
  extra_config                                   = merge(local.platform_mark, lookup(local.jwt_auth, "mcp", {}))

  depends_on = [keycloak_realm_client_policy_profile_policy.code_flow, keycloak_realm_client_policy_profile_policy.confidential]

  lifecycle {
    precondition {
      condition     = contains(keys(var.jwks), "mcp")
      error_message = "Mit mcp = true braucht jwks den Schlüssel mcp (keys/<produkt>-mcp.json)."
    }
  }
}

# Öffentlicher Client für MCP-Hosts (Claude Code, Desktop, Web): Code-Flow mit PKCE, Loopback-Weiterleitung (RFC 8252)
resource "keycloak_openid_client" "mcp_cli" {
  count                        = var.mcp ? 1 : 0
  realm_id                     = local.realm
  client_id                    = "${var.product}-mcp-cli"
  name                         = "${var.display_name} MCP für Desktop- und CLI-Hosts"
  description                  = "Öffentlicher Client (Code-Flow mit PKCE, Loopback-Weiterleitung)."
  access_type                  = "PUBLIC"
  standard_flow_enabled        = true
  implicit_flow_enabled        = false
  direct_access_grants_enabled = false
  pkce_code_challenge_method   = "S256"
  require_dpop_bound_tokens    = false
  valid_redirect_uris = concat(
    ["http://127.0.0.1/*", "http://localhost/*", "http://localhost:${var.mcp_cli_callback_port}/callback"],
    var.mcp_extra_redirect_uris,
  )
  web_origins  = []
  extra_config = local.platform_mark

  depends_on = [keycloak_realm_client_policy_profile_policy.code_flow]
}

# ---------- Mapper der Clients: Zielgruppe der API

locals {
  # Clients, die Tokens für Personen ausstellen (identity_provider) bzw. die API als Zielgruppe tragen
  person_clients = merge(
    { platform = keycloak_openid_client.platform.id },
    var.mcp ? { mcp = keycloak_openid_client.mcp[0].id, mcp_cli = keycloak_openid_client.mcp_cli[0].id } : {},
  )
  api_audience_clients = merge(
    { platform = keycloak_openid_client.platform.id },
    var.mcp ? { mcp = keycloak_openid_client.mcp[0].id } : {},
  )
}

resource "keycloak_openid_audience_protocol_mapper" "aud_api" {
  for_each                   = local.api_audience_clients
  realm_id                   = local.realm
  client_id                  = each.value
  name                       = "aud-api"
  included_client_audience   = keycloak_openid_client.api.client_id
  add_to_access_token        = true
  add_to_id_token            = false
  add_to_token_introspection = true
}

# ---------- Scopes der Clients (vollständige Listen; was hier fehlt, entfernt OpenTofu)

resource "keycloak_openid_client_default_scopes" "platform" {
  realm_id       = local.realm
  client_id      = keycloak_openid_client.platform.id
  default_scopes = local.builtin_scopes
  # Keycloak 26.8 hängt neuen Clients «organization» als optionalen Scope an; erst die optionalen Scopes setzen
  depends_on = [keycloak_openid_client_optional_scopes.platform]
}

resource "keycloak_openid_client_optional_scopes" "platform" {
  realm_id        = local.realm
  client_id       = keycloak_openid_client.platform.id
  optional_scopes = ["organization"]
}

resource "keycloak_openid_client_default_scopes" "mcp" {
  count          = var.mcp ? 1 : 0
  realm_id       = local.realm
  client_id      = keycloak_openid_client.mcp[0].id
  default_scopes = local.builtin_scopes
  # Keycloak 26.8 hängt neuen Clients «organization» als optionalen Scope an; erst die optionalen Scopes setzen
  depends_on = [keycloak_openid_client_optional_scopes.mcp]
}

resource "keycloak_openid_client_optional_scopes" "mcp" {
  count           = var.mcp ? 1 : 0
  realm_id        = local.realm
  client_id       = keycloak_openid_client.mcp[0].id
  optional_scopes = concat(["organization"], [for s in keycloak_openid_client_scope.permission : s.name])
}

resource "keycloak_openid_client_default_scopes" "mcp_cli" {
  count          = var.mcp ? 1 : 0
  realm_id       = local.realm
  client_id      = keycloak_openid_client.mcp_cli[0].id
  default_scopes = concat(local.builtin_scopes, [keycloak_openid_client_scope.mcp[0].name, "organization"])
  # Keycloak 26.8 hängt neuen Clients «organization» als optionalen Scope an; erst die optionalen Scopes setzen
  depends_on = [keycloak_openid_client_optional_scopes.mcp_cli]
}

# offline_access: MCP-Hosts (z. B. Claude) verlangen ihn, weil die Discovery ihn unter scopes_supported nennt, und
# Keycloak weist eine Anfrage mit nicht zugeordnetem Scope ganz ab («Invalid scopes»). Nur für diesen Client.
resource "keycloak_openid_client_optional_scopes" "mcp_cli" {
  count           = var.mcp ? 1 : 0
  realm_id        = local.realm
  client_id       = keycloak_openid_client.mcp_cli[0].id
  optional_scopes = concat([for s in keycloak_openid_client_scope.permission : s.name], ["offline_access"])
}

# ---------- Realm-Rolle (Rollen der App liegen in der App-Datenbank, nicht in Keycloak)

resource "keycloak_role" "platform_admin" {
  realm_id    = local.realm
  name        = "platform-admin"
  description = "Plattform-Administration über alle Mandanten"
}
