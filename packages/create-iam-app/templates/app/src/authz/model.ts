/**
 * Modell der App (App-eigen, Spezifikation 7.3 und 8): einzige Quelle für Rechte, Rollen, Scopes und Orte. Angelegt von
 * create-iam-app (Stufe «einfach»: nur Rollen an der Organisation); ab hier gehört die Datei der App.
 * Nach jeder Änderung: node infra/keycloak/platform.ts > infra/keycloak/platform.json
 */
import { defineModel } from '@vollholz/iam';

export const model = defineModel({
  product: '{{PRODUCT}}',
  permissions: {
    'item:read': { label: 'Einträge lesen', group: 'items', description: 'Einträge sehen.', resources: ['org'] },
    'item:write': { label: 'Einträge ändern', group: 'items', description: 'Einträge anlegen, ändern und löschen.', resources: ['org'] },
  },
  groups: [{ key: 'items', label: 'Einträge', match: 'eintr' }],
  roles: {
    editor: { label: 'Bearbeiter:in', description: 'Liest und ändert Einträge.', permissions: ['tenant:read', 'item:read', 'item:write'] },
    viewer: { label: 'Leser:in', description: 'Liest Einträge.', permissions: ['tenant:read', 'item:read'] },
  },
  scopes: {
    '{{PRODUCT}}:read': { text: 'Einträge lesen', permissions: ['tenant:read', 'item:read'] },
    '{{PRODUCT}}:write': { text: 'Einträge ändern', permissions: ['item:write'] },
  },
});
