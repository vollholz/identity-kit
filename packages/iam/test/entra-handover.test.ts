/**
 * Modul `entra`, Kit 0.2: Zustimmung über einen Link an die Entra-Administration (Spezifikation 9.4). Die org-admin
 * erzeugt einen Link; eine andere Person der Kunden-IT öffnet ihn ohne Sitzung und stimmt bei Microsoft zu. Gegen
 * Wegwerf-Datenbank, Mock-IdP, `KeycloakFake` und `EntraFake`.
 * Schwerpunkte: Rechte beim Erzeugen, Token nur als Hash, öffentliche Routen ohne Daten ausser Organisation und
 * Produkt, gleicher Nachweis wie beim eigenen Verbinden, Missbrauch (abgelaufen, widerrufen, doppelt eingelöst,
 * gleichzeitig, falscher Tenant, keine Admin-Rolle, Gast, verändertes Token), Mandantentrennung, Audit.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { EntraFake, KeycloakFake, startMockIdp, type FakeEntraUser, type FakeOrg, type FakeTenant, type FakeUser, type MockIdp } from '@vollholz/iam-testkit';
import { CONSENT_ADMIN_ROLES } from '../src/graph.ts';
import { skipDb } from './support/db.ts';
import { claims, notesApp, notesDb, type NotesApp } from './support/http.ts';

const skip = await skipDb();
type Res = { status: number; body: any; headers: Record<string, unknown> };
const ENTRA = { ENTRA_CLIENT_ID: '11111111-2222-3333-4444-555555555555', ENTRA_CLIENT_SECRET: 'entra-geheim' };
const GA = [CONSENT_ADMIN_ROLES[0]!];

describe('Link an die Entra-Administration', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, app: NotesApp;
  const kc = new KeycloakFake();
  const ms = new EntraFake();
  const u = {} as Record<'anna' | 'carla' | 'mona' | 'paula', FakeUser>;
  let demo: FakeOrg, contoso: FakeTenant, fremd: FakeTenant, ga: FakeEntraUser;
  const routeConfig = new Map<string, Record<string, unknown>>();

  const person = (x: FakeUser, org: string, roles: string[], extra: Record<string, unknown> = {}) =>
    idp.token({ ...claims.user({ sub: x.id, org, groupRoles: roles, email: x.email, name: `${x.firstName} ${x.lastName}` }), ...extra });
  async function call(who: string | Promise<string> | null, method: string, url: string, body?: unknown): Promise<Res> {
    const r = await app.app.inject({ method: method as 'GET', url, headers: who ? { authorization: `Bearer ${await who}` } : {}, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const anna = () => person(u.anna, 'demo', ['org-admin']);
  const mona = () => person(u.mona, 'muster', ['org-admin']);
  const paula = () => person(u.paula, 'ops', ['org-admin'], { realm_access: { roles: ['platform-admin'] } });
  const auditOf = async (action: string) => (await t.inspect.query<{ data: any; actor_name: string }>(
    "SELECT a.data, a.actor_name FROM notes.audit_log a JOIN notes.tenant t ON t.id = a.tenant_id WHERE t.alias = 'demo' AND a.action = $1 ORDER BY a.seq", [action])).rows;
  /** Neuer Link der Demo AG; liefert Token (aus dem Fragment) und Antwort. */
  const newLink = async (body: Record<string, unknown> = { tenant: 'demo.example' }, who = anna()) => {
    const r = ok(await call(who, 'POST', '/v1/admin/entra/consent-links', body), 201);
    return { ...r, token: new URL(r.url).hash.slice(1) as string };
  };
  /** Person der Kunden-IT: Link öffnen, starten, bei Microsoft zustimmen, Rückkehr (alles ohne Sitzung). */
  const viaLink = async (token: string, o: Parameters<EntraFake['approve']>[2] = { wids: GA }, who = ga) => {
    const start = ok(await call(null, 'POST', '/v1/entra/handover/start', { token }));
    return call(null, 'POST', '/v1/entra/handover/complete', ms.approve(start.url, who, o));
  };
  const linkRow = async (id: string) => (await t.inspect.query('SELECT * FROM notes.entra_consent_link WHERE id = $1', [id])).rows[0];

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    demo = kc.org('demo', 'Demo AG'); kc.org('muster', 'Muster GmbH'); const ops = kc.org('ops', 'Betrieb');
    u.anna = kc.user('anna', { email: 'anna@demo.example', firstName: 'Anna', lastName: 'Admin' });
    u.carla = kc.user('carla', { email: 'carla@demo.example', firstName: 'Carla', lastName: 'Leserin' });
    u.mona = kc.user('mona', { email: 'mona@muster.example', firstName: 'Mona', lastName: 'Muster' });
    u.paula = kc.user('paula', { email: 'paula@ops.example', firstName: 'Paula', lastName: 'Plattform' });
    kc.member(demo, u.anna, ['org-admin']); kc.member(demo, u.carla, ['viewer']);
    for (const alias of ['demo', 'muster', 'ops']) for (const r of ['org-admin', 'viewer']) kc.groupPath(`/orgs/${alias}/${r}`);
    kc.member(ops, u.paula, ['org-admin']);
    contoso = ms.tenant('Demo AG (Entra)', ['demo.example', 'demoag.onmicrosoft.com']);
    ms.user(contoso, 'anna@demo.example');
    ga = ms.user(contoso, 'it-admin@demoag.onmicrosoft.com', { displayName: 'Ivo IT' });
    fremd = ms.tenant('Fremd AG', ['fremd.example']);
    app = await notesApp({
      db: t.runtime, issuer: idp.issuer, keycloakFetch: kc.fetch, entraFetch: ms.fetch, entraRetryMs: [0],
      env: { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0', ...ENTRA },
      before: async a => { a.addHook('onRoute', r => { routeConfig.set(`${r.method} ${r.url}`, r.config as Record<string, unknown>); }); },
    });
    for (const tok of [anna(), mona(), paula()]) ok(await call(tok, 'GET', '/v1/me'));
  });
  after(async () => { await app?.app.close(); await idp?.close(); await t?.drop(); });
  // Jeder Test mit eigenen Links (höchstens 5 offene je Organisation)
  beforeEach(async () => { await t?.inspect.query('UPDATE notes.entra_consent_link SET revoked_at = now() WHERE used_at IS NULL AND revoked_at IS NULL'); });

  test('erzeugen: nur members:admin bzw. Plattform; Adresse mit Token im Fragment, gespeichert nur der Hash; Gültigkeit 5 Min. bis 24 Std.', async () => {
    assert.equal((await call(person(u.carla, 'demo', ['viewer']), 'POST', '/v1/admin/entra/consent-links', { tenant: 'demo.example' })).status, 403);
    assert.equal((await call(anna(), 'POST', '/v1/admin/entra/consent-links', { tenant: 'gibt-es-nicht.example' })).status, 422);
    for (const m of [4, 1441]) assert.equal((await call(anna(), 'POST', '/v1/admin/entra/consent-links', { tenant: 'demo.example', validMinutes: m })).status, 422, `${m}`);
    const l = await newLink({ tenant: 'demo.example', validMinutes: 60 });
    assert.match(l.url, /^http:\/\/api\.test\/verwalten\/anmeldung\/freigabe#demo\.[A-Za-z0-9_-]{43}$/);
    assert.equal(l.entraTenantId, contoso.id);
    assert.ok(Math.abs(new Date(l.expiresAt).getTime() - Date.now() - 3_600_000) < 60_000);
    const row = await linkRow(l.id);
    assert.equal(row.token_hash, createHash('sha256').update(l.token).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(l.token.split('.')[1]), 'Token nie im Klartext');
    assert.deepEqual([row.created_by_name, row.platform], ['Anna Admin', false]);
    assert.equal((await auditOf('entra.consent_link_created')).at(-1)!.data.linkId, l.id);
    const p = ok(await call(paula(), 'POST', '/v1/platform/organizations/demo/entra/consent-links', { tenant: contoso.id }), 201);
    assert.equal((await linkRow(p.id)).platform, true, 'Plattform im Auftrag');
  });

  test('öffentlich ohne Anmeldung: nur Organisation, Produkt, wer fragt, Verzeichnis und Ablauf; nie zwischengespeichert; unbekannt immer 404; Ratenbegrenzung je IP', async () => {
    const l = await newLink();
    const r = await call(null, 'POST', '/v1/entra/handover/info', { token: l.token });
    assert.deepEqual(Object.keys(ok(r)).sort(), ['entraTenantId', 'expiresAt', 'organization', 'product', 'requestedBy', 'tenant']);
    assert.deepEqual([r.body.organization, r.body.product], [(await t.inspect.query("SELECT name FROM notes.tenant WHERE alias = 'demo'")).rows[0].name, 'notes']);
    assert.deepEqual([r.body.requestedBy, r.body.tenant, r.body.entraTenantId], ['Anna Admin', 'demo.example', contoso.id], 'wer fragt und für welches Verzeichnis (gegen fremde Links)');
    assert.equal(r.headers['cache-control'], 'no-store');
    const bad = [`${l.token.slice(0, -1)}x`, l.token.replace(/^demo\./, 'muster.'), `gibtsnicht.${'a'.repeat(43)}`];
    for (const token of bad) assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token })).status, 404, token);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token: 'kurz' })).status, 422);
    for (const x of ['info', 'start', 'complete']) {
      const rl = routeConfig.get(`POST /v1/entra/handover/${x}`)?.rateLimit as { max: number; timeWindow: number; keyGenerator: (r: unknown) => string };
      assert.deepEqual([rl.max, rl.timeWindow, rl.keyGenerator({ ip: '1.2.3.4' })], [20, 60_000, 'notes:entra-handover:1.2.3.4'], x);
    }
  });

  test('Missbrauch vor dem Verbinden: falscher Tenant, keine Admin-Rolle, Gast, Ablehnung → 409, Link bleibt offen mit Fehler; nichts verbunden', async () => {
    const l = await newLink();
    const unproven = async (o: Parameters<EntraFake['approve']>[2], why: string) => {
      const r = await viaLink(l.token, o);
      assert.deepEqual([r.status, r.body.reason], [409, 'consent-unproven'], `${why}: ${JSON.stringify(r.body)}`);
    };
    await unproven({ wids: GA, claims: { tid: fremd.id } }, 'falscher Tenant');
    await unproven({ wids: ['b79fbf4d-3ef9-4689-8143-76b194e85509'] }, 'keine Admin-Rolle');
    await unproven({ wids: GA, guest: true }, 'Gast');
    const start = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l.token }));
    const state = new URL(start.url).searchParams.get('state')!;
    assert.match(state, /^h\.demo\./);
    const denied = await call(null, 'POST', '/v1/entra/handover/complete', { state, error: 'access_denied', errorDescription: 'AADSTS65004: declined' });
    assert.deepEqual([denied.status, denied.body.reason], [409, 'consent-error']);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/complete', { state, code: 'x' })).status, 404, 'state verbraucht');
    ok(await call(null, 'POST', '/v1/entra/handover/info', { token: l.token }), 200);
    const item = ok(await call(anna(), 'GET', '/v1/admin/entra/consent-links')).items.find((x: any) => x.id === l.id);
    assert.deepEqual([item.status, item.error.reason], ['failed', 'consent-error']);
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.entra_connection')).rows[0].n, 0);
    assert.ok((await auditOf('entra.consent_failed')).filter(a => a.data.viaLink === l.id).length >= 4, 'Fehlschläge im Protokoll');
  });

  test('Link für Tenant T, Zustimmung aus Tenant U: 409, nichts verbunden (tid des ID-Tokens = Tenant des Links)', async () => {
    const l = await newLink();
    const u2 = ms.user(fremd, 'ga@fremd.example', { displayName: 'Fremde Administration' });
    // a) ID-Token aus U für den Code aus T
    const a = await viaLink(l.token, { wids: GA, claims: { tid: fremd.id } }, u2);
    assert.deepEqual([a.status, a.body.reason], [409, 'consent-unproven']);
    assert.match(a.body.detail, /anderen Tenant/);
    // b) Anmeldung in U (Adresse auf U umgeschrieben): der Code aus U lässt sich am Token-Endpunkt von T nicht einlösen
    const start = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l.token }));
    const back = ms.approve(start.url.replace(contoso.id, fremd.id), u2, { wids: GA });
    const b = await call(null, 'POST', '/v1/entra/handover/complete', back);
    assert.deepEqual([b.status, b.body.reason], [409, 'consent-unproven']);
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.entra_connection')).rows[0].n, 0);
  });

  test('höchstens 5 offene Links je Organisation (409 too-many-links); Ratenbegrenzung beim Erzeugen', async () => {
    const links = [];
    for (let i = 0; i < 5; i++) links.push(await newLink());
    const sixth = await call(anna(), 'POST', '/v1/admin/entra/consent-links', { tenant: 'demo.example' });
    assert.deepEqual([sixth.status, sixth.body.reason], [409, 'too-many-links']);
    assert.equal((await call(anna(), 'DELETE', `/v1/admin/entra/consent-links/${links[0].id}`)).status, 204);
    await newLink();
    for (const path of ['/v1/admin/entra/consent-links', '/v1/platform/organizations/:alias/entra/consent-links']) {
      const rl = routeConfig.get(`POST ${path}`)?.rateLimit as { max: number; timeWindow: number; keyGenerator: (r: unknown) => string };
      assert.deepEqual([rl.max, rl.timeWindow, rl.keyGenerator({ principal: { tenantId: 't1', subject: 's1' }, ip: '1.2.3.4' })], [10, 60_000, 'notes:entra-link:t1:s1'], path);
    }
  });

  test('abgelaufen und widerrufen: 404 auch für einen schon gestarteten state; widerrufen nur offene', async () => {
    const old = await newLink();
    const start = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: old.token }));
    await t.inspect.query("UPDATE notes.entra_consent_link SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1", [old.id]);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token: old.token })).status, 404);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/start', { token: old.token })).status, 404);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/complete', ms.approve(start.url, ga, { wids: GA }))).status, 404, 'Rückkehr nach Ablauf');
    const rev = await newLink();
    const s2 = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: rev.token }));
    assert.equal((await call(anna(), 'DELETE', `/v1/admin/entra/consent-links/${rev.id}`)).status, 204);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token: rev.token })).status, 404);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/complete', ms.approve(s2.url, ga, { wids: GA }))).status, 404, 'gestartet vor dem Widerruf');
    assert.equal((await call(anna(), 'DELETE', `/v1/admin/entra/consent-links/${randomUUID()}`)).status, 404);
    const statuses = Object.fromEntries(ok(await call(anna(), 'GET', '/v1/admin/entra/consent-links')).items.map((x: any) => [x.id, x.status]));
    assert.deepEqual([statuses[old.id], statuses[rev.id]], ['expired', 'revoked']);
    assert.equal((await auditOf('entra.consent_link_revoked')).at(-1)!.data.linkId, rev.id);
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.entra_connection')).rows[0].n, 0);
  });

  test('Mandantentrennung: andere Organisation sieht die Links nicht und widerruft sie nicht', async () => {
    const l = await newLink();
    assert.ok(!ok(await call(mona(), 'GET', '/v1/admin/entra/consent-links')).items.some((x: any) => x.id === l.id));
    assert.equal((await call(mona(), 'DELETE', `/v1/admin/entra/consent-links/${l.id}`)).status, 404);
    assert.equal((await call(mona(), 'GET', '/v1/platform/organizations/demo/entra/consent-links')).status, 403, 'ohne Plattform-Administration');
    assert.equal((await linkRow(l.id)).revoked_at, null);
  });

  test('verbinden über den Link: Nachweis wie beim eigenen Verbinden, im Namen der Erzeugerin, zustimmende Person im Protokoll; danach eingelöst', async () => {
    const l = await newLink();
    const start = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l.token }));
    const url = new URL(start.url);
    assert.deepEqual([url.pathname, url.searchParams.get('prompt'), url.searchParams.get('redirect_uri')], [`/${contoso.id}/oauth2/v2.0/authorize`, 'admin_consent', 'http://api.test/verwalten/anmeldung/zustimmung']);
    const back = ms.approve(start.url, ga, { wids: GA });
    const r = ok(await call(null, 'POST', '/v1/entra/handover/complete', back));
    assert.deepEqual(r, { organization: 'Demo AG', connected: true });
    assert.equal((await t.inspect.query('SELECT entra_tenant_id::text AS t FROM notes.entra_connection')).rows[0].t, contoso.id);
    const a = (await auditOf('entra.connected')).at(-1)!;
    assert.deepEqual([a.actor_name, a.data.consentBy.name, a.data.viaLink, a.data.linkCreatedBy], ['Anna Admin', 'Ivo IT', l.id, 'Anna Admin']);
    const item = ok(await call(anna(), 'GET', '/v1/admin/entra/consent-links')).items.find((x: any) => x.id === l.id);
    assert.deepEqual([item.status, item.approverName, item.error], ['connected', 'Ivo IT', null]);
    assert.ok(ok(await call(anna(), 'GET', '/v1/admin/entra')).connection, 'org-admin sieht «verbunden»');
    // doppelt eingelöst: Link und state verbraucht
    assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token: l.token })).status, 404);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/start', { token: l.token })).status, 404);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/complete', back)).status, 404);
    assert.equal((await call(anna(), 'DELETE', `/v1/admin/entra/consent-links/${l.id}`)).status, 409, 'eingelöst nicht widerrufbar');
  });

  test('gleichzeitig zweimal eingelöst: nur eine Rückkehr verbindet', async () => {
    const l = await newLink();
    const [s1, s2] = [ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l.token })), ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l.token }))];
    const res = await Promise.all([s1, s2].map(s => call(null, 'POST', '/v1/entra/handover/complete', ms.approve(s.url, ga, { wids: GA }))));
    assert.deepEqual(res.map(x => x.status).sort(), [200, 404]);
    assert.equal((await auditOf('entra.reconnected')).filter(a => a.data.viaLink === l.id).length, 1);
  });

  test('mit einem anderen Tenant verbunden: Link für einen anderen Tenant 409', async () => {
    assert.equal((await call(anna(), 'POST', '/v1/admin/entra/consent-links', { tenant: fremd.id })).status, 409);
  });
});
