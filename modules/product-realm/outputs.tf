output "realm" {
  description = "Name des Realms."
  value       = keycloak_realm.this.realm
}

output "issuer" {
  description = "OIDC_ISSUER_URL der App."
  value       = "${local.lookup_query.url}/realms/${keycloak_realm.this.realm}"
}

output "clients" {
  description = "Client-IDs des Produkts (alle vertraulichen mit private_key_jwt); mcp und mcp_cli null ohne var.mcp."
  value = {
    bff     = keycloak_openid_client.platform.client_id
    api     = keycloak_openid_client.api.client_id
    admin   = keycloak_openid_client.service["admin"].client_id
    sync    = keycloak_openid_client.service["sync"].client_id
    mcp     = one(keycloak_openid_client.mcp[*].client_id)
    mcp_cli = one(keycloak_openid_client.mcp_cli[*].client_id)
  }
}

output "service_account_user_ids" {
  description = "Benutzer-IDs der Service Accounts <produkt>-admin und <produkt>-sync (z. B. für weitere Rollen beim Aufrufer)."
  value       = { for k, c in keycloak_openid_client.service : k => c.service_account_user_id }
}

output "machine_clients" {
  description = "Maschinen-Clients aus var.machine_clients: Organisationen, die sie in der App freigeben müssen (client_grant)."
  value       = { for c, m in var.machine_clients : c => { organizations = sort(m.organizations), roles = sort(m.roles), scopes = sort(m.scopes) } }
}
