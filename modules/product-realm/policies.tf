# Client-Richtlinien des Realms (Spezifikation 3.3). Realmweit, gelten also auch für Clients, die später jemand in der
# Konsole anlegt:
#   <produkt>-code-flow    alle Clients: PKCE S256 Pflicht, kein Implicit Flow, kein Passwort-Grant
#   <produkt>-confidential vertrauliche Clients: nur sichere Client-Authentifizierung, neue Clients mit private_key_jwt
#   <produkt>-m2m-dpop     Maschinen-Clients der Organisationen (Attribut <produkt>.m2m = true): nur DPoP-gebundene
#                          Tokens (nur mit var.m2m)
# Die Clients des Produkts setzen die erzwungenen Werte selbst (PKCE, keine Implicit-/Passwort-Grants), damit die
# Auto-Konfiguration der Richtlinien keine Abweichung zum OpenTofu-Stand erzeugt.

resource "keycloak_realm_client_policy_profile" "code_flow" {
  realm_id    = local.realm
  name        = "${var.product}-code-flow"
  description = "${var.display_name}: PKCE S256, kein Implicit Flow, kein Passwort-Grant"

  executor {
    name          = "pkce-enforcer"
    configuration = { "auto-configure" = "true" }
  }
  executor {
    name          = "reject-implicit-grant"
    configuration = { "auto-configure" = "true" }
  }
  executor {
    name          = "reject-ropc-grant"
    configuration = { "auto-configure" = "true" }
  }
}

resource "keycloak_realm_client_policy_profile" "confidential" {
  realm_id    = local.realm
  name        = "${var.product}-confidential"
  description = "${var.display_name}: sichere Client-Authentifizierung"

  executor {
    name = "secure-client-authenticator"
    configuration = {
      # Client-Geheimnisse bleiben für Maschinen-Clients der Organisationen erlaubt (übergangsweise, Kap. 12.1); die
      # Clients des Produkts nutzen nur private_key_jwt.
      "allowed-client-authenticators" = jsonencode(["client-jwt", "client-x509", "client-secret"])
      "default-client-authenticator"  = "client-jwt"
    }
  }
}

resource "keycloak_realm_client_policy_profile" "m2m_dpop" {
  count       = var.m2m ? 1 : 0
  realm_id    = local.realm
  name        = "${var.product}-m2m-dpop"
  description = "${var.display_name}: Maschinen-Clients nur mit DPoP-gebundenen Tokens"

  executor {
    name = "dpop-bind-enforcer"
    configuration = {
      "auto-configure"                             = "false"
      "enforce-authorization-code-binding-to-dpop" = "false"
      "allow-only-refresh-token-binding"           = "false"
    }
  }
}

resource "keycloak_realm_client_policy_profile_policy" "code_flow" {
  realm_id    = local.realm
  name        = "${var.product}-code-flow"
  description = "Alle Clients des Realms"
  profiles    = [keycloak_realm_client_policy_profile.code_flow.name]

  condition {
    name          = "any-client"
    configuration = {}
  }
}

resource "keycloak_realm_client_policy_profile_policy" "confidential" {
  realm_id    = local.realm
  name        = "${var.product}-confidential"
  description = "Vertrauliche Clients"
  profiles    = [keycloak_realm_client_policy_profile.confidential.name]

  condition {
    name          = "client-access-type"
    configuration = { type = jsonencode(["confidential"]) }
  }
}

# DPoP-Pflicht nur über die positive Markierung: eine Bedingung «alle ausser …» sperrte das Ändern des BFF-Clients
resource "keycloak_realm_client_policy_profile_policy" "m2m_dpop" {
  count       = var.m2m ? 1 : 0
  realm_id    = local.realm
  name        = "${var.product}-m2m-dpop"
  description = "Maschinen-Clients der Organisationen (Attribut ${var.product}.m2m = true)"
  profiles    = [keycloak_realm_client_policy_profile.m2m_dpop[0].name]

  condition {
    name = "client-attributes"
    configuration = {
      "is-negative-logic" = "false"
      attributes          = jsonencode([{ key = "${var.product}.m2m", value = "true" }])
    }
  }
}
