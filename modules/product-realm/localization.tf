# Texte der Anmeldeseiten, E-Mails und Kontoverwaltung je Sprache. Die Realm-Texte überschreiben die gleichnamigen
# Schlüssel des Keycloak-Standards und des Themes «identity». Reihenfolge (spätere gewinnen):
#   1. Texte des Baukastens (var.standard_texts, texts/README.md): Du-Form und Schweizer Rechtschreibung (de) für Login,
#      E-Mails und Kontoverwaltung; Einladungs-E-Mail «executeActions» (de, en) mit display_name
#   2. var.localization: weitere Texte der App
#   3. var.theme_texts: Akzent, Claim, Stichworte, kurze Login-Titel des Themes «identity»
# Eine Ressource je Sprache aus supported_locales, auch ohne Texte (leere Liste).

locals {
  invite_texts = {
    for locale, texts in jsondecode(file("${path.module}/texts/localization-invite.json")) :
    locale => { for k, v in texts : k => replace(v, "__PRODUKT__", var.display_name) }
  }
  standard_texts = {
    de = merge(
      jsondecode(file("${path.module}/texts/localization-de.json")),
      jsondecode(file("${path.module}/texts/localization-account-de.json")),
      local.invite_texts.de,
    )
    en = local.invite_texts.en
  }
}

resource "keycloak_realm_localization" "this" {
  for_each = toset(var.supported_locales)
  realm_id = keycloak_realm.this.id
  locale   = each.key
  texts = merge(
    var.standard_texts ? lookup(local.standard_texts, each.key, {}) : {},
    lookup(var.localization, each.key, {}),
    lookup(var.theme_texts, each.key, {}),
  )
}
