/**
 * Typen des HTTP-Vertrags (Spezifikation Kap. 5, 7, 8.3, 9, 11; docs/entwurf.md › Teststrategie), von Hand gepflegt:
 * Das Paket hängt nicht von den erzeugten Typen einer App ab. `test/contract.check.ts` prüft sie gegen einen Auszug der
 * OpenAPI von vollholz/assets. Schlüssel von Rechten, Rollen, Scopes und Ressourcentypen sind hier `string`; die App
 * schränkt `Permission` über `Register` ein (siehe `permissions.ts`).
 */

/** Fehler nach RFC 9457 mit den Erweiterungen des Vertrags; alles optional, weil auch Antworten ohne problem+json ankommen. */
export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  /** 422: Feldfehler (`path` als JSON-Pointer). */
  errors?: { path: string; message: string }[];
  /** 412: aktuelle Version der Ressource. */
  currentVersion?: number;
  /** 400 bei mehreren Organisationen ohne Wahl: die eigenen Organisationen. */
  organizations?: string[];
}

// ------------------------------------------------------------------------------------------------ /auth (BFF, 5.1)

/** `GET /auth/me` (Spezifikation 5.1, 7.1). */
export interface Me {
  person: { subject: string; name: string | null; email: string | null };
  /** Organisation dieses Tabs; `null` bei mehreren Organisationen ohne Wahl oder wenn sie nicht verfügbar ist. */
  tenant: { id: string; alias: string; name?: string } | null;
  /** Aliasse der Organisationen der Person (aus dem Token). */
  organizations: string[];
  /** Name je Alias. */
  organizationNames?: Record<string, string>;
  selectedOrganization: string | null;
  /** Grund, warum `tenant` fehlt (Text für die Person). */
  tenantError: string | null;
  roles: string[];
  /** Rechte auf Ebene der Organisation (effektiv). */
  permissions: string[];
  /** Rechte nur über Freigaben auf einzelnen Ressourcen. */
  grantedPermissions?: string[];
  csrfToken: string;
  session: { expiresAt: string; idleTimeoutSeconds: number };
}

/** `POST /auth/switch`. */
export interface SwitchInput { org: string; returnTo?: string }
export interface SwitchResult { redirect: string }

// ------------------------------------------------------------------------------------------- Katalog (7.2, GET /v1/authz/catalog)

export interface PermissionInfo {
  key: string;
  label: string;
  description: string;
  group: string;
  /** Ressourcentypen, auf denen eine Zugriffsregel für dieses Recht wirkt. */
  resources: string[];
  /** Nur die Rolle org-admin hat dieses Recht. */
  adminOnly: boolean;
}
export interface PermissionGroupInfo { key: string; label: string }
export interface CatalogRole { key: string; label: string; description: string; permissions: string[]; adminOnly: boolean }
export interface ScopeInfo { key: string; text: string; permissions: string[] }
export interface ResourceTypeInfo { key: string; label: string }

export interface AuthzCatalog {
  permissions: PermissionInfo[];
  groups: PermissionGroupInfo[];
  roles: CatalogRole[];
  scopes: ScopeInfo[];
  resourceTypes: ResourceTypeInfo[];
}

// --------------------------------------------------------------------------------------------- Rollen (8.3, /v1/roles)

export interface Role {
  key: string;
  label: string;
  description: string;
  permissions: string[];
  adminOnly: boolean;
  /** Eigene Rolle der Organisation (`c-…`). */
  custom: boolean;
  id: string | null;
  /** Nur mit `members:admin`. */
  memberCount: number | null;
  version: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface RoleList {
  items: Role[];
  /** Rechte, die eine eigene Rolle enthalten darf. */
  customPermissions: string[];
  maxCustom: number;
}
export interface RoleInput { label: string; description?: string; permissions: string[] }
export interface RolePatch { label?: string; description?: string; permissions?: string[] }

// --------------------------------------------------------------------------------------------- Verwaltung (9.2)

export interface AdminStatus {
  enabled: boolean;
  reason: string | null;
  organization: string;
  platformAdmin: boolean;
  canManageMembers: boolean;
  rolesManageable: boolean;
  roles: { key: string; label: string; permissions: string[]; adminOnly: boolean; custom?: boolean }[];
}

export interface Member {
  id: string;
  principalId: string | null;
  username: string;
  name: string;
  email: string | null;
  status: 'active' | 'invited' | 'disabled';
  roles: string[];
  lastSeenAt: string | null;
  createdAt: string | null;
  /** Anmeldelink für Personen aus Entra ID, die sich noch nie angemeldet haben. */
  loginPath: string | null;
}
export interface MemberList { items: Member[] }
export interface InviteInput { email: string; firstName?: string; lastName?: string; roles?: string[] }
export interface InviteResult { result: 'invitation-sent'; emailSent: boolean; member: Member }
export interface RemoveResult { accountDeleted: boolean }
export interface ResendResult { emailSent: boolean }
export interface RolesInput { roles: string[] }

/** Personen aus Microsoft Entra ID (9.4). */
export interface EntraCandidate {
  id: string;
  name: string;
  email: string;
  userPrincipalName: string;
  department: string | null;
  jobTitle: string | null;
  selectable: boolean;
  reason: string | null;
}
export interface EntraCandidateList { items: EntraCandidate[]; more: boolean }
export interface EntraAddInput { id: string; roles?: string[]; sendEmail?: boolean }
export interface EntraAddResult { result: 'added'; emailSent: boolean; member: Member }

export interface ClientGrant {
  clientId: string;
  description: string;
  createdAt: string;
  createdBy: string | null;
  lastRoles: string[] | null;
  lastScopes: string[] | null;
  lastUsedAt: string | null;
}
export interface ClientGrantList { items: ClientGrant[] }
export interface ClientGrantInput { description?: string }

export interface EntraConnection {
  entraTenantId: string;
  entraName: string;
  stage: 'pending' | 'enforced';
  status: 'active' | 'error';
  domains: string[];
  availableDomains: string[];
  testLoginPath: string;
  connectedAt: string;
  connectedBy: string;
  testedAt: string | null;
  testedBy: string | null;
  enforcedAt: string | null;
  enforcedBy: string | null;
  refreshedAt: string;
  lastError: string | null;
}
export interface EntraStatus { enabled: boolean; reason: string | null; connection: EntraConnection | null }
export interface EntraMember { name: string; email: string; linked: boolean; reason: string | null }
export interface EntraResult { connection: EntraConnection; members: EntraMember[]; rejectedDomains: string[] }
export interface EntraPreview { members: EntraMember[] }
export interface EntraConsentInput { tenant: string }
export interface EntraConsentStart { entraTenantId: string; url: string }
export interface EntraConsentReturn { state: string; tenant?: string; adminConsent?: string; error?: string; errorDescription?: string }
export interface EntraDomainsInput { domains: string[]; notLinked?: string[] }
export interface EntraEnforceInput { notLinked?: string[] }

export interface Organization {
  id: string;
  alias: string;
  name: string;
  description: string | null;
  enabled: boolean;
  domains: string[];
  tenant: { id: string; status: string; createdAt: string } | null;
}
export interface OrganizationList { items: Organization[] }
export interface OrganizationInput { alias: string; name: string; description?: string; domains?: string[] }
export interface OrganizationPatch { name?: string; description?: string; domains?: string[] }

// ------------------------------------------------------------------------------------------ Zugriffsregeln (7.1, /v1/acl)

export type AclEffect = 'grant' | 'restrict' | 'deny';
export type AclPrincipalType = 'user' | 'group' | 'role' | 'client';

export interface AclEntry {
  id: string;
  resourceType: string;
  resourceId: string | null;
  principalType: string;
  principalRef: string;
  permission: string;
  effect: AclEffect;
  createdAt: string;
  createdBy: string | null;
}
export interface AclList { items: AclEntry[] }
export interface AclInput {
  resourceType: string;
  resourceId?: string | null;
  principalType: AclPrincipalType;
  principalRef: string;
  permission: string;
  effect?: AclEffect;
}

/** `GET /v1/acl/effective`: echte Rechte oder Simulation. */
export interface Effective {
  principal: { id: string; kind: string; name: string; clientId: string | null };
  roles: string[];
  groups: string[];
  scopes: string[];
  permissions: string[];
  granted: string[];
  resources: { resourceType: string; resourceId: string; permission: string; allowed: boolean }[];
  simulated: boolean;
  source: 'token' | 'keycloak' | 'last-token' | 'simulation';
}

// -------------------------------------------------------------------------------- Personenverzeichnis (/v1/people)

export interface PersonEntry {
  /** Principal-ID in dieser Organisation. */
  id: string;
  kind: 'user' | 'client';
  name: string;
  email: string | null;
  clientId: string | null;
  lastSeenAt: string | null;
}
export interface PersonList { items: PersonEntry[]; nextCursor: string | null }
