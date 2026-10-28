/**
 * Ereignisse an die App (events.ts): `member.removing` (darf ablehnen) und `member.removed` beim Entfernen, gleich ob
 * über die Verwalten-Routen des Pakets (eigene Organisation und Plattform) oder über die API des Pakets aus einer Route
 * der App (`iam.admin.removeMember`); `access.*` je Rolle an einem Ort (Rollen setzen, Einladen, Freigeben, Ablauf,
 * Entziehen, `iam.tuples` der App); `member.left` und `access.expired` aus dem Abgleich. Alles in der Transaktion der
 * Änderung: der Haken sieht den neuen Stand, seine Schreibvorgänge stehen und fallen mit ihr.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { KeycloakFake, startMockIdp, type FakeOrg, type FakeUser, type MockIdp } from '@vollholz/iam-testkit';
import { pgAudit } from '../src/audit.ts';
import { withTenant, type Tx } from '../src/db.ts';
import { conflict } from '../src/errors.ts';
import type { IamEvent, IamEvents } from '../src/events.ts';
import type { Principal } from '../src/principal.ts';
import { expireAccess, syncTenantMembers } from '../src/sync.ts';
import { skipDb } from './support/db.ts';
import { claims, folderWithNote, member, notesApp, notesDb, tenant, type NotesApp } from './support/http.ts';

const skip = await skipDb();
type Res = { status: number; body: any; type: string };
const MGMT = { DPOP_MODE: 'optional', KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 'geheim-fuer-tests', KEYCLOAK_MGMT_INVITE_MIN_TIME: '0' };

describe('Ereignisse an die App: Entfernen und Rollen', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  const kc = new KeycloakFake();
  const tok: Record<string, string> = {};
  let demo: FakeOrg, anna: FakeUser, paula: FakeUser, demoId: string;

  /** Was die Haken gesehen haben: Phase, Ereignis und Zahl der Tupel des Subjekts in der Transaktion. */
  const seen: { phase: 'before' | 'after'; e: IamEvent; tuplesInTx: number }[] = [];
  /** Steuerung je Test: ablehnen (Keycloak-ID → Begründung), nach dem Entfernen scheitern. */
  const ctl = { reject: new Map<string, string>(), failAfter: false };
  const tuplesOf = async (tx: Tx, subject: string | null) => subject ? Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM notes.authz_tuple WHERE subject = $1', [subject])).rows[0]!.n) : 0;
  const events: IamEvents = {
    async before(tx, e) {
      seen.push({ phase: 'before', e, tuplesInTx: await tuplesOf(tx, e.subject) });
      const why = ctl.reject.get(e.data.userId);
      if (why) throw conflict(why, { reason: 'open-tasks', memberId: e.data.memberId });
    },
    async after(tx, e) {
      seen.push({ phase: 'after', e, tuplesInTx: await tuplesOf(tx, e.subject) });
      if (e.type === 'member.removed') {
        // Aufgabe der App in derselben Transaktion (hier als Ordner)
        await tx.query('INSERT INTO notes.folder (tenant_id, name) VALUES (app.tenant_id(), $1)', [`Neubesetzung ${e.data.userId}`]);
        if (ctl.failAfter) throw new Error('Aufgabe konnte nicht angelegt werden');
      }
    },
  };

  async function call(who: string, method: string, url: string, body?: unknown): Promise<Res> {
    const r = await n.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tok[who]}` }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, type: String(r.headers['content-type'] ?? '') };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const principalOf = async (sub: string) => (await t.inspect.query<{ id: string }>("SELECT p.id FROM notes.principal p JOIN notes.tenant x ON x.id = p.tenant_id WHERE x.alias = 'demo' AND p.subject = $1", [sub])).rows[0]?.id ?? null;
  const tuples = async (sub: string) => Number((await t.inspect.query<{ n: string }>(
    "SELECT count(*) AS n FROM notes.authz_tuple a JOIN notes.principal p ON a.subject = 'user:' || p.id WHERE p.subject = $1", [sub])).rows[0]!.n);
  const tasks = async (sub: string) => Number((await t.inspect.query<{ n: string }>('SELECT count(*) AS n FROM notes.folder WHERE name = $1', [`Neubesetzung ${sub}`])).rows[0]!.n);
  const audits = async (action: string) => (await t.inspect.query<{ resource_id: string; data: any }>(
    "SELECT a.resource_id::text, a.data FROM notes.audit_log a JOIN notes.tenant x ON x.id = a.tenant_id WHERE x.alias = 'demo' AND a.action = $1 ORDER BY a.seq", [action])).rows;
  /** Person in demo mit Rollen an org und optional einer Freigabe an einem Ordner. */
  async function person(name: string, roles: string[]): Promise<FakeUser> {
    const x = kc.user(name, { email: `${name}@demo.example`, firstName: name, lastName: 'Test' });
    kc.member(demo, x);
    for (const r of roles) await member(t.runtime, 'demo', x.id, r);
    return x;
  }
  const ofType = (type: string) => seen.filter(s => s.e.type === type);

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    demo = kc.org('demo', 'Demo AG'); const ops = kc.org('ops', 'Betrieb');
    anna = kc.user('anna', { email: 'anna@demo.example', firstName: 'Anna', lastName: 'Admin' });
    paula = kc.user('paula', { email: 'paula@ops.example', firstName: 'Paula', lastName: 'Plattform' });
    kc.member(demo, anna); await member(t.runtime, 'demo', anna.id, 'org-admin');
    kc.member(ops, paula); await member(t.runtime, 'ops', paula.id, 'org-admin');
    demoId = await tenant(t.runtime, 'demo');
    n = await notesApp({
      db: t.runtime, issuer: idp.issuer, env: MGMT, keycloakFetch: kc.fetch, events,
      // Route der App, die die API des Pakets nutzt (z. B. «Zugang entziehen» in der Fachoberfläche)
      after: app => {
        app.delete('/v1/zugang/:id', async req => {
          const p = (req as unknown as { principal: Principal }).principal;
          await req.need('members:admin');
          return n.iam.admin!.removeMember({ alias: p.tenantAlias, actor: p, platform: false, source: 'api', correlationId: req.id }, (req.params as { id: string }).id);
        });
      },
    });
    tok.anna = await idp.token(claims.user({ sub: anna.id, org: 'demo', email: anna.email, name: 'Anna Admin' }));
    tok.paula = await idp.token({ ...claims.user({ sub: paula.id, org: 'ops', email: paula.email, name: 'Paula Plattform' }), realm_access: { roles: ['platform-admin'] } });
    for (const who of ['anna', 'paula']) ok(await call(who, 'GET', '/v1/me'));
  });
  beforeEach(() => { seen.length = 0; ctl.reject.clear(); ctl.failAfter = false; });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('Verwalten-Seite: der Haken vorher lehnt ab → 409 problem+json mit Begründung, nichts geändert', async () => {
    const x = await person('xenia', ['editor']);
    ctl.reject.set(x.id, 'Xenia ist noch Projektleiterin in 2 Projekten. Zuerst die Rollen neu besetzen.');
    const r = await call('anna', 'DELETE', `/v1/admin/members/${x.id}`);
    assert.equal(r.status, 409);
    assert.match(r.type, /application\/problem\+json/);
    assert.deepEqual([r.body.title, r.body.detail, r.body.reason, r.body.memberId], ['Konflikt', 'Xenia ist noch Projektleiterin in 2 Projekten. Zuerst die Rollen neu besetzen.', 'open-tasks', x.id]);
    assert.ok(kc.orgMembers.get(demo.id)!.has(x.id), 'Mitgliedschaft in Keycloak bleibt');
    assert.equal(await tuples(x.id), 1, 'Rollen bleiben');
    assert.equal((await audits('member.removed')).filter(a => a.resource_id === x.id).length, 0);
    assert.equal((await audits('member.remove_failed')).filter(a => a.resource_id === x.id).length, 0, 'Keycloak unverändert: kein …_failed');
    assert.deepEqual(seen.map(s => [s.phase, s.e.type]), [['before', 'member.removing']], 'kein Ereignis danach');
    const pid = await principalOf(x.id);
    const e = seen[0]!.e as IamEvent<'member.removing'>;
    assert.deepEqual([e.tenantId, e.subject, e.actor.principal?.name, e.actor.source], [demoId, `user:${pid}`, 'Anna Admin', 'api']);
    assert.deepEqual(e.data, { memberId: x.id, userId: x.id, principalId: pid, email: 'xenia@demo.example', roles: ['editor'], invitation: false, platform: false });
    assert.equal(seen[0]!.tuplesInTx, 1, 'vorher: Rollen noch da');
  });

  test('Verwalten-Seite: Entfernen meldet je Rolle access.revoked und dann member.removed, in derselben Transaktion', async () => {
    const x = await person('yves', ['editor', 'viewer']);
    const { folder } = await folderWithNote(t.runtime, demoId, 'Yves');
    ok(await call('anna', 'POST', '/v1/access', { subject: `user:${await principalOf(x.id)}`, relation: 'viewer', type: 'folder', id: folder }), 201);
    seen.length = 0;
    ok(await call('anna', 'DELETE', `/v1/admin/members/${x.id}`));
    const pid = await principalOf(x.id);
    assert.deepEqual(seen.map(s => [s.phase, s.e.type]), [['before', 'member.removing'], ['after', 'access.revoked'], ['after', 'access.revoked'], ['after', 'access.revoked'], ['after', 'member.removed']]);
    const revoked = ofType('access.revoked').map(s => s.e as IamEvent<'access.revoked'>);
    assert.deepEqual(revoked.map(e => `${e.data.relation}@${e.data.type}`).sort(), ['editor@org', 'viewer@folder', 'viewer@org']);
    assert.ok(revoked.every(e => e.subject === `user:${pid}` && e.actor.principal?.name === 'Anna Admin' && e.tenantId === demoId && e.data.tupleId));
    const removed = ofType('member.removed')[0]!;
    assert.equal(removed.tuplesInTx, 0, 'der Haken sieht den neuen Stand');
    assert.deepEqual((removed.e as IamEvent<'member.removed'>).data.roles.sort(), ['editor', 'viewer']);
    assert.equal(await tasks(x.id), 1, 'Aufgabe der App mit der Änderung committet');
    assert.ok(!kc.orgMembers.get(demo.id)!.has(x.id));
  });

  test('Haken danach scheitert: Transaktion zurückgerollt (Rollen und Aufgabe), Keycloak entfernt, …_failed im Audit', async () => {
    const x = await person('zora', ['viewer']);
    ctl.failAfter = true;
    const r = await call('anna', 'DELETE', `/v1/admin/members/${x.id}`);
    assert.equal(r.status, 500);
    assert.equal(await tuples(x.id), 1, 'Tupel bleiben (zurückgerollt)');
    assert.equal(await tasks(x.id), 0, 'Aufgabe zurückgerollt');
    assert.ok(!kc.orgMembers.get(demo.id)!.has(x.id), 'Keycloak bleibt geändert');
    const f = (await audits('member.remove_failed')).filter(a => a.resource_id === x.id);
    assert.deepEqual(f.map(a => a.data.steps), [[{ step: 'membership_removed' }]]);
  });

  test('Einladung zurückziehen: dieselben Haken mit invitation: true', async () => {
    const inv = ok(await call('anna', 'POST', '/v1/admin/members', { email: 'ines@demo.example', roles: ['viewer'] }), 202);
    const granted = ofType('access.granted').map(s => s.e as IamEvent<'access.granted'>);
    assert.deepEqual(granted.map(e => [e.data.relation, e.data.type, e.actor.principal?.name]), [['viewer', 'org', 'Anna Admin']], 'Einladen vergibt die Rolle');
    seen.length = 0;
    ctl.reject.set([...kc.users.values()].find(x => x.email === 'ines@demo.example')!.id, 'Noch Aufgaben offen.');
    assert.equal((await call('anna', 'DELETE', `/v1/admin/members/${inv.member.id}`)).status, 409);
    ctl.reject.clear();
    ok(await call('anna', 'DELETE', `/v1/admin/members/${inv.member.id}`));
    const e = ofType('member.removed')[0]!.e as IamEvent<'member.removed'>;
    assert.deepEqual([e.data.memberId, e.data.invitation, e.data.roles], [inv.member.id, true, ['viewer']]);
  });

  test('Plattform-Route: dieselben Haken, platform: true; Ablehnen gilt auch für die Plattform', async () => {
    const x = await person('pia', ['viewer']);
    ctl.reject.set(x.id, 'Nicht jetzt.');
    const r = await call('paula', 'DELETE', `/v1/platform/organizations/demo/members/${x.id}`);
    assert.deepEqual([r.status, r.body.reason], [409, 'open-tasks']);
    assert.equal((seen[0]!.e as IamEvent<'member.removing'>).data.platform, true);
    ctl.reject.clear(); seen.length = 0;
    ok(await call('paula', 'DELETE', `/v1/platform/organizations/demo/members/${x.id}`));
    const e = ofType('member.removed')[0]!.e as IamEvent<'member.removed'>;
    assert.deepEqual([e.data.platform, e.actor.principal?.name, e.tenantId], [true, 'Paula Plattform', demoId]);
    assert.equal(await tasks(x.id), 1);
  });

  test('API des Pakets aus einer Route der App (iam.admin.removeMember): dieselben Haken, Ablehnung als problem+json', async () => {
    const x = await person('quirin', ['editor']);
    ctl.reject.set(x.id, 'Quirin hat offene Aufgaben.');
    const r = await call('anna', 'DELETE', `/v1/zugang/${x.id}`);
    assert.deepEqual([r.status, r.body.detail, r.body.reason], [409, 'Quirin hat offene Aufgaben.', 'open-tasks']);
    assert.match(r.type, /application\/problem\+json/);
    assert.ok(kc.orgMembers.get(demo.id)!.has(x.id));
    ctl.reject.clear(); seen.length = 0;
    ok(await call('anna', 'DELETE', `/v1/zugang/${x.id}`));
    assert.deepEqual(seen.map(s => s.e.type), ['member.removing', 'access.revoked', 'member.removed']);
    assert.equal(await tasks(x.id), 1);
  });

  test('Rollen setzen: je vergebener Rolle access.granted, je entzogener access.revoked (kein Audit je Tupel)', async () => {
    const x = await person('rita', ['viewer']);
    const before = (await audits('access.granted')).length;
    ok(await call('anna', 'PUT', `/v1/admin/members/${x.id}/roles`, { roles: ['editor'] }));
    const pid = await principalOf(x.id);
    assert.deepEqual(seen.map(s => [s.e.type, (s.e as IamEvent<'access.granted'>).data.relation]), [['access.revoked', 'viewer'], ['access.granted', 'editor']]);
    assert.ok(seen.every(s => s.e.subject === `user:${pid}` && s.e.actor.principal?.name === 'Anna Admin' && s.e.actor.source === 'api'));
    assert.equal((await audits('access.granted')).length, before, 'Protokoll bleibt member.roles_changed');
    seen.length = 0;
    ok(await call('anna', 'PUT', `/v1/admin/members/${x.id}/roles`, { roles: ['editor'] }));
    assert.equal(seen.length, 0, 'ohne Änderung kein Ereignis');
  });

  test('Rolle an einem Ort: freigeben, Ablauf ändern, entziehen; iam.tuples der App ohne Angabe: Akteur system', async () => {
    const x = await person('sven', ['viewer']);
    const pid = await principalOf(x.id);
    const { folder } = await folderWithNote(t.runtime, demoId, 'Sven');
    const g = ok(await call('anna', 'POST', '/v1/access', { subject: `user:${pid}`, relation: 'editor', type: 'folder', id: folder }), 201);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    ok(await call('anna', 'PATCH', `/v1/access/${g.id}`, { expiresAt: until }));
    ok(await call('anna', 'DELETE', `/v1/access/${g.id}`), 204);
    const e = seen.map(s => s.e as IamEvent<'access.granted'>);
    assert.deepEqual(e.map(x => [x.type, x.data.relation, x.data.type, x.data.id]), [['access.granted', 'editor', 'folder', folder], ['access.granted', 'editor', 'folder', folder], ['access.revoked', 'editor', 'folder', folder]]);
    assert.deepEqual([e[1]!.data.previousExpiresAt, e[1]!.data.expiresAt !== null], [null, true]);
    assert.ok(e.every(x => x.actor.principal?.name === 'Anna Admin' && x.subject === `user:${pid}`));
    seen.length = 0;
    await withTenant(t.runtime, { tenantId: demoId }, tx => n.iam.tuples.grant(tx, { subject: `user:${pid}`, relation: 'viewer', place: { type: 'folder', id: folder } }));
    assert.deepEqual(seen.map(s => [s.e.type, s.e.actor.principal, s.e.actor.source, s.e.tenantId]), [['access.granted', null, 'system', demoId]]);
  });
});

describe('Ereignisse an die App: Abgleich und Aufräumen', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>;
  const got: IamEvent[] = [];
  const ctx = { schema: 'notes', audit: pgAudit({ schema: 'notes' }), events: { after: async (_tx: Tx, e: IamEvent) => { got.push(e); } } satisfies IamEvents };

  before(async () => { t = await db.create(); });
  after(async () => { await t?.drop(); });

  test('Austritt in Keycloak (Abgleich): member.left; abgelaufene Rolle: access.expired', async () => {
    const tenantId = await tenant(t.runtime, 'demo');
    const p = await member(t.runtime, 'demo', 'aaaaaaaa-0000-4000-8000-000000000001', 'viewer');
    await syncTenantMembers(ctx, t.runtime, tenantId, 'demo', []);
    assert.deepEqual(got.map(e => [e.type, e.subject, e.tenantId, e.data]), [['member.left', `user:${p}`, tenantId, { userId: 'aaaaaaaa-0000-4000-8000-000000000001', principalId: p }]]);
    assert.equal(got[0]!.actor.source, 'system');
    got.length = 0;
    await t.inspect.query("UPDATE notes.authz_tuple SET expires_at = now() - interval '1 minute' WHERE subject = $1", [`user:${p}`]);
    assert.equal((await expireAccess(ctx, t.runtime, tenantId)).expired, 1);
    assert.deepEqual(got.map(e => [e.type, e.subject, (e as IamEvent<'access.expired'>).data.relation]), [['access.expired', `user:${p}`, 'viewer']]);
  });
});
