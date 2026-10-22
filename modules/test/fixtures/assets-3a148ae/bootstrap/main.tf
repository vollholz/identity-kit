# Bootstrap des Realms «assets» (einmalig bzw. beim Neuaufbau): als Service Account «assets-tofu» im Realm master
# (nur Rolle create-realm) den Realm anlegen und darin den IaC-Client «assets-iac». Danach weist vollholz/identity
# (identity-iac, products.assets.grant_realm_admin) assets-iac realm-management/realm-admin zu, und alles Weitere
# verwaltet infra/keycloak als assets-iac. Instanz: https://identity.project-suite.ch (docs/produktion.md › Keycloak-Anbindung).
#
#   ../kc.sh bootstrap init | plan | apply
#
# Der Realm gehört inhaltlich infra/keycloak; hier wird er nur angelegt (alle Einstellungen ignoriert). Eigener State-Key.

terraform {
  required_version = "~> 1.13.1"

  required_providers {
    keycloak = {
      source  = "keycloak/keycloak"
      version = "5.9.0"
    }
  }

  backend "s3" {}

  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

variable "state_passphrase" {
  type      = string
  sensitive = true
}

variable "keycloak_url" {
  type    = string
  default = "https://identity.project-suite.ch"
}

variable "keycloak_base_path" {
  type    = string
  default = ""
}

variable "realm" {
  type    = string
  default = "assets"
  validation {
    condition     = !contains(["master", "project-suite"], var.realm)
    error_message = "Die Plattform braucht einen eigenen Realm."
  }
}

# Anmeldung aus der Umgebung (KEYCLOAK_REALM=master, KEYCLOAK_CLIENT_ID=assets-tofu, private_key_jwt über
# KEYCLOAK_JWT_SIGNING_KEY; kc.sh). assets-tofu verwaltet vollholz/identity (Realm master, nur create-realm).
provider "keycloak" {
  url             = var.keycloak_url
  base_path       = var.keycloak_base_path
  jwt_signing_alg = "ES256"
}

# Kein import-Block: auf einer neuen Instanz gibt es den Realm noch nicht (Import schlüge fehl). Geht der State
# verloren: ../kc.sh bootstrap import keycloak_realm.assets assets bzw. keycloak_openid_client.iac assets/<id>.

resource "keycloak_realm" "assets" {
  realm   = var.realm
  enabled = true
  # Schon bei der Anlage: dann besteht der Client admin-permissions, bevor infra/keycloak ihn nachschlägt (admin.tf)
  admin_permissions_enabled = true

  # Inhalt verwaltet infra/keycloak – hier nur Anlage
  lifecycle {
    prevent_destroy = true
    ignore_changes  = all
  }
}

# IaC-Client im Realm: Service Account, private_key_jwt (öffentlicher Schlüssel ../keys/assets-iac.json, privater in
# .env KEYCLOAK_IAC_PRIVATE_KEY_B64 bzw. GitHub-Secret KEYCLOAK_IAC_PRIVATE_KEY). Die Rolle realm-admin vergibt
# einmalig eine Keycloak-Administration; create-realm darf sie nicht vergeben.
resource "keycloak_openid_client" "iac" {
  realm_id                              = keycloak_realm.assets.id
  client_id                             = "assets-iac"
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
    "assets.platform"                 = "true"
    "use.jwks.url"                    = "false"
    "use.jwks.string"                 = "true"
    "jwks.string"                     = jsonencode(jsondecode(file("${path.module}/../keys/assets-iac.json")))
    "token.endpoint.auth.signing.alg" = "ES256"
  }

  lifecycle {
    prevent_destroy = true
  }
}

output "iac_service_account_user_id" {
  description = "Benutzer-ID des Service Accounts (für die Zuweisung von realm-admin)."
  value       = keycloak_openid_client.iac.service_account_user_id
}
