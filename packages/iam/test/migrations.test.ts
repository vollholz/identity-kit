/**
 * Migrationen: Parameter und Platzhalter, Prüfsummen, Reihenfolge der Quellen, Übernahme mit Vorbedingungen
 * (Entwurf Kap. 6, Auflage 4).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { IAM_BASELINE, iamMigrations, migrate, migration, render, type MigrationSource } from '../src/migrations.ts';
import { productDb, skipDb } from './support/db.ts';

const skip = await skipDb();

describe('IAM-Migrationen: Parameter', () => {
  test('Dateien iam_001 … iam_009 in Reihenfolge, Stand der Übernahme dabei', () => {
    const names = iamMigrations({ product: 'notes' }).migrations.map(m => m.name);
    assert.deepEqual(names, [...names].sort());
    assert.equal(names[0], 'iam_001_core.sql');
    assert.ok(names.includes(IAM_BASELINE));
    assert.equal(names.at(-1), 'iam_009_tenant_role_key.sql');
    for (const m of iamMigrations({ product: 'notes' }).migrations) assert.doesNotMatch(m.sql, /\{\{|\}\}|assets/, m.name);
  });

  test('Schema, Rollen und Ressourcentypen werden eingesetzt; gleiche Parameter, gleiche Prüfsumme', () => {
    const a = iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'folder', 'note'], leafTypes: ['note'] }).migrations;
    const core = a.find(m => m.name === 'iam_001_core.sql')!.sql;
    assert.match(core, /CREATE SCHEMA IF NOT EXISTS notes;/);
    assert.match(core, /TO notes_app, notes_sched;/);
    const access = a.find(m => m.name === 'iam_004_access.sql')!.sql;
    assert.match(access, /CHECK \(resource_type IN \('tenant', 'folder', 'note'\)\)/);
    assert.match(access, /CONSTRAINT acl_entry_grant_resource_check CHECK \(effect <> 'grant' OR resource_type <> 'note'\)/);
    assert.match(a.find(m => m.name === 'iam_007_audit.sql')!.sql, /FOR ROLE notes_owner/);
    const b = iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'folder', 'note'], leafTypes: ['note'] }).migrations;
    assert.deepEqual(a.map(m => m.checksum), b.map(m => m.checksum));
    const c = iamMigrations({ product: 'notes', schema: 'other', resourceTypes: ['tenant', 'folder', 'note'], leafTypes: ['note'] }).migrations;
    assert.notEqual(a[0]!.checksum, c[0]!.checksum);
  });

  test('mehrere Blätter; ohne Blätter keine Bedingung; ohne Zugriffsregeln nur «tenant»', () => {
    const multi = iamMigrations({ product: 'notes', resourceTypes: ['tenant', 'a', 'b'], leafTypes: ['a', 'b'] }).migrations.find(m => m.name === 'iam_004_access.sql')!.sql;
    assert.match(multi, /resource_type NOT IN \('a', 'b'\)/);
    const none = iamMigrations({ product: 'notes' }).migrations.find(m => m.name === 'iam_004_access.sql')!.sql;
    assert.doesNotMatch(none, /grant_resource_check/);
    assert.match(none, /CHECK \(resource_type IN \('tenant'\)\)/);
  });

  test('ungültige Parameter brechen ab (nie roh ins SQL)', () => {
    assert.throws(() => iamMigrations({ product: 'Notes' }), /product/);
    assert.throws(() => iamMigrations({ product: 'notes', schema: 'notes; DROP' }), /schema/);
    assert.throws(() => iamMigrations({ product: 'notes', resourceTypes: ['note'] }), /tenant/);
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
    assert.deepEqual(again, { applied: [], adopted: [], skipped: 10 });
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
    assert.deepEqual(r.applied, ['iam_009_tenant_role_key.sql']);
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
