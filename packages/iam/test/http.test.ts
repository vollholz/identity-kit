/**
 * Anmeldung und Dekorationen des Plugins über HTTP (aus Assets test/platform/auth.test.ts, produktneutral mit der
 * Beispiel-App «notes»): 401/403/400 als problem+json, Rollen nur der gewählten Organisation, DPoP (Schema, Replay,
 * DPOP_MODE), mTLS, nur Access Tokens, kodierte Pfade, ASCII-Aliasse, Sitzung mit CSRF, Herkunft `mcp`, Cookies mit
 * SESSION_SECRET, Span-Attribut, `need` als preHandler, `can` und Fähigkeiten, `readinessChecks`.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, X509Certificate } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import cookie from '@fastify/cookie';
import { context, ROOT_CONTEXT, trace, type Context, type ContextManager, type Span } from '@opentelemetry/api';
import Fastify from 'fastify';
import pg from 'pg';
import { dpopKey, startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { withTenant } from '../src/db.ts';
import { iamPlugin } from '../src/http/plugin.ts';
import { readinessChecks } from '../src/iam.ts';
import { OidcProvider, TokenVerifier } from '../src/tokens.ts';
import { notesCatalog } from './support/catalogs.ts';
import { skipDb } from './support/db.ts';
import { claims, folderWithNote, notesApp, notesDb, tenant, type NotesApp } from './support/http.ts';

const skip = await skipDb();

/** Selbstsigniertes Client-Zertifikat (P-256) aus Assets, nur für Tests. */
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBkTCCATegAwIBAgIUVAra84SoY/XHw8mEbYjqxOzH48kwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSYXNzZXRzLXRlc3QtY2xpZW50MCAXDTI2MTAyMTEzMDMwMloY
DzIxMjYwOTI3MTMwMzAyWjAdMRswGQYDVQQDDBJhc3NldHMtdGVzdC1jbGllbnQw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARqj3msJyb16jI0lsTxZM1ryKO8Dlbc
Or8LOtEnHsyhcHCUqxTt27tZ2LRweL5tFx/Ctt9lIzFb6LqDHYdNyCWso1MwUTAd
BgNVHQ4EFgQUUhOOdKO7wT+eWxlla7RcUAlH8ewwHwYDVR0jBBgwFoAUUhOOdKO7
wT+eWxlla7RcUAlH8ewwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBF
AiB+tkUCeoLTED7fht7P4vhFdvOzO5Ji2zc2h6QYvdEEIwIhAIaGprQb34f4GRVx
C4dOM4ms2lr/aSboOV9rFsASsosw
-----END CERTIFICATE-----`;

const ME = 'http://api.test/v1/me';

describe('Anmeldung über HTTP (Plugin)', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  const apps: NotesApp[] = [];
  const build = async (o: Partial<Parameters<typeof notesApp>[0]> = {}) => {
    const a = await notesApp({ db: t.runtime, issuer: idp.issuer, ...o });
    apps.push(a);
    return a;
  };
  const me = (headers: Record<string, string>, app = n.app) => app.inject({ method: 'GET', url: '/v1/me', headers });
  const bearer = async (c: Record<string, unknown>) => ({ authorization: `Bearer ${await idp.token(c)}` });

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    n = await build();
  });
  after(async () => { for (const a of apps) await a.app.close(); await idp?.close(); await t?.drop(); });

  test('ohne Token: 401 als problem+json mit WWW-Authenticate', async () => {
    const r = await me({});
    assert.equal(r.statusCode, 401);
    assert.match(r.headers['content-type'] as string, /application\/problem\+json/);
    assert.equal(r.headers['www-authenticate'], 'Bearer realm="notes", DPoP algs="ES256 PS256 RS256"');
    assert.deepEqual(r.json(), { type: 'http://api.test/probleme/401', title: 'Nicht angemeldet', status: 401, detail: 'Access Token im Authorization-Header senden.', instance: '/v1/me' });
    const x = await me({ authorization: 'Basic abc' });
    assert.deepEqual([x.statusCode, x.json().title, x.headers['www-authenticate']], [401, 'Authorization-Header ungültig', 'Bearer realm="notes", DPoP algs="ES256 PS256 RS256"']);
  });

  test('Person: Mandant aus Organisation, Rollen aus Gruppen (und Client-Rollen mit ROLE_SOURCE=both)', async () => {
    const r = await me(await bearer(claims.user({ org: 'acme', groupRoles: ['editor'] })));
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.deepEqual([b.tenant.alias, b.principal.kind, b.roles, b.tokenBinding], ['acme', 'user', ['editor'], 'none']);
    assert.ok(b.permissions.includes('note:write') && !b.permissions.includes('acl:admin'));
    const both = await build({ env: { ROLE_SOURCE: 'both' } });
    const r2 = await me(await bearer(claims.user({ org: 'acme', groupRoles: ['viewer'], roles: ['editor'] })), both.app);
    assert.deepEqual(r2.json().roles.sort(), ['editor', 'viewer']);
  });

  test('Gruppenrollen einer anderen Organisation gelten nicht', async () => {
    const c = { ...claims.user({ org: 'acme' }), groups: ['/orgs/other/org-admin'] };
    assert.deepEqual((await me(await bearer(c))).json().roles, []);
  });

  test('falsche Zielgruppe, abgelaufen, fremder Schlüssel → 401', async () => {
    for (const tok of [
      await idp.token(claims.user({ org: 'acme' }), { aud: 'other' }),
      await idp.token(claims.user({ org: 'acme' }), { expiresIn: '-2m' }),
      await idp.token(claims.user({ org: 'acme' }), { kid: 'unknown' }),
    ]) assert.equal((await me({ authorization: `Bearer ${tok}` })).statusCode, 401);
  });

  test('mehrere Organisationen: X-Tenant wählt, fremde wird verweigert, ohne Wahl 400 mit eigener Liste', async () => {
    const tok = { authorization: `Bearer ${await idp.token(claims.user({ org: ['acme', 'globex'] }))}` };
    const none = await me(tok);
    assert.deepEqual([none.statusCode, none.json().organizations], [400, ['acme', 'globex']]);
    assert.equal((await me({ ...tok, 'x-tenant': 'globex' })).json().tenant.alias, 'globex');
    assert.equal((await me({ ...tok, 'x-tenant': 'ACME' })).json().tenant.alias, 'acme', 'Gross-/Kleinschreibung egal');
    assert.equal((await me({ ...tok, 'x-tenant': 'initech' })).statusCode, 403);
  });

  test('Token ohne Organisation → 403', async () => {
    const c = claims.user({ org: 'acme' }) as Record<string, unknown>;
    delete c.organization;
    assert.equal((await me(await bearer(c))).statusCode, 403);
  });

  test('Maschinen-Client ohne DPoP wird verweigert (DPOP_MODE=required-for-clients)', async () => {
    await tenant(t.runtime, 'acme', 'importer');
    const strict = await build({ env: { DPOP_MODE: 'required-for-clients' } });
    const r = await me(await bearer(claims.client({ clientId: 'importer', org: 'acme', roles: ['editor'], scopes: ['notes:read'] })), strict.app);
    assert.equal(r.statusCode, 401);
    assert.match(r.headers['www-authenticate'] as string, /DPoP/);
    // Abgewiesen vor dem Resolver: kein Principal, keine letzten Rollen
    await tenant(t.runtime, 'acme', 'ohne-dpop');
    assert.equal((await me(await bearer(claims.client({ clientId: 'ohne-dpop', org: 'acme', roles: ['editor'], scopes: ['notes:read'] })), strict.app)).statusCode, 401);
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.principal WHERE client_id = 'ohne-dpop'")).rows[0].n, 0);
  });

  test('Maschinen-Client mit DPoP: Rechte = Rollen ∩ Scopes', async () => {
    const k = await dpopKey();
    await tenant(t.runtime, 'acme', 'importer');
    const tok = await idp.token(claims.client({ clientId: 'importer', org: 'acme', roles: ['editor'], scopes: ['notes:read'] }), { jkt: k.jkt });
    const r = await me({ authorization: `DPoP ${tok}`, dpop: await k.proof('GET', ME, tok) });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.deepEqual([b.principal.kind, b.tokenBinding, b.principal.clientId], ['client', 'dpop', 'importer']);
    assert.ok(b.permissions.includes('note:read') && !b.permissions.includes('note:write'), 'ohne Scope notes:write');
  });

  test('DPoP: falsche Methode, URL, Schlüssel, ath, Replay und Bearer-Schema werden abgelehnt', async () => {
    const k = await dpopKey(), other = await dpopKey();
    await tenant(t.runtime, 'acme', 'importer');
    const tok = await idp.token(claims.client({ clientId: 'importer', org: 'acme', roles: ['viewer'], scopes: ['notes:read'] }), { jkt: k.jkt });
    const cases: [string, Record<string, string>][] = [
      ['Methode', { authorization: `DPoP ${tok}`, dpop: await k.proof('POST', ME, tok) }],
      ['URL', { authorization: `DPoP ${tok}`, dpop: await k.proof('GET', 'http://api.test/v1/other', tok) }],
      ['Schlüssel', { authorization: `DPoP ${tok}`, dpop: await other.proof('GET', ME, tok) }],
      ['ath', { authorization: `DPoP ${tok}`, dpop: await k.proof('GET', ME, 'anderes-token') }],
      ['alt', { authorization: `DPoP ${tok}`, dpop: await k.proof('GET', ME, tok, { iat: Math.floor(Date.now() / 1000) - 3600 }) }],
      ['Bearer-Schema', { authorization: `Bearer ${tok}`, dpop: await k.proof('GET', ME, tok) }],
      ['ohne Proof', { authorization: `DPoP ${tok}` }],
    ];
    for (const [label, h] of cases) assert.equal((await me(h)).statusCode, 401, label);
    // Schema DPoP mit einem nicht gebundenen Token: kein Nachweis geprüft, also abgelehnt (auch mit DPOP_MODE=optional)
    const unbound = await idp.token(claims.user({ org: 'acme' }));
    for (const dp of [undefined, await k.proof('GET', ME, unbound)]) {
      const r = await me({ authorization: `DPoP ${unbound}`, ...(dp ? { dpop: dp } : {}) });
      assert.deepEqual([r.statusCode, r.json().title, r.headers['www-authenticate']], [401, 'Falsches Schema', 'DPoP error="invalid_token"'], 'DPoP-Schema ohne Bindung');
    }
    assert.equal((await me({ authorization: `Bearer ${unbound}` })).statusCode, 200);
    const proof = await k.proof('GET', ME, tok);
    assert.equal((await me({ authorization: `DPoP ${tok}`, dpop: proof })).statusCode, 200);
    assert.equal((await me({ authorization: `DPoP ${tok}`, dpop: proof })).statusCode, 401, 'Replay');
  });

  test('Plattform-Admin-Rolle und Principal werden gespeichert', async () => {
    const c = { ...claims.user({ org: 'acme', sub: 'fixed-sub' }), realm_access: { roles: ['platform-admin'] } };
    assert.equal((await me(await bearer(c))).statusCode, 200);
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.principal WHERE subject = 'fixed-sub'")).rows[0].n, 1);
  });

  test('öffentliche Pfade ohne Anmeldung (publicPaths), auch kodiert', async () => {
    for (const url of ['/v1/openapi.json', '/%761/openapi.json']) {
      const r = await n.app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, url);
      assert.ok(r.json().paths['/v1/me'], url);
    }
  });

  test('A3: kodierte Pfade (/%761/…) gehen durch die Anmeldung – 401 aus dem Hook wie beim normalen Pfad', async () => {
    const normal = await n.app.inject({ method: 'GET', url: '/v1/authz/catalog' });
    assert.equal(normal.statusCode, 401);
    for (const url of ['/%761/authz/catalog', '/%761/acl', '/v%31/me', '/%76%31/unbekannt?limit=1']) {
      const r = await n.app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 401, url);
      assert.equal(r.json().detail, normal.json().detail, `${url}: nicht aus dem Hook (${r.body})`);
    }
    const h = await bearer(claims.user({ org: 'acme' }));
    assert.equal((await n.app.inject({ method: 'GET', url: '/%761/me', headers: h })).json().tenant.alias, 'acme', 'erreicht dieselbe Route');
    const missing = await n.app.inject({ method: 'GET', url: '/v1/unbekannt', headers: h });
    assert.deepEqual([missing.statusCode, missing.json().title], [404, 'Nicht gefunden'], '404 erst nach der Anmeldung');
  });

  test('A4: Alias aus Claim und X-Tenant nur ASCII klein geschrieben, sonst 403 «Organisation ungültig»', async () => {
    const kelvin = 'Kcme';
    const r = await me(await bearer(claims.user({ org: kelvin })));
    assert.deepEqual([r.statusCode, r.json().title], [403, 'Organisation ungültig']);
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.tenant WHERE alias = 'kcme'")).rows[0].n, 0, 'kein Mandant «kcme» angelegt');
    const multi = { authorization: `Bearer ${await idp.token(claims.user({ org: ['kcme', 'acme'] }))}` };
    for (const h of ['a.b', 'x'.repeat(64), '-acme', 'acme/x', 'acmé']) {
      const x = await me({ ...multi, 'x-tenant': h });
      assert.deepEqual([x.statusCode, x.json().title], [403, 'Organisation ungültig'], h);
    }
  });

  test('A6: mTLS – Zertifikat als PEM (URL-kodiert) oder DER/base64, Unlesbares → 401 statt 500', async () => {
    const m = await build({ env: { MTLS_HEADER: 'X-Client-Cert' } });
    const cert = new X509Certificate(CERT_PEM);
    const der = cert.raw.toString('base64');
    await tenant(t.runtime, 'acme', 'mtls-client');
    const c = claims.client({ clientId: 'mtls-client', org: 'acme', roles: ['viewer'], scopes: ['notes:read'] });
    const tok = await idp.token({ ...c, cnf: { 'x5t#S256': createHash('sha256').update(cert.raw).digest('base64url') } });
    const call = (h?: string, token = tok) => me({ authorization: `Bearer ${token}`, ...(h !== undefined ? { 'x-client-cert': h } : {}) }, m.app);
    for (const [label, h] of [['PEM, URL-kodiert (nginx)', encodeURIComponent(CERT_PEM)], ['DER, base64 (Caddy)', der], ['RFC 9440', `:${der}:`]]) {
      const r = await call(h);
      assert.equal(r.statusCode, 200, `${label}: ${r.body}`);
      assert.equal(r.json().tokenBinding, 'mtls', label);
    }
    for (const h of ['%E0%A4%A', 'abc$', 'AAAA']) assert.deepEqual([(await call(h)).statusCode, (await call(h)).json().title], [401, 'Client-Zertifikat ungültig'], h);
    assert.equal((await call()).json().title, 'Client-Zertifikat fehlt');
    const other = await idp.token({ ...c, cnf: { 'x5t#S256': createHash('sha256').update('anderes').digest('base64url') } });
    assert.equal((await call(der, other)).json().title, 'Client-Zertifikat passt nicht zum Token');
  });

  test('A7: nur Access Tokens (typ Bearer/DPoP oder ohne typ), unbekannte Bindung (cnf) → 401', async () => {
    for (const typ of ['ID', 'Refresh', 'Logout', 42]) {
      const r = await me(await bearer({ ...claims.user({ org: 'acme' }), typ }));
      assert.deepEqual([r.statusCode, /kein Access Token/.test(r.json().detail)], [401, true], `typ ${typ}`);
    }
    for (const typ of ['Bearer', undefined]) assert.equal((await me(await bearer({ ...claims.user({ org: 'acme' }), typ }))).statusCode, 200, `typ ${typ}`);
    for (const cnf of [{ 'x5t#S512': 'x' }, {}, 'jkt']) {
      const r = await me(await bearer({ ...claims.user({ org: 'acme' }), cnf }));
      assert.deepEqual([r.statusCode, /Unbekannte Bindung/.test(r.json().detail)], [401, true], JSON.stringify(cnf));
    }
  });

  test('A8: readinessChecks nennen öffentlich nur die Prüfung; Fehlertexte nur im Log', async () => {
    const run = async (checks: ReturnType<typeof readinessChecks>) => {
      for (const c of checks) { try { await c.run(); } catch { return { check: c.name, error: c.failure }; } }
      return null;
    };
    assert.equal(await run(readinessChecks(n.iam)), null);
    const down = await build({ issuer: 'http://127.0.0.1:1/realms/notes' });
    assert.deepEqual(await run(readinessChecks(down.iam)), { check: 'anmeldedienst', error: 'Anmeldedienst nicht erreichbar oder falsch konfiguriert' });
    // Ausfall nach erfolgreicher Discovery: der Verifier arbeitet mit der bisherigen weiter, /readyz meldet den Ausfall
    let fail = false;
    const flaky = new OidcProvider(idp.issuer, async (u, init) => { if (fail) throw new TypeError('fetch failed'); return fetch(u, init); });
    const checks = readinessChecks({ db: t.runtime, verifier: new TokenVerifier(flaky, n.iam.cfg) });
    assert.equal(await run(checks), null);
    await flaky.discovery();
    fail = true;
    assert.equal((await flaky.discovery()).issuer, idp.issuer, 'Verifier: aus dem Zwischenspeicher');
    assert.deepEqual(await run(checks), { check: 'anmeldedienst', error: 'Anmeldedienst nicht erreichbar oder falsch konfiguriert' });
    const noDb = new pg.Pool({ connectionString: 'postgres://notes:x@127.0.0.1:1/notes', connectionTimeoutMillis: 500 });
    try {
      assert.deepEqual(await run(readinessChecks({ db: noDb, verifier: n.iam.verifier })), { check: 'datenbank', error: 'Datenbank nicht erreichbar' });
    } finally { await noDb.end(); }
  });

  test('Herkunft: über den MCP-Dienst «mcp» (Person und getauschtes Token), sonst «api»; im Audit', async () => {
    await tenant(t.runtime, 'acme', 'import');
    const sources = async (h: Record<string, string>) => {
      const r = await n.app.inject({ method: 'POST', url: '/v1/folders', headers: h, payload: { name: 'Herkunft' } });
      assert.equal(r.statusCode, 201, r.body);
      return (await t.inspect.query("SELECT source, client_id FROM notes.audit_log WHERE action = 'folder.created' AND resource_id = $1", [r.json().id])).rows[0];
    };
    assert.deepEqual(await sources(await bearer(claims.user({ org: 'acme', groupRoles: ['editor'] }))), { source: 'api', client_id: 'notes-platform' });
    const viaMcp = { ...claims.user({ org: 'acme', groupRoles: ['editor'] }), azp: 'notes-mcp', scope: 'openid notes:read notes:write' };
    assert.deepEqual(await sources(await bearer(viaMcp)), { source: 'mcp', client_id: 'notes-mcp' });
    const exchanged = { ...claims.client({ clientId: 'import', org: 'acme', roles: ['editor'], scopes: ['notes:read', 'notes:write'] }), azp: 'notes-mcp' };
    assert.deepEqual(await sources(await bearer(exchanged)), { source: 'mcp', client_id: 'notes-mcp' });
  });

  test('Sitzung der Oberfläche: Token aus der Sitzung, Herkunft «ui», schreibend nur mit CSRF-Token', async () => {
    const tok = await idp.token(claims.user({ org: 'acme', groupRoles: ['editor'] }));
    const s = await build({ plugin: { sessions: { accessToken: async req => (req.headers.cookie === 'sid=1' ? { token: tok, csrfOk: req.headers['x-csrf-token'] === 'ok' } : null) } } });
    assert.equal((await s.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: 'sid=1' } })).statusCode, 200);
    assert.equal((await s.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: 'sid=2' } })).statusCode, 401, 'ohne gültige Sitzung');
    const noCsrf = await s.app.inject({ method: 'POST', url: '/v1/folders', headers: { cookie: 'sid=1' }, payload: { name: 'x' } });
    assert.deepEqual([noCsrf.statusCode, noCsrf.json().title], [403, 'CSRF-Token fehlt oder ist ungültig']);
    const r = await s.app.inject({ method: 'POST', url: '/v1/folders', headers: { cookie: 'sid=1', 'x-csrf-token': 'ok' }, payload: { name: 'UI' } });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal((await t.inspect.query("SELECT source FROM notes.audit_log WHERE resource_id = $1", [r.json().id])).rows[0].source, 'ui');
  });

  test('Cookies: ohne @fastify/cookie registriert es das Plugin; schon registriert nur mit SESSION_SECRET', async () => {
    const secret = 'a'.repeat(32), env = { SESSION_SECRET: secret };
    const own = await build({ env });
    assert.ok(own.app.unsignCookie(own.app.signCookie('x')).valid, 'vom Plugin registriert, signiert');
    await build({ env, before: async app => { await app.register(cookie, { secret }); } });
    await assert.rejects(build({ env, before: async app => { await app.register(cookie, { secret: 'b'.repeat(32) }); } }), /ohne SESSION_SECRET registriert/);
    await assert.rejects(build({ env, before: async app => { await app.register(cookie); } }), /ohne SESSION_SECRET registriert/);
    // Rotation: SESSION_SECRET=NEU,ALT – die App muss mit NEU signieren und ALT noch annehmen
    const [neu, alt] = ['n'.repeat(32), 'o'.repeat(32)], rotation = { SESSION_SECRET: `${neu},${alt}` };
    await build({ env: rotation, before: async app => { await app.register(cookie, { secret: [neu, alt] }); } });
    await assert.rejects(build({ env: rotation, before: async app => { await app.register(cookie, { secret: [neu] }); } }), /ohne SESSION_SECRET registriert/, 'ALT fehlt');
    await assert.rejects(build({ env: rotation, before: async app => { await app.register(cookie, { secret: [alt, neu] }); } }), /ohne SESSION_SECRET registriert/, 'signiert mit ALT');
  });

  test('Span-Attribut iam.tenant (bzw. spanAttribute) mit dem Alias der Organisation', async () => {
    const als = new AsyncLocalStorage<Context>();
    const manager: ContextManager = {
      active: () => als.getStore() ?? ROOT_CONTEXT,
      with: (ctx, fn, thisArg, ...args) => als.run(ctx, () => fn.call(thisArg, ...args)),
      bind: (_ctx, target) => target, enable() { return this; }, disable() { return this; },
    };
    context.setGlobalContextManager(manager);
    try {
      const h = await bearer(claims.user({ org: 'acme' }));
      const seen = async (app: NotesApp) => {
        const attrs: Record<string, unknown> = {};
        const span = { setAttribute: (k: string, v: unknown) => { attrs[k] = v; return span; }, isRecording: () => true, spanContext: () => ({ traceId: '0'.repeat(31) + '1', spanId: '0'.repeat(15) + '1', traceFlags: 1 }) } as unknown as Span;
        // inject startet erst mit `then`: innerhalb des Kontexts abwarten
        await context.with(trace.setSpan(ROOT_CONTEXT, span), async () => { await me(h, app.app); });
        return attrs;
      };
      assert.deepEqual(await seen(n), { 'iam.tenant': 'acme' });
      assert.deepEqual(await seen(await build({ plugin: { spanAttribute: 'assets.tenant' } })), { 'assets.tenant': 'acme' });
    } finally { context.disable(); }
  });

  test('Fehler: Schema 422 mit Feldpfaden, problemTypeBase; eigene Fehlerbehandlung der App möglich', async () => {
    const h = await bearer(claims.user({ org: 'acme', groupRoles: ['editor'] }));
    const bad = await n.app.inject({ method: 'POST', url: '/v1/folders', headers: h, payload: { name: '' } });
    assert.equal(bad.statusCode, 422);
    assert.deepEqual(bad.json().errors.map((e: { path: string }) => e.path), ['/name']);
    const typed = await build({ plugin: { problemTypeBase: 'https://notes.example.ch/probleme/' } });
    assert.equal((await me({}, typed.app)).json().type, 'https://notes.example.ch/probleme/401');
    const own = await build({ plugin: { errorHandler: false }, before: async app => { app.setErrorHandler((err, _req, reply) => reply.status(418).send({ eigen: (err as Error).message })); } });
    assert.deepEqual([(await me({}, own.app)).statusCode, (await me({}, own.app)).json().eigen], [418, 'Nicht angemeldet: Access Token im Authorization-Header senden.']);
  });

  test('need als preHandler, can und Fähigkeiten mit einmal geladenen Zugriffsregeln', async () => {
    const A = await tenant(t.runtime, 'acme');
    const { folder, note } = await folderWithNote(t.runtime, A, 'Projekt');
    const viewer = await bearer(claims.user({ org: 'acme', groupRoles: ['viewer'] }));
    const editor = await bearer(claims.user({ org: 'acme', groupRoles: ['editor'] }));
    const nobody = await bearer(claims.user({ org: 'acme' }));
    assert.equal((await n.app.inject({ method: 'GET', url: `/v1/folders/${folder}`, headers: viewer })).json().name, 'Projekt');
    const denied = await n.app.inject({ method: 'GET', url: `/v1/folders/${folder}`, headers: nobody });
    assert.deepEqual([denied.statusCode, denied.json().detail], [403, `Dir fehlt das Recht «Notizen lesen» (note:read) für folder ${folder}.`]);
    // Ein Stand der Zugriffsregeln je Anfrage: can und Fähigkeiten laden sie gemeinsam einmal
    const load = n.iam.access.load.bind(n.iam.access);
    let loads = 0;
    n.iam.access.load = (tenantId: string) => { loads++; return load(tenantId); };
    try {
      assert.deepEqual((await n.app.inject({ method: 'GET', url: `/v1/notes/${note}`, headers: editor })).json(), { id: note, write: true, can: { write: true } });
      assert.equal(loads, 2, 'need (AccessService) und einmal für can und Fähigkeiten');
    } finally { n.iam.access.load = load; }
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query("INSERT INTO notes.acl_entry (tenant_id, resource_type, resource_id, principal_type, principal_ref, permission, effect) VALUES ($1, 'folder', $2, 'role', 'editor', 'note:write', 'deny')", [A, folder]));
    assert.deepEqual((await n.app.inject({ method: 'GET', url: `/v1/notes/${note}`, headers: editor })).json(), { id: note, write: false, can: { write: false } }, 'Verbot auf dem Ordner wirkt auf die Notiz');
    assert.equal(notesCatalog.capabilities.note!.write, 'note:write');
  });
});

test('needsToken: Präfix und öffentliche Pfade, entschieden am Routenmuster und am dekodierten Pfad', async () => {
  const { needsToken } = await import('../src/http/plugin.ts');
  const pub = (p: string) => p === '/v1/openapi.json' || p.startsWith('/v1/docs/');
  assert.equal(needsToken('/v1', pub, undefined, '/v1/me'), true);
  assert.equal(needsToken('/v1', pub, undefined, '/%761/me'), true);
  assert.equal(needsToken('/v1', pub, undefined, '/v1/openapi.json?x=1'), false);
  assert.equal(needsToken('/v1', pub, '/v1/me', '/irgendwas'), true, 'Routenmuster zählt');
  assert.equal(needsToken('/v1', pub, undefined, '/healthz'), false);
  assert.equal(needsToken('/api', pub, undefined, '/api/x'), true, 'eigenes Präfix');
  const app = Fastify();
  // Ohne Katalog mit Zugriffsregeln kein Modul acl
  const iam = { cfg: { session: { secrets: [] }, publicBaseUrl: 'http://x' }, catalog: { acl: false, product: 'x' } } as never;
  app.register(iamPlugin, { iam, modules: ['acl'] });
  await assert.rejects(async () => { await app.ready(); }, /Modul «acl» braucht Zugriffsregeln/);
});
