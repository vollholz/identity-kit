/**
 * Audit der Plattform: `record` mit betroffener Person (`subject`, iam_021) und `platform.auditSearch` mit dem Rückfall
 * der App (`audit.subjectFallback`). Suche, Seiten und Policy prüft @vollholz/iam (test/audit.test.ts).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { definePlatform, systemActor, type Actor } from '../src/index.ts';
import { model } from './fixture/model.ts';
import { resources } from './fixture/resources.ts';
import { createTestDb, full, skipDb, tenant, type Harness } from './harness.ts';

const skip = await skipDb();
const P = '33333333-3333-4333-8333-333333333333', X = 'bbbbbbbb-0000-4000-8000-000000000001';
const who: Actor = { principal: { kind: 'user', principalId: P, name: 'Lea', clientId: null }, source: 'ui', correlationId: 'req-a' };
const FROM = new Date('2000-01-01T00:00:00Z'), TO = new Date('2100-01-01T00:00:00Z');

describe('Audit: record mit subject, platform.auditSearch', { skip }, () => {
  const platform = definePlatform({ product: 'probe', title: 'Probe', model, resources, audit: { subjectFallback: { dataKeys: ['personId'] } } });
  let t: Harness;
  let A: string;
  before(async () => { t = await createTestDb(); A = await tenant(t.runtime, 'audit-a'); });
  after(async () => { await t?.drop(); });

  test('record ohne subject wie bisher, mit subject in subject_id; Suche findet beide über Person und Rückfall', async () => {
    await full(t.runtime, A, async tx => {
      await platform.record(tx, who, { action: 'notiz.created', resourceType: 'notiz', resourceId: X, data: { personId: 'p-1' } });
      await platform.record(tx, systemActor('worker'), { action: 'notiz.updated', resourceType: 'notiz', resourceId: X, subject: 'p-1' });
      await platform.record(tx, who, { action: 'notiz.deleted', resourceType: 'notiz', resourceId: X, subject: null });
    });
    const rows = (await full(t.runtime, A, tx => tx.query('SELECT action, subject_id FROM probe.audit_log ORDER BY seq'))).rows;
    assert.deepEqual(rows, [{ action: 'notiz.created', subject_id: null }, { action: 'notiz.updated', subject_id: 'p-1' }, { action: 'notiz.deleted', subject_id: null }]);
    const page = await full(t.runtime, A, tx => platform.auditSearch(tx, { subject: 'p-1', from: FROM, to: TO }));
    assert.deepEqual(page.items.map(x => [x.action, x.subject, x.actor.kind]), [['notiz.updated', 'p-1', 'system'], ['notiz.created', null, 'user']]);
    assert.equal(page.nextCursor, null);
    const byActor = await full(t.runtime, A, tx => platform.auditSearch(tx, { actor: P, from: FROM, to: TO, order: 'asc' }));
    assert.deepEqual(byActor.items.map(x => x.action), ['notiz.created', 'notiz.deleted']);
    const valid = (await full(t.runtime, A, tx => tx.query('SELECT bool_and(hash = app.audit_hash(prev_hash, l)) AS ok FROM probe.audit_log l'))).rows[0].ok;
    assert.equal(valid, true);
  });
});
