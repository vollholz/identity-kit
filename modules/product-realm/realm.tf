# Realm des Produkts: Organisationen, sichere Voreinstellungen, Brute-Force-Schutz, feingranulare Admin-Rechte v2
# (für den Verwaltungs-Client), Admin- und Anmeldeereignisse, SMTP für Einladungen und Passwort-Mails (var.smtp).
# Angelegt hat ihn product-realm-bootstrap; der Aufrufer übernimmt ihn mit einem import-Block (README.md › Aufruf).

locals {
  realm_name    = coalesce(var.realm, var.product)
  iac_client_id = coalesce(var.iac_client_id, "${var.product}-iac")
  smtp          = var.smtp == null ? null : (var.smtp.host == "" ? null : var.smtp)
}

resource "keycloak_realm" "this" {
  realm                 = local.realm_name
  enabled               = true
  display_name          = var.display_name
  organizations_enabled = true

  ssl_required             = "external"
  registration_allowed     = false
  login_with_email_allowed = true
  duplicate_emails_allowed = false
  reset_password_allowed   = true
  password_policy          = "length(12) and notUsername and notEmail"

  access_token_lifespan    = "5m"
  sso_session_idle_timeout = "1h"
  sso_session_max_lifespan = "10h"

  # «Angemeldet bleiben»: mit Häkchen bleibt die Keycloak-Sitzung 14 Tage ohne Aktivität bzw. höchstens 30 Tage bestehen.
  # Läuft die Sitzung der Oberfläche ab (SESSION_TTL/SESSION_IDLE_TIMEOUT), meldet Keycloak ohne Passwort wieder an.
  # Client-Sitzungen folgen den Realm-Werten (0 = wie SSO).
  remember_me                          = true
  sso_session_idle_timeout_remember_me = "336h"
  sso_session_max_lifespan_remember_me = "720h"

  # Offline-Tokens (offline_access, nur <produkt>-mcp-cli, z. B. Claude): 30 Tage ohne Nutzung, höchstens 90 Tage,
  # danach meldet sich die Person im MCP-Client neu an. Ohne MCP bleiben die Werte von Keycloak unverwaltet.
  offline_session_idle_timeout         = var.mcp ? "720h" : null
  offline_session_max_lifespan_enabled = var.mcp ? true : null
  offline_session_max_lifespan         = var.mcp ? "2160h" : null
  revoke_refresh_token                 = true
  refresh_token_max_reuse              = 0

  admin_permissions_enabled = true

  # Theme «identity» der Identity-Plattform (vollholz/identity) für Login, Konto und E-Mails; Name = display_name,
  # Akzent und Claim aus var.theme_texts. Fehlt das Theme auf dem Server, nimmt Keycloak das Standard-Theme.
  login_theme   = "identity"
  account_theme = "identity"
  email_theme   = "identity"

  internationalization {
    supported_locales = var.supported_locales
    default_locale    = var.supported_locales[0]
  }

  # Ausgehende Mails (Einladungen, «Passwort festlegen», Passwort vergessen). Passwort nur aus der Umgebung
  # (TF_VAR_smtp_password: .env SMTP_PASSWORD bzw. GitHub-Secret).
  dynamic "smtp_server" {
    for_each = local.smtp == null ? [] : [local.smtp]
    content {
      host              = smtp_server.value.host
      port              = smtp_server.value.port
      from              = smtp_server.value.from
      from_display_name = coalesce(smtp_server.value.from_display_name, var.display_name)
      reply_to          = smtp_server.value.reply_to
      starttls          = smtp_server.value.starttls
      ssl               = smtp_server.value.ssl
      auth {
        username = smtp_server.value.user
        password = var.smtp_password
      }
    }
  }

  security_defenses {
    brute_force_detection {
      permanent_lockout                = false
      max_login_failures               = 10
      wait_increment_seconds           = 60
      max_failure_wait_seconds         = 900
      failure_reset_time_seconds       = 43200
      quick_login_check_milli_seconds  = 1000
      minimum_quick_login_wait_seconds = 60
    }
  }

  lifecycle {
    # Der Realm trägt Konten und Organisationen: nie über diesen State löschen oder ersetzen (der Schutz im
    # Bootstrap-State gilt hier nicht, der Aufrufer importiert den Realm)
    prevent_destroy = true

    # Ohne Passwort würde ein Apply die Anmeldung am Mailserver leeren: dann lieber gar nicht planen
    precondition {
      condition     = local.smtp == null || var.smtp_password != ""
      error_message = "SMTP ist eingerichtet, aber das Passwort fehlt: .env SMTP_PASSWORD (kc.sh) bzw. GitHub-Secret SMTP_PASSWORD."
    }
  }
}

# Ereignisse: Admin-Änderungen (Verwaltungs-Client) und Anmeldungen, 30 Tage
resource "keycloak_realm_events" "this" {
  realm_id                     = keycloak_realm.this.id
  admin_events_enabled         = true
  admin_events_details_enabled = false
  events_enabled               = true
  events_expiration            = 2592000
  events_listeners             = ["jboss-logging"]
}
