output "issuer" {
  description = "OIDC_ISSUER_URL der Plattform (deploy/hetzner/app/app.env)."
  value       = "${var.keycloak_url}${var.keycloak_base_path}/realms/${keycloak_realm.assets.realm}"
}

output "clients" {
  description = "Client-IDs der Plattform (alle vertraulichen mit private_key_jwt)."
  value = {
    bff     = keycloak_openid_client.platform.client_id
    mcp     = keycloak_openid_client.mcp.client_id
    mcp_cli = keycloak_openid_client.mcp_cli.client_id
    api     = keycloak_openid_client.api.client_id
    admin   = keycloak_openid_client.service["assets-admin"].client_id
    sync    = keycloak_openid_client.service["assets-sync"].client_id
  }
}
