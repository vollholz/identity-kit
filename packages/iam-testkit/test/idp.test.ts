import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { claimsFor, dpopKey, KeycloakFake, startMockIdp, type MockIdp } from '../src/index.ts';

describe('Mock-IdP', () => {
  let idp: MockIdp;
  before(async () => { idp = await startMockIdp({ realm: 'notes', audience: 'notes-api', exchange: { clientId: 'notes-mcp', clientSecret: 's3cret' } }); });
  after(async () => { await idp.close(); });

  test('Discovery und JWKS; Token mit Standard-Zielgruppe', async () => {
    assert.match(idp.issuer, /^http:\/\/127\.0\.0\.1:\d+\/realms\/notes$/);
    const disc = await (await fetch(`${idp.issuer}/.well-known/openid-configuration`)).json() as { issuer: string; jwks_uri: string };
    assert.equal(disc.issuer, idp.issuer);
    const { payload } = await jwtVerify(await idp.token({ sub: 'p1' }), createRemoteJWKSet(new URL(disc.jwks_uri)), { issuer: idp.issuer, audience: 'notes-api' });
    assert.equal(payload.sub, 'p1');
  });

  test('Token Exchange: Zielgruppe, Scopes geschnitten, DPoP-Bindung, sendergebundene Subject Tokens abgewiesen', async () => {
    const subject = await idp.token({ sub: 'p1', scope: 'openid notes:read' }, { aud: 'notes-mcp' });
    const tokenUrl = `${idp.issuer}/protocol/openid-connect/token`;
    const call = (body: Record<string, string>, headers: Record<string, string> = {}) => fetch(tokenUrl, {
      method: 'POST', headers: { authorization: `Basic ${Buffer.from('notes-mcp:s3cret').toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: subject, audience: 'notes-api', ...body }),
    });
    const r = await (await call({ scope: 'notes:read notes:write' })).json() as { access_token: string; token_type: string };
    const c = decodeJwt(r.access_token);
    assert.deepEqual([c.aud, c.azp, c.scope, r.token_type], ['notes-api', 'notes-mcp', 'notes:read', 'Bearer']);
    const k = await dpopKey();
    const proof = await k.proof('POST', tokenUrl, 'x', { ath: undefined });
    const bound = await (await call({}, { dpop: proof })).json() as { access_token: string; token_type: string };
    assert.equal(bound.token_type, 'DPoP');
    assert.deepEqual(decodeJwt(bound.access_token).cnf, { jkt: k.jkt });
    const res = await fetch(tokenUrl, { method: 'POST', headers: { authorization: `Basic ${Buffer.from('notes-mcp:s3cret').toString('base64')}` }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: bound.access_token }) });
    assert.equal(res.status, 400);
    assert.equal(idp.exchanges, 3);
  });
});

describe('claimsFor', () => {
  const c = claimsFor({ personClientId: 'notes-platform' });
  test('Person mit Organisationen und Gruppen aus Entra, ohne Rollen', () => {
    const g = '0b6f2f7e-4c1d-4d2b-9a55-1f0c7c2d9e11';
    const p = c.user({ org: ['acme', 'globex'], groups: [g] });
    assert.equal(p.azp, 'notes-platform');
    assert.deepEqual(p.organization, ['acme', 'globex']);
    assert.deepEqual(p.groups, [g]);
    assert.ok(!('resource_access' in p), 'keine Client-Rollen');
    assert.ok(!('groups' in c.user({ org: 'acme' })), 'ohne Entra keine Gruppen');
  });
  test('Service Account', () => {
    const s = c.client({ clientId: 'acme-sync', org: 'acme', scopes: ['notes:read'] });
    assert.deepEqual([s.azp, s.preferred_username, s.scope, s.organization], ['acme-sync', 'service-account-acme-sync', 'notes:read', ['acme']]);
    assert.ok(!('resource_access' in s));
  });
});

describe('KeycloakFake', () => {
  test('Mitglieder und Admin-API mit Token', async () => {
    const kc = new KeycloakFake();
    const o = kc.org('acme'), u = kc.user('alice');
    kc.member(o, u);
    assert.ok(kc.orgMembers.get(o.id)!.has(u.id));
    const base = 'http://kc.test/admin/realms/notes';
    assert.equal((await kc.fetch(`${base}/organizations`)).status, 401, 'ohne Token');
    const tok = await (await kc.fetch('http://kc.test/realms/notes/protocol/openid-connect/token', { method: 'POST', body: 'grant_type=client_credentials' })).json() as { access_token: string };
    const orgs = await (await kc.fetch(`${base}/organizations`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json() as { alias: string }[];
    assert.deepEqual(orgs.map(x => x.alias), ['acme']);
    // Kopfzeilen sind unabhängig von der Schreibweise und als Headers-Objekt gültig (HeadersInit)
    for (const headers of [{ Authorization: `Bearer ${tok.access_token}` }, new Headers({ authorization: `Bearer ${tok.access_token}` }), [['AUTHORIZATION', `Bearer ${tok.access_token}`]] as [string, string][]]) {
      assert.equal((await kc.fetch(`${base}/organizations`, { headers })).status, 200);
    }
    kc.deny.push(/^GET \/organizations$/);
    assert.equal((await kc.fetch(`${base}/organizations`, { headers: { authorization: `Bearer ${tok.access_token}` } })).status, 403);
  });
  test('Mapper eines Identitätsanbieters (entra-groups)', async () => {
    const kc = new KeycloakFake();
    const tok = await (await kc.fetch('http://kc.test/realms/notes/protocol/openid-connect/token', { method: 'POST', body: 'grant_type=client_credentials' })).json() as { access_token: string };
    const call = (method: string, path: string, body?: unknown) => kc.fetch(`http://kc.test/admin/realms/notes${path}`, { method, headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await call('POST', '/identity-provider/instances', { alias: 'entra-001', providerId: 'microsoft', config: {} })).status, 201);
    const m = { name: 'entra-groups', identityProviderAlias: 'entra-001', identityProviderMapper: 'oidc-user-attribute-idp-mapper', config: { syncMode: 'FORCE', claim: 'groups', 'user.attribute': 'entra_groups' } };
    assert.equal((await call('POST', '/identity-provider/instances/entra-001/mappers', m)).status, 201);
    assert.equal((await call('POST', '/identity-provider/instances/entra-001/mappers', m)).status, 409);
    const list = await (await call('GET', '/identity-provider/instances/entra-001/mappers')).json() as { id: string; name: string }[];
    assert.deepEqual(list.map(x => x.name), ['entra-groups']);
    assert.equal((await call('PUT', `/identity-provider/instances/entra-001/mappers/${list[0]!.id}`, { ...m, config: { ...m.config, syncMode: 'IMPORT' } })).status, 204);
    assert.equal(kc.idpMappers.get('entra-001')![0]!.config.syncMode, 'IMPORT');
    await call('DELETE', '/identity-provider/instances/entra-001');
    assert.equal(kc.idpMappers.has('entra-001'), false);
  });
});
