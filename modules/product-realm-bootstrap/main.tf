# Kein import-Block (in Modulen nicht möglich und auf einer neuen Instanz gibt es den Realm noch nicht). Geht der State
# verloren: tofu import module.<name>.keycloak_realm.this <realm> bzw. module.<name>.keycloak_openid_client.iac
# <realm>/<id>.

resource "keycloak_realm" "this" {
  realm   = coalesce(var.realm, var.product)
  enabled = true
  # Schon bei der Anlage: dann besteht der Client admin-permissions, bevor product-realm ihn nachschlägt (admin.tf)
  admin_permissions_enabled = true

  # Inhalt verwaltet product-realm – hier nur Anlage
  lifecycle {
    prevent_destroy = true
    ignore_changes  = all
  }
}

# IaC-Client im Realm: Service Account, private_key_jwt (öffentlicher Schlüssel var.iac_jwks, privater in .env
# KEYCLOAK_IAC_PRIVATE_KEY_B64 bzw. GitHub-Secret KEYCLOAK_IAC_PRIVATE_KEY). Die Rolle realm-admin vergibt
# der Betreiber der Instanz als Server-Admin; create-realm darf sie nicht vergeben.
resource "keycloak_openid_client" "iac" {
  realm_id                              = keycloak_realm.this.id
  client_id                             = coalesce(var.iac_client_id, "${var.product}-iac")
  name                                  = "OpenTofu (IaC)"
  description                           = "Verwaltet den Realm über infra/keycloak. Rolle realm-management/realm-admin (Bootstrap von Hand)."
  access_type                           = "CONFIDENTIAL"
  client_authenticator_type             = "client-jwt"
  standard_flow_enabled                 = false
  implicit_flow_enabled                 = false
  direct_access_grants_enabled          = false
  service_accounts_enabled              = true
  frontchannel_logout_enabled           = false
  pkce_code_challenge_method            = "S256"
  access_token_lifespan                 = "300"
  use_refresh_tokens                    = false
  use_refresh_tokens_client_credentials = false
  extra_config = {
    "${var.product}.platform"         = "true"
    "use.jwks.url"                    = "false"
    "use.jwks.string"                 = "true"
    "jwks.string"                     = jsonencode(jsondecode(var.iac_jwks))
    "token.endpoint.auth.signing.alg" = "ES256"
  }

  lifecycle {
    prevent_destroy = true
  }
}
