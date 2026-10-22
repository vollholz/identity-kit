# Tests ohne Keycloak (tofu test, Provider nachgebildet). Gegen Keycloak 26.8.1: modules/test/keycloak.sh.

mock_provider "keycloak" {}

variables {
  product  = "beispiel"
  iac_jwks = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\",\"kid\":\"iac\",\"alg\":\"ES256\",\"use\":\"sig\"}]}"
}

run "anlage" {
  command = plan

  assert {
    condition     = keycloak_realm.this.realm == "beispiel" && keycloak_realm.this.admin_permissions_enabled
    error_message = "Realm <produkt> mit admin_permissions_enabled"
  }
  assert {
    condition     = keycloak_openid_client.iac.client_id == "beispiel-iac" && keycloak_openid_client.iac.service_accounts_enabled && keycloak_openid_client.iac.client_authenticator_type == "client-jwt"
    error_message = "IaC-Client <produkt>-iac mit Service Account und private_key_jwt"
  }
  assert {
    condition     = keycloak_openid_client.iac.extra_config["beispiel.platform"] == "true" && keycloak_openid_client.iac.extra_config["jwks.string"] == jsonencode(jsondecode(var.iac_jwks))
    error_message = "Markierung <produkt>.platform und JWKS"
  }
}

run "eigener_realm_und_client" {
  command = plan

  variables {
    realm         = "beispiel-test"
    iac_client_id = "beispiel-test-iac"
  }

  assert {
    condition     = keycloak_realm.this.realm == "beispiel-test" && keycloak_openid_client.iac.client_id == "beispiel-test-iac"
    error_message = "realm und iac_client_id überschreiben die Vorgaben"
  }
}

run "realm_master" {
  command = plan

  variables {
    realm = "master"
  }

  expect_failures = [var.realm]
}

run "jwks_ohne_kid" {
  command = plan

  variables {
    iac_jwks = "{\"keys\":[{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"eA\",\"y\":\"eQ\"}]}"
  }

  expect_failures = [var.iac_jwks]
}
