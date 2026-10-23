/**
 * Beispielmodell einer Notiz-App (Spezifikation 7.3, 8, 15.2) für Tests der Bausteine und der Apps: reservierte Rechte und
 * Rollen (8.1) plus `note:*` und `folder:admin`, Kette org → folder → note (Blatt, mit Vertraulichkeit und Besitz).
 */
import type { AuthzCatalog, Me } from '../contract.ts';

const P = (key: string, label: string, group: string, resources: string[], adminOnly = false, description = '') =>
  ({ key, label, group, resources, adminOnly, description: description || label });

const NOTE_PERMS = ['note:read', 'note:write', 'note:delete'];
const ALL = ['tenant:read', 'tenant:admin', 'members:admin', 'access:admin', 'audit:read', 'note:read', 'note:write', 'note:delete', 'folder:admin'];
const ROLES = ['org-admin', 'folder-admin', 'editor', 'viewer', 'auditor'];

export const CATALOG: AuthzCatalog = {
  permissions: [
    P('tenant:read', 'Organisation lesen', 'tenant', ['org']),
    P('tenant:admin', 'Organisation verwalten', 'tenant', ['org'], true),
    { ...P('members:admin', 'Mitglieder und Rollen verwalten', 'members', ['org'], true), personOnly: true },
    { ...P('access:admin', 'Zugriff verwalten', 'access', ['org', 'folder', 'note']), personOnly: true },
    P('audit:read', 'Protokoll lesen', 'audit', ['org']),
    P('note:read', 'Notizen lesen', 'notes', ['org', 'folder', 'note']),
    P('note:write', 'Notizen ändern', 'notes', ['org', 'folder', 'note']),
    P('note:delete', 'Notizen löschen', 'notes', ['org', 'folder', 'note']),
    P('folder:admin', 'Ordner verwalten', 'notes', ['org', 'folder']),
  ],
  groups: [
    { key: 'tenant', label: 'Organisation' }, { key: 'notes', label: 'Notizen' }, { key: 'members', label: 'Mitglieder und Rollen' },
    { key: 'access', label: 'Zugriff' }, { key: 'audit', label: 'Protokoll' },
  ],
  roles: [
    { key: 'org-admin', label: 'Organisations-Admin', description: 'Alle Rechte: Organisation, Notizen, Mitglieder und Rollen, Zugriff, Protokoll.', permissions: ALL, adminOnly: true },
    { key: 'folder-admin', label: 'Ordner-Admin', description: 'Organisation lesen; Notizen lesen, ändern, löschen und Ordner verwalten; Zugriff verwalten.', permissions: ['tenant:read', 'access:admin', ...NOTE_PERMS, 'folder:admin'], adminOnly: false },
    { key: 'editor', label: 'Bearbeiter:in', description: 'Organisation lesen; Notizen lesen und ändern; Zugriff verwalten.', permissions: ['tenant:read', 'note:read', 'note:write', 'access:admin'], adminOnly: false },
    { key: 'viewer', label: 'Leser:in', description: 'Organisation lesen; Notizen lesen.', permissions: ['tenant:read', 'note:read'], adminOnly: false },
    { key: 'auditor', label: 'Prüfer:in', description: 'Organisation lesen; Protokoll lesen.', permissions: ['tenant:read', 'audit:read'], adminOnly: false },
  ],
  scopes: [
    { key: 'notes:read', text: 'Organisation und Notizen lesen', permissions: ['tenant:read', 'note:read'] },
    { key: 'notes:write', text: 'Notizen ändern und löschen', permissions: ['note:write', 'note:delete'] },
  ],
  types: [
    { key: 'org', label: 'Organisation', parent: null, roles: ROLES, relations: ROLES },
    { key: 'folder', label: 'Ordner', parent: 'org', roles: ['folder-admin', 'editor', 'viewer'], relations: ['folder-admin', 'editor', 'viewer'], read: 'note:read' },
    { key: 'note', label: 'Notiz', parent: 'folder', roles: ['editor', 'viewer'], relations: ['editor', 'viewer', 'owner'], leaf: true, classified: true, owner: true, read: 'note:read', write: 'note:write' },
  ],
  classifications: [{ level: 0, label: 'intern' }, { level: 1, label: 'vertraulich' }, { level: 2, label: 'streng vertraulich' }],
  mcpTools: [],
};

/** /auth/me einer Person mit zwei Organisationen (Organisation des Tabs: «Demo AG»), Organisations-Admin mit Freigabestufe 1. */
export const ME: Me = {
  person: { subject: 'sub-anna', name: 'Anna Admin', email: 'anna@demo.example' },
  tenant: { id: 't1', alias: 'demo', name: 'Demo AG', entraConnected: false }, organizations: ['demo', 'muster'], organizationNames: { demo: 'Demo AG', muster: 'Muster GmbH' },
  selectedOrganization: 'demo', tenantError: null,
  roles: ['org-admin'], permissions: ALL, somewhere: ALL, clearance: 1, breakGlassUntil: null, breakGlassAllowed: true, csrfToken: 'csrf-123',
  session: { expiresAt: '2030-01-01T00:00:00.000Z', idleTimeoutSeconds: 3600 },
};
