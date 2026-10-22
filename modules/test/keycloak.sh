#!/usr/bin/env bash
# Nachweis gegen eine lokale Wegwerf-Instanz von Keycloak 26.8.1 (Docker, start-dev), wiederholbar:
#
#   1. Assets: Stand von vollholz/assets infra/keycloak (fixtures/assets-3a148ae) anlegen wie in Produktion –
#      <produkt>-tofu (nur create-realm) → bootstrap/ → realm-admin für assets-iac → infra/keycloak als assets-iac.
#      Danach planen roots/assets-bootstrap und roots/assets (Modulaufruf mit moved-Blöcken) auf demselben State:
#      beide müssen «No changes» zeigen. Dann die Verschiebungen anwenden und erneut planen: wieder «No changes».
#   2. Neu: frische Anlage mit product-realm-bootstrap und product-realm (roots/neu*), einmal mit allen Schaltern
#      (m2m, mcp, entra, SMTP), einmal ohne; der zweite Plan nach dem Apply muss je «No changes» zeigen.
#
# Testschlüssel und State entstehen nur im Arbeitsverzeichnis (gelöscht am Ende, ausser KEEP=1). Admin-Passwort und
# State-Passphrase sind Wegwerf-Werte für diese Instanz.
#
#   modules/test/keycloak.sh
#
# Umgebung (optional): KEYCLOAK_IMAGE (Standard quay.io/keycloak/keycloak:26.8.1; Docker Hub keycloak/keycloak:26.8.1
# ist dasselbe Image), IDENTITY_THEME (Verzeichnis des Themes «identity»; Standard: Platzhalter theme/identity, der
# echte liegt in vollholz/identity deploy/stack/keycloak/themes/identity), KEYCLOAK_PORT (18080), KEEP=1 (Container und Arbeitsverzeichnis behalten), WORK_DIR.
# Braucht docker, tofu 1.13.1, node 24.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

image="${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.8.1}"
port="${KEYCLOAK_PORT:-18080}"
theme="$(cd "${IDENTITY_THEME:-$here/theme/identity}" && pwd)"
work="${WORK_DIR:-$(mktemp -d)}"
container="identity-kit-keycloak-$$"
mkdir -p "$work/state" "$work/data" "$work/logs"

export KC_URL="http://127.0.0.1:$port" KC_ADMIN_USER=admin KC_ADMIN_PASSWORD=nur-fuer-den-test
export TF_IN_AUTOMATION=1 TF_INPUT=0
export TF_VAR_keycloak_url="$KC_URL" TF_VAR_keycloak_base_path="" TF_VAR_keys_dir="$work/keys"
export TF_VAR_state_passphrase=nur-fuer-den-test-ohne-geheimnis TF_VAR_smtp_password=nur-fuer-den-test

cleanup() {
  local rc=$?
  if [ "${KEEP:-}" = 1 ]; then
    echo "KEEP=1: Container $container und $work bleiben"
  else
    docker rm -f "$container" >/dev/null 2>&1 || true
    rm -rf "$work"
  fi
  exit "$rc"
}
trap cleanup EXIT

step() { printf '\n=== %s\n' "$*"; }

# Anmeldung des Providers wie kc.sh: Bootstrap als <produkt>-tofu (Realm master), sonst als <produkt>-iac
as_tofu() {
  export KEYCLOAK_REALM=master KEYCLOAK_CLIENT_ID="$1-tofu" KEYCLOAK_JWT_SIGNING_KEY="$(cat "$work/keys/$1-tofu.pem")"
  unset KEYCLOAK_IAC_PRIVATE_KEY
}
as_iac() {
  export KEYCLOAK_REALM="$1" KEYCLOAK_CLIENT_ID="$1-iac" KEYCLOAK_IAC_PRIVATE_KEY="$(cat "$work/keys/$1-iac.pem")"
  export KEYCLOAK_JWT_SIGNING_KEY="$KEYCLOAK_IAC_PRIVATE_KEY"
}

# tf <name> <verzeichnis> <befehl> …: eigenes Datenverzeichnis je Lauf, Lockfile nur lesen
tf() {
  local name="$1" dir="$2"; shift 2
  TF_DATA_DIR="$work/data/$name" tofu -chdir="$dir" "$@"
}
tf_init() { # <name> <verzeichnis> <state-datei>
  tf "$1" "$2" init -no-color -lockfile=readonly -backend-config="path=$work/state/$3" >"$work/logs/$1-init.txt" 2>&1 ||
    { cat "$work/logs/$1-init.txt"; return 1; }
}
tf_apply() { # <name> <verzeichnis>
  tf "$1" "$2" apply -no-color -auto-approve >"$work/logs/$1-apply.txt" 2>&1 || { cat "$work/logs/$1-apply.txt"; return 1; }
  grep -E '^Apply complete' "$work/logs/$1-apply.txt"
}
# Plan muss «No changes» zeigen (Exit 0 mit -detailed-exitcode); sonst Plan ausgeben und abbrechen
expect_no_changes() { # <name> <verzeichnis> <log>
  local rc=0
  tf "$1" "$2" plan -no-color -detailed-exitcode >"$work/logs/$3.txt" 2>&1 || rc=$?
  if [ "$rc" != 0 ] || ! grep -q '^No changes\.' "$work/logs/$3.txt"; then
    cat "$work/logs/$3.txt"
    echo "FEHLER: $3 zeigt Änderungen (Exit $rc)" >&2
    return 1
  fi
  echo "  $3: $(grep -E '^No changes\.' "$work/logs/$3.txt")"
  printf '%s\t%s\n' "$3" "No changes" >>"$work/summary.tsv"
}
# Plan mit moved-Blöcken: OpenTofu meldet reine Verschiebungen als «Plan: 0 to add, 0 to change, 0 to destroy.» (Exit 2).
# Verlangt: genau <anzahl> Verschiebungen und sonst nichts (keine Ressource anlegen, ändern, ersetzen, löschen; keine
# Änderung an Outputs)
expect_only_moves() { # <name> <verzeichnis> <log> <anzahl>
  local rc=0 log="$work/logs/$3.txt" moved others
  tf "$1" "$2" plan -no-color -detailed-exitcode >"$log" 2>&1 || rc=$?
  moved="$(grep -c '^  # .* has moved to ' "$log" || true)"
  others="$(grep -E '^  # .* (will be|must be)|^Changes to Outputs' "$log" || true)"
  if [ "$rc" = 1 ] || [ "$moved" != "$4" ] || [ -n "$others" ] || ! grep -q '^Plan: 0 to add, 0 to change, 0 to destroy\.' "$log"; then
    cat "$log"
    echo "FEHLER: $3 zeigt mehr als die $4 Verschiebungen (Exit $rc, $moved verschoben)" >&2
    return 1
  fi
  grep -E '^  # .* has moved to ' "$log" | head -3
  echo "  … $moved Verschiebungen; $(grep -E '^Plan:' "$log")"
  printf '%s\t%s\n' "$3" "nur $moved Verschiebungen: $(grep -E '^Plan:' "$log")" >>"$work/summary.tsv"
}

step "Keycloak starten ($image)"
docker run -d --name "$container" -p "127.0.0.1:$port:8080" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME="$KC_ADMIN_USER" -e KC_BOOTSTRAP_ADMIN_PASSWORD="$KC_ADMIN_PASSWORD" \
  -v "$theme:/opt/keycloak/themes/identity:ro" \
  "$image" start-dev >/dev/null
node lib/kc.ts wait
docker logs "$container" 2>&1 | grep -o 'Keycloak [0-9.]* on JVM' | head -1

step "Testschlüssel"
clients=()
for p in assets neu mini; do
  for c in tofu iac platform admin sync mcp; do clients+=("$p-$c"); done
done
node lib/kc.ts keys "$work/keys" "${clients[@]}"
echo "${#clients[@]} Schlüsselpaare in $work/keys"

# ---------- 1. Assets: heutiger Stand, dann Modul mit moved-Blöcken

step "Assets (3a148ae): Bootstrap als assets-tofu"
cp -r fixtures/assets-3a148ae "$work/assets"
mkdir -p "$work/assets/keys"
cp "$work"/keys/assets-*.json "$work/assets/keys/"
# Backend lokal statt S3 (Override-Dateien ersetzen den Block backend "s3")
for d in "$work/assets" "$work/assets/bootstrap"; do printf 'terraform {\n  backend "local" {}\n}\n' >"$d/backend_override.tf"; done
node lib/kc.ts product-tofu assets "$work/keys/assets-tofu.json"
as_tofu assets
tf_init assets-fixture-bootstrap "$work/assets/bootstrap" assets-bootstrap.tfstate
tf_apply assets-fixture-bootstrap "$work/assets/bootstrap"
node lib/kc.ts grant-realm-admin assets assets-iac

step "Assets (3a148ae): infra/keycloak als assets-iac"
as_iac assets
tf_init assets-fixture "$work/assets" assets.tfstate
tf_apply assets-fixture "$work/assets"
expect_no_changes assets-fixture "$work/assets" "assets-heute-zweiter-plan"

step "Assets mit Modul: Bootstrap (roots/assets-bootstrap, gleicher State)"
as_tofu assets
tf_init assets-module-bootstrap roots/assets-bootstrap assets-bootstrap.tfstate
expect_only_moves assets-module-bootstrap roots/assets-bootstrap "assets-modul-bootstrap-plan" 2

step "Assets mit Modul: Realm (roots/assets, gleicher State)"
as_iac assets
tf_init assets-module roots/assets assets.tfstate
# Jede Ressource im State (ohne Datenquellen) muss genau einmal verschoben werden
expect_only_moves assets-module roots/assets "assets-modul-plan" "$(tf assets-fixture "$work/assets" state list | grep -vc '^data\.')"

step "Assets mit Modul: Verschiebungen anwenden, erneut planen"
tf_apply assets-module roots/assets
expect_no_changes assets-module roots/assets "assets-modul-plan-nach-apply"
as_tofu assets
tf_apply assets-module-bootstrap roots/assets-bootstrap
expect_no_changes assets-module-bootstrap roots/assets-bootstrap "assets-modul-bootstrap-plan-nach-apply"

# ---------- 2. Frische Anlage mit dem Modul

for variant in "neu true" "mini false"; do
  read -r p switches <<<"$variant"
  export TF_VAR_product="$p" TF_VAR_switches="$switches"

  step "Neu: $p (alle Schalter: $switches) – Bootstrap als $p-tofu"
  node lib/kc.ts product-tofu "$p" "$work/keys/$p-tofu.json"
  as_tofu "$p"
  tf_init "$p-bootstrap" roots/neu-bootstrap "$p-bootstrap.tfstate"
  tf_apply "$p-bootstrap" roots/neu-bootstrap
  expect_no_changes "$p-bootstrap" roots/neu-bootstrap "$p-bootstrap-zweiter-plan"
  node lib/kc.ts grant-realm-admin "$p" "$p-iac"

  step "Neu: $p – Realm als $p-iac"
  as_iac "$p"
  tf_init "$p" roots/neu "$p.tfstate"
  tf_apply "$p" roots/neu
  expect_no_changes "$p" roots/neu "$p-zweiter-plan"
  tf "$p" roots/neu output -no-color clients | sed 's/^/  /'
done

step "Ergebnis"
awk -F'\t' '{ printf "  %-42s %s\n", $1, $2 }' "$work/summary.tsv"
