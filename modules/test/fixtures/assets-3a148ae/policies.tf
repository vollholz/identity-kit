# Client-Richtlinien des Realms (Nr. 59, wie scripts/keycloak-setup.ts). Realmweit, gelten also auch für Clients, die
# später jemand in der Konsole anlegt:
#   assets-code-flow    alle Clients: PKCE S256 Pflicht, kein Implicit Flow, kein Passwort-Grant
#   assets-confidential vertrauliche Clients: nur sichere Client-Authentifizierung, neue Clients mit private_key_jwt
#   assets-m2m-dpop     Maschinen-Clients der Organisationen (Attribut assets.m2m = true): nur DPoP-gebundene Tokens
# Die Clients der Plattform setzen die erzwungenen Werte selbst (PKCE, keine Implicit-/Passwort-Grants), damit die
# Auto-Konfiguration der Richtlinien keine Abweichung zum OpenTofu-Stand erzeugt.

resource "keycloak_realm_client_policy_profile" "code_flow" {
  realm_id    = local.realm
  name        = "assets-code-flow"
  description = "Assets: PKCE S256, kein Implicit Flow, kein Passwort-Grant"

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
  name        = "assets-confidential"
  description = "Assets: sichere Client-Authentifizierung"

  executor {
    name = "secure-client-authenticator"
    configuration = {
      # Client-Geheimnisse bleiben für Maschinen-Clients der Organisationen erlaubt; die Plattform selbst nutzt nur
      # private_key_jwt (KEYCLOAK_CLIENT_AUTH=jwt in keycloak-setup.ts entspricht ["client-jwt","client-x509"]).
      "allowed-client-authenticators" = jsonencode(["client-jwt", "client-x509", "client-secret"])
      "default-client-authenticator"  = "client-jwt"
    }
  }
}

resource "keycloak_realm_client_policy_profile" "m2m_dpop" {
  realm_id    = local.realm
  name        = "assets-m2m-dpop"
  description = "Assets: Maschinen-Clients nur mit DPoP-gebundenen Tokens"

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
  name        = "assets-code-flow"
  description = "Alle Clients des Realms"
  profiles    = [keycloak_realm_client_policy_profile.code_flow.name]

  condition {
    name          = "any-client"
    configuration = {}
  }
}

resource "keycloak_realm_client_policy_profile_policy" "confidential" {
  realm_id    = local.realm
  name        = "assets-confidential"
  description = "Vertrauliche Clients"
  profiles    = [keycloak_realm_client_policy_profile.confidential.name]

  condition {
    name          = "client-access-type"
    configuration = { type = jsonencode(["confidential"]) }
  }
}

resource "keycloak_realm_client_policy_profile_policy" "m2m_dpop" {
  realm_id    = local.realm
  name        = "assets-m2m-dpop"
  description = "Maschinen-Clients der Organisationen (Attribut assets.m2m = true)"
  profiles    = [keycloak_realm_client_policy_profile.m2m_dpop.name]

  condition {
    name = "client-attributes"
    configuration = {
      "is-negative-logic" = "false"
      attributes          = jsonencode([{ key = "assets.m2m", value = "true" }])
    }
  }
}
