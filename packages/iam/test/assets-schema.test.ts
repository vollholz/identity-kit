/**
 * Gleichheitstest (Entwurf Kap. 6.4): Die IAM-Migrationen ergeben mit den Parametern von Assets genau die IAM-Objekte,
 * die Assets aus seinen Migrationen 001–053 hat (Abzug test/fixtures/assets-schema.json, erzeugt mit
 * scripts/assets-schema.ts). Entsprechungen: iam_001 … IAM_BASELINE = Assets 001–049 (übernommen, `adopted`),
 * iam_010 = Assets 051, iam_011 = Assets 052, iam_012 = Assets 053. iam_009 gibt es in Assets nicht; sie läuft dort in Phase 2 normal.
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

/** IAM-Migrationen mit Entsprechung in Assets (bis 053). */
const IN_ASSETS = (name: string) => name <= IAM_BASELINE || ['iam_010_', 'iam_011_', 'iam_012_'].some(p => name.startsWith(p));

/** Objekte von Assets auf IAM-Tabellen, die zur App gehören: Suche im Personenverzeichnis (pg_trgm, Assets 014). */
const APP_OWNED: [string, string][] = [['principal', 'principal_email_trgm'], ['principal', 'principal_name_trgm']];

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'assets-schema.json'), 'utf8')) as { source: string; snapshot: SchemaSnapshot };
const skip = await skipDb();

describe(`Gleichheit mit Assets (${fixture.source})`, { skip }, () => {
  // Grundlage mit dem Abgleich der Ressourcentypen (wie der Runner ihn nach den IAM-Migrationen ausführt)
  const iam = iamMigrations(ASSETS);
  const db = productDb({ product: 'assets', iam: false, sources: [{ ...iam, migrations: iam.migrations.filter(m => IN_ASSETS(m.name)) }] });
  let t: Awaited<ReturnType<typeof db.create>>;
  before(async () => { t = await db.create(); });
  after(async () => { await t?.drop(); });

  test('Abzug deckt alle IAM-Tabellen und -Funktionen ab', () => {
    for (const [k, v] of Object.entries(fixture.snapshot.tables)) assert.ok(v, `Tabelle ${k} fehlt im Abzug von Assets`);
    for (const [k, v] of Object.entries(fixture.snapshot.functions)) assert.equal((v as unknown[]).length, 1, `Funktion app.${k} im Abzug von Assets`);
  });

  test('Entsprechungen: genau iam_001 … IAM_BASELINE, iam_010, iam_011, iam_012', () => {
    assert.deepEqual(iam.migrations.filter(m => IN_ASSETS(m.name)).map(m => m.name.slice(0, 7)), ['iam_001', 'iam_002', 'iam_003', 'iam_004', 'iam_005', 'iam_006', 'iam_007', 'iam_008', 'iam_010', 'iam_011', 'iam_012']);
  });

  test(`iam_001 … ${IAM_BASELINE}, iam_010, iam_011, iam_012 = Assets 001–053`, async () => {
    const expected = structuredClone(fixture.snapshot) as SchemaSnapshot & { tables: Record<string, { indexes: Record<string, string> }> };
    for (const [table, index] of APP_OWNED) delete expected.tables[table]!.indexes[index];
    const actual = await schemaSnapshot(t.inspect as pg.ClientBase, 'assets');
    assert.deepEqual(diffSnapshots(actual, expected), []);
  });
});
