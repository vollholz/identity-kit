# Modul product-realm-bootstrap: Anlage des Realms einer App und ihres IaC-Clients <produkt>-iac (Spezifikation Kap. 2,
# Schritt 4), einmalig bzw. beim Neuaufbau. Aufgerufen als Service Account <produkt>-tofu im Realm master (nur
# create-realm, verwaltet von vollholz/identity). Danach weist vollholz/identity (products.<produkt>.grant_realm_admin)
# <produkt>-iac realm-management/realm-admin zu, und alles Weitere verwaltet das Modul product-realm als <produkt>-iac.
# Aufruf: README.md.
#
# Der Realm gehört inhaltlich product-realm; hier wird er nur angelegt (alle Einstellungen ignoriert). Backend,
# State-Verschlüsselung (eigener State-Key) und Provider-Anmeldung gehören dem Aufrufer.

terraform {
  required_version = "~> 1.13.1"

  required_providers {
    keycloak = {
      source  = "keycloak/keycloak"
      version = "5.9.0"
    }
  }
}
