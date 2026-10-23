/**
 * Migrationen: Parameter und Platzhalter, Prüfsummen, Reihenfolge der Quellen, Übernahme mit Vorbedingungen
 * (Entwurf Kap. 6, Auflage 4).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { aclChecks, ASSETS_ADOPTION, IAM_BASELINE, iamMigrations, migrate, migration, render, type MigrationSource } from '../src/migrations.ts';
import { diffSnapshots, schemaSnapshot } from '../src/schema.ts';
import { withTenant } from '../src/db.ts';
import { productDb, skipDb } from './support/db.ts';

const skip = await skipDb();

describe('IAM-Migrationen: Parameter', () => {
  /**
   * Veröffentlichte IAM-Migrationen sind unveränderlich: Ihre Prüfsumme steht in jeder angewendeten Datenbank (auch bei
   * Übernahme). Schon eine geänderte Kommentarzeile bräche jeden Deploy mit «nach dem Ausführen geändert». Änderungen
   * gehören in eine neue Migration; die Liste wird nur um neue Dateien ergänzt (gerendert wie für Assets).
   */
  test('Prüfsummen veröffentlichter IAM-Migrationen unverändert (Assets: schema assets)', () => {
    const pinned: Record<string, string> = {
  'iam_001_core.sql': '3182ce0a8c8d351d5fe55b462c5b3916108b915903495fe147927b38e94fcd81',
  'iam_002_tenant.sql': 'eb3c1fb24d89299bfaacb9e4fa147ab1e7611a34b1f0600543936ad939c68cca',
  'iam_003_principal.sql': '4d72c82cdf6d0a8ae8ba94942507d3bcbdad1b1c89a071b4444e40f5938e7959',
  'iam_004_access.sql': '7e5db8bc1732cdf41fb13b5a685a29bb844beaac34b03aab17ac5181731f892c',
  'iam_005_members.sql': 'af1388c50f87ce3e32bc27163aea5e2f016fb7ad4d0dcf5b1808901f4e8b9eb3',
  'iam_006_session.sql': 'f987e1bf80ea41ecac74bc33c468d0a5c2571abe48f38bf02799bdd292e42ede',
  'iam_007_audit.sql': '7f737522d971b57d86845856c1f84d3dac612eef4366976c07df205de1595946',
  'iam_008_entra.sql': 'a258ea7f90d797eb3d08a876ad440e436a43d81d8dbaa118c9ec71798583d8cb',
  'iam_009_tenant_role_key.sql': 'a7159742d5a051e4cb6a60100f813162451674206008484228840db223ec59f8',
  'iam_010_revoke_public_execute.sql': '253c88ed8266b93342e1bd1c36c3a8019ec25d48c130f99d8a9c819f67dc8967',
  'iam_011_resolve_tenant_strict.sql': '7522b78dbae92a4355975a01927e27739cee1aa83c6c054aeced07c70344b556',
  'iam_012_acl_unique.sql': 'c39f849caeeb7fd8bc33188d052bad51d0d764b6fc3d5bb7a175044b117ff442',
  'iam_013_entra_consent_link.sql': 'b61dd7827c1efd3a4cba80b126eac93645ec930abbe9b27eeb8676f8faea3fb9',
  'iam_014_entra_own_app.sql': '4cf838b2aee77a309fe78d6528e2506d7ce1a1e928537478b796ef5ab8f9efe4',
    };
    const now = new Map(iamMigrations({ product: 'assets', schema: 'assets' }).migrations.map(m => [m.name, m.checksum]));
    for (const [name, sum] of Object.entries(pinned)) {
      assert.ok(now.has(name), `${name} fehlt: veröffentlichte Migrationen nie umbenennen oder löschen`);
      assert.equal(now.get(name), sum, `${name} wurde geändert. Veröffentlichte IAM-Migrationen sind unveränderlich (Prüfsumme in jeder Datenbank, auch übernommen in Assets): Änderung in eine neue Migration iam_NNN legen.`);
    }
    assert.deepEqual([...now.keys()].filter(n => !pinned[n]), [], 'neue Migration: Prüfsumme hier ergänzen');
  });

  test('Dateien iam_001 … iam_014 in Reihenfolge, Stand der Übernahme dabei', () => {
    const names = iamMigrations({ product: 'notes' }).migrations.map(m => m.name);
    assert.deepEqual(names, [...names].sort());
    assert.equal(names[0], 'iam_001_core.sql');
    assert.ok(names.includes(IAM_BASELINE));
    assert.equal(names.at(-1), 'iam_014_entra_own_app.sql');
    for (const m of iamMigrations({ product: 'notes' }).migrations) assert.doesNotMatch(m.sql, /\{\{|\}\}|assets/, m.name);
  });

  test('Schema und Rollen werden eingesetzt; Prüfsummen hängen nicht an den Ressourcentypen', () => {
    const a = iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'folder', 'note'], leafTypes: ['note'] }).migrations;
    const core = a.find(m => m.name === 'iam_001_core.sql')!.sql;
    assert.match(core, /CREATE SCHEMA IF NOT EXISTS notes;/);
    assert.match(core, /TO notes_app, notes_sched;/);
    assert.match(a.find(m => m.name === 'iam_007_audit.sql')!.sql, /FOR ROLE notes_owner/);
    assert.match(a.find(m => m.name === 'iam_008_entra.sql')!.sql, /FOR SELECT TO notes_owner USING/);
    // Ein neuer Ressourcentyp ist ein normaler Fall: keine Migration ändert sich
    const b = iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'note'] }).migrations;
    assert.deepEqual(a.map(m => m.checksum), b.map(m => m.checksum));
    const c = iamMigrations({ product: 'notes', schema: 'other' }).migrations;
    assert.notEqual(a[0]!.checksum, c[0]!.checksum);
  });

  test('Bedingungen zu Ressourcentypen und Blättern (Form wie PostgreSQL sie ausgibt)', () => {
    assert.deepEqual(aclChecks({ resourceTypes: ['tenant', 'folder', 'note'], leafTypes: ['note'] }), {
      acl_entry_resource_type_check: { sql: "CHECK (resource_type IN ('tenant', 'folder', 'note'))", def: "CHECK ((resource_type = ANY (ARRAY['tenant'::text, 'folder'::text, 'note'::text])))" },
      acl_entry_grant_resource_check: { sql: "CHECK (effect <> 'grant' OR resource_type <> 'note')", def: "CHECK (((effect <> 'grant'::text) OR (resource_type <> 'note'::text)))" },
    });
    assert.match(aclChecks({ resourceTypes: ['tenant', 'a', 'b'], leafTypes: ['a', 'b'] }).acl_entry_grant_resource_check!.sql, /NOT IN \('a', 'b'\)/);
    assert.equal(aclChecks({}).acl_entry_grant_resource_check, null);
    assert.deepEqual(aclChecks({}).acl_entry_resource_type_check, { sql: "CHECK (resource_type IN ('tenant'))", def: "CHECK ((resource_type = 'tenant'::text))" });
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
    assert.throws(() => iamMigrations({ product: 'notes', resourceTypes: ['note'] }), /tenant/);
    assert.throws(() => aclChecks({ resourceTypes: ['tenant', "x')"] }), /ungültig/);
    assert.throws(() => iamMigrations({ product: 'notes', resourceTypes: ['tenant', "x')"] }), /ungültig/);
    assert.throws(() => iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'note'], leafTypes: ['tenant'] }), /leafTypes/);
    assert.throws(() => iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'note'], leafTypes: ['folder'] }), /leafTypes/);
    assert.throws(() => iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'note', 'note'] }), /doppelt/);
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
    assert.deepEqual(again, { applied: [], adopted: [], skipped: 15 });
    const log: string[] = [];
    await migrate(t.adminUrl, [iamMigrations({ product: 'notes' }), extra], m => log.push(m));
    assert.deepEqual(log, [], 'Abgleich ohne Änderung meldet nichts');
  });

  test('nur als Besitzer-Rolle des Produkts', async () => {
    await assert.rejects(migrate(t.runtimeUrl, [iamMigrations({ product: 'notes' })]), /laufen als notes_owner, nicht als notes_runtime/);
  });

  test('Ressourcentypen ändern sich mit dem Katalog: Abgleich ohne neue Migration, zweiter Lauf ohne Änderung', async () => {
    const def = async () => Object.fromEntries((await t.inspect.query<{ n: string; d: string }>(
      "SELECT conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'notes.acl_entry'::regclass AND conname LIKE 'acl_entry_%_check' AND conname <> 'acl_entry_principal_type_check' AND conname <> 'acl_entry_effect_check'")).rows.map(r => [r.n, r.d]));
    assert.deepEqual(await def(), { acl_entry_resource_type_check: "CHECK ((resource_type = 'tenant'::text))" });
    const log: string[] = [];
    const wider = { product: 'notes', resourceTypes: ['tenant', 'folder', 'note'], leafTypes: ['folder', 'note'] };
    const r = await migrate(t.adminUrl, [iamMigrations(wider), extra], m => log.push(m));
    assert.deepEqual(r.applied, []);
    assert.deepEqual(log, ['Bedingung acl_entry_resource_type_check an den Katalog angepasst', 'Bedingung acl_entry_grant_resource_check an den Katalog angepasst']);
    const want = aclChecks(wider);
    assert.deepEqual(await def(), { acl_entry_resource_type_check: want.acl_entry_resource_type_check!.def, acl_entry_grant_resource_check: want.acl_entry_grant_resource_check!.def });
    const again: string[] = [];
    await migrate(t.adminUrl, [iamMigrations(wider), extra], m => again.push(m));
    assert.deepEqual(again, []);
    // Typ entfernen, der noch verwendet wird: Abbruch mit Hinweis, Bedingung bleibt
    const id = (await t.runtime.query<{ id: string }>("SELECT app.resolve_tenant('alpha', null, 'alpha', true) AS id")).rows[0]!.id;
    await t.inspect.query("INSERT INTO notes.acl_entry (tenant_id, resource_type, resource_id, principal_type, principal_ref, permission, effect) VALUES ($1, 'folder', gen_random_uuid(), 'role', 'r', 'note:read', 'deny')", [id]);
    await assert.rejects(migrate(t.adminUrl, [iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'note'], leafTypes: ['note'] }), extra]), /acl_entry_resource_type_check lässt sich nicht an den Katalog anpassen/);
    assert.equal((await def()).acl_entry_resource_type_check, want.acl_entry_resource_type_check!.def);
    await t.inspect.query("DELETE FROM notes.acl_entry WHERE resource_type = 'folder'");
    // Ohne Blätter verschwindet die Bedingung zu Freigaben
    await migrate(t.adminUrl, [iamMigrations({ product: 'notes' }), extra]);
    assert.deepEqual(await def(), { acl_entry_resource_type_check: "CHECK ((resource_type = 'tenant'::text))" });
  });

  test('iam_009: eigene Rollen mit Primärschlüssel (tenant_id, id)', async () => {
    const pk = (await t.inspect.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'tenant_role_pkey'")).rows[0].d;
    assert.equal(pk, 'PRIMARY KEY (tenant_id, id)');
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
  /** Objekte aus «eigenen» Migrationen der App (wie Assets 001–049): die IAM-Migrationen unter anderem Namen, dazu die Marke. */
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
    assert.deepEqual(r.applied, ['iam_009_tenant_role_key.sql', 'iam_010_revoke_public_execute.sql', 'iam_011_resolve_tenant_strict.sql', 'iam_012_acl_unique.sql', 'iam_013_entra_consent_link.sql', 'iam_014_entra_own_app.sql']);
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
    const needs = migration('050_needs_iam_009.sql', "SELECT 1 / (SELECT count(*)::int FROM pg_constraint WHERE conname = 'tenant_role_pkey' AND pg_get_constraintdef(oid) = 'PRIMARY KEY (tenant_id, id)');");
    const app = own('notes');
    const fresh = productDb({ iam: false, sources: [{ ...app, migrations: [...app.migrations, needs] }, iamMigrations({ product: 'notes', adopted: { after: '049_tenant_roles.sql' } })] });
    const f = await fresh.create();
    try {
      const order = (await f.inspect.query<{ name: string }>('SELECT name FROM public.schema_migrations ORDER BY applied_at, name')).rows.map(r => r.name);
      assert.deepEqual(order.slice(-7), ['iam_009_tenant_role_key.sql', 'iam_010_revoke_public_execute.sql', 'iam_011_resolve_tenant_strict.sql', 'iam_012_acl_unique.sql', 'iam_013_entra_consent_link.sql', 'iam_014_entra_own_app.sql', '050_needs_iam_009.sql']);
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
    const r = await migrate(t.adminUrl, [iam]);
    assert.deepEqual(r.applied, ['iam_012_acl_unique.sql', 'iam_013_entra_consent_link.sql', 'iam_014_entra_own_app.sql']);
    const left = (await t.inspect.query<{ id: string }>('SELECT id FROM notes.acl_entry ORDER BY created_at, id')).rows.map(x => x.id);
    assert.deepEqual(left.sort(), [ids[0]!, ids[3]!, ids[4]!].sort(), 'ein Duplikat bleibt (das älteste), andere Wirkung und Rolle bleiben');
    await assert.rejects(withTenant(t.runtime, { tenantId: A }, tx => insert(tx)), (e: { code?: string }) => e.code === '23505');
    assert.equal((await t.inspect.query("SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'notes.acl_entry'::regclass")).rows[0].f, true, 'FORCE RLS wieder an');
  });
});

describe('Übernahme späterer IAM-Migrationen (adopted.map, Assets bis 053)', { skip }, () => {
  /** Stand wie Assets bis 053: Grundlage unter eigenem Namen, Marke 049, dann 051–053 = iam_010–012. */
  const assetsLike = (product = 'notes'): MigrationSource => {
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
    const db = productDb({ iam: false, sources: [assetsLike()] });
    const [old, t] = [await db.create(), await db.create()];
    try {
      // ohne Zuordnung: iam_012 scheitert am bestehenden Index (der Befund, der die Umstellung von Assets blockierte)
      await assert.rejects(migrate(old.adminUrl, [assetsLike(), iamMigrations({ product: 'notes', adopted: { after: '049_tenant_roles.sql' } })]), /iam_012_acl_unique\.sql fehlgeschlagen: .*already exists/);
      const r = await migrate(t.adminUrl, [assetsLike(), iamMigrations({ product: 'notes', adopted: ASSETS_ADOPTION })]);
      assert.deepEqual(r.applied, ['iam_009_tenant_role_key.sql', 'iam_013_entra_consent_link.sql', 'iam_014_entra_own_app.sql']);
      assert.deepEqual(r.adopted, [...iamMigrations({ product: 'notes' }).migrations.filter(m => m.name <= IAM_BASELINE).map(m => m.name),
        'iam_010_revoke_public_execute.sql', 'iam_011_resolve_tenant_strict.sql', 'iam_012_acl_unique.sql']);
      assert.deepEqual(diffSnapshots(await schemaSnapshot(full.inspect, 'notes'), await schemaSnapshot(t.inspect, 'notes')), []);
      const again = await migrate(t.adminUrl, [assetsLike(), iamMigrations({ product: 'notes', adopted: ASSETS_ADOPTION })]);
      assert.deepEqual([again.applied, again.adopted], [[], []]);
    } finally { await old.drop(); await t.drop(); }
  });

  test('frische Datenbank wie Assets: App bis 053, dann Übernahme und iam_009; Schema wie frische Anlage', async () => {
    const db = productDb({ iam: false, sources: [assetsLike(), iamMigrations({ product: 'notes', adopted: ASSETS_ADOPTION })] });
    const f = await db.create();
    try {
      const rows = (await f.inspect.query<{ name: string }>("SELECT name FROM public.schema_migrations WHERE name LIKE 'iam_%' ORDER BY name")).rows.map(r => r.name);
      assert.deepEqual(rows, iamMigrations({ product: 'notes' }).migrations.map(m => m.name));
      assert.deepEqual(diffSnapshots(await schemaSnapshot(full.inspect, 'notes'), await schemaSnapshot(f.inspect, 'notes')), []);
    } finally { await f.drop(); }
  });

  /** Assets-Stand mit veränderter Migration 051, 052 oder 053 (unvollständig nachgebaut): Übernahme bricht ab. */
  const broken = async (file: string, edit: (sql: string) => string, message: RegExp) => {
    const base = assetsLike();
    const src = { ...base, migrations: base.migrations.map(m => (m.name === file ? migration(m.name, edit(m.sql)) : m)) };
    const b = await productDb({ iam: false, sources: [src] }).create();
    try {
      await assert.rejects(migrate(b.adminUrl, [src, iamMigrations({ product: 'notes', adopted: ASSETS_ADOPTION })]), (e: Error) => { assert.match(e.message, message); return true; });
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
    // Stand vor iam_011 (Funktion aus iam_005 bzw. Assets vor 052): 052 ändert nichts
    await broken('052_resolve_tenant_strict.sql', () => 'SELECT 1;', /app\.resolve_tenant (findet einen Mandanten über einen ungültigen Alias|legt einen Mandanten mit der Organisations-ID|bindet die Organisations-ID)/);
  });

  test('Zuordnung ohne angewendete Migration der App oder ohne Objekte: Abbruch, nichts eingetragen', async () => {
    const base = assetsLike();
    // 053 fehlt als Migration, die Marke after ist 052: Zuordnung verlangt 053
    const short = productDb({ iam: false, sources: [{ ...base, migrations: base.migrations.slice(0, -1) }] });
    const s = await short.create();
    try {
      await assert.rejects(migrate(s.adminUrl, [iamMigrations({ product: 'notes', adopted: { ...ASSETS_ADOPTION, after: '052_resolve_tenant_strict.sql' } })]), (e: Error) => {
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

