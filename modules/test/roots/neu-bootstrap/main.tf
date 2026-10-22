variable "product" {
  type = string
}

module "bootstrap" {
  source = "../../../product-realm-bootstrap"

  product  = var.product
  iac_jwks = file("${var.keys_dir}/${var.product}-iac.json")
}

output "iac_service_account_user_id" {
  value = module.bootstrap.iac_service_account_user_id
}
