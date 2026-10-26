/**
 * Fehler als application/problem+json (RFC 9457) für 401/403/404/409/412/422/428/500 und genau ein Tag je Route.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { skipDb } from './harness.ts';
import { login, testApi, type TestApi } from './api.ts';
import { apiTags, buildApp } from '../src/index.ts';
import { app as probe } from './fixture/app.ts';

const API_TAGS = apiTags(probe.modules);

const skip = await skipDb();

describe('Problem-JSON und OpenAPI', { skip }, () => {
  let api: TestApi;
  let editor: Record<string, string>, viewer: Record<string, string>;
  before(async () => {
    api = await testApi();
    editor = { authorization: (await login(api, 'demo', 'p-editor', 'editor')).authorization };
    viewer = { authorization: (await login(api, 'demo', 'p-viewer', 'viewer')).authorization };
    // Absichtlicher Fehler für 500 (nur in diesem Test)
  });
  after(async () => { await api?.close(); });

  const isProblem = (r: { statusCode: number; headers: Record<string, unknown>; json(): Record<string, unknown> }, status: number) => {
    assert.equal(r.statusCode, status);
    assert.match(String(r.headers['content-type']), /^application\/problem\+json/);
    const b = r.json();
    assert.equal(b.status, status);
    assert.equal(b.type, `http://api.test/probleme/${status}`);
    assert.equal(typeof b.title, 'string');
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    return b;
  };

  test('401, 403, 404, 409, 412, 422, 428', async () => {
    isProblem(await api.app.inject({ method: 'GET', url: '/v1/notizen' }), 401);
    isProblem(await api.app.inject({ method: 'POST', url: '/v1/notizen', headers: viewer, payload: { label: 'x' } }), 403);
    isProblem(await api.app.inject({ method: 'GET', url: '/v1/notizen/00000000-0000-4000-8000-000000000000', headers: viewer }), 404);
    isProblem(await api.app.inject({ method: 'GET', url: '/v1/gibt-es-nicht', headers: viewer }), 404);
    const v = isProblem(await api.app.inject({ method: 'POST', url: '/v1/notizen', headers: editor, payload: { label: '' } }), 422);
    assert.ok(Array.isArray(v.errors) && (v.errors as unknown[]).length > 0);
    const s = (await api.app.inject({ method: 'POST', url: '/v1/notizen', headers: editor, payload: { label: 'Doppelt' } })).json();
    isProblem(await api.app.inject({ method: 'POST', url: '/v1/notizen', headers: editor, payload: { label: 'doppelt' } }), 409);
    isProblem(await api.app.inject({ method: 'PATCH', url: `/v1/notizen/${s.id}`, headers: { ...editor, 'if-match': 'W/"9"' }, payload: { label: 'x' } }), 412);
    isProblem(await api.app.inject({ method: 'DELETE', url: `/v1/notizen/${s.id}`, headers: editor }), 428);
  });

  test('500 mit Referenz, ohne Interna', async () => {
    const app = await buildApp({ platform: probe.platform.context, cfg: api.cfg, db: api.t.runtime, iam: api.iam, ready: () => true }, { modules: [{
      name: 'kaputt', register: a => { a.get('/v1/kaputt', { schema: { tags: ['Betrieb'] } }, async () => { throw new Error('geheime Interna'); }); },
    }] });
    const r = await app.inject({ method: 'GET', url: '/v1/kaputt', headers: editor });
    const b = isProblem(r, 500);
    assert.match(String(b.detail), /^Referenz /);
    assert.ok(!r.body.includes('geheime Interna'));
    await app.close();
  });

  test('OpenAPI: jede Route genau ein bekannter Tag', async () => {
    const doc = (await api.app.inject({ method: 'GET', url: '/v1/openapi.json' })).json() as { paths: Record<string, Record<string, { tags?: string[] }>> };
    const known = new Set(API_TAGS.map(t => t.name));
    const bad: string[] = [];
    for (const [p, ops] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(ops)) if (op.tags?.length !== 1 || !known.has(op.tags[0]!)) bad.push(`${m} ${p} ${JSON.stringify(op.tags)}`);
    assert.deepEqual(bad, []);
    assert.ok(Object.keys(doc.paths).length > 20);
  });
});
