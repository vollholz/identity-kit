output "realm" {
  description = "Name des angelegten Realms."
  value       = keycloak_realm.this.realm
}

output "iac_client_id" {
  description = "Client-ID des IaC-Clients."
  value       = keycloak_openid_client.iac.client_id
}

output "iac_service_account_user_id" {
  description = "Benutzer-ID des Service Accounts (für die Zuweisung von realm-admin)."
  value       = keycloak_openid_client.iac.service_account_user_id
}
