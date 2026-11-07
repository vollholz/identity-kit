/**
 * Produktmodule in der Plattform (Konzept «Module je Organisation», Abschnitte 6, 7 und 11): Prüfung der Module gegen
 * das Verzeichnis, OpenAPI `x-modul`, HTTP 403 `modul-inaktiv` (auch je Teilfunktion, öffentliche Route über den Alias),
 * Haken der App (einrichten, hindernisse, nachholen als Auftrag), Worker (Jobs `skipped`, `ctx.tenants`, Outbox),
 * Pakete und Befehle, bestehende Organisationen unverändert.
 * Test-App: Module `kern`, `notizen` (Teilfunktion `abo`) und `berichte` (braucht `notizen`), test/fixture/model.ts.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { defineModel } from '@vollholz/iam';
import { buildToolServer, checkModules, defineModule, NACHHOLEN_JOB, outboxTask, runCli, tenantModules, type TenantDbs, type Worker } from '../src/index.ts';
import { app } from './fixture/app.ts';
import { BERICHT_JOB, berichtModule, seen } from './fixture/bericht/index.ts';
import { notizModule } from './fixture/notiz/index.ts';
import { enqueue, platform } from './fixture/platform.ts';
import { full, skipDb, tenant } from './harness.ts';
import { login, testApi, type TestApi } from './api.ts';

const skip = await skipDb();
const quiet = { info() {}, warn() {}, error() {} };
const model = platform.model;

describe('Module: Prüfung und Doku (ohne Datenbank)', () => {
  test('checkModules: modul Pflicht mit modules, nur bekannte Schlüssel, Warnung für ungenutzte Module', () => {
    assert.throws(() => checkModules([defineModule({ name: 'x' })], model), /Modul «x»: modul fehlt/);
    assert.throws(() => checkModules([defineModule({ name: 'x', modul: 'gibtsnicht' })], model), /modul «gibtsnicht» nicht im Modell/);
    assert.throws(() => checkModules([defineModule({ name: 'x', modul: 'notizen', jobs: [{ kind: 'x.y', modul: 'notizen.nix', run: async () => {} }] })], model), /Job-Art «x.y»: modul «notizen.nix»/);
    assert.deepEqual(checkModules([notizModule, berichtModule], model), []);
    // Ohne modules im Modell: kein modul erlaubt
    const plain = { features: { modules: false }, modules: [{ key: 'kern', label: 'Kern', description: '', core: true, requires: [], parts: [] }], coreModule: 'kern', permissions: [], moduleOf: () => 'kern' } as never;
    assert.deepEqual(checkModules([defineModule({ name: 'x' })], plain), []);
    assert.throws(() => checkModules([defineModule({ name: 'x', modul: 'kern' })], plain), /ohne modules im Modell/);
    // Modul ohne Code, Job oder Recht: Warnung
    const extra = { ...model, modules: [...model.modules, { key: 'leer', label: 'Leer', description: '', core: false, requires: ['kern'], parts: [] }], features: model.features, permissions: model.permissions, moduleOf: model.moduleOf, coreModule: model.coreModule };
    assert.deepEqual(checkModules([notizModule, berichtModule], extra as never), ['Produktmodul «leer»: kein Code-Modul, Job, Aufgabe, Abnehmer, Werkzeug oder Recht gehört dazu']);
  });

  test('defineModule trägt das Modul in Jobs, Aufgaben, Abnehmer, Werkzeuge und öffentliche Routen ein (eigenes bleibt)', () => {
    assert.equal(berichtModule.jobs![0]!.modul, 'berichte');
    assert.equal(berichtModule.tasks![0]!.modul, 'berichte');
    assert.equal(berichtModule.consumers![0]!.modul, 'berichte');
    assert.equal(berichtModule.mcpTools!.get_bericht!.modul, 'berichte');
    assert.equal(notizModule.publicRoutes![0]!.modul, 'notizen.abo');
    assert.equal(notizModule.jobs![0]!.modul, 'notizen');
    assert.equal(app.tools.list_notizen!.modul, 'notizen');
  });

  test('OpenAPI: x-modul je Route (Code-Modul oder config.modul), Tag nennt das Produktmodul, IAM-Routen ohne', async () => {
    const doc = await app.openApi() as { tags: { name: string; description: string }[]; paths: Record<string, Record<string, Record<string, unknown>>> };
    assert.equal(doc.paths['/v1/berichte']!.get!['x-modul'], 'berichte');
    assert.equal(doc.paths['/v1/notizen']!.get!['x-modul'], 'notizen');
    assert.equal(doc.paths['/v1/notizen/abo']!.post!['x-modul'], 'notizen.abo');
    assert.equal(doc.paths['/abo/notizen/{datei}']!.get!['x-modul'], 'notizen.abo');
    assert.equal(doc.paths['/v1/tenant/modules']!.get!['x-modul'], undefined);
    assert.match(doc.tags.find(t => t.name === 'Berichte')!.description, /Produktmodul «Berichte» \(`berichte`\)/);
  });

  test('MCP: Werkzeug nur für Organisationen, in denen sein Modul aktiv ist (auch bei vorhandenem Recht)', () => {
    const org = (modules: string[]) => ({ api: {} as never, me: { tenant: { id: 't', alias: 'a' }, permissions: ['notiz:read', 'bericht:read'], modules } });
    const offered = (modules: string[]) => {
      const server = buildToolServer({ platform: platform.context, model, tools: app.tools }, { token: { claims: {} } as never, scopes: [], orgs: [org(modules)] }, quiet as never);
      return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
    };
    assert.deepEqual(offered(['kern', 'notizen', 'notizen.abo', 'berichte']), ['get_bericht', 'get_notiz', 'list_notizen']);
    assert.deepEqual(offered(['kern', 'notizen']), ['get_notiz', 'list_notizen']);
  });

  test('Unbekanntes Paket: Exit 64 vor jeder Verbindung', async () => {
    const exit = process.exit, error = console.error;
    const codes: number[] = [];
    process.exit = ((c: number) => { codes.push(c); throw new Error(`exit ${c}`); }) as never;
    console.error = () => {};
    try {
      await assert.rejects(runCli(app, ['tenant', 'create', 'neu', '--paket', 'gibtsnicht'], {}), /exit 64/);
      await assert.rejects(runCli(app, ['tenant', 'modules', 'neu', '--paket', 'gibtsnicht'], {}), /exit 64/);
      await assert.rejects(runCli(app, ['tenant', 'suspend', 'neu', '--paket', 'basis'], {}), /exit 64/);
    } finally { process.exit = exit; console.error = error; }
    assert.deepEqual(codes, [64, 64, 64]);
  });
});

describe('Module je Organisation', { skip }, () => {
  let api: TestApi;
  let d: TenantDbs & { admin: pg.Pool };
  let worker: Worker;

  before(async () => {
    api = await testApi();
    d = { admin: new pg.Pool({ connectionString: api.t.adminUrl, max: 2 }), runtime: api.t.runtime };
    const cfg = app.loadConfig({ NODE_ENV: 'test', OIDC_ISSUER_URL: 'http://idp.test/realms/x', DATABASE_URL: 'postgres://x@localhost/x', LOG_LEVEL: 'silent' }, null);
    worker = app.createWorker(cfg, api.t.worker, quiet);
  });
  after(async () => { await d?.admin.end(); await api?.close(); });

  const drain = async () => { for (let c = await worker.claim(); c; c = await worker.claim()) await worker.execute(c); };
  const put = (h: { authorization: string }, key: string, active: boolean) =>
    api.app.inject({ method: 'PUT', url: `/v1/tenant/modules/${key}`, headers: h, payload: { active } });
  const states = async (alias: string) => Object.fromEntries((await app.tenants.modules(d, alias)).modules.map(s => [s.key, [s.allowed, s.active]]));
  const audits = (tid: string, action: string) => full(api.t.runtime, tid, async tx =>
    (await tx.query<{ data: Record<string, unknown> }>('SELECT data FROM probe.audit_log WHERE action = $1 ORDER BY seq', [action])).rows.map(r => r.data));

  test('bestehende bzw. ohne Paket angelegte Organisation: alle Module erlaubt und aktiv, einrichten je Modul einmal', async () => {
    const admin = await login(api, 'm-alt', 'alt-admin', 'org-admin');
    assert.equal((await api.app.inject({ method: 'GET', url: '/v1/berichte', headers: admin })).statusCode, 200);
    assert.deepEqual(await states('m-alt'), { kern: [true, true], notizen: [true, true], 'notizen.abo': [true, true], berichte: [true, true] });
    assert.equal((await audits(admin.tenantId, 'bericht.eingerichtet')).length, 1);
  });

  test('HTTP: inaktives Modul 403 modul-inaktiv vor Rechten; nach erneutem Aktivieren sofort wieder', async () => {
    const admin = await login(api, 'm-http', 'http-admin', 'org-admin');
    const editor = await login(api, 'm-http', 'http-editor', 'editor');
    assert.equal((await api.app.inject({ method: 'GET', url: '/v1/berichte', headers: editor })).statusCode, 200);
    assert.equal((await put(admin, 'berichte', false)).statusCode, 200);
    const r = await api.app.inject({ method: 'GET', url: '/v1/berichte', headers: editor });
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.headers['content-type'], 'application/problem+json; charset=utf-8');
    assert.equal(r.json().reason, 'modul-inaktiv');
    assert.equal(r.json().modul, 'berichte');
    assert.equal(r.json().detail, 'Das Modul ‹Berichte› ist in deiner Organisation nicht aktiv.');
    // Andere Module unberührt; Rechte des inaktiven Moduls fehlen auch in /v1/me
    assert.equal((await api.app.inject({ method: 'GET', url: '/v1/notizen', headers: editor })).statusCode, 200);
    const me = (await api.app.inject({ method: 'GET', url: '/v1/me', headers: editor })).json();
    assert.ok(!me.permissions.includes('bericht:read') && !me.modules.includes('berichte'));
    assert.equal((await put(admin, 'berichte', true)).statusCode, 200);
    assert.equal((await api.app.inject({ method: 'GET', url: '/v1/berichte', headers: editor })).statusCode, 200);
  });

  test('Teilfunktion je Route und öffentliche Route über den Alias', async () => {
    const admin = await login(api, 'm-abo', 'abo-admin', 'org-admin');
    const editor = await login(api, 'm-abo', 'abo-editor', 'editor');
    const issued = await api.app.inject({ method: 'POST', url: '/v1/notizen/abo', headers: editor });
    assert.equal(issued.statusCode, 200, issued.body);
    const link = `/abo/notizen/m-abo.${issued.json().token}.txt`;
    assert.equal((await api.app.inject({ method: 'GET', url: link })).statusCode, 200);
    assert.equal((await put(admin, 'notizen.abo', false)).statusCode, 200);
    const r = await api.app.inject({ method: 'POST', url: '/v1/notizen/abo', headers: editor });
    assert.equal(r.statusCode, 403);
    assert.deepEqual([r.json().reason, r.json().modul, r.json().detail], ['modul-inaktiv', 'notizen.abo', 'Die Funktion ‹Abo› ist in deiner Organisation nicht aktiv.']);
    // Öffentliche Route: wie ein unbekannter Link (kein Hinweis auf die Organisation ohne gültiges Token)
    const pub = await api.app.inject({ method: 'GET', url: link });
    assert.equal(pub.statusCode, 404);
    assert.equal(pub.json().detail, 'Der Link ist ungültig oder nicht mehr aktiv.');
    assert.equal((await api.app.inject({ method: 'GET', url: '/v1/notizen', headers: editor })).statusCode, 200);
    assert.equal((await put(admin, 'notizen.abo', true)).statusCode, 200);
    assert.equal((await api.app.inject({ method: 'GET', url: link })).statusCode, 200);
  });

  test('Aktivieren und Deaktivieren: Kern, Abhängigkeit, Hindernisse, nicht erlaubt; nachholen als Auftrag mit seit', async () => {
    const admin = await login(api, 'm-life', 'life-admin', 'org-admin');
    assert.equal((await put(admin, 'kern', false)).json().reason, 'kern');
    const dep = await put(admin, 'notizen', false);
    assert.equal(dep.statusCode, 409);
    assert.deepEqual([dep.json().reason, dep.json().module], ['abhaengig-aktiv', ['berichte']]);
    seen.blockers = [{ key: 'offen', text: '2 offene Berichte', anzahl: 2 }];
    try {
      const blocked = await put(admin, 'berichte', false);
      assert.equal(blocked.statusCode, 409);
      assert.deepEqual(blocked.json().hindernisse, seen.blockers);
      // Liste mit tenant:admin zeigt die Hindernisse
      const list = (await api.app.inject({ method: 'GET', url: '/v1/tenant/modules', headers: admin })).json().items as { key: string; blockers?: unknown[] }[];
      assert.deepEqual(list.find(x => x.key === 'berichte')!.blockers, seen.blockers);
    } finally { seen.blockers = []; }

    assert.equal((await put(admin, 'berichte', false)).statusCode, 200);
    const inactiveSince = await full(api.t.runtime, admin.tenantId, async tx => (await tx.query<{ t: Date }>("SELECT inactive_since AS t FROM probe.tenant_module WHERE module = 'berichte'")).rows[0]!.t);
    assert.equal((await put(admin, 'berichte', true)).statusCode, 200);
    // einrichten nur beim ersten Aktivieren (Belegung), danach nachholen – im Worker, nicht in der Anfrage
    assert.equal((await audits(admin.tenantId, 'bericht.eingerichtet')).length, 1);
    assert.equal((await audits(admin.tenantId, 'bericht.nachgeholt')).length, 0);
    const jobs = await full(api.t.runtime, admin.tenantId, async tx => (await tx.query<{ payload: { modul: string; seit: string } }>('SELECT payload FROM probe.job WHERE kind = $1', [NACHHOLEN_JOB])).rows);
    assert.deepEqual(jobs.map(j => j.payload), [{ modul: 'berichte', seit: inactiveSince.toISOString() }]);
    await drain();
    assert.deepEqual(await audits(admin.tenantId, 'bericht.nachgeholt'), [{ seit: inactiveSince.toISOString() }]);

    // Entzogen (Betrieb): Aktivieren 403 modul-nicht-erlaubt, die Route 403 modul-inaktiv
    await app.tenants.modules(d, 'm-life', { entziehen: ['berichte'] });
    const denied = await put(admin, 'berichte', true);
    assert.deepEqual([denied.statusCode, denied.json().reason], [403, 'modul-nicht-erlaubt']);
    assert.equal((await api.app.inject({ method: 'GET', url: '/v1/berichte', headers: admin })).json().reason, 'modul-inaktiv');
  });

  test('Worker: Job eines inaktiven Moduls skipped ohne Fehler; Aufgabe nur aktive Organisationen; Outbox überspringt', async () => {
    const A = await tenant(api.t.runtime, 'w-an');
    const B = await tenant(api.t.runtime, 'w-aus');
    await app.tenants.modules(d, 'w-an');
    await app.tenants.modules(d, 'w-aus', { entziehen: ['berichte'] });
    const ja = (await full(api.t.runtime, A, tx => enqueue(tx, BERICHT_JOB, { n: 1 })))!;
    const jb = (await full(api.t.runtime, B, tx => enqueue(tx, BERICHT_JOB, { n: 2 })))!;
    await drain();
    const job = (tid: string, id: string) => full(api.t.runtime, tid, async tx => (await tx.query('SELECT status, attempts, last_error, result FROM probe.job WHERE id = $1', [id])).rows[0]);
    assert.deepEqual(await job(A, ja), { status: 'done', attempts: 1, last_error: null, result: null });
    assert.deepEqual(await job(B, jb), { status: 'skipped', attempts: 1, last_error: null, result: { modul: 'inaktiv' } });
    assert.equal((await audits(A, 'bericht.erstellt')).length, 1);
    assert.equal((await audits(B, 'bericht.erstellt')).length, 0);

    // Aufgabe mit Modul: nur Organisationen, in denen es aktiv ist (ohne Modul alle)
    assert.ok(await worker.runTask(berichtModule.tasks![0]!));
    const aliases = seen.tenants.map(t => t.alias);
    assert.ok(aliases.includes('w-an') && !aliases.includes('w-aus'), aliases.join(','));

    // Outbox: Ereignisse von B erhält der Abnehmer nicht, verteilt sind sie trotzdem
    seen.events.length = 0;
    await full(api.t.runtime, A, tx => platform.emit(tx, 'bericht.test', null, { n: 'a' }));
    await full(api.t.runtime, B, tx => platform.emit(tx, 'bericht.test', null, { n: 'b' }));
    assert.ok(await worker.runTask(outboxTask(app.modules.flatMap(m => m.consumers ?? []), model)));
    const got = seen.events.filter(e => e.type === 'bericht.test').map(e => e.tenant_alias);
    assert.deepEqual(got, ['w-an']);
    const open = (await api.t.worker.query("SELECT count(*)::int AS n FROM probe.outbox_event WHERE dispatched_at IS NULL")).rows[0].n;
    assert.equal(open, 0);
  });

  test('Pakete: tenant create --paket setzt genau die Menge, off-Teilfunktionen aus, einrichten nur für Module des Pakets', async () => {
    const t = await app.tenants.create(d, 'p-basis', 'Basis AG', { paket: 'basis' });
    assert.deepEqual(await states('p-basis'), { kern: [true, true], notizen: [true, true], 'notizen.abo': [true, false], berichte: [false, false] });
    assert.equal((await audits(t.id, 'bericht.eingerichtet')).length, 0);
    assert.deepEqual((await audits(t.id, 'tenant.module_package')).map(x => x.paket), ['basis']);
    // Die API belegt nichts nach (Zeilen vorhanden): Berichte bleiben aus
    const admin = await login(api, 'p-basis', 'basis-admin', 'org-admin');
    assert.equal((await api.app.inject({ method: 'GET', url: '/v1/berichte', headers: admin })).json().reason, 'modul-inaktiv');
    assert.equal((await api.app.inject({ method: 'POST', url: '/v1/notizen/abo', headers: admin })).json().reason, 'modul-inaktiv');
    // Ein zweites Mal mit Paket: Fehler (Module bestehen)
    await assert.rejects(app.tenants.create(d, 'p-basis', undefined, { paket: 'gesamt' }), /hat schon Module/);

    // Paket erneut anwenden (Betrieb): gesamt erlaubt und aktiviert alles, einrichten für Berichte genau einmal
    const r = await app.tenants.modules(d, 'p-basis', { paket: 'gesamt' });
    assert.equal(r.paket, 'gesamt');
    assert.deepEqual(await states('p-basis'), { kern: [true, true], notizen: [true, true], 'notizen.abo': [true, true], berichte: [true, true] });
    assert.equal((await audits(t.id, 'bericht.eingerichtet')).length, 1);
    // basis nur erlauben: Berichte entzogen (deaktiviert mit), das Abo bleibt aktiv
    await app.tenants.modules(d, 'p-basis', { paket: 'basis', nurErlauben: true });
    assert.deepEqual(await states('p-basis'), { kern: [true, true], notizen: [true, true], 'notizen.abo': [true, true], berichte: [false, false] });
    // basis vollständig: Abo aus
    await app.tenants.modules(d, 'p-basis', { paket: 'basis' });
    assert.deepEqual((await states('p-basis'))['notizen.abo'], [true, false]);
    // Erlauben aktiviert nichts
    await app.tenants.modules(d, 'p-basis', { erlauben: ['berichte'] });
    assert.deepEqual((await states('p-basis')).berichte, [true, false]);
    await assert.rejects(app.tenants.modules(d, 'p-basis', { erlauben: ['gibtsnicht'] }), /Unbekannte Module: gibtsnicht/);
  });

  test('Pakete: scheitert einrichten beim Anlegen, bleibt nichts stehen; der zweite Versuch gelingt', async () => {
    seen.failSetup = true;
    try {
      await assert.rejects(app.tenants.create(d, 'p-fehler', undefined, { paket: 'gesamt' }), /einrichten gescheitert/);
    } finally { seen.failSetup = false; }
    const t = await app.tenants.create(d, 'p-fehler', undefined, { paket: 'gesamt' });
    assert.deepEqual(await states('p-fehler'), { kern: [true, true], notizen: [true, true], 'notizen.abo': [true, true], berichte: [true, true] });
    assert.equal((await audits(t.id, 'bericht.eingerichtet')).length, 1);
  });

  test('Pakete: Wechsel bei Voraussetzung «eines von» aktiviert zuerst den Ersatz', async () => {
    const alt = defineModel({
      product: 'probe',
      modules: [
        { key: 'kern', label: 'Kern', core: true }, { key: 'aa', label: 'A', requires: ['kern'] }, { key: 'bb', label: 'B', requires: ['kern'] },
        { key: 'cc', label: 'C', requires: [['aa', 'bb']] },
      ],
      packages: [{ key: 'pa', label: 'PA', modules: ['kern', 'aa', 'cc'] }, { key: 'pb', label: 'PB', modules: ['kern', 'bb', 'cc'] }],
      permissions: {}, groups: [], roles: {},
    });
    await tenant(api.t.runtime, 'p-alt');
    const m = { model: alt as never, audit: platform.audit };
    const on = (r: Awaited<ReturnType<typeof tenantModules>>) => r.modules.filter(s => s.active).map(s => s.key);
    assert.deepEqual(on(await tenantModules(platform.context, d, 'p-alt', m, { paket: 'pa' })), ['kern', 'aa', 'cc']);
    assert.deepEqual(on(await tenantModules(platform.context, d, 'p-alt', m, { paket: 'pb' })), ['kern', 'bb', 'cc']);
  });

  test('Befehle über runCli: tenant create --paket und tenant modules (JSON)', async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => { out.push(s); };
    const env = { DATABASE_ADMIN_URL: api.t.adminUrl, DATABASE_URL: api.t.runtimeUrl };
    try {
      await runCli(app, ['tenant', 'create', 'cli-basis', '--paket', 'basis'], env);
      await runCli(app, ['tenant', 'modules', 'cli-basis', '--erlauben', 'berichte'], env);
    } finally { console.log = log; }
    const listed = JSON.parse(out.at(-1)!) as { tenant: { alias: string }; modules: { key: string; allowed: boolean; active: boolean }[] };
    assert.equal(listed.tenant.alias, 'cli-basis');
    assert.deepEqual(listed.modules.map(m => [m.key, m.allowed, m.active]), [['kern', true, true], ['notizen', true, true], ['notizen.abo', true, false], ['berichte', true, false]]);
  });
});
