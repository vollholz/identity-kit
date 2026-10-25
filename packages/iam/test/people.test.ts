/**
 * Modul `people`: Personenverzeichnis (Beispiel-App «notes»; Personenattribute bleiben in der App): Liste und Suche nach Name, Sicht auf E-Mail und letzten Zugriff,
 * Clients, Cursor, Sammelabfrage `ids`, Mandantentrennung, Recht aus der Option `people.permissions`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { defaultPeoplePermissions } from '../src/http/people.ts';
import { notesModel, simpleModel } from './support/models.ts';
import { skipDb } from './support/db.ts';
import { claims, grantClient, notesApp, notesDb, tenant, withRole, type NotesApp } from './support/http.ts';

const skip = await skipDb();
type Res = { status: number; body: any };
interface Person { id: string; kind: string; name: string; email: string | null; clientId: string | null; lastSeenAt: string | null }

test('Standardrecht: Fachrechte des Lese-Scopes und access:admin', () => {
  assert.deepEqual(defaultPeoplePermissions(notesModel), ['note:read', 'team:read', 'view:read', 'access:admin']);
  assert.deepEqual(defaultPeoplePermissions(simpleModel), [], 'ohne Lese-Scope und ohne Typen ausser org');
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
    const pool = t.runtime;
    tok.admin = await idp.token(await withRole(pool, claims.user({ sub: ada, org: 'acme', name: 'Ada Admin', email: 'ada@acme.example' }), 'org-admin'));
    tok.carla = await idp.token(await withRole(pool, claims.user({ org: 'acme', name: 'Carla Prüferin', email: 'carla@acme.example' }), 'editor'));
    tok.dora = await idp.token(await withRole(pool, claims.user({ org: 'acme', name: 'dora Duss', email: 'dora@acme.example' }), 'viewer'));
    tok.norole = await idp.token(claims.user({ org: 'acme', name: 'Nora Ohnerolle', email: 'nora@acme.example' }));
    const A = await tenant(pool, 'acme');
    await grantClient(pool, A, 'notiz-sync', 'viewer'); await grantClient(pool, A, 'ohne-scope', 'viewer');
    tok.svc = await idp.token(claims.client({ clientId: 'notiz-sync', org: 'acme', scopes: ['notes:read'] }));
    tok.svcNoScope = await idp.token(claims.client({ clientId: 'ohne-scope', org: 'acme', scopes: [] }));
    tok.mcp = await idp.token({ ...claims.user({ sub: ada, org: 'acme', name: 'Ada Admin', email: 'ada@acme.example' }), azp: 'notes-mcp', scope: 'notes:read' });
    tok.gustav = await idp.token(await withRole(pool, claims.user({ org: 'globex', name: 'Gustav Globex', email: 'gustav@globex.example' }), 'org-admin'));
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
    assert.equal(r.status, 403, 'ohne note:read und access:admin');
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
    // Opaker Cursor mit 36 erlaubten Zeichen, aber keiner UUID: 422 statt Fehler der Datenbank
    const c = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...c, id: '-'.repeat(36) })).toString('base64url');
    assert.equal((await call('dora', 'GET', `/v1/people?limit=1&cursor=${forged}`)).status, 422);
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

  test('Option people.permissions: eigenes Recht öffnet das Verzeichnis; unbekannte Rechte melden einen Fehler beim Start', async () => {
    const own = await notesApp({ db: t.runtime, issuer: idp.issuer, plugin: { people: { permissions: ['note:write'] } } });
    try {
      assert.equal((await call('dora', 'GET', '/v1/people', own)).status, 403, 'viewer ohne note:write');
      assert.equal((await call('carla', 'GET', '/v1/people', own)).status, 200);
    } finally { await own.app.close(); }
    await assert.rejects(notesApp({ db: t.runtime, issuer: idp.issuer, plugin: { people: { permissions: ['note:write', 'gibt:es-nicht' as never] } } }), /unbekannte Rechte in people.permissions: gibt:es-nicht/);
  });

  test('Ohne Recht, das das Verzeichnis öffnet: App startet ohne Modul people; ausdrücklich verlangt ein Fehler', async () => {
    const o = { db: t.runtime, issuer: idp.issuer, model: simpleModel, resources: null };
    const x = await notesApp(o);
    try { assert.equal((await call('dora', 'GET', '/v1/people', x)).status, 404); } finally { await x.app.close(); }
    await assert.rejects(notesApp({ ...o, plugin: { modules: ['account', 'people'] } }), /kein Recht öffnet/);
  });
});
