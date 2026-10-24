/**
 * Modelle für die Tests: die Notiz-App mit allen Wegen der Entscheidung (Kap. 7.5) – Ordner mit Unterordnern (`self`),
 * Notizen als Blatt mit Vertraulichkeit und Zuständigkeit über Teams, Teams als Einheiten (`member`), Ansichten mit
 * Besitz – und ein einfaches Modell nur mit Rollen an der Organisation (Stufe «einfach»).
 */
import { defineModel } from '../../src/model.ts';

export const notesInput = () => ({
  product: 'notes',
  permissions: {
    'note:read': { label: 'Notizen lesen', group: 'notes', description: 'Notizen sehen.', resources: ['org', 'folder', 'note'] },
    'note:write': { label: 'Notizen ändern', group: 'notes', description: 'Notizen anlegen und ändern.', resources: ['org', 'folder', 'note'] },
    'note:share': { label: 'Notizen teilen', group: 'notes', description: 'Notizen ausserhalb teilen.', scope: false as const },
    'team:read': { label: 'Teams lesen', group: 'teams', description: 'Teams und ihre Mitglieder sehen.', resources: ['org', 'team'] },
    'view:read': { label: 'Ansichten lesen', group: 'views', description: 'Gespeicherte Ansichten sehen.', resources: ['org', 'view'] },
    'view:write': { label: 'Ansichten ändern', group: 'views', description: 'Gespeicherte Ansichten ändern.', resources: ['org', 'view'] },
    'access:admin': { resources: ['org', 'folder', 'note', 'team', 'view'] },
  },
  groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }, { key: 'teams', label: 'Teams', match: 'team' }, { key: 'views', label: 'Ansichten', match: 'ansicht' }],
  roles: {
    editor: { label: 'Bearbeiter:in', description: 'Liest und ändert Notizen und Ansichten, teilt sie, sieht Teams und gibt Zugriff; Organisation lesen.', permissions: ['tenant:read', 'note:read', 'note:write', 'note:share', 'team:read', 'view:read', 'view:write', 'access:admin'] },
    viewer: { label: 'Leser:in', description: 'Liest Notizen, Teams und Ansichten der Organisation.', permissions: ['tenant:read', 'note:read', 'team:read', 'view:read'] },
  },
  scopes: {
    'notes:read': { text: 'Notizen lesen', permissions: ['tenant:read', 'note:read', 'team:read', 'view:read'] },
    'notes:write': { text: 'Notizen ändern', permissions: ['note:write', 'view:write'] },
  },
  types: {
    folder: { label: 'Ordner', parent: 'org', self: 'folder', roles: ['editor', 'viewer'], read: 'note:read' },
    note: { label: 'Notiz', parent: 'folder', roles: ['editor', 'viewer'], leaf: true, classified: true, scope: { via: 'reference', relation: 'gehört zu' }, read: 'note:read', write: 'note:write' },
    team: { label: 'Team', parent: 'org', roles: ['viewer'], relations: ['member'], read: 'team:read' },
    view: { label: 'Ansicht', parent: 'org', roles: ['editor', 'viewer'], owner: true, read: 'view:read', write: 'view:write' },
  },
  capabilities: { note: { write: 'note:write', share: 'note:share' } },
  features: { audit: true },
} as const);

export const notesModel = defineModel(notesInput());

/** Stufe «einfach»: nur Rollen an der Organisation. */
export const simpleModel = defineModel({
  product: 'kanban',
  permissions: {
    'card:read': { label: 'Karten lesen', group: 'cards', description: 'Karten sehen.' },
    'card:write': { label: 'Karten ändern', group: 'cards', description: 'Karten anlegen und ändern.' },
  },
  groups: [{ key: 'cards', label: 'Karten', match: 'karte' }],
  roles: {
    worker: { label: 'Mitarbeiter:in', description: 'Liest und ändert Karten; Organisation lesen.', permissions: ['tenant:read', 'card:read', 'card:write'] },
    guest: { label: 'Gast', description: 'Liest Karten.', permissions: ['card:read'] },
  },
});

/** Notiz-App mit einer Rolle, die nur an Ordnern und Ansichten hängt (`types.org.roles` ohne `sharer`, Kit 1.3). */
export const orgLimitedModel = defineModel((() => {
  const i = notesInput();
  return {
    ...i,
    roles: { ...i.roles, sharer: { label: 'Teiler:in', description: 'Liest Notizen, nur an Ordnern und Ansichten.', permissions: ['note:read'] } },
    types: {
      org: { label: 'Organisation', roles: ['editor', 'viewer'] },
      ...i.types,
      folder: { ...i.types.folder, roles: ['editor', 'viewer', 'sharer'] },
    },
  };
})() as never);
