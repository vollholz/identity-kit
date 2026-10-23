/**
 * Modul `entra`, Kit 0.3: Verbinden mit einer eigenen App der Organisation in ihrem Tenant (Spezifikation 9.4; aus
 * Assets #22 «Eigene App»). Ohne App der Plattform (ENTRA_CLIENT_ID fehlt), mit ENCRYPTION_KEYS. Gegen
 * Wegwerf-Datenbank, Mock-IdP, `KeycloakFake` und `EntraFake` (App-Registrierungen je Tenant).
 * Schwerpunkte: Prüfung bei Microsoft vor dem Speichern (falsches Geheimnis, App eines anderen Tenants, fehlende
 * Berechtigung, abgelaufen), Geheimnis nur verschlüsselt (nie in Antwort oder Protokoll), Anbieter `entra-app-<alias>`,
 * Wechsel des Geheimnisses, Ablauf aus Graph, Personensuche mit der eigenen App, Link «Credentials eintragen»,
 * Rotation der Hauptschlüssel, Wechsel zur App der Plattform nur über Trennen.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { EntraFake, KeycloakFake, startMockIdp, type FakeApp, type FakeOrg, type FakeTenant, type FakeUser, type MockIdp } from '@vollholz/iam-testkit';
import { parseEncryptionKeys } from '../src/config.ts';
import { withTenant } from '../src/db.ts';
import { decryptAppSecret, rewrapEntraSecrets } from '../src/entra.ts';
import { skipDb } from './support/db.ts';
import { claims, notesApp, notesDb, type NotesApp } from './support/http.ts';

const skip = await skipDb();
type Res = { status: number; body: any };
const KEY1 = `k1:${randomBytes(32).toString('base64')}`;
const ENTRA = { ENTRA_CLIENT_ID: '11111111-2222-3333-4444-555555555555', ENTRA_CLIENT_SECRET: 'entra-geheim' };

describe('Eigene App der Organisation', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, app: NotesApp, withPlatform: NotesApp, noKeys: NotesApp;
  const kc = new KeycloakFake();
  const ms = new EntraFake();
  const u = {} as Record<'anna' | 'bea' | 'mona' | 'paula', FakeUser>;
  let annaOid: string, beaOid: string;
  let demo: FakeOrg, contoso: FakeTenant, muster: FakeTenant, fremd: FakeTenant, own: FakeApp;

  const person = (x: FakeUser, org: string, roles: string[], extra: Record<string, unknown> = {}) =>
    idp.token({ ...claims.user({ sub: x.id, org, groupRoles: roles, email: x.email, name: `${x.firstName} ${x.lastName}` }), ...extra });
  async function call(who: string | Promise<string> | null, method: string, url: string, body?: unknown, a = app): Promise<Res> {
    const r = await a.app.inject({ method: method as 'GET', url, headers: who ? { authorization: `Bearer ${await who}` } : {}, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const anna = () => person(u.anna, 'demo', ['org-admin']);
  const mona = () => person(u.mona, 'muster', ['org-admin']);
  const auditOf = async (alias: string, action: string) => (await t.inspect.query<{ data: any; actor_name: string }>(
    'SELECT a.data, a.actor_name FROM notes.audit_log a JOIN notes.tenant t ON t.id = a.tenant_id WHERE t.alias = $1 AND a.action = $2 ORDER BY a.seq', [alias, action])).rows;
  const connRow = async (alias: string) => (await t.inspect.query("SELECT c.* FROM notes.entra_connection c JOIN notes.tenant t ON t.id = c.tenant_id WHERE t.alias = $1", [alias])).rows[0];
  const putApp = (body: Record<string, unknown>, who = anna(), a = app) => call(who, 'PUT', '/v1/admin/entra/app', body, a);

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    demo = kc.org('demo', 'Demo AG'); const m = kc.org('muster', 'Muster GmbH'); const ops = kc.org('ops', 'Betrieb');
    demo.domains = []; m.domains = [];
    u.anna = kc.user('anna', { email: 'anna@demo.example', firstName: 'Anna', lastName: 'Admin' });
    u.bea = kc.user('bea', { email: 'bea@demo.example', firstName: 'Bea', lastName: 'Beispiel' });
    u.mona = kc.user('mona', { email: 'mona@muster.example', firstName: 'Mona', lastName: 'Muster' });
    u.paula = kc.user('paula', { email: 'paula@ops.example', firstName: 'Paula', lastName: 'Plattform' });
    kc.member(demo, u.anna, ['org-admin']); kc.member(demo, u.bea, ['viewer']); kc.member(m, u.mona, ['org-admin']); kc.member(ops, u.paula, ['org-admin']);
    for (const alias of ['demo', 'muster', 'ops']) for (const r of ['org-admin', 'viewer']) kc.groupPath(`/orgs/${alias}/${r}`);
    contoso = ms.tenant('Demo AG (Entra)', ['demo.example', 'demoag.onmicrosoft.com']);
    annaOid = ms.user(contoso, 'anna@demo.example').id;
    beaOid = ms.user(contoso, 'bea@demo.example').id;
    ms.user(contoso, 'anton@demo.example', { displayName: 'Anton Andres' });
    muster = ms.tenant('Muster (Entra)', ['muster.example']);
    ms.user(muster, 'mona@muster.example');
    fremd = ms.tenant('Fremd AG', ['fremd.example']);
    own = ms.app(contoso);
    const base = { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' };
    const mk = (env: Record<string, string>) => notesApp({ db: t.runtime, issuer: idp.issuer, env, keycloakFetch: kc.fetch, entraFetch: ms.fetch, entraRetryMs: [0] });
    app = await mk({ ...base, ENCRYPTION_KEYS: KEY1 });
    withPlatform = await mk({ ...base, ENCRYPTION_KEYS: KEY1, ...ENTRA });
    noKeys = await mk(base);
    for (const tok of [anna(), mona(), person(u.paula, 'ops', ['org-admin'], { realm_access: { roles: ['platform-admin'] } })]) ok(await call(tok, 'GET', '/v1/me'));
  });
  after(async () => { for (const a of [app, withPlatform, noKeys]) await a?.app.close(); await idp?.close(); await t?.drop(); });

  test('Status ohne ENTRA_CLIENT_ID: nur «eigene App», mit Redirect-URI der Organisation und Berechtigungen; ohne ENCRYPTION_KEYS keiner', async () => {
    const s = ok(await call(anna(), 'GET', '/v1/admin/entra'));
    assert.deepEqual([s.enabled, s.methods, s.ownAppReason, s.connection], [false, { platformApp: false, ownApp: true }, null, null]);
    assert.equal(s.ownApp.redirectUri, `${idp.issuer}/broker/entra-app-demo/endpoint`);
    assert.deepEqual(s.ownApp.permissions.map((p: any) => `${p.type}:${p.name}${p.optional ? '?' : ''}`), ['Delegated:User.Read', 'Application:Organization.Read.All', 'Application:User.Read.All', 'Application:Application.Read.All?']);
    assert.ok(s.ownApp.permissions.every((p: any) => p.why));
    const n = ok(await call(anna(), 'GET', '/v1/admin/entra', undefined, noKeys));
    assert.deepEqual([n.methods.ownApp, n.ownApp], [false, null]);
    const r = await putApp({ tenant: contoso.id, clientId: own.clientId, clientSecret: own.secret }, anna(), noKeys);
    assert.deepEqual([r.status, r.body.reason], [503, 'encryption-missing']);
    const c = await call(anna(), 'POST', '/v1/admin/entra/consent', { tenant: contoso.id });
    assert.deepEqual([c.status, c.body.reason], [409, 'platform-app-disabled'], 'Zustimmung ohne App der Plattform');
  });

  test('Prüfung bei Microsoft vor dem Speichern: falsches Geheimnis, App eines anderen Tenants, fehlende Berechtigung, abgelaufen, Tenant unbekannt → nichts angelegt', async () => {
    const fail = async (body: Record<string, unknown>, status: number, reason: string | null, why: string) => {
      const r = await putApp(body);
      assert.deepEqual([r.status, r.body.reason ?? null], [status, reason], `${why}: ${JSON.stringify(r.body)}`);
      return r.body;
    };
    await fail({ tenant: contoso.id, clientId: own.clientId, clientSecret: 'falsch' }, 409, 'invalid-secret', 'falsches Geheimnis');
    const other = ms.app(fremd);
    await fail({ tenant: contoso.id, clientId: other.clientId, clientSecret: other.secret }, 409, 'wrong-tenant', 'App eines anderen Tenants');
    const weak = ms.app(contoso, { roles: ['User.Read.All'] });
    const b = await fail({ tenant: 'demo.example', clientId: weak.clientId, clientSecret: weak.secret }, 409, 'missing-permissions', 'Berechtigung fehlt');
    assert.deepEqual(b.missing, ['Organization.Read.All']);
    const none = ms.app(contoso, { roles: [] });
    assert.deepEqual((await fail({ tenant: contoso.id, clientId: none.clientId, clientSecret: none.secret }, 409, 'missing-permissions', 'ohne Administratorzustimmung')).missing, ['Organization.Read.All', 'User.Read.All']);
    const old = ms.app(contoso, { expired: true });
    await fail({ tenant: contoso.id, clientId: old.clientId, clientSecret: old.secret }, 409, 'secret-expired', 'abgelaufen');
    await fail({ tenant: 'gibt-es-nicht.example', clientId: own.clientId, clientSecret: own.secret }, 422, null, 'Tenant unbekannt');
    await fail({ tenant: contoso.id, clientId: 'keine-guid-keine-guid-keine-guid-xxxx', clientSecret: own.secret }, 422, null, 'Anwendungs-ID keine GUID');
    assert.equal(kc.idps.size, 0);
    assert.equal(await connRow('demo'), undefined);
  });

  test('verbinden: Anbieter entra-app-<alias> mit den Angaben der Organisation, Geheimnis nur verschlüsselt, nie in Antwort oder Protokoll', async () => {
    // Von Hand angelegter Anbieter (vor dem Neuverbinden): Anna dort verknüpft, Bea ohne Verknüpfung
    kc.idps.set('entra-manuell', { alias: 'entra-manuell', providerId: 'microsoft', config: {} });
    kc.links.set(u.anna.id, new Map([['entra-manuell', { userId: annaOid, userName: 'anna@demo.example' }]]));
    const accounts = kc.users.size;
    const r = ok(await putApp({ tenant: 'demo.example', clientId: own.clientId.toUpperCase(), clientSecret: ` ${own.secret} ` }));
    assert.deepEqual([r.connection.method, r.connection.clientId, r.connection.stage, r.connection.secretExpiresAt, r.connection.secretExpiresSoon],
      ['own', own.clientId, 'pending', null, false]);
    assert.equal(r.connection.redirectUri, `${idp.issuer}/broker/entra-app-demo/endpoint`);
    assert.deepEqual(r.connection.domains, ['demo.example', 'demoag.onmicrosoft.com']);
    assert.ok(r.members.find((m: any) => m.email === 'anna@demo.example').linked);
    // Bestehende Konten (gleiche Adresse) werden mit dem neuen Anbieter verknüpft, über die Objekt-ID; kein neues Konto
    assert.deepEqual(kc.links.get(u.anna.id)!.get('entra-app-demo'), { userId: annaOid, userName: 'anna@demo.example' }, 'trotz alter Verknüpfung');
    assert.deepEqual(kc.links.get(u.bea.id)!.get('entra-app-demo'), { userId: beaOid, userName: 'bea@demo.example' }, 'ohne Verknüpfung');
    assert.equal(kc.users.size, accounts, 'kein Duplikat');
    const idpRep = kc.idps.get('entra-app-demo')!;
    assert.deepEqual([idpRep.providerId, idpRep.config.clientId, idpRep.config.clientSecret, idpRep.config.tenantId], ['microsoft', own.clientId, own.secret, contoso.id]);
    const row = await connRow('demo');
    assert.ok(row.app_secret_enc.startsWith('v1.k1.') && !row.app_secret_enc.includes(own.secret));
    assert.equal(decryptAppSecret(parseEncryptionKeys(KEY1), row.tenant_id, own.clientId, row.app_secret_enc), own.secret);
    assert.throws(() => decryptAppSecret(parseEncryptionKeys(KEY1), row.tenant_id, randomBytes(16).toString('hex'), row.app_secret_enc), 'AAD an die App gebunden');
    const a = (await auditOf('demo', 'entra.connected')).at(-1)!;
    assert.deepEqual([a.data.app, a.data.appClientId], ['own', own.clientId]);
    const s = ok(await call(anna(), 'GET', '/v1/admin/entra'));
    for (const x of [r, s, a]) assert.ok(!JSON.stringify(x).includes(own.secret), 'Geheimnis nie in Antwort oder Protokoll');
    assert.match(s.connection.testLoginPath, /idp=entra-app-demo/);
  });

  test('Personen suchen und «Nur Entra»-Vorschau mit der eigenen App (Token der Organisation, nicht der Plattform)', async () => {
    const r = ok(await call(anna(), 'GET', '/v1/admin/members/entra-search?q=anton'));
    assert.deepEqual(r.items.map((x: any) => x.email), ['anton@demo.example']);
    ok(await call(anna(), 'GET', '/v1/admin/entra/preview'));
  });

  test('Geheimnis wechseln (gleiche App, gleicher Tenant): Stufe und Domänen bleiben; Ablauf aus Graph bzw. angegeben; Warnung vor Ablauf', async () => {
    await t.inspect.query("UPDATE notes.entra_connection SET domains = '{demo.example}'");
    const before = await connRow('demo');
    own.secret = 'neu~geheimnis-1'; own.passwordCredentials = [{ keyId: 'k', hint: 'neu', endDateTime: new Date(Date.now() + 10 * 86_400_000).toISOString() }];
    ok(await putApp({ tenant: contoso.id, clientId: own.clientId, clientSecret: own.secret, secretExpiresAt: '2030-01-01T00:00:00Z' }));
    let row = await connRow('demo');
    assert.notEqual(row.app_secret_enc, before.app_secret_enc);
    assert.deepEqual(row.domains, ['demo.example'], 'Domänen bleiben');
    assert.equal(row.app_secret_expires_at.toISOString(), '2030-01-01T00:00:00.000Z', 'ohne Application.Read.All: angegeben');
    assert.equal(kc.idps.get('entra-app-demo')!.config.clientSecret, 'neu~geheimnis-1');
    own.roles = ['Organization.Read.All', 'User.Read.All', 'Application.Read.All'];
    const r = ok(await putApp({ tenant: contoso.id, clientId: own.clientId, clientSecret: own.secret }));
    assert.equal(new Date(r.connection.secretExpiresAt).toISOString(), own.passwordCredentials[0]!.endDateTime, 'aus Graph (Hinweis = erste drei Zeichen)');
    assert.equal(r.connection.secretExpiresSoon, true, 'in 10 Tagen');
    own.passwordCredentials[0]!.endDateTime = new Date(Date.now() + 200 * 86_400_000).toISOString();
    const f = ok(await call(anna(), 'POST', '/v1/admin/entra/refresh'));
    assert.equal(f.connection.secretExpiresSoon, false, 'Aktualisieren liest den Ablauf neu');
    row = await connRow('demo');
    assert.equal(row.app_secret_expires_at.toISOString(), own.passwordCredentials[0]!.endDateTime);
  });

  test('anderer Tenant 409 tenant-mismatch; Zustimmung über die App der Plattform 409 own-app (Wechsel nur über Trennen)', async () => {
    const f = ms.app(fremd);
    const r = await putApp({ tenant: fremd.id, clientId: f.clientId, clientSecret: f.secret });
    assert.deepEqual([r.status, r.body.reason], [409, 'tenant-mismatch']);
    const c = await call(anna(), 'POST', '/v1/admin/entra/consent', { tenant: contoso.id }, withPlatform);
    assert.deepEqual([c.status, c.body.reason], [409, 'own-app']);
    const l = await call(anna(), 'POST', '/v1/admin/entra/consent-links', { tenant: contoso.id, kind: 'consent' }, withPlatform);
    assert.deepEqual([l.status, l.body.reason], [409, 'own-app']);
  });

  test('Link «Credentials eintragen»: Kunden-IT trägt die App ohne Konto ein; Tenant fest aus dem Link; Fehler lassen den Link offen; einmal einlösbar', async () => {
    const link = ok(await call(mona(), 'POST', '/v1/admin/entra/consent-links', { tenant: 'muster.example' }), 201);
    assert.equal(link.kind, 'credentials', 'ohne App der Plattform: Standard credentials');
    const token = new URL(link.url).hash.slice(1);
    const info = ok(await call(null, 'POST', '/v1/entra/handover/info', { token }));
    assert.deepEqual([info.kind, info.entraTenantId, info.ownApp.redirectUri], ['credentials', muster.id, `${idp.issuer}/broker/entra-app-muster/endpoint`]);
    const start = await call(null, 'POST', '/v1/entra/handover/start', { token });
    assert.deepEqual([start.status, start.body.reason], [409, 'link-kind'], 'kein Zustimmungs-Link');
    const mapp = ms.app(muster);
    const bad = await call(null, 'POST', '/v1/entra/handover/credentials', { token, clientId: mapp.clientId, clientSecret: 'falsch' });
    assert.deepEqual([bad.status, bad.body.reason], [409, 'invalid-secret']);
    const otherTenant = await call(null, 'POST', '/v1/entra/handover/credentials', { token, clientId: own.clientId, clientSecret: own.secret });
    assert.deepEqual([otherTenant.status, otherTenant.body.reason], [409, 'wrong-tenant'], 'App eines anderen Tenants: Tenant aus dem Link');
    let item = ok(await call(mona(), 'GET', '/v1/admin/entra/consent-links')).items.find((x: any) => x.id === link.id);
    assert.deepEqual([item.kind, item.status, item.error.reason], ['credentials', 'failed', 'wrong-tenant']);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/credentials', { token: 'x', clientId: mapp.clientId, clientSecret: mapp.secret })).status, 422);
    const r = ok(await call(null, 'POST', '/v1/entra/handover/credentials', { token, clientId: mapp.clientId, clientSecret: mapp.secret }));
    assert.deepEqual(r, { organization: (await t.inspect.query("SELECT name FROM notes.tenant WHERE alias = 'muster'")).rows[0].name, connected: true });
    const row = await connRow('muster');
    assert.deepEqual([row.app_client_id, row.idp_alias, row.entra_tenant_id], [mapp.clientId, 'entra-app-muster', muster.id]);
    const a = (await auditOf('muster', 'entra.connected')).at(-1)!;
    assert.deepEqual([a.actor_name, a.data.viaLink, a.data.app], ['Mona Muster', link.id, 'own']);
    assert.ok(!JSON.stringify(a).includes(mapp.secret));
    item = ok(await call(mona(), 'GET', '/v1/admin/entra/consent-links')).items.find((x: any) => x.id === link.id);
    assert.deepEqual([item.status, item.error], ['connected', null]);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/credentials', { token, clientId: mapp.clientId, clientSecret: mapp.secret })).status, 404, 'eingelöst');
  });

  test('Rotation der Hauptschlüssel: Geheimnisse eigener Apps auf den neuen ersten Schlüssel umgestellt', async () => {
    const keys = parseEncryptionKeys(`k2:${randomBytes(32).toString('base64')},${KEY1}`);
    const demoId = (await connRow('demo')).tenant_id;
    assert.equal(await withTenant(t.runtime, { tenantId: demoId }, tx => rewrapEntraSecrets(tx, keys, { schema: 'notes', dryRun: true })), 1);
    assert.equal(await withTenant(t.runtime, { tenantId: demoId }, tx => rewrapEntraSecrets(tx, keys, { schema: 'notes' })), 1);
    const row = await connRow('demo');
    assert.ok(row.app_secret_enc.startsWith('v1.k2.'));
    assert.equal(decryptAppSecret([keys[0]!], demoId, own.clientId, row.app_secret_enc), own.secret, 'nur mit dem neuen Schlüssel');
    assert.equal(await withTenant(t.runtime, { tenantId: demoId }, tx => rewrapEntraSecrets(tx, keys, { schema: 'notes' })), 0, 'zweiter Lauf: nichts');
  });
});
