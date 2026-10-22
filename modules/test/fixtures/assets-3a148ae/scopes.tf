locals {
  # Rollen und Scopes aus src/platform/authz/permissions.ts (platform.json, vom Test auf Aktualität geprüft)
  platform = jsondecode(file("${path.module}/platform.json"))
  realm    = keycloak_realm.assets.id

  # Von Keycloak beim Anlegen des Realms erzeugte Scopes, die die Clients der Plattform als Standard erhalten
  builtin_scopes = ["profile", "email", "roles", "web-origins", "acr", "basic"]

  # Markiert Clients der Plattform (Prüfung auf fremde Clients, Nr. 57)
  platform_mark = { "assets.platform" = "true" }
}

# Rechte-Scopes für Maschinen-Clients und MCP (ein Scope deckt mehrere Rechte ab)
resource "keycloak_openid_client_scope" "permission" {
  for_each               = toset(local.platform.scopes)
  realm_id               = local.realm
  name                   = each.key
  description            = "Assets: ${each.key}"
  consent_screen_text    = "Assets: ${each.key}"
  include_in_token_scope = true
}

# Zielgruppe des MCP-Dienstes (Tokens der MCP-Hosts)
resource "keycloak_openid_client_scope" "mcp" {
  realm_id               = local.realm
  name                   = "assets-mcp"
  description            = "Zugriff über MCP-Werkzeuge"
  consent_screen_text    = "Zugriff über MCP-Werkzeuge"
  include_in_token_scope = true
}

resource "keycloak_openid_audience_protocol_mapper" "mcp_scope_audience" {
  realm_id                   = local.realm
  client_scope_id            = keycloak_openid_client_scope.mcp.id
  name                       = "aud-mcp"
  included_client_audience   = "assets-mcp"
  add_to_access_token        = true
  add_to_id_token            = false
  add_to_token_introspection = true

  depends_on = [keycloak_openid_client.mcp]
}

# Scope «organization»: legt Keycloak beim Anlegen des Realms selbst an (mit Mapper). Der Mapper soll zusätzlich die
# Organisations-ID liefern (offener Punkt Nr. 69: Aliase können neu vergeben werden, die ID nicht). Der Provider kann
# einen von Keycloak erzeugten Mapper nicht übernehmen; deshalb gleicht org-mapper.ts ihn idempotent ab
# (Admin-API, gleicher Service Account). Der Auslöser enthält die Soll-Konfiguration: ändert sie sich, läuft er erneut.
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
    command = "node org-mapper.ts"
    # Anmeldung als assets-iac: KEYCLOAK_IAC_PRIVATE_KEY kommt aus der Umgebung von kc.sh
    environment = {
      KEYCLOAK_REALM         = var.realm
      ORGANIZATION_MAPPER    = jsonencode(local.organization_mapper)
      KEYCLOAK_TF_URL_ORIGIN = var.keycloak_url
      KEYCLOAK_TF_BASE_PATH  = var.keycloak_base_path
    }
    working_dir = path.module
  }
}
