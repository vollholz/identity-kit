# {{MARK}}

variable "state_passphrase" {
  description = "Passphrase der State-Verschlüsselung (TF_STATE_PASSPHRASE; kc.sh)."
  type        = string
  sensitive   = true
}

variable "keycloak_url" {
  description = "Adresse der Keycloak-Instanz ohne Basispfad (kc.sh, aus identity.app.json › keycloakUrl oder KEYCLOAK_TF_URL)."
  type        = string
}

variable "keycloak_base_path" {
  description = "Basispfad der Instanz (leer: kein relativer Pfad)."
  type        = string
  default     = ""
}

variable "smtp_password" {
  description = "Passwort des SMTP-Kontos, nur aus der Umgebung (TF_VAR_smtp_password; kc.sh liest SMTP_PASSWORD)."
  type        = string
  default     = ""
  sensitive   = true
}
