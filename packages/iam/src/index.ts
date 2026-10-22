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
