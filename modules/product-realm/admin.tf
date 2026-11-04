# Service Accounts des Produkts für die Admin-API des Realms (Spezifikation 3.7; Rechte so knapp, wie Keycloak es
# zulässt – live geprüft mit 26.8.1, modules/test/keycloak.sh):
#   <produkt>-admin  Verwaltung (API): Organisationen über realm-management/manage-organizations (ab Keycloak 26.8;
#                    davor nur mit manage-realm), Realm lesen über view-realm (E-Mail-Versand eingerichtet?); Benutzer
#                    über feingranulare Admin-Rechte v2 lesen und verwalten (keine Rollen-Zuweisung, keine Clients);
#                    Identitätsanbieter für Entra ID über manage-identity-providers (entra.tf, nur mit var.entra)
#   <produkt>-sync   Abgleich der Mitglieder (Worker): view-organizations, Benutzer nur lesen (FGAP v2)
# Kein manage-realm: damit liessen sich Anmeldeabläufe, Schlüssel und Realm-Einstellungen ändern.
# Beide melden sich nur mit private_key_jwt an; Tokens 120 s, keine Refresh-Tokens.

locals {
  service_clients = {
    admin = { client_id = "${var.product}-admin", name = "${var.display_name} Verwaltung", description = "Service Account der Plattform für Organisationen, Mitglieder und Rollen (Admin-API). Nur für die API der Plattform." }
    sync  = { client_id = "${var.product}-sync", name = "${var.display_name} Abgleich", description = "Service Account des Workers: liest Organisationen und Mitglieder für das Personenverzeichnis." }
  }
}

resource "keycloak_openid_client" "service" {
  for_each                              = local.service_clients
  realm_id                              = local.realm
  client_id                             = each.value.client_id
  name                                  = each.value.name
  description                           = each.value.description
  access_type                           = "CONFIDENTIAL"
  client_authenticator_type             = "client-jwt"
  standard_flow_enabled                 = false
  implicit_flow_enabled                 = false
  direct_access_grants_enabled          = false
  service_accounts_enabled              = true
  frontchannel_logout_enabled           = false
  pkce_code_challenge_method            = "S256"
  access_token_lifespan                 = "120"
  use_refresh_tokens                    = false
  use_refresh_tokens_client_credentials = false
  extra_config                          = merge(local.platform_mark, local.jwt_auth[each.key])

  depends_on = [keycloak_realm_client_policy_profile_policy.code_flow, keycloak_realm_client_policy_profile_policy.confidential]
}

# Interne IDs der eingebauten Clients über scripts/lookup.ts: data "keycloak_openid_client" liest das Client-Secret, was
# Keycloak ab 26.8 verweigert (403). admin-permissions entsteht mit admin_permissions_enabled, das
# product-realm-bootstrap schon bei der Anlage setzt. Bewusst ohne Bezug auf die Realm-Ressource: sonst wären die IDs
# bei jeder Realm-Änderung unbekannt und OpenTofu würde die Zuweisungen neu anlegen.
locals {
  lookup_query = {
    url           = "${trimsuffix(var.keycloak_url, "/")}${trimsuffix(var.keycloak_base_path, "/")}"
    realm         = local.realm_name
    iac_client_id = local.iac_client_id
  }
}

data "external" "realm_management" {
  program = ["node", "${path.module}/scripts/lookup.ts"]
  query   = merge(local.lookup_query, { client_id = "realm-management" })
}

locals {
  service_roles = {
    "admin/manage-organizations" = { client = "admin", role = "manage-organizations" }
    "admin/view-realm"           = { client = "admin", role = "view-realm" }
    "sync/view-organizations"    = { client = "sync", role = "view-organizations" }
  }
}

resource "keycloak_openid_client_service_account_role" "service" {
  for_each                = local.service_roles
  realm_id                = local.realm
  service_account_user_id = keycloak_openid_client.service[each.value.client].service_account_user_id
  client_id               = data.external.realm_management.result.id
  role                    = each.value.role
}

# Bis 2.x hatten beide manage-realm (Ressource manage_realm): Der erste Plan nach dem Wechsel entfernt diese Zuweisung
# (destroy betrifft nur die Rollenzuweisung, nicht den Client).

# ---------- Feingranulare Admin-Rechte v2 (Realm: admin_permissions_enabled)
# Je Scope genau eine Berechtigung über alle Benutzer: «view» für <produkt>-admin und <produkt>-sync, «manage» nur für
# <produkt>-admin (Mitgliederverwaltung). Rechte auf Gruppen gibt es nicht: Rollen liegen in der App-Datenbank.

data "external" "admin_permissions" {
  program = ["node", "${path.module}/scripts/lookup.ts"]
  query   = merge(local.lookup_query, { client_id = "admin-permissions" })
}

resource "keycloak_openid_client_client_policy" "admin_service_account" {
  realm_id           = local.realm
  resource_server_id = data.external.admin_permissions.result.id
  name               = "${var.product}-admin: Service Account"
  description        = "Service Account der Plattform-Verwaltung"
  clients            = [keycloak_openid_client.service["admin"].id]
  logic              = "POSITIVE"
  decision_strategy  = "UNANIMOUS"
}

# Erfüllt, wenn der anfragende Client einer der beiden Service Accounts ist
resource "keycloak_openid_client_client_policy" "service_accounts" {
  realm_id           = local.realm
  resource_server_id = data.external.admin_permissions.result.id
  name               = "${var.product}: Service Accounts der Plattform"
  description        = "Verwaltung (${var.product}-admin) und Abgleich (${var.product}-sync)"
  clients            = [for k in ["admin", "sync"] : keycloak_openid_client.service[k].id]
  logic              = "POSITIVE"
  decision_strategy  = "UNANIMOUS"
}

locals {
  admin_permissions = {
    users      = { name = "${var.product}-admin: Benutzer", description = "Konten anlegen, einladen, entfernen; Mitgliedschaft in Organisationen", type = "Users", scopes = ["manage"], policy = "admin" }
    users_view = { name = "${var.product}: Benutzer lesen", description = "Konten und Mitglieder lesen (Verwaltung und Abgleich)", type = "Users", scopes = ["view"], policy = "service_accounts" }
  }
  admin_policy_ids = {
    admin            = keycloak_openid_client_client_policy.admin_service_account.id
    service_accounts = keycloak_openid_client_client_policy.service_accounts.id
  }
  admin_scope_names = distinct(flatten([for p in local.admin_permissions : p.scopes]))
}

data "keycloak_openid_client_authorization_scope" "admin" {
  for_each           = toset(local.admin_scope_names)
  realm_id           = local.realm
  resource_server_id = data.external.admin_permissions.result.id
  name               = each.key
}

resource "keycloak_openid_client_authorization_permission" "admin" {
  for_each           = local.admin_permissions
  realm_id           = local.realm
  resource_server_id = data.external.admin_permissions.result.id
  name               = each.value.name
  description        = each.value.description
  type               = "scope"
  resource_type      = each.value.type
  scopes             = [for s in each.value.scopes : data.keycloak_openid_client_authorization_scope.admin[s].id]
  policies           = [local.admin_policy_ids[each.value.policy]]
  decision_strategy  = "UNANIMOUS"

  # Keycloak legt für «alle Benutzer/Gruppen» intern eine Ressource an und meldet sie zurück; sie folgt aus resource_type
  lifecycle {
    ignore_changes = [resources]
  }
}
