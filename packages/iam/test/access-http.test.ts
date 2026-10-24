/**
 * Zugriff über HTTP (Spezifikation Kap. 9.5, Regeln 9.1 Nr. 5–7; Pflichttest `access-http` in Kap. 14): Formen von
 * `AccessList`, `AccessEntry`, `Explain`, `ApiMe`; niemand gibt mehr, als er hat (POST, PATCH, DELETE); `org-admin` nur
 * `platform-admin` und ohne Ablauf; letzter Admin; Duplikat; 422 je Feld; 404 für nicht lesbare Ressourcen; «Warum?» für
 * andere nur mit `access:admin`; Zuständigkeit über Personen aus Fachdaten (`via: 'data'`, nicht entfernbar); Audit
 * `access.*`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { withTenant } from '../src/db.ts';
import { skipDb } from './support/db.ts';
import { claims, folderWithNote, grant, notesApp, notesDb, responsible, tenant, view, type NotesApp } from './support/http.ts';

const skip = await skipDb();
const G1 = '0b6f2f7e-4c1d-4d2b-9a55-1f0c7c2d9e11';

describe('Zugriff über HTTP (/v1/access)', { skip }, () => {
  const dbs = notesDb();
  let t: Awaited<ReturnType<typeof dbs.create>>, idp: MockIdp, n: NotesApp;
  let A: string, B: string, F1: string, F2: string, N1: string, NB: string, V: string;
  const ids: Record<string, string> = {};
  const headers: Record<string, Record<string, string>> = {};

  /** Person anmelden (legt den Principal an) und ihre Principal-ID merken. */
  async function login(name: string, o: { org?: string; platform?: boolean; groups?: string[] } = {}) {
    const c = { ...claims.user({ sub: `sub-${name}`, org: o.org ?? 'acme', name, email: `${name}@acme.example`, ...(o.groups ? { groups: o.groups } : {}) }), ...(o.platform ? { realm_access: { roles: ['platform-admin'] } } : {}) };
    headers[name] = { authorization: `Bearer ${await idp.token(c)}` };
    const r = await n.app.inject({ method: 'GET', url: '/v1/me', headers: headers[name] });
    assert.equal(r.statusCode, 200, r.body);
    ids[name] = r.json().principal.id;
    return ids[name]!;
  }
  const call = (who: string, method: string, url: string, payload?: unknown) => n.app.inject({ method: method as 'GET', url, headers: headers[who], ...(payload !== undefined ? { payload: payload as object } : {}) });
  const audit = async (action: string) => withTenant(t.runtime, { tenantId: A }, async tx => (await tx.query<{ data: Record<string, unknown> }>('SELECT data FROM notes.audit_log WHERE action = $1 ORDER BY seq', [action])).rows.map(r => r.data));

  before(async () => {
    t = await dbs.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    n = await notesApp({ db: t.runtime, issuer: idp.issuer });
    A = await tenant(t.runtime, 'acme'); B = await tenant(t.runtime, 'globex');
    const f = await folderWithNote(t.runtime, A, 'F1');
    F1 = f.folder; N1 = f.note;
    F2 = (await folderWithNote(t.runtime, A, 'F2', { classification: 2 })).folder;
    NB = (await folderWithNote(t.runtime, B, 'fremd')).note;
    V = await view(t.runtime, A, 'Ansicht');
    for (const x of ['admin', 'admin2', 'editor', 'viewer', 'nobody', 'owner', 'stranger']) await login(x);
    await login('platform', { platform: true });
    await grant(t.runtime, A, `user:${ids.admin}`, 'org-admin');
    await grant(t.runtime, A, `user:${ids.editor}`, 'editor', { type: 'folder', id: F1 });
    await grant(t.runtime, A, `user:${ids.viewer}`, 'viewer');
    await grant(t.runtime, A, `user:${ids.owner}`, 'owner', { type: 'view', id: V });
    await grant(t.runtime, A, `user:${ids.platform}`, 'viewer');
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('Katalog: types[].membersRole nur bei Typen mit owner', async () => {
    const types = (await call('viewer', 'GET', '/v1/authz/catalog')).json().types as { key: string; membersRole?: string }[];
    assert.deepEqual(types.filter(x => x.membersRole).map(x => [x.key, x.membersRole]), [['view', 'viewer']]);
  });

  test('GET /v1/me (ApiMe): Rollen und Rechte an org, irgendwo, Freigabestufe', async () => {
    const r = await call('editor', 'GET', '/v1/me');
    const b = r.json();
    assert.deepEqual(Object.keys(b).sort(), ['breakGlassUntil', 'clearance', 'permissions', 'principal', 'roles', 'scopes', 'somewhere', 'tenant', 'tokenBinding']);
    assert.deepEqual([b.roles, b.permissions, b.clearance, b.breakGlassUntil], [[], [], 0, null]);
    assert.ok(b.somewhere.includes('note:write') && b.somewhere.includes('access:admin'));
    assert.deepEqual((await call('viewer', 'GET', '/v1/me')).json().roles, ['viewer']);
  });

  test('Wer hat Zugriff? Formen; direkt, geerbt; grantable; 404 für nicht lesbar, fremd und unbekannt', async () => {
    const r = await call('editor', 'GET', `/v1/access?type=note&id=${N1}`);
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.deepEqual(b.resource, { type: 'note', id: N1 });
    assert.equal(b.classification, 0);
    const vias = b.items.map((i: { via: string; relation: string; place: { type: string } }) => `${i.via}:${i.relation}@${i.place.type}`);
    assert.deepEqual(vias, ['inherited:editor@folder', 'inherited:org-admin@org', 'inherited:viewer@org', 'inherited:viewer@org']);
    const e = b.items[0];
    assert.deepEqual(Object.keys(e).sort(), ['createdAt', 'createdBy', 'expiresAt', 'id', 'place', 'relation', 'removable', 'subject', 'via']);
    assert.deepEqual(e.subject, { ref: `user:${ids.editor}`, kind: 'user', name: 'editor' });
    assert.equal(e.removable, false, 'geerbte nur am Ursprung');
    assert.deepEqual(b.grantable, ['editor', 'viewer']);
    assert.deepEqual((await call('viewer', 'GET', `/v1/access?type=folder&id=${F1}`)).json().grantable, [], 'ohne access:admin');
    assert.equal((await call('nobody', 'GET', `/v1/access?type=folder&id=${F1}`)).statusCode, 404, 'nicht lesbar');
    assert.equal((await call('admin', 'GET', `/v1/access?type=note&id=${NB}`)).statusCode, 404, 'fremd');
    assert.equal((await call('admin', 'GET', '/v1/access?type=note&id=00000000-0000-4000-8000-000000000999')).statusCode, 404, 'unbekannt');
    assert.equal((await call('admin', 'GET', `/v1/access?type=folder&id=${F2}`)).statusCode, 200);
    assert.equal((await call('admin', 'GET', '/v1/access?type=nix&id=00000000-0000-4000-8000-000000000999')).statusCode, 422);
    const org = (await call('viewer', 'GET', '/v1/access?type=org')).json();
    assert.deepEqual(org.resource, { type: 'org', id: null });
    assert.equal(org.classification, null);
    assert.deepEqual(org.items.map((i: { via: string }) => i.via), ['direct', 'direct', 'direct']);
  });

  test('Freigeben: 201 AccessEntry; Duplikat 409; 422 je Feld; 403 ohne access:admin; Audit access.granted', async () => {
    const body = { subject: `user:${ids.nobody}`, relation: 'viewer', type: 'folder', id: F1 };
    const r = await call('editor', 'POST', '/v1/access', body);
    assert.equal(r.statusCode, 201, r.body);
    const e = r.json();
    assert.deepEqual([e.via, e.relation, e.place, e.removable, e.createdBy, e.subject.ref], ['direct', 'viewer', { type: 'folder', id: F1 }, true, 'editor', `user:${ids.nobody}`]);
    const dup = await call('editor', 'POST', '/v1/access', body);
    assert.deepEqual([dup.statusCode, dup.json().reason], [409, 'duplicate']);
    const field = async (b: object, path: string) => {
      const x = await call('editor', 'POST', '/v1/access', { ...body, ...b });
      assert.equal(x.statusCode, 422, `${path}: ${x.body}`);
      assert.equal(x.json().errors[0].path, path);
    };
    await field({ relation: 'owner' }, '/relation');
    await field({ relation: 'member' }, '/relation');
    await field({ subject: 'user:kein-guid' }, '/subject');
    await field({ subject: `client:${ids.nobody}` }, '/subject');
    await field({ subject: `group:${G1}` }, '/subject');
    await field({ expiresAt: '2000-01-01T00:00:00Z' }, '/expiresAt');
    assert.equal((await call('editor', 'POST', '/v1/access', { ...body, subject: 'user:00000000-0000-4000-8000-000000000999' })).statusCode, 404, 'unbekannte Person');
    assert.equal((await call('editor', 'POST', '/v1/access', { ...body, extra: 1 })).statusCode, 422, 'unbekanntes Feld');
    assert.equal((await call('viewer', 'POST', '/v1/access', { ...body, subject: `user:${ids.owner}` })).statusCode, 403, 'kein access:admin');
    assert.equal((await call('editor', 'POST', '/v1/access', { ...body, type: 'org', id: null })).statusCode, 404, 'org für editor nicht lesbar (kein tenant:read)');
    assert.equal((await call('nobody', 'POST', '/v1/access', { ...body, subject: `user:${ids.owner}`, type: 'folder', id: F2 })).statusCode, 404, 'Ort nicht lesbar');
    const logged = await audit('access.granted');
    assert.deepEqual(logged.at(-1), { subject: `user:${ids.nobody}`, relation: 'viewer', type: 'folder', id: F1, expiresAt: null });
  });

  test('niemand gibt mehr, als er hat: 403 exceeds-own mit missing (auch für Entziehen und Ablauf)', async () => {
    const r = await call('owner', 'POST', '/v1/access', { subject: `user:${ids.nobody}`, relation: 'editor', type: 'view', id: V });
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().reason, 'exceeds-own');
    assert.ok(r.json().missing.includes('note:write'));
    const ok = await call('owner', 'POST', '/v1/access', { subject: 'org:members', relation: 'viewer', type: 'view', id: V });
    assert.equal(ok.statusCode, 403, 'viewer enthält note:read und team:read, die der Besitz nicht gibt');
    // Ein Tupel, das der Owner nicht vergeben durfte: entziehen und Ablauf ändern ebenso verboten
    const tid = await grant(t.runtime, A, `user:${ids.viewer}`, 'editor', { type: 'view', id: V });
    assert.equal((await call('owner', 'DELETE', `/v1/access/${tid}`)).json().reason, 'exceeds-own');
    assert.equal((await call('owner', 'PATCH', `/v1/access/${tid}`, { expiresAt: null })).json().reason, 'exceeds-own');
    assert.equal((await call('admin', 'DELETE', `/v1/access/${tid}`)).statusCode, 204);
  });

  test('org-admin: nur platform-admin, ohne Ablauf; letzter Admin bleibt', async () => {
    const r = await call('admin', 'POST', '/v1/access', { subject: `user:${ids.admin2}`, relation: 'org-admin', type: 'org' });
    assert.deepEqual([r.statusCode, r.json().reason], [403, 'platform-admin-only']);
    const exp = await call('platform', 'POST', '/v1/access', { subject: `user:${ids.admin2}`, relation: 'org-admin', type: 'org', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    assert.equal(exp.statusCode, 422);
    assert.equal(exp.json().errors[0].path, '/expiresAt');
    // Platform-Admin ist von «niemand gibt mehr» ausgenommen (A9), braucht kein access:admin
    const ok = await call('platform', 'POST', '/v1/access', { subject: `user:${ids.admin2}`, relation: 'org-admin', type: 'org' });
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal((await call('platform', 'DELETE', `/v1/access/${ok.json().id}`)).statusCode, 204);
    const list = (await call('admin', 'GET', '/v1/access?type=org')).json();
    const only = list.items.find((i: { relation: string }) => i.relation === 'org-admin');
    const last = await call('platform', 'DELETE', `/v1/access/${only.id}`);
    assert.deepEqual([last.statusCode, last.json().reason], [409, 'last-admin']);
  });

  test('Ablauf ändern (PATCH) mit previousExpiresAt; entfernen (DELETE) mit access.revoked; 404 für fremde Tupel', async () => {
    const created = (await call('editor', 'POST', '/v1/access', { subject: `user:${ids.owner}`, relation: 'viewer', type: 'note', id: N1 })).json();
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const p = await call('editor', 'PATCH', `/v1/access/${created.id}`, { expiresAt: until });
    assert.equal(p.statusCode, 200, p.body);
    assert.equal(p.json().expiresAt, until);
    assert.deepEqual((await audit('access.granted')).at(-1), { subject: `user:${ids.owner}`, relation: 'viewer', type: 'note', id: N1, expiresAt: until, previousExpiresAt: null });
    assert.equal((await call('editor', 'PATCH', `/v1/access/${created.id}`, { expiresAt: '2001-01-01T00:00:00Z' })).statusCode, 422);
    const foreign = await grant(t.runtime, B, 'org:members', 'viewer');
    assert.equal((await call('admin', 'DELETE', `/v1/access/${foreign}`)).statusCode, 404, 'Tupel fremder Organisation');
    assert.equal((await call('admin', 'PATCH', `/v1/access/${foreign}`, { expiresAt: null })).statusCode, 404);
    assert.equal((await call('editor', 'DELETE', `/v1/access/${created.id}`)).statusCode, 204);
    assert.equal((await audit('access.revoked')).at(-1)!.subject, `user:${ids.owner}`);
    assert.equal((await call('editor', 'DELETE', `/v1/access/${created.id}`)).statusCode, 404);
  });

  test('Freigaben eines Subjekts: subject=me für jeden, sonst members:admin', async () => {
    const mine = (await call('editor', 'GET', '/v1/access?subject=me')).json();
    assert.deepEqual(mine.items.map((i: { relation: string; place: { type: string } }) => `${i.relation}@${i.place.type}`), ['editor@folder']);
    assert.equal((await call('editor', 'GET', `/v1/access?subject=user:${ids.viewer}`)).statusCode, 403);
    const other = await call('admin', 'GET', `/v1/access?subject=user:${ids.editor}`);
    assert.equal(other.statusCode, 200);
    assert.equal(other.json().items.length, 1);
  });

  test('Warum? für sich selbst; für andere nur mit access:admin am Ort; Klassifizierung blockiert; label', async () => {
    const self = await call('editor', 'GET', `/v1/access/explain?type=note&id=${N1}`);
    assert.equal(self.statusCode, 200, self.body);
    const b = self.json();
    assert.deepEqual([b.allowed, b.permission, b.subject.ref, b.blocked], [true, 'note:read', `user:${ids.editor}`, null]);
    assert.deepEqual(b.reasons[0], { via: 'inherited', relation: 'editor', place: { type: 'folder', id: F1 }, tupleId: b.reasons[0].tupleId, matched: `user:${ids.editor}`, label: 'editor' });
    assert.equal((await call('viewer', 'GET', `/v1/access/explain?type=note&id=${N1}&subject=user:${ids.editor}`)).statusCode, 403, 'viewer hat kein access:admin');
    const other = await call('editor', 'GET', `/v1/access/explain?type=note&id=${N1}&subject=user:${ids.viewer}&permission=note:write`);
    assert.deepEqual([other.statusCode, other.json().allowed, other.json().reasons], [200, false, []]);
    const members = await call('editor', 'GET', `/v1/access/explain?type=note&id=${N1}&subject=org:members`);
    assert.equal(members.json().subject.name, 'Alle Mitglieder');
    const n2 = (await withTenant(t.runtime, { tenantId: A, settings: { 'app.read_all': 'on', 'app.clearance': '2' } }, tx => tx.query<{ id: string }>('SELECT id FROM notes.note WHERE folder_id = $1', [F2]))).rows[0]!.id;
    const blocked = await call('admin', 'GET', `/v1/access/explain?type=note&id=${n2}&subject=user:${ids.viewer}`);
    assert.equal(blocked.statusCode, 404, `für mich (Stufe 0) nicht lesbar: ${blocked.body}`);
    assert.equal((await call('stranger', 'GET', `/v1/access/explain?type=note&id=${N1}`)).statusCode, 404);
    assert.equal((await call('editor', 'GET', `/v1/access/explain?type=team&id=${F1}`)).statusCode, 404);
    assert.equal((await call('editor', 'GET', `/v1/access/explain?type=note&id=${N1}&permission=x:y`)).statusCode, 422);
  });

  test('Zuständigkeit über Personen: Wer hat Zugriff? und Warum? mit via data, nicht entfernbar; /v1/me irgendwo', async () => {
    await login('resp');
    const { note } = await folderWithNote(t.runtime, A, 'Verantwortet');
    assert.equal((await call('resp', 'GET', `/v1/access?type=note&id=${note}`)).statusCode, 404, 'vorher nicht lesbar');
    assert.ok(!(await call('resp', 'GET', '/v1/me')).json().somewhere.includes('note:read'));
    await responsible(t.runtime, A, note, ids.resp!, 'edit');
    await responsible(t.runtime, A, note, ids.nobody!, 'none', 'Ehemals');
    const r = await call('resp', 'GET', `/v1/access?type=note&id=${note}`);
    assert.equal(r.statusCode, 200, r.body);
    const data = r.json().items.filter((i: { via: string }) => i.via === 'data');
    assert.deepEqual(data, [{
      id: null, subject: { ref: `user:${ids.resp}`, kind: 'user', name: 'resp' }, relation: 'Verantwortlich', place: { type: 'note', id: note }, via: 'data',
      data: { relation: 'Verantwortlich', grants: 'edit' }, expiresAt: null, createdAt: null, createdBy: null, removable: false,
    }]);
    assert.equal(r.json().items.at(-1).via, 'data', 'zuletzt');
    assert.ok((await call('admin', 'GET', `/v1/access?type=note&id=${note}`)).json().items.some((i: { via: string; removable: boolean }) => i.via === 'data' && !i.removable), 'auch für access:admin nicht entfernbar');
    const why = (await call('resp', 'GET', `/v1/access/explain?type=note&id=${note}&permission=note:write`)).json();
    assert.equal(why.allowed, true);
    assert.deepEqual(why.reasons, [{ via: 'data', relation: 'Verantwortlich', place: { type: 'note', id: note }, tupleId: null, matched: `user:${ids.resp}`, label: 'resp', data: { relation: 'Verantwortlich', grants: 'edit' } }]);
    const forOther = (await call('admin', 'GET', `/v1/access/explain?type=note&id=${note}&permission=note:write&subject=user:${ids.resp}`)).json();
    assert.deepEqual([forOther.allowed, forOther.reasons.map((x: { via: string }) => x.via)], [true, ['data']], 'für andere');
    const none = (await call('admin', 'GET', `/v1/access/explain?type=note&id=${note}&subject=user:${ids.nobody}`)).json();
    assert.deepEqual([none.allowed, none.reasons], [false, []], 'grants none');
    assert.ok((await call('resp', 'GET', '/v1/me')).json().somewhere.includes('note:write'), 'irgendwo');
  });

  test('Gruppen aus Entra ohne Verbindung: 409 entra-not-connected; ohne access:admin irgendwo 403', async () => {
    const r = await call('editor', 'GET', '/v1/access/groups?q=abt');
    assert.deepEqual([r.statusCode, r.json().reason], [409, 'entra-not-connected']);
    assert.equal((await call('nobody', 'GET', '/v1/access/groups?q=abt')).statusCode, 403);
  });

  test('Clients und MCP verwalten keine Freigaben', async () => {
    await grant(t.runtime, A, 'org:members', 'editor', { type: 'folder', id: F2 });
    const mcp = { authorization: `Bearer ${await idp.token({ ...claims.user({ sub: 'sub-editor', org: 'acme' }), azp: 'notes-mcp', scope: 'notes:read notes:write' })}` };
    const r = await n.app.inject({ method: 'POST', url: '/v1/access', headers: mcp, payload: { subject: 'org:members', relation: 'viewer', type: 'folder', id: F1 } });
    assert.equal(r.statusCode, 403);
  });
});
