/**
 * Typen des HTTP-Vertrags (Spezifikation Kap. 5, 7, 8.3, 9, 11; docs/entwurf.md › Teststrategie), von Hand gepflegt:
 * Das Paket hängt nicht von den erzeugten Typen einer App ab. `test/contract.check.ts` prüft sie gegen einen Auszug der
 * OpenAPI von vollholz/assets. Schlüssel von Rechten sind `Permission` (ohne Registrierung `string`, mit Registrierung
 * der Typ der App, siehe `permissions.ts`); Rollen, Scopes und Ressourcentypen sind `string`.
 */
import type { Permission } from './permissions.ts';

/**
 * Fehler nach RFC 9457 mit den Erweiterungen des Vertrags; alles optional, weil auch Antworten ohne problem+json ankommen.
 * Weitere Erweiterungsfelder der App (RFC 9457, Abschnitt 3.2) bleiben erhalten und sind als `unknown` lesbar.
 */
export interface ProblemDetails {
  [extension: string]: unknown;
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
  tenant: { id: string; alias: string; name: string } | null;
  /** Aliasse der Organisationen der Person (aus dem Token). */
  organizations: string[];
  /** Name je Alias (für jede Organisation in `organizations`). */
  organizationNames: Record<string, string>;
  selectedOrganization: string | null;
  /** Grund, warum `tenant` fehlt (Text für die Person). */
  tenantError: string | null;
  roles: string[];
  /** Rechte auf Ebene der Organisation (effektiv). */
  permissions: Permission[];
  /** Rechte nur über Freigaben auf einzelnen Ressourcen; immer vorhanden, leer ohne Freigaben (5.1, 7.1). */
  grantedPermissions: Permission[];
  csrfToken: string;
  session: { expiresAt: string; idleTimeoutSeconds: number };
}

/** `POST /auth/switch`. */
export interface SwitchInput { org: string; returnTo?: string }
export interface SwitchResult { redirect: string }

// ------------------------------------------------------------------------------------------- Katalog (7.2, GET /v1/authz/catalog)

export interface PermissionInfo {
  key: Permission;
  label: string;
  description: string;
  group: string;
  /** Ressourcentypen, auf denen eine Zugriffsregel für dieses Recht wirkt. */
  resources: string[];
  /** Nur die Rolle org-admin hat dieses Recht. */
  adminOnly: boolean;
}
export interface PermissionGroupInfo { key: string; label: string }
export interface CatalogRole { key: string; label: string; description: string; permissions: Permission[]; adminOnly: boolean }
export interface ScopeInfo { key: string; text: string; permissions: Permission[] }
/** Werkzeug des MCP-Dienstes (12.2) mit dem Recht und dem Scope, die es braucht. */
export interface McpToolInfo { name: string; title: string; permission: Permission; scope: string | null; readOnly: boolean }
/** `leaf`: Blatt der Kette, dort nie `grant` (7.1); fehlt, wenn der Server es nicht meldet. */
export interface ResourceTypeInfo { key: string; label: string; leaf?: boolean }

export interface AuthzCatalog {
  permissions: PermissionInfo[];
  groups: PermissionGroupInfo[];
  roles: CatalogRole[];
  scopes: ScopeInfo[];
  resourceTypes: ResourceTypeInfo[];
  /** Nur mit MCP-Dienst (7.2). */
  mcpTools?: McpToolInfo[];
}

// --------------------------------------------------------------------------------------------- Rollen (8.3, /v1/roles)

export interface Role {
  key: string;
  label: string;
  description: string;
  permissions: Permission[];
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
  customPermissions: Permission[];
  maxCustom: number;
}
export interface RoleInput { label: string; description?: string; permissions: Permission[] }
export interface RolePatch { label?: string; description?: string; permissions?: Permission[] }

// --------------------------------------------------------------------------------------------- Verwaltung (9.2)

export interface AdminStatus {
  enabled: boolean;
  reason: string | null;
  organization: string;
  platformAdmin: boolean;
  canManageMembers: boolean;
  rolesManageable: boolean;
  roles: RoleInfo[];
  /** `GROUP_ROLE_PREFIX` des Servers (Spezifikation 14), z. B. `/orgs`; ältere Server ohne. */
  groupRolePrefix?: string;
}
/** Rolle in `GET /v1/admin/status`: vergebbare Rollen der Organisation mit ihren Rechten. */
export interface RoleInfo { key: string; label: string; description: string; permissions: Permission[]; adminOnly: boolean; custom?: boolean }

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
/** `description: null` leert die Beschreibung; fehlt das Feld, bleibt sie. */
export interface OrganizationPatch { name?: string; description?: string | null; domains?: string[] }

// ------------------------------------------------------------------------------------------ Zugriffsregeln (7.1, /v1/acl)

export type AclEffect = 'grant' | 'restrict' | 'deny';
export type AclPrincipalType = 'user' | 'group' | 'role' | 'client';

export interface AclEntry {
  id: string;
  resourceType: string;
  resourceId: string | null;
  principalType: string;
  principalRef: string;
  permission: Permission;
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
  permission: Permission;
  effect?: AclEffect;
}

/** `GET /v1/acl/effective`: echte Rechte oder Simulation. */
export interface Effective {
  principal: { id: string; kind: string; name: string; clientId: string | null };
  roles: string[];
  groups: string[];
  scopes: string[];
  permissions: Permission[];
  granted: Permission[];
  resources: { resourceType: string; resourceId: string; permission: Permission; allowed: boolean }[];
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
