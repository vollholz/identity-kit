/**
 * Beispielkatalog einer Notiz-App (Spezifikation 8, 15.2) für Tests der Bausteine und der Apps: reservierte Rechte und
 * Rollen (8.1) plus `note:*` und `folder:admin`, Ressourcenkette tenant → folder → note (Blatt).
 */
import type { AuthzCatalog, Me } from '../contract.ts';

const P = (key: string, label: string, group: string, resources: string[], adminOnly = false, description = '') =>
  ({ key, label, group, resources, adminOnly, description: description || label });

const NOTE_PERMS = ['note:read', 'note:write', 'note:delete'];
const ALL = ['tenant:read', 'tenant:admin', 'members:admin', 'acl:read', 'acl:admin', 'audit:read', 'note:read', 'note:write', 'note:delete', 'folder:admin'];

export const CATALOG: AuthzCatalog = {
  permissions: [
    P('tenant:read', 'Organisation lesen', 'tenant', ['tenant']),
    P('tenant:admin', 'Organisation verwalten', 'tenant', ['tenant'], true),
    P('members:admin', 'Mitglieder und Rollen verwalten', 'members', ['tenant'], true),
    P('acl:read', 'Zugriff lesen', 'access', ['tenant']),
    P('acl:admin', 'Zugriff verwalten', 'access', ['tenant'], true),
    P('audit:read', 'Protokoll lesen', 'audit', ['tenant']),
    P('note:read', 'Notizen lesen', 'notes', ['tenant', 'folder', 'note']),
    P('note:write', 'Notizen ändern', 'notes', ['tenant', 'folder', 'note']),
    P('note:delete', 'Notizen löschen', 'notes', ['tenant', 'folder', 'note']),
    P('folder:admin', 'Ordner verwalten', 'notes', ['tenant', 'folder']),
  ],
  groups: [
    { key: 'tenant', label: 'Organisation' }, { key: 'notes', label: 'Notizen' }, { key: 'members', label: 'Mitglieder und Rollen' },
    { key: 'access', label: 'Zugriff' }, { key: 'audit', label: 'Protokoll' },
  ],
  roles: [
    { key: 'org-admin', label: 'Organisations-Admin', description: 'Alle Rechte: Organisation, Notizen, Mitglieder und Rollen, Zugriff, Protokoll.', permissions: ALL, adminOnly: true },
    { key: 'folder-admin', label: 'Ordner-Admin', description: 'Organisation lesen; Notizen lesen, ändern, löschen und Ordner verwalten; Zugriff lesen.', permissions: ['tenant:read', 'acl:read', ...NOTE_PERMS, 'folder:admin'], adminOnly: false },
    { key: 'editor', label: 'Bearbeiter:in', description: 'Organisation lesen; Notizen lesen und ändern.', permissions: ['tenant:read', 'note:read', 'note:write'], adminOnly: false },
    { key: 'viewer', label: 'Leser:in', description: 'Organisation lesen; Notizen lesen.', permissions: ['tenant:read', 'note:read'], adminOnly: false },
    { key: 'auditor', label: 'Prüfer:in', description: 'Organisation lesen; Protokoll und Zugriff lesen.', permissions: ['tenant:read', 'audit:read', 'acl:read'], adminOnly: false },
  ],
  scopes: [
    { key: 'notes:read', text: 'Organisation und Notizen lesen', permissions: ['tenant:read', 'note:read'] },
    { key: 'notes:write', text: 'Notizen ändern und löschen', permissions: ['note:write', 'note:delete'] },
  ],
  // `leaf`: Blatt der Kette, dort keine Freigabe (Spezifikation 7.1)
  resourceTypes: [{ key: 'tenant', label: 'Organisation' }, { key: 'folder', label: 'Ordner' }, { key: 'note', label: 'Notiz', leaf: true }],
};

/** /auth/me einer Person mit zwei Organisationen (Organisation des Tabs: «Demo AG»). */
export const ME: Me = {
  person: { subject: 'sub-anna', name: 'Anna Admin', email: 'anna@demo.example' },
  tenant: { id: 't1', alias: 'demo', name: 'Demo AG' }, organizations: ['demo', 'muster'], organizationNames: { demo: 'Demo AG', muster: 'Muster GmbH' },
  selectedOrganization: 'demo', tenantError: null,
  roles: ['org-admin'], permissions: ALL, grantedPermissions: [], csrfToken: 'csrf-123',
  session: { expiresAt: '2030-01-01T00:00:00.000Z', idleTimeoutSeconds: 3600 },
};
