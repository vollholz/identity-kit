# {{MARK}}
#
# Bootstrap des Realms (einmalig bzw. beim Neuaufbau, nur lokal): als Service Account <produkt>-tofu im Realm master
# (nur Rolle create-realm, eingerichtet vom Betreiber der Keycloak-Instanz) den Realm anlegen und darin den IaC-Client
# <produkt>-iac. Danach weist der Betreiber <produkt>-iac realm-management/realm-admin zu, und alles Weitere verwaltet
# infra/keycloak. Der Schlüssel von <produkt>-tofu bleibt lokal, nie als CI-Secret.
#
#   ../kc.sh bootstrap init | plan | apply

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
  type = string
}

variable "keycloak_base_path" {
  type    = string
  default = ""
}

# Anmeldung aus der Umgebung (KEYCLOAK_REALM=master, KEYCLOAK_CLIENT_ID=<produkt>-tofu, KEYCLOAK_JWT_SIGNING_KEY; kc.sh)
provider "keycloak" {
  url             = var.keycloak_url
  base_path       = var.keycloak_base_path
  jwt_signing_alg = "ES256"
}

locals {
  app = jsondecode(file("${path.module}/../../../identity.app.json"))
}

# Realm (nur Anlage, prevent_destroy, ignore_changes = all) und IaC-Client <produkt>-iac (private_key_jwt mit
# ../keys/<produkt>-iac.json). Kein import-Block: auf einer neuen Instanz gibt es den Realm noch nicht.
module "bootstrap" {
  source = "git::https://github.com/vollholz/identity-kit.git//modules/product-realm-bootstrap?ref=product-realm-bootstrap-v{{BOOTSTRAP}}"

  product  = local.app.product
  iac_jwks = file("${path.module}/../keys/${local.app.product}-iac.json")
}

output "iac_service_account_user_id" {
  description = "Benutzer-ID des Service Accounts (für die Zuweisung von realm-admin beim Betreiber)."
  value       = module.bootstrap.iac_service_account_user_id
}
