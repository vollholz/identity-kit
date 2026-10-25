/**
 * Migrationen: Parameter und Platzhalter, Prüfsummen, Reihenfolge der Quellen, Übernahme mit Vorbedingungen
 * (Entwurf Kap. 6, Auflage 4).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { IAM_BASELINE, iamMigrations, migrate, migration, render, type MigrationSource } from '../src/migrations.ts';
import { diffSnapshots, schemaSnapshot } from '../src/schema.ts';
import { withTenant } from '../src/db.ts';
import { productDb, skipDb } from './support/db.ts';
import { modelChecks } from '../src/migrations.ts';
import { notesModel } from './support/models.ts';

const skip = await skipDb();

describe('IAM-Migrationen: Parameter', () => {
  /**
   * Veröffentlichte IAM-Migrationen sind unveränderlich: Ihre Prüfsumme steht in jeder angewendeten Datenbank (auch bei
   * Übernahme). Schon eine geänderte Kommentarzeile bräche jeden Deploy mit «nach dem Ausführen geändert». Änderungen
   * gehören in eine neue Migration; die Liste wird nur um neue Dateien ergänzt (gerendert für `notes`).
   */
  test('Prüfsummen veröffentlichter IAM-Migrationen unverändert', () => {
    const pinned: Record<string, string> = {
  'iam_001_core.sql': 'edcd4dea97370589c9e3d38cf311ee4aecd4bed1b8d531658375f0e93c2c5298',
  'iam_002_tenant.sql': 'f2fae5b3b1bc22ea275ddc9aab8eac6d3c5d72737f9d19e82c7dd2d0208f5552',
  'iam_003_principal.sql': 'ce00e980dd65a5b31671dbc93fa4ac22d0990e6b8f654e3e38cf62c765a65e25',
  'iam_004_access.sql': 'b07a22e4c7579a41d05e5b4277fbef9170e8abde65943c6655e747a3ba557990',
  'iam_005_members.sql': '9adc165203bb652c6f520eb8c37cb605d2c679c5b2d8ab4029967a5e6950677f',
  'iam_006_session.sql': '71917caddb293fd9f32ea59169ee2e5f5c58ba3619292ab24d3f08f14b29fa5d',
  'iam_007_audit.sql': 'd16541bc55129ec4eafbaecb18be3901394cb5724a5cd4a12ed3e66eacdd4a4a',
  'iam_008_entra.sql': 'fe5161963216d70f133852f7a97e8685b00b2c184c2bba6f7e3f4fb7ef688c6f',
  'iam_009_tenant_role_key.sql': '23be7629e1b61dbda5ea63d0ec8de5d3e6ef25e31d3f61abd0380ddbe14283fb',
  'iam_010_revoke_public_execute.sql': '0c9fd8514bc3cd387d2716302d114b1bd3b6a6f2c5bb7b62b387d1263f9b0f81',
  'iam_011_resolve_tenant_strict.sql': '4096b1e01b48880655808eb03612c589b703a9ad6ee2669a74022eb0a7d4b00e',
  'iam_012_acl_unique.sql': '1ffec0eab8fbfd500a3f5815ae51c44d133596369c4db2db5f63a675ec80cea1',
  'iam_013_entra_consent_link.sql': '60066235d13e7891c15d002f70af87993aca706010bf1bfcc96d4eb6831cf2bd',
  'iam_014_entra_own_app.sql': 'dc7ec8bcbbbf5fc06da8ffe3d5ad67a030b047458c66e3c492e74d3779ad9997',
  'iam_015_authz.sql': 'bdd7d4c74ae77053d60e7dacec2287f37b03b31abbe14577dc8e038f125bdf40',
  'iam_016_person_scope.sql': 'a6e82cebe810b9f1a32328ccf4bb20c38be89f24add4a919d78cd12b2b430123',
  'iam_017_account.sql': '918a2dd121d903f7b9f093e8dc8ec8fb80f825c0a9eb86b7eecb0a5eeead4185',
    };
    const now = new Map(iamMigrations({ product: 'notes' }).migrations.map(m => [m.name, m.checksum]));
    for (const [name, sum] of Object.entries(pinned)) {
      assert.ok(now.has(name), `${name} fehlt: veröffentlichte Migrationen nie umbenennen oder löschen`);
      assert.equal(now.get(name), sum, `${name} wurde geändert. Veröffentlichte IAM-Migrationen sind unveränderlich (Prüfsumme in jeder Datenbank): Änderung in eine neue Migration iam_NNN legen.`);
    }
    assert.deepEqual([...now.keys()].filter(n => !pinned[n]), [], 'neue Migration: Prüfsumme hier ergänzen');
  });

  test('Dateien iam_001 … iam_017 in Reihenfolge, Stand der Übernahme dabei', () => {
    const names = iamMigrations({ product: 'notes' }).migrations.map(m => m.name);
    assert.deepEqual(names, [...names].sort());
    assert.equal(names[0], 'iam_001_core.sql');
    assert.ok(names.includes(IAM_BASELINE));
    assert.equal(names.at(-1), 'iam_017_account.sql');
    // Alles Produktspezifische kommt aus den Platzhaltern: kein fester Name einer App im SQL
    const beta = iamMigrations({ product: 'beta' }).migrations;
    for (const [i, m] of iamMigrations({ product: 'alpha' }).migrations.entries()) {
      assert.doesNotMatch(m.sql, /\{\{|\}\}/, m.name);
      assert.equal(m.sql.replaceAll('alpha', 'beta'), beta[i]!.sql, m.name);
    }
  });

  test('Schema und Rollen werden eingesetzt; Prüfsummen hängen nicht am Modell', () => {
    const a = iamMigrations({ product: 'notes', model: notesModel }).migrations;
    const core = a.find(m => m.name === 'iam_001_core.sql')!.sql;
    assert.match(core, /CREATE SCHEMA IF NOT EXISTS notes;/);
    assert.match(core, /TO notes_app, notes_sched;/);
    assert.match(a.find(m => m.name === 'iam_007_audit.sql')!.sql, /FOR ROLE notes_owner/);
    assert.match(a.find(m => m.name === 'iam_008_entra.sql')!.sql, /FOR SELECT TO notes_owner USING/);
    assert.match(a.find(m => m.name === 'iam_015_authz.sql')!.sql, /CREATE TABLE notes\.authz_tuple/);
    // Ein neuer Typ oder eine neue Rolle ist ein normaler Fall: keine Migration ändert sich
    const b = iamMigrations({ product: 'notes', model: { types: ['org', 'note'], relations: ['org-admin', 'viewer'] } }).migrations;
    assert.deepEqual(a.map(m => m.checksum), b.map(m => m.checksum));
    const c = iamMigrations({ product: 'notes', schema: 'other' }).migrations;
    assert.notEqual(a[0]!.checksum, c[0]!.checksum);
  });

  test('Bedingungen zu Relationen und Typen von authz_tuple (Form wie PostgreSQL sie ausgibt)', () => {
    assert.deepEqual(modelChecks({ types: ['org', 'folder', 'note'], relations: ['org-admin', 'editor'] }), {
      authz_tuple_relation_check: { sql: "CHECK (relation IN ('org-admin', 'editor'))", def: "CHECK ((relation = ANY (ARRAY['org-admin'::text, 'editor'::text])))" },
      authz_tuple_object_type_check: { sql: "CHECK (object_type IN ('org', 'folder', 'note'))", def: "CHECK ((object_type = ANY (ARRAY['org'::text, 'folder'::text, 'note'::text])))" },
    });
    assert.deepEqual(modelChecks(), {
      authz_tuple_relation_check: { sql: "CHECK (relation IN ('org-admin'))", def: "CHECK ((relation = 'org-admin'::text))" },
      authz_tuple_object_type_check: { sql: "CHECK (object_type IN ('org'))", def: "CHECK ((object_type = 'org'::text))" },
    });
    const all = modelChecks({ types: [...notesModel.types.keys()], relations: notesModel.allRelations() });
    for (const r of ['org-admin', 'editor', 'viewer', 'member', 'owner']) assert.match(all.authz_tuple_relation_check!.sql, new RegExp(`'${r}'`), r);
  });

  test('Produkt mit Bindestrich: Schema und Rollen mit Unterstrich (gleiche Regel wie die Konfiguration)', () => {
    const m = iamMigrations({ product: 'my-app' }).migrations;
    const core = m.find(x => x.name === 'iam_001_core.sql')!.sql;
    assert.match(core, /CREATE SCHEMA IF NOT EXISTS my_app;/);
    assert.match(core, /TO my_app_app, my_app_sched;/);
    assert.match(m.find(x => x.name === 'iam_007_audit.sql')!.sql, /FOR ROLE my_app_owner/);
    assert.throws(() => iamMigrations({ product: 'my_app' }), /product/);
  });

  test('ungültige Parameter brechen ab (nie roh ins SQL)', () => {
    assert.throws(() => iamMigrations({ product: 'Notes' }), /product/);
    assert.throws(() => iamMigrations({ product: 'notes', schema: 'notes; DROP' }), /schema/);
    assert.throws(() => iamMigrations({ product: 'notes', model: { types: ['note'], relations: ['org-admin'] } }), /org/);
    assert.throws(() => modelChecks({ types: ['org', "x')"], relations: [] }), /ungültig/);
    assert.throws(() => iamMigrations({ product: 'notes', model: { types: ['org'], relations: ["x')"] } }), /ungültig/);
    assert.throws(() => render('SELECT {{nope}}', {}), /Unbekannter Platzhalter/);
  });

  test('Prüfsumme unabhängig von Zeilenenden', () => {
    assert.equal(migration('x.sql', 'SELECT 1;\r\nSELECT 2;\r\n').checksum, migration('x.sql', 'SELECT 1;\nSELECT 2;\n').checksum);
  });
});

describe('Runner gegen PostgreSQL', { skip }, () => {
  const extra: MigrationSource = { name: 'app', migrations: [migration('001_notes.sql', 'CREATE TABLE notes.note (tenant_id uuid NOT NULL REFERENCES notes.tenant(id), id uuid NOT NULL, PRIMARY KEY (tenant_id, id));')] };
  const db = productDb({ sources: [extra] });
  let t: Awaited<ReturnType<typeof db.create>>;
  before(async () => { t = await db.create(); });
  after(async () => { await t?.drop(); });

  test('IAM vor App; Tabellen der App erhalten RLS automatisch; zweiter Lauf ändert nichts', async () => {
    const rows = (await t.inspect.query<{ name: string }>('SELECT name FROM public.schema_migrations ORDER BY applied_at, name')).rows.map(r => r.name);
    assert.deepEqual(rows, [...iamMigrations({ product: 'notes' }).migrations.map(m => m.name), '001_notes.sql']);
    const note = (await t.inspect.query("SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE oid = 'notes.note'::regclass")).rows[0];
    assert.deepEqual(note, { r: true, f: true });
    const again = await migrate(t.adminUrl, [iamMigrations({ product: 'notes' }), extra]);
    assert.deepEqual(again, { applied: [], adopted: [], skipped: 18 });
    const log: string[] = [];
    await migrate(t.adminUrl, [iamMigrations({ product: 'notes' }), extra], m => log.push(m));
    assert.deepEqual(log, [], 'Abgleich ohne Änderung meldet nichts');
  });

  test('nur als Besitzer-Rolle des Produkts', async () => {
    await assert.rejects(migrate(t.runtimeUrl, [iamMigrations({ product: 'notes' })]), /laufen als notes_owner, nicht als notes_runtime/);
  });

  test('Typen und Relationen ändern sich mit dem Modell: Abgleich ohne neue Migration, zweiter Lauf ohne Änderung', async () => {
    const def = async () => Object.fromEntries((await t.inspect.query<{ n: string; d: string }>(
      "SELECT conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'notes.authz_tuple'::regclass AND conname IN ('authz_tuple_relation_check', 'authz_tuple_object_type_check')")).rows.map(r => [r.n, r.d]));
    assert.deepEqual(await def(), { authz_tuple_relation_check: "CHECK ((relation = 'org-admin'::text))", authz_tuple_object_type_check: "CHECK ((object_type = 'org'::text))" });
    const log: string[] = [];
    const wider = { product: 'notes', model: { types: ['org', 'folder'], relations: ['org-admin', 'editor'] } };
    const r = await migrate(t.adminUrl, [iamMigrations(wider), extra], m => log.push(m));
    assert.deepEqual(r.applied, []);
    assert.deepEqual(log, ['Bedingung authz_tuple_relation_check an das Modell angepasst', 'Bedingung authz_tuple_object_type_check an das Modell angepasst']);
    const want = modelChecks(wider.model);
    assert.deepEqual(await def(), { authz_tuple_relation_check: want.authz_tuple_relation_check!.def, authz_tuple_object_type_check: want.authz_tuple_object_type_check!.def });
    const again: string[] = [];
    await migrate(t.adminUrl, [iamMigrations(wider), extra], m => again.push(m));
    assert.deepEqual(again, []);
    // Relation entfernen, die noch verwendet wird: Abbruch mit Hinweis, Bedingung bleibt (Kap. 8.2)
    const id = (await t.runtime.query<{ id: string }>("SELECT app.resolve_tenant('alpha', null, 'alpha', true) AS id")).rows[0]!.id;
    await t.inspect.query("INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type, object_id) VALUES ($1, 'org:members', 'editor', 'folder', gen_random_uuid())", [id]);
    await assert.rejects(migrate(t.adminUrl, [iamMigrations({ product: 'notes', model: { types: ['org', 'folder'], relations: ['org-admin'] } }), extra]), /authz_tuple_relation_check lässt sich nicht an das Modell anpassen.*Tupel mit entfernten Relationen oder Typen zuerst löschen/);
    assert.equal((await def()).authz_tuple_relation_check, want.authz_tuple_relation_check!.def);
    await t.inspect.query("DELETE FROM notes.authz_tuple WHERE object_type = 'folder'");
    await migrate(t.adminUrl, [iamMigrations({ product: 'notes' }), extra]);
    assert.deepEqual(await def(), { authz_tuple_relation_check: "CHECK ((relation = 'org-admin'::text))", authz_tuple_object_type_check: "CHECK ((object_type = 'org'::text))" });
  });

  test('iam_015: alte Tabellen (Zugriffsregeln, eigene Rollen, Freigaben) entfernt, authz_tuple mit RLS', async () => {
    const tables = (await t.inspect.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'notes' AND tablename IN ('acl_entry', 'tenant_role', 'client_grant', 'authz_tuple')")).rows.map(r => r.t);
    assert.deepEqual(tables, ['authz_tuple']);
    const rls = (await t.inspect.query("SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE oid = 'notes.authz_tuple'::regclass")).rows[0];
    assert.deepEqual(rls, { r: true, f: true });
    const cols = (await t.inspect.query<{ c: string }>("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'notes' AND table_name = 'principal' AND column_name IN ('last_roles', 'clearance', 'clearance_boost', 'clearance_until')")).rows.map(r => r.c).sort();
    assert.deepEqual(cols, ['clearance', 'clearance_boost', 'clearance_until']);
  });

  test('geänderte Migration und doppelte Namen brechen ab', async () => {
    const changed: MigrationSource = { name: 'app', migrations: [migration('001_notes.sql', 'SELECT 1;')] };
    await assert.rejects(migrate(t.adminUrl, [iamMigrations({ product: 'notes' }), changed]), /001_notes.sql wurde nach dem Ausführen geändert/);
    const dup: MigrationSource = { name: 'zwei', migrations: [migration('001_notes.sql', 'SELECT 1;')] };
    await assert.rejects(migrate(t.adminUrl, [extra, dup]), /kommt in app und zwei vor/);
  });

  test('fehlgeschlagene Migration wird zurückgerollt und nicht eingetragen', async () => {
    const bad: MigrationSource = { name: 'app', migrations: [...extra.migrations, migration('002_bad.sql', 'CREATE TABLE notes.x (id int); SELECT 1/0;')] };
    await assert.rejects(migrate(t.adminUrl, [iamMigrations({ product: 'notes' }), bad]), /002_bad.sql fehlgeschlagen/);
    assert.equal((await t.inspect.query("SELECT to_regclass('notes.x') AS r")).rows[0].r, null);
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM public.schema_migrations WHERE name = '002_bad.sql'")).rows[0].n, 0);
  });
});

describe('Übernahme (adopted)', { skip }, () => {
  /** Objekte aus «eigenen» Migrationen der App (z. B. 001–049): die IAM-Migrationen unter anderem Namen, dazu die Marke. */
  const own = (product: string): MigrationSource => ({
    name: 'app',
    migrations: [
      ...iamMigrations({ product }).migrations.filter(m => m.name <= IAM_BASELINE).map(m => migration(m.name.replace(/^iam_/, '0'), m.sql)),
      migration('049_tenant_roles.sql', 'SELECT 1;'),
    ],
  });
  const db = productDb({ iam: false, sources: [own('notes')] });
  // Nur die Marke (und was der Runner nach jeder Migration aufruft), keine Objekte
  const empty = productDb({ iam: false, sources: [{ name: 'app', migrations: [migration('049_tenant_roles.sql', "CREATE SCHEMA app; CREATE FUNCTION app.secure_tenant_tables() RETURNS int LANGUAGE sql AS 'SELECT 0';")] }] });
  let t: Awaited<ReturnType<typeof db.create>>, e: Awaited<ReturnType<typeof empty.create>>;
  before(async () => { t = await db.create(); e = await empty.create(); });
  after(async () => { await t?.drop(); await e?.drop(); });

  test('Objekte vorhanden, Marke angewendet: bis zur Grundlage eingetragen, Späteres ausgeführt', async () => {
    const r = await migrate(t.adminUrl, [own('notes'), iamMigrations({ product: 'notes', adopted: { after: '049_tenant_roles.sql' } })]);
    assert.deepEqual(r.adopted, iamMigrations({ product: 'notes' }).migrations.filter(m => m.name <= IAM_BASELINE).map(m => m.name));
    assert.deepEqual(r.applied, ['iam_009_tenant_role_key.sql', 'iam_010_revoke_public_execute.sql', 'iam_011_resolve_tenant_strict.sql', 'iam_012_acl_unique.sql', 'iam_013_entra_consent_link.sql', 'iam_014_entra_own_app.sql', 'iam_015_authz.sql', 'iam_016_person_scope.sql', 'iam_017_account.sql']);
    const again = await migrate(t.adminUrl, [own('notes'), iamMigrations({ product: 'notes', adopted: { after: '049_tenant_roles.sql' } })]);
    assert.deepEqual([again.applied, again.adopted], [[], []]);
  });

  test('Objekte fehlen: Abbruch mit Befunden, nichts eingetragen', async () => {
    await assert.rejects(migrate(e.adminUrl, [iamMigrations({ product: 'notes', adopted: { after: '049_tenant_roles.sql' } })]), (err: Error) => {
      assert.match(err.message, /Übernahme der Migrationen von iam nicht möglich/);
      assert.match(err.message, /Tabelle notes\.tenant fehlt/);
      assert.match(err.message, /Funktion app\.resolve_tenant fehlt/);
      return true;
    });
    assert.equal((await e.inspect.query("SELECT count(*)::int AS n FROM public.schema_migrations WHERE name LIKE 'iam_%'")).rows[0].n, 0);
  });

  test('Objekte ohne Schutz (Stub-Tabellen und -Funktionen ohne RLS, Policies, SECURITY DEFINER): Abbruch, nichts eingetragen', async () => {
    const tables = ['tenant', 'principal', 'acl_entry', 'tenant_role', 'member_invitation', 'client_grant', 'session', 'replay_guard', 'rate_limit', 'audit_log', 'audit_anchor', 'entra_connection', 'entra_consent'];
    const cols: Record<string, string> = { principal: 'last_roles text[], removed_at timestamptz', member_invitation: 'id uuid, entra boolean', audit_log: 'seq bigint', session: 'idp_sid text', tenant_role: 'deleted_at timestamptz' };
    const fns = ['tenant_id', 'principal_id', 'secure_tenant_tables', 'resolve_tenant', 'bump_acl_version', 'audit_hash', 'audit_chain', 'suspended_tenants', 'platform_tenants', 'set_tenant_status', 'entra_login_alias', 'entra_free_slot', 'entra_domains_taken'];
    const stubSql = ['CREATE SCHEMA app; CREATE SCHEMA notes;',
      ...tables.map(t => `CREATE TABLE notes.${t} (${t === 'tenant' ? 'id uuid' : 'tenant_id uuid'}${cols[t] ? `, ${cols[t]}` : ''}); GRANT SELECT ON notes.${t} TO PUBLIC;`),
      ...fns.map(f => `CREATE FUNCTION app.${f}() RETURNS int LANGUAGE sql AS 'SELECT 0';`)].join('\n');
    const stub = productDb({ iam: false, sources: [{ name: 'app', migrations: [migration('049_tenant_roles.sql', stubSql)] }] });
    const s1 = await stub.create();
    try {
      await assert.rejects(migrate(s1.adminUrl, [iamMigrations({ product: 'notes', adopted: { after: '049_tenant_roles.sql' } })]), (err: Error) => {
        for (const m of [/Tabelle notes\.principal: RLS mit FORCE fehlt/, /notes\.audit_log: Policy tenant_isolation für notes_app/, /notes\.tenant: RLS mit Policy tenant_self fehlt/, /notes\.session: PUBLIC hat Rechte/, /app\.resolve_tenant: SECURITY DEFINER mit search_path=notes, pg_temp fehlt/]) assert.match(err.message, m);
        return true;
      });
      assert.equal((await s1.inspect.query("SELECT count(*)::int AS n FROM public.schema_migrations WHERE name LIKE 'iam_%'")).rows[0].n, 0);
    } finally { await s1.drop(); }
  });

  test('frische Datenbank: IAM direkt nach der Marke, spätere Migrationen der App dürfen spätere IAM-Migrationen voraussetzen', async () => {
    const needs = migration('050_needs_iam_009.sql', "SELECT 1 / (SELECT count(*)::int FROM pg_constraint WHERE conname = 'authz_tuple_pkey');");
    const app = own('notes');
    const fresh = productDb({ iam: false, sources: [{ ...app, migrations: [...app.migrations, needs] }, iamMigrations({ product: 'notes', adopted: { after: '049_tenant_roles.sql' } })] });
    const f = await fresh.create();
    try {
      const order = (await f.inspect.query<{ name: string }>('SELECT name FROM public.schema_migrations ORDER BY applied_at, name')).rows.map(r => r.name);
      assert.deepEqual(order.slice(-10), ['iam_009_tenant_role_key.sql', 'iam_010_revoke_public_execute.sql', 'iam_011_resolve_tenant_strict.sql', 'iam_012_acl_unique.sql', 'iam_013_entra_consent_link.sql', 'iam_014_entra_own_app.sql', 'iam_015_authz.sql', 'iam_016_person_scope.sql', 'iam_017_account.sql', '050_needs_iam_009.sql']);
    } finally { await f.drop(); }
  });

  test('Marke nicht angewendet: Abbruch', async () => {
    const c = new pg.Client({ connectionString: t.adminUrl });
    await c.connect();
    try {
      // Datenbank mit Objekten, aber ohne die Marke der App
      await c.query("DELETE FROM public.schema_migrations WHERE name LIKE 'iam_%' OR name = '049_tenant_roles.sql'");
    } finally { await c.end(); }
    await assert.rejects(migrate(t.adminUrl, [iamMigrations({ product: 'notes', adopted: { after: '049_tenant_roles.sql' } })]), /Migration 049_tenant_roles.sql ist nicht angewendet/);
  });
});

describe('Produkt mit Bindestrich gegen PostgreSQL', { skip }, () => {
  const db = productDb({ product: 'iam-kit' });
  let t: Awaited<ReturnType<typeof db.create>>;
  before(async () => { t = await db.create(); });
  after(async () => { await t?.drop(); });

  test('Migrationen laufen, Schema und Rollen mit Unterstrich', async () => {
    const id = (await t.runtime.query<{ id: string }>("SELECT app.resolve_tenant('alpha', null, 'alpha', true) AS id")).rows[0]!.id;
    assert.ok(id);
    assert.equal((await t.inspect.query("SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = 'iam_kit'")).rows[0].o, 'iam_kit_owner');
  });
});

describe('iam_012: keine doppelten Zugriffsregeln', { skip }, () => {
  const iam = iamMigrations({ product: 'notes' });
  const db = productDb({ iam: false, sources: [{ ...iam, migrations: iam.migrations.filter(m => m.name < 'iam_012') }] });
  let t: Awaited<ReturnType<typeof db.create>>;
  before(async () => { t = await db.create(); });
  after(async () => { await t?.drop(); });

  test('bestehende Duplikate entfernt (der älteste bleibt, auch mit NULL), danach eindeutig', async () => {
    const A = (await t.runtime.query<{ id: string }>("SELECT app.resolve_tenant('alpha', null, 'alpha', true) AS id")).rows[0]!.id;
    const insert = async (c: pg.ClientBase, effect = 'deny', ref = 'viewer') => (await c.query<{ id: string }>(
      `INSERT INTO notes.acl_entry (tenant_id, resource_type, principal_type, principal_ref, permission, effect) VALUES ($1, 'tenant', 'role', $2, 'note:read', $3) RETURNING id`, [A, ref, effect])).rows[0]!.id;
    const ids: string[] = [];
    for (const [effect, ref] of [['deny', 'viewer'], ['deny', 'viewer'], ['deny', 'viewer'], ['restrict', 'viewer'], ['deny', 'editor']]) ids.push(await withTenant(t.runtime, { tenantId: A }, tx => insert(tx, effect, ref)));
    // Nur bis iam_012 (iam_015 entfernt acl_entry)
    const r = await migrate(t.adminUrl, [{ ...iam, migrations: iam.migrations.filter(m => m.name < 'iam_013') }]);
    assert.deepEqual(r.applied, ['iam_012_acl_unique.sql']);
    const left = (await t.inspect.query<{ id: string }>('SELECT id FROM notes.acl_entry ORDER BY created_at, id')).rows.map(x => x.id);
    assert.deepEqual(left.sort(), [ids[0]!, ids[3]!, ids[4]!].sort(), 'ein Duplikat bleibt (das älteste), andere Wirkung und Rolle bleiben');
    await assert.rejects(withTenant(t.runtime, { tenantId: A }, tx => insert(tx)), (e: { code?: string }) => e.code === '23505');
    assert.equal((await t.inspect.query("SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'notes.acl_entry'::regclass")).rows[0].f, true, 'FORCE RLS wieder an');
  });
});

describe('Übernahme späterer IAM-Migrationen (adopted.map)', { skip }, () => {
  /** Bestehende App: Grundlage unter eigenem Namen, Marke 049, dann 051–053 = iam_010–012. */
  const ADOPTION = {
    after: '053_acl_unique.sql',
    map: { '051_revoke_public_execute.sql': 'iam_010_revoke_public_execute.sql', '052_resolve_tenant_strict.sql': 'iam_011_resolve_tenant_strict.sql', '053_acl_unique.sql': 'iam_012_acl_unique.sql' },
  };
  const existingApp = (product = 'notes'): MigrationSource => {
    const iam = iamMigrations({ product }).migrations;
    const sql = (prefix: string) => iam.find(m => m.name.startsWith(prefix))!.sql;
    return {
      name: 'app',
      migrations: [
        ...iam.filter(m => m.name <= IAM_BASELINE).map(m => migration(m.name.replace(/^iam_/, '0'), m.sql)),
        migration('049_tenant_roles.sql', 'SELECT 1;'),
        migration('051_revoke_public_execute.sql', sql('iam_010_')),
        migration('052_resolve_tenant_strict.sql', sql('iam_011_')),
        migration('053_acl_unique.sql', sql('iam_012_')),
      ],
    };
  };
  const fullIam = productDb();
  let full: Awaited<ReturnType<typeof fullIam.create>>;
  before(async () => { full = await fullIam.create(); });
  after(async () => { await full?.drop(); });

  test('bestehende Datenbank bis 053: iam_001–008 und 010–012 eingetragen, nur iam_009 (und neuere) laufen; Schema wie frische Anlage', async () => {
    const db = productDb({ iam: false, sources: [existingApp()] });
    const [old, t] = [await db.create(), await db.create()];
    try {
      // ohne Zuordnung: iam_012 scheitert am bestehenden Index
      await assert.rejects(migrate(old.adminUrl, [existingApp(), iamMigrations({ product: 'notes', adopted: { after: '049_tenant_roles.sql' } })]), /iam_012_acl_unique\.sql fehlgeschlagen: .*already exists/);
      const r = await migrate(t.adminUrl, [existingApp(), iamMigrations({ product: 'notes', adopted: ADOPTION })]);
      assert.deepEqual(r.applied, ['iam_009_tenant_role_key.sql', 'iam_013_entra_consent_link.sql', 'iam_014_entra_own_app.sql', 'iam_015_authz.sql', 'iam_016_person_scope.sql', 'iam_017_account.sql']);
      assert.deepEqual(r.adopted, [...iamMigrations({ product: 'notes' }).migrations.filter(m => m.name <= IAM_BASELINE).map(m => m.name),
        'iam_010_revoke_public_execute.sql', 'iam_011_resolve_tenant_strict.sql', 'iam_012_acl_unique.sql']);
      assert.deepEqual(diffSnapshots(await schemaSnapshot(full.inspect, 'notes'), await schemaSnapshot(t.inspect, 'notes')), []);
      const again = await migrate(t.adminUrl, [existingApp(), iamMigrations({ product: 'notes', adopted: ADOPTION })]);
      assert.deepEqual([again.applied, again.adopted], [[], []]);
    } finally { await old.drop(); await t.drop(); }
  });

  test('frische Datenbank: App bis 053, dann Übernahme und iam_009; Schema wie frische Anlage', async () => {
    const db = productDb({ iam: false, sources: [existingApp(), iamMigrations({ product: 'notes', adopted: ADOPTION })] });
    const f = await db.create();
    try {
      const rows = (await f.inspect.query<{ name: string }>("SELECT name FROM public.schema_migrations WHERE name LIKE 'iam_%' ORDER BY name")).rows.map(r => r.name);
      assert.deepEqual(rows, iamMigrations({ product: 'notes' }).migrations.map(m => m.name));
      assert.deepEqual(diffSnapshots(await schemaSnapshot(full.inspect, 'notes'), await schemaSnapshot(f.inspect, 'notes')), []);
    } finally { await f.drop(); }
  });

  /** Bestehende App mit veränderter Migration 051, 052 oder 053 (unvollständig nachgebaut): Übernahme bricht ab. */
  const broken = async (file: string, edit: (sql: string) => string, message: RegExp) => {
    const base = existingApp();
    const src = { ...base, migrations: base.migrations.map(m => (m.name === file ? migration(m.name, edit(m.sql)) : m)) };
    const b = await productDb({ iam: false, sources: [src] }).create();
    try {
      await assert.rejects(migrate(b.adminUrl, [src, iamMigrations({ product: 'notes', adopted: ADOPTION })]), (e: Error) => { assert.match(e.message, message); return true; });
      assert.equal((await b.inspect.query("SELECT count(*)::int AS n FROM public.schema_migrations WHERE name LIKE 'iam_%'")).rows[0].n, 0, file);
      // die Probe von resolve_tenant hinterlässt nichts
      assert.equal((await b.inspect.query("SELECT count(*)::int AS n FROM notes.tenant WHERE alias LIKE 'iamprobe-%'")).rows[0].n, 0);
    } finally { await b.drop(); }
  };

  test('unvollständig nachgebaut: fehlender Grant, partieller Index, Index ohne NULLS NOT DISTINCT, resolve_tenant ohne Prüfungen → Abbruch ohne Eintrag', async () => {
    await broken('051_revoke_public_execute.sql', sql => sql.replace(/GRANT EXECUTE ON FUNCTION app\.audit_hash[^;]*;/, ''), /EXECUTE auf app\.audit_hash\(bytea, notes\.audit_log\) fehlt für notes_app, notes_sched/);
    await broken('053_acl_unique.sql', sql => sql.replace(/NULLS NOT DISTINCT;/, "NULLS NOT DISTINCT WHERE effect <> 'deny';"), /acl_entry_unique entspricht nicht iam_012/);
    await broken('053_acl_unique.sql', sql => sql.replace(/ NULLS NOT DISTINCT;/, ';'), /acl_entry_unique entspricht nicht iam_012/);
    await broken('052_resolve_tenant_strict.sql', sql => sql.replace(/ {4}IF v_kc IS DISTINCT FROM p_kc_org_id THEN RETURN NULL; END IF;\n/, ''), /bindet die Organisations-ID eines anderen Mandanten/);
    await broken('052_resolve_tenant_strict.sql', sql => sql.replace("ON CONFLICT DO NOTHING", ''), /app\.resolve_tenant: .*duplicate key|legt einen Mandanten mit der Organisations-ID/);
    // Stand vor iam_011 (Funktion aus iam_005 bzw. App vor 052): 052 ändert nichts
    await broken('052_resolve_tenant_strict.sql', () => 'SELECT 1;', /app\.resolve_tenant (findet einen Mandanten über einen ungültigen Alias|legt einen Mandanten mit der Organisations-ID|bindet die Organisations-ID)/);
  });

  test('Zuordnung ohne angewendete Migration der App oder ohne Objekte: Abbruch, nichts eingetragen', async () => {
    const base = existingApp();
    // 053 fehlt als Migration, die Marke after ist 052: Zuordnung verlangt 053
    const short = productDb({ iam: false, sources: [{ ...base, migrations: base.migrations.slice(0, -1) }] });
    const s = await short.create();
    try {
      await assert.rejects(migrate(s.adminUrl, [iamMigrations({ product: 'notes', adopted: { ...ADOPTION, after: '052_resolve_tenant_strict.sql' } })]), (e: Error) => {
        assert.match(e.message, /Migration 053_acl_unique\.sql \(für iam_012_acl_unique\.sql\) ist nicht angewendet/);
        assert.match(e.message, /iam_012_acl_unique\.sql: eindeutiger Index notes\.acl_entry_unique fehlt/);
        return true;
      });
      assert.equal((await s.inspect.query("SELECT count(*)::int AS n FROM public.schema_migrations WHERE name LIKE 'iam_%'")).rows[0].n, 0);
    } finally { await s.drop(); }
    assert.throws(() => iamMigrations({ product: 'notes', adopted: { after: 'x', map: { 'x.sql': 'iam_099_gibt_es_nicht.sql' } } }), /gibt es nicht/);
    assert.throws(() => iamMigrations({ product: 'notes', adopted: { after: 'x', map: { 'x.sql': IAM_BASELINE } } }), /Grundlage/);
  });
});

