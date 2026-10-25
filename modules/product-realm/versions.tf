# Modul product-realm: Realm einer App auf einer Keycloak-Instanz nach Spezifikation Kap. 3. Aufruf, Eingaben und
# Umstellung: README.md.
#
# Backend, State-Verschlüsselung und Provider-Anmeldung gehören dem Aufrufer (infra/keycloak der App, kc.sh). Das Modul
# braucht beim Plan und Apply Node 24 (scripts/*.ts) und den privaten Schlüssel des IaC-Clients in der Umgebung
# (KEYCLOAK_IAC_PRIVATE_KEY, PEM; setzt kc.sh).

terraform {
  required_version = "~> 1.13.1"

  required_providers {
    keycloak = {
      source  = "keycloak/keycloak"
      version = "5.9.0"
    }
    # scripts/lookup.ts: IDs eingebauter Clients ohne Lesen des Client-Secrets (admin.tf)
    external = {
      source  = "hashicorp/external"
      version = "2.4.2"
    }
  }
}
