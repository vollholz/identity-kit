# {{MARK}}
#
# Realm der App aus dem Modul product-realm (Spezifikation Kap. 3). Alle Werte kommen aus identity.app.json (Zone
# «Einstellbar»); was das Modul fest vorgibt (Sicherheit, Clients, Richtlinien), ist hier nicht änderbar (Zone «Fest»).
# Aufruf: ./kc.sh init | plan | apply; in GitHub über den Workflow «Keycloak».

locals {
  app      = jsondecode(file("${path.module}/../../identity.app.json"))
  settings = try(local.app.realm, {})
  mcp      = try(local.settings.mcp, false)
}

# Den Realm hat bootstrap/ angelegt; hier wird er übernommen (ohne Wirkung, wenn er schon im State ist)
import {
  to = module.realm.keycloak_realm.this
  id = local.app.product
}

module "realm" {
  source = "git::https://github.com/vollholz/identity-kit.git//modules/product-realm?ref=product-realm-v{{PRODUCT_REALM}}"

  product            = local.app.product
  display_name       = local.app.displayName
  public_base_url    = local.app.publicBaseUrl
  keycloak_url       = var.keycloak_url
  keycloak_base_path = var.keycloak_base_path

  # Scopes aus dem Modell der App (node infra/keycloak/platform.ts > infra/keycloak/platform.json)
  catalog = jsondecode(file("${path.module}/platform.json"))
  jwks    = { for c in concat(["platform", "admin", "sync"], local.mcp ? ["mcp"] : []) : c => file("${path.module}/keys/${local.app.product}-${c}.json") }

  theme             = try(local.settings.theme, null)
  theme_texts       = try(local.settings.themeTexts, null) == null ? {} : jsondecode(file("${path.module}/../../${local.settings.themeTexts}"))
  localization      = try(local.settings.localization, null) == null ? {} : jsondecode(file("${path.module}/../../${local.settings.localization}"))
  supported_locales = try(local.settings.supportedLocales, ["de", "en"])

  smtp = try(local.settings.smtp, null) == null ? null : {
    host              = local.settings.smtp.host
    port              = try(local.settings.smtp.port, 587)
    from              = local.settings.smtp.from
    from_display_name = try(local.settings.smtp.fromDisplayName, null)
    reply_to          = try(local.settings.smtp.replyTo, "")
    starttls          = try(local.settings.smtp.starttls, true)
    ssl               = try(local.settings.smtp.ssl, false)
    user              = local.settings.smtp.user
  }
  smtp_password = var.smtp_password

  m2m                     = try(local.settings.m2m, false)
  mcp                     = local.mcp
  mcp_cli_callback_port   = try(local.settings.mcpCallbackPort, 8765)
  mcp_extra_redirect_uris = try(local.settings.mcpExtraRedirectUris, [])
  entra                   = try(local.settings.entra, false)
  entra_deny_message      = try(local.settings.entraDenyMessage, "Dein Microsoft-Konto ist für diese Organisation nicht freigeschaltet. Bitte wende dich an die Administration deiner Organisation.")

  # Maschinen-Clients: Organisationen und Scopes im Manifest, öffentlicher Schlüssel in keys/<client>.json
  machine_clients = {
    for id, m in try(local.settings.machineClients, {}) : id => {
      name          = try(m.name, null)
      description   = try(m.description, "")
      organizations = m.organizations
      scopes        = try(m.scopes, [])
      jwks          = file("${path.module}/keys/${id}.json")
    }
  }
}
