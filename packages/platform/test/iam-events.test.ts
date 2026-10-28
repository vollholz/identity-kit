/**
 * Haken der App an den Baukasten (`AppSpec.iamEvents`): `createApi` gibt sie an `createIam`; Ereignisse landen in der
 * Outbox der App in derselben Transaktion wie die Änderung (Rezept aus der Doku von `iamEvents`).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { withTenant } from '@vollholz/iam';
import { app as probe } from './fixture/app.ts';
import { login, person, testApi, type TestApi } from './api.ts';
import { skipDb } from './harness.ts';

const skip = await skipDb();

describe('Ereignisse des Baukastens an die App', { skip }, () => {
  let api: TestApi;
  before(async () => { api = await testApi(); });
  after(async () => { await api?.close(); });

  test('iamEvents erreicht createIam; Rolle vergeben schreibt iam.access.granted in die Outbox, zurückgerollt nichts', async () => {
    assert.equal(api.iam.events, probe.iamEvents);
    const { tenantId } = await login(api, 'demo', 'u-admin', 'org-admin');
    const pid = await person(api, tenantId, 'u-neu');
    await withTenant(api.t.runtime, { tenantId }, tx => api.iam.tuples.grant(tx, { subject: `user:${pid}`, relation: 'viewer', place: { type: 'org' } }));
    await assert.rejects(withTenant(api.t.runtime, { tenantId }, async tx => {
      await api.iam.tuples.grant(tx, { subject: `user:${pid}`, relation: 'editor', place: { type: 'org' } });
      throw new Error('Abbruch');
    }));
    const rows = (await api.t.inspect.query<{ type: string; subject: string; data: any }>('SELECT type, subject, data FROM probe.outbox_event WHERE subject = $1 ORDER BY created_at', [`user:${pid}`])).rows;
    assert.deepEqual(rows.map(r => [r.type, r.data.relation, r.data.type]), [['iam.access.granted', 'viewer', 'org']]);
  });
});
