locals {
  # Rollen und Scopes aus dem Rechtekatalog der App (platform.json, dort vom Test auf Aktualität geprüft)
  realm = keycloak_realm.this.id

  # Von Keycloak beim Anlegen des Realms erzeugte Scopes, die die Clients des Produkts als Standard erhalten
  builtin_scopes = ["profile", "email", "roles", "web-origins", "acr", "basic"]

  # Markiert Clients des Produkts (Prüfung auf fremde Clients, Spezifikation 3.8)
  platform_mark = { "${var.product}.platform" = "true" }
}

# Rechte-Scopes für Maschinen-Clients und MCP (ein Scope deckt mehrere Rechte ab)
resource "keycloak_openid_client_scope" "permission" {
  for_each               = toset(var.catalog.scopes)
  realm_id               = local.realm
  name                   = each.key
  description            = "${var.display_name}: ${each.key}"
  consent_screen_text    = "${var.display_name}: ${each.key}"
  include_in_token_scope = true
}

# Zielgruppe des MCP-Dienstes (Tokens der MCP-Hosts)
resource "keycloak_openid_client_scope" "mcp" {
  count                  = var.mcp ? 1 : 0
  realm_id               = local.realm
  name                   = "${var.product}-mcp"
  description            = "Zugriff über MCP-Werkzeuge"
  consent_screen_text    = "Zugriff über MCP-Werkzeuge"
  include_in_token_scope = true
}

resource "keycloak_openid_audience_protocol_mapper" "mcp_scope_audience" {
  count                      = var.mcp ? 1 : 0
  realm_id                   = local.realm
  client_scope_id            = keycloak_openid_client_scope.mcp[0].id
  name                       = "aud-mcp"
  included_client_audience   = "${var.product}-mcp"
  add_to_access_token        = true
  add_to_id_token            = false
  add_to_token_introspection = true

  depends_on = [keycloak_openid_client.mcp]
}

# Scope «organization»: legt Keycloak beim Anlegen des Realms selbst an (mit Mapper). Der Mapper soll zusätzlich die
# Organisations-ID liefern (Claim {alias: {id}}; Aliase können neu vergeben werden, die ID nicht). Der Provider kann
# einen von Keycloak erzeugten Mapper nicht übernehmen; deshalb gleicht scripts/org-mapper.ts ihn idempotent ab
# (Admin-API, IaC-Client). Der Auslöser enthält die Soll-Konfiguration: ändert sie sich, läuft er erneut.
data "keycloak_openid_client_scope" "organization" {
  realm_id = local.realm
  name     = "organization"
}

locals {
  organization_mapper = {
    "claim.name"                = "organization"
    "multivalued"               = "true"
    "addOrganizationId"         = "true"
    "addOrganizationAttributes" = "false"
    "jsonType.label"            = "JSON"
    "access.token.claim"        = "true"
    "id.token.claim"            = "true"
    "userinfo.token.claim"      = "true"
    "introspection.token.claim" = "true"
    "lightweight.claim"         = "false"
  }
}

resource "terraform_data" "organization_mapper" {
  triggers_replace = {
    scope  = data.keycloak_openid_client_scope.organization.id
    config = jsonencode(local.organization_mapper)
  }

  provisioner "local-exec" {
    command = "node scripts/org-mapper.ts"
    # Anmeldung als IaC-Client: KEYCLOAK_IAC_PRIVATE_KEY kommt aus der Umgebung von kc.sh
    environment = {
      KEYCLOAK_URL           = local.lookup_query.url
      KEYCLOAK_REALM         = local.realm_name
      KEYCLOAK_IAC_CLIENT_ID = local.iac_client_id
      ORGANIZATION_MAPPER    = jsonencode(local.organization_mapper)
    }
    working_dir = path.module
  }
}
