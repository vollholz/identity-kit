// Hilfsskripte (scripts/*.ts) gegen eine Nachbildung der Keycloak-API: Anmeldung als IaC-Client mit private_key_jwt,
// Nachschlagen der Client-ID, Abgleich des Organisations-Mappers. Gegen ein echtes Keycloak: modules/test/keycloak.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;

const body = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

// Keycloak-Nachbildung: Token nur mit gültiger Client-Assertion des IaC-Clients; Admin-API nur mit diesem Token
async function fakeKeycloak(realm: string, clientId: string) {
  const mapper = { id: 'm1', name: 'organization', protocol: 'openid-connect', protocolMapper: 'oidc-organization-membership-mapper', config: { 'claim.name': 'organization', multivalued: 'false' } };
  const puts: unknown[] = [];
  const server = createServer((req, res) => void handle(req, res).catch((e: unknown) => { res.writeHead(500); res.end(String(e)); }));
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, data?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (req.method === 'POST' && url.pathname === `/realms/${realm}/protocol/openid-connect/token`) {
      const form = new URLSearchParams(await body(req));
      const [h, p, s] = form.get('client_assertion')!.split('.');
      const claims = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, string>;
      const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'));
      if (!ok || form.get('client_id') !== clientId || claims.iss !== clientId || claims.sub !== clientId || !claims.aud!.endsWith(`/realms/${realm}`)) return send(401, {});
      return send(200, { access_token: 'tok' });
    }
    if (req.headers.authorization !== 'Bearer tok') return send(401, {});
    if (url.pathname === `/admin/realms/${realm}/clients`) return send(200, url.searchParams.get('clientId') === 'realm-management' ? [{ id: 'rm-id' }] : []);
    if (url.pathname === `/admin/realms/${realm}/client-scopes`) return send(200, [{ id: 'sc', name: 'organization' }]);
    if (req.method === 'GET' && url.pathname === `/admin/realms/${realm}/client-scopes/sc/protocol-mappers/models`) return send(200, [mapper]);
    if (req.method === 'PUT' && url.pathname === `/admin/realms/${realm}/client-scopes/sc/protocol-mappers/models/m1`) {
      const m = JSON.parse(await body(req)) as typeof mapper;
      puts.push(m); mapper.config = m.config; return send(204);
    }
    send(404, {});
  }
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, puts, close: () => { server.closeAllConnections(); server.close(); } };
}

function run(name: string, env: Record<string, string>, stdin?: string) {
  // Ohne NODE_TEST_CONTEXT: sonst hielte sich das Skript für einen Teil des Testlaufs
  const { NODE_TEST_CONTEXT: _, ...inherited } = process.env;
  return new Promise<{ code: number; stdout: string; stderr: string }>((ok) => {
    const child = execFile(process.execPath, [script(name)], { env: { ...inherited, ...env } }, (err, stdout, stderr) =>
      ok({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
    child.stdin!.end(stdin ?? '');
  });
}

test('lookup.ts: meldet sich als IaC-Client an und liefert die interne ID', async () => {
  const kc = await fakeKeycloak('beispiel', 'beispiel-iac');
  try {
    const query = JSON.stringify({ client_id: 'realm-management', url: kc.url, realm: 'beispiel', iac_client_id: 'beispiel-iac' });
    const r = await run('lookup.ts', { KEYCLOAK_IAC_PRIVATE_KEY: pem }, query);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { id: 'rm-id' });
    const missing = await run('lookup.ts', { KEYCLOAK_IAC_PRIVATE_KEY: pem }, JSON.stringify({ ...JSON.parse(query), client_id: 'admin-permissions' }));
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /admin-permissions im Realm beispiel nicht gefunden/);
    const wrongClient = await run('lookup.ts', { KEYCLOAK_IAC_PRIVATE_KEY: pem }, JSON.stringify({ ...JSON.parse(query), iac_client_id: 'andere-iac' }));
    assert.match(wrongClient.stderr, /Anmeldung an Keycloak als andere-iac fehlgeschlagen: HTTP 401/);
  } finally { kc.close(); }
});

test('org-mapper.ts: gleicht nur Abweichungen ab und ist idempotent', async () => {
  const kc = await fakeKeycloak('beispiel', 'beispiel-iac');
  try {
    const env = { KEYCLOAK_IAC_PRIVATE_KEY: pem, KEYCLOAK_URL: kc.url, KEYCLOAK_REALM: 'beispiel', KEYCLOAK_IAC_CLIENT_ID: 'beispiel-iac', ORGANIZATION_MAPPER: JSON.stringify({ multivalued: 'true', addOrganizationId: 'true' }) };
    const first = await run('org-mapper.ts', env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /abgeglichen \(multivalued, addOrganizationId\)/);
    assert.deepEqual((kc.puts[0] as { config: unknown }).config, { 'claim.name': 'organization', multivalued: 'true', addOrganizationId: 'true' });
    const second = await run('org-mapper.ts', env);
    assert.match(second.stdout, /aktuell/);
    assert.equal(kc.puts.length, 1);
  } finally { kc.close(); }
});
