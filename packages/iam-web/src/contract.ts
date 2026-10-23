/**
 * Typen des HTTP-Vertrags (Spezifikation Kap. 5, 7, 9, 11), von Hand gepflegt nach Kap. 9.5–9.7: Das Paket hängt nicht
 * von den erzeugten Typen einer App ab. `test/contract.check.ts` prüft die unveränderten Teile gegen einen Auszug der
 * OpenAPI von vollholz/assets; Zugriff, Mitglieder, Clients, Katalog und Break-Glass folgen allein der Spezifikation,
 * bis das Backend eine OpenAPI dafür liefert. Schlüssel von Rechten sind `Permission` (ohne Registrierung `string`, mit
 * Registrierung der Typ der App, siehe `permissions.ts`); Rollen, Scopes und Typen sind `string`.
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

/** Vertraulichkeit einer Ressource bzw. Freigabestufe (7.8): `0` intern, `1` vertraulich, `2` streng vertraulich. */
export type Level = 0 | 1 | 2;
/** Ort einer Rolle (7.7, 9.5); `id` leer genau bei `org`. */
export interface ResourceRef { type: string; id: string | null }

// ------------------------------------------------------------------------------------------------ /auth (BFF, 5.1)

/** `GET /auth/me` (9.5). */
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
  /** Rollen an der Organisation (nicht abgelaufene Freigaben eines meiner Subjekte an `org`). */
  roles: string[];
  /** Rechte an der Organisation. */
  permissions: Permission[];
  /** Rechte, die an mindestens einem Ort gelten; Obermenge von `permissions`. */
  somewhere: Permission[];
  /** Wirksame Freigabestufe (mit Break-Glass). */
  clearance: Level;
  breakGlassUntil: string | null;
  csrfToken: string;
  session: { expiresAt: string; idleTimeoutSeconds: number };
}

/** `POST /auth/switch`. */
export interface SwitchInput { org: string; returnTo?: string }
export interface SwitchResult { redirect: string }

/** `GET /v1/me` (9.5). */
export interface ApiMe {
  tenant: { id: string; alias: string };
  principal: { id: string; kind: 'user' | 'client'; name: string; email: string | null; clientId: string | null };
  roles: string[];
  scopes: string[];
  permissions: Permission[];
  somewhere: Permission[];
  clearance: Level;
  breakGlassUntil: string | null;
  tokenBinding: string;
}

// ------------------------------------------------------------------------------------------- Katalog (7.3, GET /v1/authz/catalog)

export interface PermissionInfo {
  key: Permission;
  label: string;
  group: string;
  description: string;
  /** Typen, an denen das Recht geprüft wird (immer mit `org`). */
  resources: string[];
  /** Nur die Rolle org-admin hat dieses Recht (ihre Rolle vergibt nur die Plattform-Administration). */
  adminOnly: boolean;
  /** Nur für Personen, in keinem Scope. */
  personOnly?: true;
}
export interface PermissionGroupInfo { key: string; label: string; match?: string }
/** `adminOnly`: nur die Plattform-Administration vergibt die Rolle. */
export interface CatalogRole { key: string; label: string; description: string; permissions: Permission[]; adminOnly: boolean }
export interface ScopeInfo { key: string; text: string; permissions: Permission[] }
/** Werkzeug des MCP-Dienstes (12.2) mit dem Recht und dem Scope, die es braucht. */
export interface McpToolInfo { name: string; title: string; permission: Permission; scope: string | null; readOnly: boolean }
/** Ort des Modells (7.3); `org` zuerst. */
export interface TypeInfo {
  key: string;
  label: string;
  parent: string | null;
  self?: true;
  /** Rollen, die hier hängen dürfen (org: alle). */
  roles: string[];
  /** `roles` plus Beziehungen ohne Rechte (`member`) und `owner`, wo zulässig. */
  relations: string[];
  leaf?: true;
  classified?: true;
  owner?: true;
  scope?: { relation: string };
  read?: string;
  write?: string;
}
export interface ClassificationInfo { level: Level; label: string }

export interface AuthzCatalog {
  permissions: PermissionInfo[];
  groups: PermissionGroupInfo[];
  roles: CatalogRole[];
  scopes: ScopeInfo[];
  types: TypeInfo[];
  classifications: ClassificationInfo[];
  mcpTools: McpToolInfo[];
}

// ------------------------------------------------------------------------------------------- Zugriff (9.5, /v1/access)

/** Subjekt einer Freigabe: `user:<id>`, `client:<id>`, `group:<entra-object-id>` oder `org:members`. */
export interface AccessSubject {
  ref: string;
  kind: 'user' | 'client' | 'group' | 'members';
  /** Name der Person bzw. des Clients, Anzeigename der Gruppe (sonst Objekt-ID), «Alle Mitglieder». */
  name: string;
  /** Nur Clients: Scopes im letzten Token. */
  scopes?: string[] | null;
}
/** Einheit, zu der eine Ressource gehört (Zuständigkeit, 7.5 Regel 2). */
export interface AccessUnit { ref: ResourceRef; relation: string; grants: 'read' | 'edit' }
export interface AccessEntry {
  /** Tupel-ID; `null` bei Zuständigkeit. */
  id: string | null;
  subject: AccessSubject;
  /** Rolle, `member` oder `owner`. */
  relation: string;
  /** Ort des Tupels. */
  place: ResourceRef;
  via: 'direct' | 'inherited' | 'scope';
  /** Nur bei `scope`. */
  unit?: AccessUnit;
  expiresAt: string | null;
  createdAt: string | null;
  /** Name. */
  createdBy: string | null;
  /** Ich darf entfernen und den Ablauf ändern (nur `direct`). */
  removable: boolean;
}
/** `GET /v1/access?type=&id=`. */
export interface AccessList {
  resource: ResourceRef;
  /** `null`: Typ ohne `classified`. */
  classification: Level | null;
  /** Direkt zuerst, dann geerbt von unten nach oben, dann Zuständigkeit. */
  items: AccessEntry[];
  /** Relationen, die ich hier vergeben darf; leer ohne `access:admin`. */
  grantable: string[];
}
/** `GET /v1/access?subject=me` bzw. `?subject=<subjekt>`: nur `via: 'direct'`. */
export interface AccessEntryList { items: AccessEntry[] }
/** `POST /v1/access`. */
export interface AccessInput { subject: string; relation: string; type: string; id?: string | null; expiresAt?: string | null }
/** `PATCH /v1/access/{id}`. */
export interface AccessPatch { expiresAt: string | null }
/** `GET /v1/access/groups`: Gruppen aus Entra ID (`id` = Objekt-ID, Subjekt `group:<id>`). */
export interface AccessGroupList { items: { id: string; name: string }[] }

/** `GET /v1/access/explain`. */
export interface Explain {
  allowed: boolean;
  permission: string;
  subject: { ref: string; name: string };
  /** Alle Wege, die das Recht ergeben; leer, wenn keiner. */
  reasons: {
    via: 'direct' | 'inherited' | 'scope' | 'owner';
    relation: string;
    place: ResourceRef;
    tupleId: string | null;
    /** Welches Subjekt passt, z. B. `group:<entra-object-id>` oder `org:members`. */
    matched: string;
    unit?: AccessUnit;
  }[];
  /** Was trotz Weg verhindert; `null`, wenn erlaubt oder kein Weg. */
  blocked:
    | { reason: 'clearance'; classification: Level; clearance: Level }
    | { reason: 'scope'; scope: string | null }
    | null;
}

/** `POST /v1/break-glass` (9.7): Begründung 1–500 Zeichen, Dauer 1–240 Minuten. */
export interface BreakGlassInput { reason: string; minutes: number }
export interface BreakGlassResult { until: string; clearance: 2 }

// --------------------------------------------------------------------------------------------- Verwaltung (9.2, 9.6)

export interface AdminStatus {
  enabled: boolean;
  reason: string | null;
  organization: string;
  platformAdmin: boolean;
  canManageMembers: boolean;
  roles: RoleInfo[];
}
/** Rolle in `GET /v1/admin/status`: Rollen an der Organisation mit ihren Rechten. */
export interface RoleInfo { key: string; label: string; description: string; permissions: Permission[]; adminOnly: boolean }

/** Person oder freigegebener Maschinen-Client der Organisation (9.6). */
export interface Member {
  /** Person: Keycloak-ID bzw. Einladungs-ID; Client: Client-ID. */
  id: string;
  kind: 'user' | 'client';
  /** Subjekt `user:<id>` bzw. `client:<id>`. */
  principalId: string;
  username: string;
  name: string;
  email: string | null;
  status: 'active' | 'invited' | 'disabled';
  /** Rollen an der Organisation. */
  roles: string[];
  /** Gespeicherte Freigabestufe, ohne Break-Glass. */
  clearance: Level;
  breakGlassUntil: string | null;
  /** Freigaben an anderen Orten als der Organisation («+3 Orte»). */
  places: number;
  lastSeenAt: string | null;
  createdAt: string | null;
  /** Nur offene Einladung aus Entra ID. */
  loginPath: string | null;
  /** Nur Clients. */
  clientId: string | null;
  /** Nur Clients: Scopes im letzten Token. */
  scopes: string[] | null;
}
export interface MemberList { items: Member[] }
export interface InviteInput { email: string; firstName?: string; lastName?: string; roles?: string[] }
export interface InviteResult { result: 'invitation-sent'; emailSent: boolean; member: Member }
export interface RemoveResult { accountDeleted: boolean }
export interface ResendResult { emailSent: boolean }
export interface RolesInput { roles: string[] }
export interface ClearanceInput { clearance: Level }

/** Freigegebener Maschinen-Client (9.6). */
export interface Client {
  clientId: string;
  principalId: string;
  description: string;
  roles: string[];
  clearance: Level;
  places: number;
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  lastScopes: string[] | null;
}
export interface ClientList { items: Client[] }
/** `PUT /v1/admin/clients/{clientId}`: Rollen an der Organisation (mindestens eine), Beschreibung bis 500 Zeichen. */
export interface ClientInput { roles: string[]; description?: string; clearance?: Level }

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
  /** Ab iam 0.3.0: über die Plattform-App (`platform`) oder die eigene App-Registrierung der Organisation (`own`). */
  method?: EntraMethod;
  /** Eigene App: Client-ID der App-Registrierung. */
  clientId?: string | null;
  /** Umleitungs-URI des Anbieters dieser Verbindung. */
  redirectUri?: string;
  /** Eigene App: Ablauf des Secrets (falls bekannt); `secretExpiresSoon` ab 30 Tagen davor und wenn abgelaufen. */
  secretExpiresAt?: string | null;
  secretExpiresSoon?: boolean;
}
export type EntraMethod = 'platform' | 'own';
/** Berechtigung der eigenen App-Registrierung (Microsoft Graph); `optional`: z. B. damit der Server den Ablauf des Secrets liest. */
export interface EntraPermission { name: string; type: 'Application' | 'Delegated'; why: string; optional?: boolean }
/** Anleitung für die eigene App-Registrierung: Redirect-URI und Berechtigungen, vom Server. */
export interface EntraOwnAppGuide { redirectUri: string; permissions: EntraPermission[] }
/**
 * Eigene App-Registrierung verbinden bzw. Secret wechseln: `tenant` Verzeichnis-ID oder Domäne (bei bestehender
 * Verbindung gleich), `secretExpiresAt` nur nötig, wenn der Server den Ablauf nicht selbst lesen kann.
 */
export interface EntraOwnAppInput { tenant: string; clientId: string; clientSecret: string; secretExpiresAt?: string | null }
/**
 * `consentPath`, `testPath`: Rückkehrpfade des Servers (ENTRA_UI_PATH), müssen zu `paths.entra` passen; ältere Server ohne.
 * Ab iam 0.3.0 `methods`: angebotene Wege (Zustimmung zur Plattform-App, eigene App-Registrierung) und `ownApp` mit der
 * Anleitung. Ältere Server ohne `methods` bieten nur die Plattform-App.
 */
export interface EntraStatus {
  enabled: boolean; reason: string | null; connection: EntraConnection | null; consentPath?: string; testPath?: string;
  methods?: { platformApp: boolean; ownApp: boolean };
  /** Warum die eigene App nicht angeboten wird (z. B. fehlende Verschlüsselung auf dem Server). */
  ownAppReason?: string | null;
  ownApp?: EntraOwnAppGuide | null;
}
/** `passwordKept`: warum Passwort und Passkey bei «Nur Entra» bleiben (z. B. Konto der Plattform-Administration). */
export interface EntraMember { name: string; email: string; linked: boolean; reason: string | null; passwordKept?: string }
export interface EntraResult { connection: EntraConnection; members: EntraMember[]; rejectedDomains: string[] }
export interface EntraPreview { members: EntraMember[] }
export interface EntraConsentInput { tenant: string }
export interface EntraConsentStart { entraTenantId: string; url: string }
/** Rückkehr von Microsoft (Code-Flow): `code` weist die Zustimmung nach, bei Abbruch `error`. */
export interface EntraConsentReturn { state: string; code?: string; error?: string; errorDescription?: string }
/**
 * Link an die Entra-Administration (Übergabe der Zustimmung an eine andere Person, ohne Sitzung). `in-progress`: beim
 * Einlösen belegt (höchstens 5 Min.); `revoked` mit `error.reason` `creator-lost-access` bzw. `disconnected`, von Hand
 * widerrufen mit `error` null.
 */
export type ConsentLinkStatus = 'open' | 'in-progress' | 'expired' | 'revoked' | 'connected' | 'failed';
export interface ConsentLink {
  id: string;
  entraTenantId: string;
  createdByName: string;
  createdAt: string;
  expiresAt: string;
  status: ConsentLinkStatus;
  usedAt: string | null;
  approverName: string | null;
  error: { reason: string; detail: string } | null;
  /** Ab iam 0.3.0; ohne: `consent`. */
  kind?: ConsentLinkKind;
}
export interface ConsentLinkList { items: ConsentLink[] }
/** `validMinutes` 5–1440, Standard 15. */
/** `kind` ab iam 0.3.0: `consent` (bei Microsoft zustimmen) oder `credentials` (eigene App-Registrierung eintragen). */
export type ConsentLinkKind = 'consent' | 'credentials';
export interface ConsentLinkInput { tenant: string; validMinutes?: number; kind?: ConsentLinkKind }
/** `url`: `<PUBLIC_BASE_URL><ENTRA_UI_PATH>/freigabe#<token>`, das Token nur im Fragment. */
export interface ConsentLinkCreated { id: string; url: string; entraTenantId: string; expiresAt: string; kind?: ConsentLinkKind }
/**
 * Öffentlich (`/v1/entra/handover/*`): Angaben zum Link für die Entra-Administration. `notice`: Hinweis des Servers
 * (z. B. dass verifizierte Domänen an die Organisation gehen), anzeigen.
 */
export interface HandoverToken { token: string }
export interface HandoverInfo {
  organization: string; product: string; requestedBy: string; tenant: string; entraTenantId: string; notice: string; expiresAt: string;
  /** Ab iam 0.3.0; ohne: `consent`. Bei `credentials` die Anleitung der eigenen App-Registrierung (`ownApp`). */
  kind?: ConsentLinkKind;
  ownApp?: EntraOwnAppGuide | null;
}
/** Eigene App-Registrierung über den Link eintragen (öffentlich, Token nur im Body; das Verzeichnis gibt der Link vor). */
export interface HandoverCredentialsInput { token: string; clientId: string; clientSecret: string; secretExpiresAt?: string | null }
export interface HandoverStart { url: string }
export interface HandoverResult { organization: string; connected: true }

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
