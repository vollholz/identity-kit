# Maschinen-Clients als Code (Spezifikation 12.1, B4): Organisations-Clients (eine Organisation) und System-Clients
# (mehrere Organisationen, je Aufruf X-Tenant) aus var.machine_clients statt von Hand in der Konsole nach Vorlage.
# Je Client: Service Account mit private_key_jwt, DPoP-gebundene Tokens (Richtlinie <produkt>-m2m-dpop), 5 min, keine
# Refresh-Tokens; Zielgruppe <produkt>-api, fester Claim organization mit den Aliassen, keine Client-Rollen von
# <produkt>-platform entfallen (die Rolle der Maschine liegt als Client-Freigabe in der App-Datenbank), Rechte-Scopes
# als Standard-Scopes. Keine Zielgruppe <produkt>-mcp: der
# MCP-Dienst tauscht keine sendergebundenen Tokens und nimmt nur die MCP-Hosts an; Maschinen nutzen die REST-API.
# Wirksam wird ein Client in einer Organisation erst mit ihrer Freigabe in der App (client_grant, members:admin);
# ein falscher Alias öffnet so keine fremde Organisation.

resource "keycloak_openid_client" "machine" {
  for_each                              = var.machine_clients
  realm_id                              = local.realm
  client_id                             = each.key
  name                                  = coalesce(each.value.name, "${var.display_name}: ${each.key}")
  description                           = each.value.description
  access_type                           = "CONFIDENTIAL"
  client_authenticator_type             = "client-jwt"
  standard_flow_enabled                 = false
  implicit_flow_enabled                 = false
  direct_access_grants_enabled          = false
  service_accounts_enabled              = true
  frontchannel_logout_enabled           = false
  pkce_code_challenge_method            = "S256"
  require_dpop_bound_tokens             = true
  access_token_lifespan                 = "300"
  use_refresh_tokens                    = false
  use_refresh_tokens_client_credentials = false
  extra_config = merge(local.platform_mark, { "${var.product}.m2m" = "true" }, {
    "use.jwks.url"                    = "false"
    "use.jwks.string"                 = "true"
    "jwks.string"                     = jsonencode(jsondecode(each.value.jwks))
    "token.endpoint.auth.signing.alg" = "ES256"
  })

  depends_on = [
    keycloak_realm_client_policy_profile_policy.code_flow,
    keycloak_realm_client_policy_profile_policy.confidential,
    keycloak_realm_client_policy_profile_policy.m2m_dpop,
  ]

  lifecycle {
    precondition {
      condition     = var.m2m
      error_message = "machine_clients braucht m2m = true (Richtlinie <produkt>-m2m-dpop)."
    }
  }
}

resource "keycloak_openid_audience_protocol_mapper" "machine_api" {
  for_each                   = keycloak_openid_client.machine
  realm_id                   = local.realm
  client_id                  = each.value.id
  name                       = "aud-api"
  included_client_audience   = keycloak_openid_client.api.client_id
  add_to_access_token        = true
  add_to_id_token            = false
  add_to_token_introspection = true
}

# Organisationen des Clients als fester Claim (Liste von Aliassen, wie TENANT_CLAIM sie liest)
resource "keycloak_openid_hardcoded_claim_protocol_mapper" "machine_organization" {
  for_each            = keycloak_openid_client.machine
  realm_id            = local.realm
  client_id           = each.value.id
  name                = "organization"
  claim_name          = "organization"
  claim_value         = jsonencode(sort(var.machine_clients[each.key].organizations))
  claim_value_type    = "JSON"
  add_to_access_token = true
  add_to_id_token     = false
  add_to_userinfo     = false
}

# Scopes als vollständige Listen; die Rechte-Scopes des Clients als Standard (Client Credentials ohne scope-Parameter)
resource "keycloak_openid_client_default_scopes" "machine" {
  for_each       = keycloak_openid_client.machine
  realm_id       = local.realm
  client_id      = each.value.id
  default_scopes = concat(local.builtin_scopes, [for s in var.machine_clients[each.key].scopes : keycloak_openid_client_scope.permission[s].name])
  # Keycloak 26.8 hängt neuen Clients «organization» als optionalen Scope an; erst die optionalen Scopes setzen
  depends_on = [keycloak_openid_client_optional_scopes.machine]
}

resource "keycloak_openid_client_optional_scopes" "machine" {
  for_each        = keycloak_openid_client.machine
  realm_id        = local.realm
  client_id       = each.value.id
  optional_scopes = []
}
