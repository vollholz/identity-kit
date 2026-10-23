/**
 * Modul `people`: Personenverzeichnis (aus Assets test/platform/people.test.ts, produktneutral mit der Beispiel-App
 * «notes»; Personenattribute bleiben in der App): Liste und Suche nach Name, Sicht auf E-Mail und letzten Zugriff,
 * Clients, Cursor, Sammelabfrage `ids`, Mandantentrennung, Recht aus der Option `people.permissions`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { defaultPeoplePermissions } from '../src/http/people.ts';
import { assetsCatalog, notesCatalog } from './support/catalogs.ts';
import { skipDb } from './support/db.ts';
import { claims, notesApp, notesDb, tenant, type NotesApp } from './support/http.ts';

const skip = await skipDb();
type Res = { status: number; body: any };
interface Person { id: string; kind: string; name: string; email: string | null; clientId: string | null; lastSeenAt: string | null }

test('Standardrecht: Fachrechte des Lese-Scopes und acl:read', () => {
  assert.deepEqual(defaultPeoplePermissions(notesCatalog), ['note:read', 'acl:read']);
  assert.ok(defaultPeoplePermissions(assetsCatalog).includes('object:read') && !defaultPeoplePermissions(assetsCatalog).includes('tenant:read'));
});

describe('Personenverzeichnis', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  const tok: Record<string, string> = {};
  const pid: Record<string, string> = {};

  async function call(who: string, method: string, url: string, app = n): Promise<Res> {
    const r = await app.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tok[who]}` } });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const names = (items: Person[]) => items.map(p => p.name);

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    n = await notesApp({ db: t.runtime, issuer: idp.issuer });
    const ada = randomUUID();
    tok.admin = await idp.token(claims.user({ sub: ada, org: 'acme', groupRoles: ['org-admin'], name: 'Ada Admin', email: 'ada@acme.example' }));
    tok.carla = await idp.token(claims.user({ org: 'acme', groupRoles: ['editor'], name: 'Carla Prüferin', email: 'carla@acme.example' }));
    tok.dora = await idp.token(claims.user({ org: 'acme', groupRoles: ['viewer'], name: 'dora Duss', email: 'dora@acme.example' }));
    tok.norole = await idp.token(claims.user({ org: 'acme', groupRoles: [], name: 'Nora Ohnerolle', email: 'nora@acme.example' }));
    await tenant(t.runtime, 'acme', 'notiz-sync', 'ohne-scope');
    tok.svc = await idp.token(claims.client({ clientId: 'notiz-sync', org: 'acme', roles: ['viewer'], scopes: ['notes:read'] }));
    tok.svcNoScope = await idp.token(claims.client({ clientId: 'ohne-scope', org: 'acme', roles: ['viewer'], scopes: [] }));
    tok.mcp = await idp.token({ ...claims.user({ sub: ada, org: 'acme', groupRoles: ['org-admin'], name: 'Ada Admin', email: 'ada@acme.example' }), azp: 'notes-mcp', scope: 'notes:read' });
    tok.gustav = await idp.token(claims.user({ org: 'globex', groupRoles: ['org-admin'], name: 'Gustav Globex', email: 'gustav@globex.example' }));
    // Jeder Zugriff legt den Principal an
    for (const who of ['admin', 'carla', 'dora', 'norole', 'svc', 'svcNoScope', 'gustav']) {
      const r = await n.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tok[who]}` } });
      assert.equal(r.statusCode, 200, `${who}: ${r.body}`);
      pid[who] = JSON.parse(r.body).principal.id;
    }
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('Liste: bekannte Personen des Mandanten nach Name, ohne Clients; Felder je nach Sicht', async () => {
    const list = ok(await call('dora', 'GET', '/v1/people')).items as Person[];
    assert.deepEqual(names(list), ['Ada Admin', 'Carla Prüferin', 'dora Duss', 'Nora Ohnerolle'], 'sortiert ohne Gross/Klein, nur kind user, nur acme');
    const carla = list.find(p => p.name === 'Carla Prüferin')!;
    assert.deepEqual([carla.id, carla.kind, carla.email, carla.lastSeenAt], [pid.carla, 'user', 'carla@acme.example', null], 'E-Mail für Personen, letzter Zugriff nur für Verwaltende');
    const asAdmin = ok(await call('admin', 'GET', `/v1/people/${pid.carla}`)) as Person;
    assert.ok(asAdmin.lastSeenAt && !Number.isNaN(Date.parse(asAdmin.lastSeenAt)));
    const clients = ok(await call('admin', 'GET', '/v1/people?kind=client')).items as Person[];
    assert.deepEqual(clients.map(c => c.clientId).sort(), ['notiz-sync', 'ohne-scope']);
    assert.ok(clients.every(c => c.kind === 'client' && c.email === null));
    assert.equal(ok(await call('admin', 'GET', '/v1/people?kind=client&q=SYNC')).items.length, 1, 'Clients auch über die Client-ID');
  });

  test('Entfernte Personen fehlen in der Liste, bleiben einzeln lesbar', async () => {
    await t.inspect.query('UPDATE notes.principal SET removed_at = now() WHERE id = $1', [pid.norole]);
    try {
      assert.ok(!names(ok(await call('dora', 'GET', '/v1/people')).items).includes('Nora Ohnerolle'));
      assert.equal(ok(await call('dora', 'GET', `/v1/people/${pid.norole}`)).name, 'Nora Ohnerolle');
    } finally { await t.inspect.query('UPDATE notes.principal SET removed_at = NULL WHERE id = $1', [pid.norole]); }
  });

  test('Suche: Teilstring ohne Gross/Klein in Name und E-Mail, Platzhalter maskiert', async () => {
    assert.deepEqual(names(ok(await call('dora', 'GET', '/v1/people?q=PRÜF')).items), ['Carla Prüferin']);
    assert.deepEqual(names(ok(await call('dora', 'GET', '/v1/people?q=a%20ad')).items), ['Ada Admin']);
    assert.deepEqual(names(ok(await call('dora', 'GET', '/v1/people?q=carla%40acme')).items), ['Carla Prüferin'], 'E-Mail');
    assert.deepEqual(ok(await call('dora', 'GET', '/v1/people?q=%25')).items, [], '«%» ist kein Platzhalter');
    assert.deepEqual(ok(await call('dora', 'GET', '/v1/people?q=_')).items, [], '«_» ist kein Platzhalter');
    assert.deepEqual(ok(await call('dora', 'GET', '/v1/people?q=gustav')).items, [], 'anderer Mandant');
  });

  test('Maschinen-Clients und MCP: ohne E-Mail, Suche nicht über die E-Mail; ohne Recht kein Zugriff', async () => {
    for (const who of ['svc', 'mcp']) {
      const list = ok(await call(who, 'GET', '/v1/people')).items as Person[];
      assert.equal(list.length, 4, who);
      assert.ok(list.every(p => p.email === null), who);
      assert.deepEqual(ok(await call(who, 'GET', '/v1/people?q=carla%40acme')).items, [], `${who}: E-Mail nicht erratbar`);
      assert.deepEqual(names(ok(await call(who, 'GET', '/v1/people?q=carla')).items), ['Carla Prüferin']);
    }
    assert.ok(ok(await call('svc', 'GET', '/v1/people')).items.every((p: Person) => p.lastSeenAt === null));
    assert.equal((await call('svcNoScope', 'GET', '/v1/people')).status, 403);
    const r = await call('norole', 'GET', '/v1/people');
    assert.equal(r.status, 403, 'ohne note:read und acl:read');
    assert.match(r.body.detail, /Notizen lesen/);
    assert.equal((await call('norole', 'GET', `/v1/people/${pid.carla}`)).status, 403);
  });

  test('Cursor-Paginierung: vollständig, stabil, Cursor nur für dieselbe Abfrage', async () => {
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const r: { items: Person[]; nextCursor: string | null } = ok(await call('dora', 'GET', `/v1/people?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      seen.push(...names(r.items));
      cursor = r.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assert.deepEqual(seen, ['Ada Admin', 'Carla Prüferin', 'dora Duss', 'Nora Ohnerolle']);
    const first = ok(await call('dora', 'GET', '/v1/people?limit=1'));
    assert.equal((await call('dora', 'GET', `/v1/people?limit=1&q=a&cursor=${encodeURIComponent(first.nextCursor)}`)).status, 422, 'andere Suche');
    assert.equal((await call('svc', 'GET', `/v1/people?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).status, 422, 'andere Sicht (ohne E-Mail)');
    assert.equal((await call('dora', 'GET', '/v1/people?cursor=kaputt')).status, 422);
  });

  test('Mandantentrennung: Personen anderer Mandanten unsichtbar (RLS)', async () => {
    assert.deepEqual(names(ok(await call('gustav', 'GET', '/v1/people')).items), ['Gustav Globex']);
    assert.equal((await call('gustav', 'GET', `/v1/people/${pid.carla}`)).status, 404);
    assert.equal((await call('admin', 'GET', `/v1/people/${pid.gustav}`)).status, 404);
    assert.equal((await call('admin', 'GET', `/v1/people/${randomUUID()}`)).status, 404);
    const svc = ok(await call('admin', 'GET', `/v1/people/${pid.svc}`)) as Person;
    assert.deepEqual([svc.kind, svc.clientId], ['client', 'notiz-sync']);
  });

  test('Sammelabfrage ids: Personen und Clients auf einmal, fremde und unbekannte fehlen, nicht kombinierbar', async () => {
    const qs = [pid.carla, pid.svc, pid.gustav, randomUUID()].map(id => `ids=${id}`).join('&');
    const r = ok(await call('admin', 'GET', `/v1/people?${qs}`));
    assert.deepEqual(r.items.map((x: Person) => x.id).sort(), [pid.carla, pid.svc].sort(), 'Gustav aus anderem Mandanten fehlt');
    assert.equal(r.nextCursor, null);
    assert.equal((await call('admin', 'GET', `/v1/people?ids=${pid.carla}&q=carla`)).status, 422);
    const many = Array.from({ length: 101 }, () => `ids=${randomUUID()}`).join('&');
    assert.equal((await call('admin', 'GET', `/v1/people?${many}`)).status, 422, 'höchstens 100');
  });

  test('Option people.permissions: eigenes Recht öffnet das Verzeichnis; unbekannte Rechte zählen nicht', async () => {
    const own = await notesApp({ db: t.runtime, issuer: idp.issuer, plugin: { people: { permissions: ['note:write'] } } });
    try {
      assert.equal((await call('dora', 'GET', '/v1/people', own)).status, 403, 'viewer ohne note:write');
      assert.equal((await call('carla', 'GET', '/v1/people', own)).status, 200);
    } finally { await own.app.close(); }
    await assert.rejects(notesApp({ db: t.runtime, issuer: idp.issuer, plugin: { people: { permissions: ['gibt:es-nicht' as never] } } }), /kein Recht öffnet/);
  });
});
