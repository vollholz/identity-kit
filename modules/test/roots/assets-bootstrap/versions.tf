# Bootstrap von Assets mit dem Modul product-realm-bootstrap (Phase 2), Nachweis «No changes» gegen
# fixtures/assets-3a148ae/bootstrap. Backend lokal, Schlüssel aus var.keys_dir.

terraform {
  required_version = "~> 1.13.1"

  required_providers {
    keycloak = {
      source  = "keycloak/keycloak"
      version = "5.9.0"
    }
  }

  backend "local" {}

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

provider "keycloak" {
  url             = var.keycloak_url
  base_path       = var.keycloak_base_path
  jwt_signing_alg = "ES256"
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

variable "keys_dir" {
  description = "Verzeichnis mit den öffentlichen Schlüsseln <client>.json."
  type        = string
}
