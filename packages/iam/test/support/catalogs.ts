/**
 * Kataloge für die Tests: der Katalog von Assets (Fixture aus scripts/assets-catalog.ts) und ein kleiner Katalog einer
 * Notiz-App mit Zugriffsregeln.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCatalog, type AuthzCatalogJson, type CatalogInput } from '../../src/catalog.ts';

interface AssetsFixture {
  source: string;
  input: Omit<CatalogInput, 'groups'> & { groups: { key: string; label: string; match: { source: string; flags: string } }[] };
  expected: AuthzCatalogJson;
  platformJson: string;
}

export const assetsFixture = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'assets-catalog.json'), 'utf8')) as AssetsFixture;

/** Eingabe von Assets mit Stichwörtern als RegExp (wie in Assets test/platform/authz.test.ts). */
export const assetsInput = (): CatalogInput => ({ ...structuredClone(assetsFixture.input), groups: assetsFixture.input.groups.map(g => ({ ...g, match: new RegExp(g.match.source, g.match.flags) })) });

export const assetsCatalog = defineCatalog(assetsInput() as CatalogInput<string>);

/** Notiz-App: Ordner und Notizen (Blatt), Lese- und Schreib-Scope. */
export const notesInput = () => ({
  product: 'notes',
  permissions: {
    'note:read': { label: 'Notizen lesen', group: 'notes', description: 'Notizen sehen.', resources: ['tenant', 'folder', 'note'] },
    'note:write': { label: 'Notizen ändern', group: 'notes', description: 'Notizen anlegen und ändern.', resources: ['tenant', 'folder', 'note'] },
    'note:share': { label: 'Notizen teilen', group: 'notes', description: 'Notizen ausserhalb teilen.', resources: ['tenant'], scope: false as const },
  },
  groups: [{ key: 'notes', label: 'Notizen', match: 'notiz' }],
  roles: {
    editor: { label: 'Bearbeiter:in', description: 'Liest und ändert Notizen, teilt sie; Zugriff auf die Organisation.', permissions: ['tenant:read', 'note:read', 'note:write', 'note:share'] },
    viewer: { label: 'Leser:in', description: 'Liest Notizen der Organisation.', permissions: ['tenant:read', 'note:read'] },
  },
  scopes: { 'notes:read': { text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] }, 'notes:write': { text: 'Notizen ändern', permissions: ['note:write'] } },
  resources: { folder: { label: 'Ordner' }, note: { label: 'Notiz', leaf: true } },
  capabilities: { note: { write: 'note:write' } },
});
export const notesCatalog = defineCatalog(notesInput());
