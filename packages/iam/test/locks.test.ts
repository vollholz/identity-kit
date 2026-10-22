/**
 * Sperren als Vertrag (Auflage 6): Werte fest, und die Datenbank-Seite nimmt wirklich dieselbe Sperre – eine gehaltene
 * Sperre hält Migrations-Runner bzw. Audit-Kette auf, bis sie frei wird.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { withTenant } from '../src/db.ts';
import { LOCKS, lockKey } from '../src/locks.ts';
import { iamMigrations, migrate } from '../src/migrations.ts';
import { productDb, skipDb } from './support/db.ts';

const skip = await skipDb();

test('Werte der Sperren (gleich wie Assets, nie ändern)', () => {
  assert.deepEqual(LOCKS, { migrate: 727001, memberSync: 727016 });
  assert.equal(lockKey.audit('t1'), 'audit:t1');
  // wie NEW.tenant_id::text im Trigger: UUID immer klein
  assert.equal(lockKey.audit('0F0E-AB'), 'audit:0f0e-ab');
  assert.equal(lockKey.admin('acme'), 'admin:acme');
  assert.equal(lockKey.peopleSync('t1'), 'people-sync:t1');
  assert.equal(lockKey.entraPlatform(), 'entra:platform');
});

/** Läuft `p` erst, nachdem `release` die Sperre freigibt? */
async function waitsFor<T>(p: Promise<T>, release: () => Promise<unknown>): Promise<T> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(done, false, 'läuft trotz gehaltener Sperre');
  await release();
  return p;
}

describe('Sperren in PostgreSQL', { skip }, () => {
  const db = productDb();
  let t: Awaited<ReturnType<typeof db.create>>;
  let holder: pg.Client;
  before(async () => { t = await db.create(); holder = new pg.Client({ connectionString: t.adminUrl }); await holder.connect(); });
  after(async () => { await holder?.end(); await t?.drop(); });

  test('Migrations-Runner wartet auf LOCKS.migrate', async () => {
    await holder.query('SELECT pg_advisory_lock($1)', [LOCKS.migrate]);
    const r = await waitsFor(migrate(t.adminUrl, [iamMigrations({ product: 'notes' })]), () => holder.query('SELECT pg_advisory_unlock($1)', [LOCKS.migrate]));
    assert.equal(r.applied.length, 0);
  });

  test('Audit-Kette nimmt lockKey.audit(<tenant>) (geteilt mit der Outbox einer App)', async () => {
    const id = (await t.runtime.query<{ id: string }>("SELECT app.resolve_tenant('alpha', null, 'alpha', true) AS id")).rows[0]!.id;
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey.audit(id)]);
    await waitsFor(withTenant(t.runtime, { tenantId: id }, tx => tx.query("INSERT INTO notes.audit_log (tenant_id, actor_kind, source, action) VALUES ($1, 'system', 'system', 'x')", [id])),
      () => holder.query('COMMIT'));
  });
});
