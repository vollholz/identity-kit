variable "product" {
  description = "Technischer Name des Produkts (<produkt>, wie im Modul product-realm)."
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
  description = "Realm des Produkts (nie master oder der Realm eines anderen Produkts). Leer: wie product."
  type        = string
  default     = null
  validation {
    condition     = var.realm == null || !contains(["master", "project-suite"], coalesce(var.realm, "-"))
    error_message = "Das Produkt braucht einen eigenen Realm (nicht master, nicht project-suite)."
  }
}

variable "iac_client_id" {
  description = "IaC-Client im Realm. Leer: <produkt>-iac."
  type        = string
  default     = null
}

variable "iac_jwks" {
  description = "Öffentlicher Schlüssel des IaC-Clients als JWKS (Inhalt von infra/keycloak/keys/<produkt>-iac.json)."
  type        = string
  validation {
    condition = try(
      length(jsondecode(var.iac_jwks).keys) == 1 &&
      jsondecode(var.iac_jwks).keys[0].kty == "EC" &&
      jsondecode(var.iac_jwks).keys[0].crv == "P-256" &&
      jsondecode(var.iac_jwks).keys[0].kid != "" &&
      !can(jsondecode(var.iac_jwks).keys[0].d),
      false,
    )
    error_message = "iac_jwks muss ein JWKS mit genau einem öffentlichen EC-P-256-Schlüssel (mit kid, ohne d) sein."
  }
}
