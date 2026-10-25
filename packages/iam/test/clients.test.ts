/**
 * Modul `clients`: Freigabe von Maschinen-Clients je Mandant (Spezifikation Kap. 9.6, 12.1; A3, A18): Ohne Tupel
 * `client:<id> <rolle> org` kein Zugriff, kein Principal, kein neuer Mandant; Freigabe gilt nur im eigenen Mandanten;
 * Rollen nur aus Tupeln (nie aus dem Token); Regeln wie bei Mitgliedern; Entzug wirkt sofort; Protokoll.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { skipDb } from './support/db.ts';
import { claims, notesApp, notesDb, withRole, type NotesApp } from './support/http.ts';

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
    idp.token({ ...claims.client({ clientId, org: 'x', scopes: ['notes:read', 'notes:write'] }), organization: Array.isArray(org) ? org : [org], ...extra });
  const auditOf = async (alias: string, action: string) => (await t.inspect.query(
    'SELECT a.data, a.actor_name FROM notes.audit_log a JOIN notes.tenant t ON t.id = a.tenant_id WHERE t.alias = $1 AND a.action = $2 ORDER BY a.seq', [alias, action])).rows;

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    n = await notesApp({ db: t.runtime, issuer: idp.issuer });
    const pool = t.runtime;
    tok.acme = await idp.token(await withRole(pool, claims.user({ org: 'acme', name: 'Ada Acme' }), 'org-admin', 2));
    tok.globex = await idp.token(await withRole(pool, claims.user({ org: 'globex', name: 'Gus Globex' }), 'org-admin'));
    tok.viewer = await idp.token(await withRole(pool, claims.user({ org: 'acme' }), 'viewer'));
    tok.editor = await idp.token(await withRole(pool, claims.user({ org: 'acme', name: 'Eda Editor' }), 'editor'));
    tok.paula = await idp.token({ ...await withRole(pool, claims.user({ org: 'ops', name: 'Paula Plattform' }), 'org-admin'), realm_access: { roles: ['platform-admin'] } });
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
    const disguised = await idp.token({ ...claims.user({ org: 'acme' }), azp: 'fremde-app' });
    assert.equal((await call(disguised, 'GET', '/v1/me')).body.title, 'Client nicht freigegeben', 'Personendaten im Token eines fremden Clients');
    // Über den MCP-Dienst (azp = notes-mcp): massgebend ist der ursprüngliche Client
    const viaMcp = await idp.token({ ...claims.client({ clientId: 'import', org: 'acme', scopes: ['notes:read'] }), azp: 'notes-mcp' });
    assert.match((await call(viaMcp, 'GET', '/v1/me')).body.detail ?? '', /«import»/);
  });

  test('members:admin gibt frei, Client arbeitet nur in diesem Mandanten mit Rollen aus Tupeln; Entzug wirkt sofort; Protokoll', async () => {
    assert.equal((await call(tok.viewer!, 'PUT', '/v1/admin/clients/import', { body: { roles: ['viewer'] } })).status, 403, 'nur members:admin');
    assert.equal((await call(tok.acme!, 'PUT', '/v1/admin/clients/import', { body: {} })).status, 422, 'Rollen Pflicht');
    assert.equal((await call(tok.acme!, 'PUT', '/v1/admin/clients/import', { body: { roles: [] } })).status, 422, 'mindestens eine Rolle');
    const g = ok(await call(tok.acme!, 'PUT', '/v1/admin/clients/import', { body: { roles: ['editor'], description: 'Inventar-Import' } }));
    assert.deepEqual([g.clientId, g.description, g.createdBy, g.roles, g.clearance, g.places], ['import', 'Inventar-Import', 'Ada Acme', ['editor'], 0, 0]);
    const again = ok(await call(tok.acme!, 'PUT', '/v1/admin/clients/import', { body: { roles: ['viewer', 'editor'] } }));
    assert.deepEqual([again.principalId, again.description, again.roles], [g.principalId, 'Inventar-Import', ['editor', 'viewer']], 'Beschreibung bleibt, Rollen genau die Liste');
    const me = ok(await call(await client('acme'), 'GET', '/v1/me'));
    assert.deepEqual([me.principal.kind, me.roles], ['client', ['editor', 'viewer']]);
    assert.equal((await call(await client('globex'), 'GET', '/v1/me')).status, 403, 'Freigabe in acme gilt nicht für globex');
    const multi = await client(['acme', 'globex']);
    assert.equal((await call(multi, 'GET', '/v1/me', { tenant: 'globex' })).status, 403);
    ok(await call(multi, 'GET', '/v1/me', { tenant: 'acme' }));
    // Rollen im Token zählen nie
    const withRoles = await client('acme', 'import', { resource_access: { import: { roles: ['org-admin'] } }, realm_access: { roles: ['platform-admin'] } });
    assert.deepEqual(ok(await call(withRoles, 'GET', '/v1/me')).roles, ['editor', 'viewer']);
    // Maschinen-Clients selbst verwalten keine Freigaben
    assert.equal((await call(await client('acme'), 'PUT', '/v1/admin/clients/anderer', { body: { roles: ['viewer'] } })).status, 403);
    // Person mit org-admin über den MCP-Dienst (scope-gebunden): nie
    const viaMcp = await idp.token({ ...claims.user({ org: 'acme', name: 'Ada Acme' }), sub: JSON.parse(Buffer.from(tok.acme!.split('.')[1]!, 'base64url').toString()).sub, azp: 'notes-mcp', scope: 'openid notes:read notes:write' });
    assert.equal((await call(viaMcp, 'GET', '/v1/admin/clients')).status, 403, 'MCP: nur Personen direkt');
    assert.equal((await call(viaMcp, 'PUT', '/v1/admin/clients/anderer', { body: { roles: ['viewer'] } })).status, 403);
    // globex sieht die Freigabe von acme nicht
    assert.deepEqual(ok(await call(tok.globex!, 'GET', '/v1/admin/clients')).items, []);
    assert.equal((await call(tok.globex!, 'DELETE', '/v1/admin/clients/import')).status, 404);
    const list = ok(await call(tok.acme!, 'GET', '/v1/admin/clients')).items;
    assert.equal(list.length, 1);
    assert.ok(list[0].lastUsedAt, 'letzter Zugriff');
    assert.deepEqual(list[0].lastScopes, ['notes:read', 'notes:write']);
    assert.equal((await call(tok.acme!, 'DELETE', '/v1/admin/clients/import')).status, 204);
    assert.equal((await call(await client('acme'), 'GET', '/v1/me')).status, 403, 'Entzug sofort');
    assert.equal((await call(tok.acme!, 'DELETE', '/v1/admin/clients/import')).status, 404, 'ohne Tupel keine Freigabe');
    assert.deepEqual((await auditOf('acme', 'client.granted')).map(a => [a.data.clientId, a.data.roles, a.actor_name]), [['import', ['editor'], 'Ada Acme'], ['import', ['editor', 'viewer'], 'Ada Acme']]);
    assert.equal((await auditOf('acme', 'client.revoked')).length, 1);
    assert.equal((await auditOf('acme', 'access.revoked')).filter(a => String(a.data.subject).startsWith('client:')).length, 2, 'je Tupel access.revoked');
    assert.equal((await auditOf('globex', 'client.granted')).length, 0);
    assert.equal((await call(tok.acme!, 'PUT', '/v1/admin/clients/mit leerzeichen', { body: { roles: ['viewer'] } })).status, 422);
  });

  test('Regeln: org-admin nur durch die Plattform, niemand gibt mehr als er hat, Freigabestufe nie über die eigene', async () => {
    const r = await call(tok.acme!, 'PUT', '/v1/admin/clients/bot', { body: { roles: ['org-admin'] } });
    assert.deepEqual([r.status, r.body.reason], [403, 'platform-admin-only']);
    // editor hat members:admin nicht: Verwaltung verweigert
    assert.equal((await call(tok.editor!, 'PUT', '/v1/admin/clients/bot', { body: { roles: ['viewer'] } })).status, 403);
    // Freigabestufe: Ada hat 2, Gus 0
    const c = ok(await call(tok.acme!, 'PUT', '/v1/admin/clients/bot', { body: { roles: ['viewer'], clearance: 1 } }));
    assert.equal(c.clearance, 1);
    ok(await call(tok.globex!, 'PUT', '/v1/admin/clients/bot', { body: { roles: ['viewer'] } }));
    const high = await call(tok.globex!, 'PUT', '/v1/admin/clients/bot', { body: { roles: ['viewer'], clearance: 1 } });
    assert.deepEqual([high.status, high.body.reason], [403, 'exceeds-own']);
    assert.equal(ok(await call(tok.globex!, 'GET', '/v1/admin/clients')).items[0].clearance, 0, 'nichts geändert');
    // Unbekannte Rolle
    assert.equal((await call(tok.acme!, 'PUT', '/v1/admin/clients/bot', { body: { roles: ['gibt-es-nicht'] } })).status, 422);
    for (const a of ['acme', 'globex']) ok(await call(a === 'acme' ? tok.acme! : tok.globex!, 'DELETE', '/v1/admin/clients/bot'), 204);
  });

  test('Plattform-Administration gibt für eine beliebige Organisation frei (auch org-admin); andere nicht', async () => {
    assert.equal((await call(tok.acme!, 'PUT', '/v1/platform/organizations/globex/clients/bot', { body: { roles: ['viewer'] } })).status, 403);
    ok(await call(tok.paula!, 'PUT', '/v1/platform/organizations/globex/clients/bot', { body: { roles: ['editor'], description: 'durch Plattform' } }));
    assert.equal((await call(tok.paula!, 'GET', '/v1/platform/organizations/unbekannt/clients')).status, 404);
    assert.equal((await call(tok.paula!, 'GET', '/v1/platform/organizations/GLOBEX/clients')).status, 422, 'Alias nur klein (Schema)');
    assert.deepEqual(ok(await call(tok.globex!, 'GET', '/v1/admin/clients')).items.map((c: { clientId: string }) => c.clientId), ['bot']);
    const a = (await auditOf('globex', 'client.granted')).at(-1)!;
    assert.deepEqual([a.actor_name, a.data.platformAdmin, a.data.actorTenant], ['Paula Plattform', true, undefined]);
    const before = ok(await call(tok.paula!, 'GET', '/v1/platform/organizations/globex/clients')).items[0];
    assert.deepEqual([before.lastUsedAt, before.lastScopes], [null, null], 'noch nie benutzt');
    ok(await call(await client('globex', 'bot'), 'GET', '/v1/me'));
    const seen = ok(await call(tok.paula!, 'GET', '/v1/platform/organizations/globex/clients')).items[0];
    assert.deepEqual([seen.roles, seen.lastScopes], [['editor'], ['notes:read', 'notes:write']]);
    const admin = ok(await call(tok.paula!, 'PUT', '/v1/platform/organizations/globex/clients/bot', { body: { roles: ['org-admin'] } }));
    assert.deepEqual(admin.roles, ['org-admin'], 'org-admin durch die Plattform');
    ok(await call(tok.paula!, 'DELETE', '/v1/platform/organizations/globex/clients/bot'), 204);
    assert.equal((await auditOf('globex', 'client.revoked')).at(-1)!.data.platformAdmin, true);
  });

  test('Scopes des Tokens am Principal, nur bei Maschinen-Clients, Änderung sofort; Austausch über MCP zählt für die Freigabe', async () => {
    ok(await call(tok.globex!, 'PUT', '/v1/admin/clients/report', { body: { roles: ['viewer'] } }));
    const sub = randomUUID();
    const as = (scopes: string[]) => idp.token({ ...claims.client({ clientId: 'report', org: 'globex', scopes }), sub });
    ok(await call(await as(['notes:read']), 'GET', '/v1/me'));
    ok(await call(await as(['notes:read', 'notes:write']), 'GET', '/v1/me'));
    const g = ok(await call(tok.globex!, 'GET', '/v1/admin/clients')).items.find((c: { clientId: string }) => c.clientId === 'report');
    assert.deepEqual(g.lastScopes, ['notes:read', 'notes:write'], 'neue Scopes ohne Warten auf den Zwischenspeicher');
    const users = (await t.inspect.query("SELECT count(*)::int AS n FROM notes.principal WHERE kind = 'user' AND last_scopes IS NOT NULL")).rows[0].n;

    ok(await call(tok.globex!, 'PUT', '/v1/admin/clients/svc', { body: { roles: ['editor'] } }));
    const exchanged = await client('globex', 'notes-mcp', { client_id: 'svc', preferred_username: 'service-account-svc', sub: randomUUID() });
    ok(await call(exchanged, 'GET', '/v1/me'));
    const svc = ok(await call(tok.globex!, 'GET', '/v1/admin/clients')).items.find((c: { clientId: string }) => c.clientId === 'svc');
    assert.ok(svc.lastUsedAt, 'Zugriff über MCP zählt für die Freigabe «svc»');
    assert.deepEqual(svc.lastScopes, ['notes:read', 'notes:write']);
    assert.equal(users, 0, 'bei Personen nie gespeichert');
  });
});
