/**
 * Modul `acl` über HTTP (aus Assets test/platform/acl-grants.test.ts, authz.test.ts D3/E2, catalog.test.ts «ACL» und
 * multi-org.test.ts, produktneutral mit der Beispiel-App «notes»): Freigaben je Bereich, Beschränkung (alter Name
 * `allow`), Verbote, Ausnahme org-admin nur für Personen, wirkungslose Einträge mit Feldmeldung (422), Gruppen anderer
 * Organisationen, Existenz der Ressource im eigenen Mandanten, wirksame Rechte (echt, aus Keycloak, aus dem letzten
 * Token, Simulation), Audit und Ereignis `acl.changed`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { defineCatalog } from '../src/catalog.ts';
import { withTenant } from '../src/db.ts';
import { notesInput } from './support/catalogs.ts';
import { skipDb } from './support/db.ts';
import { claims, folderWithNote, notesApp, notesDb, notesResources, tenant, type NotesApp } from './support/http.ts';

const skip = await skipDb();

/** Notiz-App mit Prüfer:in (liest Zugriffsregeln, ohne sie zu ändern). */
const input = notesInput();
// acl:admin auch auf Ordnern und Notizen: Verbote je Ressource sperren das Verwalten ihrer Zugriffsregeln
const catalog = defineCatalog({
  ...input,
  permissions: { ...input.permissions, 'acl:admin': { label: 'Zugriff verwalten', group: 'access', description: 'Zugriffsregeln anlegen und löschen.', resources: ['tenant', 'folder', 'note'] } },
  roles: { ...input.roles, auditor: { label: 'Prüfer:in', description: 'Liest Notizen, den Zugriff und die Organisation.', permissions: ['tenant:read', 'note:read', 'acl:read'] } },
  scopes: { ...input.scopes, 'notes:admin': { text: 'Zugriffsregeln verwalten', permissions: ['acl:read', 'acl:admin'] } },
});

type Res = { status: number; body: any };

describe('Zugriffsregeln über HTTP (Modul acl)', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  const member = new Map<string, { roles: string[]; groups: string[] } | 'fehler'>();

  async function call(who: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const r = await n.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tok[who]}`, ...headers }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const acl = (b: Record<string, unknown>, who = 'admin') => call(who, 'POST', '/v1/acl', b);
  const del = async (...entries: { id: string }[]) => { for (const e of entries) ok(await call('admin', 'DELETE', `/v1/acl/${e.id}`), 204); };
  const writes = async (who: string, note: string) => ok(await call(who, 'GET', `/v1/notes/${note}`)).write as boolean;
  const errors = (r: Res) => (r.body.errors ?? []) as { path: string; message: string }[];

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    n = await notesApp({ db: t.runtime, issuer: idp.issuer, catalog });
    n.iam.memberAccess = async (alias, subject) => {
      const m = member.get(`${alias}:${subject}`);
      if (m === 'fehler') throw new Error('Keycloak nicht erreichbar');
      return m ?? null;
    };
    id.A = await tenant(t.runtime, 'acme', 'import', 'reader');
    id.B = await tenant(t.runtime, 'globex');
    ({ folder: id.f1!, note: id.n1! } = await folderWithNote(t.runtime, id.A, 'IT'));
    ({ folder: id.f2!, note: id.n2! } = await folderWithNote(t.runtime, id.A, 'Personal'));
    ({ folder: id.g1!, note: id.gn1! } = await folderWithNote(t.runtime, id.B, 'Globex'));
    const person = (sub: string, roles: string[], groups: string[] = [], org = 'acme') => idp.token({ ...claims.user({ org, sub, groupRoles: roles }), groups: [...roles.map(r => `/orgs/${org}/${r}`), ...groups] });
    tok.admin = await person('anna', ['org-admin']);
    tok.auditor = await person('aldo', ['auditor']);
    tok.editor = await person('edi', ['editor']);
    tok.vera = await person('vera', ['viewer'], ['/it-team']);
    tok.ida = await person('ida', []);
    tok.globex = await person('gus', ['org-admin'], [], 'globex');
    tok.client = await idp.token(claims.client({ clientId: 'import', org: 'acme', roles: ['org-admin'], scopes: ['notes:read', 'notes:write'] }));
    tok.clientAdmin = await idp.token(claims.client({ clientId: 'import', org: 'acme', roles: ['org-admin'], scopes: ['notes:read', 'notes:admin'] }));
    tok.clientRead = await idp.token(claims.client({ clientId: 'reader', org: 'acme', roles: ['viewer'], scopes: ['notes:read'] }));
    // Principals anlegen (erster Zugriff)
    for (const who of ['admin', 'auditor', 'editor', 'vera', 'ida', 'client', 'clientRead', 'globex']) ok(await call(who, 'GET', '/v1/me'));
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('Freigabe: Leserin darf nur im freigegebenen Ordner ändern; Verbot darunter gilt auch für die Freigabe', async () => {
    assert.equal(await writes('vera', id.n1!), false);
    const g = ok(await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'user', principalRef: 'vera', permission: 'note:write', effect: 'grant' }), 201);
    assert.equal(g.effect, 'grant');
    assert.equal(await writes('vera', id.n1!), true);
    assert.equal(await writes('vera', id.n2!), false, 'anderer Ordner bleibt gesperrt');
    const me = ok(await call('vera', 'GET', '/v1/me'));
    assert.ok(!me.permissions.includes('note:write'));
    assert.deepEqual(me.grantedPermissions, ['note:write']);
    const d = ok(await acl({ resourceType: 'note', resourceId: id.n1, principalType: 'group', principalRef: '/it-team', permission: 'note:write', effect: 'deny' }), 201);
    assert.equal(await writes('vera', id.n1!), false, 'Verbot auf der Notiz');
    await del(g, d);
    assert.equal(await writes('vera', id.n1!), false, 'nach dem Entfernen wieder ohne Recht');
  });

  test('Rolle als Principal einer Freigabe; Clients brauchen den Scope', async () => {
    const g = ok(await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'role', principalRef: 'viewer', permission: 'note:write', effect: 'grant' }), 201);
    try {
      assert.equal(await writes('vera', id.n1!), true);
      assert.equal(await writes('clientRead', id.n1!), false, 'Scope notes:write fehlt');
    } finally { await del(g); }
  });

  test('Freigabe auf dem Mandanten zählt zu den Rechten auf Mandantenebene', async () => {
    const g = ok(await acl({ resourceType: 'tenant', principalType: 'user', principalRef: 'ida', permission: 'note:read', effect: 'grant' }), 201);
    try {
      const me = ok(await call('ida', 'GET', '/v1/me'));
      assert.deepEqual([me.permissions, me.grantedPermissions], [['note:read'], []]);
    } finally { await del(g); }
  });

  test('org-admin: Personen ausgenommen, Maschinen-Clients nicht', async () => {
    const d = ok(await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'client', principalRef: 'import', permission: 'note:write', effect: 'deny' }), 201);
    const p = ok(await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'group', principalRef: '/niemand', permission: 'note:write', effect: 'restrict' }), 201);
    try {
      assert.equal(await writes('client', id.n1!), false, 'Client mit org-admin: Verbot greift');
      assert.equal(await writes('client', id.n2!), true);
      assert.equal(await writes('admin', id.n1!), true, 'Person mit org-admin ausgenommen');
      assert.equal(await writes('editor', id.n1!), false, 'Beschränkung auf /niemand');
    } finally { await del(d, p); }
  });

  test('D3: wirkungslose oder unzulässige Einträge mit Feldmeldung abgelehnt, nichts gespeichert', async () => {
    const before = ok(await call('admin', 'GET', '/v1/acl')).items.length;
    const onLeaf = await acl({ resourceType: 'note', resourceId: id.n1, principalType: 'user', principalRef: 'vera', permission: 'note:write', effect: 'grant' });
    assert.deepEqual([onLeaf.status, errors(onLeaf).map(e => e.path)], [422, ['/effect']]);
    assert.match(errors(onLeaf)[0]!.message, /Freigaben gelten für Bereiche \(Organisation, Ordner\), nicht für einzelne Ressourcen vom Typ «Notiz»/);
    const wrongType = await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'role', principalRef: 'editor', permission: 'note:share' });
    assert.deepEqual([wrongType.status, errors(wrongType).map(e => e.path)], [422, ['/permission']]);
    assert.match(errors(wrongType)[0]!.message, /«Notizen teilen» \(note:share\) wirkt nicht auf «Ordner»; passend: Organisation\./);
    const adminOnly = await acl({ resourceType: 'tenant', principalType: 'user', principalRef: 'vera', permission: 'acl:admin', effect: 'grant' });
    assert.match(errors(adminOnly)[0]!.message, /hat nur die Rolle «Organisations-Admin» und lässt sich nicht freigeben/);
    const denyPerson = await acl({ resourceType: 'tenant', principalType: 'role', principalRef: 'auditor', permission: 'members:admin', effect: 'deny' });
    assert.match(errors(denyPerson)[0]!.message, /Wirksam nur für einen Maschinen-Client/);
    const adminRole = await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'role', principalRef: 'org-admin', permission: 'note:write' });
    assert.deepEqual(errors(adminRole).map(e => e.path), ['/principalRef']);
    const unknown = await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'role', principalRef: 'chef', permission: 'note:write' });
    assert.match(errors(unknown)[0]!.message, /Unbekannte Rolle «chef»; erlaubt: editor, viewer, auditor\./);
    const both = await acl({ resourceType: 'tenant', principalType: 'role', principalRef: 'org-admin', permission: 'acl:admin' });
    assert.equal(errors(both).length, 2, 'alle Feldfehler auf einmal');
    for (const b of [{ resourceType: 'folder', principalType: 'role', principalRef: 'viewer', permission: 'note:read' }, { resourceType: 'tenant', resourceId: id.f1, principalType: 'role', principalRef: 'viewer', permission: 'note:read' }]) {
      assert.match((await acl(b)).body.detail, /`resourceId` ist für «tenant» leer und sonst Pflicht/);
    }
    assert.equal((await acl({ resourceType: 'board', principalType: 'role', principalRef: 'viewer', permission: 'note:read' })).status, 422, 'unbekannter Ressourcentyp (Schema)');
    assert.equal(ok(await call('admin', 'GET', '/v1/acl')).items.length, before, 'nichts gespeichert');

    // Verbot eines Rechts nur von org-admin für einen Maschinen-Client ist erlaubt; alter Name allow, Standard restrict
    const forClient = ok(await acl({ resourceType: 'tenant', principalType: 'client', principalRef: 'import', permission: 'acl:admin', effect: 'deny' }), 201);
    const legacy = ok(await acl({ resourceType: 'folder', resourceId: id.f2, principalType: 'group', principalRef: '/it-team', permission: 'note:read', effect: 'allow' }), 201);
    const dflt = ok(await acl({ resourceType: 'folder', resourceId: id.f2, principalType: 'role', principalRef: 'editor', permission: 'note:read' }), 201);
    assert.deepEqual([legacy.effect, dflt.effect], ['restrict', 'restrict']);
    try {
      ok(await call('vera', 'GET', `/v1/notes/${id.n2}`));
      assert.equal((await call('clientRead', 'GET', `/v1/notes/${id.n2}`)).status, 403, 'weder Gruppe noch Rolle editor');
    } finally { await del(forClient, legacy, dflt); }
  });

  test('Ressource im eigenen Mandanten: unbekannt oder fremd 404; Gruppen anderer Organisationen 422; eigene Rollen bekannt', async () => {
    const missing = await acl({ resourceType: 'folder', resourceId: '00000000-0000-4000-8000-000000000000', principalType: 'role', principalRef: 'viewer', permission: 'note:read' });
    assert.deepEqual([missing.status, missing.body.title], [404, 'Ressource folder nicht gefunden']);
    assert.equal((await acl({ resourceType: 'folder', resourceId: id.g1, principalType: 'role', principalRef: 'viewer', permission: 'note:read' })).status, 404, 'Ordner von globex');
    assert.equal((await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'role', principalRef: 'viewer', permission: 'note:read' }, 'globex')).status, 404, 'globex auf den Ordner von acme');
    const foreign = await acl({ resourceType: 'tenant', principalType: 'group', principalRef: '/orgs/globex/viewer', permission: 'note:read', effect: 'deny' });
    assert.equal(foreign.status, 422);
    assert.match(errors(foreign)[0]!.message, /Nur Gruppen dieser Organisation \(\/orgs\/acme\/…\)/);
    const own = ok(await acl({ resourceType: 'tenant', principalType: 'group', principalRef: '/orgs/acme/viewer', permission: 'note:read', effect: 'deny' }), 201);
    await withTenant(t.runtime, { tenantId: id.A! }, tx => tx.query("INSERT INTO notes.tenant_role (tenant_id, key, label, description, permissions) VALUES ($1, 'c-pflege', 'Pflege', 'Pflegt Notizen.', '{note:read}')", [id.A]));
    n.iam.access.invalidate(id.A!);
    const custom = ok(await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'role', principalRef: 'c-pflege', permission: 'note:write', effect: 'grant' }), 201);
    await del(own, custom);
  });

  test('Rechte: ohne acl:read kein Lesen, ohne acl:admin kein Schreiben (403 mit Label)', async () => {
    assert.equal((await call('vera', 'GET', '/v1/acl')).body.detail, 'Dir fehlt das Recht «Zugriff lesen» (acl:read).');
    assert.equal((await call('vera', 'GET', '/v1/acl/effective')).status, 403);
    const e = ok(await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'role', principalRef: 'editor', permission: 'note:write', effect: 'deny' }), 201);
    try {
      const list = ok(await call('auditor', 'GET', '/v1/acl?resourceType=folder')).items;
      assert.deepEqual(list.map((x: { id: string }) => x.id), [e.id]);
      assert.deepEqual(ok(await call('auditor', 'GET', `/v1/acl?resourceId=${id.f2}`)).items, []);
      assert.equal((await acl({ resourceType: 'tenant', principalType: 'role', principalRef: 'viewer', permission: 'note:read' }, 'auditor')).status, 403);
      assert.equal((await call('auditor', 'DELETE', `/v1/acl/${e.id}`)).status, 403);
      assert.deepEqual(ok(await call('globex', 'GET', '/v1/acl')).items, [], 'globex sieht die Einträge von acme nicht');
      assert.equal((await call('globex', 'DELETE', `/v1/acl/${e.id}`)).status, 404, 'globex löscht nicht in acme');
    } finally { await del(e); }
    assert.equal((await call('admin', 'DELETE', `/v1/acl/${e.id}`)).status, 404, 'schon gelöscht');
  });

  test('keine Duplikate: derselbe Eintrag ein zweites Mal 422, nichts gespeichert, kein Ereignis', async () => {
    const b = { resourceType: 'folder', resourceId: id.f1, principalType: 'role', principalRef: 'viewer', permission: 'note:read', effect: 'deny' };
    const e = ok(await acl(b), 201);
    n.events.length = 0;
    try {
      const again = await acl(b);
      assert.deepEqual([again.status, again.body.detail, errors(again).map(x => x.path)], [422, 'Diesen Eintrag gibt es schon.', ['/']]);
      assert.deepEqual(n.events, []);
      assert.equal(ok(await call('admin', 'GET', `/v1/acl?resourceId=${id.f1}`)).items.length, 1);
      await del(ok(await acl({ ...b, effect: 'restrict' }), 201));
      const tenantWide = { resourceType: 'tenant', principalType: 'role', principalRef: 'viewer', permission: 'note:read', effect: 'deny' };
      const t1 = ok(await acl(tenantWide), 201);
      assert.equal((await acl(tenantWide)).status, 422, 'auch ohne resourceId (NULL)');
      await del(t1);
      // Gleichzeitig (an der Prüfung vorbei): der eindeutige Index aus iam_012 verhindert die zweite Zeile
      await assert.rejects(withTenant(t.runtime, { tenantId: id.A! }, tx => tx.query(
        "INSERT INTO notes.acl_entry (tenant_id, resource_type, resource_id, principal_type, principal_ref, permission, effect) VALUES ($1, 'folder', $2, 'role', 'viewer', 'note:read', 'deny')", [id.A, id.f1])), /acl_entry_unique/);
    } finally { await del(e); }
  });

  test('acl:admin je Ressource: ein Verbot auf einem Ordner sperrt das Verwalten seiner Zugriffsregeln', async () => {
    const deny = ok(await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'client', principalRef: 'import', permission: 'acl:admin', effect: 'deny' }), 201);
    const onF1 = ok(await acl({ resourceType: 'note', resourceId: id.n1, principalType: 'role', principalRef: 'viewer', permission: 'note:write', effect: 'deny' }), 201);
    try {
      const body = (f: string) => ({ resourceType: 'folder', resourceId: f, principalType: 'role', principalRef: 'viewer', permission: 'note:read', effect: 'deny' });
      const blocked = await acl(body(id.f1!), 'clientAdmin');
      assert.deepEqual([blocked.status, blocked.body.detail], [403, `Dir fehlt das Recht «Zugriff verwalten» (acl:admin) für folder ${id.f1}.`]);
      assert.equal((await acl({ ...body(id.n1!), resourceType: 'note', effect: 'restrict' }, 'clientAdmin')).status, 403, 'auch darunter (Notiz im Ordner)');
      assert.equal((await call('clientAdmin', 'DELETE', `/v1/acl/${onF1.id}`)).status, 403, 'Löschen eines Eintrags auf der Notiz im Ordner');
      assert.equal((await call('admin', 'GET', `/v1/acl?resourceId=${id.n1}`)).body.items.length, 1, 'nicht gelöscht');
      const other = ok(await acl(body(id.f2!), 'clientAdmin'), 201);
      ok(await call('clientAdmin', 'DELETE', `/v1/acl/${other.id}`), 204);
      assert.equal((await acl(body(id.f1!), 'admin')).status, 201, 'Person mit org-admin ausgenommen');
      await del(...ok(await call('admin', 'GET', `/v1/acl?resourceId=${id.f1}&principalRef=viewer`)).items);
    } finally { await del(deny, onF1); }
  });

  test('Audit und Ereignis acl.changed in derselben Transaktion', async () => {
    n.events.length = 0;
    const e = ok(await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'role', principalRef: 'viewer', permission: 'note:read', effect: 'deny' }), 201);
    await del(e);
    const log = (await t.inspect.query("SELECT action, actor_name, source, resource_type, resource_id, data->>'aclId' AS acl FROM notes.audit_log WHERE data->>'aclId' = $1 ORDER BY seq", [e.id])).rows;
    assert.deepEqual(log.map(r => [r.action, r.source, r.resource_type, r.resource_id, r.acl]), [['acl.created', 'api', 'folder', id.f1, e.id], ['acl.deleted', 'api', 'folder', id.f1, e.id]]);
    assert.deepEqual(n.events.map(x => [x.type, x.subject, x.data.action]), [['acl.changed', id.f1, 'acl.created'], ['acl.changed', id.f1, 'acl.deleted']]);
  });

  test('E2/D1: wirksame Rechte – eigene, Simulation mit Rollen, Gruppen und Scopes', async () => {
    const deny = ok(await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'group', principalRef: '/it', permission: 'note:write' , effect: 'deny' }), 201);
    try {
      const own = ok(await call('auditor', 'GET', '/v1/acl/effective'));
      assert.deepEqual([own.simulated, own.source], [false, 'token']);
      assert.ok(own.permissions.includes('acl:read'));
      const roles = ok(await call('auditor', 'GET', '/v1/acl/effective?roles=editor'));
      assert.deepEqual([roles.simulated, roles.principal.name, roles.principal.kind, roles.roles, roles.source], [true, 'Simulation', 'user', ['editor'], 'simulation']);
      assert.ok(roles.permissions.includes('note:write') && !roles.permissions.includes('acl:read'), 'Rechte der simulierten Rolle, nicht die eigenen');
      const at = (r: { resources: { resourceId: string; permission: string; allowed: boolean }[] }) => r.resources.find(x => x.resourceId === id.f1 && x.permission === 'note:write')!.allowed;
      assert.equal(at(roles), true);
      const grouped = ok(await call('auditor', 'GET', '/v1/acl/effective?roles=editor&groups=/it'));
      assert.equal(at(grouped), false, 'Verbot für die Gruppe greift');
      assert.deepEqual(ok(await call('auditor', 'GET', '/v1/acl/effective?groups=/it')).permissions, [], 'ohne Rolle keine Rechte');
      const scoped = ok(await call('auditor', 'GET', '/v1/acl/effective?roles=editor&scopes=notes:read'));
      assert.ok(scoped.permissions.includes('note:read') && !scoped.permissions.includes('note:write'), 'Scopes begrenzen');
    } finally { await del(deny); }
  });

  test('Rechte prüfen: Client als Client (letztes Token, Simulation), Person ohne Rolle simuliert', async () => {
    const d = ok(await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'client', principalRef: 'import', permission: 'note:write', effect: 'deny' }), 201);
    try {
      const c = ok(await call('admin', 'GET', '/v1/acl/effective?client=import'));
      assert.deepEqual([c.principal.kind, c.source, c.roles, c.simulated], ['client', 'last-token', ['org-admin'], false]);
      assert.equal(c.resources.find((r: { resourceId: string }) => r.resourceId === id.f1).allowed, false, 'org-admin-Client: Verbot greift');
      const sim = ok(await call('admin', 'GET', '/v1/acl/effective?client=import&roles=org-admin&scopes=notes:read&simulate=true'));
      assert.deepEqual([sim.simulated, sim.principal.kind], [true, 'client']);
      assert.ok(!sim.permissions.includes('note:write'), 'Scopes begrenzen');
      const unknown = ok(await call('admin', 'GET', '/v1/acl/effective?client=nie-benutzt&roles=viewer&scopes=notes:read'));
      assert.deepEqual([unknown.principal.kind, unknown.source, unknown.principal.name], ['client', 'simulation', 'nie-benutzt']);
      const vera = ok(await call('vera', 'GET', '/v1/me')).principal.id;
      const none = ok(await call('admin', 'GET', `/v1/acl/effective?principal=${vera}&simulate=true`));
      assert.deepEqual([none.simulated, none.roles, none.permissions], [true, [], []], 'ohne Rolle simuliert, nicht die echten Rechte');
      const scoped = ok(await call('admin', 'GET', `/v1/acl/effective?principal=${vera}&roles=editor&scopes=notes:read`));
      assert.ok(scoped.permissions.includes('note:read') && !scoped.permissions.includes('note:write'), 'Scopes begrenzen auch eine simulierte Person');
    } finally { await del(d); }
  });

  test('Nr. 21: echte Rechte anderer Personen aus Keycloak (memberAccess), von Clients aus dem letzten Token', async () => {
    const g = ok(await acl({ resourceType: 'folder', resourceId: id.f1, principalType: 'group', principalRef: '/it-team', permission: 'note:write', effect: 'grant' }), 201);
    try {
      const vera = ok(await call('vera', 'GET', '/v1/me')).principal.id;
      assert.deepEqual(ok(await call('admin', 'GET', `/v1/acl/effective?principal=${vera}`)).source, 'simulation', 'ohne Angaben aus Keycloak: Simulation');
      member.set('acme:vera', { roles: ['viewer'], groups: ['/it-team'] });
      const real = ok(await call('admin', 'GET', `/v1/acl/effective?principal=${vera}`));
      assert.deepEqual([real.simulated, real.source, real.roles, real.groups, real.granted], [false, 'keycloak', ['viewer'], ['/it-team'], ['note:write']]);
      const sim = ok(await call('admin', 'GET', `/v1/acl/effective?principal=${vera}&roles=editor`));
      assert.deepEqual([sim.simulated, sim.source, sim.roles], [true, 'simulation', ['editor']]);
      member.set('acme:vera', 'fehler');
      assert.equal(ok(await call('admin', 'GET', `/v1/acl/effective?principal=${vera}`)).source, 'simulation', 'Keycloak nicht erreichbar: Simulation statt Fehler');

      const cid = ok(await call('client', 'GET', '/v1/me')).principal.id;
      const c = ok(await call('admin', 'GET', `/v1/acl/effective?principal=${cid}`));
      assert.deepEqual([c.simulated, c.source, c.roles, c.principal.clientId], [false, 'last-token', ['org-admin'], 'import']);
      assert.ok(c.permissions.includes('note:write') && !c.permissions.includes('acl:read'), 'durch die Scopes des Tokens begrenzt');
      // Entfernt oder Freigabe entzogen: keine «echten» Rechte mehr aus dem letzten Token
      await withTenant(t.runtime, { tenantId: id.A! }, tx => tx.query("DELETE FROM notes.client_grant WHERE client_id = 'import'"));
      try {
        assert.deepEqual([ok(await call('admin', 'GET', `/v1/acl/effective?principal=${cid}`)).source, ok(await call('admin', 'GET', '/v1/acl/effective?client=import')).source], ['simulation', 'simulation'], 'ohne Freigabe');
      } finally { await tenant(t.runtime, 'acme', 'import'); }
      await withTenant(t.runtime, { tenantId: id.A! }, tx => tx.query("UPDATE notes.principal SET removed_at = now() WHERE client_id = 'import'"));
      try {
        assert.deepEqual([ok(await call('admin', 'GET', `/v1/acl/effective?principal=${cid}`)).source, ok(await call('admin', 'GET', '/v1/acl/effective?client=import')).source], ['simulation', 'simulation'], 'entfernt');
      } finally { await withTenant(t.runtime, { tenantId: id.A! }, tx => tx.query("UPDATE notes.principal SET removed_at = NULL WHERE client_id = 'import'")); }
      assert.equal((await call('admin', 'GET', '/v1/acl/effective?principal=00000000-0000-4000-8000-000000000000')).status, 404);
      const gus = ok(await call('globex', 'GET', '/v1/me')).principal.id;
      assert.equal((await call('admin', 'GET', `/v1/acl/effective?principal=${gus}`)).status, 404, 'Principal von globex');
    } finally { await del(g); member.clear(); }
  });

  test('multi-org: Gruppen nur der gewählten Organisation; gespeicherte Einträge auf fremde Gruppen und Subjects wirken nur im eigenen Mandanten', async () => {
    const dora = await idp.token({ ...claims.user({ org: ['acme', 'globex'], sub: 'dora' }), groups: ['/orgs/acme/editor', '/orgs/globex/viewer', '/orgs/globex/it', '/it-alle'] });
    const as = (tenantAlias: string) => n.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${dora}`, 'x-tenant': tenantAlias } }).then(r => r.json());
    const pid = (await as('acme')).principal.id;
    const eff = ok(await call('admin', 'GET', `/v1/acl/effective?principal=${pid}`));
    assert.ok(!JSON.stringify(eff).includes('globex'), 'keine Gruppe und kein Alias von globex im Mandanten acme');
    // Alt gespeichert (vor der Prüfung): Verbot auf eine Gruppe von globex und auf das Subject im Mandanten acme
    await withTenant(t.runtime, { tenantId: id.A! }, async tx => {
      await tx.query("INSERT INTO notes.acl_entry (tenant_id, resource_type, principal_type, principal_ref, permission, effect) VALUES ($1, 'tenant', 'group', '/orgs/globex/it', 'note:write', 'deny')", [id.A]);
      await tx.query("INSERT INTO notes.acl_entry (tenant_id, resource_type, principal_type, principal_ref, permission, effect) VALUES ($1, 'tenant', 'user', 'dora', 'note:read', 'deny')", [id.A]);
    });
    const acme = await as('acme'), globex = await as('globex');
    assert.ok(acme.permissions.includes('note:write'), 'Verbot auf /orgs/globex/it wirkt in acme nicht');
    assert.ok(!acme.permissions.includes('note:read'), 'Verbot über das Subject wirkt in acme');
    assert.ok(globex.permissions.includes('note:read'), 'in globex unberührt');
    await withTenant(t.runtime, { tenantId: id.A! }, tx => tx.query("DELETE FROM notes.acl_entry WHERE principal_ref IN ('/orgs/globex/it', 'dora')"));
  });

  test('Zusatzfelder der App in /v1/acl/effective (effectiveExtra mit Schema)', async () => {
    const x = await notesApp({
      db: t.runtime, issuer: idp.issuer, catalog,
      resources: { ...notesResources, effectiveExtra: async target => ({ folders: target.roles.includes('editor') ? [id.f1] : [] }), effectiveExtraSchema: { folders: Type.Array(Type.String(), { description: 'Ordner' }) } },
    });
    try {
      const r = await x.app.inject({ method: 'GET', url: '/v1/acl/effective?roles=editor', headers: { authorization: `Bearer ${tok.admin}` } });
      assert.deepEqual(r.json().folders, [id.f1]);
      const doc = (await x.app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
      assert.equal(doc.paths['/v1/acl/effective'].get.responses['200'].content['application/json'].schema.properties.folders.description, 'Ordner');
    } finally { await x.app.close(); }
  });
});
