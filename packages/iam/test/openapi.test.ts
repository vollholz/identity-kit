/**
 * OpenAPI-Beschreibung der Routen des Pakets (Entwurf 13.4): Tags aus `IAM_API_TAGS`, Zusammenfassungen, übliche
 * Fehlerantworten (problem+json), Ersetzungen der App (Tags, Texte, Felder), Antwort von `GET /v1/authz/catalog` ohne
 * Verlust durch die Serialisierung (auch mit den optionalen Feldern `match`, `personOnly`, `leaf` usw.).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';
import { routesOf } from '@vollholz/iam-testkit';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { authzCatalogSchema } from '../src/http/account.ts';
import { IAM_API_TAGS, optionalBodies } from '../src/http/routes.ts';
import { notesModel } from './support/models.ts';
import { skipDb } from './support/db.ts';
import { claims, notesApp, notesDb, type NotesApp } from './support/http.ts';

const skip = await skipDb();
const IAM_ROUTES = [
  'GET /v1/me', 'GET /v1/authz/catalog', 'GET /v1/account', 'POST /v1/account/organizations', 'POST /v1/signup', 'GET /v1/access', 'POST /v1/access', 'PATCH /v1/access/{id}', 'DELETE /v1/access/{id}', 'GET /v1/access/explain', 'GET /v1/access/groups',
  'POST /v1/break-glass', 'DELETE /v1/break-glass', 'PUT /v1/admin/members/{id}/clearance', 'PUT /v1/platform/organizations/{alias}/members/{id}/clearance',
  'GET /v1/admin/clients', 'PUT /v1/admin/clients/{clientId}', 'DELETE /v1/admin/clients/{clientId}',
  'GET /v1/platform/organizations/{alias}/clients', 'PUT /v1/platform/organizations/{alias}/clients/{clientId}', 'DELETE /v1/platform/organizations/{alias}/clients/{clientId}',
  'GET /v1/admin/status', 'GET /v1/admin/members', 'POST /v1/admin/members', 'PUT /v1/admin/members/{id}/roles', 'DELETE /v1/admin/members/{id}', 'POST /v1/admin/members/{id}/invitation',
  'GET /v1/platform/organizations/{alias}/members', 'POST /v1/platform/organizations/{alias}/members', 'PUT /v1/platform/organizations/{alias}/members/{id}/roles',
  'DELETE /v1/platform/organizations/{alias}/members/{id}', 'POST /v1/platform/organizations/{alias}/members/{id}/invitation',
  'GET /v1/platform/organizations', 'POST /v1/platform/organizations', 'GET /v1/platform/organizations/{alias}', 'PATCH /v1/platform/organizations/{alias}',
  'POST /v1/platform/organizations/{alias}/suspend', 'POST /v1/platform/organizations/{alias}/resume',
  ...['/v1/admin/entra', '/v1/platform/organizations/{alias}/entra'].flatMap(b => [`GET ${b}`, `DELETE ${b}`, `POST ${b}/consent`, `POST ${b}/consent/complete`, `PUT ${b}/app`, `GET ${b}/preview`, `POST ${b}/enforce`, `PUT ${b}/domains`, `POST ${b}/refresh`, `POST ${b}/consent-links`, `GET ${b}/consent-links`, `DELETE ${b}/consent-links/{id}`]),
  'POST /v1/entra/handover/info', 'POST /v1/entra/handover/start', 'POST /v1/entra/handover/complete', 'POST /v1/entra/handover/credentials',
  ...['/v1/admin/members', '/v1/platform/organizations/{alias}/members'].flatMap(b => [`GET ${b}/entra-search`, `POST ${b}/entra`]),
  'POST /v1/admin/entra/test', 'POST /v1/platform/entra/refresh',
  'GET /v1/people', 'GET /v1/people/{id}',
  ...['/v1/admin/roles', '/v1/platform/organizations/{alias}/roles'].flatMap(b => [`GET ${b}`, `POST ${b}`, `PUT ${b}/{key}`, `DELETE ${b}/{key}`]),
];

describe('OpenAPI der Routen des Pakets', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  let doc: { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, unknown> } };
  const op = (route: string) => { const [m, p] = route.split(' '); return doc.paths[p!]![m!.toLowerCase()]; };

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    n = await notesApp({ db: t.runtime, issuer: idp.issuer });
    doc = (await n.app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('alle Routen des Pakets mit Tag aus IAM_API_TAGS und Zusammenfassung; versteckte fehlen', () => {
    const iam = routesOf(doc, r => !r.includes('/folders') && !r.includes('/notes'));
    assert.deepEqual(iam.sort(), [...IAM_ROUTES].sort());
    const tags = new Set(IAM_API_TAGS.map(x => x.name));
    for (const r of IAM_ROUTES) {
      assert.equal(op(r).tags.length, 1, r);
      assert.ok(tags.has(op(r).tags[0]), `${r}: ${op(r).tags}`);
      assert.ok(op(r).summary, r);
    }
    assert.ok(!doc.paths['/v1/openapi.json'], 'versteckt');
  });

  test('optionalBodies: Swagger 2 (swaggerObject) unverändert, ohne Pfade kein Fehler (D)', () => {
    const swagger2 = { swagger: '2.0', paths: { '/x': { post: { 'x-body-optional': true } } } };
    assert.equal(optionalBodies({ swaggerObject: swagger2 }), swagger2);
    assert.deepEqual(swagger2.paths['/x'].post, { 'x-body-optional': true }, 'nicht verändert');
    assert.deepEqual(optionalBodies({ openapiObject: { openapi: '3.1.0' } }), { openapi: '3.1.0' });
    assert.equal(optionalBodies({}), undefined);
  });

  test('Modul admin: Status ohne rolesManageable und groupRolePrefix, Body von suspend/resume optional, Einladen mit 202', () => {
    const status = op('GET /v1/admin/status').responses['200'].content['application/json'].schema;
    assert.deepEqual(Object.keys(status.properties).sort(), ['canManageMembers', 'enabled', 'organization', 'platformAdmin', 'reason', 'roles']);
    for (const v of ['suspend', 'resume']) {
      const rb = op(`POST /v1/platform/organizations/{alias}/${v}`).requestBody;
      assert.equal(rb.required, false, v);
      assert.equal(rb.content['application/json'].schema.properties.reason.maxLength, 500);
      assert.equal(op(`POST /v1/platform/organizations/{alias}/${v}`)['x-body-optional'], undefined, 'Markierung entfernt');
    }
    assert.equal(op('POST /v1/admin/members').requestBody.required, true);
    assert.ok(!('sendEmail' in op('POST /v1/admin/members').requestBody.content['application/json'].schema.properties));
    assert.ok(op('POST /v1/admin/members').responses['202']);
    for (const s of ['Member', 'Organization', 'Person', 'EntraConnection', 'Client', 'AccessEntry']) assert.ok(doc.components.schemas[s], s);
    assert.ok(!doc.components.schemas.Role, 'keine eigenen Rollen');
    const member = doc.components.schemas.Member as { required: string[] };
    assert.deepEqual([...member.required].sort(), ['breakGlassUntil', 'clearance', 'clientId', 'createdAt', 'description', 'email', 'id', 'kind', 'lastSeenAt', 'loginPath', 'name', 'places', 'principalId', 'roles', 'scopes', 'status', 'username']);
    const entra = op('GET /v1/admin/entra').responses['200'].content['application/json'].schema;
    assert.ok(['consentPath', 'testPath'].every(k => entra.required.includes(k)), 'Rückkehrpfade im Status');
    assert.deepEqual(status.properties.roles.items.properties.permissions.items.enum, [...notesModel.permissions], 'Status: Rollen');
  });

  test('übliche Fehlerantworten als problem+json, auch für Routen der App', () => {
    for (const s of ['Problem', 'ValidationProblem', 'VersionConflict', 'OrganizationChoice', 'BatchProblem']) assert.ok(doc.components.schemas[s], s);
    const codes = (r: string) => Object.keys(op(r).responses).sort();
    assert.deepEqual(codes('GET /v1/me'), ['200', '400', '401', '403', '429', '500']);
    assert.deepEqual(codes('POST /v1/access'), ['201', '400', '401', '403', '409', '422', '429', '500']);
    assert.deepEqual(codes('DELETE /v1/access/{id}'), ['204', '400', '401', '403', '404', '409', '422', '429', '500']);
    assert.deepEqual(op('GET /v1/me').responses['401'].content['application/problem+json'].schema, { $ref: '#/components/schemas/Problem' });
    assert.ok(op('GET /v1/folders/{id}').responses['404'], 'Route der App');
  });

  test('Katalog: Aufzählungen aus dem Modell der App, optionale Felder optional', () => {
    const s = op('GET /v1/authz/catalog').responses['200'].content['application/json'].schema;
    const perm = s.properties.permissions.items;
    assert.deepEqual(perm.properties.key.enum, [...notesModel.permissions]);
    assert.ok(!perm.required.includes('personOnly') && perm.properties.personOnly);
    assert.ok(!s.properties.groups.items.required.includes('match') && s.properties.groups.items.properties.match);
    for (const f of ['leaf', 'classified', 'owner', 'scope', 'self', 'read', 'write']) assert.ok(!s.properties.types.items.required.includes(f) && s.properties.types.items.properties[f], f);
    assert.deepEqual(s.properties.types.items.properties.key.enum, ['org', 'folder', 'note', 'team', 'view']);
    assert.match(s.properties.mcpTools.items.properties.scope.anyOf[1].description, /Standard-Scope `notes:read`/);
  });

  test('GET /v1/authz/catalog liefert genau toJSON() (Serialisierung entfernt nichts)', async () => {
    const r = await n.app.inject({ method: 'GET', url: '/v1/authz/catalog', headers: { authorization: `Bearer ${await idp.token(claims.user({ org: 'acme' }))}` } });
    assert.deepEqual(r.json(), notesModel.toJSON());
    assert.equal(r.headers.vary, 'Accept-Language');
    assert.ok(r.json().permissions.some((p: { personOnly?: boolean }) => p.personOnly) && r.json().groups.some((g: { match?: string }) => g.match));
    assert.deepEqual(r.json().types.filter((t: { leaf?: boolean }) => t.leaf).map((t: { key: string }) => t.key), ['note'], 'Blatt nur, wo gesetzt');
  });

  test('Ersetzungen der App: Tags, Zusammenfassung, Beschreibung, Felder (Titel oder Route)', async () => {
    const x = await notesApp({
      db: t.runtime, issuer: idp.issuer, plugin: { openapi: {
        tags: { Zugriff: 'Freigaben' },
        routes: { 'GET /v1/me': { summary: 'Wer bin ich', description: 'Eigene Beschreibung', tags: ['Konto'] } },
        fields: { 'AuthzCatalog.permissions[].resources': 'Eigene Feldbeschreibung', 'ApiMe.somewhere': 'Irgendwo', 'AccessList.grantable': 'Vergebbar' },
      } },
    });
    try {
      const d = (await x.app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
      assert.deepEqual(d.paths['/v1/access'].get.tags, ['Freigaben']);
      assert.deepEqual([d.paths['/v1/me'].get.summary, d.paths['/v1/me'].get.description], ['Wer bin ich', 'Eigene Beschreibung']);
      const cat = d.paths['/v1/authz/catalog'].get.responses['200'].content['application/json'].schema;
      assert.equal(cat.properties.permissions.items.properties.resources.description, 'Eigene Feldbeschreibung');
      assert.equal(d.paths['/v1/me'].get.responses['200'].content['application/json'].schema.properties.somewhere.description, 'Irgendwo');
      assert.equal(d.paths['/v1/access'].get.responses['200'].content['application/json'].schema.anyOf[0].properties.grantable.description, 'Vergebbar');
      // Die Antwort bleibt dieselbe
      const r = await x.app.inject({ method: 'GET', url: '/v1/authz/catalog', headers: { authorization: `Bearer ${await idp.token(claims.user({ org: 'acme' }))}` } });
      assert.deepEqual(r.json(), notesModel.toJSON());
    } finally { await x.app.close(); }
  });
});

test('Schema des Katalogs serialisiert toJSON() verlustfrei', async () => {
  const app = Fastify();
  app.get('/c', { schema: { response: { 200: authzCatalogSchema(notesModel) } } }, async () => notesModel.toJSON());
  try {
    assert.deepEqual((await app.inject({ method: 'GET', url: '/c' })).json(), notesModel.toJSON());
  } finally { await app.close(); }
});
