/**
 * Mandantentrennung direkt in PostgreSQL (app-boilerplate L4, 5.3, 7): Die Datenbank selbst verhindert
 * Fremdzugriffe, auch wenn die Anwendung einen Fehler hätte.
 *
 * Vollständig gegen den Katalog: Jede Tabelle mit tenant_id steht in `TENANT_TABLES` (Tabellen der Plattform und der Test-App,
 * mit Testdaten für die Matrix) oder in `KIT_TABLES` (Tabellen von @vollholz/iam, geprüft im Paket); jede Tabelle ohne tenant_id mit
 * Rechten der Laufzeit in `WITHOUT_TENANT`; jede Policy ausser tenant_isolation in `POLICIES`; jede SECURITY-DEFINER-
 * Funktion in `SECURITY_DEFINER`. Neue Tabellen, Policies oder Ausnahmen kommen mit Begründung hierher – sonst schlägt
 * der Test fehl.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import {
  bypassRoleProblems, grantedTableProblems, publicExecuteProblems, publicSchemaProblems, readViewProblems, securityDefinerProblems, tenantTableProblems,
} from '@vollholz/iam-testkit';
import { withTenant, type Tx } from '../src/index.ts';
import { createTestDb, full, skipDb, tenant, type Harness } from './harness.ts';

const skip = await skipDb();
const S = 'probe';

/** Tabellen der App mit tenant_id: je eine Zeile für den Mandanten anlegen (volle Sicht), liefert eine Bedingung auf sie. */
const TENANT_TABLES: Record<string, (tx: Tx, tenantId: string) => Promise<string>> = {
  job: async (tx, t) => { await tx.query("INSERT INTO probe.job (tenant_id, kind) VALUES ($1, 'probe')", [t]); return "kind = 'probe'"; },
  idempotency_key: async (tx, t) => {
    await tx.query("INSERT INTO probe.idempotency_key (tenant_id, principal_id, key, method, path, request_hash, expires_at) VALUES ($1, gen_random_uuid(), 'probe', 'POST', '/x', 'h', now() + interval '1 h')", [t]);
    return "key = 'probe'";
  },
  outbox_event: async (tx, t) => { await tx.query("INSERT INTO probe.outbox_event (tenant_id, type) VALUES ($1, 'probe.created')", [t]); return "type = 'probe.created'"; },
  notiz: async (tx, t) => { await tx.query("INSERT INTO probe.notiz (tenant_id, label) VALUES ($1, 'Probe')", [t]); return "label = 'Probe'"; },
  notiz_version: async () => "label = 'Probe'",   // entsteht per Trigger mit der Notiz
  // Token der öffentlichen Route: nur tenant_isolation, keine Lesesicht (public-route.test.ts)
  notiz_abo: async (tx, t) => {
    const p = (await tx.query<{ id: string }>("INSERT INTO probe.principal (tenant_id, kind, subject) VALUES ($1, 'user', 'abo-probe') RETURNING id", [t])).rows[0]!.id;
    await tx.query("INSERT INTO probe.notiz_abo (tenant_id, principal_id, token_hash) VALUES ($1, $2, repeat('a', 64))", [t, p]);
    return "token_hash = repeat('a', 64)";
  },
};

/** Tabellen von @vollholz/iam mit tenant_id: RLS, Policies und Trennung prüft das Paket selbst (und die Prüfungen unten). */
const KIT_TABLES = ['principal', 'authz_tuple', 'authz_role', 'member_invitation', 'audit_log', 'audit_anchor', 'entra_connection', 'entra_consent', 'entra_consent_link'];

/** Tabellen ohne tenant_id, auf die Laufzeit oder Worker Rechte haben – jede mit Begründung. */
const WITHOUT_TENANT: Record<string, string> = {
  'probe.tenant': 'Mandantenzeile selbst: RLS mit tenant_self (nur der eigene Mandant), Schreiben nur name und settings',
  'probe.session': 'Sitzungen der Oberfläche (BFF): verschlüsselt, Zugriff nur über die zufällige Sitzungs-ID',
  'probe.rate_limit': 'Zähler des Rate-Limits je Route und Schlüssel, keine Mandantendaten',
  'probe.replay_guard': 'Replay-Schutz (DPoP-Proofs, Logout-Tokens), nur Schlüssel und Ablauf',
};

/** Policies ausser tenant_isolation, so wie PostgreSQL sie ausgibt. */
const POLICIES = [
  // @vollholz/iam
  'probe.tenant.tenant_self PERMISSIVE ALL probe_app USING (id = app.tenant_id()) CHECK (id = app.tenant_id())',
  "probe.entra_connection.entra_scan PERMISSIVE SELECT probe_owner USING (current_setting('app.entra_scan'::text, true) = 'on'::text) CHECK -",
  'probe.principal.owner_tenant PERMISSIVE ALL probe_owner USING (tenant_id = app.tenant_id()) CHECK (tenant_id = app.tenant_id())',
  'probe.authz_role.owner_tenant PERMISSIVE ALL probe_owner USING (tenant_id = app.tenant_id()) CHECK (tenant_id = app.tenant_id())',
  'probe.authz_tuple.owner_tenant PERMISSIVE ALL probe_owner USING (tenant_id = app.tenant_id()) CHECK (tenant_id = app.tenant_id())',
  'probe.audit_log.owner_tenant PERMISSIVE ALL probe_owner USING (tenant_id = app.tenant_id()) CHECK (tenant_id = app.tenant_id())',
  // Plattform (platform_001_core): Scheduler liest über alle Mandanten, schreibt ohne Kontext oder nur im gesetzten
  // Mandanten; abgelaufene Idempotenz aufräumen
  'probe.job.sched_read PERMISSIVE SELECT probe_sched USING true CHECK -',
  'probe.job.sched_write PERMISSIVE ALL probe_sched USING ((app.tenant_id() IS NULL) OR (tenant_id = app.tenant_id())) CHECK ((app.tenant_id() IS NULL) OR (tenant_id = app.tenant_id()))',
  'probe.outbox_event.sched_read PERMISSIVE SELECT probe_sched USING true CHECK -',
  'probe.outbox_event.sched_write PERMISSIVE ALL probe_sched USING ((app.tenant_id() IS NULL) OR (tenant_id = app.tenant_id())) CHECK ((app.tenant_id() IS NULL) OR (tenant_id = app.tenant_id()))',
  'probe.idempotency_key.sched_cleanup PERMISSIVE DELETE probe_sched USING (expires_at < now()) CHECK -',
  'probe.idempotency_key.sched_read PERMISSIVE SELECT probe_sched USING (expires_at < now()) CHECK -',
  // Lesesicht der Notizen (Test-App, 001_notiz)
  "probe.notiz.notiz_read RESTRICTIVE SELECT probe_app USING ((classification <= app.clearance()) AND (app.read_all() OR app.has_tuple('notiz'::text, id, app.read_relations()))) CHECK -",
  "probe.notiz.notiz_insert RESTRICTIVE INSERT probe_app USING - CHECK ((classification <= app.clearance()) AND app.write_all())",
  "probe.notiz.notiz_update RESTRICTIVE UPDATE probe_app USING ((classification <= app.clearance()) AND (app.write_all() OR app.has_tuple('notiz'::text, id, app.write_relations()))) CHECK ((classification <= app.clearance()) AND (app.write_all() OR app.has_tuple('notiz'::text, id, app.write_relations())))",
  "probe.notiz.notiz_delete RESTRICTIVE DELETE probe_app USING ((classification <= app.clearance()) AND (app.write_all() OR app.has_tuple('notiz'::text, id, app.write_relations()))) CHECK -",
  "probe.notiz_version.notiz_version_read RESTRICTIVE SELECT probe_app USING ((classification <= app.clearance()) AND (app.read_all() OR app.has_tuple('notiz'::text, notiz_id, app.read_relations()))) CHECK -",
];

/** SECURITY-DEFINER-Funktionen mit Begründung (alle aus @vollholz/iam; die App hat keine eigenen). */
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

const norm = (sql: string | null) => (sql === null ? '-' : sql.replace(/\s+/g, ' ').trim());

/** Policies ausser tenant_isolation als Zeilen (für den Vergleich mit `POLICIES`). */
async function policyLines(c: pg.ClientBase | pg.Pool): Promise<string[]> {
  const rows = (await c.query<{ s: string; t: string; n: string; p: string; c: string; r: string[]; q: string | null; w: string | null }>(
    'SELECT schemaname AS s, tablename AS t, policyname AS n, permissive AS p, cmd AS c, roles::text[] AS r, qual AS q, with_check AS w FROM pg_policies WHERE schemaname = $1', [S])).rows;
  return rows.filter(x => x.n !== 'tenant_isolation').map(x => `${x.s}.${x.t}.${x.n} ${x.p} ${x.c} ${x.r.join(',')} USING ${norm(x.q)} CHECK ${norm(x.w)}`).sort();
}

describe('PostgreSQL RLS', { skip }, () => {
  let t: Harness;
  let A: string, B: string;
  const where: Record<string, string> = {};

  before(async () => {
    t = await createTestDb();
    A = await tenant(t.runtime, 'alpha');
    B = await tenant(t.runtime, 'beta');
    for (const id of [A, B]) {
      await full(t.runtime, id, async tx => { for (const [name, seed] of Object.entries(TENANT_TABLES)) where[name] = await seed(tx, id); });
    }
  });
  after(async () => { await t?.drop(); });

  test('Vollständigkeit: jede Tabelle mit tenant_id steht in der Matrix oder ist eine Tabelle des Baukastens', async () => {
    const tables = (await t.inspect.query<{ t: string }>(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
        ORDER BY 1`, [S])).rows.map(r => r.t);
    const known = new Set([...Object.keys(TENANT_TABLES), ...KIT_TABLES]);
    assert.deepEqual(tables.filter(x => !known.has(x)), [], 'neue Tabelle: in TENANT_TABLES aufnehmen (Testdaten)');
    assert.deepEqual([...known].filter(x => !tables.includes(x)), [], 'Eintrag ohne Tabelle');
    // RLS mit FORCE auf jeder dieser Tabellen
    const weak = (await t.inspect.query<{ t: string }>(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = ANY($2) AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`, [S, tables])).rows;
    assert.deepEqual(weak, []);
  });

  test('Prüfungen des Test-Kits: Mandantentabellen, Rechte, Lesesicht, SECURITY DEFINER, PUBLIC, Rollen', async () => {
    assert.deepEqual(await tenantTableProblems(t.inspect, { appRole: 'probe_app', minTables: 12 }), []);
    assert.deepEqual(await grantedTableProblems(t.inspect, { roles: ['probe_app', 'probe_sched'], minTables: 15, withoutTenant: WITHOUT_TENANT }), []);
    assert.deepEqual(await readViewProblems(t.inspect, { schema: S, appRole: 'probe_app' }), []);
    assert.deepEqual(await securityDefinerProblems(t.inspect, { allowed: SECURITY_DEFINER }), []);
    assert.deepEqual(await publicSchemaProblems(t.inspect, { schemas: ['app', S] }), []);
    assert.deepEqual(await publicExecuteProblems(t.inspect, { schemas: ['app', S], strict: true }), []);
    assert.deepEqual(await bypassRoleProblems(t.inspect, { rolePrefix: 'probe_' }), []);
  });

  test('Policies: alle ausser tenant_isolation wie aufgeführt', async () => {
    assert.deepEqual(await policyLines(t.inspect), [...POLICIES].sort());
  });

  test('eine absichtlich entfernte Policy fällt auf', async () => {
    await t.admin.query('BEGIN');
    try {
      await t.admin.query('DROP POLICY notiz_read ON probe.notiz');
      const lines = await policyLines(t.admin);
      assert.notDeepEqual(lines, [...POLICIES].sort());
      assert.ok(!lines.some(l => l.includes('notiz_read')));
    } finally { await t.admin.query('ROLLBACK'); }
  });

  test('ohne Mandantenkontext sind keine Zeilen sichtbar, auch nicht für die Besitzer-Rolle', async () => {
    for (const name of Object.keys(TENANT_TABLES)) {
      assert.equal((await t.runtime.query(`SELECT count(*)::int AS n FROM ${S}.${name}`)).rows[0].n, 0, `runtime ${name}`);
      assert.equal((await t.admin.query(`SELECT count(*)::int AS n FROM ${S}.${name}`)).rows[0].n, 0, `owner ${name}`);
    }
  });

  test('Matrix: Mandant B sieht, ändert und löscht keine Daten von A', async () => {
    for (const name of Object.keys(TENANT_TABLES)) {
      await withTenant(t.runtime, { tenantId: B, settings: {} }, async tx => {
        assert.equal((await tx.query(`SELECT count(*)::int AS n FROM ${S}.${name} WHERE tenant_id = $1`, [A])).rows[0].n, 0, `lesen ${name}`);
      });
      // Volle Sicht in B: Policies der Lesesicht offen, nur die Mandantengrenze bleibt
      await full(t.runtime, B, async tx => {
        assert.equal((await tx.query(`SELECT count(*)::int AS n FROM ${S}.${name} WHERE tenant_id = $1`, [A])).rows[0].n, 0, `lesen (voll) ${name}`);
        assert.ok((await tx.query(`SELECT count(*)::int AS n FROM ${S}.${name} WHERE ${where[name]}`)).rows[0].n >= 1, `eigene Zeile ${name}`);
        await tx.query('SAVEPOINT s');
        const del = await tx.query(`DELETE FROM ${S}.${name} WHERE tenant_id = $1`, [A]).catch((e: Error) => e);
        await tx.query('ROLLBACK TO SAVEPOINT s');
        assert.ok(del instanceof Error ? /permission denied/.test(del.message) : del.rowCount === 0, `löschen ${name}`);
      });
    }
    await assert.rejects(full(t.runtime, B, tx => tx.query("INSERT INTO probe.notiz (tenant_id, label) VALUES ($1, 'Fremd')", [A])), /row-level security/);
    await assert.rejects(full(t.runtime, B, tx => tx.query("INSERT INTO probe.job (tenant_id, kind) VALUES ($1, 'fremd')", [A])), /row-level security/);
  });

  test('Lesesicht: ohne Rolle keine Notizen, Klassifizierung über der Freigabestufe unsichtbar', async () => {
    await withTenant(t.runtime, { tenantId: A, settings: {} }, async tx => {
      assert.equal((await tx.query(`SELECT count(*)::int AS n FROM ${S}.notiz`)).rows[0].n, 0);
      assert.equal((await tx.query(`SELECT count(*)::int AS n FROM ${S}.notiz_version`)).rows[0].n, 0);
    });
    await full(t.runtime, A, tx => tx.query(`INSERT INTO ${S}.notiz (tenant_id, label, classification) VALUES ($1, 'Geheim', 2)`, [A]));
    const labels = (clearance: string) => withTenant(t.runtime, { tenantId: A, settings: { 'app.read_all': 'on', 'app.clearance': clearance } }, async tx =>
      (await tx.query<{ label: string }>(`SELECT label FROM ${S}.notiz ORDER BY label`)).rows.map(r => r.label));
    assert.deepEqual(await labels('0'), ['Probe']);
    assert.deepEqual(await labels('2'), ['Geheim', 'Probe']);
  });

  test('Verlauf ist nur anhängbar; Worker sieht Warteschlange über alle Mandanten, aber keine Notizen ohne Kontext', async () => {
    await assert.rejects(full(t.runtime, A, tx => tx.query(`UPDATE ${S}.notiz_version SET label = 'x'`)), /permission denied/);
    await assert.rejects(full(t.runtime, A, tx => tx.query(`DELETE FROM ${S}.notiz_version`)), /permission denied/);
    const jobs = (await t.worker.query<{ n: number }>(`SELECT count(DISTINCT tenant_id)::int AS n FROM ${S}.job`)).rows[0]!.n;
    assert.equal(jobs, 2);
    assert.equal((await t.worker.query(`SELECT count(*)::int AS n FROM ${S}.notiz`)).rows[0].n, 0);
  });

  test('Scheduler: liest über alle Mandanten, schreibt im Kontext eines Mandanten nur dort', async () => {
    // Ohne Kontext (Abholen, Abschluss): beide Mandanten
    assert.equal((await t.worker.query("UPDATE probe.job SET last_error = 'ohne Kontext' WHERE kind = 'probe'")).rowCount, 2);
    // Im Kontext von B: Jobs von A sind lesbar, aber nicht änderbar
    await withTenant(t.worker, { tenantId: B, settings: {} }, async tx => {
      assert.equal((await tx.query(`SELECT count(*)::int AS n FROM ${S}.job WHERE tenant_id = $1`, [A])).rows[0].n, 1);
      assert.equal((await tx.query(`UPDATE ${S}.job SET last_error = 'fremd' WHERE tenant_id = $1`, [A])).rowCount, 0);
      assert.equal((await tx.query(`UPDATE ${S}.outbox_event SET dispatched_at = now() WHERE tenant_id = $1`, [A])).rowCount, 0);
      assert.equal((await tx.query(`UPDATE ${S}.job SET last_error = 'eigen' WHERE tenant_id = $1`, [B])).rowCount, 1);
    });
  });
});
