module "bootstrap" {
  source = "../../../product-realm-bootstrap"

  product  = "assets"
  iac_jwks = file("${var.keys_dir}/assets-iac.json")
}

moved {
  from = keycloak_realm.assets
  to   = module.bootstrap.keycloak_realm.this
}
moved {
  from = keycloak_openid_client.iac
  to   = module.bootstrap.keycloak_openid_client.iac
}

output "iac_service_account_user_id" {
  value = module.bootstrap.iac_service_account_user_id
}
