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
  test('Person mit Rollengruppen der ersten Organisation', () => {
    const p = c.user({ org: ['acme', 'globex'], groupRoles: ['editor'], roles: ['viewer'] });
    assert.equal(p.azp, 'notes-platform');
    assert.deepEqual(p.organization, ['acme', 'globex']);
    assert.deepEqual(p.groups, ['/orgs/acme/editor']);
    assert.deepEqual(p.resource_access, { 'notes-platform': { roles: ['viewer'] } });
  });
  test('Service Account', () => {
    const s = c.client({ clientId: 'acme-sync', org: 'acme', roles: ['editor'], scopes: ['notes:read'] });
    assert.deepEqual([s.azp, s.preferred_username, s.scope, s.organization], ['acme-sync', 'service-account-acme-sync', 'notes:read', ['acme']]);
  });
  test('eigenes Gruppenpräfix', () => {
    assert.deepEqual(claimsFor({ personClientId: 'x', groupPrefix: '/tenants/' }).user({ org: 'a', groupRoles: ['r'] }).groups, ['/tenants/a/r']);
  });
});

describe('KeycloakFake', () => {
  test('Mitglieder, Rollengruppen und Admin-API mit Token', async () => {
    const kc = new KeycloakFake();
    const o = kc.org('acme'), u = kc.user('alice');
    kc.member(o, u, ['editor', 'c-team']);
    assert.deepEqual(kc.rolesOf(o, u), ['c-team', 'editor']);
    const base = 'http://kc.test/admin/realms/notes';
    assert.equal((await kc.fetch(`${base}/organizations`)).status, 401, 'ohne Token');
    const tok = await (await kc.fetch('http://kc.test/realms/notes/protocol/openid-connect/token', { method: 'POST', body: 'grant_type=client_credentials' })).json() as { access_token: string };
    const orgs = await (await kc.fetch(`${base}/organizations`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json() as { alias: string }[];
    assert.deepEqual(orgs.map(x => x.alias), ['acme']);
    kc.deny.push(/^GET \/organizations$/);
    assert.equal((await kc.fetch(`${base}/organizations`, { headers: { authorization: `Bearer ${tok.access_token}` } })).status, 403);
  });
  test('eigenes Gruppenpräfix', () => {
    const kc = new KeycloakFake({ groupPrefix: '/tenants' });
    const o = kc.org('acme'), u = kc.user('bob');
    kc.member(o, u, ['viewer']);
    assert.deepEqual(kc.rolesOf(o, u), ['viewer']);
    assert.ok([...kc.groups.values()].some(g => g.path === '/tenants/acme/viewer'));
  });
});
