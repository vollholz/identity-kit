/**
 * Mandanten verwalten (aus Assets test/platform/ops.test.ts, «Mandant sperren» und «Mandant umhängen»): anlegen,
 * sperren und entsperren mit Wirkung auf die Anmeldung, an eine andere Keycloak-Organisation hängen (Daten und
 * Personen bleiben, idempotent, protokolliert), Alias nur ASCII klein geschrieben.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { pgAudit } from '../src/audit.ts';
import { createTenant, findTenant, listTenants, relinkTenant, setTenantStatus } from '../src/tenants.ts';
import { skipDb } from './support/db.ts';
import { claims, notesApp, notesDb, type NotesApp } from './support/http.ts';

const skip = await skipDb();
const ctx = { schema: 'notes', audit: pgAudit({ schema: 'notes' }) };

describe('Mandanten verwalten', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp;
  const actions = async (tenantId: string) => (await t.inspect.query('SELECT action FROM notes.audit_log WHERE tenant_id = $1 ORDER BY seq', [tenantId])).rows.map(x => x.action);

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    n = await notesApp({ db: t.runtime, issuer: idp.issuer });
  });
  after(async () => { await n?.app.close(); await idp?.close(); await t?.drop(); });

  test('anlegen, sperren (keine Anmeldung), entsperren; protokolliert; mit Besitzer-Rolle wie mit der Laufzeit', async () => {
    const tn = await createTenant(ctx, t.admin, t.runtime, 'sperre', 'Sperre AG');
    assert.deepEqual([tn.alias, tn.name, tn.status], ['sperre', 'Sperre AG', 'active']);
    const me = async () => (await n.app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${await idp.token(claims.user({ org: 'sperre' }))}` } })).statusCode;
    assert.equal(await me(), 200);
    // Mit `resolver` im Kontext vergisst setTenantStatus den Mandanten selbst (Wirkung sofort in dieser Instanz)
    const live = { ...ctx, resolver: n.iam.resolver };
    const suspended = await setTenantStatus(live, t.admin, t.runtime, 'sperre', 'suspended', 'Test');
    assert.equal(suspended.status, 'suspended');
    assert.equal(await me(), 403, 'gesperrt: keine Anmeldung');
    await setTenantStatus(live, t.runtime, t.runtime, 'sperre', 'active', '', { principal: null, source: 'api', correlationId: 'req-1', data: { platformAdmin: true } });
    assert.equal(await me(), 200);
    assert.equal((await setTenantStatus(live, t.admin, t.runtime, 'sperre', 'active', 'nochmals')).status, 'active');
    assert.deepEqual(await actions(tn.id), ['tenant.provisioned', 'tenant.suspended', 'tenant.resumed'], 'gleicher Status: kein Eintrag');
    const resumed = (await t.inspect.query("SELECT correlation_id, data FROM notes.audit_log WHERE tenant_id = $1 AND action = 'tenant.resumed'", [tn.id])).rows[0];
    assert.deepEqual([resumed.correlation_id, resumed.data.platformAdmin], ['req-1', true]);
    await assert.rejects(setTenantStatus(ctx, t.admin, t.runtime, 'unbekannt', 'suspended'), /nicht gefunden/);
  });

  test('Protokoll scheitert: kein Mandant angelegt, Status unverändert (eine Transaktion)', async () => {
    const broken = { schema: 'notes', audit: { write: async () => { throw new Error('Protokoll nicht erreichbar'); } } };
    await assert.rejects(createTenant(broken, t.admin, t.runtime, 'waise', 'Waise AG'), /Protokoll nicht erreichbar/);
    assert.equal(await findTenant(t.runtime, 'waise'), null, 'Alias nicht verwaist belegt');
    const tn = await createTenant(ctx, t.admin, t.runtime, 'waise', 'Waise AG');
    assert.equal(tn.status, 'active', 'erneuter Versuch geht');
    await assert.rejects(setTenantStatus(broken, t.admin, t.runtime, 'waise', 'suspended', 'Test'), /Protokoll nicht erreichbar/);
    assert.equal((await findTenant(t.runtime, 'waise'))!.status, 'active', 'Status zurückgerollt');
    assert.deepEqual(await actions(tn.id), ['tenant.provisioned']);
  });

  test('auflisten über alle Mandanten; finden nur nach ASCII-Alias (Kelvin-Zeichen trifft nicht)', async () => {
    await createTenant(ctx, t.admin, t.runtime, 'kcme');
    assert.ok((await listTenants(t.runtime)).some(x => x.alias === 'kcme'), 'Laufzeit sieht alle über app.platform_tenants()');
    assert.equal((await findTenant(t.runtime, 'KCME'))?.alias, 'kcme', 'ASCII-Grossschreibung');
    assert.equal(await findTenant(t.runtime, 'Kcme'), null, 'Kelvin-Zeichen ist kein «k»');
  });

  test('umhängen: neue Organisations-ID, Daten und Personen bleiben, idempotent, protokolliert', async () => {
    const alt = '11111111-1111-4111-8111-111111111111', neu = '22222222-2222-4222-8222-222222222222';
    const tn = await createTenant(ctx, t.admin, t.runtime, 'umzug', 'Umzug AG', alt);
    const resolve = async (org: string) => (await t.inspect.query("SELECT app.resolve_tenant('umzug', $1, 'Umzug AG', false) AS id", [org])).rows[0].id;
    assert.equal(await resolve(alt), tn.id);
    assert.equal(await resolve(neu), null, 'fremde ID vor dem Umhängen abgewiesen');
    const altSub = randomUUID(), neuSub = randomUUID();
    const pid = (await t.inspect.query("INSERT INTO notes.principal (tenant_id, kind, subject, display_name, email) VALUES ($1, 'user', $2, 'Person', 'Person@Example.ch') RETURNING id", [tn.id, altSub])).rows[0].id;
    const r = await relinkTenant(ctx, t.admin, t.runtime, 'umzug', neu, { 'person@example.ch': neuSub });
    assert.deepEqual([r.changed, r.principals, r.id], [true, 1, tn.id]);
    assert.equal(await resolve(neu), tn.id);
    assert.equal(await resolve(alt), null, 'alte ID danach abgewiesen');
    assert.deepEqual((await t.inspect.query('SELECT id, subject FROM notes.principal WHERE tenant_id = $1', [tn.id])).rows, [{ id: pid, subject: neuSub }], 'gleiche Person, neues Subjekt');
    assert.equal((await relinkTenant(ctx, t.admin, t.runtime, 'umzug', neu, { 'person@example.ch': neuSub })).changed, false);
    await createTenant(ctx, t.admin, t.runtime, 'andere', 'Andere AG', '33333333-3333-4333-8333-333333333333');
    await assert.rejects(relinkTenant(ctx, t.admin, t.runtime, 'umzug', '33333333-3333-4333-8333-333333333333'), /gehört schon/);
    await assert.rejects(relinkTenant(ctx, t.admin, t.runtime, 'umzug', 'keine-uuid'), /UUID/);
    await assert.rejects(relinkTenant(ctx, t.admin, t.runtime, 'umzug', neu, { 'keine-mail': neuSub }), /E-Mail=Benutzer-ID/);
    const log = (await t.inspect.query("SELECT data FROM notes.audit_log WHERE tenant_id = $1 AND action = 'tenant.relinked'", [tn.id])).rows;
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].data.from, log[0].data.to, log[0].data.principals], [alt, neu, [{ email: 'person@example.ch', from: altSub, to: neuSub }]]);
    // E-Mail nur ASCII klein verglichen: «Kim@…» mit Kelvin-Zeichen (U+212A) ist nicht «kim@…»
    const kimSub = randomUUID();
    await t.inspect.query("INSERT INTO notes.principal (tenant_id, kind, subject, display_name, email) VALUES ($1, 'user', $2, 'Kim', 'Kim@Example.ch')", [tn.id, kimSub]);
    assert.equal((await relinkTenant(ctx, t.admin, t.runtime, 'umzug', neu, { '\u212Aim@example.ch': randomUUID() })).principals, 0, 'Kelvin-Zeichen trifft nicht');
    assert.equal((await relinkTenant(ctx, t.admin, t.runtime, 'umzug', neu, { 'KIM@EXAMPLE.CH': randomUUID() })).principals, 1, 'ASCII-Grossschreibung trifft');
    await assert.rejects(createTenant(ctx, t.admin, t.runtime, 'umzug', 'Umzug AG', alt), /anderen Keycloak-Organisation/);
  });
});
