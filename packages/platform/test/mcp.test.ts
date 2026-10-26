/**
 * MCP-Dienst (app-boilerplate 5.10): Metadaten (RFC 9728), 401 mit Challenge, Token Exchange zur API mit
 * DPoP, Werkzeuge aus dem Modell nur mit Recht, Aufrufe über die REST-API mit Mandantentrennung.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import type { FastifyInstance } from 'fastify';
import { app } from './fixture/app.ts';
import { skipDb } from './harness.ts';
import { claims, login, testApi, type TestApi } from './api.ts';

const skip = await skipDb();
const freePort = () => new Promise<number>(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

describe('MCP-Dienst', { skip }, () => {
  let api: TestApi, idp: MockIdp, mcp: FastifyInstance;
  let base = '';

  before(async () => {
    idp = await startMockIdp({ audience: 'probe-mcp', realm: 'probe', exchange: { clientId: 'probe-mcp', clientSecret: 'mcp-geheim' } });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    api = await testApi({ PUBLIC_BASE_URL: base }, { idp });
    await api.app.listen({ host: '127.0.0.1', port });
    const cfg = app.loadConfig({ NODE_ENV: 'test', OIDC_ISSUER_URL: idp.issuer, PUBLIC_BASE_URL: base, MCP_API_URL: base, MCP_PUBLIC_URL: 'http://mcp.test/mcp', MCP_CLIENT_SECRET: 'mcp-geheim', DPOP_MODE: 'optional', LOG_LEVEL: 'silent' }, 'mcp');
    mcp = (await app.buildMcp(cfg, { logger: false })).app;
    await mcp.ready();
    // Daten: eine Notiz in demo, eine in andere
    const anna = await login(api, 'demo', 'mcp-anna', 'viewer');
    const editor = await login(api, 'demo', 'mcp-editor', 'editor');
    const other = await login(api, 'andere', 'mcp-other', 'editor');
    void anna;
    assert.equal((await api.app.inject({ method: 'POST', url: '/v1/notizen', headers: { authorization: editor.authorization }, payload: { label: 'Spätschicht' } })).statusCode, 201);
    assert.equal((await api.app.inject({ method: 'POST', url: '/v1/notizen', headers: { authorization: other.authorization }, payload: { label: 'Fremdschicht' } })).statusCode, 201);
  });
  after(async () => { await mcp?.close(); await api?.close(); await idp?.close(); });

  const hostToken = (sub: string, org: string) => idp.token({ ...claims.user({ sub, org }), azp: 'probe-mcp-cli', scope: 'openid profile organization probe:read' });
  const rpc = async (token: string | null, method: string, params: Record<string, unknown> = {}) => mcp.inject({
    method: 'POST', url: '/mcp', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });

  test('Metadaten (RFC 9728) und 401 mit Challenge', async () => {
    const m = await mcp.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
    assert.equal(m.statusCode, 200);
    assert.equal(m.json().resource, 'http://mcp.test/mcp');
    const r = await rpc(null, 'tools/list');
    assert.equal(r.statusCode, 401);
    assert.match(String(r.headers['www-authenticate']), /resource_metadata=/);
  });

  test('Werkzeuge mit Recht; Aufruf über die API zeigt nur die eigene Organisation', async () => {
    const token = await hostToken('mcp-anna', 'demo');
    const list = await rpc(token, 'tools/list');
    assert.equal(list.statusCode, 200, list.body);
    const tools = list.json().result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    assert.deepEqual(tools.map(t => t.name).sort(), ['get_notiz', 'list_notizen']);
    assert.ok(tools.every(t => t.annotations?.readOnlyHint === true));
    const call = await rpc(token, 'tools/call', { name: 'list_notizen', arguments: {} });
    assert.equal(call.statusCode, 200, call.body);
    const text = call.json().result.content[0].text as string;
    assert.match(text, /Spätschicht/);
    assert.ok(!text.includes('Fremdschicht'));
    assert.ok(idp.exchanges >= 1, 'Token Exchange');
  });

  test('ohne Recht keine Werkzeuge; fremde Hosts abgewiesen', async () => {
    await login(api, 'demo', 'mcp-niemand', null);
    const none = await rpc(await hostToken('mcp-niemand', 'demo'), 'tools/list');
    assert.equal(none.statusCode, 200, none.body);
    assert.deepEqual(none.json().result.tools, []);
    const foreignHost = await idp.token({ ...claims.user({ sub: 'mcp-anna', org: 'demo' }), azp: 'irgendein-client', scope: 'openid organization probe:read' });
    assert.equal((await rpc(foreignHost, 'tools/list')).statusCode, 403);
  });
});
