// Die Liste der moved-Blöcke für Assets im README des Moduls ist genau die, die keycloak.sh gegen Keycloak prüft
// (roots/assets/moved.tf), und deckt jede Ressource von Assets infra/keycloak (fixtures/assets-3a148ae) ab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const blocks = (s: string) => [...s.matchAll(/moved \{\s*from = (\S+)\s*to\s*= (\S+)\s*\}/g)].map(m => `${m[1]} -> ${m[2]}`);

test('README › Umstellung von Assets: dieselben moved-Blöcke wie roots/assets/moved.tf und roots/assets-bootstrap', () => {
  const readme = blocks(read('../product-realm/README.md'));
  const tested = [...blocks(read('roots/assets/moved.tf')), ...blocks(read('roots/assets-bootstrap/main.tf'))];
  assert.ok(tested.length > 35);
  assert.deepEqual(readme.sort(), tested.sort());
});

test('roots/assets/moved.tf verschiebt jede Ressource von Assets infra/keycloak', () => {
  const dir = new URL('fixtures/assets-3a148ae/', import.meta.url);
  const resources = readdirSync(dir).filter(f => f.endsWith('.tf'))
    .flatMap(f => [...readFileSync(new URL(f, dir), 'utf8').matchAll(/^resource "(\w+)" "(\w+)"/gm)].map(m => `${m[1]}.${m[2]}`));
  const from = new Set(blocks(read('roots/assets/moved.tf')).map(b => b.split(' -> ')[0]!.replace(/\[.*$/, '')));
  // Seit 1.0.0 ohne Gegenstück im Modul (Rollen liegen in der App-Datenbank): Client-Rollen und Gruppe /orgs
  const removed = ['keycloak_role.platform', 'keycloak_group.orgs'];
  assert.deepEqual(resources.filter(r => !from.has(r) && !removed.includes(r)), []);
  assert.deepEqual(removed.filter(r => from.has(r)), []);
  assert.equal(resources.length, 38);
});
