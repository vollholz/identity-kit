/**
 * Beispiele der Antworten und Anfragen aus Spezifikation 9.5–9.7 (Authz neu) mit allen Feldern; `test/contract.check.ts`
 * hält damit die von Hand gepflegten Typen fest (gleiche Felder, gleiche Pflichtfelder), bis das Backend eine OpenAPI
 * dafür liefert.
 */
import type {
  AccessEntry, AccessInput, AccessList, AdminStatus, ApiMe, AuthzCatalog, BreakGlassInput, BreakGlassResult, Client, ClientInput, Explain, Member,
} from '../../src/contract.ts';

export const CATALOG_FIXTURE = {
  permissions: [{ key: 'note:read', label: 'Notizen lesen', group: 'notes', description: '…', resources: ['org', 'folder', 'note'], adminOnly: false, personOnly: true as const }],
  groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }],
  roles: [{ key: 'viewer', label: 'Leser:in', description: 'Notizen lesen.', permissions: ['note:read'], adminOnly: false }],
  scopes: [{ key: 'notes:read', text: 'Notizen lesen', permissions: ['note:read'] }],
  types: [
    { key: 'org', label: 'Organisation', parent: null, roles: ['viewer'], relations: ['viewer'] },
    {
      key: 'note', label: 'Notiz', parent: 'org', self: true as const, roles: ['viewer'], relations: ['viewer', 'member', 'owner'], leaf: true as const,
      classified: true as const, owner: true as const, scope: { relation: 'Gehört zu' }, read: 'note:read', write: 'note:write',
    },
  ],
  classifications: [{ level: 0 as const, label: 'intern' }],
  mcpTools: [{ name: 'notes_search', title: 'Notizen suchen', permission: 'note:read', scope: 'notes:read', readOnly: true }],
} satisfies AuthzCatalog;

export const API_ME_FIXTURE = {
  tenant: { id: 't1', alias: 'demo' },
  principal: { id: 'p1', kind: 'client' as const, name: 'notiz-import', email: null, clientId: 'notiz-import' },
  roles: ['editor'], scopes: ['notes:read'], permissions: ['note:read'], somewhere: ['note:read'],
  clearance: 0 as const, breakGlassUntil: null, tokenBinding: 'dpop',
} satisfies ApiMe;

export const ACCESS_SCOPE_FIXTURE = {
  id: null,
  subject: { ref: 'group:0f0e', kind: 'group' as const, name: 'Abteilung X' },
  relation: 'member',
  place: { type: 'unit', id: 'u1' },
  via: 'scope' as const,
  unit: { ref: { type: 'unit', id: 'u1' }, relation: 'Gehört zu', grants: 'read' as const },
  expiresAt: null, createdAt: null, createdBy: null,
  removable: false,
} satisfies AccessEntry;

export const ACCESS_CLIENT_FIXTURE = {
  id: 'tp1',
  subject: { ref: 'client:p2', kind: 'client' as const, name: 'sync-1', scopes: ['notes:read'] },
  relation: 'editor', place: { type: 'org', id: null }, via: 'inherited' as const,
  expiresAt: null, createdAt: '2026-10-01T00:00:00Z', createdBy: 'Anna Admin', removable: false,
} satisfies AccessEntry;

export const ACCESS_LIST_FIXTURE = {
  resource: { type: 'note', id: 'n42' },
  classification: 1 as const,
  items: [ACCESS_SCOPE_FIXTURE, ACCESS_CLIENT_FIXTURE],
  grantable: ['viewer'],
} satisfies AccessList;

export const EXPLAIN_FIXTURE = {
  allowed: false,
  permission: 'note:read',
  subject: { ref: 'user:p1', name: 'Anna Admin' },
  reasons: [{ via: 'scope' as const, relation: 'member', place: { type: 'unit', id: 'u1' }, tupleId: null, matched: 'group:0f0e', label: 'Abteilung X', unit: ACCESS_SCOPE_FIXTURE.unit }],
  blocked: { reason: 'clearance' as const, classification: 2 as const, clearance: 1 as const },
} satisfies Explain;

export const MEMBER_FIXTURE = {
  id: 'kc-1', kind: 'user' as const, principalId: 'p1', username: 'anna', name: 'Anna Admin', email: 'anna@demo.example',
  status: 'active' as const, roles: ['org-admin'], clearance: 2 as const, breakGlassUntil: null, places: 3,
  lastSeenAt: null, createdAt: null, loginPath: null, clientId: null, scopes: null, description: null,
} satisfies Member;

export const CLIENT_FIXTURE = {
  clientId: 'notiz-import', principalId: 'p2', description: 'Import', roles: ['editor'], clearance: 0 as const, places: 0,
  createdAt: '2026-10-01T00:00:00Z', createdBy: null, lastUsedAt: null, lastScopes: null,
} satisfies Client;

export const STATUS_FIXTURE = {
  enabled: true, reason: null, organization: 'demo', platformAdmin: false, canManageMembers: true,
  roles: [{ key: 'viewer', label: 'Leser:in', description: '…', permissions: ['note:read'], adminOnly: false }],
} satisfies AdminStatus;

export const ACCESS_INPUT_FIXTURE = { subject: 'org:members', relation: 'viewer', type: 'note', id: 'n42', expiresAt: null } satisfies AccessInput;
export const CLIENT_INPUT_FIXTURE = { roles: ['editor'], description: 'Import', clearance: 0 as const } satisfies ClientInput;
export const BREAK_GLASS_INPUT_FIXTURE = { reason: 'Störung', minutes: 60 } satisfies BreakGlassInput;
export const BREAK_GLASS_FIXTURE = { until: '2026-10-23T14:30:00Z', clearance: 2 as const } satisfies BreakGlassResult;
