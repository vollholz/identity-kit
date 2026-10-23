# Anmeldung über Microsoft Entra ID je Organisation (Spezifikation 9.4, nur mit var.entra). Die Anbieter selbst
# («entra-001» …) legt die App an, wenn eine Organisation sich verbindet – nicht OpenTofu.
#   - <produkt>-admin darf Identitätsanbieter verwalten (manage-identity-providers; alle Anbieter des Realms samt
#     Mappern; die App legt «entra-NNN» an und dazu den Mapper `entra-groups`, siehe README)
#   - Ablauf «<produkt>-entra-first-login»: Erstanmeldung über einen Anbieter immer verweigert (keine Konten, keine
#     Verknüpfung über die Adresse; nur vorab über die Objekt-ID verknüpfte Konten melden sich an)
#   - Claim `identity_provider` (Session-Note) an den Personen-Clients: die App verlangt ihn für an Entra gebundene
#     Domains («nur Entra»)
#   - Claim `groups` an <produkt>-platform: Benutzerattribut `entra_groups` (Objekt-IDs der Entra-Gruppen; gefüllt vom
#     Mapper `entra-groups` je Anbieter, FORCE bei jeder Anmeldung)

resource "keycloak_openid_client_service_account_role" "manage_identity_providers" {
  count                   = var.entra ? 1 : 0
  realm_id                = local.realm
  service_account_user_id = keycloak_openid_client.service["admin"].service_account_user_id
  client_id               = data.external.realm_management.result.id
  role                    = "manage-identity-providers"
}

resource "keycloak_authentication_flow" "entra_first_login" {
  count       = var.entra ? 1 : 0
  realm_id    = local.realm
  alias       = "${var.product}-entra-first-login"
  description = "${var.display_name}: Erstanmeldung über Entra ID immer verweigern (nur vorab verknüpfte Konten)"
  provider_id = "basic-flow"
}

resource "keycloak_authentication_execution" "entra_first_login_deny" {
  count             = var.entra ? 1 : 0
  realm_id          = local.realm
  parent_flow_alias = keycloak_authentication_flow.entra_first_login[0].alias
  authenticator     = "deny-access-authenticator"
  requirement       = "REQUIRED"
}

resource "keycloak_authentication_execution_config" "entra_first_login_deny" {
  count        = var.entra ? 1 : 0
  realm_id     = local.realm
  execution_id = keycloak_authentication_execution.entra_first_login_deny[0].id
  alias        = "${var.product}-entra-deny"
  config = {
    denyErrorMessage = var.entra_deny_message
  }
}

resource "keycloak_openid_user_session_note_protocol_mapper" "identity_provider" {
  for_each                   = var.entra ? local.person_clients : {}
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

resource "keycloak_openid_user_attribute_protocol_mapper" "entra_groups" {
  count                      = var.entra ? 1 : 0
  realm_id                   = local.realm
  client_id                  = keycloak_openid_client.platform.id
  name                       = "entra-groups"
  user_attribute             = "entra_groups"
  claim_name                 = "groups"
  claim_value_type           = "String"
  multivalued                = true
  aggregate_attributes       = false
  add_to_id_token            = false
  add_to_access_token        = true
  add_to_userinfo            = true
  add_to_token_introspection = true
}
