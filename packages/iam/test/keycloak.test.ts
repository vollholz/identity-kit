/**
 * Zugang zur Keycloak-Admin-API (aus Assets test/platform/admin.test.ts, «signierte Client-Assertion» und «V9»), gegen
 * die Nachbildung `KeycloakFake` des Test-Kits: Anmeldung mit private_key_jwt bzw. Geheimnis, Token wiederverwendet,
 * Admin-URL aus dem Issuer, Einladungen, Suche, Fehler als KeycloakError ohne Interna.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { importSPKI, jwtVerify } from 'jose';
import { KeycloakFake } from '@vollholz/iam-testkit';
import { ConfigError } from '../src/config.ts';
import { KeycloakAdmin, KeycloakError, keyInfo } from '../src/keycloak.ts';
import { testConfig } from './support/config.ts';

const ISSUER = 'http://idp.test/realms/notes', TOKEN = async () => `${ISSUER}/protocol/openid-connect/token`;

test('signierte Client-Assertion (RFC 7523): iss = sub = Client, aud = Issuer, kid = Thumbprint; Admin-URL aus dem Issuer', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const cfg = testConfig(ISSUER, { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_PRIVATE_KEY: pem });
  const fake = new KeycloakFake();
  fake.org('demo');
  const kca = new KeycloakAdmin(cfg, TOKEN, fake.fetch);
  assert.equal(kca.adminUrl, 'http://idp.test/admin/realms/notes');
  assert.deepEqual((await kca.listOrgs()).map(o => o.alias), ['demo']);
  await kca.listOrgs();
  assert.equal(fake.tokenRequests.length, 1, 'Token wiederverwendet');
  const f = fake.tokenRequests[0]!;
  assert.equal(f.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  assert.equal(f.get('client_secret'), null);
  const { payload, protectedHeader } = await jwtVerify(f.get('client_assertion')!, await importSPKI(publicKey.export({ format: 'pem', type: 'spki' }).toString(), 'ES256'), { issuer: 'notes-admin', audience: ISSUER });
  assert.equal(payload.sub, 'notes-admin');
  assert.ok(payload.jti && payload.exp! - payload.iat! <= 60);
  assert.equal(protectedHeader.kid, (await keyInfo(pem)).kid);
});

test('ohne Client-ID ConfigError; Admin-URL aus KEYCLOAK_MGMT_URL oder Fehler, wenn der Issuer kein Realm nennt', () => {
  assert.throws(() => new KeycloakAdmin(testConfig(ISSUER), TOKEN), ConfigError);
  const own = new KeycloakAdmin(testConfig('https://login.example/x', { KEYCLOAK_MGMT_CLIENT_ID: 'a', KEYCLOAK_MGMT_CLIENT_SECRET: 's', KEYCLOAK_MGMT_URL: 'https://admin.example/admin/realms/x/' }), TOKEN);
  assert.equal(own.adminUrl, 'https://admin.example/admin/realms/x');
  assert.throws(() => new KeycloakAdmin(testConfig('https://login.example/x', { KEYCLOAK_MGMT_CLIENT_ID: 'a', KEYCLOAK_MGMT_CLIENT_SECRET: 's' }), TOKEN), /KEYCLOAK_MGMT_URL fehlt/);
  assert.equal(new KeycloakAdmin(testConfig(ISSUER), TOKEN, fetch, { clientId: 'sync', privateKey: null, clientSecret: 's' }).adminUrl, 'http://idp.test/admin/realms/notes', 'Zugang des Abgleichs (KEYCLOAK_SYNC_*) als Parameter');
});

test('V9: Fake wie Keycloak 26 – invite-existing-user prüft das Konto vor dem Versand, Suche exakt bzw. Teiltreffer, unbekanntes Mitglied 400', async () => {
  const cfg = testConfig(ISSUER, { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'x' });
  const fake = new KeycloakFake();
  const kca = new KeycloakAdmin(cfg, TOKEN, fake.fetch);
  const o = fake.org('demo'), other = fake.org('muster');
  const ok = fake.user('ok', { email: 'ok@demo.example' }), off = fake.user('off', { email: 'off@demo.example', enabled: false });
  const noMail = fake.user('ohne', { email: undefined as unknown as string }), member = fake.user('drin', { email: 'drin@demo.example' });
  fake.user('xok', { email: 'xok@demo.example', firstName: 'Okka' });
  fake.member(o, member); fake.member(other, ok);
  // ohne SMTP: Konto geprüft (400/409) vor dem Versand (500)
  assert.deepEqual(await Promise.all([ok, off, noMail, member].map(u => kca.inviteExistingUser(o.id, u.id))), ['failed', 'refused', 'refused', 'refused']);
  assert.equal(await kca.inviteExistingUser(o.id, randomUUID()), 'refused');
  assert.equal(await kca.mailConfigured(), false);
  fake.smtp = true;
  assert.deepEqual(await Promise.all([ok, off].map(u => kca.inviteExistingUser(o.id, u.id))), ['sent', 'refused']);
  assert.equal(await kca.mailConfigured(), true);
  // Suche: Adresse exakt (kein Treffer «xok…»), search als Teiltreffer in Benutzername, Adresse, Name
  assert.equal((await kca.findUserByEmail('OK@demo.example'))!.id, ok.id);
  assert.equal(await kca.findUserByEmail('k@demo.example'), null);
  assert.deepEqual((await kca.searchUsers('ok')).map(u => u.username).sort(), ['ok', 'xok']);
  assert.deepEqual((await kca.searchUsers('okka')).map(u => u.username), ['xok']);
  // Mitglied hinzufügen mit unbekanntem Konto: 400 wie Keycloak (nicht 404)
  await assert.rejects(kca.addMember(o.id, randomUUID()), (e: unknown) => e instanceof KeycloakError && e.kcStatus === 400);
  // fail: beliebiger Status ohne Änderung; Fehler ohne Interna (Status 502 bzw. 404/409)
  fake.fail = [{ re: /^DELETE \/users\//, status: 500 }];
  await assert.rejects(kca.deleteUser(ok.id), (e: unknown) => e instanceof KeycloakError && e.kcStatus === 500 && e.status === 502);
  assert.ok(fake.users.has(ok.id));
  fake.fail = [{ re: /^GET \/organizations/, status: 403 }];
  await assert.rejects(kca.listOrgs(), (e: unknown) => e instanceof KeycloakError && /fehlt ein Recht/.test(e.detail ?? ''));
});

test('Anmeldung abgelehnt bzw. Keycloak nicht erreichbar: 502 ohne Interna', async () => {
  const cfg = testConfig(ISSUER, { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'falsch' });
  const refuse = new KeycloakAdmin(cfg, TOKEN, async () => new Response(JSON.stringify({ error: 'unauthorized_client' }), { status: 401 }));
  await assert.rejects(refuse.listOrgs(), (e: unknown) => e instanceof KeycloakError && e.status === 502 && /unauthorized_client/.test(e.detail ?? ''));
  const down = new KeycloakAdmin(cfg, TOKEN, async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(down.listOrgs(), (e: unknown) => e instanceof KeycloakError && /nicht erreichbar/.test(e.detail ?? '') && !/fetch failed/.test(e.detail ?? ''));
});
