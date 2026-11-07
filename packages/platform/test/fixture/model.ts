/**
 * Modell der Test-App «probe»: Notizen unter der Organisation, mit Klassifizierung, Scopes und MCP-Werkzeugen.
 * Produktmodule: Kern, Notizen (Teilfunktion Abo) und Berichte (braucht Notizen); Pakete «basis» (ohne Berichte, Abo
 * aus) und «gesamt».
 */
import { defineModel } from '@vollholz/iam';

export const model = defineModel({
  product: 'probe',
  modules: [
    { key: 'kern', label: 'Kern', core: true },
    { key: 'notizen', label: 'Notizen', description: 'Notizen der Organisation.', requires: ['kern'], parts: [{ key: 'abo', label: 'Abo', description: 'Notizen als Abo ohne Anmeldung.' }] },
    { key: 'berichte', label: 'Berichte', description: 'Auswertungen der Notizen.', requires: ['notizen'] },
  ],
  packages: [
    { key: 'basis', label: 'Basis', modules: ['kern', 'notizen'], off: ['notizen.abo'] },
    { key: 'gesamt', label: 'Alles', modules: '*' },
  ],
  permissions: {
    'notiz:read': { label: 'Notizen lesen', group: 'notizen', description: 'Notizen und ihren Verlauf sehen.', resources: ['org', 'notiz'], modul: 'notizen' },
    'notiz:write': { label: 'Notizen ändern', group: 'notizen', description: 'Notizen anlegen und ändern.', resources: ['org', 'notiz'], modul: 'notizen' },
    'notiz:delete': { label: 'Notizen löschen', group: 'notizen', description: 'Notizen löschen.', resources: ['org', 'notiz'], modul: 'notizen' },
    'bericht:read': { label: 'Berichte lesen', group: 'berichte', description: 'Auswertungen der Notizen sehen.', resources: ['org'], modul: 'berichte' },
    'webhook:admin': { label: 'Webhooks verwalten', group: 'webhooks', description: 'Webhooks der Organisation anlegen und löschen.', resources: ['org'], scope: false },
    'access:admin': { resources: ['org', 'notiz'] },
  },
  groups: [{ key: 'notizen', label: 'Notizen', match: 'notiz' }, { key: 'berichte', label: 'Berichte', match: 'bericht' }, { key: 'webhooks', label: 'Webhooks', match: 'webhook' }],
  roles: {
    editor: {
      label: 'Bearbeiter:in',
      description: 'Liest, ändert und löscht Notizen; liest Berichte; Organisation lesen.',
      permissions: ['tenant:read', 'notiz:read', 'notiz:write', 'notiz:delete', 'bericht:read'],
    },
    viewer: { label: 'Leser:in', description: 'Liest Notizen; Organisation lesen.', permissions: ['tenant:read', 'notiz:read'] },
    auditor: { label: 'Revisor:in', description: 'Liest Notizen und das Protokoll; Organisation lesen.', permissions: ['tenant:read', 'notiz:read', 'audit:read'] },
  },
  scopes: {
    'probe:read': { text: 'Probe lesen', permissions: ['tenant:read', 'notiz:read', 'bericht:read'] },
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
    get_bericht: { title: 'Bericht lesen', permission: 'bericht:read', readOnly: true },
  },
  features: { audit: true },
});

export type Permission = (typeof model.permissions)[number];
