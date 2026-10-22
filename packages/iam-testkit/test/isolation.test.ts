import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { coverageProblems, HANDLER_HEADER, idSource, leaks, normalize, openApiPath, ROUTE_HEADER, routeCollector, routesOf, unreached } from '../src/index.ts';

describe('Isolations-Durchlauf', () => {
  test('openApiPath wie @fastify/swagger', () => {
    assert.equal(openApiPath('/v1/objects/:id'), '/v1/objects/{id}');
    assert.equal(openApiPath('/v1/connections/:id/mappings/:version([a-z0-9]+)::dry-run'), '/v1/connections/{id}/mappings/{version}:dry-run');
    assert.equal(openApiPath('/v1/objects::batch'), '/v1/objects:batch');
    assert.equal(openApiPath('/v1/x/:id(^[0-9]+$)/y'), '/v1/x/{id}/y');
    assert.equal(openApiPath('/files/*'), '/files/{*}');
  });

  test('routeCollector sammelt Methoden und Pfade', () => {
    const c = routeCollector();
    let hook: ((r: { method: string | string[]; url: string }) => void) | null = null;
    c.install({ addHook: (_n, fn) => { hook = fn; } });
    hook!({ method: ['GET', 'HEAD'], url: '/v1/notes/:id' });
    hook!({ method: 'POST', url: '/v1/notes' });
    assert.deepEqual([...c.routes].sort(), ['GET /v1/notes/{id}', 'HEAD /v1/notes/{id}', 'POST /v1/notes']);
  });

  test('unreached: andere Route, keine Route, 422 aus der Schemaprüfung', () => {
    const res = (status: number, route: string | null, handler = true) => ({ status, text: '{}', headers: { ...(route ? { [ROUTE_HEADER]: route } : {}), ...(handler ? { [HANDLER_HEADER]: '1' } : {}) } });
    assert.equal(unreached(res(404, '/v1/notes/:id'), 'GET', 'GET /v1/notes/{id}'), null);
    assert.match(unreached(res(404, null), 'GET', 'GET /v1/notes/{id}')!, /erreicht \(keine\)/);
    assert.match(unreached(res(404, '/v1/other'), 'GET', 'GET /v1/notes/{id}')!, /erreicht GET \/v1\/other/);
    assert.match(unreached(res(422, '/v1/notes/:id', false), 'GET', 'GET /v1/notes/{id}')!, /Schemaprüfung/);
    assert.equal(unreached(res(422, '/v1/notes/:id', true), 'GET', 'GET /v1/notes/{id}'), null, '422 aus der Fachprüfung zählt');
  });

  test('leaks: Markierungen ohne Gross-/Kleinschreibung, IDs, erlaubte Echos', () => {
    const id = '3f2b7d0e-1111-4222-8333-944455556666';
    assert.deepEqual(leaks('{"name":"geheim-a Laptop"}', { markers: ['GEHEIM-A'] }), ['enthält «GEHEIM-A» aus Organisation A']);
    assert.deepEqual(leaks(`{"id":"${id}"}`, { markers: [], ids: [id] }), [`enthält die ID ${id} aus Organisation A`]);
    assert.deepEqual(leaks(`{"instance":"/v1/notes/${id}"}`, { markers: [], ids: [id], allowed: [id] }), []);
  });

  test('idSource: IDs von A, unbekannte IDs, eigene, fehlende', () => {
    const a = idSource({ note: 'A-NOTE' });
    assert.equal(a.ids.note, 'A-NOTE');
    assert.deepEqual([...a.used], [['note', 'A-NOTE']]);
    assert.throws(() => a.ids.folder, /ID «folder» von A fehlt/);
    const u = idSource(null, { unknown: k => (k === 'client' ? 'x-client' : 'u-' + k), own: k => (k === 'bType' ? 'B-TYPE' : undefined) });
    assert.equal(u.ids.note, 'u-note');
    assert.equal(u.ids.note, 'u-note', 'gleiche Kennung bei erneutem Zugriff');
    assert.equal(u.ids.client, 'x-client');
    assert.equal(u.ids.bType, 'B-TYPE');
  });

  test('normalize: Namen der IDs, Zeitpunkte, neue UUIDs, eigene Ersetzungen', () => {
    const used = new Map([['note', 'A-NOTE']]);
    const keep = '11111111-1111-4111-8111-111111111111';
    const text = JSON.stringify({ id: 'A-NOTE', at: '2026-10-22T10:00:00.123Z', n: '22222222-2222-4222-8222-222222222222', own: keep, secret: 'whsec_abc' });
    assert.deepEqual(normalize(text, used, { keep: [keep], replace: [[/whsec_[A-Za-z0-9]+/g, '<geheimnis>']] }), { id: '<note>', at: '<zeit>', n: '<neu>', own: keep, secret: '<geheimnis>' });
    assert.equal(normalize('kein json', new Map()), 'kein json');
  });

  test('coverageProblems: fehlend, veraltet, Ausnahmen mit Präfix', () => {
    const all = ['GET /v1/notes/{id}', 'DELETE /v1/notes/{id}', 'GET /v1/platform/organizations', 'GET /v1/openapi.json'];
    const r = coverageProblems({ all, covered: new Map([['GET /v1/notes/{id}', '1'], ['GET /v1/old', '1']]), exempt: { '/v1/platform/': 'mandantenübergreifend', '/v1/openapi.json': 'öffentlich' } });
    assert.deepEqual(r, { missing: ['DELETE /v1/notes/{id}'], stale: ['GET /v1/old'] });
  });

  test('routesOf aus OpenAPI', () => {
    assert.deepEqual(routesOf({ paths: { '/v1/notes': { get: {}, post: {} }, '/health': { get: {} } } }, r => r.includes(' /v1/')), ['GET /v1/notes', 'POST /v1/notes']);
    // Angaben auf Ebene des Pfads (OpenAPI 3.1: summary, description, servers, parameters, $ref) sind keine Operationen
    assert.deepEqual(routesOf({ paths: { '/v1/notes/{id}': { summary: 'Notiz', description: 'x', servers: [], parameters: [], $ref: '#/x', get: {}, delete: {}, trace: {} } } }), ['GET /v1/notes/{id}', 'DELETE /v1/notes/{id}', 'TRACE /v1/notes/{id}']);
  });
});
