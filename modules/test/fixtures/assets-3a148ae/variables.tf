variable "state_passphrase" {
  description = "Passphrase der State-Verschlüsselung (TF_STATE_PASSPHRASE, wie infra/hetzner)."
  type        = string
  sensitive   = true
}

variable "keycloak_url" {
  description = "Adresse der Keycloak-Instanz ohne Basispfad."
  type        = string
  default     = "https://identity.project-suite.ch"
}

variable "keycloak_base_path" {
  description = "Basispfad der Instanz (leer: identity.project-suite.ch hat keinen relativen Pfad)."
  type        = string
  default     = ""
}



variable "realm" {
  description = "Realm der Plattform (eigener Realm, Entscheid Nr. 52; nie master oder project-suite)."
  type        = string
  default     = "assets"
  validation {
    condition     = !contains(["master", "project-suite"], var.realm)
    error_message = "Die Plattform braucht einen eigenen Realm."
  }
}


variable "public_base_url" {
  description = "Adresse der Oberfläche (PUBLIC_BASE_URL)."
  type        = string
  default     = "https://assets.project-suite.ch"
}

variable "mcp_cli_callback_port" {
  description = "Fester Loopback-Port für MCP-Hosts mit exaktem Abgleich der Weiterleitung."
  type        = number
  default     = 8765
}

variable "mcp_extra_redirect_uris" {
  description = "Weitere Weiterleitungen des öffentlichen MCP-Clients (Claude Desktop/Web)."
  type        = list(string)
  default     = ["https://claude.ai/api/mcp/auth_callback"]
}

variable "smtp" {
  description = "Ausgehende Mails des Realms (wie Realm project-suite: Infomaniak, STARTTLS, Anmeldung). host leer = kein SMTP."
  type = object({
    host              = optional(string, "mail.infomaniak.com")
    port              = optional(number, 587)
    from              = optional(string, "noreply@project-suite.ch")
    from_display_name = optional(string, "Assets")
    reply_to          = optional(string, "")
    starttls          = optional(bool, true)
    ssl               = optional(bool, false)
    # Anmeldung mit der Postfachadresse; mit dem Login des Infomaniak-Kontos lehnt der Server ab (535)
    user = optional(string, "noreply@project-suite.ch")
  })
  default = {}
}

variable "smtp_password" {
  description = "Passwort des SMTP-Kontos, nur aus der Umgebung (TF_VAR_smtp_password; kc.sh liest SMTP_PASSWORD aus der .env)."
  type        = string
  default     = ""
  sensitive   = true
}
