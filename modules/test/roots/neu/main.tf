variable "product" {
  type = string
}

variable "switches" {
  description = "Alle Schalter (m2m, mcp, entra, SMTP) an oder aus."
  type        = bool
}

import {
  to = module.realm.keycloak_realm.this
  id = var.product
}

module "realm" {
  source = "../../../product-realm"

  product            = var.product
  display_name       = "Neu ${var.product}"
  public_base_url    = "https://${var.product}.example.ch/"
  keycloak_url       = var.keycloak_url
  keycloak_base_path = var.keycloak_base_path

  catalog = {
    scopes = ["${var.product}:read", "notes:write"]
  }
  theme_texts = {
    de = { themeAccent = "#0D6B5B", themeClaim = "Alles an einem Ort." }
    en = { themeAccent = "#0D6B5B", themeClaim = "All in one place." }
  }
  localization = { en = { loginAccountTitle = "Sign in" } }
  jwks         = { for c in concat(["platform", "admin", "sync"], var.switches ? ["mcp"] : []) : c => file("${var.keys_dir}/${var.product}-${c}.json") }

  smtp          = var.switches ? { host = "smtp.example.ch", from = "noreply@example.ch", user = "noreply@example.ch" } : null
  smtp_password = var.smtp_password

  m2m                     = var.switches
  mcp                     = var.switches
  mcp_extra_redirect_uris = ["https://claude.ai/api/mcp/auth_callback"]
  entra                   = var.switches

  # Maschinen-Client für zwei Organisationen (System-Client); die Organisationen müssen in Keycloak nicht bestehen
  machine_clients = var.switches ? {
    "${var.product}-export" = {
      organizations = ["acme", "zeta"]
      scopes        = ["${var.product}:read"]
      jwks          = file("${var.keys_dir}/${var.product}-m2m.json")
    }
  } : {}
}

output "issuer" {
  value = module.realm.issuer
}

output "clients" {
  value = module.realm.clients
}
