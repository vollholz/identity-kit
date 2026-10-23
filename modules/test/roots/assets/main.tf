locals {
  # In Assets: path.module (infra/keycloak)
  assets   = "${path.module}/../../fixtures/assets-3a148ae"
  platform = jsondecode(file("${local.assets}/platform.json"))
}

# Beim Neuaufbau legt bootstrap/ den Realm an; hier wird er übernommen (ohne Wirkung, wenn er schon im State ist)
import {
  to = module.realm.keycloak_realm.this
  id = "assets"
}

module "realm" {
  source = "../../../product-realm"

  product            = "assets"
  display_name       = "Assets"
  public_base_url    = "https://assets.project-suite.ch"
  keycloak_url       = var.keycloak_url
  keycloak_base_path = var.keycloak_base_path

  # Der Stand 3a148ae führt org-admin noch im Katalog; seit Modul 0.2.0 legt das Modul die Rolle an
  catalog     = { roles = { for k, v in local.platform.roles : k => v if k != "org-admin" }, scopes = local.platform.scopes }
  theme_texts = jsondecode(file("${local.assets}/localization-theme.json"))
  jwks        = { for c in ["platform", "admin", "sync", "mcp"] : c => file("${var.keys_dir}/assets-${c}.json") }

  smtp = {
    host = "mail.infomaniak.com"
    from = "noreply@project-suite.ch"
    user = "noreply@project-suite.ch"
  }
  smtp_password = var.smtp_password

  m2m                     = true
  mcp                     = true
  mcp_extra_redirect_uris = ["https://claude.ai/api/mcp/auth_callback"]
  entra                   = true
}

output "issuer" {
  value = module.realm.issuer
}

output "clients" {
  value = module.realm.clients
}
