# Clients der Plattform. Alle vertraulichen Clients melden sich mit private_key_jwt an (kein gemeinsames Geheimnis,
# keines im State): Der öffentliche Schlüssel liegt in keys/<client>.json (erzeugt von
# deploy/hetzner/scripts/secrets.sh), der private nur verschlüsselt in deploy/hetzner/app/secrets.sops.yaml.

locals {
  ui = trimsuffix(var.public_base_url, "/")

  # Attribute für private_key_jwt mit hinterlegtem JWKS (kid = JWK-Thumbprint, wie die Plattform ihn berechnet)
  jwt_auth = {
    for c in ["assets-platform", "assets-mcp", "assets-admin", "assets-sync"] : c => {
      "use.jwks.url"                    = "false"
      "use.jwks.string"                 = "true"
      "jwks.string"                     = jsonencode(jsondecode(file("${path.module}/keys/${c}.json")))
      "token.endpoint.auth.signing.alg" = "ES256"
    }
  }
}

# Zielgruppe der REST-API; stellt selbst keine Tokens aus
resource "keycloak_openid_client" "api" {
  realm_id                     = local.realm
  client_id                    = "assets-api"
  name                         = "Assets API (Zielgruppe)"
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

# Oberfläche (Backend for Frontend): Code-Flow mit PKCE, trägt die Rollen der Plattform
# Redirect-URI /auth/entra/*: Weiterleitung nach der Einladung aus Entra ID (E-Mail von Keycloak, Nr. 104 Teil 2). Die
# Route startet nur die Anmeldung über den Anbieter und gibt keine Parameter weiter (auch keinen Code).
resource "keycloak_openid_client" "platform" {
  realm_id                            = local.realm
  client_id                           = "assets-platform"
  name                                = "Assets Plattform"
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
  valid_redirect_uris                 = ["${local.ui}/auth/callback", "${local.ui}/auth/entra/*"]
  web_origins                         = [local.ui]
  valid_post_logout_redirect_uris     = ["${local.ui}/abgemeldet", "${local.ui}/"]
  frontchannel_logout_enabled         = false
  backchannel_logout_url              = "${local.ui}/auth/backchannel-logout"
  backchannel_logout_session_required = true
  use_refresh_tokens                  = true
  extra_config                        = merge(local.platform_mark, local.jwt_auth["assets-platform"])

  depends_on = [keycloak_realm_client_policy_profile_policy.code_flow, keycloak_realm_client_policy_profile_policy.confidential]
}

# MCP-Dienst: tauscht Tokens der MCP-Hosts gegen API-Tokens (Standard Token Exchange, RFC 8693)
resource "keycloak_openid_client" "mcp" {
  realm_id                                       = local.realm
  client_id                                      = "assets-mcp"
  name                                           = "Assets MCP-Dienst"
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
  extra_config                                   = merge(local.platform_mark, local.jwt_auth["assets-mcp"])

  depends_on = [keycloak_realm_client_policy_profile_policy.code_flow, keycloak_realm_client_policy_profile_policy.confidential]
}

# Öffentlicher Client für MCP-Hosts (Claude Code, Desktop, Web): Code-Flow mit PKCE, Loopback-Weiterleitung (RFC 8252)
resource "keycloak_openid_client" "mcp_cli" {
  realm_id                     = local.realm
  client_id                    = "assets-mcp-cli"
  name                         = "Assets MCP für Desktop- und CLI-Hosts"
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

# ---------- Mapper der Clients: Zielgruppe der API und Gruppen (Rollen über /orgs/<alias>/<rolle>)

resource "keycloak_openid_audience_protocol_mapper" "aud_api" {
  for_each                   = { platform = keycloak_openid_client.platform.id, mcp = keycloak_openid_client.mcp.id }
  realm_id                   = local.realm
  client_id                  = each.value
  name                       = "aud-api"
  included_client_audience   = keycloak_openid_client.api.client_id
  add_to_access_token        = true
  add_to_id_token            = false
  add_to_token_introspection = true
}

resource "keycloak_openid_group_membership_protocol_mapper" "groups" {
  for_each                   = { platform = keycloak_openid_client.platform.id, mcp = keycloak_openid_client.mcp.id, mcp_cli = keycloak_openid_client.mcp_cli.id }
  realm_id                   = local.realm
  client_id                  = each.value
  name                       = "groups"
  claim_name                 = "groups"
  full_path                  = true
  add_to_access_token        = true
  add_to_id_token            = false
  add_to_userinfo            = true
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
  realm_id       = local.realm
  client_id      = keycloak_openid_client.mcp.id
  default_scopes = local.builtin_scopes
  # Keycloak 26.8 hängt neuen Clients «organization» als optionalen Scope an; erst die optionalen Scopes setzen
  depends_on = [keycloak_openid_client_optional_scopes.mcp]
}

resource "keycloak_openid_client_optional_scopes" "mcp" {
  realm_id        = local.realm
  client_id       = keycloak_openid_client.mcp.id
  optional_scopes = concat(["organization"], [for s in keycloak_openid_client_scope.permission : s.name])
}

resource "keycloak_openid_client_default_scopes" "mcp_cli" {
  realm_id       = local.realm
  client_id      = keycloak_openid_client.mcp_cli.id
  default_scopes = concat(local.builtin_scopes, [keycloak_openid_client_scope.mcp.name, "organization"])
  # Keycloak 26.8 hängt neuen Clients «organization» als optionalen Scope an; erst die optionalen Scopes setzen
  depends_on = [keycloak_openid_client_optional_scopes.mcp_cli]
}

# offline_access: MCP-Hosts (z. B. Claude) verlangen ihn, weil die Discovery ihn unter scopes_supported nennt, und
# Keycloak weist eine Anfrage mit nicht zugeordnetem Scope ganz ab («Invalid scopes»). Nur für diesen Client.
resource "keycloak_openid_client_optional_scopes" "mcp_cli" {
  realm_id        = local.realm
  client_id       = keycloak_openid_client.mcp_cli.id
  optional_scopes = concat([for s in keycloak_openid_client_scope.permission : s.name], ["offline_access"])
}

# ---------- Rollen und Gruppen

resource "keycloak_role" "platform_admin" {
  realm_id    = local.realm
  name        = "platform-admin"
  description = "Plattform-Administration über alle Mandanten"
}

# Rollen der Plattform als Client-Rollen von assets-platform (ROLE_CLIENT_ID)
resource "keycloak_role" "platform" {
  for_each    = local.platform.roles
  realm_id    = local.realm
  client_id   = keycloak_openid_client.platform.id
  name        = each.key
  description = each.value
}

# Gruppenbasis /orgs; darunter legt die Plattform /orgs/<alias>/<rolle> an
resource "keycloak_group" "orgs" {
  realm_id = local.realm
  name     = "orgs"
}
