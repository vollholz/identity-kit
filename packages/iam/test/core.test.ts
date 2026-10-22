/**
 * Verschlüsselung, Fehlerformat, geteilter Zustand, Datenbank-Kontext und Audit.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { pgAudit } from '../src/audit.ts';
import { box, NoEncryptionKeyError, primaryKey, Sealer, unbox, validateKeyring } from '../src/crypto.ts';
import { schemaName, setContext, withTenant, withTx } from '../src/db.ts';
import { HttpError, invalid, problemBody } from '../src/errors.ts';
import { MemoryReplayStore, PgReplayStore, pgRateLimitStore, purgeSharedState } from '../src/state.ts';
import { productDb, skipDb } from './support/db.ts';

const skip = await skipDb();
const k = (id: string) => ({ id, key: randomBytes(32) });

describe('Verschlüsselung', () => {
  test('box/unbox: Rundweg, falsche AAD, Manipulation', () => {
    const key = randomBytes(32);
    const sealed = box(key, 'geheim', 'tenant:1');
    assert.equal(unbox(key, sealed, 'tenant:1').toString(), 'geheim');
    assert.throws(() => unbox(key, sealed, 'tenant:2'));
    sealed[sealed.length - 1]! ^= 1;
    assert.throws(() => unbox(key, sealed, 'tenant:1'));
    assert.throws(() => unbox(key, Buffer.alloc(10), 'x'), /zu kurz/);
  });

  test('Sealer: erster Schlüssel verschlüsselt, alle entschlüsseln (Rotation), Format mit Schlüssel-ID', () => {
    const k1 = k('k1'), k2 = k('k2');
    const old = new Sealer([k1]).sealString('sitzung', 'sid');
    const s = new Sealer([k2, k1]);
    assert.equal(s.openString(old, 'sid'), 'sitzung');
    const neu = s.seal('x', 'sid');
    assert.deepEqual([neu[0], neu[1], neu.subarray(2, 4).toString()], [1, 2, 'k2']);
    assert.throws(() => new Sealer([k1]).open(neu, 'sid'), /k2/);
    assert.throws(() => s.openString(old, 'andere-sid'));
    assert.throws(() => s.open(Buffer.from([9, 0]), 'sid'), /unbekanntes Format/);
    assert.throws(() => new Sealer([]), /mindestens ein Schlüssel/);
    assert.throws(() => validateKeyring([{ id: 'a.b', key: randomBytes(32) }]), /ohne Punkt/);
    assert.throws(() => primaryKey([]), NoEncryptionKeyError);
  });
});

test('Fehler nach RFC 9457', () => {
  const body = problemBody(invalid('Ungültig.', [{ path: '/a', message: 'x' }]), 'https://notes.example.ch/probleme/', '/v1/x');
  assert.deepEqual(body, { type: 'https://notes.example.ch/probleme/422', title: 'Ungültige Eingabe', status: 422, detail: 'Ungültig.', instance: '/v1/x', errors: [{ path: '/a', message: 'x' }] });
  const e = new HttpError(401, 'Nicht angemeldet', undefined, { 'WWW-Authenticate': 'Bearer' });
  assert.deepEqual(problemBody(e, 'urn:p:'), { type: 'urn:p:401', title: 'Nicht angemeldet', status: 401 });
  assert.equal(e.message, 'Nicht angemeldet');
});

test('Replay-Schutz im Speicher', async () => {
  const r = new MemoryReplayStore();
  assert.equal(await r.claim('a', 1000), true);
  assert.equal(await r.claim('a', 1000), false);
  assert.equal(await r.claim('b', 0), true);
  await new Promise(res => setTimeout(res, 5));
  assert.equal(await r.claim('b', 1000), true);
});

test('Schema nur als einfacher Bezeichner', () => {
  assert.equal(schemaName('notes'), 'notes');
  assert.throws(() => schemaName('notes; DROP TABLE x'), /ungültig/);
  assert.throws(() => new PgReplayStore(null as never, 'A'), /ungültig/);
});

describe('Datenbank: Zustand, Kontext, Audit', { skip }, () => {
  const db = productDb();
  let t: Awaited<ReturnType<typeof db.create>>;
  let A: string;
  before(async () => {
    t = await db.create();
    A = (await t.runtime.query<{ id: string }>("SELECT app.resolve_tenant('alpha', null, 'alpha', true) AS id")).rows[0]!.id;
  });
  after(async () => { await t?.drop(); });

  test('Replay-Schutz über alle Instanzen (PostgreSQL)', async () => {
    const r = new PgReplayStore(t.runtime, 'notes');
    assert.equal(await r.claim('dpop:x:1', 60_000), true);
    assert.equal(await r.claim('dpop:x:1', 60_000), false);
    assert.equal(await new PgReplayStore(t.runtime, 'notes').claim('dpop:x:1', 60_000), false);
    assert.equal(await r.claim('dpop:x:2', 1), true);
    await new Promise(res => setTimeout(res, 10));
    assert.equal(await r.claim('dpop:x:2', 60_000), true, 'abgelaufen = wieder frei');
  });

  test('Rate-Limit-Speicher: zählt je Schlüssel und Route, beginnt nach dem Fenster neu; Bereinigung', async () => {
    const Store = pgRateLimitStore(t.runtime, 'notes');
    const s = new Store();
    const incr = (st: InstanceType<typeof Store>, key: string, win: number) => new Promise<{ current: number; ttl: number }>((res, rej) => st.incr(key, (e, r) => (e ? rej(e) : res(r!)), win));
    assert.equal((await incr(s, 'p1', 60_000)).current, 1);
    const second = await incr(s, 'p1', 60_000);
    assert.equal(second.current, 2);
    assert.ok(second.ttl > 0 && second.ttl <= 60_000);
    const child = s.child({ routeInfo: { method: 'GET', url: '/v1/x' } });
    assert.equal((await incr(child, 'p1', 60_000)).current, 1);
    assert.deepEqual(await new Promise(res => s.read('p1', (_e, r) => res(r!.current))), 2);
    assert.equal((await incr(s, 'kurz', 1)).current, 1);
    await new Promise(res => setTimeout(res, 10));
    assert.equal((await incr(s, 'kurz', 60_000)).current, 1);
    await t.inspect.query("UPDATE notes.rate_limit SET reset_at = now() - interval '2 minutes' WHERE key = 'p1'");
    await t.inspect.query("UPDATE notes.replay_guard SET expires_at = now() - interval '1 second'");
    assert.ok(await purgeSharedState(t.runtime, 'notes') >= 3);
  });

  test('Kontext: Mandant, Principal und Einstellungen der App in einer Transaktion; eigene Namen geschützt', async () => {
    const got = await withTenant(t.runtime, { tenantId: A, principalId: '00000000-0000-4000-8000-000000000001', settings: { 'app.read_all': 'on' } }, async tx =>
      (await tx.query("SELECT app.tenant_id() AS t, app.principal_id() AS p, current_setting('app.read_all') AS r")).rows[0]);
    assert.deepEqual(got, { t: A, p: '00000000-0000-4000-8000-000000000001', r: 'on' });
    await assert.rejects(withTx(t.runtime, tx => setContext(tx, { tenantId: A, settings: { 'app.tenant_id': 'x' } })), /nicht erlaubt/);
    await assert.rejects(withTx(t.runtime, tx => setContext(tx, { tenantId: A, settings: { 'search_path': 'x' } })), /nicht erlaubt/);
    // Fehler in der Transaktion: zurückgerollt, Verbindung wieder frei
    await assert.rejects(withTenant(t.runtime, { tenantId: A }, async tx => { await tx.query("INSERT INTO notes.client_grant (tenant_id, client_id) VALUES ($1, 'roll')", [A]); throw new Error('Abbruch'); }), /Abbruch/);
    assert.equal(await withTenant(t.runtime, { tenantId: A }, async tx => (await tx.query("SELECT count(*)::int AS n FROM notes.client_grant WHERE client_id = 'roll'")).rows[0].n), 0);
  });

  test('pgAudit schreibt im Mandanten des Kontexts, mit Akteur, Quelle und Korrelation', async () => {
    const audit = pgAudit({ schema: 'notes' });
    await withTenant(t.runtime, { tenantId: A }, async tx => {
      await audit.write(tx, { principal: { kind: 'user', principalId: '00000000-0000-4000-8000-000000000002', name: 'Anna', clientId: 'notes-platform' }, source: 'ui', correlationId: 'req-1' }, { action: 'member.invited', resourceType: 'member', data: { email: 'a@b.ch' } });
      await audit.write(tx, { principal: null, source: 'worker' }, { action: 'people.synced' });
    });
    const rows = (await t.inspect.query('SELECT tenant_id, seq, actor_kind, actor_id, actor_name, client_id, source, action, resource_type, correlation_id, data FROM notes.audit_log WHERE tenant_id = $1 ORDER BY seq', [A])).rows;
    assert.deepEqual(rows.map(r => [Number(r.seq), r.actor_kind, r.actor_name, r.client_id, r.source, r.action, r.resource_type, r.correlation_id, r.data]), [
      [1, 'user', 'Anna', 'notes-platform', 'ui', 'member.invited', 'member', 'req-1', { email: 'a@b.ch' }],
      [2, 'system', null, null, 'worker', 'people.synced', null, null, {}],
    ]);
    // Ohne Mandantenkontext schreibt niemand ins Audit
    await assert.rejects(withTx(t.runtime, tx => audit.write(tx, { principal: null, source: 'system' }, { action: 'x' })), /null value|row-level security/);
  });
});
