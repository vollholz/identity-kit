/**
 * Erzeugt den Schema-Abzug von Assets für den Gleichheitstest (test/fixtures/assets-schema.json, Entwurf Kap. 6.4):
 * frische Datenbank, Migrationen von Assets, Abzug der IAM-Objekte.
 *
 *   node scripts/assets-schema.ts <assets>/db/migrations <commit>
 *
 * Voraussetzung: Rollen von Assets (`psql … -f <assets>/db/bootstrap.sql`, Passwort der Besitzer-Rolle in
 * ASSETS_OWNER_PASSWORD, Standard `ci-owner` wie in der CI von Assets) und der Superuser wie für die Tests
 * (POSTGRES_SUPERUSER_PASSWORD, POSTGRES_PORT oder TEST_POSTGRES_URL).
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import pg from 'pg';
import { dirMigrations, migrate } from '../src/migrations.ts';
import { schemaSnapshot } from '../test/support/schema.ts';

const [dir, commit] = process.argv.slice(2);
if (!dir || !commit) throw new Error('Aufruf: node scripts/assets-schema.ts <assets>/db/migrations <commit>');
const su = process.env.TEST_POSTGRES_URL ?? `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_SUPERUSER_PASSWORD ?? '')}@localhost:${process.env.POSTGRES_PORT ?? '5433'}/postgres`;
const db = `iam_assets_schema_${randomBytes(4).toString('hex')}`;
const withDb = (url: string, name: string) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };

const c = new pg.Client({ connectionString: su });
await c.connect();
await c.query(`CREATE DATABASE ${db} OWNER assets_owner`);
await c.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
await c.query(`GRANT CONNECT ON DATABASE ${db} TO assets_app, assets_sched`);
try {
  const owner = new URL(su);
  owner.username = 'assets_owner'; owner.password = process.env.ASSETS_OWNER_PASSWORD ?? 'ci-owner';
  const source = dirMigrations(dir);
  await migrate(withDb(owner.toString(), db), [source]);
  const inspect = new pg.Client({ connectionString: withDb(su, db) });
  await inspect.connect();
  const snapshot = await schemaSnapshot(inspect, 'assets').finally(() => inspect.end());
  const last = source.migrations.at(-1)!.name;
  const out = { source: `vollholz/assets ${commit} (${basename(dir)} bis ${last})`, snapshot };
  writeFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', 'assets-schema.json'), `${JSON.stringify(out, null, 1)}\n`);
  console.log(`Abzug geschrieben (bis ${last})`);
} finally {
  await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await c.end();
}
