# ---------- Produkt und Adressen

variable "product" {
  description = "Technischer Name des Produkts (<produkt>, z. B. assets). Daraus folgen alle Namen: Clients <produkt>-platform, -api, -admin, -sync, -mcp, -mcp-cli, Richtlinien <produkt>-code-flow …, Attribute <produkt>.platform und <produkt>.m2m."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.product))
    error_message = "product: Kleinbuchstaben, Ziffern und Bindestrich, 3–32 Zeichen, beginnt mit einem Buchstaben."
  }
  # product ist ohne var.realm zugleich der Realm-Name
  validation {
    condition     = !contains(["master", "project-suite"], var.product)
    error_message = "Das Produkt braucht einen eigenen Realm (product nicht master, nicht project-suite)."
  }
}

variable "realm" {
  description = "Realm des Produkts (eigener Realm, Spezifikation Kap. 2; nie master oder der Realm eines anderen Produkts). Leer: wie product."
  type        = string
  default     = null
  validation {
    condition     = var.realm == null || !contains(["master", "project-suite"], coalesce(var.realm, "-"))
    error_message = "Das Produkt braucht einen eigenen Realm (nicht master, nicht project-suite)."
  }
}

variable "display_name" {
  description = "Anzeigename des Produkts (<Produkt>, z. B. «Assets»): Realm, Theme, Texte, Namen der Clients, SMTP-Absender."
  type        = string
  validation {
    condition     = trimspace(var.display_name) != ""
    error_message = "display_name darf nicht leer sein."
  }
}

variable "public_base_url" {
  description = "Adresse der Oberfläche (PUBLIC_BASE_URL der App), z. B. https://assets.project-suite.ch."
  type        = string
  validation {
    condition     = can(regex("^https?://[^/]+(/.*)?$", var.public_base_url))
    error_message = "public_base_url muss eine http(s)-Adresse sein."
  }
}

variable "keycloak_url" {
  description = "Adresse der Keycloak-Instanz ohne Basispfad (für Issuer und die Admin-API der Hilfsskripte)."
  type        = string
  default     = "https://identity.project-suite.ch"
}

variable "keycloak_base_path" {
  description = "Basispfad der Instanz (leer: identity.project-suite.ch hat keinen relativen Pfad)."
  type        = string
  default     = ""
}

variable "iac_client_id" {
  description = "IaC-Client des Produkts (Service Account mit realm-admin, angelegt von product-realm-bootstrap). Leer: <produkt>-iac."
  type        = string
  default     = null
}

# ---------- Rechtekatalog, Schlüssel, Texte

variable "catalog" {
  description = "Scopes aus dem Modell der App: scopes = [<scope>, …]. Rollen kennt Keycloak nicht (Rollen liegen in der App-Datenbank)."
  type = object({
    scopes = list(string)
  })
  validation {
    condition     = alltrue([for s in var.catalog.scopes : can(regex("^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$", s))])
    error_message = "Scopes: <bereich>:<verb> (Spezifikation 8.2)."
  }
}

variable "jwks" {
  description = "Öffentliche Schlüssel (JWKS, Inhalt von infra/keycloak/keys/<produkt>-<client>.json) je Client: platform, admin, sync und mit mcp = true auch mcp."
  type        = map(string)
  validation {
    condition     = length(setsubtract(["platform", "admin", "sync"], keys(var.jwks))) == 0 && length(setsubtract(keys(var.jwks), ["platform", "admin", "sync", "mcp"])) == 0
    error_message = "jwks braucht genau die Schlüssel platform, admin, sync und optional mcp."
  }
  # Genau ein EC-P-256-Schlüssel mit kid, ohne privaten Teil (wie test/infra-keycloak.test.ts in Assets)
  validation {
    condition = alltrue([for v in values(var.jwks) : try(
      length(jsondecode(v).keys) == 1 &&
      jsondecode(v).keys[0].kty == "EC" &&
      jsondecode(v).keys[0].crv == "P-256" &&
      jsondecode(v).keys[0].kid != "" &&
      !can(jsondecode(v).keys[0].d),
      false,
    )])
    error_message = "Jeder Eintrag in jwks muss ein JWKS mit genau einem öffentlichen EC-P-256-Schlüssel (mit kid, ohne d) sein."
  }
}

variable "theme_texts" {
  description = "Werte für das Theme «identity» je Sprache (themeAccent, themeAccentDark, themeAccentText, themeAccentTextDark, themeClaim, themeClaimSub, themeChips, themeSub.<Seite>, themeMailFooter, kurze Login-Titel; vollholz/identity docs/betrieb.md › Anmeldeseiten). Überschreiben alle anderen Texte."
  type        = map(map(string))
  default     = {}
  validation {
    # Das Theme übernimmt nur #RRGGBB; anderes fiele still auf Blau zurück
    condition     = alltrue(flatten([for texts in values(var.theme_texts) : [for k, v in texts : can(regex("^#[0-9A-Fa-f]{6}$", v)) if startswith(k, "themeAccent")]]))
    error_message = "theme_texts: themeAccent* nur als #RRGGBB."
  }
}

variable "localization" {
  description = "Weitere Realm-Texte je Sprache (Schlüssel der Keycloak-Messages); überschreiben die Standardtexte des Baukastens, nicht theme_texts."
  type        = map(map(string))
  default     = {}
}

variable "standard_texts" {
  description = "Texte des Baukastens: Login, E-Mails und Kontoverwaltung in Du-Form (de) und die Einladungs-E-Mail (de, en). texts/README.md."
  type        = bool
  default     = true
}

variable "supported_locales" {
  description = "Sprachen des Realms; die erste ist die Standardsprache."
  type        = list(string)
  default     = ["de", "en"]
  validation {
    condition     = length(var.supported_locales) > 0
    error_message = "Mindestens eine Sprache."
  }
}

# ---------- SMTP

variable "smtp" {
  description = "Ausgehende Mails des Realms (Einladungen, Passwort festlegen/vergessen) über das eigene Konto des Produkts. null: kein SMTP. Gesetzt: host, from und user Pflicht; from_display_name leer: display_name."
  type = object({
    host              = optional(string)
    port              = optional(number, 587)
    from              = optional(string)
    from_display_name = optional(string)
    reply_to          = optional(string, "")
    starttls          = optional(bool, true)
    ssl               = optional(bool, false)
    # Bei Infomaniak die Postfachadresse; mit dem Login des Kontos lehnt der Server ab (535)
    user = optional(string)
  })
  default = null
  # Keine Vorgaben für Server und Konto: eine App soll nie stillschweigend das Postfach einer anderen nutzen
  validation {
    condition     = var.smtp == null || alltrue([for v in [try(var.smtp.host, null), try(var.smtp.from, null), try(var.smtp.user, null)] : v != null && trimspace(coalesce(v, " ")) != ""])
    error_message = "smtp: host, from und user angeben (eigenes Konto des Produkts) oder smtp = null."
  }
}

variable "smtp_password" {
  description = "Passwort des SMTP-Kontos, nur aus der Umgebung (TF_VAR_smtp_password; kc.sh liest SMTP_PASSWORD aus der .env)."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------- Zugänge (Spezifikation Kap. 12)

variable "m2m" {
  description = "Maschinen-Clients der Organisationen (Kap. 12.1): Richtlinie <produkt>-m2m-dpop (DPoP-Pflicht für Clients mit Attribut <produkt>.m2m = true)."
  type        = bool
  default     = false
}

variable "mcp" {
  description = "MCP-Dienst (Kap. 12.2): Clients <produkt>-mcp (Token Exchange) und <produkt>-mcp-cli (öffentlich, mit offline_access), Scope <produkt>-mcp."
  type        = bool
  default     = false
}

variable "mcp_cli_callback_port" {
  description = "Fester Loopback-Port für MCP-Hosts mit exaktem Abgleich der Weiterleitung."
  type        = number
  default     = 8765
}

variable "mcp_extra_redirect_uris" {
  description = "Weitere Weiterleitungen des öffentlichen MCP-Clients, z. B. https://claude.ai/api/mcp/auth_callback."
  type        = list(string)
  default     = []
}

variable "entra" {
  description = "Anmeldung über Microsoft Entra ID je Organisation (Kap. 9.4): manage-identity-providers für <produkt>-admin, Ablauf «Erstanmeldung verweigern», Claim identity_provider, Weiterleitung /auth/entra/*."
  type        = bool
  default     = false
}

variable "entra_deny_message" {
  description = "Meldung, wenn sich ein nicht vorab verknüpftes Microsoft-Konto anmelden will."
  type        = string
  default     = "Dein Microsoft-Konto ist für diese Organisation nicht freigeschaltet. Bitte wende dich an die Administration deiner Organisation."
}

variable "machine_clients" {
  description = <<-EOT
    Maschinen-Clients als Code (Kap. 12.1, B4), Schlüssel = Client-ID. organizations: Aliasse der Organisationen, für
    die der Client Tokens erhält (einer: Organisations-Client; mehrere: System-Client, je Aufruf X-Tenant). Rollen
    gibt es in Keycloak nicht: die Rolle der Maschine liegt als Client-Freigabe in der App-Datenbank. scopes:
    Rechte-Scopes des Katalogs. jwks: öffentlicher Schlüssel (JWKS, EC P-256, z. B. keys/<client>.json). Nur REST-API (Zielgruppe
    <produkt>-api). Wirksam erst mit der Freigabe in der jeweiligen Organisation (App, members:admin). Braucht m2m = true.
  EOT
  type = map(object({
    name          = optional(string)
    description   = optional(string, "")
    organizations = list(string)
    scopes        = optional(list(string), [])
    jwks          = string
  }))
  default = {}
  validation {
    condition     = alltrue([for c in keys(var.machine_clients) : can(regex("^[a-z0-9][a-z0-9._-]{2,62}$", c))])
    error_message = "machine_clients: Client-ID ^[a-z0-9][a-z0-9._-]{2,62}$."
  }
  # Nicht die Clients des Produkts, des Bootstraps oder die eingebauten von Keycloak
  validation {
    condition = length(setintersection(keys(var.machine_clients), concat(
      [for s in ["platform", "api", "admin", "sync", "iac", "tofu", "mcp", "mcp-cli"] : "${var.product}-${s}"],
      ["account", "account-console", "admin-cli", "admin-permissions", "broker", "realm-management", "security-admin-console"],
    ))) == 0
    error_message = "machine_clients: Client-ID ist für das Produkt oder Keycloak reserviert."
  }
  validation {
    condition = alltrue([for m in values(var.machine_clients) : length(m.organizations) > 0 && length(distinct(m.organizations)) == length(m.organizations)
    && alltrue([for a in m.organizations : can(regex("^[a-z0-9][a-z0-9_-]{0,62}$", a))])])
    error_message = "machine_clients: organizations mit mindestens einem Alias (^[a-z0-9][a-z0-9_-]{0,62}$), ohne Doppelte."
  }
  validation {
    condition     = alltrue([for m in values(var.machine_clients) : length(setsubtract(m.scopes, var.catalog.scopes)) == 0])
    error_message = "machine_clients: scopes nur aus catalog.scopes."
  }
  validation {
    condition = alltrue([for m in values(var.machine_clients) : try(
      length(jsondecode(m.jwks).keys) == 1 &&
      jsondecode(m.jwks).keys[0].kty == "EC" &&
      jsondecode(m.jwks).keys[0].crv == "P-256" &&
      jsondecode(m.jwks).keys[0].kid != "" &&
      !can(jsondecode(m.jwks).keys[0].d),
      false,
    )])
    error_message = "machine_clients: jwks mit genau einem öffentlichen EC-P-256-Schlüssel (mit kid, ohne d)."
  }
}
