/**
 * Öffentliche Routen mit Token (FM-OF-21): Organisation aus dem Alias, Kontext genau dieser Organisation, Lesesicht der
 * Person des Tokens (begrenzt auf die Scopes der Route), Rate-Limit je IP, problem+json ohne Existenz-Leaks, Token nie
 * im Log. Route der Test-App: `GET /abo/notizen/<alias>.<token>.txt` (test/fixture/notiz/abo.ts).
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { isPublicPath } from '../src/core/public-paths.ts';
import { aliasToken, checkPublicRoutes, publicToken, publicTokenHash, type App, type PublicRoute } from '../src/index.ts';
import { grant, person, testApi, type TestApi } from './api.ts';
import { issueAbo } from './fixture/notiz/abo.ts';
import { app as probe } from './fixture/app.ts';
import { full, skipDb, tenant } from './harness.ts';

const skip = await skipDb();
const url = (alias: string, token: string) => `/abo/notizen/${alias}.${token}.txt`;
let ip = 0;
/** Jede Anfrage von einer eigenen Adresse (das Rate-Limit prüft ein eigener Test). */
const from = () => `10.0.${Math.floor(++ip / 250)}.${ip % 250 + 1}`;

describe('Öffentliche Routen: Prüfungen und Hilfen', () => {
  const r = (o: Partial<PublicRoute>): PublicRoute => ({ name: 'abo', url: '/abo/:x', credentials: () => null, handler: async () => null, ...o });

  test('Pfade unter /v1, /auth und Betrieb, doppelte Namen und unbekannte Scopes werden abgelehnt', () => {
    for (const u of ['/v1/abo/:x', '/auth/x', '/healthz', '/readyz', '/metrics', 'abo']) assert.throws(() => checkPublicRoutes([r({ url: u })]), /nicht erlaubt/, u);
    assert.throws(() => checkPublicRoutes([r({}), r({ url: '/b/:x' })]), /doppelt/);
    assert.throws(() => checkPublicRoutes([r({ name: 'Abo!' })]), /Name/);
    assert.throws(() => checkPublicRoutes([r({ scopes: ['gibt-es-nicht'] })], probe.platform.model.scopes), /Scope/);
    assert.doesNotThrow(() => checkPublicRoutes([r({ scopes: ['probe:read'] })], probe.platform.model.scopes));
  });

  test('Token: 256 Bit base64url, gespeichert nur als SHA-256; aliasToken trennt am ersten Punkt', () => {
    const t = publicToken();
    assert.match(t.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(t.hash, publicTokenHash(t.token));
    assert.match(t.hash, /^[0-9a-f]{64}$/);
    assert.notEqual(publicToken().token, t.token);
    assert.deepEqual(aliasToken('acme.abc.ics', { suffix: '.ics' }), { alias: 'acme', token: 'abc' });
    for (const x of ['acme.abc', '.abc.ics', 'acme.ics', undefined, 3]) assert.equal(aliasToken(x, { suffix: '.ics' }), null, String(x));
  });
});

describe('Öffentliche Route über die API', { skip }, () => {
  let api: TestApi;
  let A: string, B: string, pA: string, token: string;
  const get = (u: string, address = from()) => api.app.inject({ method: 'GET', url: u, remoteAddress: address });

  before(async () => {
    api = await testApi();
    A = await tenant(api.t.runtime, 'acme'); B = await tenant(api.t.runtime, 'globex');
    pA = await person(api, A, 'u-a', 0);
    await grant(api, A, `user:${pA}`, 'editor');
    await full(api.t.runtime, A, tx => tx.query("INSERT INTO probe.notiz (tenant_id, label, classification) VALUES ($1, 'Offen', 0), ($1, 'Vertraulich', 2)", [A]));
    await full(api.t.runtime, B, tx => tx.query("INSERT INTO probe.notiz (tenant_id, label) VALUES ($1, 'Fremd')", [B]));
    token = await full(api.t.runtime, A, tx => issueAbo(tx, pA));
  });
  after(async () => { await api?.close(); });

  test('liefert die Notizen der Organisation in der Lesesicht der Person (Freigabestufe gilt), nicht zwischenspeicherbar', async () => {
    const r = await get(url('acme', token));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.body, 'Offen');
    assert.match(String(r.headers['content-type']), /^text\/plain/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    // Alias wie bei der Anmeldung ohne Gross/Klein
    assert.equal((await get(url('ACME', token))).body, 'Offen');
  });

  test('ohne Rechte: leer; Person entfernt: wie unbekannt', async () => {
    const pN = await person(api, A, 'u-ohne', 2);
    const t = await full(api.t.runtime, A, tx => issueAbo(tx, pN));
    const r = await get(url('acme', t));
    assert.deepEqual([r.statusCode, r.body], [200, '']);
    await full(api.t.runtime, A, tx => tx.query('UPDATE probe.principal SET removed_at = now() WHERE id = $1', [pN]));
    assert.equal((await get(url('acme', t))).statusCode, 404);
  });

  test('keine Existenz-Leaks: Format, Organisation, Token, fremde Organisation und gesperrte Organisation ergeben dieselbe Antwort', async () => {
    const bad = publicToken().token;
    const cases = [
      url('acme', bad), url('globex', token), url('unbekannt', token), url('acme', 'kurz'), url('ac%C3%A9me', token),
      `/abo/notizen/acme.${token}.ics`, `/abo/notizen/acme${token}.txt`, url('acme', `${token}x`),
      // Schema verletzt (datei länger als 200): Validierung vor der Route, gleiche Antwort ohne Token
      url('acme', `${token}${'x'.repeat(160)}`),
    ];
    const bodies = new Set<string>();
    for (const u of cases) {
      const r = await get(u);
      assert.equal(r.statusCode, 404, `${u}: ${r.body}`);
      assert.match(String(r.headers['content-type']), /^application\/problem\+json/, u);
      assert.ok(!r.body.includes(token), `${u}: Token nicht in der Antwort`);
      bodies.add(r.body);
    }
    assert.equal(bodies.size, 1, [...bodies].join('\n'));
    assert.deepEqual(JSON.parse([...bodies][0]!), { type: 'http://api.test/probleme/404', title: 'Nicht gefunden', status: 404, detail: 'Der Link ist ungültig oder nicht mehr aktiv.', instance: '/abo/notizen/:datei' });

    const d = { admin: new pg.Pool({ connectionString: api.t.adminUrl, max: 1 }), runtime: api.t.runtime };
    await probe.tenants.suspend(d, 'acme', 'Test');
    try {
      const r = await get(url('acme', token));
      assert.deepEqual([r.statusCode, r.body], [404, [...bodies][0]]);
    } finally { await probe.tenants.resume(d, 'acme'); await d.admin.end(); }
    assert.equal((await get(url('acme', token))).statusCode, 200);
  });

  test('Kontext genau einer Organisation: das Token einer Organisation gilt nur dort', async () => {
    // Gleiches Token in B für eine Person von B: jede Organisation findet nur ihren eigenen Eintrag
    const pB = await person(api, B, 'u-b', 0);
    await grant(api, B, `user:${pB}`, 'viewer');
    await full(api.t.runtime, B, tx => tx.query('INSERT INTO probe.notiz_abo (tenant_id, principal_id, token_hash) VALUES ($1, $2, $3)', [B, pB, publicTokenHash(token)]));
    assert.equal((await get(url('globex', token))).body, 'Fremd');
    assert.equal((await get(url('acme', token))).body, 'Offen');
  });

  test('Rate-Limit je IP und Route (auch ausserhalb von /v1)', async () => {
    const address = '192.0.2.77';
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await get(url('acme', i % 2 ? token : publicToken().token), address)).statusCode);
    assert.deepEqual(codes.slice(0, 5), [404, 200, 404, 200, 404]);
    assert.deepEqual(codes.slice(5), [429, 429]);
    const limited = await get(url('acme', token), address);
    assert.equal(limited.statusCode, 429);
    assert.match(String(limited.headers['content-type']), /^application\/problem\+json/);
    assert.equal(limited.headers['cache-control'], 'no-store');
    assert.ok(!limited.body.includes(token), limited.body);
    assert.equal(limited.json().instance, '/abo/notizen/:datei');
    assert.equal((await get(url('acme', token), '192.0.2.78')).statusCode, 200, 'andere IP zählt eigen');
  });

  test('Telemetrie erkennt die Pfade (Spuren entfallen), auch kodiert und mit Abfrage; andere nicht', () => {
    for (const u of [url('acme', token), `${url('acme', token)}?x=1`, '/abo/notizen/acme%2Ex.txt']) assert.ok(isPublicPath(u), u);
    for (const u of ['/abo/notizen', '/abo/notizen/a/b', '/v1/notizen', '/healthz', undefined]) assert.ok(!isPublicPath(u), String(u));
  });

  test('in der OpenAPI ohne Anmeldung (security: [])', () => {
    const doc = api.app.swagger() as { paths: Record<string, Record<string, { security?: unknown[] }>> };
    assert.deepEqual(doc.paths['/abo/notizen/{datei}']?.get?.security, []);
  });
});

describe('Öffentliche Route: Token nie im Log', { skip }, () => {
  let api: TestApi, app: App;
  const lines: string[] = [];

  before(async () => {
    api = await testApi();
    const parts = await probe.createApi(api.cfg, api.t.runtime, {
      fastify: { logger: { level: 'info', stream: new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }) } },
    });
    app = parts.app;
    await app.ready();
  });
  after(async () => { await app?.close(); await api?.close(); });

  test('Anfrage mit Routenmuster statt URL protokolliert', async () => {
    const A = await tenant(api.t.runtime, 'acme');
    const pA = await person(api, A, 'u-log', 0);
    const token = await full(api.t.runtime, A, tx => issueAbo(tx, pA));
    assert.equal((await app.inject({ method: 'GET', url: url('acme', token) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: url('acme', publicToken().token) })).statusCode, 404);
    assert.ok(lines.some(l => l.includes('/abo/notizen/:datei')), lines.join(''));
    assert.ok(!lines.some(l => l.includes(token) || l.includes('acme.')), lines.join(''));
  });
});
