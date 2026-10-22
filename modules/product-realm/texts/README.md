# Texte des Baukastens

Realm-Texte, die das Modul mit `standard_texts = true` setzt (localization.tf). Herkunft: vollholz/assets
`infra/keycloak` (`3a148ae`), Keycloak 26.8.1.

| Datei | Inhalt |
|---|---|
| `localization-de.json` | genau die Schlüssel des Keycloak-Standards (Login, E-Mails) mit Sie-Form oder ß, in Du-Form und Schweizer Rechtschreibung |
| `localization-de.source.json` | Originaltexte dieser Schlüssel (Keycloak 26.8.1) als Referenz für Updates |
| `localization-account-de.json`, `.source.json` | dasselbe für die Kontoverwaltung (Account Console keycloak.v3, Platzhalter `{{name}}`) |
| `localization-invite.json` | E-Mail «executeActions» als Einladung (de, en) und die Seiten nach dem Link; `__PRODUKT__` im Betreff ersetzt das Modul durch `display_name` |

Die Realm-Texte sind ein Namensraum für Login, Konto und E-Mails; Schlüssel, die beide Standards kennen, stehen nur in
`localization-de.json`. `test/texts.test.ts` prüft gleiche Schlüssel, Platzhalter und HTML-Tags wie die Quelle, keine
Sie-Form, kein ß und keine Überschneidungen. Bei jedem Keycloak-Update die `*.source.json` mit der neuen Version
vergleichen und geänderte Schlüssel nachziehen.
