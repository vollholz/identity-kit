# Texte der Anmeldeseiten und E-Mails (Einladung, Passwort festlegen/vergessen, Bestätigungen, Fehlermeldungen) in
# Du-Form und Schweizer Rechtschreibung (Entscheid 2026-10-20: ganze App in Du-Form). Die Realm-Texte überschreiben die
# gleichnamigen Schlüssel des Keycloak-Standards (de) und des Themes «identity».
#
# localization-de.json: genau die Schlüssel des Standards mit Sie-Form oder ß, umformuliert.
# localization-de.source.json: die Originaltexte dieser Schlüssel (Keycloak 26.8.1) als Referenz für Updates;
# test/infra-keycloak.test.ts prüft gleiche Schlüssel, gleiche Platzhalter und HTML-Tags und keine Sie-Form.
#
# localization-account-de.json / .source.json: dasselbe für die Kontoverwaltung (Account Console keycloak.v3, Texte aus
# keycloak-account-ui-26.8.1.jar). Eigene Dateien, weil Quelle und Platzhalter ({{name}} statt {0}) andere sind. Die
# Realm-Texte sind ein Namensraum für Login, Konto und E-Mails: Schlüssel, die beide Standards kennen, stehen nur in
# localization-de.json und passen für beide Seiten (der Test prüft, dass sich die Dateien nicht überschneiden).
#
# localization-invite.json: E-Mail «executeActions» als Einladung (de/en). Die Plattform sendet sie nur für Einladungen:
# mit Passwort (UPDATE_PASSWORD, VERIFY_EMAIL) und aus Microsoft Entra ID (nur VERIFY_EMAIL, Nr. 104 Teil 2). Der Text
# passt deshalb für beide Fälle; {3} sind die Schritte, {2} der Name des Realms. Dazu die Seiten nach dem Link
# (confirmExecutionOfActions, accountUpdatedTitle/-Message): Keycloak zeigt sie nur nach Links mit Aktionen, die die
# Administration sendet – hier also nur nach Einladungen.
#
# localization-theme.json: Werte für das Theme «identity» der Identity-Plattform (vollholz/identity, docs/betrieb.md ›
# Anmeldeseiten): Akzentfarbe, Claim und Stichworte der Bühne, kurze Login-Titel (die zweite, graue Zeile liefert das
# Theme aus themeSub.<Seite>); je Sprache, überschreibt die übrigen Dateien.
locals {
  theme_texts  = jsondecode(file("${path.module}/localization-theme.json"))
  invite_texts = jsondecode(file("${path.module}/localization-invite.json"))
}

resource "keycloak_realm_localization" "de" {
  realm_id = keycloak_realm.assets.id
  locale   = "de"
  texts = merge(
    jsondecode(file("${path.module}/localization-de.json")),
    jsondecode(file("${path.module}/localization-account-de.json")),
    local.invite_texts.de,
    local.theme_texts.de,
  )
}

resource "keycloak_realm_localization" "en" {
  realm_id = keycloak_realm.assets.id
  locale   = "en"
  texts    = merge(local.invite_texts.en, local.theme_texts.en)
}
