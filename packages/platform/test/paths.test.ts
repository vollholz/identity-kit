/**
 * Kodierte Pfade (`/%761/…` erreicht dieselbe Route wie `/v1/…`): Rate-Limit und Idempotenz entscheiden am
 * Routenmuster und am dekodierten Pfad, nicht am rohen `req.url` – sonst liesse sich beides umgehen.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { skipDb } from './harness.ts';
import { login, testApi, type TestApi } from './api.ts';

const skip = await skipDb();

describe('Kodierte Pfade', { skip }, () => {
  let api: TestApi;
  let editor: Record<string, string>;
  before(async () => {
    api = await testApi({ API_RATE_LIMIT: '3', SHARED_STATE: 'memory' });
    editor = { authorization: (await login(api, 'demo', 'k-editor', 'editor')).authorization };
  });
  after(async () => { await api?.close(); });

  test('kodierter Pfad erreicht die Route der API', async () => {
    const r = await api.app.inject({ method: 'GET', url: '/%761/notizen', headers: editor });
    assert.equal(r.statusCode, 200, r.body);
  });

  test('Rate-Limit zählt kodierte Pfade mit', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await api.app.inject({ method: 'GET', url: '/%761/notizen', headers: editor })).statusCode);
    assert.ok(codes.includes(429), `erwartet 429, erhalten ${codes.join(', ')}`);
  });

  test('Idempotency-Key gilt auch für kodierte Pfade, gleich wie für den normalen Pfad', async () => {
    const other = await testApi();
    try {
      const h = { authorization: (await login(other, 'demo', 'k-idem', 'editor')).authorization, 'idempotency-key': 'kodiert-1' };
      const a = await other.app.inject({ method: 'POST', url: '/%761/notizen', headers: h, payload: { label: 'Kodiert' } });
      const b = await other.app.inject({ method: 'POST', url: '/v1/notizen', headers: h, payload: { label: 'Kodiert' } });
      assert.equal(a.statusCode, 201, a.body);
      assert.equal(b.statusCode, 201, b.body);
      assert.equal(b.headers['idempotent-replayed'], 'true');
      assert.equal(b.json().id, a.json().id);
    } finally { await other.close(); }
  });
});
