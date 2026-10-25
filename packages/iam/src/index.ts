export { IAM_VARS, PRODUCT_PATTERN, checkProduct, productIdent, readVars, iamConfigErrors, iamConfig, loadIamConfig, iamWarnings, parseDuration, parseEncryptionKeys, ConfigError, type IamConfig, type VarSpec, type RawVars, type Service, type Mode } from './config.ts';
export { HttpError, notFound, forbidden, conflict, invalid, problemBody } from './errors.ts';
export { box, unbox, Sealer, primaryKey, keyById, validateKeyring, NoEncryptionKeyError, type MasterKey, type Keyring } from './crypto.ts';
export { createPool, withTx, withTenant, setContext, schemaName, type Db, type Tx, type DbContext } from './db.ts';
export { MemoryReplayStore, PgReplayStore, pgRateLimitStore, purgeSharedState, type ReplayStore } from './state.ts';
export { pgAudit, type AuditPort, type AuditEntry, type Actor, type Source } from './audit.ts';
export { LOCKS, lockKey } from './locks.ts';
export {
  migrate, iamMigrations, dirMigrations, migration, render, adoptionProblems, modelChecks, modelChecksInput, syncModelChecks, IAM_BASELINE, IAM_MIGRATIONS_DIR,
  type Migration, type MigrationSource, type MigrationResult, type IamMigrationOptions, type Adoption, type ModelChecksInput,
} from './migrations.ts';
export { schemaSnapshot, diffSnapshots, IAM_TABLES, IAM_FUNCTIONS, type SchemaSnapshot } from './schema.ts';
export {
  defineModel, ModelError, ADMIN_ROLE, ADMIN_LABEL, PLATFORM_ADMIN_ROLE, ORG, MEMBER, OWNER, RELATION_LABELS, CLASSIFICATIONS, RESERVED_PERMISSIONS, RESERVED_GROUPS,
  type Model, type ModelInput, type PermissionDef, type GroupDef, type RoleDef, type TypeDef, type TypeInfo, type McpToolDef, type PermissionInfo, type AuthzCatalogJson,
  type Level, type ReservedPermission, type Register, type RegisteredPermission,
} from './model.ts';
export { OidcProvider, TokenVerifier, parseClientCert, normalizeHtu, type VerifiedToken, type VerifyOptions } from './tokens.ts';
export {
  PrincipalResolver, orgsFromClaims, orgAlias, asciiLower, ALIAS_PATTERN, isServiceAccount, isClient, groupsFromClaims, clientNotGranted,
  type Principal,
} from './principal.ts';
export {
  AccessService, capabilities, capabilitiesFor, canSchema, subjectsOf, live, fullView, pgArray, noFacts, UNIT_DEPTH, TUPLE_COLS,
  type TenantAccess, type Tuple, type Who, type Facts, type Belong, type PersonEdge, type PersonGrants, type Reason, type ClearanceRow,
} from './access.ts';
export { TupleStore, SUBJECT_PATTERN, accessData, type TupleInput } from './tuples.ts';
export { AccessInfo, checkRef, MEMBERS_NAME, type AccessEntry, type AccessList, type ExplainOut, type GroupNames, type AccessSubjectOut } from './explain.ts';
export { checkRoles, checkRoleChange, activeAdmins, lastAdminGuard, setOrgRoles, setClearance, type Acting } from './rules.ts';
export { flatResources, flatChain, refKey, type ResourceModel, type ResourceRef } from './resources.ts';
export { createIam, readinessChecks, resourceProblems, type Iam, type IamOptions, type IamEvents } from './iam.ts';
export { iamPlugin, need, needsToken, requestPath, type IamPluginOptions, type IamModuleName, type SessionBridge } from './http/plugin.ts';
export { problem, problemResponses, registerProblemSchemas, registerErrorHandler, PROBLEM_SCHEMAS } from './http/problems.ts';
export { IAM_API_TAGS, routeSchema, personOf, optionalBodies, encodeCursor, decodeCursor, likePattern, etag, ifMatchVersion, HIDDEN, type OpenApiOverrides, type IamModule, type ModuleContext } from './http/routes.ts';
export { authzCatalogSchema } from './http/account.ts';
export { breakGlassAllowed } from './http/break-glass.ts';
export { listClients, type ClientOut } from './http/clients.ts';
export { Bff, LoginExpired, safeReturnTo, scopesFor, isOrgAlias, safeEqual, decodeClaims, type BffOptions, type Session, type SessionData } from './bff.ts';
export { loginErrorPage } from './http/bff.ts';
export { KeycloakAdmin, KeycloakError, keyInfo, seg as keycloakSegment, type KcOrg, type KcUser, type KcOrgDomain, type KcIdp, type KcIdpMapper, type KcFederatedIdentity, type KcCredential } from './keycloak.ts';
export { listTenants, findTenant, createTenant, setTenantStatus, relinkTenant, type TenantRow, type TenantActor, type TenantsContext } from './tenants.ts';
export { AdminService, entraAddress, type EntraLink, entraLoginPath, type AdminDeps, type Scope as AdminScope, type Member, type MemberStatus, type Organization, type Step as AdminStep, type Work as AdminWork, type Failure as AdminFailure } from './admin.ts';
export { MemberSync, syncAllMembers, syncTenantMembers, syncTenantName, expireAccess, expireAllAccess, orgMatches, pendingActions, displayName, type SyncContext, type SyncResult } from './sync.ts';
export { defaultPeoplePermissions } from './http/people.ts';
export { EntraService, brokerRedirectUri, brokerRedirectUris, ownAppAlias, encryptAppSecret, decryptAppSecret, rewrapEntraSecrets, type OwnAppGuide, type LinkKind, type ConsentLinkOut, consentPath, consentRedirectUri, testPath, entraFirstLoginFlow, idpRepresentation, entraGroupsMapper, ENTRA_GROUPS_MAPPER, slotAlias, type EntraConnection, type EntraConnectionOut, type EntraStatus, type EntraCandidate, type BindResult, type ConnectResult } from './entra.ts';
export { EntraGraph, EntraError, notLinkable, ENTRA_LOGIN, GRAPH, OWN_APP_PERMISSIONS, GROUPS_PERMISSION, GROUP_SEARCH_TOP, type EntraGroup, type AppPermission, type AppCheck, type EntraAppConfig, type EntraUser, type EntraOrganization } from './graph.ts';
export { DpopSigner, wantsNonce } from './mcp/dpop.ts';
export { TokenExchanger, type ExchangedToken } from './mcp/exchange.ts';
export { ApiClient, ApiError, type CallOptions } from './mcp/api.ts';
export { McpAuth, registerMcpAuth, exchangeScopes, type McpAuthOptions, type McpAuthorized, type McpOrg, type McpMe, type McpRequest } from './mcp/auth.ts';
export { InitFileSchema, initFileErrors, INVITE_LIFESPAN_SEC, inviteErrors, orgBootstrap, orgBootstrapErrors, orgBootstrapFile, type InitFile, type OrgBootstrapFileOptions, type OrgBootstrapOptions, type OrgBootstrapResult } from './bootstrap.ts';
export { isServiceAccountUser, MIGRATION_TABLES, resetDatabase, resetKeycloak, type DatabaseResetOptions, type DatabaseResetResult, type KeycloakResetResult, type ResetOptions } from './reset.ts';
