/**
 * Modul `entra`: Anmeldung über Microsoft Entra ID je Organisation (aus Assets test/platform/entra.test.ts,
 * produktneutral mit der Beispiel-App «notes») gegen Wegwerf-Datenbank, Mock-IdP, den `KeycloakFake` des Test-Kits und
 * das nachgebildete Microsoft (`EntraFake` des Test-Kits).
 * Schwerpunkte: Admin-Zustimmung (state einmal gültig, an Person, Organisation und Tenant gebunden), nur verifizierte
 * Domänen, keine Domäne einer anderen Organisation (ohne sie zu nennen), Verknüpfung nur über die Objekt-ID und ohne
 * Gäste, Passwörter entfernt, «Nur Entra» im Resolver, nicht selbst aussperren, Trennen, Plätze für Redirect-URIs,
 * Rückkehrpfade aus ENTRA_UI_PATH.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { EntraFake, KeycloakFake, startMockIdp, type FakeOrg, type FakeTenant, type FakeUser, type MockIdp } from '@vollholz/iam-testkit';
import { brokerRedirectUris, idpRepresentation } from '../src/entra.ts';
import { CONSENT_ADMIN_ROLES, EntraGraph, notLinkable, type EntraUser } from '../src/graph.ts';
import { skipDb } from './support/db.ts';
import { claims, notesApp, notesDb, type NotesApp } from './support/http.ts';

const skip = await skipDb();

type Res = { status: number; body: any };
const ENTRA = { ENTRA_CLIENT_ID: '11111111-2222-3333-4444-555555555555', ENTRA_CLIENT_SECRET: 'entra-geheim' };

describe('Entra ID: Regeln ohne Datenbank', () => {
  const member = (o: Partial<EntraUser> = {}): EntraUser => ({ id: 'a', userPrincipalName: 'anna@demo.example', mail: 'anna@demo.example', displayName: null, givenName: null, surname: null, userType: 'Member', accountEnabled: true, ...o });
  test('verknüpfbar nur: Mitglied, aktiv, Adresse in gebundener Domäne und passend zum Konto', () => {
    assert.equal(notLinkable(member(), ['demo.example'], 'anna@demo.example'), null);
    assert.match(notLinkable(member({ userType: 'Guest' }), ['demo.example'])!, /Gast/);
    assert.match(notLinkable(member({ userPrincipalName: 'anna_demo.example#EXT#@other.onmicrosoft.com' }), ['demo.example'])!, /Gast/, '#EXT# auch mit userType Member');
    assert.match(notLinkable(member({ accountEnabled: false }), ['demo.example'])!, /deaktiviert/);
    assert.match(notLinkable(member({ userPrincipalName: 'anna@other.example', mail: 'anna@other.example' }), ['demo.example'])!, /nicht in einer Domäne/);
    assert.match(notLinkable(member(), ['demo.example'], 'anna.admin@demo.example')!, /passt nicht/);
    assert.equal(notLinkable(member({ mail: null }), ['demo.example'], 'ANNA@demo.example'), null, 'UPN genügt, Gross/klein egal');
  });

  test('Anbieter: «microsoft» mit Tenant, ohne E-Mail-Vertrauen, Erstanmeldung verweigert; Redirect-URIs je Platz', () => {
    const r = idpRepresentation('entra-007', 'tid-1', { clientId: 'cid', clientSecret: 's' }, 'notes');
    assert.deepEqual([r.providerId, r.config.tenantId, r.trustEmail, r.hideOnLogin, r.firstBrokerLoginFlowAlias, r.config.clientId, r.config.syncMode], ['microsoft', 'tid-1', false, true, 'notes-entra-first-login', 'cid', 'IMPORT']);
    assert.deepEqual(brokerRedirectUris({ oidc: { issuer: 'https://login.test/realms/notes' } as never, entra: { slots: 3 } as never }),
      ['https://login.test/realms/notes/broker/entra-001/endpoint', 'https://login.test/realms/notes/broker/entra-002/endpoint', 'https://login.test/realms/notes/broker/entra-003/endpoint']);
  });

  test('Graph: Tenant per Domäne oder ID, Admin-Zustimmung mit fester Adresse, Eingaben geprüft', async () => {
    const ms = new EntraFake();
    const t = ms.tenant('Demo AG', ['demo.example', 'demo.onmicrosoft.com']);
    const g = new EntraGraph({ clientId: 'cid', clientSecret: ms.secret, timeoutMs: 2000 }, ms.fetch);
    assert.equal(await g.resolveTenant('Demo.onmicrosoft.com'), t.id);
    assert.equal(await g.resolveTenant(t.id), t.id);
    assert.equal(await g.resolveTenant('unbekannt.example'), null);
    for (const bad of ['common', 'organizations', '../x', 'a b', 'http://x']) assert.equal(await g.resolveTenant(bad), null, bad);
    const u = new URL(g.consentUrl(t.id, { state: 's1', redirectUri: 'https://app.test/cb', nonce: 'n1', codeChallenge: 'c1' }));
    assert.equal(`${u.origin}${u.pathname}`, `https://login.microsoftonline.com/${t.id}/oauth2/v2.0/authorize`);
    assert.deepEqual(['response_type', 'scope', 'prompt', 'nonce', 'code_challenge', 'code_challenge_method'].map(k => u.searchParams.get(k)),
      ['code', 'openid profile https://graph.microsoft.com/.default', 'admin_consent', 'n1', 'c1', 'S256']);
    await assert.rejects(g.organization(t.id), (e: any) => e.status === 409, 'ohne Zustimmung kein Token');
    t.consented = true;
    assert.deepEqual((await g.organization(t.id, true)).verifiedDomains, ['demo.example', 'demo.onmicrosoft.com']);
    // Adresse mit Hochkomma: im Filter maskiert, nicht abgeschnitten
    ms.user(t, "o'neil@demo.example");
    assert.equal((await g.usersByAddress(t.id, "O'Neil@demo.example")).length, 1);
  });
});

describe('Anmeldung über Microsoft Entra ID je Organisation', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, app: NotesApp, off: NotesApp, small: NotesApp;
  const kc = new KeycloakFake();
  const ms = new EntraFake();
  const u = {} as Record<'anna' | 'carla' | 'dana' | 'olga' | 'mona' | 'paula' | 'ext', FakeUser>;
  let demo: FakeOrg, muster: FakeOrg, ops: FakeOrg, contoso: FakeTenant;
  const oid = {} as Record<string, string>;

  const person = (x: FakeUser, org: string, roles: string[], extra: Record<string, unknown> = {}) =>
    idp.token({ ...claims.user({ sub: x.id, org, groupRoles: roles, email: x.email, name: `${x.firstName} ${x.lastName}` }), ...extra });
  async function call(who: string | Promise<string>, method: string, url: string, body?: unknown, o: { app?: NotesApp } = {}): Promise<Res> {
    const r = await (o.app ?? app).app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${await who}` }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const auditOf = async (alias: string, action: string) => (await t.inspect.query<{ data: any; actor_name: string }>(
    'SELECT a.data, a.actor_name FROM notes.audit_log a JOIN notes.tenant t ON t.id = a.tenant_id WHERE t.alias = $1 AND a.action = $2 ORDER BY a.seq', [alias, action])).rows;
  const anna = () => person(u.anna, 'demo', ['org-admin']);
  const annaEntra = (alias = 'entra-001') => person(u.anna, 'demo', ['org-admin'], { identity_provider: alias });
  const paula = () => person(u.paula, 'ops', ['org-admin'], { realm_access: { roles: ['platform-admin'] } });

  /** Zustimmung im Tenant simulieren: starten, Zustimmung erteilen, Rückkehr wie die Oberfläche. */
  async function connect(who: Promise<string>, base: string, tenant: FakeTenant, input = tenant.domains[0]!, back: Record<string, string> = {}, o: { app?: NotesApp } = {}): Promise<Res> {
    const s = ok(await call(who, 'POST', `${base}/consent`, { tenant: input }, o));
    // Globale Administration des Tenants meldet sich an und stimmt zu
    const admin = tenant.users.find(x => x.userPrincipalName.startsWith('ga@')) ?? ms.user(tenant, `ga@${tenant.domains.at(-1)}`, { displayName: 'Globale Administration' });
    return call(who, 'POST', `${base}/consent/complete`, { ...ms.approve(s.url, admin, { wids: [CONSENT_ADMIN_ROLES[0]!] }), ...back }, o);
  }

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    demo = kc.org('demo', 'Demo AG'); muster = kc.org('muster', 'Muster GmbH'); ops = kc.org('ops', 'Betrieb');
    // muster.example gehört in Keycloak schon Muster; demo.example ist noch keiner Organisation zugeordnet
    demo.domains = [{ name: 'alt.example', verified: false }];
    muster.domains = [{ name: 'muster.example', verified: false }];
    u.anna = kc.user('anna', { email: 'anna@demo.example', firstName: 'Anna', lastName: 'Admin' });
    u.carla = kc.user('carla', { email: 'carla@demo.example', firstName: 'Carla', lastName: 'Gast' });
    u.dana = kc.user('dana', { email: 'dana@demo.example', firstName: 'Dana', lastName: 'Fehlt' });
    u.olga = kc.user('olga', { email: 'olga@extra.example', firstName: 'Olga', lastName: 'Extra' });
    u.ext = kc.user('ext', { email: 'ext@gmail.example', firstName: 'Externe', lastName: 'Beraterin' });
    u.mona = kc.user('mona', { email: 'mona@muster.example', firstName: 'Mona', lastName: 'Muster' });
    u.paula = kc.user('paula', { email: 'paula@ops.example', firstName: 'Paula', lastName: 'Plattform' });
    kc.member(demo, u.anna, ['org-admin']); kc.member(demo, u.carla, ['viewer']); kc.member(demo, u.dana, ['viewer']); kc.member(demo, u.olga, ['viewer']); kc.member(demo, u.ext, ['viewer']);
    kc.member(muster, u.mona, ['org-admin']); kc.member(ops, u.paula, ['org-admin']);
    for (const alias of ['demo', 'muster', 'ops']) for (const r of ['org-admin', 'viewer']) kc.groupPath(`/orgs/${alias}/${r}`);
    u.dana.requiredActions = ['UPDATE_PASSWORD'];

    // Tenant der Demo AG: muster.example ist dort auch verifiziert (gehört aber Muster)
    contoso = ms.tenant('Demo AG (Entra)', ['demo.example', 'extra.example', 'muster.example', 'demoag.onmicrosoft.com']);
    oid.anna = ms.user(contoso, 'anna@demo.example').id;
    ms.user(contoso, 'carla_demo.example#EXT#@demoag.onmicrosoft.com', { mail: 'carla@demo.example', userType: 'Guest' });
    oid.olga = ms.user(contoso, 'olga@extra.example').id;

    const base = { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' };
    const mk = (env: Record<string, string>, entra = true) => notesApp({ db: t.runtime, issuer: idp.issuer, env, keycloakFetch: kc.fetch, ...(entra ? { entraFetch: ms.fetch, entraRetryMs: [0, 1] } : {}) });
    app = await mk({ ...base, ...ENTRA });
    off = await mk(base, false);
    small = await mk({ ...base, ...ENTRA, ENTRA_IDP_SLOTS: '1' });
    for (const tok of [anna(), paula(), person(u.mona, 'muster', ['org-admin'])]) ok(await call(tok, 'GET', '/v1/me'));
  });
  after(async () => { await app?.app.close(); await off?.app.close(); await small?.app.close(); await idp?.close(); await t?.drop(); });

  test('ohne ENTRA_CLIENT_ID: nur der Weg «eigene App»; Zustimmung 409 platform-app-disabled (Konfiguration: test/config.test.ts)', async () => {
    const s = ok(await call(anna(), 'GET', '/v1/admin/entra', undefined, { app: off }));
    assert.deepEqual([s.enabled, s.methods.platformApp], [false, false]);
    assert.match(s.reason, /ENTRA_CLIENT_ID/);
    assert.deepEqual([s.methods.ownApp, s.ownApp], [false, null], 'ohne ENCRYPTION_KEYS auch keine eigene App');
    assert.match(s.ownAppReason, /ENCRYPTION_KEYS/);
    const consent = await call(anna(), 'POST', '/v1/admin/entra/consent', { tenant: 'demo.example' }, { app: off });
    assert.deepEqual([consent.status, consent.body.reason], [409, 'platform-app-disabled']);
    const link = await call(anna(), 'POST', '/v1/admin/entra/consent-links', { tenant: 'demo.example', kind: 'consent' }, { app: off });
    assert.deepEqual([link.status, link.body.reason], [409, 'platform-app-disabled'], 'Link mit Zustimmung');
    assert.equal((await call(anna(), 'POST', '/v1/platform/entra/refresh', undefined, { app: off })).status, 403, 'erst das Recht');
    assert.deepEqual([s.consentPath, s.testPath], ['/verwalten/anmeldung/zustimmung', '/verwalten/anmeldung/test'], 'Rückkehrpfade aus ENTRA_UI_PATH (Standard)');
  });

  test('ENTRA_UI_PATH: Rückkehrpfade im Status, Redirect-URI der Zustimmung und returnTo der Testanmeldung folgen der Oberfläche', async () => {
    const own = await notesApp({ db: t.runtime, issuer: idp.issuer, env: { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'x', ...ENTRA, ENTRA_UI_PATH: '/admin/sso/' }, keycloakFetch: kc.fetch, entraFetch: ms.fetch });
    try {
      const s = ok(await call(anna(), 'GET', '/v1/admin/entra', undefined, { app: own }));
      assert.deepEqual([s.consentPath, s.testPath], ['/admin/sso/zustimmung', '/admin/sso/test']);
      const r = ok(await call(anna(), 'POST', '/v1/admin/entra/consent', { tenant: contoso.id }, { app: own }));
      assert.equal(new URL(r.url).searchParams.get('redirect_uri'), 'http://api.test/admin/sso/zustimmung');
      const doc = own.app.swagger() as { paths: Record<string, Record<string, { description?: string }>> };
      assert.match(doc.paths['/v1/admin/entra/consent']!.post!.description!, /\/admin\/sso\/zustimmung/);
    } finally { await own.app.close(); }
    await t.inspect.query('DELETE FROM notes.entra_consent');
  });

  test('Rechte: nur org-admin bzw. Plattform; Personen ohne Recht 403', async () => {
    assert.equal((await call(person(u.carla, 'demo', ['viewer']), 'GET', '/v1/admin/entra')).status, 403);
    assert.equal((await call(person(u.carla, 'demo', ['viewer']), 'POST', '/v1/admin/entra/consent', { tenant: 'demo.example' })).status, 403);
    assert.equal((await call(anna(), 'GET', '/v1/platform/organizations/muster/entra')).status, 403, 'org-admin nicht für fremde Organisation');
    assert.equal(ok(await call(anna(), 'GET', '/v1/admin/entra')).enabled, true);
  });

  test('Zustimmung starten: Tenant per Domäne, state nur als Hash, Adresse von Microsoft; unbekannter Tenant 422', async () => {
    assert.equal((await call(anna(), 'POST', '/v1/admin/entra/consent', { tenant: 'gibt-es-nicht.example' })).status, 422);
    const r = ok(await call(anna(), 'POST', '/v1/admin/entra/consent', { tenant: 'demoag.onmicrosoft.com' }));
    assert.equal(r.entraTenantId, contoso.id);
    const url = new URL(r.url);
    assert.equal(url.pathname, `/${contoso.id}/oauth2/v2.0/authorize`);
    assert.ok(url.searchParams.get('nonce') && url.searchParams.get('code_challenge') && !url.searchParams.get('nonce')!.includes(url.searchParams.get('state')!), 'PKCE und nonce, nicht aus state ablesbar');
    assert.equal(url.searchParams.get('client_id'), ENTRA.ENTRA_CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), 'http://api.test/verwalten/anmeldung/zustimmung');
    const state = url.searchParams.get('state')!;
    assert.match(state, /^o\.demo\.[A-Za-z0-9_-]{40,}$/);
    const rows = (await t.inspect.query('SELECT state_hash FROM notes.entra_consent')).rows;
    assert.ok(rows.length >= 1 && rows.every(x => x.state_hash !== state && /^[0-9a-f]{64}$/.test(x.state_hash)), 'nur der Hash');
  });

  test('Rückkehr: state fremder Person, Organisation oder Weg, abgelaufen, doppelt → 404; Ablehnung und Rückkehr ohne Code → 409', async () => {
    const start = async (who = anna(), base = '/v1/admin/entra') => new URL(ok(await call(who, 'POST', `${base}/consent`, { tenant: contoso.id })).url).searchParams.get('state')!;
    const s1 = await start();
    // andere Person derselben Organisation (eigenes Recht vorausgesetzt) – hier die Plattform für demo
    assert.equal((await call(paula(), 'POST', '/v1/platform/organizations/demo/entra/consent/complete', { state: s1 })).status, 404, 'Plattform-Weg mit o.-state');
    assert.equal((await call(person(u.mona, 'muster', ['org-admin']), 'POST', '/v1/admin/entra/consent/complete', { state: s1 })).status, 404, 'andere Organisation');
    assert.equal((await call(person(u.mona, 'muster', ['org-admin']), 'POST', '/v1/admin/entra/consent/complete', { state: s1.replace('o.demo.', 'o.muster.') })).status, 404, 'Alias im state umgeschrieben');
    const declined = await call(anna(), 'POST', '/v1/admin/entra/consent/complete', { state: s1, error: 'access_denied', errorDescription: 'AADSTS65004: User declined to consent. Interna …' });
    assert.equal(declined.status, 409);
    assert.match(declined.body.detail, /abgelehnt.*AADSTS65004/);
    assert.doesNotMatch(declined.body.detail, /Interna/);
    assert.equal((await call(anna(), 'POST', '/v1/admin/entra/consent/complete', { state: s1 })).status, 404, 'einmal gültig');
    const s2 = await start();
    const old = await call(anna(), 'POST', '/v1/admin/entra/consent/complete', { state: s2, tenant: contoso.id, adminConsent: 'True' });
    assert.equal(old.status, 422, 'Felder der alten Admin-Zustimmung: unbekannt (removeAdditional: false)');
    const noCode = await call(anna(), 'POST', '/v1/admin/entra/consent/complete', { state: s2 });
    assert.deepEqual([noCode.status, noCode.body.reason], [409, 'consent-unproven'], 'Rückkehr ohne Code genügt nicht');
    const s3 = await start();
    await t.inspect.query("UPDATE notes.entra_consent SET expires_at = now() - interval '1 minute'");
    assert.equal((await call(anna(), 'POST', '/v1/admin/entra/consent/complete', { state: s3 })).status, 404, 'abgelaufen');
    assert.equal(kc.idps.size, 0, 'nichts angelegt');
  });

  test('Zustimmung nur mit Nachweis: Tenant hat schon zugestimmt, Code fehlt, fremd, falscher Tenant, nonce, PKCE, ohne Admin-Rolle, Gast → 409', async () => {
    // Angriff: Tenant hat früher zugestimmt (Client Credentials gehen), die org-admin ruft complete ohne Anmeldung bei Microsoft
    contoso.consented = true;
    const ga = ms.user(contoso, 'ga@demoag.onmicrosoft.com', { displayName: 'Globale Administration' });
    const begin = async () => ok(await call(anna(), 'POST', '/v1/admin/entra/consent', { tenant: contoso.id })).url as string;
    const complete = (body: Record<string, unknown>) => call(anna(), 'POST', '/v1/admin/entra/consent/complete', body);
    const unproven = (r: Res, m: RegExp, why: string) => { assert.deepEqual([r.status, r.body.reason], [409, 'consent-unproven'], `${why}: ${JSON.stringify(r.body)}`); assert.match(r.body.detail, m, why); };
    unproven(await complete({ state: new URL(await begin()).searchParams.get('state') }), /keinen Code/, 'ohne Code');
    unproven(await complete({ state: new URL(await begin()).searchParams.get('state'), code: 'erfunden' }), /AADSTS70000/, 'erfundener Code');
    // Code einer anderen Zustimmung (andere Person, eigener state): passt nicht zum PKCE-Verifier dieses state
    const other = ms.approve(await begin(), ga, { wids: [CONSENT_ADMIN_ROLES[0]!] });
    unproven(await complete({ state: new URL(await begin()).searchParams.get('state'), code: other.code }), /AADSTS501481/, 'Code einer anderen Zustimmung');
    const fremd = ms.tenant('Fremd AG', ['fremd.example']);
    unproven(await complete(ms.approve(await begin(), ga, { wids: [CONSENT_ADMIN_ROLES[0]!], claims: { tid: fremd.id } })), /anderen Tenant/, 'tid fremd');
    unproven(await complete(ms.approve(await begin(), ga, { wids: [CONSENT_ADMIN_ROLES[0]!], claims: { nonce: 'alt' } })), /gehört nicht zu dieser Zustimmung/, 'nonce');
    unproven(await complete(ms.approve(await begin(), ga, { wids: ['b79fbf4d-3ef9-4689-8143-76b194e85509'] })), /weder «Global Administrator»/, 'nur Default User');
    unproven(await complete(ms.approve(await begin(), ga, { claims: { wids: undefined } })), /wids fehlt: DirectoryRole-Claim/, 'Claim fehlt (App-Registrierung ohne Verzeichnisrollen)');
    unproven(await complete(ms.approve(await begin(), ga, { wids: [CONSENT_ADMIN_ROLES[1]!], guest: true })), /Gast/, 'Gast');
    unproven(await complete(ms.approve(await begin(), ga, { wids: [CONSENT_ADMIN_ROLES[0]!], claims: { aud: 'andere-app' } })), /ID-Token ungültig/, 'Zielgruppe');
    assert.deepEqual([kc.idps.size, (await t.inspect.query('SELECT count(*)::int AS n FROM notes.entra_connection')).rows[0].n], [0, 0], 'nichts verbunden');
    const failed = (await auditOf('demo', 'entra.consent_failed')).map(a => a.data.reason);
    assert.ok(failed.length >= 10 && failed.every(r => r === 'consent-unproven' || r === 'consent-error'), 'Fehlschläge im Protokoll');
    assert.ok((await auditOf('demo', 'entra.consent_started')).length >= 10, 'Start im Protokoll');
    contoso.consented = false;
    contoso.users.splice(contoso.users.indexOf(ga), 1);
  });

  test('verbinden (Stufe 1): Anbieter je Tenant, nur freie verifizierte Domänen, Mitglieder über Objekt-ID verknüpft; Passwörter und Anmeldung bleiben', async () => {
    ms.lagging = 1; // erste Token-Anfrage nach der Zustimmung scheitert noch
    const r = ok(await connect(anna(), '/v1/admin/entra', contoso));
    assert.deepEqual(r.connection.domains, ['demo.example', 'demoag.onmicrosoft.com', 'extra.example']);
    assert.deepEqual([r.connection.stage, r.connection.testedAt], ['pending', null]);
    assert.equal(r.connection.testLoginPath, '/auth/login?idp=entra-001&org=demo&returnTo=%2Fverwalten%2Fanmeldung%2Ftest');
    assert.deepEqual(r.rejectedDomains, ['muster.example'], 'gehört Muster – ohne die Organisation zu nennen');
    assert.doesNotMatch(JSON.stringify(r), /muster GmbH|Muster GmbH|"muster"/);
    assert.equal(r.connection.entraTenantId, contoso.id);
    const ga = contoso.users.find(x => x.userPrincipalName.startsWith('ga@'))!;
    assert.deepEqual((await auditOf('demo', 'entra.connected'))[0]!.data.consentBy, { oid: ga.id, name: 'Globale Administration', username: ga.userPrincipalName }, 'wer im Tenant zugestimmt hat');
    // Keycloak: Anbieter «microsoft» für genau diesen Tenant, ohne automatische Mitgliedschaft mit der Organisation verbunden
    const ip = kc.idps.get('entra-001')!;
    assert.deepEqual([ip.providerId, ip.config.tenantId, ip.config.clientSecret, ip.trustEmail, ip.firstBrokerLoginFlowAlias], ['microsoft', contoso.id, 'entra-geheim', false, 'notes-entra-first-login']);
    assert.deepEqual(kc.orgIdps.get(demo.id)!.get('entra-001'), { autoMembership: false, membershipType: 'UNMANAGED' });
    const domains = Object.fromEntries(demo.domains.map(d => [d.name, d]));
    assert.deepEqual(domains['demo.example'], { name: 'demo.example', verified: true, identityProviderAlias: 'entra-001', autoRedirect: false }, 'zugeordnet, noch ohne Weiterleitung');
    assert.equal(domains['alt.example']!.identityProviderAlias, undefined, 'bestehende Domäne der Organisation bleibt');
    assert.ok(!demo.domains.some(d => d.name === 'muster.example'));
    // Verknüpfung über die Objekt-ID (für die Testanmeldung); Gast und Unbekannte nicht
    assert.deepEqual(kc.links.get(u.anna.id)!.get('entra-001'), { userId: oid.anna, userName: 'anna@demo.example' });
    assert.deepEqual(kc.links.get(u.olga.id)!.get('entra-001')!.userId, oid.olga);
    assert.ok(!kc.links.get(u.carla.id)?.size, 'Gast nie verknüpft');
    const byMail = Object.fromEntries(r.members.map((m: any) => [m.email, m]));
    assert.deepEqual([byMail['anna@demo.example'].linked, byMail['olga@extra.example'].linked, byMail['carla@demo.example'].linked, byMail['dana@demo.example'].linked], [true, true, false, false]);
    assert.match(byMail['carla@demo.example'].reason, /Gast/);
    assert.match(byMail['dana@demo.example'].reason, /nicht gefunden/);
    assert.equal(byMail['ext@gmail.example'], undefined, 'andere Domänen unberührt');
    // Noch nichts erzwungen: Passwörter bleiben, Anmeldung mit Passwort gilt, Einladen mit Passwort geht
    assert.deepEqual([u.anna.password, u.carla.password, u.dana.password, u.olga.password], [true, true, true, true]);
    assert.deepEqual(u.dana.requiredActions, ['UPDATE_PASSWORD']);
    ok(await call(anna(), 'GET', '/v1/admin/entra'));
    const a = (await auditOf('demo', 'entra.connected'))[0]!;
    assert.equal(a.actor_name, 'Anna Admin');
    assert.deepEqual([a.data.entraTenantId, a.data.linked, a.data.rejectedDomains, a.data.stage], [contoso.id, 2, ['muster.example'], 'pending']);
  });

  test('Testanmeldung: nur eine über den Anbieter angemeldete Sitzung mit Adresse der Domänen; jede Person der Organisation', async () => {
    assert.equal((await call(anna(), 'POST', '/v1/admin/entra/enforce', {})).body.reason, 'test-login-missing', 'ohne Testanmeldung nicht aktivierbar');
    const pw = await call(anna(), 'POST', '/v1/admin/entra/test');
    assert.deepEqual([pw.status, pw.body.reason], [409, 'not-entra-session']);
    assert.equal((await call(annaEntra('entra-002'), 'POST', '/v1/admin/entra/test')).body.reason, 'not-entra-session');
    assert.equal((await call(person(u.ext, 'demo', ['viewer'], { identity_provider: 'entra-001' }), 'POST', '/v1/admin/entra/test')).body.reason, 'not-in-domains');
    // olga ist nur viewer: darf testen, sonst nichts an der Verbindung
    const olga = person(u.olga, 'demo', ['viewer'], { identity_provider: 'entra-001' });
    assert.equal((await call(olga, 'GET', '/v1/admin/entra')).status, 403);
    const t1 = ok(await call(olga, 'POST', '/v1/admin/entra/test'));
    assert.equal(t1.testedBy, 'Olga Extra');
    assert.ok(t1.testedAt);
    assert.equal((await auditOf('demo', 'entra.test_login')).length, 1);
  });

  test('«Nur Entra» aktivieren: Vorschau, Bestätigung der Liste nötig, nicht selbst aussperren; danach Passwörter weg, Weiterleitung an', async () => {
    // Olga ist auch Plattform-Administration: Ihr Notfallzugang bleibt (F2)
    kc.realmRoleMappings.set(u.olga.id, new Set(['platform-admin']));
    const pv = ok(await call(anna(), 'GET', '/v1/admin/entra/preview'));
    assert.match(pv.members.find((m: any) => m.email === 'olga@extra.example').passwordKept, /Plattform-Administration/);
    assert.ok(pv.members.filter((m: any) => m.passwordKept).length === 1, 'nur Olga');
    assert.deepEqual(pv.members.filter((m: any) => !m.linked).map((m: any) => m.email).sort(), ['carla@demo.example', 'dana@demo.example']);
    const none = await call(anna(), 'POST', '/v1/admin/entra/enforce', {});
    assert.deepEqual([none.status, none.body.reason], [409, 'confirm-not-linked']);
    assert.deepEqual(none.body.notLinked.map((m: any) => m.email).sort(), ['carla@demo.example', 'dana@demo.example']);
    assert.equal((await call(anna(), 'POST', '/v1/admin/entra/enforce', { notLinked: ['carla@demo.example'] })).body.reason, 'confirm-not-linked', 'unvollständige Liste');
    // nicht selbst aussperren: Verknüpfung von anna fehlt und sie ist in Entra Gast
    const annaLink = kc.links.get(u.anna.id)!.get('entra-001')!;
    kc.links.get(u.anna.id)!.delete('entra-001');
    contoso.users.find(x => x.id === oid.anna)!.userType = 'Guest';
    try {
      const self = await call(anna(), 'POST', '/v1/admin/entra/enforce', { notLinked: ['carla@demo.example', 'dana@demo.example', 'anna@demo.example'] });
      assert.deepEqual([self.status, self.body.reason], [409, 'self-not-linkable']);
      assert.ok(u.carla.password, 'nichts geändert');
    } finally { contoso.users.find(x => x.id === oid.anna)!.userType = 'Member'; kc.links.get(u.anna.id)!.set('entra-001', annaLink); }
    // auch mit Verknüpfung: die verknüpfte Person ist in Entra deaktiviert – Vorschau nennt sie, nicht selbst aussperren
    contoso.users.find(x => x.id === oid.anna)!.accountEnabled = false;
    try {
      const p2 = ok(await call(anna(), 'GET', '/v1/admin/entra/preview')).members.find((m: any) => m.email === 'anna@demo.example');
      assert.deepEqual([p2.linked, p2.reason], [false, 'In Entra ID deaktiviert']);
      const self = await call(anna(), 'POST', '/v1/admin/entra/enforce', { notLinked: ['carla@demo.example', 'dana@demo.example', 'anna@demo.example'] });
      assert.deepEqual([self.status, self.body.reason], [409, 'self-not-linkable']);
    } finally { contoso.users.find(x => x.id === oid.anna)!.accountEnabled = true; }
    assert.equal(ok(await call(anna(), 'GET', '/v1/admin/entra')).connection.stage, 'pending');
    const r = ok(await call(anna(), 'POST', '/v1/admin/entra/enforce', { notLinked: ['DANA@demo.example', 'carla@demo.example'] }));
    assert.deepEqual([r.connection.stage, r.connection.enforcedBy], ['enforced', 'Anna Admin']);
    assert.deepEqual([u.anna.password, u.carla.password, u.dana.password, u.olga.password, u.ext.password], [false, false, false, true, true], 'Plattform-Administration behält ihr Passwort');
    kc.realmRoleMappings.delete(u.olga.id);
    assert.deepEqual(u.dana.requiredActions, []);
    assert.equal(demo.domains.find(d => d.name === 'demo.example')!.autoRedirect, true);
    const a = (await auditOf('demo', 'entra.enforced'))[0]!;
    assert.deepEqual(a.data.notLinked.map((m: any) => m.email).sort(), ['carla@demo.example', 'dana@demo.example']);
    assert.equal((await call(annaEntra(), 'POST', '/v1/admin/entra/enforce', {})).status, 409, 'schon aktiv');
  });

  test('nur Entra: Personen gebundener Domänen nur mit Anmeldung über den Anbieter; andere und Plattform unberührt', async () => {
    const denied = await call(anna(), 'GET', '/v1/admin/entra');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'entra-login-required');
    assert.equal((await call(annaEntra('entra-002'), 'GET', '/v1/admin/entra')).status, 403, 'anderer Anbieter zählt nicht');
    const s = ok(await call(annaEntra(), 'GET', '/v1/admin/entra'));
    assert.deepEqual(s.connection.availableDomains, ['muster.example']);
    ok(await call(person(u.ext, 'demo', ['viewer']), 'GET', '/v1/me'));
    assert.equal((await call(person(u.ext, 'demo', ['viewer']), 'GET', '/v1/people')).status, 200, 'externe Adresse: Passwort weiter erlaubt');
    // Plattform-Administration: Notfallzugang ohne Entra
    ok(await call(person(u.anna, 'demo', ['org-admin'], { realm_access: { roles: ['platform-admin'] } }), 'GET', '/v1/admin/entra'));
  });

  test('Einladen in Domäne mit «Nur Entra» 409; Domänen der Verbindung nicht über die Plattform-Organisation änderbar', async () => {
    const r = await call(annaEntra(), 'POST', '/v1/admin/members', { email: 'neu@demo.example' });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'entra-domain');
    assert.equal(kc.byEmail('neu@demo.example'), null, 'kein Konto angelegt');
    ok(await call(annaEntra(), 'POST', '/v1/admin/members', { email: 'neu@gmail.example' }), 202);
    const p = await call(paula(), 'PATCH', '/v1/platform/organizations/demo', { domains: ['alt.example'] });
    assert.equal(p.status, 409);
    assert.match(p.body.detail, /demo\.example/);
  });

  test('Mandantentrennung: Domänen schon gebunden → 409 ohne die andere Organisation zu nennen; Plätze erschöpft → 409', async () => {
    const same = ms.tenant('Fremd', ['demo.example', 'extra.example']);
    const mona = person(u.mona, 'muster', ['org-admin']);
    const r = await connect(mona, '/v1/admin/entra', same, same.id);
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'domains-taken');
    assert.doesNotMatch(JSON.stringify(r.body), /demo(?!\.example)|Demo AG/);
    // Plätze: mit ENTRA_IDP_SLOTS=1 ist der einzige belegt
    const own = ms.tenant('Muster (Entra)', ['muster-neu.example']);
    const s = await connect(mona, '/v1/admin/entra', own, own.id, {}, { app: small });
    assert.equal(s.status, 409);
    assert.equal(s.body.reason, 'no-slot');
  });

  test('Plattform verbindet im Auftrag (gleiche Funktion); Platz 2; Protokoll im Mandanten der Organisation', async () => {
    const own = ms.tenant('Muster (Entra)', ['muster.example']);
    ms.user(own, 'mona@muster.example');
    const r = ok(await connect(paula(), '/v1/platform/organizations/muster/entra', own, own.id));
    assert.deepEqual(r.connection.domains, ['muster.example'], 'eigene Domäne der Organisation darf gebunden werden');
    assert.ok(kc.idps.has('entra-002'));
    assert.equal(muster.domains.find(d => d.name === 'muster.example')!.identityProviderAlias, 'entra-002');
    const a = (await auditOf('muster', 'entra.connected'))[0]!;
    assert.equal(a.data.platformAdmin, true);
  });

  test('gleichzeitig verbinden (zwei Organisationen): verschiedene Plätze, kein Anbieter der anderen gelöscht (plattformweite Sperre)', async () => {
    const o1 = kc.org('para1', 'Parallel Eins'), o2 = kc.org('para2', 'Parallel Zwei');
    const t1 = ms.tenant('P1', ['para1.example']), t2 = ms.tenant('P2', ['para2.example']);
    // Halt vor dem Anlegen des Anbieters, bis beide Abläufe dort sind (höchstens 500 ms): Ohne plattformweite Sperre
    // sähen beide denselben freien Platz; mit Sperre wartet der zweite, bis der erste fertig ist.
    let waiting = 0, release: () => void = () => undefined;
    const both = new Promise<void>(r => { release = r; });
    kc.before = async call => {
      if (!/^GET \/identity-provider\/instances\/entra-/.test(call)) return;
      if (++waiting >= 2) release();
      await Promise.race([both, sleep(500)]);
    };
    const [r1, r2] = await Promise.all([
      connect(paula(), '/v1/platform/organizations/para1/entra', t1, t1.id),
      connect(paula(), '/v1/platform/organizations/para2/entra', t2, t2.id),
    ]);
    kc.before = null;
    ok(r1); ok(r2);
    const a1 = o1.domains.find(d => d.name === 'para1.example')!.identityProviderAlias!, a2 = o2.domains.find(d => d.name === 'para2.example')!.identityProviderAlias!;
    assert.notEqual(a1, a2);
    assert.deepEqual([kc.idps.get(a1)?.config.tenantId, kc.idps.get(a2)?.config.tenantId], [t1.id, t2.id], 'beide Anbieter bestehen, je mit ihrem Tenant');
    for (const a of ['para1', 'para2']) ok(await call(paula(), 'DELETE', `/v1/platform/organizations/${a}/entra`), 204);
  });

  test('erneut zustimmen (gleicher Tenant): Platz und gebundene Domänen bleiben, Anbieter nachgeführt; anderer Tenant 409', async () => {
    kc.idps.get('entra-001')!.config.clientSecret = 'veraltet';
    const r = ok(await connect(annaEntra(), '/v1/admin/entra', contoso, contoso.id));
    assert.deepEqual(r.connection.domains, ['demo.example', 'demoag.onmicrosoft.com', 'extra.example']);
    assert.deepEqual(r.members.filter((m: any) => m.linked).map((m: any) => m.email).sort(), ['anna@demo.example', 'olga@extra.example'], 'schon verknüpft');
    assert.equal(kc.idps.get('entra-001')!.config.clientSecret, 'entra-geheim');
    assert.equal(kc.idps.size, 2);
    assert.equal((await auditOf('demo', 'entra.reconnected')).length, 1);
    const other = ms.tenant('Anderer', ['anders.example']);
    assert.equal((await call(annaEntra(), 'POST', '/v1/admin/entra/consent', { tenant: other.id })).status, 409);
  });

  test('Domänen wählen: lösen entfernt selbst eingetragene Domänen, binden verknüpft neu; nur verifizierte', async () => {
    assert.equal((await call(annaEntra(), 'PUT', '/v1/admin/entra/domains', { domains: ['demo.example', 'nicht-verifiziert.example'] })).status, 422);
    const r = ok(await call(annaEntra(), 'PUT', '/v1/admin/entra/domains', { domains: ['demo.example'] }));
    assert.deepEqual(r.connection.domains, ['demo.example']);
    assert.ok(!demo.domains.some(d => d.name === 'extra.example'), 'selbst eingetragen → entfernt');
    const back = ok(await call(annaEntra(), 'PUT', '/v1/admin/entra/domains', { domains: ['demo.example', 'extra.example'] }));
    assert.deepEqual(back.members.map((m: any) => [m.email, m.linked]), [['olga@extra.example', true]], 'schon verknüpft zählt als verknüpft');
    assert.equal((await call(annaEntra(), 'PUT', '/v1/admin/entra/domains', { domains: ['demo.example', 'muster.example'] })).status, 409, 'Domäne einer anderen Organisation');
  });

  test('Aktualisieren: nicht mehr verifizierte Domäne gelöst, Anbieter mit aktuellem Geheimnis nachgeführt; Graph-Fehler → Status error', async () => {
    contoso.domains = contoso.domains.filter(d => d !== 'extra.example');
    kc.idps.get('entra-001')!.config.clientSecret = 'alt';
    const r = ok(await call(annaEntra(), 'POST', '/v1/admin/entra/refresh'));
    assert.deepEqual(r.connection.domains, ['demo.example']);
    assert.equal(kc.idps.get('entra-001')!.config.clientSecret, 'entra-geheim');
    contoso.consented = false;
    assert.equal((await call(annaEntra(), 'POST', '/v1/admin/entra/refresh')).status, 409);
    const s = ok(await call(annaEntra(), 'GET', '/v1/admin/entra'));
    assert.equal(s.connection.status, 'error');
    assert.match(s.connection.lastError, /Zustimmung|Token/);
    contoso.consented = true;
    const all = ok(await call(paula(), 'POST', '/v1/platform/entra/refresh'));
    assert.deepEqual([all.refreshed.sort(), all.failed], [['demo', 'muster'], []]);
  });

  test('Mitglied entfernen löst die Verknüpfung (sonst bliebe die Anmeldung über Entra)', async () => {
    const olga = kc.user('olga2', { email: 'olga2@demo.example', firstName: 'Olga', lastName: 'Zwei' });
    kc.member(demo, olga, ['viewer']);
    kc.links.set(olga.id, new Map([['entra-001', { userId: 'x', userName: 'olga2@demo.example' }]]));
    ok(await call(annaEntra(), 'DELETE', `/v1/admin/members/${olga.id}`));
    assert.equal(kc.links.get(olga.id)!.size, 0);
  });

  test('trennen: Anbieter samt Verknüpfungen gelöscht, Weiterleitung aufgehoben, Konten bleiben; danach wieder ohne Entra', async () => {
    ok(await call(annaEntra(), 'DELETE', '/v1/admin/entra'), 204);
    assert.ok(!kc.idps.has('entra-001'));
    assert.equal(kc.links.get(u.anna.id)!.size, 0);
    assert.ok(!demo.domains.some(d => d.identityProviderAlias || d.name === 'demo.example'), 'selbst eingetragene Domänen entfernt');
    assert.ok(kc.users.has(u.anna.id) && kc.orgMembers.get(demo.id)!.has(u.anna.id), 'Konto und Mitgliedschaft bleiben');
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.entra_connection c JOIN notes.tenant t ON t.id = c.tenant_id WHERE t.alias = 'demo'")).rows[0].n, 0);
    assert.equal((await auditOf('demo', 'entra.disconnected')).length, 1);
    ok(await call(anna(), 'GET', '/v1/admin/entra'), 200);
    assert.equal((await call(anna(), 'DELETE', '/v1/admin/entra')).status, 404);
    // Platz 1 ist wieder frei
    assert.equal((await t.inspect.query('SELECT app.entra_free_slot(5) AS a')).rows[0].a, 'entra-001');
  });
});
