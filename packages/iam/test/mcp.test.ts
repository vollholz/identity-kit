/**
 * MCP-Dienst der App (aus Assets test/platform/mcp.test.ts und mcp-dpop.test.ts, ohne MCP-SDK und Werkzeuge – die baut
 * die App): DPoP-Schlüssel und Proofs, Token Exchange mit Nonce und Bindung, API-Aufrufe mit Proof und Nonce, und
 * `McpAuth` gegen die Beispiel-App «notes» über HTTP (Wegwerf-Datenbank, Mock-IdP mit Token Exchange). Schwerpunkte:
 * Challenge nach RFC 9728, nur Hosts aus MCP_HOST_CLIENT_IDS, gebundene Tokens abgewiesen, Organisation über X-Tenant
 * bzw. ?org= und nie eine fremde, Fehler -32602 mit der eigenen Liste, Zwischenspeicher je Token und Mandant.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, type JWK } from 'jose';
import { dpopKey, startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { ConfigError } from '../src/config.ts';
import { HttpError } from '../src/errors.ts';
import { ApiClient } from '../src/mcp/api.ts';
import { exchangeScopes, headerText, McpAuth, registerMcpAuth, type McpAuthorized } from '../src/mcp/auth.ts';
import { DpopSigner } from '../src/mcp/dpop.ts';
import { TokenExchanger } from '../src/mcp/exchange.ts';
import { OidcProvider, TokenVerifier } from '../src/tokens.ts';
import { testConfig } from './support/config.ts';
import { skipDb } from './support/db.ts';
import { claims, member, notesApp, notesDb, type NotesApp } from './support/http.ts';
import { notesModel } from './support/models.ts';

const skip = await skipDb();
const PUBLIC = 'http://mcp.test/mcp';
const EXCHANGE = { clientId: 'notes-mcp', clientSecret: 'mcp-geheim' };

describe('MCP: DPoP und Token Exchange', () => {
  test('Schlüssel aus MCP_DPOP_KEY (P-256) oder erzeugt; andere Kurven abgewiesen; Proof ohne Query, mit ath', async () => {
    const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const a = await DpopSigner.create(pem), b = await DpopSigner.create(pem);
    assert.equal(a.jkt, b.jkt, 'fester Schlüssel → gleicher Thumbprint');
    assert.equal(a.ephemeral, false);
    const c = await DpopSigner.create();
    assert.deepEqual([c.ephemeral, c.jkt === a.jkt], [true, false]);
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    await assert.rejects(DpopSigner.create(p384), ConfigError);
    await assert.rejects(DpopSigner.create('kein Schlüssel'), ConfigError);

    const proof = await a.proof('get', 'http://api.test/v1/me?x=1', 'tok');
    const h = decodeProtectedHeader(proof);
    assert.deepEqual([h.typ, h.alg, (h.jwk as JWK & { d?: string }).d], ['dpop+jwt', 'ES256', undefined], 'kein privater Anteil im Header');
    assert.equal(await calculateJwkThumbprint(h.jwk!, 'sha256'), a.jkt);
    const p = decodeJwt(proof);
    assert.deepEqual([p.htm, p.htu], ['GET', 'http://api.test/v1/me'], 'ohne Query');
    assert.ok(p.ath && p.jti && p.iat);
    assert.notEqual(decodeJwt(await a.proof('GET', 'http://api.test/v1/me', 'tok')).jti, p.jti);
  });

  describe('Token Exchange', () => {
    let idp: MockIdp, nonceIdp: MockIdp, plainIdp: MockIdp;
    before(async () => {
      idp = await startMockIdp({ realm: 'notes', audience: 'notes-api', exchange: EXCHANGE });
      nonceIdp = await startMockIdp({ realm: 'notes', audience: 'notes-api', exchange: { ...EXCHANGE, nonce: 'n-1' } });
      plainIdp = await startMockIdp({ realm: 'notes', audience: 'notes-api', exchange: { ...EXCHANGE, ignoreDpop: true } });
    });
    after(async () => { await idp?.close(); await nonceIdp?.close(); await plainIdp?.close(); });

    const exchanger = async (i: MockIdp, fetchImpl?: typeof fetch) => {
      const cfg = testConfig(i.issuer, { MCP_CLIENT_SECRET: EXCHANGE.clientSecret });
      return new TokenExchanger(cfg, new OidcProvider(cfg.oidc.issuer), { dpop: await DpopSigner.create(), model: notesModel, fetch: fetchImpl });
    };
    const subject = (i: MockIdp) => i.token({ ...claims.user({ org: 'acme' }), scope: 'openid organization notes:read' }, { aud: 'notes-mcp' });

    test('ohne Client-Anmeldung kein Exchange (ConfigError)', async () => {
      const cfg = testConfig(idp.issuer);
      assert.throws(() => new TokenExchanger(cfg, new OidcProvider(cfg.oidc.issuer), { dpop: undefined as never, model: notesModel }), ConfigError);
    });

    test('getauschtes Token an den Schlüssel gebunden; nur Scopes des Katalogs und organization; zwischengespeichert', async () => {
      const ex = await exchanger(idp);
      const sub = await subject(idp);
      const t = await ex.exchange(sub, ['openid', 'organization', 'notes:read', 'fremd:read']);
      const c = decodeJwt(t.token);
      assert.deepEqual([c.cnf, c.azp, c.scope, c.aud], [{ jkt: ex.dpop.jkt }, 'notes-mcp', 'organization notes:read', 'notes-api']);
      const n = idp.exchanges;
      assert.equal((await ex.exchange(sub, ['notes:read'])).token, t.token);
      assert.equal(idp.exchanges, n, 'aus dem Zwischenspeicher');
      ex.forget(sub);
      await ex.exchange(sub, ['notes:read']);
      assert.equal(idp.exchanges, n + 1, 'nach forget neu getauscht');
      await assert.rejects(ex.exchange(await subject(idp), ['openid', 'organization']), (e: HttpError) => e.status === 403, 'ohne Scope des Katalogs nie getauscht');
      assert.equal(idp.exchanges, n + 1);
    });

    test('Nonce des Anmeldedienstes: einmal wiederholen, danach gleich mitsenden', async () => {
      const proofs: (string | undefined)[] = [];
      const spy: typeof fetch = (input, init) => { proofs.push(decodeJwt((init?.headers as Record<string, string>).dpop!).nonce as string | undefined); return fetch(input, init); };
      const ex = await exchanger(nonceIdp, spy);
      const t = await ex.exchange(await subject(nonceIdp), ['notes:read']);
      assert.deepEqual(decodeJwt(t.token).cnf, { jkt: ex.dpop.jkt });
      assert.deepEqual(proofs, [undefined, 'n-1']);
      await ex.exchange(await subject(nonceIdp), ['notes:read']);
      assert.deepEqual(proofs, [undefined, 'n-1', 'n-1'], 'gemerkte Nonce sofort verwendet');
    });

    test('ungebundenes Token vom Anmeldedienst wird nicht verwendet (502); gebundenes Subject Token: 401', async () => {
      await assert.rejects((await exchanger(plainIdp)).exchange(await subject(plainIdp), ['notes:read']), (e: HttpError) => e.status === 502 && /kein DPoP-gebundenes Token/.test(e.detail ?? ''));
      const bound = await idp.token({ ...claims.user({ org: 'acme' }), scope: 'notes:read' }, { aud: 'notes-mcp', jkt: 'abc' });
      await assert.rejects((await exchanger(idp)).exchange(bound, ['notes:read']), (e: HttpError) => e.status === 401 && /Sender-constrained/.test(e.detail ?? ''));
    });
  });

  test('API-Aufruf: DPoP-Schema, Proof auf die öffentliche Adresse, Nonce der API einmal', async () => {
    const signer = await DpopSigner.create();
    const calls: { url: string; auth: string; proof: Record<string, unknown> }[] = [];
    let n = 0;
    const fake: typeof fetch = async (input, init) => {
      const h = init!.headers as Record<string, string>;
      calls.push({ url: String(input), auth: h.authorization!, proof: decodeJwt(h.dpop!) });
      if (n++ === 0) return new Response(JSON.stringify({ title: 'Nonce nötig' }), { status: 401, headers: { 'www-authenticate': 'DPoP error="use_dpop_nonce"', 'dpop-nonce': 'api-n1' } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const api = new ApiClient({ baseUrl: 'http://intern:8080', publicBaseUrl: 'https://notes.example.ch', token: 'tok', dpop: signer, fetch: fake });
    assert.deepEqual(await api.call('POST', '/v1/notes', { body: { a: 1 }, query: { x: '1' } }).then(r => r.body), { ok: true });
    assert.equal(calls.length, 2);
    assert.deepEqual([calls[0]!.url, calls[0]!.auth, calls[0]!.proof.htu, calls[0]!.proof.htm, calls[0]!.proof.nonce], ['http://intern:8080/v1/notes?x=1', 'DPoP tok', 'https://notes.example.ch/v1/notes', 'POST', undefined]);
    assert.equal(calls[1]!.proof.nonce, 'api-n1');
    n = 0;
    const loop: typeof fetch = async () => new Response('{}', { status: 401, headers: { 'www-authenticate': 'DPoP error="use_dpop_nonce"', 'dpop-nonce': `api-n${++n + 1}` } });
    await assert.rejects(new ApiClient({ baseUrl: 'http://intern:8080', token: 'tok', dpop: signer, fetch: loop }).get('/v1/me'), (e: { status: number }) => e.status === 401);
    assert.equal(n, 2, 'nicht endlos wiederholt');
  });

  test('headerText: nur druckbares ASCII ohne Anführungszeichen', () => {
    assert.equal(headerText('Gebundene «Tokens» – mit Umlaut ä und …\r\nNeue Zeile "x" \\'), "Gebundene 'Tokens' - mit Umlaut a und ... Neue Zeile x");
  });

  test('exchangeScopes: bei der Anmeldung gewählte Organisation ausdrücklich anfordern', () => {
    const scopes = ['openid', 'organization', 'notes:read'];
    assert.deepEqual(exchangeScopes(scopes, { organization: { acme: { id: 'o1' } } }), ['openid', 'organization:acme', 'notes:read']);
    assert.deepEqual(exchangeScopes(scopes, { organization: ['acme'] }), ['openid', 'organization:acme', 'notes:read']);
    assert.deepEqual(exchangeScopes(scopes, { organization: ['acme', 'globex'] }), scopes, 'mehrere: Wahl über X-Tenant bzw. ?org=');
    assert.deepEqual(exchangeScopes(scopes, {}), scopes);
    assert.deepEqual(exchangeScopes(scopes, { organization: ['Ungültig!'] }), scopes, 'ungültiger Alias');
  });
});

describe('MCP: McpAuth gegen die REST-API', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, api: NotesApp, mcp: FastifyInstance, auth: McpAuth, ex: TokenExchanger;
  let mcpUrl = '', apiUrl = '';
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const spy: typeof fetch = (input, init) => { seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } }); return fetch(input, init); };

  /** Token des MCP-Hosts: Zielgruppe notes-mcp, Scopes wie vom Host angefordert; Person `mcp-<rolle>` (Tupel an org). */
  const hostToken = (org: string | string[], role: string, scope: string, extra: Record<string, unknown> = {}, o: { jkt?: string } = {}) =>
    idp.token({ ...claims.user({ org, sub: `mcp-${role}` }), azp: 'notes-mcp-cli', scope, ...extra }, { aud: 'notes-mcp', ...o });
  const post = (token: string | null, o: { url?: string; headers?: Record<string, string>; method?: string } = {}) => fetch(o.url ?? mcpUrl, {
    method: o.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...o.headers },
    ...(o.method && o.method !== 'POST' ? {} : { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }),
  });

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api', exchange: EXCHANGE });
    api = await notesApp({ db: t.runtime, issuer: idp.issuer });
    for (const org of ['acme', 'globex']) for (const role of ['viewer', 'editor']) await member(t.runtime, org, `mcp-${role}`, role);
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    apiUrl = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;
    const cfg = testConfig(idp.issuer, { MCP_PUBLIC_URL: PUBLIC, MCP_API_URL: apiUrl, MCP_CLIENT_SECRET: EXCHANGE.clientSecret });
    const provider = new OidcProvider(cfg.oidc.issuer);
    ex = new TokenExchanger(cfg, provider, { dpop: await DpopSigner.create(), model: notesModel });
    auth = new McpAuth({ cfg, model: notesModel, verifier: new TokenVerifier(provider, cfg), exchanger: ex, fetch: spy });
    // MCP-Dienst der App im Kleinen: Antwort mit den Organisationen und Rechten statt MCP-Server
    mcp = Fastify();
    registerMcpAuth(mcp, auth);
    mcp.all('/mcp', async req => {
      const a: McpAuthorized = await auth.authorize(req);
      return { orgs: a.orgs.map(o => ({ alias: o.me.tenant.alias, permissions: o.me.permissions })) };
    });
    await mcp.listen({ host: '127.0.0.1', port: 0 });
    mcpUrl = `http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`;
  });
  after(async () => { await mcp?.close(); await api?.app.close(); await idp?.close(); await t?.drop(); });

  test('ohne gültiges Token: 401 mit resource_metadata (RFC 9728), JSON-RPC-Fehler; Metadaten an beiden Pfaden', async () => {
    const r = await post(null);
    assert.equal(r.status, 401);
    const wa = r.headers.get('www-authenticate') ?? '';
    assert.match(wa, /^Bearer resource_metadata="http:\/\/mcp\.test\/\.well-known\/oauth-protected-resource\/mcp", scope="openid organization:\* notes:read"$/, 'ohne error (RFC 6750)');
    assert.deepEqual(await r.json(), { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Nicht angemeldet: Access Token im Authorization-Header senden.' } });

    const wrong = await post(await idp.token(claims.user({ org: 'acme' })));
    assert.equal(wrong.status, 401, 'API-Token (falsche Zielgruppe)');
    assert.match(wrong.headers.get('www-authenticate') ?? '', /resource_metadata=.*error="invalid_token"/);

    const noScope = await post(await hostToken('acme', 'viewer', 'openid organization'));
    assert.equal(noScope.status, 403);
    assert.match(noScope.headers.get('www-authenticate') ?? '', /insufficient_scope/);

    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const m = await (await fetch(new URL(path, mcpUrl))).json() as Record<string, any>;
      assert.deepEqual([m.resource, m.authorization_servers, m.scopes_supported], [PUBLIC, [idp.issuer], ['openid', 'organization:*', 'notes:read', 'notes:write']]);
    }
  });

  test('Ursprung, Methode, Host-Client und gebundene Tokens: 403 bzw. 405 ohne Tausch', async () => {
    const n = idp.exchanges;
    const viewer = await hostToken('acme', 'viewer', 'openid organization notes:read');
    assert.equal((await post(viewer, { headers: { origin: 'http://evil.example' } })).status, 403, 'fremder Browser-Ursprung');
    assert.equal((await post(viewer, { headers: { origin: 'http://mcp.test' } })).status, 200, 'eigener Ursprung');
    const get = await post(viewer, { method: 'GET' });
    assert.deepEqual([get.status, get.headers.get('allow'), (await get.json()).error.code], [405, 'POST', -32000]);
    const foreign = await post(await hostToken('acme', 'viewer', 'openid organization notes:read', { azp: 'anderer-client' }));
    assert.equal(foreign.status, 403);
    assert.match((await foreign.json()).error.message, /MCP_HOST_CLIENT_IDS/);
    const sa = await idp.token({ ...claims.client({ clientId: 'notiz-sync', org: 'acme', scopes: ['notes:read'] }) }, { aud: 'notes-mcp' });
    assert.equal((await post(sa)).status, 403, 'Service Account');
    assert.equal(idp.exchanges, n + 1, 'nur die erlaubte Anfrage getauscht');
  });

  test('effektive Rechte über die API (Rolle ∩ Scope), API-Token an den Schlüssel gebunden und zwischengespeichert', async () => {
    seen.length = 0;
    const editor = await hostToken('acme', 'editor', 'openid organization notes:read');
    const r = await (await post(editor)).json();
    assert.deepEqual(r.orgs.map((o: any) => o.alias), ['acme']);
    assert.ok(r.orgs[0].permissions.includes('note:read') && !r.orgs[0].permissions.includes('note:write'), 'ohne notes:write kein Schreibrecht');
    const call = seen.find(s => s.url.endsWith('/v1/me'))!;
    assert.match(call.headers.authorization!, /^DPoP /);
    const apiToken = call.headers.authorization!.slice(5);
    assert.deepEqual(decodeJwt(apiToken).cnf, { jkt: ex.dpop.jkt });
    // abgegriffen ohne Schlüssel wertlos
    assert.equal((await fetch(`${apiUrl}/v1/me`, { headers: { authorization: `DPoP ${apiToken}` } })).status, 401);
    assert.equal((await fetch(`${apiUrl}/v1/me`, { headers: { authorization: `Bearer ${apiToken}` } })).status, 401);
    const n = idp.exchanges, calls = seen.length;
    await post(editor);
    assert.deepEqual([idp.exchanges, seen.length], [n, calls], 'Tausch und Rechte aus dem Zwischenspeicher');
  });

  test('mehrere Organisationen: alle laden oder über ?org= bzw. X-Tenant festlegen; fremde Organisation 403', async () => {
    const token = await hostToken(['acme', 'globex'], 'viewer', 'openid organization:* notes:read');
    assert.deepEqual((await (await post(token)).json()).orgs.map((o: any) => o.alias), ['acme', 'globex'], 'Wahl je Werkzeugaufruf');
    assert.deepEqual((await (await post(token, { url: `${mcpUrl}?org=globex` })).json()).orgs.map((o: any) => o.alias), ['globex']);
    assert.deepEqual((await (await post(token, { headers: { 'x-tenant': 'acme' } })).json()).orgs.map((o: any) => o.alias), ['acme']);
    assert.equal((await post(token, { url: `${mcpUrl}?org=initech` })).status, 403, 'Organisation, der die Person nicht angehört');
    for (const bad of [`${mcpUrl}?org=B%C3%B6se`, `${mcpUrl}?org=a%2F..`]) {
      const r = await post(token, { url: bad });
      assert.deepEqual([r.status, (await r.json()).error.code], [400, -32602], bad);
    }
    const h = await post(token, { headers: { 'x-tenant': 'ACME!' } });
    assert.equal(h.status, 400, 'X-Tenant ohne gültigen Alias');
  });

  test('API verlangt eine Wahl: -32602 mit der eigenen Liste; 401 der API verwirft das getauschte Token', async () => {
    const cfg = testConfig(idp.issuer, { MCP_PUBLIC_URL: PUBLIC, MCP_API_URL: apiUrl, MCP_CLIENT_SECRET: EXCHANGE.clientSecret });
    const provider = new OidcProvider(cfg.oidc.issuer);
    let answer: Response;
    const fake: typeof fetch = async () => answer;
    const a = new McpAuth({ cfg, model: notesModel, verifier: new TokenVerifier(provider, cfg), exchanger: ex, fetch: fake });
    const req = async (token: string) => ({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}` } });
    const token = await hostToken('acme', 'viewer', 'openid organization notes:read');
    answer = new Response(JSON.stringify({ title: 'Organisation wählen', organizations: ['acme', 'globex'] }), { status: 400 });
    const e = await a.authorize(await req(token)).catch(x => x);
    const r = a.errorResponse(e);
    assert.deepEqual([r.status, r.body.error.code, r.body.error.data], [400, -32602, { organizations: ['acme', 'globex'] }]);
    assert.match(r.body.error.message, /X-Tenant.*\?org=acme/);
    answer = new Response(JSON.stringify({ title: 'Token abgelaufen' }), { status: 401 });
    const n = idp.exchanges;
    const u = a.errorResponse(await a.authorize(await req(token)).catch(x => x));
    assert.deepEqual([u.status, u.body.error.code], [401, -32001]);
    assert.match(u.headers['WWW-Authenticate']!, /error="invalid_token"/);
    answer = new Response(JSON.stringify({ tenant: { id: 'x', alias: 'acme' }, permissions: [] }), { status: 200 });
    await a.authorize(await req(token));
    assert.equal(idp.exchanges, n + 1, 'nach 401 der API neu getauscht');
    assert.deepEqual(a.errorResponse(new Error('geheim')).body.error.message, 'Interner Fehler', '5xx ohne Interna');
  });

  test('gebundenes Token des Hosts (DPoP): 403 statt Anmeldeschleife; als Bearer gesendet 401', async () => {
    const key = await dpopKey();
    const bound = await hostToken('acme', 'viewer', 'openid organization notes:read', {}, { jkt: key.jkt });
    const n = idp.exchanges;
    const r = await post(bound, { headers: { authorization: `DPoP ${bound}`, dpop: await key.proof('POST', PUBLIC, bound) } });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error.message, /sendergebundene Tokens/);
    // Grund mit «…» im Header: auf ASCII gebracht, Challenge und JSON-RPC bleiben (sonst ERR_INVALID_CHAR)
    const bearer = await post(bound, { headers: { dpop: await key.proof('POST', PUBLIC, bound) } });
    assert.equal(bearer.status, 401, 'Bearer-Schema');
    assert.match(bearer.headers.get('www-authenticate') ?? '', /resource_metadata=.*error="invalid_token", error_description="DPoP-gebundene Tokens mit 'Authorization: DPoP \.\.\.' senden\."/);
    assert.equal((await bearer.json()).error.code, -32001);
    assert.equal(idp.exchanges, n, 'kein Tausch');
  });
});
