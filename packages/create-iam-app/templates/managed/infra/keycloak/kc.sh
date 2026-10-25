#!/usr/bin/env bash
# {{MARK}}
#
# OpenTofu für den Realm der App (Module product-realm und product-realm-bootstrap aus vollholz/identity-kit).
# Produkt, Keycloak-Instanz und State-Backend kommen aus identity.app.json.
#
#   ./kc.sh init | plan | apply | import | <beliebiger tofu-Befehl>   Realm-Inhalt (infra/keycloak) als <produkt>-iac
#   ./kc.sh apply-plan <datei>                                     gespeicherten Plan anwenden
#   ./kc.sh smtp-test <empfänger>                                  Testmail über die SMTP-Einstellungen des Realms
#   ./kc.sh bootstrap init | plan | apply                          Realm und <produkt>-iac anlegen (bootstrap/, nur lokal)
#
# Anmeldung des Providers nur über die Umgebung (steht nicht im gespeicherten Plan):
#   infra/keycloak:  <produkt>-iac, private_key_jwt – KEYCLOAK_IAC_PRIVATE_KEY (PEM) oder KEYCLOAK_IAC_PRIVATE_KEY_B64
#   bootstrap/:      <produkt>-tofu im Realm master – KEYCLOAK_TF_PRIVATE_KEY (PEM) oder KEYCLOAK_TF_PRIVATE_KEY_B64
# Ausserdem S3_ACCESS_KEY, S3_SECRET_KEY, TF_STATE_PASSPHRASE, mit SMTP SMTP_PASSWORD; KEYCLOAK_TF_URL nur, um
# keycloakUrl des Manifests zu übersteuern. Werte aus der Umgebung oder der .env im Hauptcheckout (nie ausgegeben).
set -euo pipefail
cd "$(dirname "$0")"

MANIFEST="$(cd ../.. && pwd)/identity.app.json"
[ -f "$MANIFEST" ] || { echo "kc.sh: $MANIFEST fehlt" >&2; exit 1; }
m() { node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), m); process.stdout.write(v == null ? "" : String(v));' "$MANIFEST" "$1"; }
PRODUCT="$(m product)"

ENV_FILE="${IDENTITY_ENV_FILE:-$(cd "$(git rev-parse --git-common-dir 2>/dev/null || echo ../../.git)/.." && pwd)/.env}"
load() {
  local name="$1" line
  [ -n "${!name:-}" ] && return 0
  [ -f "$ENV_FILE" ] || return 0
  line="$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  line="${line#*=}"; line="${line%$'\r'}"; line="${line#\"}"; line="${line%\"}"
  export "$name=$line"
}
for v in KEYCLOAK_TF_URL KEYCLOAK_TF_PRIVATE_KEY_B64 KEYCLOAK_IAC_PRIVATE_KEY_B64 S3_ACCESS_KEY S3_SECRET_KEY TF_STATE_PASSPHRASE SMTP_PASSWORD; do load "$v"; done
[ -z "${SMTP_PASSWORD:-}" ] || export TF_VAR_smtp_password="$SMTP_PASSWORD"
need() { [ -n "${!1:-}" ] || { echo "kc.sh: $1 fehlt (Umgebung oder $ENV_FILE)" >&2; exit 1; }; }

state_env() {
  for v in S3_ACCESS_KEY S3_SECRET_KEY TF_STATE_PASSPHRASE; do need "$v"; done
  export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" TF_VAR_state_passphrase="$TF_STATE_PASSPHRASE"
}

# Backend aus identity.app.json › state als Datei für -backend-config (keine Geheimnisse); Schlüssel je Teil:
# <produkt>/keycloak.tfstate bzw. <produkt>/keycloak-bootstrap.tfstate
backend_file() {
  local bucket region endpoint file
  bucket="$(m state.bucket)"; region="$(m state.region)"; endpoint="$(m state.endpoint)"
  [ -n "$bucket" ] || { echo "kc.sh: identity.app.json › state fehlt (bucket, region, endpoint)" >&2; exit 1; }
  file="$(mktemp)"
  cat > "$file" <<HCL
bucket                      = "$bucket"
key                         = "$PRODUCT/$1.tfstate"
region                      = "$region"
endpoints                   = { s3 = "$endpoint" }
use_path_style              = true
use_lockfile                = true
skip_credentials_validation = true
skip_region_validation      = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
skip_s3_checksum            = true
HCL
  printf '%s' "$file"
}

url_env() {
  # https://host/auth → url https://host, base_path /auth
  local u origin
  u="${KEYCLOAK_TF_URL:-$(m keycloakUrl)}"; u="${u%/}"
  origin="$(printf '%s' "$u" | sed -E 's#^(https?://[^/]+).*#\1#')"
  export KEYCLOAK_TF_URL="$u" TF_VAR_keycloak_url="$origin" TF_VAR_keycloak_base_path="${u#"$origin"}"
}

login_iac() {
  url_env
  if [ -z "${KEYCLOAK_IAC_PRIVATE_KEY:-}" ] && [ -n "${KEYCLOAK_IAC_PRIVATE_KEY_B64:-}" ]; then
    KEYCLOAK_IAC_PRIVATE_KEY="$(printf '%s' "$KEYCLOAK_IAC_PRIVATE_KEY_B64" | base64 -d)"
  fi
  need KEYCLOAK_IAC_PRIVATE_KEY
  export KEYCLOAK_IAC_PRIVATE_KEY KEYCLOAK_REALM="$PRODUCT" KEYCLOAK_CLIENT_ID="$PRODUCT-iac" KEYCLOAK_JWT_SIGNING_KEY="$KEYCLOAK_IAC_PRIVATE_KEY"
  unset KEYCLOAK_CLIENT_SECRET
}

login_tofu() {
  url_env
  if [ -z "${KEYCLOAK_TF_PRIVATE_KEY:-}" ] && [ -n "${KEYCLOAK_TF_PRIVATE_KEY_B64:-}" ]; then
    KEYCLOAK_TF_PRIVATE_KEY="$(printf '%s' "$KEYCLOAK_TF_PRIVATE_KEY_B64" | base64 -d)"
  fi
  need KEYCLOAK_TF_PRIVATE_KEY
  export KEYCLOAK_REALM=master KEYCLOAK_CLIENT_ID="$PRODUCT-tofu" KEYCLOAK_JWT_SIGNING_KEY="$KEYCLOAK_TF_PRIVATE_KEY"
  unset KEYCLOAK_CLIENT_SECRET
}

cmd="${1:-plan}"; shift || true
case "$cmd" in
  bootstrap)
    cd bootstrap
    sub="${1:-plan}"; shift || true
    state_env; login_tofu
    case "$sub" in
      init) cfg="$(backend_file keycloak-bootstrap)"; exec tofu init -input=false -backend-config="$cfg" "$@" ;;
      plan|apply) exec tofu "$sub" -input=false "$@" ;;
      *) exec tofu "$sub" "$@" ;;
    esac
    ;;
  init) state_env; cfg="$(backend_file keycloak)"; exec tofu init -input=false -backend-config="$cfg" "$@" ;;
  apply-plan) state_env; login_iac; exec tofu apply -input=false "$@" ;;
  smtp-test) login_iac
    KEYCLOAK_URL="$KEYCLOAK_TF_URL" KEYCLOAK_IAC_CLIENT_ID="$KEYCLOAK_CLIENT_ID" \
      exec node .terraform/modules/realm/modules/product-realm/scripts/smtp-test.ts "$@" ;;
  plan|apply|import) state_env; login_iac; exec tofu "$cmd" -input=false "$@" ;;
  *) state_env; login_iac; exec tofu "$cmd" "$@" ;;
esac
