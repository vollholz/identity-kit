# Modul product-realm-bootstrap

Legt den Realm einer App und ihren IaC-Client `<produkt>-iac` an (Spezifikation
[Kap. 2](../../docs/spezifikation.md#2-anbindung-an-die-identity-plattform), Schritt 4) – einmalig bzw. beim
Neuaufbau, als Service Account `<produkt>-tofu` im Realm `master` (nur `create-realm`, verwaltet von vollholz/identity).
Danach weist vollholz/identity `<produkt>-iac` `realm-management/realm-admin` zu (Schritt 5), und alles Weitere
verwaltet [product-realm](../product-realm/README.md). Herausgelöst aus vollholz/assets `infra/keycloak/bootstrap`
(`3a148ae`).

**Version 0.1.0** (Git-Quelle mit Tag `product-realm-bootstrap-v0.1.0`).

| Ressource | Inhalt |
|---|---|
| `keycloak_realm.this` | Realm `<produkt>` nur angelegt: `enabled`, `admin_permissions_enabled = true` (damit `admin-permissions` besteht, bevor product-realm ihn nachschlägt); `prevent_destroy`, `ignore_changes = all` – den Inhalt verwaltet product-realm |
| `keycloak_openid_client.iac` | `<produkt>-iac`: Service Account, `private_key_jwt` (ES256, JWKS aus `iac_jwks`), Token 300 s, keine Refresh-Tokens, `<produkt>.platform = true`; `prevent_destroy` |

## Eingaben und Ausgaben

| Eingabe | Typ | Vorgabe | Bedeutung |
|---|---|---|---|
| `product` | string | – | technischer Name `<produkt>` |
| `iac_jwks` | string | – | Inhalt von `infra/keycloak/keys/<produkt>-iac.json` (ein EC-P-256-Schlüssel mit `kid`, ohne privaten Teil) |
| `realm` | string | `product` | Realm, falls er anders heisst (nie `master`, `project-suite`) |
| `iac_client_id` | string | `<produkt>-iac` | Name des IaC-Clients |

| Ausgabe | Inhalt |
|---|---|
| `realm` | Name des Realms |
| `iac_client_id` | Client-ID des IaC-Clients |
| `iac_service_account_user_id` | Benutzer-ID des Service Accounts |

## Aufruf

`infra/keycloak/bootstrap/main.tf` der App, eigener State-Key (`…/keycloak-bootstrap.tfstate`), Backend und
Verschlüsselung wie in Assets:

```hcl
# Anmeldung nur aus der Umgebung (kc.sh bootstrap …): KEYCLOAK_REALM=master, KEYCLOAK_CLIENT_ID=<produkt>-tofu,
# KEYCLOAK_JWT_SIGNING_KEY (privater Schlüssel von <produkt>-tofu, nur lokal, nie in GitHub)
provider "keycloak" {
  url             = var.keycloak_url
  base_path       = var.keycloak_base_path
  jwt_signing_alg = "ES256"
}

module "bootstrap" {
  source = "git::https://github.com/vollholz/identity-kit.git//modules/product-realm-bootstrap?ref=product-realm-bootstrap-v0.1.0"

  product  = "notes"
  iac_jwks = file("${path.module}/../keys/notes-iac.json")
}
```

`kc.sh bootstrap init && kc.sh bootstrap apply`. Kein `import`-Block: auf einer neuen Instanz gibt es den Realm noch
nicht. Geht der State verloren: `kc.sh bootstrap import module.bootstrap.keycloak_realm.this <realm>` bzw.
`… module.bootstrap.keycloak_openid_client.iac <realm>/<id>`. Neuer Schlüssel für `<produkt>-iac`: Schlüsselpaar
erzeugen, `keys/<produkt>-iac.json` ersetzen, `kc.sh bootstrap apply`.

Umstellung von Assets (`moved`-Blöcke) und Nachweis: [product-realm › Umstellung](../product-realm/README.md#assets).
