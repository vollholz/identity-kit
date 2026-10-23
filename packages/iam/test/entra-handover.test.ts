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
  const u = {} as Record<'anna' | 'carla' | 'mona' | 'paula' | 'otto', FakeUser>;
  let demo: FakeOrg, contoso: FakeTenant, fremd: FakeTenant, ga: FakeEntraUser;
  const routeConfig = new Map<string, Record<string, unknown>>();
  /** Vor jedem Aufruf bei Microsoft (Adresse), z. B. um mitten im Nachweis den Link zu widerrufen. */
  let onEntra: ((url: string) => Promise<void>) | null = null;

  const person = (x: FakeUser, org: string, roles: string[], extra: Record<string, unknown> = {}) =>
    idp.token({ ...claims.user({ sub: x.id, org, groupRoles: roles, email: x.email, name: `${x.firstName} ${x.lastName}` }), ...extra });
  async function call(who: string | Promise<string> | null, method: string, url: string, body?: unknown): Promise<Res> {
    const r = await app.app.inject({ method: method as 'GET', url, headers: who ? { authorization: `Bearer ${await who}` } : {}, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const anna = () => person(u.anna, 'demo', ['org-admin']);
  const otto = () => person(u.otto, 'demo', ['org-admin']);
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
    u.otto = kc.user('otto', { email: 'otto@demo.example', firstName: 'Otto', lastName: 'Zweit' });
    u.paula = kc.user('paula', { email: 'paula@ops.example', firstName: 'Paula', lastName: 'Plattform' });
    kc.member(demo, u.anna, ['org-admin']); kc.member(demo, u.carla, ['viewer']); kc.member(demo, u.otto, ['org-admin']);
    for (const alias of ['demo', 'muster', 'ops']) for (const r of ['org-admin', 'viewer']) kc.groupPath(`/orgs/${alias}/${r}`);
    kc.member(ops, u.paula, ['org-admin']);
    kc.realmRoleMappings.set(u.paula.id, new Set(['platform-admin']));
    contoso = ms.tenant('Demo AG (Entra)', ['demo.example', 'demoag.onmicrosoft.com']);
    ms.user(contoso, 'anna@demo.example');
    ga = ms.user(contoso, 'it-admin@demoag.onmicrosoft.com', { displayName: 'Ivo IT' });
    fremd = ms.tenant('Fremd AG', ['fremd.example']);
    app = await notesApp({
      db: t.runtime, issuer: idp.issuer, keycloakFetch: kc.fetch, entraFetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => { await onEntra?.(String(input instanceof Request ? input.url : input)); return ms.fetch(input, init); }) as typeof fetch, entraRetryMs: [0],
      env: { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0', ...ENTRA },
      before: async a => { a.addHook('onRoute', r => { routeConfig.set(`${r.method} ${r.url}`, r.config as Record<string, unknown>); }); },
    });
    for (const tok of [anna(), otto(), mona(), paula()]) ok(await call(tok, 'GET', '/v1/me'));
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
    assert.deepEqual(Object.keys(ok(r)).sort(), ['entraTenantId', 'expiresAt', 'notice', 'organization', 'product', 'requestedBy', 'tenant']);
    assert.deepEqual([r.body.organization, r.body.product], [(await t.inspect.query("SELECT name FROM notes.tenant WHERE alias = 'demo'")).rows[0].name, 'notes']);
    assert.deepEqual([r.body.requestedBy, r.body.tenant, r.body.entraTenantId], ['Anna Admin', 'demo.example', contoso.id], 'wer fragt und für welches Verzeichnis (gegen fremde Links)');
    assert.equal(r.headers['cache-control'], 'no-store');
    const bad = [`${l.token.slice(0, -1)}x`, l.token.replace(/^demo\./, 'muster.'), `gibtsnicht.${'a'.repeat(43)}`];
    for (const token of bad) assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token })).status, 404, token);
    for (const token of [`${l.token}x`, `Demo.${l.token.split('.')[1]}`, `${l.token.slice(0, -1)}=`]) assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token })).status, 422, `Format: ${token}`);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token: 'kurz' })).status, 422);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token: `x.${'a'.repeat(43)}` })).status, 404, 'Alias mit einem Zeichen: Token mit 45 Zeichen gültig geformt');
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
    assert.equal(ok(await call(anna(), 'GET', '/v1/admin/entra/consent-links')).items.find((x: any) => x.id === rev.id).error, null, 'von Hand widerrufen: ohne Grund');
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

  test('verbinden über den Link: Nachweis wie beim eigenen Verbinden, im Namen der erzeugenden Person, zustimmende Person im Protokoll; danach eingelöst', async () => {
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
    assert.equal((await auditOf('entra.consent_started')).at(-1)!.data.viaLink, l.id, 'Start im Protokoll');
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

  test('Abbruch mitten in der Einlösung: Link nur mit Frist belegt, nicht eingelöst; nach der Frist wieder einlösbar', async () => {
    const l = await newLink();
    const s1 = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l.token }));
    // Prozess bricht nach dem Belegen ab (Zustand wie nach dem Belegen, ohne Nachweis und ohne Freigabe)
    const state1 = new URL(s1.url).searchParams.get('state')!;
    await t.inspect.query("UPDATE notes.entra_consent SET used_at = now() WHERE state_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [state1]);
    await t.inspect.query('UPDATE notes.entra_consent_link SET claimed_at = now() WHERE id = $1', [l.id]);
    const item = ok(await call(anna(), 'GET', '/v1/admin/entra/consent-links')).items.find((x: any) => x.id === l.id);
    assert.equal(item.status, 'in-progress', 'belegt, nicht «verbunden»');
    const s2 = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l.token }));
    assert.equal((await call(null, 'POST', '/v1/entra/handover/complete', ms.approve(s2.url, ga, { wids: GA }))).status, 404, 'während der Frist belegt');
    assert.equal((await call(anna(), 'DELETE', `/v1/admin/entra/consent-links/${l.id}`)).status, 204, 'widerrufbar');
    const l2 = await newLink();
    const s3 = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l2.token }));
    await t.inspect.query("UPDATE notes.entra_consent_link SET claimed_at = now() - interval '6 minutes' WHERE id = $1", [l2.id]);
    ok(await call(null, 'POST', '/v1/entra/handover/complete', ms.approve(s3.url, ga, { wids: GA })));
    const done = await linkRow(l2.id);
    assert.ok(done.used_at && done.claimed_at === null, 'nach der Frist wieder frei, eingelöst erst nach Erfolg');
  });

  test('mit einem anderen Tenant verbunden: Link für einen anderen Tenant 409', async () => {
    assert.equal((await call(anna(), 'POST', '/v1/admin/entra/consent-links', { tenant: fremd.id })).status, 409);
  });

  test('Liste: alle offenen und die letzten 20 erledigten Links; erledigte nach 90 Tagen gelöscht', async () => {
    const open = await newLink();
    await t.inspect.query("UPDATE notes.entra_consent_link SET created_at = now() - interval '1 hour' WHERE id = $1", [open.id]);
    await t.inspect.query(`INSERT INTO notes.entra_consent_link (tenant_id, token_hash, entra_tenant_id, tenant_input, platform, created_by, created_by_subject, created_by_name, created_by_tenant, created_at, expires_at, revoked_at)
      SELECT tenant_id, md5(random()::text || g), entra_tenant_id, tenant_input, platform, created_by, created_by_subject, created_by_name, created_by_tenant, now() - interval '10 minutes' + g * interval '1 second', now() + interval '1 hour', now()
        FROM notes.entra_consent_link, generate_series(1, 22) g WHERE id = $1`, [open.id]);
    const items = ok(await call(anna(), 'GET', '/v1/admin/entra/consent-links')).items as any[];
    assert.ok(items.some(x => x.id === open.id), 'offener Link trotz 22 neueren erledigten');
    assert.equal(items.filter(x => x.status !== 'open').length, 20);
    const old = (await t.inspect.query(`INSERT INTO notes.entra_consent_link (tenant_id, token_hash, entra_tenant_id, tenant_input, platform, created_by, created_by_subject, created_by_name, created_by_tenant, created_at, expires_at)
      SELECT tenant_id, md5(random()::text), entra_tenant_id, tenant_input, platform, created_by, created_by_subject, created_by_name, created_by_tenant, now() - interval '100 days', now() - interval '100 days' + interval '15 minutes'
        FROM notes.entra_consent_link WHERE id = $1 RETURNING id`, [open.id])).rows[0].id;
    await newLink();
    assert.equal(await linkRow(old), undefined, 'alt: gelöscht');
    assert.ok(await linkRow(open.id));
  });

  test('Rechte ausserhalb der App entzogen (Keycloak): beim Start und bei der Rückkehr 404, Link widerrufen, nichts verbunden', async () => {
    const adminGroup = kc.groupPath('/orgs/demo/org-admin').id;
    const a = await newLink(undefined, otto());
    kc.userGroups.get(u.otto.id)!.delete(adminGroup);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/start', { token: a.token })).status, 404, 'Start');
    assert.ok((await linkRow(a.id)).revoked_at);
    assert.equal((await auditOf('entra.consent_link_revoked')).at(-1)!.data.reason, 'creator-lost-access');
    kc.userGroups.get(u.otto.id)!.add(adminGroup);
    const b = await newLink(undefined, otto());
    const start = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: b.token }));
    kc.userGroups.get(u.otto.id)!.delete(adminGroup);
    try {
      assert.equal((await call(null, 'POST', '/v1/entra/handover/complete', ms.approve(start.url, ga, { wids: GA }))).status, 404, 'Rückkehr');
    } finally { kc.userGroups.get(u.otto.id)!.add(adminGroup); }
    const row = await linkRow(b.id);
    assert.ok(row.revoked_at && !row.used_at);
    assert.equal((await auditOf('entra.reconnected')).filter(x => x.data.viaLink === b.id).length, 0);
  });

  test('erzeugende Person verliert members:admin oder wird entfernt: ihre offenen Links verfallen sofort (creator-lost-access)', async () => {
    const a = await newLink(undefined, otto());
    const keep = await newLink();
    ok(await call(paula(), 'PUT', `/v1/platform/organizations/demo/members/${u.otto.id}/roles`, { roles: ['viewer'] }));
    assert.ok((await linkRow(a.id)).revoked_at, 'zurückgestuft: widerrufen');
    const shown = ok(await call(anna(), 'GET', '/v1/admin/entra/consent-links')).items.find((x: any) => x.id === a.id);
    assert.deepEqual([shown.status, shown.error?.reason], ['revoked', 'creator-lost-access']);
    assert.equal((await linkRow(keep.id)).revoked_at, null, 'Links anderer Personen bleiben');
    const ev = (await auditOf('entra.consent_link_revoked')).at(-1)!;
    assert.deepEqual([ev.data.linkIds, ev.data.reason], [[a.id], 'creator-lost-access']);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token: a.token })).status, 404);
    ok(await call(paula(), 'PUT', `/v1/platform/organizations/demo/members/${u.otto.id}/roles`, { roles: ['org-admin'] }));
    const b = await newLink(undefined, otto());
    ok(await call(paula(), 'PUT', `/v1/platform/organizations/demo/members/${u.otto.id}/roles`, { roles: ['org-admin', 'viewer'] }));
    assert.equal((await linkRow(b.id)).revoked_at, null, 'weiter org-admin: bleibt');
    const removed = await call(paula(), 'DELETE', `/v1/platform/organizations/demo/members/${u.otto.id}`);
    assert.ok(removed.status < 300, JSON.stringify(removed.body));
    assert.ok((await linkRow(b.id)).revoked_at, 'entfernt: widerrufen');
  });

  test('Plattform-Link: verbindet im Namen der Plattform-Administration; ohne Realm-Rolle 404 und widerrufen', async () => {
    const create = async () => {
      const r = ok(await call(paula(), 'POST', '/v1/platform/organizations/demo/entra/consent-links', { tenant: contoso.id }), 201);
      return { ...r, token: new URL(r.url).hash.slice(1) as string };
    };
    const p = await create();
    ok(await viaLink(p.token));
    const a = (await auditOf('entra.reconnected')).at(-1)!;
    assert.deepEqual([a.actor_name, a.data.viaLink, a.data.consentBy.name], ['Paula Plattform', p.id, 'Ivo IT']);
    const q = await create();
    kc.realmRoleMappings.set(u.paula.id, new Set());
    try {
      assert.equal((await call(null, 'POST', '/v1/entra/handover/start', { token: q.token })).status, 404);
    } finally { kc.realmRoleMappings.set(u.paula.id, new Set(['platform-admin'])); }
    assert.ok((await linkRow(q.id)).revoked_at);
  });

  test('falscher state: Alias getauscht, o./p.-state an handover/complete, h.-state an consent/complete → 404; der richtige Weg geht danach', async () => {
    const l = await newLink();
    const start = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l.token }));
    const back = ms.approve(start.url, ga, { wids: GA });
    assert.equal((await call(null, 'POST', '/v1/entra/handover/complete', { ...back, state: back.state.replace(/^h\.demo\./, 'h.muster.') })).status, 404, 'Alias getauscht');
    for (const pre of ['o.', 'p.']) assert.equal((await call(null, 'POST', '/v1/entra/handover/complete', { ...back, state: back.state.replace(/^h\./, pre) })).status, 404, pre);
    assert.equal((await call(anna(), 'POST', '/v1/admin/entra/consent/complete', back)).status, 404, 'h.-state an consent/complete');
    assert.equal((await call(paula(), 'POST', '/v1/platform/organizations/demo/entra/consent/complete', back)).status, 404, 'h.-state an die Plattform');
    ok(await call(null, 'POST', '/v1/entra/handover/complete', back));
    assert.ok((await linkRow(l.id)).used_at);
  });

  test('während des Nachweises widerrufen: nichts verbunden, Link nicht eingelöst', async () => {
    const l = await newLink();
    const start = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l.token }));
    onEntra = async url => {
      if (!url.includes('/oauth2/v2.0/token')) return;
      onEntra = null;
      assert.equal((await call(anna(), 'DELETE', `/v1/admin/entra/consent-links/${l.id}`)).status, 204);
    };
    try {
      const r = await call(null, 'POST', '/v1/entra/handover/complete', ms.approve(start.url, ga, { wids: GA }));
      assert.equal(r.status, 404, JSON.stringify(r.body));
    } finally { onEntra = null; }
    const row = await linkRow(l.id);
    assert.ok(row.revoked_at && !row.used_at && !row.approver_name);
    assert.equal((await auditOf('entra.reconnected')).filter(x => x.data.viaLink === l.id).length, 0);
  });

  test('gesperrte Organisation: Link gilt nicht (404); nach dem Entsperren wieder', async () => {
    const l = await newLink();
    const s1 = await call(paula(), 'POST', '/v1/platform/organizations/demo/suspend', {});
    assert.ok(s1.status < 300, JSON.stringify(s1.body));
    try {
      assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token: l.token })).status, 404);
      assert.equal((await call(null, 'POST', '/v1/entra/handover/start', { token: l.token })).status, 404);
    } finally { assert.ok((await call(paula(), 'POST', '/v1/platform/organizations/demo/resume', {})).status < 300); }
    ok(await call(null, 'POST', '/v1/entra/handover/info', { token: l.token }));
  });

  test('Alias mit einem Zeichen: Token mit 45 Zeichen, Link funktioniert', async () => {
    const org = kc.org('a', 'A AG');
    const ada = kc.user('ada', { email: 'ada@a.example', firstName: 'Ada', lastName: 'A' });
    kc.member(org, ada, ['org-admin']);
    for (const r of ['org-admin', 'viewer']) kc.groupPath(`/orgs/a/${r}`);
    const who = person(ada, 'a', ['org-admin']);
    ok(await call(who, 'GET', '/v1/me'));
    const l = await newLink({ tenant: fremd.id }, who);
    assert.equal(l.token.length, 45);
    assert.match(l.token, /^a\./);
    const info = ok(await call(null, 'POST', '/v1/entra/handover/info', { token: l.token }));
    assert.equal(info.requestedBy, 'Ada A');
    ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l.token }));
  });

  test('Alias in Keycloak mit Grossbuchstaben: Token und states mit kanonischem Alias, Links und eigenes Verbinden funktionieren', async () => {
    const org = kc.org('Gross', 'Gross AG');
    const gina = kc.user('gina', { email: 'gina@gross.example', firstName: 'Gina', lastName: 'Gross' });
    kc.member(org, gina, ['org-admin']);
    for (const r of ['org-admin', 'viewer']) kc.groupPath(`/orgs/Gross/${r}`);
    const who = person(gina, 'gross', ['org-admin']);
    ok(await call(who, 'GET', '/v1/me'));
    const l = await newLink({ tenant: fremd.id }, who);
    assert.match(l.token, /^gross\./);
    ok(await call(null, 'POST', '/v1/entra/handover/info', { token: l.token }));
    const start = ok(await call(null, 'POST', '/v1/entra/handover/start', { token: l.token }));
    assert.match(new URL(start.url).searchParams.get('state')!, /^h\.gross\./);
    const own = ok(await call(who, 'POST', '/v1/admin/entra/consent', { tenant: fremd.id }));
    const state = new URL(own.url).searchParams.get('state')!;
    assert.match(state, /^o\.gross\./);
    const r = await call(who, 'POST', '/v1/admin/entra/consent/complete', { state, error: 'access_denied', errorDescription: 'AADSTS65004' });
    assert.deepEqual([r.status, r.body.reason], [409, 'consent-error'], 'state gehört zur Organisation (nicht 404)');
  });

  test('RATE_LIMIT_NAMESPACE: Vorsatz vor allen Rate-Limit-Schlüsseln des Pakets', async () => {
    const seen = new Map<string, { keyGenerator: (r: unknown) => string }>();
    const e2e = await notesApp({
      db: t.runtime, issuer: idp.issuer, keycloakFetch: kc.fetch, entraFetch: ms.fetch,
      env: { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', ...ENTRA, RATE_LIMIT_NAMESPACE: 'e2e' },
      before: async a => { a.addHook('onRoute', r => { const rl = (r.config as { rateLimit?: { keyGenerator: (r: unknown) => string } } | undefined)?.rateLimit; if (rl) seen.set(`${r.method} ${r.url}`, rl); }); },
    });
    try {
      const req = { principal: { tenantId: 't1', subject: 's1' }, ip: '1.2.3.4' };
      assert.equal(seen.get('POST /v1/entra/handover/info')!.keyGenerator(req), 'e2e:notes:entra-handover:1.2.3.4');
      assert.equal(seen.get('POST /v1/admin/entra/consent-links')!.keyGenerator(req), 'e2e:notes:entra-link:t1:s1');
      assert.equal(seen.get('GET /v1/admin/members/entra-search')!.keyGenerator(req), 'e2e:notes:entra-search:t1:s1');
    } finally { await e2e.app.close(); }
  });

  test('Trennen: offene Links verfallen', async () => {
    const l = await newLink();
    assert.equal((await call(anna(), 'DELETE', '/v1/admin/entra')).status, 204);
    assert.ok((await linkRow(l.id)).revoked_at);
    assert.equal((await call(null, 'POST', '/v1/entra/handover/info', { token: l.token })).status, 404);
    const shown = ok(await call(anna(), 'GET', '/v1/admin/entra/consent-links')).items.find((x: any) => x.id === l.id);
    assert.deepEqual([shown.status, shown.error?.reason], ['revoked', 'disconnected']);
  });
});
