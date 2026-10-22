# Anmeldung über Microsoft Entra ID je Organisation (Nr. 104, docs/konzepte/entra-id.md); wie scripts/keycloak-setup.ts.
# Die Anbieter selbst («entra-001» …) legt die Plattform an, wenn eine Organisation sich verbindet – nicht OpenTofu.
#   - assets-admin darf Identitätsanbieter verwalten (manage-identity-providers; alle Anbieter des Realms samt Mappern,
#     die Plattform legt nur «entra-NNN» ohne Mapper an)
#   - Ablauf «assets-entra-first-login»: Erstanmeldung über einen Anbieter immer verweigert (keine Konten, keine
#     Verknüpfung über die Adresse; nur vorab über die Objekt-ID verknüpfte Konten melden sich an)
#   - Claim `identity_provider` (Session-Note) an den Personen-Clients: die Plattform verlangt ihn für an Entra
#     gebundene Domains («nur Entra», src/platform/auth/principal.ts)

resource "keycloak_openid_client_service_account_role" "manage_identity_providers" {
  realm_id                = local.realm
  service_account_user_id = keycloak_openid_client.service["assets-admin"].service_account_user_id
  client_id               = data.external.realm_management.result.id
  role                    = "manage-identity-providers"
}

resource "keycloak_authentication_flow" "entra_first_login" {
  realm_id    = local.realm
  alias       = "assets-entra-first-login"
  description = "Assets: Erstanmeldung über Entra ID immer verweigern (nur vorab verknüpfte Konten)"
  provider_id = "basic-flow"
}

resource "keycloak_authentication_execution" "entra_first_login_deny" {
  realm_id          = local.realm
  parent_flow_alias = keycloak_authentication_flow.entra_first_login.alias
  authenticator     = "deny-access-authenticator"
  requirement       = "REQUIRED"
}

resource "keycloak_authentication_execution_config" "entra_first_login_deny" {
  realm_id     = local.realm
  execution_id = keycloak_authentication_execution.entra_first_login_deny.id
  alias        = "assets-entra-deny"
  config = {
    denyErrorMessage = "Dein Microsoft-Konto ist für diese Organisation nicht freigeschaltet. Bitte wende dich an die Administration deiner Organisation."
  }
}

resource "keycloak_openid_user_session_note_protocol_mapper" "identity_provider" {
  for_each                   = { platform = keycloak_openid_client.platform.id, mcp = keycloak_openid_client.mcp.id, mcp_cli = keycloak_openid_client.mcp_cli.id }
  realm_id                   = local.realm
  client_id                  = each.value
  name                       = "identity-provider"
  claim_name                 = "identity_provider"
  claim_value_type           = "String"
  session_note               = "identity_provider"
  add_to_id_token            = false
  add_to_access_token        = true
  add_to_userinfo            = false
  add_to_token_introspection = true
}
