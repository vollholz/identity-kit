export { IAM_VARS, PRODUCT_PATTERN, checkProduct, productIdent, readVars, iamConfigErrors, iamConfig, loadIamConfig, iamWarnings, parseDuration, parseEncryptionKeys, ConfigError, type IamConfig, type VarSpec, type RawVars, type Service, type Mode } from './config.ts';
export { HttpError, notFound, forbidden, conflict, invalid, problemBody } from './errors.ts';
export { box, unbox, Sealer, primaryKey, keyById, validateKeyring, NoEncryptionKeyError, type MasterKey, type Keyring } from './crypto.ts';
export { createPool, withTx, withTenant, setContext, schemaName, type Db, type Tx, type DbContext } from './db.ts';
export { MemoryReplayStore, PgReplayStore, pgRateLimitStore, purgeSharedState, type ReplayStore } from './state.ts';
export { pgAudit, type AuditPort, type AuditEntry, type Actor, type Source } from './audit.ts';
export { LOCKS, lockKey } from './locks.ts';
export {
  migrate, iamMigrations, dirMigrations, migration, render, adoptionProblems, aclChecks, syncAclChecks, IAM_BASELINE, IAM_MIGRATIONS_DIR,
  type Migration, type MigrationSource, type MigrationResult, type IamMigrationOptions, type Adoption,
} from './migrations.ts';
export { schemaSnapshot, diffSnapshots, IAM_TABLES, IAM_FUNCTIONS, type SchemaSnapshot } from './schema.ts';
export {
  defineCatalog, CatalogError, ADMIN_ROLE, ADMIN_LABEL, CUSTOM_ROLE_PREFIX, PLATFORM_ADMIN_ROLE, RESERVED_PERMISSIONS, RESERVED_GROUPS, isCustomRole,
  type Catalog, type CatalogInput, type PermissionDef, type GroupDef, type RoleDef, type ResourceDef, type McpToolDef, type PermissionInfo, type AuthzCatalogJson,
  type Register, type RegisteredPermission,
} from './catalog.ts';
export { OidcProvider, TokenVerifier, parseClientCert, normalizeHtu, type VerifiedToken, type VerifyOptions } from './tokens.ts';
export {
  PrincipalResolver, orgsFromClaims, orgAlias, asciiLower, ALIAS_PATTERN, isServiceAccount, isClient, rolesFromClaims, groupsFromClaims, tenantGroups, roleSourceWarning,
  type Principal,
} from './principal.ts';
export { AccessService, capabilities, capabilitiesFor, canSchema, indexAcl, ACL_EFFECTS, type AclEffect, type AclRow, type TenantAccess } from './access.ts';
export { flatResources, flatChain, type ResourceModel, type ResourceRef } from './resources.ts';
export { createIam, readinessChecks, type Iam, type IamOptions, type IamEvents, type MemberAccess } from './iam.ts';
export { iamPlugin, need, needsToken, requestPath, type IamPluginOptions, type IamModuleName, type SessionBridge } from './http/plugin.ts';
export { problem, problemResponses, registerProblemSchemas, registerErrorHandler, PROBLEM_SCHEMAS } from './http/problems.ts';
export { IAM_API_TAGS, routeSchema, personOf, optionalBodies, HIDDEN, type OpenApiOverrides, type IamModule, type ModuleContext } from './http/routes.ts';
export { authzCatalogSchema } from './http/account.ts';
export { pointlessAcl } from './http/acl.ts';
export { Bff, safeReturnTo, scopesFor, isOrgAlias, safeEqual, decodeClaims, type BffOptions, type Session, type SessionData } from './bff.ts';
export { KeycloakAdmin, KeycloakError, keyInfo, seg as keycloakSegment, type KcOrg, type KcUser, type KcGroup, type KcOrgDomain, type KcIdp, type KcFederatedIdentity, type KcCredential } from './keycloak.ts';
export { listTenants, findTenant, createTenant, setTenantStatus, relinkTenant, type TenantRow, type TenantActor, type TenantsContext } from './tenants.ts';
export { AdminService, roleCatalog, entraLoginPath, type AdminDeps, type Scope as AdminScope, type Member, type MemberStatus, type Organization, type CustomRole, type RoleInfo, type Step as AdminStep, type Work as AdminWork, type Failure as AdminFailure } from './admin.ts';
export { MemberSync, syncAllMembers, syncTenantMembers, syncTenantName, orgMatches, pendingActions, displayName, type SyncContext, type SyncResult, type RoleCleanup } from './sync.ts';
