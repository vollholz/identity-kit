# {{MARK}}
#
# OpenTofu, Provider, Backend (S3, Werte aus identity.app.json › state, gesetzt von kc.sh) und Verschlüsselung von
# State und Plan (Passphrase TF_STATE_PASSPHRASE).

terraform {
  required_version = "~> 1.13.1"

  required_providers {
    keycloak = {
      source  = "keycloak/keycloak"
      version = "5.9.0"
    }
    # Modul product-realm, scripts/lookup.ts: IDs eingebauter Clients ohne Lesen des Client-Secrets
    external = {
      source  = "hashicorp/external"
      version = "2.4.2"
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

# Anmeldung als Service Account <produkt>-iac (realm-admin im Realm der App, private_key_jwt), bewusst NUR aus der
# Umgebung (KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID, KEYCLOAK_JWT_SIGNING_KEY; kc.sh setzt sie) – so steht sie nicht im
# gespeicherten Plan.
provider "keycloak" {
  url             = var.keycloak_url
  base_path       = var.keycloak_base_path
  jwt_signing_alg = "ES256"
}
