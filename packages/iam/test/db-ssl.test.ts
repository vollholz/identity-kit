/**
 * TLS zur Datenbank nach `DATABASE_SSL` auch für Verbindungen ausserhalb des Pools: Migrationen (`migrate`), Einrichtung
 * und Zurücksetzen. Gegen einen Server ohne TLS zeigt `require`, dass die Einstellung ankommt (pg verlangt dann TLS).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dbSslFromEnv, pgSsl } from '../src/db.ts';
import { migrate } from '../src/migrations.ts';
import { skipDb } from './support/db.ts';
import { notesDb } from './support/http.ts';

const skip = await skipDb();

describe('DATABASE_SSL', () => {
  test('pgSsl und dbSslFromEnv: Werte wie in der Konfiguration, Standard disable, unbekannt → Fehler', () => {
    assert.equal(pgSsl('disable'), false);
    assert.equal(pgSsl(undefined), false);
    assert.deepEqual(pgSsl('require'), { rejectUnauthorized: false });
    assert.deepEqual(pgSsl('verify-full'), { rejectUnauthorized: true });
    assert.equal(dbSslFromEnv({}), 'disable');
    assert.equal(dbSslFromEnv({ DATABASE_SSL: 'verify-full' }), 'verify-full');
    assert.throws(() => dbSslFromEnv({ DATABASE_SSL: 'on' }), /DATABASE_SSL «on» ungültig/);
  });

  test('migrate verbindet mit TLS nach ssl; ohne Angabe wie bisher ohne', { skip }, async () => {
    const t = await notesDb().create();
    try {
      const on = (await t.inspect.query<{ ssl: string }>('SHOW ssl')).rows[0]!.ssl === 'on';
      const r = await migrate(t.adminUrl, [], { ssl: 'disable' });
      assert.deepEqual(r, { applied: [], adopted: [], skipped: 0 });
      assert.deepEqual(await migrate(t.adminUrl, [], () => undefined), r, 'bisherige Form: log als Funktion');
      if (on) assert.deepEqual(await migrate(t.adminUrl, [], { ssl: 'require' }), r);
      else await assert.rejects(migrate(t.adminUrl, [], { ssl: 'require' }), /does not support SSL/);
    } finally { await t.drop(); }
  });
});
