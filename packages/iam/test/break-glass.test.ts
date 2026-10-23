/**
 * Break-Glass (Spezifikation Kap. 7.8, 9.7; Pflichttest `break-glass` in Kap. 14): nur Personen mit direktem Tupel
 * `org-admin` an org (nicht über Gruppen, nie Clients, nie über MCP), 1–240 Minuten, Begründung Pflicht, Neubeginn,
 * Ende (auch ohne aktives), Ablauf im Worker, wirkt sofort auf Lesesicht und `can`, gibt keine Rechte, nur im eigenen
 * Mandanten; Audit `break_glass.started` und `break_glass.ended`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { pgAudit } from '../src/audit.ts';
import { expireAccess } from '../src/sync.ts';
import { skipDb } from './support/db.ts';
import { claims, folderWithNote, grant, grantClient, member, notesApp, notesDb, tenant, withRole, type NotesApp } from './support/http.ts';

const skip = await skipDb();
type Res = { status: number; body: any };
const G = '3f1c2a9e-7b4d-4e8a-9c1f-0a2b3c4d5e6f';

describe('Break-Glass', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  const tok: Record<string, string> = {};
  const pid: Record<string, string> = {};
  let A = '', B = '', secret = '';

  async function call(who: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const r = await n.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${tok[who]}`, ...headers }, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }
  const ok = (r: Res, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const audit = async (action: string, tenantId = A) => (await t.inspect.query<{ data: any; resource_id: string }>(
    'SELECT data, resource_id::text FROM notes.audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY seq', [tenantId, action])).rows;
  const start = (who: string, minutes = 30, reason = 'Prüfung eines Vorfalls') => call(who, 'POST', '/v1/break-glass', { reason, minutes });

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    n = await notesApp({ db: t.runtime, issuer: idp.issuer });
    A = await tenant(t.runtime, 'acme'); B = await tenant(t.runtime, 'globex');
    const pool = t.runtime;
    const anna = await withRole(pool, claims.user({ org: 'acme', name: 'Anna Admin' }), 'org-admin');
    tok.anna = await idp.token(anna);
    pid.anna = await member(pool, 'acme', anna.sub, 'org-admin');
    tok.eda = await idp.token(await withRole(pool, claims.user({ org: 'acme', name: 'Eda Editor' }), 'editor'));
    // org-admin nur über eine Gruppe aus Entra: zählt für Break-Glass nicht (nur direktes Tupel)
    tok.grp = await idp.token({ ...await withRole(pool, claims.user({ org: 'acme', name: 'Gina Gruppe', groups: [G] }), null) });
    await grant(pool, A, `group:${G}`, 'org-admin');
    // Person in zwei Organisationen: org-admin in acme und globex
    const both = await withRole(pool, claims.user({ org: ['acme', 'globex'], name: 'Doris Doppel' }), 'org-admin');
    tok.both = await idp.token(both);
    pid.bothA = await member(pool, 'acme', both.sub); pid.bothB = await member(pool, 'globex', both.sub);
    tok.mcp = await idp.token({ ...anna, azp: 'notes-mcp', scope: 'notes:read notes:write' });
    await grantClient(pool, A, 'import', 'editor');
    tok.client = await idp.token(claims.client({ clientId: 'import', org: 'acme', scopes: ['notes:read', 'notes:write'] }));
    secret = (await folderWithNote(pool, A, 'Geheim', { classification: 2 })).note;
    await folderWithNote(pool, A, 'Offen');
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('nur Personen mit direktem Tupel org-admin an org; nie Gruppen, Clients oder MCP', async () => {
    assert.equal((await start('eda')).status, 403, 'editor');
    assert.equal((await start('grp')).status, 403, 'org-admin nur über eine Gruppe');
    assert.ok(ok(await call('grp', 'GET', '/v1/me')).roles.includes('org-admin'), 'die Gruppe gibt die Rolle (aber kein Break-Glass)');
    assert.equal((await start('client')).status, 403, 'Client');
    assert.equal((await start('mcp')).status, 403, 'MCP (scope-gebunden)');
    for (const who of ['eda', 'grp', 'client', 'mcp']) assert.equal((await call(who, 'DELETE', '/v1/break-glass')).status, 403, `${who}: beenden`);
    assert.equal((await audit('break_glass.started')).length, 0);
  });

  test('Eingaben: Begründung 1–500 Zeichen (nicht nur Leerzeichen), 1–240 Minuten', async () => {
    for (const [body, why] of [
      [{ reason: '', minutes: 10 }, 'leer'], [{ reason: '   ', minutes: 10 }, 'nur Leerzeichen'], [{ reason: 'x'.repeat(501), minutes: 10 }, 'zu lang'],
      [{ reason: 'ok', minutes: 0 }, '0 min'], [{ reason: 'ok', minutes: 241 }, '241 min'], [{ reason: 'ok', minutes: 1.5 }, 'keine ganze Zahl'],
      [{ reason: 'ok' }, 'ohne Dauer'], [{ reason: 'ok', minutes: 10, clearance: 2 }, 'unbekanntes Feld'],
    ] as [Record<string, unknown>, string][]) assert.equal((await call('anna', 'POST', '/v1/break-glass', body)).status, 422, why);
    assert.equal((await audit('break_glass.started')).length, 0);
  });

  test('starten: Stufe 2 bis zum Ende, sofort in Entscheidung und Lesesicht; gibt keine Rechte; Audit', async () => {
    const before = ok(await call('anna', 'GET', '/v1/me'));
    assert.deepEqual([before.clearance, before.breakGlassUntil], [0, null]);
    assert.equal((await call('anna', 'GET', `/v1/notes/${secret}`)).status, 403, 'org-admin scheitert an der Klassifizierung');
    assert.equal(ok(await call('anna', 'GET', '/v1/notes')).items.length, 1, 'Lesesicht ohne die geheime Notiz');
    const t0 = Date.now();
    const r = ok(await start('anna', 30));
    assert.equal(r.clearance, 2);
    const until = Date.parse(r.until);
    assert.ok(Math.abs(until - (t0 + 30 * 60_000)) < 60_000, r.until);
    const me = ok(await call('anna', 'GET', '/v1/me'));
    assert.deepEqual([me.clearance, Date.parse(me.breakGlassUntil)], [2, until]);
    assert.equal(ok(await call('anna', 'GET', `/v1/notes/${secret}`)).id, secret);
    assert.equal(ok(await call('anna', 'GET', '/v1/notes')).items.length, 2, 'Lesesicht = can');
    assert.deepEqual(me.permissions, before.permissions, 'keine neuen Rechte');
    const row = (await t.inspect.query('SELECT clearance, clearance_boost FROM notes.principal WHERE id = $1', [pid.anna])).rows[0];
    assert.deepEqual(row, { clearance: 0, clearance_boost: 2 }, 'gespeicherte Stufe unverändert');
    const a = (await audit('break_glass.started')).at(-1)!;
    assert.deepEqual([a.resource_id, a.data.reason, a.data.until], [pid.anna, 'Prüfung eines Vorfalls', new Date(until).toISOString()]);
  });

  test('neuer Aufruf beginnt neu ab jetzt (eigener Eintrag), keine Verlängerung sonst; beenden setzt zurück', async () => {
    const first = Date.parse(ok(await call('anna', 'GET', '/v1/me')).breakGlassUntil);
    const r = ok(await start('anna', 5, 'Neubeginn'));
    assert.ok(Date.parse(r.until) < first, 'neu ab jetzt, auch kürzer');
    assert.equal((await audit('break_glass.started')).length, 2);
    assert.equal((await call('anna', 'DELETE', '/v1/break-glass')).status, 204);
    const me = ok(await call('anna', 'GET', '/v1/me'));
    assert.deepEqual([me.clearance, me.breakGlassUntil], [0, null]);
    assert.equal((await call('anna', 'GET', `/v1/notes/${secret}`)).status, 403, 'sofort wieder ohne');
    assert.deepEqual((await audit('break_glass.ended')).map(x => x.data.expired), [false]);
    assert.equal((await call('anna', 'DELETE', '/v1/break-glass')).status, 204, 'auch ohne aktives');
    assert.equal((await audit('break_glass.ended')).length, 1, 'ohne aktives kein Eintrag');
  });

  test('Ablauf: zählt nicht mehr, der Worker setzt zurück (break_glass.ended mit expired)', async () => {
    ok(await start('anna', 1));
    await t.inspect.query("UPDATE notes.principal SET clearance_until = now() - interval '1 second' WHERE id = $1", [pid.anna]);
    n.iam.access.invalidate(A);
    const me = ok(await call('anna', 'GET', '/v1/me'));
    assert.deepEqual([me.clearance, me.breakGlassUntil], [0, null], 'abgelaufen zählt nicht');
    assert.equal((await call('anna', 'GET', `/v1/notes/${secret}`)).status, 403);
    assert.deepEqual(await expireAccess({ schema: 'notes', audit: pgAudit({ schema: 'notes' }) }, t.runtime, A), { expired: 0, breakGlassEnded: 1 });
    assert.deepEqual((await audit('break_glass.ended')).at(-1)!.data, { expired: true });
    assert.deepEqual((await t.inspect.query('SELECT clearance_boost, clearance_until FROM notes.principal WHERE id = $1', [pid.anna])).rows[0], { clearance_boost: null, clearance_until: null });
  });

  test('Mandantentrennung: Break-Glass gilt nur in der gewählten Organisation', async () => {
    ok(await call('both', 'POST', '/v1/break-glass', { reason: 'nur acme', minutes: 10 }, { 'x-tenant': 'acme' }));
    assert.equal(ok(await call('both', 'GET', '/v1/me', undefined, { 'x-tenant': 'acme' })).clearance, 2);
    const g = ok(await call('both', 'GET', '/v1/me', undefined, { 'x-tenant': 'globex' }));
    assert.deepEqual([g.clearance, g.breakGlassUntil], [0, null], 'globex unberührt');
    assert.equal((await t.inspect.query('SELECT clearance_boost FROM notes.principal WHERE id = $1', [pid.bothB])).rows[0].clearance_boost, null);
    assert.equal((await audit('break_glass.started', B)).length, 0);
    assert.equal((await call('both', 'DELETE', '/v1/break-glass', undefined, { 'x-tenant': 'globex' })).status, 204);
    assert.equal(ok(await call('both', 'GET', '/v1/me', undefined, { 'x-tenant': 'acme' })).clearance, 2, 'Beenden in globex beendet acme nicht');
    assert.equal((await call('both', 'DELETE', '/v1/break-glass', undefined, { 'x-tenant': 'acme' })).status, 204);
  });
});
