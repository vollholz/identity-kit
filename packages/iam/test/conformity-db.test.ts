/**
 * Konformitätstest, Ebene Datenbank (`dbChecks` aus dem Test-Kit), gegen eine Datenbank mit den Migrationen dieses
 * Pakets: frisch migriert konform bis auf die fehlende erste Organisation; Organisation ohne org-admin, eigene Tabelle
 * ohne Mandantentrennung, Laufzeit als Besitzerin und fehlende Migration werden gemeldet.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { dbChecks, kitMigrationNames, type Finding } from '@vollholz/iam-testkit';
import { productDb, skipDb } from './support/db.ts';
import { notesModel } from './support/models.ts';

const skip = await skipDb();
const kitMigrations = readdirSync(join(import.meta.dirname, '..', 'migrations')).filter(f => f.endsWith('.sql')).sort();
const failed = (f: Finding[]) => f.filter(x => x.status === 'fail').map(x => `${x.check}: ${x.details.join('; ')}`);

describe('Konformität: Datenbank', { skip }, () => {
  const db = productDb({ model: notesModel });
  let t: Awaited<ReturnType<typeof db.create>>;
  let owner: pg.Client;
  before(async () => {
    t = await db.create();
    owner = new pg.Client({ connectionString: t.adminUrl });
    await owner.connect();
  });
  after(async () => { await owner?.end(); await t?.drop(); });
  const run = (o: Partial<Parameters<typeof dbChecks>[1]> = {}) => dbChecks(owner, { ident: 'notes', schema: 'notes', kitMigrations, ...o });

  test('frisch migriert: alles konform, nur die erste Organisation fehlt', async () => {
    assert.deepEqual(failed(await run()), ['Jede Organisation hat einen org-admin: keine aktive Organisation in notes.tenant (erste Organisation: npx iam-org-bootstrap --manifest identity.app.json)']);
  });

  test('Organisation ohne org-admin gemeldet; mit gültigem org-admin konform; abgelaufen oder entfernt zählt nicht', async () => {
    const id = (await t.inspect.query<{ id: string }>("SELECT app.resolve_tenant('demo', 'kc-demo', 'Demo', true) AS id")).rows[0]!.id;
    assert.match(failed(await run()).join(), /Organisation demo: kein org-admin/);
    const p = (await t.inspect.query<{ id: string }>("INSERT INTO notes.principal (tenant_id, kind, subject, display_name) VALUES ($1, 'user', 'u-anna', 'Anna') RETURNING id", [id])).rows[0]!.id;
    await t.inspect.query("INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type, expires_at) VALUES ($1, $2, 'org-admin', 'org', now() - interval '1 minute')", [id, `user:${p}`]);
    assert.match(failed(await run()).join(), /Organisation demo: kein org-admin/, 'abgelaufen');
    await t.inspect.query('UPDATE notes.authz_tuple SET expires_at = NULL WHERE tenant_id = $1', [id]);
    await t.inspect.query('UPDATE notes.principal SET removed_at = now() WHERE id = $1', [p]);
    assert.match(failed(await run()).join(), /Organisation demo: kein org-admin/, 'entfernt');
    await t.inspect.query('UPDATE notes.principal SET removed_at = NULL WHERE id = $1', [p]);
    assert.deepEqual(failed(await run()), []);
  });

  test('Verstösse: Tabelle ohne Mandantentrennung, Laufzeit besitzt Objekte, Migration fehlt, unbegründete SECURITY-DEFINER-Funktion', async () => {
    await t.inspect.query('CREATE TABLE notes.notiz (id uuid PRIMARY KEY, text text)');
    await t.inspect.query('GRANT SELECT ON notes.notiz TO notes_app');
    await t.inspect.query('CREATE TABLE notes.eigen (id int) ; ALTER TABLE notes.eigen OWNER TO notes_runtime');
    await t.inspect.query("CREATE FUNCTION notes.alle() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = notes, pg_temp AS 'SELECT 1'; REVOKE EXECUTE ON FUNCTION notes.alle() FROM PUBLIC");
    try {
      const f = failed(await run({ kitMigrations: [...kitMigrations, 'iam_999_neu.sql'] })).join('\n');
      assert.match(f, /notes\.notiz \(notes_app\): ohne Mandantentrennung/);
      assert.match(f, /notes\.eigen gehört notes_runtime/);
      assert.match(f, /iam_999_neu\.sql nicht angewendet/);
      assert.match(f, /notes\.alle\(\): SECURITY DEFINER ohne Begründung/);
      const excused = failed(await run({ exceptions: { withoutTenant: { 'notes.notiz': 'Stammdaten ohne Mandant' }, securityDefiner: { 'notes.alle()': 'Zählung über alle Mandanten' } } })).join('\n');
      assert.doesNotMatch(excused, /notiz|alle\(\)/);
    } finally {
      await t.inspect.query('DROP TABLE notes.notiz, notes.eigen; DROP FUNCTION notes.alle()');
    }
  });

  test('erwartete Migrationen aus dem installierten Paket', () => {
    // Im Repository ist @vollholz/iam ein Workspace-Link auf dieses Paket
    assert.deepEqual(kitMigrationNames(join(import.meta.dirname, '..', '..', '..')), kitMigrations);
  });
});
