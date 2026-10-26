/**
 * Migrationen der Plattform: frisch in fester Reihenfolge (IAM, Plattform, App) und Übernahme bei einer App, die
 * Warteschlange, Idempotenz und Outbox schon aus eigenen Migrationen hat – nur in der Endform (ohne `sched_all`).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { render } from '@vollholz/iam';
import { PLATFORM_MIGRATIONS_DIR } from '../src/index.ts';
import { createTestDb, skipDb } from './harness.ts';

const skip = await skipDb();
const core = render(readFileSync(join(PLATFORM_MIGRATIONS_DIR, 'platform_001_core.sql'), 'utf8'), { schema: 'probe', app: 'probe_app', sched: 'probe_sched' });

/** Ordner mit Migrationen einer bestehenden App (`files`) und der Marke für die Übernahme. */
function legacy(files: Record<string, string>, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  writeFileSync(join(dir, 'adopted.txt'), after);
  return dir;
}

const applied = async (t: Awaited<ReturnType<typeof createTestDb>>) =>
  (await t.inspect.query<{ name: string }>('SELECT name FROM public.schema_migrations ORDER BY applied_at, name')).rows.map(r => r.name);

describe('Migrationen der Plattform', { skip }, () => {
  test('frisch: IAM, dann Plattform, dann App', async () => {
    const t = await createTestDb();
    try {
      const names = await applied(t);
      const iamLast = Math.max(...names.map((n, i) => (n.startsWith('iam_') ? i : -1)));
      assert.ok(iamLast < names.indexOf('platform_001_core.sql'));
      assert.ok(names.indexOf('platform_001_core.sql') < names.indexOf('001_notiz.sql'));
    } finally { await t.drop(); }
  });

  test('Übernahme: bestehende Objekte in Endform werden eingetragen, nicht ausgeführt', async () => {
    // Wie nachtschicht: Kern zuerst mit sched_all (001), später aufgeteilt (004)
    const old = core.replace(/CREATE POLICY sched_read ON probe\.job[^;]*;\nCREATE POLICY sched_write ON probe\.job[^;]*;/s, 'CREATE POLICY sched_all ON probe.job TO probe_sched USING (true) WITH CHECK (true);');
    assert.notEqual(old, core);
    const split = `DROP POLICY sched_all ON probe.job;
CREATE POLICY sched_read ON probe.job FOR SELECT TO probe_sched USING (true);
CREATE POLICY sched_write ON probe.job TO probe_sched
  USING (app.tenant_id() IS NULL OR tenant_id = app.tenant_id()) WITH CHECK (app.tenant_id() IS NULL OR tenant_id = app.tenant_id());`;
    const t = await createTestDb({ migrationsDir: legacy({ '001_core.sql': old, '002_split.sql': split }, '002_split.sql') });
    try {
      const names = await applied(t);
      assert.ok(names.includes('platform_001_core.sql'));
      assert.ok(names.indexOf('002_split.sql') < names.indexOf('platform_001_core.sql'));
    } finally { await t.drop(); }
  });

  test('Übernahme verweigert, solange der Scheduler über alle Mandanten schreiben darf', async () => {
    const old = core.replace(/CREATE POLICY sched_read ON probe\.job[^;]*;\nCREATE POLICY sched_write ON probe\.job[^;]*;/s, 'CREATE POLICY sched_all ON probe.job TO probe_sched USING (true) WITH CHECK (true);');
    await assert.rejects(createTestDb({ migrationsDir: legacy({ '001_core.sql': old }, '001_core.sql') }), /Policy sched_all auf probe\.job besteht noch/);
  });
});
