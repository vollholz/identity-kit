# Realm «assets» der Plattform auf der Identity-Plattform (identity.project-suite.ch, vollholz/identity). Entspricht dem, was
# scripts/keycloak-setup.ts für Entwicklung und Tests einrichtet (ohne Demo-Organisationen und Testpersonen).
# Aufruf: ./kc.sh init | plan | apply. Ablauf und Rechte: docs/produktion.md › Keycloak-Anbindung.

terraform {
  required_version = "~> 1.13.1"

  required_providers {
    keycloak = {
      source  = "keycloak/keycloak"
      version = "5.9.0"
    }
    # lookup.ts: IDs eingebauter Clients ohne Lesen des Client-Secrets (admin.tf)
    external = {
      source  = "hashicorp/external"
      version = "2.4.2"
    }
  }

  backend "s3" {}

  # Wie infra/hetzner: State und Plan clientseitig verschlüsselt (gleiche Passphrase TF_STATE_PASSPHRASE)
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

# Anmeldung als Service Account «assets-iac» im Realm assets (realm-management/realm-admin, private_key_jwt), bewusst
# NUR aus der Umgebung (KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID, KEYCLOAK_JWT_SIGNING_KEY; kc.sh setzt sie) – so steht sie
# nicht im gespeicherten Plan. Nur realm-admin darf mit FGAP v2 Admin-Rollen (manage-realm, view-*) vergeben.
# Anlage des Realms und von assets-iac: bootstrap/ als «assets-tofu» (Realm master, nur create-realm).
provider "keycloak" {
  url             = var.keycloak_url
  base_path       = var.keycloak_base_path
  jwt_signing_alg = "ES256"
}
