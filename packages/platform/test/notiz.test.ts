/**
 * Beispielmodul Notizen (app-boilerplate 5.7, 7): CRUD, Cursor, ETag/If-Match (412, 428), Idempotenz, Rechte
 * inklusive Scope (Rolle ∩ Scope), Klassifizierung, Audit, Ereignis in der Outbox, Job und Verlauf.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { full, skipDb } from './harness.ts';
import { login, machine, testApi, type TestApi } from './api.ts';

const skip = await skipDb();

describe('Notizen', { skip }, () => {
  let api: TestApi;
  let editor: Record<string, string>, viewer: Record<string, string>, nobody: Record<string, string>, secret: Record<string, string>;
  let tenantId: string;

  before(async () => {
    api = await testApi();
    const e = await login(api, 'demo', 'u-editor', 'editor');
    tenantId = e.tenantId;
    editor = { authorization: e.authorization };
    viewer = { authorization: (await login(api, 'demo', 'u-viewer', 'viewer')).authorization };
    nobody = { authorization: (await login(api, 'demo', 'u-nobody', null)).authorization };
    secret = { authorization: (await login(api, 'demo', 'u-secret', 'editor', { clearance: 2 })).authorization };
  });
  after(async () => { await api?.close(); });

  const call = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
    api.app.inject({ method: method as 'GET', url, headers: { ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });

  test('anlegen, lesen, ändern, löschen mit ETag', async () => {
    const c = await call('POST', '/v1/notizen', editor, { label: '  Frühschicht ', beginn: '06:00', ende: '14:00' });
    assert.equal(c.statusCode, 201, c.body);
    const s = c.json();
    assert.equal(s.label, 'Frühschicht');
    assert.deepEqual([s.beginn, s.ende, s.classification, s.version], ['06:00', '14:00', 0, 1]);
    assert.deepEqual(s.can, { write: true, delete: true });
    assert.equal(c.headers.location, `/v1/notizen/${s.id}`);
    assert.equal(c.headers.etag, 'W/"1"');

    const g = await call('GET', `/v1/notizen/${s.id}`, viewer);
    assert.equal(g.statusCode, 200);
    assert.deepEqual(g.json().can, { write: false, delete: false });

    const noIfMatch = await call('PATCH', `/v1/notizen/${s.id}`, editor, { label: 'Früh' });
    assert.equal(noIfMatch.statusCode, 428);
    assert.match(noIfMatch.headers['content-type'] as string, /application\/problem\+json/);

    const p = await call('PATCH', `/v1/notizen/${s.id}`, { ...editor, 'if-match': 'W/"1"' }, { label: 'Früh' });
    assert.equal(p.statusCode, 200, p.body);
    assert.equal(p.json().version, 2);
    assert.equal(p.headers.etag, 'W/"2"');

    const stale = await call('PATCH', `/v1/notizen/${s.id}`, { ...editor, 'if-match': 'W/"1"' }, { label: 'Alt' });
    assert.equal(stale.statusCode, 412);
    assert.equal(stale.json().currentVersion, 2);

    const unknown = await call('PATCH', `/v1/notizen/${s.id}`, { ...editor, 'if-match': 'W/"2"' }, { farbe: 'rot' });
    assert.equal(unknown.statusCode, 422, 'unbekannte Felder');

    assert.equal((await call('DELETE', `/v1/notizen/${s.id}`, { ...editor, 'if-match': 'W/"1"' })).statusCode, 412);
    assert.equal((await call('DELETE', `/v1/notizen/${s.id}`, { ...editor, 'if-match': 'W/"2"' })).statusCode, 204);
    assert.equal((await call('GET', `/v1/notizen/${s.id}`, editor)).statusCode, 404);

    const h = await call('GET', `/v1/notizen/${s.id}/history`, viewer);
    assert.equal(h.statusCode, 200);
    assert.deepEqual(h.json().items.map((v: { version: number; action: string }) => `${v.version}:${v.action}`), ['3:deleted', '2:updated', '1:created']);
  });

  test('Beginn und Ende nur gemeinsam: 422 statt Datenbankfehler, auch beim Ändern', async () => {
    const half = await call('POST', '/v1/notizen', editor, { label: 'Halb', beginn: '06:00' });
    assert.equal(half.statusCode, 422, half.body);
    assert.deepEqual(half.json().errors, [{ path: '/ende', message: 'fehlt' }]);
    const s = (await call('POST', '/v1/notizen', editor, { label: 'Paar', beginn: '06:00', ende: '14:00' })).json();
    const clear = await call('PATCH', `/v1/notizen/${s.id}`, { ...editor, 'if-match': 'W/"1"' }, { ende: null });
    assert.equal(clear.statusCode, 422, clear.body);
    const both = await call('PATCH', `/v1/notizen/${s.id}`, { ...editor, 'if-match': 'W/"1"' }, { beginn: null, ende: null });
    assert.equal(both.statusCode, 200, both.body);
    assert.deepEqual([both.json().beginn, both.json().ende], [null, null]);
  });

  test('Liste: Suche und Cursor', async () => {
    for (const label of ['Spät A', 'Spät B', 'Spät C', 'Nacht']) assert.equal((await call('POST', '/v1/notizen', editor, { label })).statusCode, 201);
    const first = (await call('GET', '/v1/notizen?q=sp%C3%A4t&limit=2', viewer)).json();
    assert.deepEqual(first.items.map((x: { label: string }) => x.label), ['Spät A', 'Spät B']);
    assert.ok(first.nextCursor);
    const second = (await call('GET', `/v1/notizen?q=sp%C3%A4t&limit=2&cursor=${first.nextCursor}`, viewer)).json();
    assert.deepEqual(second.items.map((x: { label: string }) => x.label), ['Spät C']);
    assert.equal(second.nextCursor, null);
    // Cursor einer anderen Suche
    assert.equal((await call('GET', `/v1/notizen?q=x&cursor=${first.nextCursor}`, viewer)).statusCode, 422);
    // Name eindeutig ohne Gross/klein
    assert.equal((await call('POST', '/v1/notizen', editor, { label: 'NACHT' })).statusCode, 409);
  });

  test('Rechte: Leser:in ändert nicht, ohne Rolle nichts sichtbar', async () => {
    assert.equal((await call('POST', '/v1/notizen', viewer, { label: 'Verboten' })).statusCode, 403);
    assert.equal((await call('GET', '/v1/notizen', nobody)).statusCode, 403);
    assert.equal((await call('GET', '/v1/notizen', {})).statusCode, 401);
  });

  test('Scope: Rolle ∩ Scope bei Maschinen-Clients', async () => {
    const reader = await machine(api, 'demo', 'lesesystem', 'editor', ['probe:read']);
    const writer = await machine(api, 'demo', 'schreibsystem', 'editor', ['probe:read', 'notiz:write']);
    assert.equal((await call('GET', '/v1/notizen', reader)).statusCode, 200);
    assert.equal((await call('POST', '/v1/notizen', reader, { label: 'Vom Lesesystem' })).statusCode, 403, 'Rolle editor, aber Scope nur lesen');
    const w = await call('POST', '/v1/notizen', writer, { label: 'Vom Schreibsystem' });
    assert.equal(w.statusCode, 201, w.body);
  });

  test('Klassifizierung: nur bis zur Freigabestufe sichtbar und anlegbar', async () => {
    assert.equal((await call('POST', '/v1/notizen', editor, { label: 'GL-Sonderschicht', classification: 2 })).statusCode, 403, 'über eigener Stufe');
    const c = await call('POST', '/v1/notizen', secret, { label: 'GL-Sonderschicht', classification: 2 });
    assert.equal(c.statusCode, 201, c.body);
    const id = c.json().id;
    // Innerhalb der Organisation: 403 ohne Inhalt (Entscheid des Baukastens mit Klassifizierung); fremde Organisationen
    // erhalten 404 (tenant-isolation.test.ts)
    const denied = await call('GET', `/v1/notizen/${id}`, viewer);
    assert.equal(denied.statusCode, 403);
    assert.ok(!denied.body.includes('GL-Sonderschicht'));
    assert.ok(!(await call('GET', '/v1/notizen?q=GL', viewer)).json().items.length);
    assert.equal((await call('GET', `/v1/notizen/${id}`, secret)).statusCode, 200);
  });

  test('Idempotency-Key: Wiederholung liefert dieselbe Antwort, andere Anfrage 409', async () => {
    const h = { ...editor, 'idempotency-key': 'k-1' };
    const a = await call('POST', '/v1/notizen', h, { label: 'Pikett' });
    const b = await call('POST', '/v1/notizen', h, { label: 'Pikett' });
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.equal(b.headers['idempotent-replayed'], 'true');
    assert.equal(b.json().id, a.json().id);
    assert.equal(b.headers.location, a.headers.location);
    assert.equal((await call('POST', '/v1/notizen', h, { label: 'Anders' })).statusCode, 409);
  });

  test('Audit, Ereignis und Job in derselben Transaktion; Nachtarbeit erkannt', async () => {
    const c = await call('POST', '/v1/notizen', { ...editor, 'x-request-id': 'req-nacht' }, { label: 'Probe', beginn: '22:00', ende: '06:00' });
    assert.equal(c.statusCode, 201);
    const id = c.json().id;
    const rows = await full(api.t.runtime, tenantId, async tx => ({
      audit: (await tx.query('SELECT action, source, correlation_id, actor_kind FROM probe.audit_log WHERE resource_id = $1', [id])).rows,
      events: (await tx.query('SELECT type, subject FROM probe.outbox_event WHERE subject = $1', [`notiz/${id}`])).rows,
      jobs: (await tx.query("SELECT kind, payload FROM probe.job WHERE payload->>'id' = $1", [id])).rows,
    }));
    assert.deepEqual(rows.audit, [{ action: 'notiz.created', source: 'api', correlation_id: 'req-nacht', actor_kind: 'user' }]);
    assert.deepEqual(rows.events, [{ type: 'notiz.created', subject: `notiz/${id}` }]);
    assert.deepEqual(rows.jobs.map(j => j.kind), ['notiz.nachtarbeit-pruefen']);
  });
});
