// Testdatei für test/db-skip.test.ts: vier Datenbank-Tests (auch test.only, test.todo) mit Hook über `dbTests(await postgresSkip())`, ein Test ohne
import { test as plain } from 'node:test';
import { dbTests, postgresSkip } from '../../src/index.ts';

const { describe, test, before } = dbTests(await postgresSkip());
describe('mit Datenbank', () => {
  before(() => { throw new Error('Hook läuft ohne Datenbank'); });
  test('braucht PostgreSQL', () => { throw new Error('läuft ohne Datenbank'); });
  describe('innen', () => { test('auch', { timeout: 1000 }, () => { throw new Error('läuft ohne Datenbank'); }); });
  test.only('only', () => { throw new Error('läuft ohne Datenbank'); });
  test.todo('todo', () => { throw new Error('läuft ohne Datenbank'); });
});
plain('ohne Datenbank', () => {});
