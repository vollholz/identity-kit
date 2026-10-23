/**
 * Modul `clients`: Freigabe von Maschinen-Clients je Mandant (aus Assets test/platform/multi-org.test.ts, Abschnitt
 * «Maschinen-Clients: Freigabe je Mandant», produktneutral mit der Beispiel-App «notes»). Ohne Freigabe kein Zugriff,
 * kein Principal, kein neuer Mandant; Freigabe gilt nur im eigenen Mandanten; Entzug wirkt sofort; Protokoll.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { skipDb } from './support/db.ts';
import { claims, notesApp, notesDb, type NotesApp } from './support/http.ts';

const skip = await skipDb();
type Res = { status: number; body: any };

describe('Maschinen-Clients: Freigabe je Mandant', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  const tok: Record<string, string> = {};
  async function call(token: string, method: string, url: string, o: { tenant?: string; body?: unknown } = {}): Promise<Res> {
    const r = await n.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}`, ...(o.tenant ? { 'x-tenant': o.tenant } : {}) }, ...(o.body !== undefined ? { payload: o.body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const client = (org: string | string[], clientId = 'import', extra: Record<string, unknown> = {}) =>
    idp.token({ ...claims.client({ clientId, org: 'x', roles: ['editor'], scopes: ['notes:read', 'notes:write'] }), organization: Array.isArray(org) ? org : [org], ...extra });
  const auditOf = async (alias: string, action: string) => (await t.inspect.query(
    'SELECT a.data, a.actor_name FROM notes.audit_log a JOIN notes.tenant t ON t.id = a.tenant_id WHERE t.alias = $1 AND a.action = $2 ORDER BY a.seq', [alias, action])).rows;

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    n = await notesApp({ db: t.runtime, issuer: idp.issuer });
    tok.acme = await idp.token(claims.user({ org: 'acme', groupRoles: ['org-admin'], name: 'Ada Acme' }));
    tok.globex = await idp.token(claims.user({ org: 'globex', groupRoles: ['org-admin'], name: 'Gus Globex' }));
    tok.viewer = await idp.token(claims.user({ org: 'acme', groupRoles: ['viewer'] }));
    tok.paula = await idp.token({ ...claims.user({ org: 'ops', groupRoles: ['org-admin'], name: 'Paula Plattform' }), realm_access: { roles: ['platform-admin'] } });
    for (const w of ['acme', 'globex', 'paula']) ok(await call(tok[w]!, 'GET', '/v1/me'));
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('ohne Freigabe 403 mit klarer Meldung; kein Principal, kein neuer Mandant', async () => {
    const tenants = Number((await t.inspect.query('SELECT count(*) FROM notes.tenant')).rows[0].count);
    const r = await call(await client('acme'), 'GET', '/v1/me');
    assert.equal(r.status, 403);
    assert.equal(r.body.title, 'Client nicht freigegeben');
    assert.match(r.body.detail, /«import» ist für die Organisation «acme» nicht freigegeben.*PUT \/v1\/admin\/clients/);
    assert.equal((await call(await client('neu-org'), 'GET', '/v1/me')).status, 403, 'unbekannte Organisation');
    assert.equal(Number((await t.inspect.query('SELECT count(*) FROM notes.tenant')).rows[0].count), tenants, 'Maschinen-Clients legen keinen Mandanten an');
    assert.equal(Number((await t.inspect.query("SELECT count(*) FROM notes.principal WHERE kind = 'client'")).rows[0].count), 0);
  });

  test('Person oder Client: Service Account ohne Profil-Scopes und Tokens fremder Clients gelten als Client', async () => {
    const bare = await idp.token({ sub: randomUUID(), azp: 'import', organization: ['acme'], scope: 'notes:read', resource_access: { 'notes-platform': { roles: ['org-admin'] } } });
    assert.equal((await call(bare, 'GET', '/v1/me')).body.title, 'Client nicht freigegeben');
    const disguised = await idp.token({ ...claims.user({ org: 'acme', roles: ['org-admin'] }), azp: 'fremde-app' });
    assert.equal((await call(disguised, 'GET', '/v1/me')).body.title, 'Client nicht freigegeben', 'Personendaten im Token eines fremden Clients');
    // Über den MCP-Dienst (azp = notes-mcp): massgebend ist der ursprüngliche Client
    const viaMcp = await idp.token({ ...claims.client({ clientId: 'import', org: 'acme', roles: ['editor'], scopes: ['notes:read'] }), azp: 'notes-mcp' });
    assert.match((await call(viaMcp, 'GET', '/v1/me')).body.detail ?? '', /«import»/);
  });

  test('org-admin gibt frei, Client arbeitet nur in diesem Mandanten; Entzug wirkt sofort; Protokoll', async () => {
    assert.equal((await call(tok.viewer!, 'PUT', '/v1/admin/clients/import', { body: {} })).status, 403, 'nur org-admin');
    const g = ok(await call(tok.acme!, 'PUT', '/v1/admin/clients/import', { body: { description: 'Inventar-Import' } }), 201);
    assert.deepEqual([g.clientId, g.description, g.createdBy], ['import', 'Inventar-Import', 'Ada Acme']);
    ok(await call(tok.acme!, 'PUT', '/v1/admin/clients/import', { body: { description: 'Inventar-Import (neu)' } }), 200);
    assert.equal(ok(await call(await client('acme'), 'GET', '/v1/me')).principal.kind, 'client');
    assert.equal((await call(await client('globex'), 'GET', '/v1/me')).status, 403, 'Freigabe in acme gilt nicht für globex');
    const multi = await client(['acme', 'globex']);
    assert.equal((await call(multi, 'GET', '/v1/me', { tenant: 'globex' })).status, 403);
    ok(await call(multi, 'GET', '/v1/me', { tenant: 'acme' }));
    // Maschinen-Clients selbst verwalten keine Freigaben, auch nicht mit org-admin
    const adminClient = await idp.token({ ...claims.client({ clientId: 'import', org: 'acme', roles: ['org-admin'], scopes: ['notes:read'] }) });
    assert.equal((await call(adminClient, 'PUT', '/v1/admin/clients/anderer', { body: {} })).status, 403);
    // globex sieht die Freigabe von acme nicht
    assert.deepEqual(ok(await call(tok.globex!, 'GET', '/v1/admin/clients')).items, []);
    assert.equal((await call(tok.globex!, 'DELETE', '/v1/admin/clients/import')).status, 404);
    const list = ok(await call(tok.acme!, 'GET', '/v1/admin/clients')).items;
    assert.equal(list.length, 1);
    assert.ok(list[0].lastUsedAt, 'letzter Zugriff');
    assert.ok(['editor', 'org-admin'].some(r => list[0].lastRoles.includes(r)), 'Rollen des letzten Tokens');
    assert.equal((await call(tok.acme!, 'DELETE', '/v1/admin/clients/import')).status, 204);
    assert.equal((await call(await client('acme'), 'GET', '/v1/me')).status, 403, 'Entzug sofort (diese Instanz)');
    assert.deepEqual((await auditOf('acme', 'client.granted')).map(a => [a.data.clientId, a.actor_name]), [['import', 'Ada Acme']]);
    assert.equal((await auditOf('acme', 'client.grant_updated')).length, 1);
    assert.equal((await auditOf('acme', 'client.revoked')).length, 1);
    assert.equal((await auditOf('globex', 'client.granted')).length, 0);
    assert.equal((await call(tok.acme!, 'PUT', '/v1/admin/clients/mit leerzeichen', { body: {} })).status, 422);
  });

  test('Plattform-Administration gibt für eine beliebige Organisation frei; andere nicht', async () => {
    assert.equal((await call(tok.acme!, 'PUT', '/v1/platform/organizations/globex/clients/bot', { body: {} })).status, 403);
    ok(await call(tok.paula!, 'PUT', '/v1/platform/organizations/globex/clients/bot', { body: { description: 'durch Plattform' } }), 201);
    assert.equal((await call(tok.paula!, 'GET', '/v1/platform/organizations/unbekannt/clients')).status, 404);
    assert.equal((await call(tok.paula!, 'GET', '/v1/platform/organizations/GLOBEX/clients')).status, 422, 'Alias nur klein (Schema)');
    assert.deepEqual(ok(await call(tok.globex!, 'GET', '/v1/admin/clients')).items.map((c: { clientId: string }) => c.clientId), ['bot']);
    const a = (await auditOf('globex', 'client.granted')).at(-1)!;
    assert.deepEqual([a.actor_name, a.data.platformAdmin, a.data.actorTenant], ['Paula Plattform', true, 'ops']);
    const before = ok(await call(tok.paula!, 'GET', '/v1/platform/organizations/globex/clients')).items[0];
    assert.deepEqual([before.lastUsedAt, before.lastRoles, before.lastScopes], [null, null, null], 'noch nie benutzt');
    ok(await call(await client('globex', 'bot'), 'GET', '/v1/me'));
    const seen = ok(await call(tok.paula!, 'GET', '/v1/platform/organizations/globex/clients')).items[0];
    assert.deepEqual([seen.lastRoles, seen.lastScopes], [['editor'], ['notes:read', 'notes:write']]);
    ok(await call(tok.paula!, 'DELETE', '/v1/platform/organizations/globex/clients/bot'), 204);
    assert.equal((await auditOf('globex', 'client.revoked')).at(-1)!.data.platformAdmin, true);
  });

  test('Rollen und Scopes des Tokens am Principal, nur bei Maschinen-Clients, Änderung sofort; Austausch über MCP zählt für die Freigabe', async () => {
    ok(await call(tok.globex!, 'PUT', '/v1/admin/clients/report', { body: {} }), 201);
    const sub = randomUUID();
    const as = (roles: string[], scopes: string[]) => idp.token({ ...claims.client({ clientId: 'report', org: 'globex', roles, scopes }), sub });
    ok(await call(await as(['viewer'], ['notes:read']), 'GET', '/v1/me'));
    ok(await call(await as(['viewer', 'editor'], ['notes:read', 'notes:write']), 'GET', '/v1/me'));
    const g = ok(await call(tok.globex!, 'GET', '/v1/admin/clients')).items.find((c: { clientId: string }) => c.clientId === 'report');
    assert.deepEqual([g.lastRoles, g.lastScopes], [['viewer', 'editor'], ['notes:read', 'notes:write']], 'neue Rollen ohne Warten auf den Zwischenspeicher');
    const users = (await t.inspect.query("SELECT count(*)::int AS n FROM notes.principal WHERE kind = 'user' AND (last_roles IS NOT NULL OR last_scopes IS NOT NULL)")).rows[0].n;

    ok(await call(tok.globex!, 'PUT', '/v1/admin/clients/svc', { body: {} }), 201);
    const exchanged = await client('globex', 'notes-mcp', { client_id: 'svc', preferred_username: 'service-account-svc', sub: randomUUID() });
    ok(await call(exchanged, 'GET', '/v1/me'));
    const svc = ok(await call(tok.globex!, 'GET', '/v1/admin/clients')).items.find((c: { clientId: string }) => c.clientId === 'svc');
    assert.ok(svc.lastUsedAt, 'Zugriff über MCP zählt für die Freigabe «svc»');
    assert.deepEqual([svc.lastRoles, svc.lastScopes], [['editor'], ['notes:read', 'notes:write']]);
    assert.equal(users, 0, 'bei Personen nie gespeichert');
  });
});
