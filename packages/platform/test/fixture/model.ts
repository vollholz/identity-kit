/**
 * Modell der Test-App «probe»: Notizen unter der Organisation, mit Klassifizierung, Scopes und MCP-Werkzeugen.
 */
import { defineModel } from '@vollholz/iam';

export const model = defineModel({
  product: 'probe',
  permissions: {
    'notiz:read': { label: 'Notizen lesen', group: 'notizen', description: 'Notizen und ihren Verlauf sehen.', resources: ['org', 'notiz'] },
    'notiz:write': { label: 'Notizen ändern', group: 'notizen', description: 'Notizen anlegen und ändern.', resources: ['org', 'notiz'] },
    'notiz:delete': { label: 'Notizen löschen', group: 'notizen', description: 'Notizen löschen.', resources: ['org', 'notiz'] },
    'webhook:admin': { label: 'Webhooks verwalten', group: 'webhooks', description: 'Webhooks der Organisation anlegen und löschen.', resources: ['org'], scope: false },
    'access:admin': { resources: ['org', 'notiz'] },
  },
  groups: [{ key: 'notizen', label: 'Notizen', match: 'notiz' }, { key: 'webhooks', label: 'Webhooks', match: 'webhook' }],
  roles: {
    editor: {
      label: 'Bearbeiter:in',
      description: 'Liest, ändert und löscht Notizen; Organisation lesen.',
      permissions: ['tenant:read', 'notiz:read', 'notiz:write', 'notiz:delete'],
    },
    viewer: { label: 'Leser:in', description: 'Liest Notizen; Organisation lesen.', permissions: ['tenant:read', 'notiz:read'] },
    auditor: { label: 'Revisor:in', description: 'Liest Notizen und das Protokoll; Organisation lesen.', permissions: ['tenant:read', 'notiz:read', 'audit:read'] },
  },
  scopes: {
    'probe:read': { text: 'Probe lesen', permissions: ['tenant:read', 'notiz:read'] },
    'notiz:write': { text: 'Notizen ändern', permissions: ['notiz:write', 'notiz:delete'] },
  },
  types: {
    org: { label: 'Organisation', roles: ['editor', 'viewer', 'auditor'] },
    notiz: {
      label: 'Notiz', parent: 'org', roles: ['editor', 'viewer'], leaf: true, classified: true,
      read: 'notiz:read', write: 'notiz:write',
    },
  },
  capabilities: { notiz: { write: 'notiz:write', delete: 'notiz:delete' } },
  mcpTools: {
    list_notizen: { title: 'Notizen auflisten', permission: 'notiz:read', readOnly: true },
    get_notiz: { title: 'Notiz lesen', permission: 'notiz:read', readOnly: true },
  },
  features: { audit: true },
});

export type Permission = (typeof model.permissions)[number];
