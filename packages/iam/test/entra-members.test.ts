/**
 * Modul `entra`: Personen aus Microsoft Entra ID vorab hinzufügen (aus Assets test/platform/entra-members.test.ts,
 * produktneutral mit der Beispiel-App «notes») gegen Wegwerf-Datenbank, Mock-IdP, den `KeycloakFake` des Test-Kits und
 * das nachgebildete Microsoft (support/entra-fake.ts).
 * Schwerpunkte: Suche nur im eigenen Tenant und ohne Hinweis auf andere Organisationen, Person in Graph neu gelesen
 * (Regel notLinkable), Konto ohne Passwort bzw. bestehendes Konto, Verknüpfung über die Objekt-ID (409 bei fremder
 * Verknüpfung), gleiche Antwort für neue und bestehende Konten, «eingeladen» bis zum ersten Zugriff, E-Mail von Keycloak
 * mit Weiterleitung zur Anmeldung über Microsoft, erneut senden, zurückziehen, Rücknahme bei Fehlern, «Nur Entra».
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { KeycloakFake, startMockIdp, type FakeOrg, type FakeUser, type MockIdp } from '@vollholz/iam-testkit';
import { entraAddress } from '../src/admin.ts';
import { skipDb } from './support/db.ts';
import { EntraFake, type FakeTenant } from './support/entra-fake.ts';
import { claims, notesApp, notesDb, type NotesApp } from './support/http.ts';

const skip = await skipDb();

type Res = { status: number; body: any };
const ENTRA = { ENTRA_CLIENT_ID: '11111111-2222-3333-4444-555555555555', ENTRA_CLIENT_SECRET: 'entra-geheim' };

describe('Personen aus Entra ID: Regeln ohne Datenbank', () => {
  test('Adresse des Kontos: mail in gebundener Domäne, sonst UPN (klein geschrieben)', () => {
    const u = { id: 'a', userPrincipalName: 'Anna@Demo.onmicrosoft.com', mail: 'Anna.Admin@Demo.example', displayName: null, givenName: null, surname: null, userType: 'Member', accountEnabled: true };
    assert.equal(entraAddress(u, ['demo.example']), 'anna.admin@demo.example');
    assert.equal(entraAddress(u, ['demo.onmicrosoft.com']), 'anna@demo.onmicrosoft.com');
    assert.equal(entraAddress({ ...u, mail: null }, ['demo.example']), 'anna@demo.onmicrosoft.com');
  });
});

describe('Personen aus Microsoft Entra ID hinzufügen', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, app: NotesApp;
  const kc = new KeycloakFake();
  const ms = new EntraFake();
  const u = {} as Record<'anna' | 'berta' | 'carl' | 'mona', FakeUser>;
  let demo: FakeOrg, muster: FakeOrg, contoso: FakeTenant;
  const oid = {} as Record<'anna' | 'berta' | 'neu' | 'neu2' | 'gast' | 'aus' | 'fremd' | 'carl' | 'dora', string>;

  const person = (x: { id: string; email: string; firstName?: string; lastName?: string }, org: string, roles: string[], extra: Record<string, unknown> = {}) =>
    idp.token({ ...claims.user({ sub: x.id, org, groupRoles: roles, email: x.email, name: `${x.firstName ?? ''} ${x.lastName ?? ''}`.trim() || x.email }), ...extra });
  async function call(who: string | Promise<string>, method: string, url: string, body?: unknown): Promise<Res> {
    const r = await app.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${await who}` }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const auditOf = async (alias: string, action: string) => (await t.inspect.query<{ data: any }>(
    'SELECT a.data FROM notes.audit_log a JOIN notes.tenant t ON t.id = a.tenant_id WHERE t.alias = $1 AND a.action = $2 ORDER BY a.seq', [alias, action])).rows;
  const anna = () => person(u.anna, 'demo', ['org-admin'], { identity_provider: 'entra-001' });
  const paula = () => idp.token({ ...claims.user({ sub: 'paula', org: 'ops', groupRoles: ['org-admin'], email: 'paula@ops.example', name: 'Paula Plattform' }), realm_access: { roles: ['platform-admin'] } });
  const search = async (q: string, who = anna()) => ok(await call(who, 'GET', `/v1/admin/members/entra-search?q=${encodeURIComponent(q)}`));
  const add = (id: string, roles: string[] = ['viewer'], extra: Record<string, unknown> = {}, who = anna()) => call(who, 'POST', '/v1/admin/members/entra', { id, roles, ...extra });
  const routeConfig = new Map<string, Record<string, unknown>>();
  const list = async () => ok(await call(anna(), 'GET', '/v1/admin/members')).items as any[];

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    demo = kc.org('demo', 'Demo AG'); muster = kc.org('muster', 'Muster GmbH'); kc.org('ops', 'Betrieb');
    u.anna = kc.user('anna', { email: 'anna@demo.example', firstName: 'Anna', lastName: 'Admin' });
    // Berta hat schon ein Konto (Mitglied von Muster) mit Passwort; die Adresse liegt in der Domäne der Demo AG
    u.berta = kc.user('berta', { email: 'berta@demo.example', firstName: 'Berta', lastName: 'Beraterin' });
    u.mona = kc.user('mona', { email: 'mona@muster.example', firstName: 'Mona', lastName: 'Muster' });
    kc.member(demo, u.anna, ['org-admin']); kc.member(muster, u.berta, ['viewer']); kc.member(muster, u.mona, ['org-admin']);
    for (const alias of ['demo', 'muster']) for (const r of ['org-admin', 'viewer', 'editor']) kc.groupPath(`/orgs/${alias}/${r}`);
    kc.smtp = true;

    contoso = ms.tenant('Demo AG (Entra)', ['demo.example', 'demoag.onmicrosoft.com', 'frei.example']);
    oid.anna = ms.user(contoso, 'anna@demo.example', { displayName: 'Anna Admin' }).id;
    oid.berta = ms.user(contoso, 'berta@demo.example', { displayName: 'Berta Beraterin', givenName: 'Berta', surname: 'Beraterin', department: 'Beratung' }).id;
    oid.neu = ms.user(contoso, 'nina.neu@demoag.onmicrosoft.com', { mail: 'nina.neu@demo.example', displayName: 'Nina Neu', givenName: 'Nina', surname: 'Neu', jobTitle: 'Planerin' }).id;
    oid.neu2 = ms.user(contoso, 'noah.neu@demo.example', { displayName: 'Noah Neu', givenName: 'Noah', surname: 'Neu' }).id;
    oid.gast = ms.user(contoso, 'nora_gmail.example#EXT#@demoag.onmicrosoft.com', { mail: 'nora@gmail.example', displayName: 'Nora Gast', userType: 'Guest' }).id;
    oid.aus = ms.user(contoso, 'norbert@demo.example', { displayName: 'Norbert Aus', accountEnabled: false }).id;
    oid.fremd = ms.user(contoso, 'nils@anders.example', { mail: 'nils@anders.example', displayName: 'Nils Anders' }).id;
    oid.carl = ms.user(contoso, 'carl@demo.example', { displayName: 'Carl Verknüpft' }).id;
    oid.dora = ms.user(contoso, 'dora@demo.example', { displayName: 'Dora Fehler', givenName: 'Dora' }).id;

    const base = { KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' };
    // Wie Assets: unbekannte Felder im Body ablehnen (422) statt still entfernen (Einstellung der App); Optionen der Routen
    // für @fastify/rate-limit festhalten (das Plugin registriert die App)
    app = await notesApp({
      db: t.runtime, issuer: idp.issuer, env: { ...base, ...ENTRA }, keycloakFetch: kc.fetch, entraFetch: ms.fetch, entraRetryMs: [0],
      fastify: { ajv: { customOptions: { removeAdditional: false } } },
      before: async a => { a.addHook('onRoute', r => { routeConfig.set(`${r.method} ${r.url}`, r.config as Record<string, unknown>); }); },
    });
    for (const tok of [anna(), paula(), person(u.mona, 'muster', ['org-admin'])]) ok(await call(tok, 'GET', '/v1/me'));
    // Verbinden (Stufe pending) wie in Teil 1; frei.example bleibt ungebunden
    const s = ok(await call(anna(), 'POST', '/v1/admin/entra/consent', { tenant: contoso.id }));
    contoso.consented = true;
    ok(await call(anna(), 'POST', '/v1/admin/entra/consent/complete', { state: new URL(s.url).searchParams.get('state'), tenant: contoso.id }));
    ok(await call(anna(), 'PUT', '/v1/admin/entra/domains', { domains: ['demo.example', 'demoag.onmicrosoft.com'] }));
  });
  after(async () => { await app?.app.close(); await idp?.close(); await t?.drop(); });

  test('Suche: nur verbundene Organisation, nur org-admin bzw. Plattform, Mindestlänge; ConsistencyLevel für $search', async () => {
    assert.equal((await call(person(u.mona, 'muster', ['org-admin']), 'GET', '/v1/admin/members/entra-search?q=nina')).body.reason, 'entra-not-connected');
    assert.equal((await call(person(u.anna, 'demo', ['viewer']), 'GET', '/v1/admin/members/entra-search?q=nina')).status, 403);
    assert.equal((await call(anna(), 'GET', '/v1/admin/members/entra-search?q=n')).status, 422);
    assert.equal((await call(anna(), 'GET', `/v1/admin/members/entra-search?q=${encodeURIComponent('"" \\')}`)).status, 422, 'nur Anführungszeichen');
    const r = await search('nina');
    assert.deepEqual(r.items.map((x: any) => [x.id, x.name, x.email, x.jobTitle, x.selectable, x.reason]), [[oid.neu, 'Nina Neu', 'nina.neu@demo.example', 'Planerin', true, null]]);
    assert.equal(r.more, false);
    assert.match(ms.searches.at(-1)!, /^"displayName:nina" OR "mail:nina" OR "userPrincipalName:nina"$/);
    // Plattform im Auftrag: gleiche Funktion
    assert.equal(ok(await call(paula(), 'GET', '/v1/platform/organizations/demo/members/entra-search?q=nina')).items.length, 1);
    // Anführungszeichen im Suchbegriff beenden den Ausdruck nicht
    await search('ni"na');
    assert.match(ms.searches.at(-1)!, /"displayName:ni na"/);
  });

  test('Suche: Gast, deaktiviert, Domäne nicht gebunden, schon Mitglied – ausgegraut mit Grund; anderes Konto nicht erkennbar', async () => {
    const byId = async (q: string) => Object.fromEntries((await search(q)).items.map((x: any) => [x.id, x]));
    const n = await byId('no');
    assert.match(n[oid.gast].reason, /Gast/);
    assert.match(n[oid.aus].reason, /deaktiviert/);
    assert.equal(n[oid.neu2].selectable, true);
    assert.match((await byId('nils'))[oid.fremd].reason, /nicht in einer Domäne/);
    assert.equal((await byId('anna'))[oid.anna].reason, 'Bereits Mitglied');
    // Berta hat ein Konto in Muster: Treffer wie für jede neue Person (gleiche Felder, wählbar, ohne Grund)
    const b = (await byId('berta'))[oid.berta];
    const nn = (await byId('nina'))[oid.neu];
    assert.deepEqual(Object.keys(b).sort(), Object.keys(nn).sort());
    assert.deepEqual([b.selectable, b.reason, b.department], [true, null, 'Beratung']);
    assert.doesNotMatch(JSON.stringify(await search('berta')), /muster|Muster/);
  });

  test('Hinzufügen: Regel notLinkable aus Graph (nicht dem Client trauen); unbekannte Objekt-ID 404; org-admin vergibt nicht org-admin', async () => {
    assert.deepEqual([(await add(oid.gast)).status, (await add(oid.gast)).body.reason], [409, 'not-linkable']);
    assert.equal((await add(oid.aus)).body.reason, 'not-linkable');
    assert.equal((await add(oid.fremd)).body.reason, 'not-linkable');
    assert.equal((await add('99999999-9999-4999-8999-999999999999')).status, 404);
    assert.equal((await add(oid.neu, ['org-admin'])).status, 403);
    assert.equal((await call(anna(), 'POST', '/v1/admin/members/entra', { id: oid.neu, roles: [], email: 'boese@demo.example' })).status, 422, 'nur Objekt-ID, Rollen, sendEmail');
    assert.equal((await add(oid.anna)).status, 409, 'schon Mitglied');
    assert.equal(kc.byEmail('nora@gmail.example'), null);
  });

  test('neue Person: Konto ohne Passwort und ohne Aktion, Mitglied, über Objekt-ID verknüpft, Rollen, E-Mail mit Weiterleitung zu Microsoft', async () => {
    const r = ok(await add(oid.neu, ['viewer', 'editor']), 202);
    assert.deepEqual([r.result, r.emailSent, r.member.status, r.member.email, r.member.name, r.member.roles.sort()], ['added', true, 'invited', 'nina.neu@demo.example', 'Nina Neu', ['editor', 'viewer']]);
    assert.equal(r.member.loginPath, '/auth/entra/entra-001?org=demo');
    const acc = kc.byEmail('nina.neu@demo.example')!;
    assert.ok(acc, 'Konto mit der Adresse aus mail (gebundene Domäne)');
    assert.notEqual(r.member.id, acc.id, 'nach aussen die ID der Einladung');
    assert.deepEqual([acc.password, acc.requiredActions, acc.firstName, acc.lastName], [false, [], 'Nina', 'Neu']);
    assert.ok(kc.orgMembers.get(demo.id)!.has(acc.id), 'Mitglied vor der ersten Anmeldung');
    assert.deepEqual(kc.links.get(acc.id)!.get('entra-001'), { userId: oid.neu, userName: 'nina.neu@demoag.onmicrosoft.com' });
    assert.deepEqual(kc.rolesOf(demo, acc), ['editor', 'viewer']);
    const mail = kc.mails.at(-1)!;
    assert.deepEqual([mail.userId, mail.kind, mail.actions], [acc.id, 'actions', ['VERIFY_EMAIL']]);
    const q = new URLSearchParams(mail.query);
    assert.deepEqual([q.get('redirect_uri'), q.get('client_id')], ['http://api.test/auth/entra/entra-001?org=demo', 'notes-platform']);
    const a = (await auditOf('demo', 'member.added_from_entra')).at(-1)!;
    assert.deepEqual([a.data.email, a.data.entraId, a.data.emailSent], ['nina.neu@demo.example', oid.neu, true]);
    // Liste: eingeladen (aus der Einladung), mit Link; nicht im Personenverzeichnis
    const m = (await list()).find(x => x.email === 'nina.neu@demo.example');
    assert.deepEqual([m.id, m.status, m.loginPath], [r.member.id, 'invited', '/auth/entra/entra-001?org=demo']);
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.principal WHERE subject = $1 AND removed_at IS NULL", [acc.id])).rows[0].n, 0);
    assert.equal((await add(oid.neu)).status, 409, 'schon eingeladen');
    assert.equal((await search('nina')).items[0].reason, 'Bereits eingeladen');
  });

  test('bestehendes Konto (andere Organisation): verwendet statt neu angelegt; Antwort wie für ein neues Konto', async () => {
    const before = kc.users.size;
    const neutral = (b: any) => ({ ...b, member: { ...b.member, id: '-', email: '-', name: '-', username: '-', createdAt: '-' } });
    const rb = ok(await add(oid.berta), 202);
    const rn = ok(await add(oid.neu2), 202);
    assert.deepEqual(neutral(rb), neutral(rn));
    assert.equal(kc.users.size, before + 1, 'nur für Noah ein neues Konto');
    assert.ok(kc.orgMembers.get(demo.id)!.has(u.berta.id) && kc.orgMembers.get(muster.id)!.has(u.berta.id), 'Mitglied beider Organisationen');
    assert.equal(kc.links.get(u.berta.id)!.get('entra-001')!.userId, oid.berta);
    assert.deepEqual([u.berta.password, kc.rolesOf(muster, u.berta)], [true, ['viewer']], 'Passwort (Stufe pending) und Rollen in Muster bleiben');
    // Protokoll ohne Angabe, ob das Konto neu ist
    const a = (await auditOf('demo', 'member.added_from_entra')).at(-2)!;
    assert.deepEqual(Object.keys(a.data).sort(), ['email', 'emailSent', 'entraId', 'roles']);
  });

  test('Objekt-ID schon mit einem anderen Konto verknüpft → 409; ohne E-Mail: Link statt Versand', async () => {
    u.carl = kc.user('carl-alt', { email: 'carl.alt@demo.example' });
    kc.links.set(u.carl.id, new Map([['entra-001', { userId: oid.carl, userName: 'carl@demo.example' }]]));
    const r = await add(oid.carl);
    assert.deepEqual([r.status, r.body.reason], [409, 'entra-linked']);
    assert.equal(kc.byEmail('carl@demo.example'), null, 'kein zweites Konto');
    kc.links.get(u.carl.id)!.clear();
    const mails = kc.mails.length;
    const n = ok(await add(oid.carl, [], { sendEmail: false }), 202);
    assert.deepEqual([n.emailSent, n.member.loginPath, kc.mails.length], [false, '/auth/entra/entra-001?org=demo', mails]);
  });

  test('erneut senden: wieder der Link zu Microsoft (VERIFY_EMAIL, kein Passwort); ohne SMTP 502', async () => {
    const m = (await list()).find(x => x.email === 'carl@demo.example');
    ok(await call(anna(), 'POST', `/v1/admin/members/${m.id}/invitation`));
    const mail = kc.mails.at(-1)!;
    assert.deepEqual([mail.actions, new URLSearchParams(mail.query).get('redirect_uri')], [['VERIFY_EMAIL'], 'http://api.test/auth/entra/entra-001?org=demo']);
    kc.smtp = false;
    try { assert.equal((await call(anna(), 'POST', `/v1/admin/members/${m.id}/invitation`)).status, 502); }
    finally { kc.smtp = true; }
  });

  test('eingeladen bis zum ersten Zugriff, dann aktiv (nicht über Required Actions)', async () => {
    const acc = kc.byEmail('noah.neu@demo.example')!;
    assert.equal((await list()).find(x => x.email === 'noah.neu@demo.example').status, 'invited');
    ok(await call(person({ ...acc, email: acc.email }, 'demo', ['viewer'], { identity_provider: 'entra-001' }), 'GET', '/v1/me'));
    const m = (await list()).find(x => x.email === 'noah.neu@demo.example');
    assert.deepEqual([m.id, m.status, m.loginPath], [acc.id, 'active', null]);
    assert.ok(m.lastSeenAt && m.principalId);
    assert.notEqual((await t.inspect.query("SELECT accepted_at FROM notes.member_invitation WHERE user_id = $1", [acc.id])).rows[0].accepted_at, null);
  });

  test('zurückziehen: selbst angelegtes Konto gelöscht, bestehendes bleibt (ohne Mitgliedschaft und Verknüpfung)', async () => {
    const items = await list();
    const nina = kc.byEmail('nina.neu@demo.example')!;
    ok(await call(anna(), 'DELETE', `/v1/admin/members/${items.find(x => x.email === 'nina.neu@demo.example').id}`));
    assert.ok(!kc.users.has(nina.id), 'nie benutztes Konto der Einladung gelöscht');
    const r = ok(await call(anna(), 'DELETE', `/v1/admin/members/${items.find(x => x.email === 'berta@demo.example').id}`));
    assert.equal(r.accountDeleted, false);
    assert.ok(kc.users.has(u.berta.id) && kc.orgMembers.get(muster.id)!.has(u.berta.id) && !kc.orgMembers.get(demo.id)!.has(u.berta.id));
    assert.equal(kc.links.get(u.berta.id)!.size, 0, 'Verknüpfung gelöst');
    assert.equal(kc.rolesOf(demo, u.berta).length, 0);
    // danach wieder wählbar
    assert.equal((await search('nina')).items[0].selectable, true);
  });

  test('Fehler mitten im Hinzufügen: selbst angelegtes Konto zurückgenommen; bestehendes ohne Mitgliedschaft, Verknüpfung und Rollen', async () => {
    const viewer = [...kc.groups.values()].find(g => g.path === '/orgs/demo/viewer')!;
    kc.fail = [{ re: new RegExp(`^PUT /users/[^/]+/groups/${viewer.id}$`), status: 500 }];
    try {
      const before = kc.users.size;
      assert.equal((await add(oid.dora)).status, 502);
      assert.equal(kc.users.size, before);
      assert.equal(kc.byEmail('dora@demo.example'), null);
      assert.equal((await add(oid.berta)).status, 502);
      assert.ok(!kc.orgMembers.get(demo.id)!.has(u.berta.id));
      assert.equal(kc.links.get(u.berta.id)!.size, 0);
    } finally { kc.fail = []; }
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.member_invitation WHERE lower(email) IN ('dora@demo.example', 'berta@demo.example') AND accepted_at IS NULL")).rows[0].n, 0);
    // Alles zurückgenommen: kein Eintrag `…_failed` (er listete nur Schritte, die in Keycloak geblieben sind)
    assert.equal((await auditOf('demo', 'member.entra_add_failed')).length, 0);
  });

  test('«Nur Entra»: bestehendes Konto verliert Passwort; Einladen mit Passwort in die Domäne weiter abgelehnt', async () => {
    await t.inspect.query("UPDATE notes.entra_connection SET stage = 'enforced', enforced_at = now(), enforced_by_name = 'Test'");
    u.berta.password = true;
    const r = ok(await add(oid.berta), 202);
    assert.equal(r.member.status, 'invited');
    assert.equal(u.berta.password, false);
    assert.equal(kc.links.get(u.berta.id)!.get('entra-001')!.userId, oid.berta);
    const inv = await call(anna(), 'POST', '/v1/admin/members', { email: 'zoe@demo.example' });
    assert.deepEqual([inv.status, inv.body.reason], [409, 'entra-domain']);
    assert.match(inv.body.detail, /Person hinzufügen/);
  });

  test('Rate-Limit der Suche je Person: 30 je Minute, Schlüssel Mandant und Person (wirkt mit @fastify/rate-limit der App)', async () => {
    for (const url of ['/v1/admin/members/entra-search', '/v1/platform/organizations/:alias/members/entra-search']) {
      const rl = routeConfig.get(`GET ${url}`)?.rateLimit as { max: number; timeWindow: number; keyGenerator: (r: unknown) => string } | undefined;
      assert.deepEqual([rl?.max, rl?.timeWindow], [30, 60_000], url);
      assert.equal(rl!.keyGenerator({ principal: { tenantId: 't1', subject: 's1' }, ip: '1.2.3.4' }), 'entra-search:t1:s1');
      assert.equal(rl!.keyGenerator({ principal: null, ip: '1.2.3.4' }), 'entra-search::1.2.3.4');
    }
  });

  test('eigene Rolle, die eine andere Instanz gelöscht hat: 422, keine neue Gruppe (Prüfung ohne Zwischenspeicher)', async () => {
    const r = ok(await call(anna(), 'POST', '/v1/roles', { label: 'Aus Entra', permissions: ['note:read'] }), 201);
    await list(); // Rollen der Organisation im Zwischenspeicher
    await t.inspect.query('UPDATE notes.tenant_role SET deleted_at = now() WHERE key = $1', [r.key]);
    const id = ms.user(contoso, 'rolf@demo.example', { displayName: 'Rolf Rolle' }).id;
    assert.equal((await add(id, ['viewer', r.key])).status, 422);
    assert.ok(![...kc.groups.values()].some(g => g.path === `/orgs/demo/${r.key}`), 'Gruppe nicht neu angelegt');
  });
});
