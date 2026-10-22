/**
 * Gleichheitstest (Entwurf Kap. 6.4): `iam_001` bis IAM_BASELINE ergeben mit den Parametern von Assets genau die
 * IAM-Objekte, die Assets aus seinen Migrationen 001–049 hat (Abzug test/fixtures/assets-schema.json, erzeugt mit
 * scripts/assets-schema.ts). Nur dann darf Assets die Migrationen übernehmen (`adopted`), ohne sie auszuführen.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { IAM_BASELINE, iamMigrations } from '../src/migrations.ts';
import { productDb, skipDb } from './support/db.ts';
import { diffSnapshots, schemaSnapshot, type SchemaSnapshot } from '../src/schema.ts';

/** Parameter von Assets (Katalog: Ressourcentypen und Blatt der Kette). */
export const ASSETS = { product: 'assets', resourceTypes: ['tenant', 'schema', 'type', 'object', 'connection', 'credential'], leafTypes: ['object'] };

/** Objekte von Assets auf IAM-Tabellen, die zur App gehören: Suche im Personenverzeichnis (pg_trgm, Assets 014). */
const APP_OWNED: [string, string][] = [['principal', 'principal_email_trgm'], ['principal', 'principal_name_trgm']];

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'assets-schema.json'), 'utf8')) as { source: string; snapshot: SchemaSnapshot };
const skip = await skipDb();

describe(`Gleichheit mit Assets (${fixture.source})`, { skip }, () => {
  // Grundlage mit dem Abgleich der Ressourcentypen (wie der Runner ihn nach den IAM-Migrationen ausführt)
  const iam = iamMigrations(ASSETS);
  const db = productDb({ product: 'assets', iam: false, sources: [{ ...iam, migrations: iam.migrations.filter(m => m.name <= IAM_BASELINE) }] });
  let t: Awaited<ReturnType<typeof db.create>>;
  before(async () => { t = await db.create(); });
  after(async () => { await t?.drop(); });

  test('Abzug deckt alle IAM-Tabellen und -Funktionen ab', () => {
    for (const [k, v] of Object.entries(fixture.snapshot.tables)) assert.ok(v, `Tabelle ${k} fehlt im Abzug von Assets`);
    for (const [k, v] of Object.entries(fixture.snapshot.functions)) assert.equal((v as unknown[]).length, 1, `Funktion app.${k} im Abzug von Assets`);
  });

  test(`iam_001 … ${IAM_BASELINE} = Assets 001–049`, async () => {
    const expected = structuredClone(fixture.snapshot) as SchemaSnapshot & { tables: Record<string, { indexes: Record<string, string> }> };
    for (const [table, index] of APP_OWNED) delete expected.tables[table]!.indexes[index];
    const actual = await schemaSnapshot(t.inspect as pg.ClientBase, 'assets');
    assert.deepEqual(diffSnapshots(actual, expected), []);
  });
});
