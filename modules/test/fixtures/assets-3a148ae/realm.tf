# Realm der Plattform: Organisationen, sichere Voreinstellungen, Brute-Force-Schutz, feingranulare Admin-Rechte v2
# (für den Verwaltungs-Client), Admin- und Anmeldeereignisse, SMTP für Einladungen und Passwort-Mails (variables.tf › smtp).
# Beim Neuaufbau legt bootstrap/ den Realm an; hier wird er übernommen (ohne Wirkung, wenn er schon im State ist)
import {
  to = keycloak_realm.assets
  id = var.realm
}

resource "keycloak_realm" "assets" {
  realm                 = var.realm
  enabled               = true
  display_name          = "Assets"
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

  # Offline-Tokens (offline_access, nur assets-mcp-cli, z. B. Claude): 30 Tage ohne Nutzung, höchstens 90 Tage,
  # danach meldet sich die Person im MCP-Client neu an (Entscheid 2026-10-20).
  offline_session_idle_timeout         = "720h"
  offline_session_max_lifespan_enabled = true
  offline_session_max_lifespan         = "2160h"
  revoke_refresh_token                 = true
  refresh_token_max_reuse              = 0

  admin_permissions_enabled = true

  # Theme «identity» der Identity-Plattform (vollholz/identity) für Login, Konto und E-Mails; Name = display_name,
  # Akzent und Claim aus localization-theme.json. Fehlt das Theme auf dem Server, nimmt Keycloak das Standard-Theme.
  login_theme   = "identity"
  account_theme = "identity"
  email_theme   = "identity"

  internationalization {
    supported_locales = ["de", "en"]
    default_locale    = "de"
  }

  # Ausgehende Mails (Einladungen, «Passwort festlegen», Passwort vergessen). Gleiche Zugangsdaten wie im Realm
  # project-suite; Passwort nur aus der Umgebung (TF_VAR_smtp_password: .env SMTP_PASSWORD bzw. GitHub-Secret).
  dynamic "smtp_server" {
    for_each = var.smtp.host != "" ? [var.smtp] : []
    content {
      host              = smtp_server.value.host
      port              = smtp_server.value.port
      from              = smtp_server.value.from
      from_display_name = smtp_server.value.from_display_name
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

  # Ohne Passwort würde ein Apply die Anmeldung am Mailserver leeren: dann lieber gar nicht planen
  lifecycle {
    precondition {
      condition     = var.smtp.host == "" || var.smtp_password != ""
      error_message = "SMTP ist eingerichtet, aber das Passwort fehlt: .env SMTP_PASSWORD (kc.sh) bzw. GitHub-Secret SMTP_PASSWORD."
    }
  }
}

# Ereignisse: Admin-Änderungen (Verwaltungs-Client der Plattform) und Anmeldungen, 30 Tage
resource "keycloak_realm_events" "assets" {
  realm_id                     = keycloak_realm.assets.id
  admin_events_enabled         = true
  admin_events_details_enabled = false
  events_enabled               = true
  events_expiration            = 2592000
  events_listeners             = ["jboss-logging"]
}
