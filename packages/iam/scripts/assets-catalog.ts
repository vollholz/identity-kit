/**
 * Erzeugt den Katalog von Assets als Fixture (test/fixtures/assets-catalog.json): die Eingabe für `defineCatalog`
 * (aus Assets `authz/permissions.ts`, `capabilities.ts`, `mcp-tools.ts`, Stichwörter aus `test/platform/authz.test.ts`)
 * und die erwartete Antwort von `GET /v1/authz/catalog` sowie `platform.json`. Pflichttest: test/catalog.test.ts.
 *
 *   node scripts/assets-catalog.ts <assets> <commit>
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, commit] = process.argv.slice(2);
if (!root || !commit) throw new Error('Aufruf: node scripts/assets-catalog.ts <assets> <commit>');
const load = (p: string) => import(pathToFileURL(join(root, p)).href);
const perm = await load('src/platform/authz/permissions.ts');
const caps = await load('src/platform/authz/capabilities.ts');
const tools = await load('src/platform/authz/mcp-tools.ts');
const platform = await load('infra/keycloak/platform.ts');

// Stichwörter je Rechtegruppe wie in Assets test/platform/authz.test.ts (A7)
const MATCH: Record<string, { source: string; flags: string }> = {
  tenant: { source: '.', flags: '' }, schemas: { source: 'schema', flags: 'i' }, objects: { source: 'objekt', flags: 'i' }, discussion: { source: 'kommentier|anh[äa]ng', flags: 'i' },
  sharing: { source: 'teil', flags: 'i' }, integrations: { source: 'verbindung', flags: 'i' }, credentials: { source: 'credential', flags: 'i' }, connectors: { source: 'konnektor', flags: 'i' },
  proposals: { source: 'prüf', flags: 'i' }, webhooks: { source: 'webhook', flags: 'i' }, access: { source: 'zugriff', flags: 'i' }, audit: { source: 'protokoll', flags: 'i' },
  members: { source: 'mitglieder', flags: 'i' }, assistant: { source: 'assistent', flags: 'i' },
};
// Nur für Personen (Kommentare in permissions.ts): in keinem Scope
const PERSON_ONLY = ['members:admin', 'connector:activate', 'assistant:use'];

const capabilities: Record<string, Record<string, string>> = {};
for (const kind of ['object', 'type', 'schema', 'connection', 'credential']) {
  const s = caps.canSchema(kind) as { properties: Record<string, { description: string }> };
  capabilities[kind] = Object.fromEntries(Object.entries(s.properties).map(([cap, p]) => [cap, /«(.+?)»/.exec(p.description)![1]!]));
}

const input = {
  product: 'assets',
  permissions: Object.fromEntries((perm.PERMISSIONS as string[]).map(k => [k, { ...perm.PERMISSION_INFO[k], ...(PERSON_ONLY.includes(k) ? { scope: false } : {}) }])),
  groups: (perm.PERMISSION_GROUPS as { key: string; label: string }[]).map(g => ({ ...g, match: MATCH[g.key] })),
  roles: perm.ROLES,
  scopes: Object.fromEntries(Object.entries(perm.SCOPES as Record<string, string[]>).map(([k, permissions]) => [k, { text: perm.SCOPE_TEXT[k], permissions }])),
  resources: Object.fromEntries((perm.RESOURCE_TYPES as string[]).map(k => [k, { label: perm.RESOURCE_LABELS[k], ...(k === 'object' ? { leaf: true } : {}) }])),
  capabilities,
  mcpTools: tools.MCP_TOOLS,
  features: { members: true, tenantSettings: true, audit: true },
};
const out = { source: `vollholz/assets ${commit} (src/platform/authz)`, input, expected: perm.authzCatalog(), platformJson: platform.platformJson() };
writeFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', 'assets-catalog.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log('Katalog geschrieben');
