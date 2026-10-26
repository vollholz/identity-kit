/**
 * Mandantentrennung direkt in PostgreSQL mit den IAM-Migrationen (ohne API): die Datenbank selbst muss Fremdzugriffe verhindern, auch wenn die Anwendung einen Fehler hätte.
 * Neue Tabellen, Policies oder Ausnahmen kommen mit Begründung hierher – sonst schlägt der Test fehl.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import {
  bypassRoleProblems, grantedTableProblems, LATER_READ_VIEW_FUNCTIONS, publicExecuteProblems, publicSchemaProblems, readViewProblems, securityDefinerProblems, tenantTableProblems,
} from '@vollholz/iam-testkit';
import { withTenant } from '../src/db.ts';
import { productDb, skipDb } from './support/db.ts';
import { notesModel } from './support/models.ts';

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
  // Erste Organisation (iam-org-bootstrap, A20): die Besitzer-Rolle schreibt im Kontext des Mandanten
  'notes.principal.owner_tenant PERMISSIVE ALL notes_owner USING (tenant_id = app.tenant_id()) CHECK (tenant_id = app.tenant_id())',
  'notes.authz_tuple.owner_tenant PERMISSIVE ALL notes_owner USING (tenant_id = app.tenant_id()) CHECK (tenant_id = app.tenant_id())',
  'notes.audit_log.owner_tenant PERMISSIVE ALL notes_owner USING (tenant_id = app.tenant_id()) CHECK (tenant_id = app.tenant_id())',
];

/** SECURITY-DEFINER-Funktionen mit Begründung. */
const SECURITY_DEFINER: Record<string, string> = {
  'app.resolve_tenant(p_alias text, p_kc_org_id text, p_name text, p_create boolean)': 'Mandant auflösen, bevor der Kontext gesetzt ist; liefert nur die ID',
  'app.bump_acl_version()': 'Trigger: Version des Mandanten nach Änderung an Tupeln und Freigabestufen',
  'app.suspended_tenants()': 'Worker: gesperrte Mandanten ohne Kontext',
  'app.platform_tenants()': 'Plattform-Administration: Mandanten aller Organisationen (API prüft platform-admin)',
  'app.set_tenant_status(p_id uuid, p_status text)': 'Plattform-Administration: sperren und entsperren',
  'app.entra_login_alias(p_domain text)': 'Resolver: Anbieter einer gebundenen Domäne, nie der Mandant',
  'app.entra_free_slot(p_max integer)': 'Entra: kleinster freier Platz',
  'app.entra_domains_taken(p_domains text[])': 'Entra: Domänen anderer Mandanten, ohne sie zu nennen',
  'app.account_touch(p_subject text, p_email text, p_name text)': 'Konto ohne Mandant: anlegen bzw. nachführen, liefert nur die eigene ID',
  'app.account_reserve_org(p_account uuid, p_limit integer)': 'Konto: Höchstzahl selbst erstellter Organisationen (atomar)',
  'app.account_release_org(p_account uuid)': 'Konto: Reservierung zurückgeben',
  'app.platform_audit(p_actor_kind text, p_actor_id uuid, p_actor_name text, p_source text, p_action text, p_resource_type text, p_resource_id uuid, p_org uuid, p_correlation text, p_data jsonb)': 'Protokoll der Plattform: nur anhängen',
};

const PUBLIC_EXEC = "EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')";
const norm = (sql: string | null) => (sql === null ? '-' : sql.replace(/\s+/g, ' ').trim());

describe('PostgreSQL RLS (IAM)', { skip }, () => {
  const db = productDb({ model: notesModel });
  let t: Awaited<ReturnType<typeof db.create>>;
  let A: string, B: string;

  before(async () => {
    t = await db.create();
    const r = async (alias: string) => (await t.runtime.query<{ id: string }>('SELECT app.resolve_tenant($1, null, $1, true) AS id', [alias])).rows[0]!.id;
    A = await r('alpha'); B = await r('beta');
    await withTenant(t.runtime, { tenantId: A }, async tx => {
      await tx.query("INSERT INTO notes.principal (tenant_id, kind, subject, display_name) VALUES ($1, 'user', 'u-a', 'Anna')", [A]);
      await tx.query("INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type) VALUES ($1, 'org:members', 'editor', 'org')", [A]);
    });
  });
  after(async () => { await t?.drop(); });

  test('Prüfungen des Test-Kits: Mandantentabellen, Rechte, SECURITY DEFINER, PUBLIC, Rollen', async () => {
    assert.deepEqual(await tenantTableProblems(t.inspect, { appRole: 'notes_app', minTables: 8 }), []);
    assert.deepEqual(await grantedTableProblems(t.inspect, { roles: ['notes_app', 'notes_sched'], minTables: 12, withoutTenant: WITHOUT_TENANT }), []);
    assert.deepEqual(await readViewProblems(t.inspect, { schema: 'notes', appRole: 'notes_app' }), []);
    const later = (await t.inspect.query<{ f: string }>("SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = 'has_permission' ORDER BY 1")).rows.map(r => r.f);
    assert.deepEqual(later, LATER_READ_VIEW_FUNCTIONS, 'iam_018: app.has_permission besteht (das Test-Kit prüft sie nur, wenn vorhanden)');
    const tables = (await t.inspect.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'notes' ORDER BY 1")).rows.map(r => r.t);
    for (const gone of ['acl_entry', 'tenant_role', 'client_grant']) assert.ok(!tables.includes(gone), `${gone} entfällt`);
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
    for (const tbl of ['principal', 'authz_tuple', 'audit_log']) assert.equal((await t.admin.query(`SELECT count(*)::int AS n FROM notes.${tbl}`)).rows[0].n, 0, tbl);
  });

  test('ohne Mandantenkontext sind keine Zeilen sichtbar', async () => {
    assert.equal((await t.runtime.query('SELECT count(*)::int AS n FROM notes.principal')).rows[0].n, 0);
    assert.equal((await t.runtime.query('SELECT count(*)::int AS n FROM notes.tenant')).rows[0].n, 0);
    await assert.rejects(t.runtime.query("INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type) VALUES ($1, 'org:members', 'viewer', 'org')", [A]), /row-level security/);
  });

  test('Mandant B sieht keine Daten von A und kann keine für A schreiben', async () => {
    await withTenant(t.runtime, { tenantId: B }, async tx => {
      for (const tbl of ['principal', 'authz_tuple']) assert.equal((await tx.query(`SELECT count(*)::int AS n FROM notes.${tbl}`)).rows[0].n, 0, tbl);
      assert.deepEqual((await tx.query('SELECT alias FROM notes.tenant')).rows, [{ alias: 'beta' }]);
      assert.equal((await tx.query("UPDATE notes.principal SET display_name = 'gehackt' WHERE subject = 'u-a'")).rowCount, 0);
      assert.equal((await tx.query("UPDATE notes.tenant SET name = 'gehackt' WHERE id = $1", [A])).rowCount, 0);
    });
    await assert.rejects(withTenant(t.runtime, { tenantId: B }, tx =>
      tx.query("INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type) VALUES ($1, 'org:members', 'viewer', 'org')", [A])), /row-level security/);
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

  test('app.has_permission (iam_018): ohne Einstellung false, Recht an org, Tupel nur an genau dieser Ressource und im eigenen Mandanten', async () => {
    const U = '6f1c3c1e-2b7a-4a51-9a52-0c2f3e4d5a61', V = 'a1b2c3d4-0000-4000-8000-000000000001', W = 'a1b2c3d4-0000-4000-8000-000000000002';
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query("INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type, object_id) VALUES ($1, $2, 'viewer', 'view', $3)", [A, `user:${U}`, V]));
    const q = "SELECT app.has_permission('view:read') AS org, app.has_permission('view:read', 'view', $1) AS v, app.has_permission('view:read', 'view', $2) AS w, app.has_permission('view:write', 'view', $1) AS write, app.has_permission(NULL, 'view', $1) AS none";
    const view = { 'app.subjects': `{"user:${U}"}`, 'app.permission_relations': JSON.stringify({ 'view:read': ['viewer', 'editor', 'owner'], 'view:write': ['editor', 'owner'] }) };
    const run = (tenantId: string, settings: Record<string, string>) => withTenant(t.runtime, { tenantId, settings }, async tx => (await tx.query(q, [V, W])).rows[0]);
    assert.deepEqual(await run(A, {}), { org: false, v: false, w: false, write: false, none: false }, 'ohne Lesesicht');
    assert.deepEqual(await run(A, view), { org: false, v: true, w: false, write: false, none: false }, 'Tupel viewer an V');
    assert.deepEqual(await run(A, { ...view, 'app.org_permissions': '{"view:read"}' }), { org: true, v: true, w: true, write: false, none: false }, 'Recht an org');
    assert.deepEqual(await run(A, { ...view, 'app.permission_relations': '{}' }), { org: false, v: false, w: false, write: false, none: false }, 'Scope deckt das Recht nicht');
    assert.deepEqual(await run(B, view), { org: false, v: false, w: false, write: false, none: false }, 'Tupel eines anderen Mandanten zählt nie');
    assert.equal((await t.runtime.query("SELECT app.has_permission('view:read', 'view', $1) AS ok", [V])).rows[0].ok, false, 'ohne Mandant');
  });

  test('Tupel: Subjekt nach Muster, leer genau bei org, Clients nur an org, Relation und Typ aus dem Modell, eindeutig', async () => {
    const ins = (subject: string, relation: string, type: string, id: string | null) => withTenant(t.runtime, { tenantId: A }, tx => tx.query(
      'INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type, object_id) VALUES ($1, $2, $3, $4, $5)', [A, subject, relation, type, id]));
    const id = '00000000-0000-4000-8000-000000000001';
    await assert.rejects(ins('user:x', 'viewer', 'org', null), /authz_tuple_subject_check/);
    await assert.rejects(ins('group:ABC', 'viewer', 'org', null), /authz_tuple_subject_check/);
    await assert.rejects(ins(`user:${id}`, 'viewer', 'org', id), /authz_tuple_org_check/);
    await assert.rejects(ins(`user:${id}`, 'viewer', 'folder', null), /authz_tuple_org_check/);
    await assert.rejects(ins(`client:${id}`, 'viewer', 'folder', id), /authz_tuple_client_check/);
    await assert.rejects(ins(`user:${id}`, 'boss', 'org', null), /authz_tuple_relation_check/);
    await assert.rejects(ins(`user:${id}`, 'viewer', 'schema', id), /authz_tuple_object_type_check/);
    await ins(`user:${id}`, 'viewer', 'folder', id);
    await assert.rejects(ins(`user:${id}`, 'viewer', 'folder', id), /authz_tuple_unique/);
    await ins(`client:${id}`, 'viewer', 'org', null);
    await assert.rejects(ins(`client:${id}`, 'viewer', 'org', null), /authz_tuple_unique/, 'NULLS NOT DISTINCT an org');
  });

  test('Änderungen an Tupeln und Freigabestufen erhöhen acl_version', async () => {
    const v = async () => Number((await withTenant(t.runtime, { tenantId: A }, tx => tx.query('SELECT acl_version FROM notes.tenant'))).rows[0].acl_version);
    const v0 = await v();
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query("INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type) VALUES ($1, 'org:members', 'viewer', 'org')", [A]));
    const v1 = await v();
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query("UPDATE notes.principal SET clearance = 1 WHERE subject = 'u-a'"));
    const v2 = await v();
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query("UPDATE notes.principal SET display_name = 'Anna M.' WHERE subject = 'u-a'"));
    await withTenant(t.runtime, { tenantId: A }, tx => tx.query("DELETE FROM notes.authz_tuple WHERE relation = 'viewer' AND subject = 'org:members'"));
    assert.ok(v1 > v0 && v2 > v1, 'Tupel und Freigabestufe');
    assert.equal(await v(), v2 + 1, 'Name ändert nichts, Löschen schon');
    const pB = await withTenant(t.runtime, { tenantId: B }, async tx => Number((await tx.query('SELECT acl_version FROM notes.tenant')).rows[0].acl_version));
    assert.equal(pB, 1, 'anderer Mandant unberührt');
  });

  test('Freigabestufe: 0..2, Break-Glass nur mit Ablauf', async () => {
    await assert.rejects(withTenant(t.runtime, { tenantId: A }, tx => tx.query("UPDATE notes.principal SET clearance = 3 WHERE subject = 'u-a'")), /principal_clearance_check/);
    await assert.rejects(withTenant(t.runtime, { tenantId: A }, tx => tx.query("UPDATE notes.principal SET clearance_boost = 2 WHERE subject = 'u-a'")), /principal_clearance_boost/);
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
    // Eine ID, die schon ein anderer Mandant trägt, wird nicht ein zweites Mal gebunden und löst nicht auf (iam_011)
    assert.equal(await resolve('alpha', 'kc-1'), null);
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

  test('Mandanten-Auflösung: nur ASCII-Aliasse, nie Unicode-Faltung (Kelvin-Zeichen); nur A–Z wird klein', async () => {
    const resolve = async (alias: string, create = true) => (await t.runtime.query<{ id: string | null }>('SELECT app.resolve_tenant($1, null, $1, $2) AS id', [alias, create])).rows[0]!.id;
    const k = await resolve('kilo');
    assert.ok(k);
    // U+212A KELVIN SIGN: lower() einer Unicode-Locale macht daraus «k»
    assert.equal(await resolve('\u212Ailo'), null);
    assert.equal(await resolve('\u212Ailo', false), null);
    assert.equal(await resolve('KILO'), k);
    for (const bad of ['', '-kilo', 'ki lo', 'kilo/x', 'ü', 'a'.repeat(64)]) assert.equal(await resolve(bad), null, JSON.stringify(bad));
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.tenant WHERE alias LIKE '%ilo'")).rows[0].n, 1);
  });

  test('Mandanten-Auflösung: Binden der Organisations-ID scheitert (ID gehört einem anderen Mandanten) → kein Mandant', async () => {
    const resolve = async (alias: string, kc: string | null) => (await t.runtime.query<{ id: string | null }>('SELECT app.resolve_tenant($1, $2, $1, true) AS id', [alias, kc])).rows[0]!.id;
    const owner = await resolve('lima', 'kc-lima');
    assert.ok(owner);
    const legacy = await resolve('mike', null);
    assert.ok(legacy);
    // «mike» hat noch keine ID; das Token nennt die ID von «lima» → nicht binden und nicht auflösen
    assert.equal(await resolve('mike', 'kc-lima'), null);
    assert.equal((await t.inspect.query("SELECT kc_org_id FROM notes.tenant WHERE alias = 'mike'")).rows[0].kc_org_id, null);
    // Neuer Alias mit einer ID, die schon einem anderen Mandanten gehört: NULL statt Fehler, nichts angelegt
    assert.equal(await resolve('november', 'kc-lima'), null);
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.tenant WHERE alias = 'november'")).rows[0].n, 0);
    // Eigene neue ID bindet weiterhin
    assert.equal(await resolve('mike', 'kc-mike'), legacy);
    assert.equal(await resolve('mike', 'kc-mike'), legacy);
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
