/**
 * Produktmodule je Organisation mit Datenbank (iam_022, modules.ts, Modul `modules`; Konzept «Module je Organisation»,
 * Abschnitte 3–5, 10, 11): erste Belegung in `migrate` und beim Laden, Routen der Organisation und der
 * Plattform-Administration, Regeln beim Aktivieren und Deaktivieren, Haken der App, Ereignisse, Audit in beiden
 * Protokollen, Wirkung auf Rechte (acl_version) und Mandantentrennung in PostgreSQL.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { withTenant } from '../src/db.ts';
import { iamMigrations } from '../src/migrations.ts';
import type { ModuleBlocker } from '../src/modules.ts';
import { skipDb } from './support/db.ts';
import { claims, grant, member, notesApp, notesDb, person, tenant, view, type NotesApp } from './support/http.ts';
import { modulesModel } from './support/models.ts';

const skip = await skipDb();
type Res = { status: number; body: any; etag?: string };

describe('Produktmodule je Organisation', { skip }, () => {
  const db = notesDb(modulesModel);
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp, plain: NotesApp;
  const tok: Record<string, string> = {};
  let demoId: string, otherId: string, viewId: string, oldId: string;
  // Haken der App: Hindernisse schaltbar, Aufrufe von einrichten und nachholen gezählt
  let teamBlockers: ModuleBlocker[] = [];
  const calls: string[] = [];
  const moduleHooks = {
    teams: { hindernisse: async () => teamBlockers },
    ansichten: {
      einrichten: async (tx: pg.ClientBase, tenantId: string) => { calls.push(`einrichten:${tenantId === demoId ? 'demo' : tenantId}:${(await tx.query('SELECT app.tenant_id()::text AS t')).rows[0].t === tenantId}`); },
      nachholen: async (_tx: pg.ClientBase, tenantId: string, seit: Date) => { calls.push(`nachholen:${tenantId === demoId ? 'demo' : tenantId}:${seit instanceof Date}`); },
    },
  };

  async function call(who: string, method: string, url: string, body?: unknown, o: { app?: NotesApp; headers?: Record<string, string> } = {}): Promise<Res> {
    const r = await (o.app ?? n).app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tok[who]}`, ...o.headers }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, etag: r.headers.etag as string | undefined };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const me = async (who: string) => ok(await call(who, 'GET', '/v1/me'));
  const list = async (who = 'anna') => { const r = await call(who, 'GET', '/v1/tenant/modules'); ok(r); return { items: r.body.items as any[], etag: r.etag! }; };
  const setActive = (key: string, active: boolean, who = 'anna', headers?: Record<string, string>) => call(who, 'PUT', `/v1/tenant/modules/${key}`, { active }, { headers });
  const setAllowed = (alias: string, key: string, allowed: boolean, query = '') => call('paula', 'PUT', `/v1/platform/organizations/${alias}/modules/${key}${query}`, { allowed });
  const rows = async (tenantId: string) => (await t.inspect.query<{ module: string; allowed: boolean; active: boolean }>('SELECT module, allowed, active FROM notes.tenant_module WHERE tenant_id = $1 ORDER BY module', [tenantId])).rows;
  const audits = async (tenantId: string, action: string) => (await t.inspect.query<{ data: any }>('SELECT data FROM notes.audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY seq', [tenantId, action])).rows.map(r => r.data);

  before(async () => {
    t = await db.create();
    // Bestehende Organisation vor dem Einführen der Module: Zeilen fehlen (wie nach dem Anheben auf 6.1)
    oldId = await tenant(t.runtime, 'alt');
    await t.inspect.query('DELETE FROM notes.tenant_module WHERE tenant_id = $1', [oldId]);
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    for (const [sub, role] of [['anna', 'org-admin'], ['dana', 'viewer'], ['edgar', 'editor']] as const) await member(t.runtime, 'demo', sub, role);
    await member(t.runtime, 'other', 'otto', 'org-admin');
    await member(t.runtime, 'ops', 'paula', 'org-admin');
    demoId = await tenant(t.runtime, 'demo'); otherId = await tenant(t.runtime, 'other');
    viewId = await view(t.runtime, demoId, 'Meine Ansicht');
    const edgar = await person(t.runtime, demoId, 'edgar');
    await grant(t.runtime, demoId, `user:${edgar}`, 'owner', { type: 'view', id: viewId });
    n = await notesApp({ db: t.runtime, issuer: idp.issuer, model: modulesModel, moduleHooks });
    plain = await notesApp({ db: t.runtime, issuer: idp.issuer });
    for (const sub of ['anna', 'dana', 'edgar']) tok[sub] = await idp.token(claims.user({ sub, org: 'demo' }));
    tok.otto = await idp.token(claims.user({ sub: 'otto', org: 'other' }));
    tok.paula = await idp.token({ ...claims.user({ sub: 'paula', org: 'ops' }), realm_access: { roles: ['platform-admin'] } });
  });
  after(async () => { await n?.app.close(); await plain?.app.close(); await idp?.close(); await t?.drop(); });

  test('migrate: bestehende Organisationen ohne Zeilen erhalten alle Module erlaubt und aktiv (protokolliert); zweiter Lauf ändert nichts', async () => {
    assert.deepEqual(await rows(oldId), []);
    const c = t.admin;
    {
      const sync = iamMigrations({ product: 'notes', model: modulesModel }).sync!;
      await c.query('BEGIN');
      const log = await sync(c);
      await c.query('COMMIT');
      assert.ok(log.some(l => /Produktmodule: alle Module erlaubt und aktiv für \d+ Organisation\(en\) \(.*alt.*\)/.test(l)), log.join('\n'));
      await c.query('BEGIN');
      assert.ok(!(await sync(c)).some(l => /Produktmodule/.test(l)), 'zweiter Lauf: nichts');
      await c.query('COMMIT');
    }
    assert.deepEqual(await rows(oldId), ['ansichten', 'kern', 'notizen', 'teams'].map(module => ({ module, allowed: true, active: true })));
    assert.deepEqual(calls, [], 'bestehende Organisationen: ohne Haken (Daten bestehen schon)');
    assert.equal((await audits(oldId, 'tenant.module_backfill')).length, 1);
  });

  test('Sicherheitsnetz beim Laden: neue Organisation ohne Zeilen hat alle Module; /v1/me und /v1/authz/catalog nennen sie', async () => {
    await t.inspect.query('DELETE FROM notes.tenant_module WHERE tenant_id = $1', [demoId]);
    const backfills = (await audits(demoId, 'tenant.module_backfill')).length;
    calls.length = 0;
    const m = await me('anna');
    assert.deepEqual(calls, ['einrichten:demo:true'], 'neue Organisation: einrichten wie beim ersten Aktivieren');
    assert.deepEqual(m.modules, ['kern', 'notizen', 'notizen.teilen', 'ansichten', 'teams']);
    assert.ok(m.permissions.includes('view:read') && m.permissions.includes('tenant:admin'));
    assert.equal((await rows(demoId)).length, 4);
    assert.equal((await audits(demoId, 'tenant.module_backfill')).length, backfills + 1);
    const cat = ok(await call('dana', 'GET', '/v1/authz/catalog'));
    assert.deepEqual(cat.modules.map((x: any) => x.key), ['kern', 'notizen', 'ansichten', 'teams']);
    assert.equal(cat.permissions.find((p: any) => p.key === 'view:read').modul, 'ansichten');
  });

  test('ohne modules im Modell: /v1/me nennt nur den Kern, keine Routen /v1/tenant/modules, keine Zeilen', async () => {
    const m = await me('anna').then(() => call('anna', 'GET', '/v1/me', undefined, { app: plain }));
    assert.deepEqual(ok(m).modules, ['kern']);
    assert.equal((await call('anna', 'GET', '/v1/tenant/modules', undefined, { app: plain })).status, 404);
    assert.deepEqual(ok(await call('anna', 'GET', '/v1/authz/catalog', undefined, { app: plain })).modules.map((x: any) => x.key), ['kern']);
  });

  test('GET /v1/tenant/modules: mit tenant:read ohne Hindernisse, mit tenant:admin mit; ETag = acl_version', async () => {
    teamBlockers = [{ key: 'offen', text: '2 offene Einträge', anzahl: 2 }];
    const dana = await list('dana');
    assert.deepEqual(dana.items.map(x => [x.key, x.module, x.core, x.allowed, x.active]), [
      ['kern', null, true, true, true], ['notizen', null, false, true, true], ['notizen.teilen', 'notizen', false, true, true], ['ansichten', null, false, true, true], ['teams', null, false, true, true],
    ]);
    assert.ok(dana.items.every(x => x.blockers === undefined));
    const anna = await list('anna');
    assert.deepEqual(anna.items.find(x => x.key === 'teams').blockers, teamBlockers);
    assert.deepEqual(anna.items.find(x => x.key === 'ansichten').blockers, []);
    assert.equal(anna.items.find(x => x.key === 'kern').blockers, undefined);
    const v = (await t.inspect.query<{ v: string }>('SELECT acl_version::text AS v FROM notes.tenant WHERE id = $1', [demoId])).rows[0]!.v;
    assert.equal(anna.etag, `W/"${v}"`);
    teamBlockers = [];
  });

  test('PUT: nur mit tenant:admin; Kern 409; unbekannt 404; If-Match veraltet 412', async () => {
    assert.equal((await setActive('teams', false, 'dana')).status, 403);
    const kern = await setActive('kern', false);
    assert.equal(kern.status, 409); assert.equal(kern.body.reason, 'kern');
    assert.equal((await setActive('lohn', true)).status, 404);
    assert.equal((await setActive('Teams', true)).status, 422, 'Schlüssel ungültig');
    assert.equal((await setActive('teams', false, 'anna', { 'if-match': 'W/"1"' })).status, 412);
    assert.equal((await call('anna', 'GET', '/v1/tenant/modules', undefined, { app: n })).status, 200);
  });

  test('Deaktivieren: Rechte fehlen sofort überall (Person, Scope, owner, Katalog, «Warum?»), Tupel bleiben; Aktivieren gibt sie sofort zurück', async () => {
    const tuplesBefore = (await t.inspect.query('SELECT count(*)::int AS n FROM notes.authz_tuple WHERE tenant_id = $1', [demoId])).rows[0].n;
    const { etag } = await list();
    const r = ok(await setActive('ansichten', false, 'anna', { 'if-match': etag }));
    assert.deepEqual([r.key, r.active, r.allowed], ['ansichten', false, true]);
    const anna = await me('anna');
    assert.ok(!anna.permissions.includes('view:read') && !anna.somewhere.includes('view:read'), 'auch org-admin nicht');
    assert.ok(!anna.modules.includes('ansichten'));
    assert.ok(!(await me('edgar')).somewhere.includes('view:write'), 'owner einer Ansicht hat kein Recht mehr');
    const cat = ok(await call('dana', 'GET', '/v1/authz/catalog'));
    assert.ok(!cat.permissions.some((p: any) => p.key.startsWith('view:')));
    assert.ok(!cat.roles.find((x: any) => x.key === 'editor').permissions.includes('view:read'));
    const why = ok(await call('anna', 'GET', `/v1/access/explain?type=org&permission=view:read`));
    assert.deepEqual([why.allowed, why.reasons], [false, []]);
    assert.equal((await t.inspect.query('SELECT count(*)::int AS n FROM notes.authz_tuple WHERE tenant_id = $1', [demoId])).rows[0].n, tuplesBefore, 'Tupel bleiben');
    // Andere Organisation unverändert
    assert.ok((await me('otto')).modules.includes('ansichten'));
    ok(await setActive('ansichten', true));
    assert.ok((await me('anna')).permissions.includes('view:read'), 'nach erneutem Aktivieren sofort (acl_version)');
    assert.ok((await me('edgar')).somewhere.includes('view:write'));
  });

  test('Schaltungen nacheinander: auch ohne If-Match wartet ein PUT auf die Sperre des Mandanten', async () => {
    const c = await (t.runtime as pg.Pool).connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [demoId]);
      await c.query('SELECT 1 FROM notes.tenant WHERE id = $1 FOR UPDATE', [demoId]);
      let done = false;
      const put = setActive('teams', false).then(r => { done = true; return r; });
      await new Promise(r => setTimeout(r, 300));
      assert.equal(done, false, 'wartet auf die Sperre');
      await c.query('COMMIT');
      ok(await put);
    } finally { c.release(); }
    ok(await setActive('teams', true));
  });

  test('Regeln: abhängiges Modul aktiv 409, Voraussetzung fehlt 409, Teilfunktion ohne Modul 409, Hindernisse 409', async () => {
    const dep = await setActive('notizen', false);
    assert.equal(dep.status, 409); assert.deepEqual([dep.body.reason, dep.body.module], ['abhaengig-aktiv', ['ansichten']]);
    ok(await setActive('ansichten', false));
    ok(await setActive('notizen', false));
    assert.ok(!(await me('anna')).modules.includes('notizen.teilen'), 'Teilfunktion mit ihrem Modul aus');
    const req = await setActive('ansichten', true);
    assert.equal(req.status, 409); assert.deepEqual([req.body.reason, req.body.fehlt], ['voraussetzung-fehlt', ['notizen']]);
    const part = await setActive('notizen.teilen', false).then(() => setActive('notizen.teilen', true));
    assert.equal(part.status, 409); assert.equal(part.body.reason, 'modul-inaktiv');
    ok(await setActive('notizen', true));
    ok(await setActive('notizen.teilen', true));
    ok(await setActive('ansichten', true));
    teamBlockers = [{ key: 'offen', text: '1 offener Eintrag', anzahl: 1 }];
    const blocked = await setActive('teams', false);
    assert.equal(blocked.status, 409); assert.deepEqual([blocked.body.reason, blocked.body.hindernisse], ['hindernisse', teamBlockers]);
    teamBlockers = [];
    // Teilfunktion einzeln aus: nur ihr Recht fehlt
    ok(await setActive('notizen.teilen', false));
    const anna = await me('anna');
    assert.ok(!anna.permissions.includes('note:share') && anna.permissions.includes('note:read'));
    ok(await setActive('notizen.teilen', true));
  });

  test('Plattform: freigeben und entziehen; nicht erlaubt 403; Entziehen deaktiviert mit; Hindernisse mit force; Kern 409', async () => {
    assert.equal((await call('anna', 'GET', '/v1/platform/organizations/demo/modules')).status, 403, 'nur Plattform-Administration');
    const pl = ok(await call('paula', 'GET', '/v1/platform/organizations/demo/modules'));
    assert.ok(pl.items.find((x: any) => x.key === 'teams').blockers);
    assert.equal((await call('paula', 'GET', '/v1/platform/organizations/nirgends/modules')).status, 404);
    assert.equal((await setAllowed('demo', 'kern', false)).body.reason, 'kern');
    teamBlockers = [{ key: 'offen', text: '1 offener Eintrag' }];
    assert.equal((await setAllowed('demo', 'teams', false)).body.reason, 'hindernisse');
    const r = ok(await setAllowed('demo', 'teams', false, '?force=true'));
    teamBlockers = [];
    assert.deepEqual([r.allowed, r.active], [false, false]);
    assert.ok(!(await me('dana')).permissions.includes('team:read'));
    const no = await setActive('teams', true);
    assert.equal(no.status, 403); assert.equal(no.body.reason, 'modul-nicht-erlaubt');
    ok(await setAllowed('demo', 'teams', true));
    assert.ok(!(await me('dana')).permissions.includes('team:read'), 'Freigeben aktiviert nicht');
    ok(await setActive('teams', true));
    assert.ok((await me('dana')).permissions.includes('team:read'));
    const dep = await setAllowed('demo', 'notizen', false, '?force=true');
    assert.equal(dep.status, 409); assert.equal(dep.body.reason, 'abhaengig-aktiv');
    // Audit: Organisation (beide Einträge) und Plattform (Freigeben mit platformAdmin)
    const allowed = await audits(demoId, 'tenant.module_allowed');
    assert.ok(allowed.some(d => d.module === 'teams' && d.before === true && d.after === false && d.platformAdmin === true && d.force === true));
    const plat = (await t.inspect.query<{ action: string; data: any }>("SELECT action, data FROM notes.platform_audit_log WHERE org_id = $1 AND action LIKE 'tenant.module_%' ORDER BY seq", [demoId])).rows;
    assert.ok(plat.some(x => x.action === 'tenant.module_allowed' && x.data.module === 'teams'));
    assert.ok(plat.some(x => x.action === 'tenant.module_active' && x.data.module === 'teams' && x.data.after === false), 'Entziehen deaktiviert mit, auch im Protokoll der Plattform');
  });

  test('Haken: einrichten genau einmal beim ersten Aktivieren, nachholen beim erneuten (mit seit); Ereignisse und Audit', async () => {
    // Ansichten nie gehabt: Zeile fehlt, Betrieb gibt frei
    await t.inspect.query("DELETE FROM notes.tenant_module WHERE tenant_id = $1 AND module = 'ansichten'", [otherId]);
    n.iam.access.invalidate(otherId);
    assert.ok(!(await me('otto')).modules.includes('ansichten'), 'ohne Zeile nicht aktiv');
    ok(await setAllowed('other', 'ansichten', true));
    calls.length = 0; n.events.length = 0;
    ok(await setActive('ansichten', true, 'otto'));
    assert.deepEqual(calls, [`einrichten:${otherId}:true`], 'in der Transaktion im Kontext der Organisation');
    ok(await setActive('ansichten', false, 'otto'));
    ok(await setActive('ansichten', true, 'otto'));
    assert.deepEqual(calls, [`einrichten:${otherId}:true`, `nachholen:${otherId}:true`], 'einrichten nicht noch einmal');
    const ev = n.events.filter(e => e.type.startsWith('module.'));
    const otto = (await t.inspect.query<{ id: string }>("SELECT id FROM notes.principal WHERE subject = 'otto' AND tenant_id = $1", [otherId])).rows[0]!.id;
    assert.deepEqual(ev.map(e => [e.type, (e.data as any).module, (e.data as any).by, e.tenantId]), [
      ['module.activated', 'ansichten', otto, otherId], ['module.deactivated', 'ansichten', otto, otherId], ['module.activated', 'ansichten', otto, otherId],
    ]);
    const act = await audits(otherId, 'tenant.module_active');
    assert.deepEqual(act.slice(-3).map(d => [d.module, d.before, d.after]), [['ansichten', false, true], ['ansichten', true, false], ['ansichten', false, true]]);
    const row = (await t.inspect.query<{ changed_by: string; active_since: Date; inactive_since: Date }>("SELECT changed_by, active_since, inactive_since FROM notes.tenant_module WHERE tenant_id = $1 AND module = 'ansichten'", [otherId])).rows[0]!;
    assert.equal(row.changed_by, otto);
    assert.ok(row.active_since > row.inactive_since);
  });

  test('Mandantentrennung in PostgreSQL: B sieht und ändert nichts von A; Laufzeit schreibt nur über die Funktionen', async () => {
    await withTenant(t.runtime, { tenantId: otherId }, async tx => {
      const seen = (await tx.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM notes.tenant_module')).rows.map(r => r.tenant_id);
      assert.deepEqual(seen, [otherId]);
      await tx.query('SAVEPOINT s');
      await assert.rejects(tx.query("UPDATE notes.tenant_module SET active = false WHERE tenant_id = $1", [demoId]), /permission denied/);
      await tx.query('ROLLBACK TO SAVEPOINT s');
      await assert.rejects(tx.query("INSERT INTO notes.tenant_module (tenant_id, module, allowed, active) VALUES ($1, 'teams', true, true)", [otherId]), /permission denied/);
    });
    // set_module_active schaltet immer nur im eigenen Kontext
    await withTenant(t.runtime, { tenantId: otherId }, tx => tx.query("SELECT * FROM app.set_module_active('teams', false)"));
    assert.ok((await rows(demoId)).find(r => r.module === 'teams')!.active, 'A unverändert');
    assert.equal((await rows(otherId)).find(r => r.module === 'teams')!.active, false);
    await withTenant(t.runtime, { tenantId: otherId }, tx => tx.query("SELECT * FROM app.set_module_active('teams', true)"));
    // Nicht erlaubt: auch die Funktion lehnt ab
    await withTenant(t.runtime, { tenantId: otherId }, async tx => {
      await assert.rejects(tx.query("SELECT * FROM app.set_module_active('lohn', true)"), /nicht freigegeben/);
    });
    await assert.rejects(t.runtime.query("SELECT * FROM app.set_module_active('teams', true)"), /Kein Mandant/);
    // Mit set_module_allowed für B bleibt der Kontext des Aufrufers erhalten
    await withTenant(t.runtime, { tenantId: demoId }, async tx => {
      await tx.query("SELECT * FROM app.set_module_allowed($1, 'lohn', false)", [otherId]);
      assert.equal((await tx.query('SELECT app.tenant_id()::text AS t')).rows[0].t, demoId);
    });
    assert.ok((await rows(otherId)).some(r => r.module === 'lohn'));
    assert.ok(!(await rows(demoId)).some(r => r.module === 'lohn'));
  });
});
