/**
 * Mandantentrennung direkt in PostgreSQL mit den IAM-Migrationen (ohne API; aus Assets test/platform/rls.test.ts, IAM-Teil,
 * und iam-kit.test.ts): die Datenbank selbst muss Fremdzugriffe verhindern, auch wenn die Anwendung einen Fehler hätte.
 * Neue Tabellen, Policies oder Ausnahmen kommen mit Begründung hierher – sonst schlägt der Test fehl.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import {
  bypassRoleProblems, grantedTableProblems, publicExecuteProblems, publicSchemaProblems, securityDefinerProblems, tenantTableProblems,
} from '@vollholz/iam-testkit';
import { withTenant } from '../src/db.ts';
import { productDb, skipDb } from './support/db.ts';

const skip = await skipDb();

/** Tabellen ohne tenant_id, auf die Laufzeit oder Worker Rechte haben – jede mit Begründung. */
const WITHOUT_TENANT: Record<string, string> = {
  'notes.tenant': 'Mandantenzeile selbst: RLS mit tenant_self (nur der eigene Mandant), Schreiben nur name und settings',
  'notes.session': 'Sitzungen der Oberfläche (BFF): verschlüsselt, Zugriff nur über die zufällige Sitzungs-ID',
  'notes.rate_limit': 'Zähler des Rate-Limits je Route und Schlüssel, keine Mandantendaten',
  'notes.replay_guard': 'Replay-Schutz (DPoP-Proofs, Logout-Tokens), nur Schlüssel und Ablauf',
};

/** Policies ausser tenant_isolation (die gilt überall gleich), so wie PostgreSQL sie ausgibt. */
const POLICIES = [
  'notes.tenant.tenant_self PERMISSIVE ALL notes_app USING (id = app.tenant_id()) CHECK (id = app.tenant_id())',
  // Besitzer-Funktionen (SECURITY DEFINER), die über alle Mandanten lesen; die Variable setzt nur die Funktion selbst
  "notes.entra_connection.entra_scan PERMISSIVE SELECT notes_owner USING (current_setting('app.entra_scan'::text, true) = 'on'::text) CHECK -",
];

/** SECURITY-DEFINER-Funktionen mit Begründung. */
const SECURITY_DEFINER: Record<string, string> = {
  'app.resolve_tenant(p_alias text, p_kc_org_id text, p_name text, p_create boolean)': 'Mandant auflösen, bevor der Kontext gesetzt ist; liefert nur die ID',
  'app.bump_acl_version()': 'Trigger: Version des Mandanten nach Änderung an Zugriffsregeln und eigenen Rollen',
  'app.suspended_tenants()': 'Worker: gesperrte Mandanten ohne Kontext',
  'app.platform_tenants()': 'Plattform-Administration: Mandanten aller Organisationen (API prüft platform-admin)',
  'app.set_tenant_status(p_id uuid, p_status text)': 'Plattform-Administration: sperren und entsperren',
  'app.entra_login_alias(p_domain text)': 'Resolver: Anbieter einer gebundenen Domäne, nie der Mandant',
  'app.entra_free_slot(p_max integer)': 'Entra: kleinster freier Platz',
  'app.entra_domains_taken(p_domains text[])': 'Entra: Domänen anderer Mandanten, ohne sie zu nennen',
};

const PUBLIC_EXEC = "EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')";
const norm = (sql: string | null) => (sql === null ? '-' : sql.replace(/\s+/g, ' ').trim());

describe('PostgreSQL RLS (IAM)', { skip }, () => {
  const db = productDb({ resourceTypes: ['tenant', 'note'], leafTypes: ['note'] });
  let t: Awaited<ReturnType<typeof db.create>>;
  let A: string, B: string;

  before(async () => {
    t = await db.create();
    const r = async (alias: string) => (await t.runtime.query<{ id: string }>('SELECT app.resolve_tenant($1, null, $1, true) AS id', [alias])).rows[0]!.id;
    A = await r('alpha'); B = await r('beta');
    await withTenant(t.runtime, { tenantId: A }, async tx => {
      await tx.query("INSERT INTO notes.principal (tenant_id, kind, subject, display_name) VALUES ($1, 'user', 'u-a', 'Anna')", [A]);
      await tx.query("INSERT INTO notes.client_grant (tenant_id, client_id) VALUES ($1, 'export')", [A]);
      await tx.query("INSERT INTO notes.acl_entry (tenant_id, resource_type, principal_type, principal_ref, permission) VALUES ($1, 'tenant', 'role', 'editor', 'note:read')", [A]);
    });
  });
  after(async () => { await t?.drop(); });

  test('Prüfungen des Test-Kits: Mandantentabellen, Rechte, SECURITY DEFINER, PUBLIC, Rollen', async () => {
    assert.deepEqual(await tenantTableProblems(t.inspect, { appRole: 'notes_app', minTables: 9 }), []);
    assert.deepEqual(await grantedTableProblems(t.inspect, { roles: ['notes_app', 'notes_sched'], minTables: 13, withoutTenant: WITHOUT_TENANT }), []);
    assert.deepEqual(await securityDefinerProblems(t.inspect, { allowed: SECURITY_DEFINER }), []);
    assert.deepEqual(await publicSchemaProblems(t.inspect, { schemas: ['app', 'notes'] }), []);
    assert.deepEqual(await publicExecuteProblems(t.inspect, { schemas: ['app', 'notes'], strict: true }), []);
    assert.deepEqual(await bypassRoleProblems(t.inspect, { rolePrefix: 'notes_' }), []);
  });

  test('Policies: für notes_app nur tenant_isolation und tenant_self, alle übrigen wie aufgeführt', async () => {
    const rows = (await t.inspect.query<{ s: string; t: string; n: string; p: string; c: string; r: string[]; q: string | null; w: string | null }>(
      'SELECT schemaname AS s, tablename AS t, policyname AS n, permissive AS p, cmd AS c, roles::text[] AS r, qual AS q, with_check AS w FROM pg_policies WHERE schemaname = $1', ['notes'])).rows;
    const other = rows.filter(x => x.n !== 'tenant_isolation').map(x => `${x.s}.${x.t}.${x.n} ${x.p} ${x.c} ${x.r.join(',')} USING ${norm(x.q)} CHECK ${norm(x.w)}`).sort();
    assert.deepEqual(other, [...POLICIES].sort());
  });

  test('neue Funktionen der Besitzer-Rolle sind nicht für PUBLIC ausführbar', async () => {
    await t.admin.query('BEGIN');
    try {
      await t.admin.query("CREATE FUNCTION app.rls_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'");
      await t.admin.query("CREATE FUNCTION notes.rls_probe() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = notes, pg_temp AS 'SELECT 1'");
      const probes = (await t.admin.query<{ f: string; pub: boolean }>(`SELECT p.pronamespace::regnamespace || '.' || p.proname AS f, ${PUBLIC_EXEC} AS pub FROM pg_proc p WHERE p.proname = 'rls_probe' ORDER BY 1`)).rows;
      assert.deepEqual(probes, [{ f: 'app.rls_probe', pub: false }, { f: 'notes.rls_probe', pub: false }]);
    } finally { await t.admin.query('ROLLBACK'); }
  });

  test('keine Funktion in app und notes für PUBLIC ausführbar (iam_010); Laufzeit-Rollen nur mit ausdrücklichem EXECUTE', async () => {
    const rows = (await t.inspect.query<{ f: string; pub: boolean; app: boolean; sched: boolean }>(`
      SELECT p.oid::regprocedure::text AS f, ${PUBLIC_EXEC} AS pub,
             has_function_privilege('notes_app', p.oid, 'EXECUTE') AS app, has_function_privilege('notes_sched', p.oid, 'EXECUTE') AS sched
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('app', 'notes') ORDER BY 1`)).rows;
    assert.ok(rows.length >= 13, `nur ${rows.length} Funktionen gefunden`);
    assert.deepEqual(rows.filter(r => r.pub).map(r => r.f), []);
    // Bis iam_010 nur über PUBLIC: Prüfung der Audit-Kette und app.audit_chain() im Trigger
    assert.deepEqual(rows.filter(r => r.f.startsWith('app.audit_hash(')).map(r => [r.app, r.sched]), [[true, true]]);
    assert.deepEqual(rows.filter(r => /^app\.(tenant_id|principal_id)\(/.test(r.f)).map(r => [r.app, r.sched]), [[true, true], [true, true]]);
    assert.deepEqual(rows.filter(r => r.f.startsWith('app.secure_tenant_tables(')).map(r => [r.app, r.sched]), [[false, false]]);
  });

  test('auch die Besitzer-Rolle sieht ohne Kontext keine Mandantendaten (FORCE RLS)', async () => {
    for (const tbl of ['principal', 'client_grant', 'acl_entry']) assert.equal((await t.admin.query(`SELECT count(*)::int AS n FROM notes.${tbl}`)).rows[0].n, 0, tbl);
  });

  test('ohne Mandantenkontext sind keine Zeilen sichtbar', async () => {
    assert.equal((await t.runtime.query('SELECT count(*)::int AS n FROM notes.principal')).rows[0].n, 0);
    assert.equal((await t.runtime.query('SELECT count(*)::int AS n FROM notes.tenant')).rows[0].n, 0);
    await assert.rejects(t.runtime.query("INSERT INTO notes.client_grant (tenant_id, client_id) VALUES ($1, 'x')", [A]), /row-level security/);
  });

  test('Mandant B sieht keine Daten von A und kann keine für A schreiben', async () => {
    await withTenant(t.runtime, { tenantId: B }, async tx => {
      for (const tbl of ['principal', 'client_grant', 'acl_entry']) assert.equal((await tx.query(`SELECT count(*)::int AS n FROM notes.${tbl}`)).rows[0].n, 0, tbl);
      assert.deepEqual((await tx.query('SELECT alias FROM notes.tenant')).rows, [{ alias: 'beta' }]);
      assert.equal((await tx.query("UPDATE notes.principal SET display_name = 'gehackt' WHERE subject = 'u-a'")).rowCount, 0);
      assert.equal((await tx.query("UPDATE notes.tenant SET name = 'gehackt' WHERE id = $1", [A])).rowCount, 0);
    });
    await assert.rejects(withTenant(t.runtime, { tenantId: B }, tx =>
      tx.query("INSERT INTO notes.acl_entry (tenant_id, resource_type, principal_type, principal_ref, permission) VALUES ($1, 'tenant', 'role', 'x', 'note:read')", [A])), /row-level security/);
    // Mandantenzeile: nur Name und Einstellungen schreibbar
    await assert.rejects(withTenant(t.runtime, { tenantId: B }, tx => tx.query("UPDATE notes.tenant SET status = 'active' WHERE id = $1", [B])), /permission denied/);
  });

  test('Kontext gilt nur innerhalb der Transaktion (set_config lokal)', async () => {
    const c = await t.runtime.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      await c.query('COMMIT');
      assert.equal((await c.query('SELECT count(*)::int AS n FROM notes.principal')).rows[0].n, 0);
    } finally { c.release(); }
  });

  test('Zugriffsregeln: Freigabe nie auf einem Blatt, Ressource leer genau beim Mandanten, nur bekannte Typen', async () => {
    const ins = (type: string, id: string | null, effect: string) => withTenant(t.runtime, { tenantId: A }, tx => tx.query(
      "INSERT INTO notes.acl_entry (tenant_id, resource_type, resource_id, principal_type, principal_ref, permission, effect) VALUES ($1, $2, $3, 'role', 'editor', 'note:read', $4)", [A, type, id, effect]));
    const id = '00000000-0000-4000-8000-000000000001';
    await assert.rejects(ins('note', id, 'grant'), /acl_entry_grant_resource_check/);
    await assert.rejects(ins('tenant', id, 'deny'), /acl_entry_check/);
    await assert.rejects(ins('schema', id, 'deny'), /acl_entry_resource_type_check/);
    await assert.rejects(ins('tenant', null, 'allow'), /acl_entry_effect_check/);
    await ins('note', id, 'deny');
  });

  test('Änderungen an Zugriffsregeln und eigenen Rollen erhöhen acl_version', async () => {
    const v = async () => Number((await withTenant(t.runtime, { tenantId: A }, tx => tx.query('SELECT acl_version FROM notes.tenant'))).rows[0].acl_version);
    const v0 = await v();
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query("INSERT INTO notes.tenant_role (tenant_id, key, label, permissions) VALUES ($1, 'c-leser', 'Leser', '{note:read}')", [A]));
    const v1 = await v();
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query("DELETE FROM notes.acl_entry WHERE permission = 'note:read' AND effect = 'deny'"));
    assert.ok(v1 > v0 && (await v()) > v1);
  });

  test('Audit-Log ist unveränderlich und verkettet', async () => {
    await withTenant(t.runtime, { tenantId: A }, async tx => {
      for (const action of ['a.one', 'a.two', 'a.three']) {
        await tx.query("INSERT INTO notes.audit_log (tenant_id, actor_kind, source, action) VALUES ($1, 'system', 'system', $2)", [A, action]);
      }
    });
    await assert.rejects(withTenant(t.runtime, { tenantId: A }, tx => tx.query("UPDATE notes.audit_log SET action = 'x'")), /permission denied/);
    await assert.rejects(withTenant(t.runtime, { tenantId: A }, tx => tx.query('DELETE FROM notes.audit_log')), /permission denied/);
    await assert.rejects(withTenant(t.runtime, { tenantId: A }, tx => tx.query('DELETE FROM notes.audit_anchor')), /permission denied/);
    const rows = (await t.inspect.query<{ prev_hash: Buffer | null; hash: Buffer }>('SELECT prev_hash, hash FROM notes.audit_log WHERE tenant_id = $1 ORDER BY seq', [A])).rows;
    assert.equal(rows.length, 3);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i]!.prev_hash!.equals(rows[i - 1]!.hash), `Kette bei Eintrag ${i}`);
  });

  test('Audit-Kette bleibt bei gleichzeitigen Transaktionen lückenlos und in seq-Reihenfolge verkettet', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => withTenant(t.runtime, { tenantId: B }, async tx => {
      await tx.query("INSERT INTO notes.audit_log (tenant_id, actor_kind, source, action) VALUES ($1, 'system', 'system', $2)", [B, `parallel.${i}`]);
      await new Promise(r => setTimeout(r, (i * 7) % 15));
    })));
    const rows = (await t.inspect.query<{ seq: string; ok: boolean; linked: boolean }>(`
      SELECT seq, hash = app.audit_hash(prev_hash, l) AS ok, prev_hash IS NOT DISTINCT FROM lag(hash) OVER (ORDER BY seq) AS linked
        FROM notes.audit_log l WHERE tenant_id = $1 ORDER BY seq`, [B])).rows;
    assert.equal(rows.length, 20);
    rows.forEach((r, i) => { assert.equal(Number(r.seq), i + 1); assert.ok(r.ok && r.linked, `seq ${r.seq}`); });
  });

  test('Mandanten-Auflösung: Bindung an die ID der Organisation, gesperrt, unbekannt ohne Auto-Provisionierung', async () => {
    const resolve = async (alias: string, kc: string | null, create = true) => (await t.runtime.query<{ id: string | null }>('SELECT app.resolve_tenant($1, $2, $1, $3) AS id', [alias, kc, create])).rows[0]!.id;
    assert.equal(await resolve('gamma', null, false), null);
    // Erster Kontakt mit ID bindet; dieselbe ID passt, eine andere (neue Organisation mit altem Alias) nie
    const d = await resolve('delta', 'kc-1');
    assert.ok(d);
    assert.equal(await resolve('delta', 'kc-1'), d);
    assert.equal(await resolve('delta', null), d);
    assert.equal(await resolve('delta', 'kc-2'), null);
    // Eine ID, die schon ein anderer Mandant trägt, wird nicht ein zweites Mal gebunden
    assert.equal(await resolve('alpha', 'kc-1'), A);
    assert.equal((await t.inspect.query('SELECT kc_org_id FROM notes.tenant WHERE id = $1', [A])).rows[0].kc_org_id, null);
    // Grossbuchstaben im Alias (ASCII) treffen denselben Mandanten
    assert.equal(await resolve('ALPHA', null), A);
    await t.inspect.query("UPDATE notes.tenant SET status = 'suspended' WHERE alias = 'beta'");
    assert.equal(await resolve('beta', null), null);
    // Gesperrte Mandanten sieht nur der Worker (Rolle sched), nicht die API
    await assert.rejects(t.runtime.query('SELECT app.suspended_tenants()'), /permission denied/);
    const worker = new pg.Client({ connectionString: t.workerUrl });
    await worker.connect();
    try { assert.deepEqual((await worker.query('SELECT app.suspended_tenants() AS s')).rows[0].s, [B]); } finally { await worker.end(); }
    await t.inspect.query("UPDATE notes.tenant SET status = 'active' WHERE alias = 'beta'");
  });

  test('Plattform-Funktionen: Status nur gültig, unbekannter Mandant ist ein Fehler', async () => {
    await assert.rejects(t.runtime.query("SELECT app.set_tenant_status($1, 'deleted')", [A]), /ungültig/);
    await assert.rejects(t.runtime.query("SELECT app.set_tenant_status('00000000-0000-4000-8000-000000000009', 'suspended')"), /nicht gefunden/);
    const all = (await t.runtime.query<{ alias: string }>('SELECT alias FROM app.platform_tenants()')).rows.map(r => r.alias);
    assert.ok(all.includes('alpha') && all.includes('beta'));
  });

  test('Entra: Domänen anderer Mandanten nur mit Kontext, Alias nur bei «Nur Entra» und aktivem Mandanten', async () => {
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query(
      "INSERT INTO notes.entra_connection (tenant_id, entra_tenant_id, idp_alias, domains, stage) VALUES ($1, gen_random_uuid(), 'entra-001', '{alpha.ch}', 'enforced')", [A]));
    const q = async (sql: string, p: unknown[] = []) => (await t.runtime.query(sql, p)).rows[0];
    assert.equal((await q("SELECT app.entra_login_alias('ALPHA.ch') AS a")).a, 'entra-001');
    assert.equal((await q("SELECT app.entra_login_alias('beta.ch') AS a")).a, null);
    assert.equal((await q('SELECT app.entra_free_slot(5) AS s')).s, 'entra-002');
    assert.equal((await q("SELECT app.entra_domains_taken('{alpha.ch}') AS d")).d, null);
    assert.deepEqual(await withTenant(t.runtime, { tenantId: B }, async tx => (await tx.query("SELECT app.entra_domains_taken('{alpha.ch,beta.ch}') AS d")).rows[0].d), ['alpha.ch']);
    assert.deepEqual(await withTenant(t.runtime, { tenantId: A }, async tx => (await tx.query("SELECT app.entra_domains_taken('{alpha.ch}') AS d")).rows[0].d), []);
    // Die Variable der Funktionen öffnet der Laufzeit nichts
    assert.equal(await withTenant(t.runtime, { tenantId: B, settings: { 'app.entra_scan': 'on' } }, async tx => (await tx.query('SELECT count(*)::int AS n FROM notes.entra_connection')).rows[0].n), 0);
  });
});
