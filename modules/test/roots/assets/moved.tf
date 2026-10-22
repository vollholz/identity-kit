# Umstellung von Assets infra/keycloak (3a148ae) auf das Modul product-realm: jede Ressource an ihre neue Adresse.
# Nach dem ersten Apply mit dem Modul können die Blöcke bleiben (kosten nichts) oder in einer späteren Version weg.

moved {
  from = keycloak_realm.assets
  to   = module.realm.keycloak_realm.this
}
moved {
  from = keycloak_realm_events.assets
  to   = module.realm.keycloak_realm_events.this
}

# policies.tf
moved {
  from = keycloak_realm_client_policy_profile.code_flow
  to   = module.realm.keycloak_realm_client_policy_profile.code_flow
}
moved {
  from = keycloak_realm_client_policy_profile.confidential
  to   = module.realm.keycloak_realm_client_policy_profile.confidential
}
moved {
  from = keycloak_realm_client_policy_profile.m2m_dpop
  to   = module.realm.keycloak_realm_client_policy_profile.m2m_dpop[0]
}
moved {
  from = keycloak_realm_client_policy_profile_policy.code_flow
  to   = module.realm.keycloak_realm_client_policy_profile_policy.code_flow
}
moved {
  from = keycloak_realm_client_policy_profile_policy.confidential
  to   = module.realm.keycloak_realm_client_policy_profile_policy.confidential
}
moved {
  from = keycloak_realm_client_policy_profile_policy.m2m_dpop
  to   = module.realm.keycloak_realm_client_policy_profile_policy.m2m_dpop[0]
}

# clients.tf
moved {
  from = keycloak_openid_client.api
  to   = module.realm.keycloak_openid_client.api
}
moved {
  from = keycloak_openid_client.platform
  to   = module.realm.keycloak_openid_client.platform
}
moved {
  from = keycloak_openid_client.mcp
  to   = module.realm.keycloak_openid_client.mcp[0]
}
moved {
  from = keycloak_openid_client.mcp_cli
  to   = module.realm.keycloak_openid_client.mcp_cli[0]
}
moved {
  from = keycloak_openid_audience_protocol_mapper.aud_api
  to   = module.realm.keycloak_openid_audience_protocol_mapper.aud_api
}
moved {
  from = keycloak_openid_group_membership_protocol_mapper.groups
  to   = module.realm.keycloak_openid_group_membership_protocol_mapper.groups
}
moved {
  from = keycloak_openid_client_default_scopes.platform
  to   = module.realm.keycloak_openid_client_default_scopes.platform
}
moved {
  from = keycloak_openid_client_optional_scopes.platform
  to   = module.realm.keycloak_openid_client_optional_scopes.platform
}
moved {
  from = keycloak_openid_client_default_scopes.mcp
  to   = module.realm.keycloak_openid_client_default_scopes.mcp[0]
}
moved {
  from = keycloak_openid_client_optional_scopes.mcp
  to   = module.realm.keycloak_openid_client_optional_scopes.mcp[0]
}
moved {
  from = keycloak_openid_client_default_scopes.mcp_cli
  to   = module.realm.keycloak_openid_client_default_scopes.mcp_cli[0]
}
moved {
  from = keycloak_openid_client_optional_scopes.mcp_cli
  to   = module.realm.keycloak_openid_client_optional_scopes.mcp_cli[0]
}
moved {
  from = keycloak_role.platform_admin
  to   = module.realm.keycloak_role.platform_admin
}
moved {
  from = keycloak_role.platform
  to   = module.realm.keycloak_role.platform
}
moved {
  from = keycloak_group.orgs
  to   = module.realm.keycloak_group.orgs
}

# admin.tf (Schlüssel der Service Accounts: admin, sync statt der Client-ID)
moved {
  from = keycloak_openid_client.service["assets-admin"]
  to   = module.realm.keycloak_openid_client.service["admin"]
}
moved {
  from = keycloak_openid_client.service["assets-sync"]
  to   = module.realm.keycloak_openid_client.service["sync"]
}
moved {
  from = keycloak_openid_client_service_account_role.manage_realm["assets-admin"]
  to   = module.realm.keycloak_openid_client_service_account_role.manage_realm["admin"]
}
moved {
  from = keycloak_openid_client_service_account_role.manage_realm["assets-sync"]
  to   = module.realm.keycloak_openid_client_service_account_role.manage_realm["sync"]
}
moved {
  from = keycloak_openid_client_client_policy.admin_service_account
  to   = module.realm.keycloak_openid_client_client_policy.admin_service_account
}
moved {
  from = keycloak_openid_client_authorization_permission.admin
  to   = module.realm.keycloak_openid_client_authorization_permission.admin
}

# scopes.tf
moved {
  from = keycloak_openid_client_scope.permission
  to   = module.realm.keycloak_openid_client_scope.permission
}
moved {
  from = keycloak_openid_client_scope.mcp
  to   = module.realm.keycloak_openid_client_scope.mcp[0]
}
moved {
  from = keycloak_openid_audience_protocol_mapper.mcp_scope_audience
  to   = module.realm.keycloak_openid_audience_protocol_mapper.mcp_scope_audience[0]
}
moved {
  from = terraform_data.organization_mapper
  to   = module.realm.terraform_data.organization_mapper
}

# entra.tf
moved {
  from = keycloak_openid_client_service_account_role.manage_identity_providers
  to   = module.realm.keycloak_openid_client_service_account_role.manage_identity_providers[0]
}
moved {
  from = keycloak_authentication_flow.entra_first_login
  to   = module.realm.keycloak_authentication_flow.entra_first_login[0]
}
moved {
  from = keycloak_authentication_execution.entra_first_login_deny
  to   = module.realm.keycloak_authentication_execution.entra_first_login_deny[0]
}
moved {
  from = keycloak_authentication_execution_config.entra_first_login_deny
  to   = module.realm.keycloak_authentication_execution_config.entra_first_login_deny[0]
}
moved {
  from = keycloak_openid_user_session_note_protocol_mapper.identity_provider
  to   = module.realm.keycloak_openid_user_session_note_protocol_mapper.identity_provider
}

# localization.tf
moved {
  from = keycloak_realm_localization.de
  to   = module.realm.keycloak_realm_localization.this["de"]
}
moved {
  from = keycloak_realm_localization.en
  to   = module.realm.keycloak_realm_localization.this["en"]
}
