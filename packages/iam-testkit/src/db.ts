/**
 * Wegwerf-Datenbanken für Tests (Spezifikation Kap. 10, 14): je Testdatei eine eigene Datenbank auf dem lokalen
 * PostgreSQL bzw. dem Service-Container der CI, mit den Migrationen der App, Besitzer-Rolle und Laufzeit-Rollen wie in
 * Produktion. Überspringen: `{ skip: await dbSkip() }` (bzw. `postgresSkip()`) zählt die Tests ohne Datenbank sichtbar als
 * übersprungen; ist sie konfiguriert, aber nicht erreichbar, scheitert der Lauf. `dbAvailable()` (nur true/false) bleibt.
 *
 * Umgebung (Namen wie in den Apps): `TEST_POSTGRES_URL` oder `POSTGRES_SUPERUSER_PASSWORD` (+ `POSTGRES_PORT`, Standard
 * 5433) für den Superuser, `DATABASE_URL` (Laufzeit), `DATABASE_ADMIN_URL` (Besitzer), optional `DATABASE_WORKER_URL`.
 * Die Datenbank in diesen Adressen wird durch die Wegwerf-Datenbank ersetzt.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';

export interface TestDatabaseOptions<R> {
  /** Präfix der Datenbanknamen, z. B. `notes_test_` (Kleinbuchstaben, endet mit `_`). */
  prefix: string;
  /** Besitzer-Rolle der Datenbank, z. B. `notes_owner`. */
  owner: string;
  /** Rollen mit CONNECT auf die Datenbank, z. B. `['notes_app', 'notes_sched']`. */
  connect: string[];
  /** Migrationen der App als Besitzer ausführen; `dir` aus `create({ migrationsDir })`. */
  migrate(adminUrl: string, dir?: string): Promise<unknown>;
  /** Laufzeit-Zugang der App (z. B. ihr Pool) für die Tests. */
  runtime(runtimeUrl: string): R;
  /** Laufzeit-Zugang schliessen. */
  closeRuntime(runtime: R): Promise<unknown>;
  /** Reste abgebrochener Läufe ab diesem Alter löschen (Standard 1 h). */
  staleAfterMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** `admin` = Besitzer-Rolle (unterliegt FORCE RLS), `inspect` = Superuser auf der Testdatenbank für Prüfabfragen. */
export interface TestDb<R> {
  name: string; runtimeUrl: string; adminUrl: string; workerUrl: string;
  runtime: R; admin: pg.Client; inspect: pg.Client;
  drop(): Promise<void>;
}

export interface TestDatabases<R> {
  superuserUrl(): string | null;
  dbAvailable(): Promise<boolean>;
  /** `false`, Grund zum Überspringen (keine Datenbank konfiguriert) oder Fehler (konfiguriert, aber nicht nutzbar). */
  dbSkip(): Promise<false | string>;
  testDbName(now?: number, prefix?: string): string;
  sweepStaleTestDbs(o?: { maxAgeMs?: number; now?: number; prefix?: string; only?: (name: string) => boolean }): Promise<string[]>;
  createTestDb(o?: { migrationsDir?: string }): Promise<TestDb<R>>;
}

const PREFIX = /^[a-z][a-z0-9_]*_$/;
const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Adresse des Superusers aus der Umgebung: `TEST_POSTGRES_URL` oder `POSTGRES_SUPERUSER_PASSWORD` (+ `POSTGRES_PORT`). */
export function superuserUrlFrom(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TEST_POSTGRES_URL) return env.TEST_POSTGRES_URL;
  if (!env.POSTGRES_SUPERUSER_PASSWORD) return null;
  return `postgres://postgres:${encodeURIComponent(env.POSTGRES_SUPERUSER_PASSWORD)}@localhost:${env.POSTGRES_PORT ?? '5433'}/postgres`;
}

/** Grund zum Überspringen ohne konfigurierte Datenbank (für `{ skip }` von node:test). */
export const NO_POSTGRES = 'Datenbank-Tests übersprungen: keine PostgreSQL konfiguriert (TEST_POSTGRES_URL oder POSTGRES_SUPERUSER_PASSWORD)';

/**
 * Für `describe(…, { skip: await postgresSkip() })`: `false` mit erreichbarer Datenbank; ohne Konfiguration der Grund
 * `NO_POSTGRES` (node:test zählt die Tests als übersprungen und zeigt ihn); konfiguriert, aber nicht erreichbar: Fehler
 * (der Lauf scheitert, statt still weniger Tests zu prüfen).
 */
export async function postgresSkip(env: NodeJS.ProcessEnv = process.env): Promise<false | string> {
  const url = superuserUrlFrom(env);
  if (!url) return NO_POSTGRES;
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try { await c.connect(); } catch (e) {
    const u = new URL(url);
    throw new Error(`PostgreSQL konfiguriert (${env.TEST_POSTGRES_URL ? 'TEST_POSTGRES_URL' : 'POSTGRES_SUPERUSER_PASSWORD'}), aber nicht erreichbar unter ${u.host}: ${(e as Error).message}`);
  } finally { await c.end().catch(() => undefined); }
  return false;
}

export function withDb(url: string, db: string): string { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); }

export function testDatabases<R>(o: TestDatabaseOptions<R>): TestDatabases<R> {
  if (!PREFIX.test(o.prefix)) throw new Error(`Ungültiges Präfix: ${o.prefix}`);
  for (const r of [o.owner, ...o.connect]) if (!IDENT.test(r)) throw new Error(`Ungültiger Rollenname: ${r}`);
  const env = o.env ?? process.env;

  const superuserUrl = () => superuserUrlFrom(env);

  async function dbAvailable(): Promise<boolean> {
    const url = superuserUrl();
    if (!url || !env.DATABASE_URL || !env.DATABASE_ADMIN_URL) return false;
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
    try { await c.connect(); await c.end(); return true; } catch { return false; }
  }

  /** Wie `postgresSkip`, dazu Fehler, wenn mit Datenbank `DATABASE_URL` oder `DATABASE_ADMIN_URL` fehlt. */
  async function dbSkip(): Promise<false | string> {
    const skip = await postgresSkip(env);
    if (skip) return skip;
    const missing = ['DATABASE_URL', 'DATABASE_ADMIN_URL'].filter(k => !env[k]);
    if (missing.length) throw new Error(`PostgreSQL erreichbar, aber ${missing.join(' und ')} fehlt (Rollen der Wegwerf-Datenbank)`);
    return false;
  }

  // Name trägt den Erstellungszeitpunkt (Base36-Millisekunden), damit Reste abgebrochener Läufe ohne Dateizugriff datierbar sind
  const testDbName = (now = Date.now(), prefix = o.prefix) => `${prefix}${now.toString(36)}_${randomBytes(4).toString('hex')}`;

  /**
   * Löscht Wegwerf-Datenbanken `<prefix>*` älter als `maxAgeMs` ohne aktive Verbindung (Reste abgebrochener Läufe).
   * Alter aus dem Zeitstempel im Namen, sonst aus dem Erstellungsdatum der Datei PG_VERSION.
   * Ohne FORCE: Verbindet sich jemand zwischen Prüfung und Löschen, schlägt das Löschen fehl und die Datenbank bleibt.
   */
  async function sweepStaleTestDbs(s: { maxAgeMs?: number; now?: number; prefix?: string; only?: (name: string) => boolean } = {}): Promise<string[]> {
    const maxAgeMs = s.maxAgeMs ?? o.staleAfterMs ?? 3_600_000, now = s.now ?? Date.now(), prefix = s.prefix ?? o.prefix;
    if (!PREFIX.test(prefix)) throw new Error(`Ungültiges Präfix: ${prefix}`);
    const valid = new RegExp(`^${prefix}[a-z0-9_]+$`), stamped = new RegExp(`^${prefix}([0-9a-z]+)_[0-9a-f]+$`);
    const su = new pg.Client({ connectionString: superuserUrl()! });
    await su.connect();
    const dropped: string[] = [];
    try {
      const rows = (await su.query<{ name: string; oid: number }>(
        `SELECT datname AS name, oid FROM pg_database d WHERE datname LIKE $1 AND NOT datistemplate
           AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datid = d.oid) ORDER BY datname`, [`${prefix.replaceAll('_', '\\_')}%`])).rows;
      for (const r of rows) {
        if (!valid.test(r.name) || (s.only && !s.only(r.name))) continue;
        const m = stamped.exec(r.name);
        let created = m ? parseInt(m[1]!, 36) : NaN;
        if (!m) {
          // pg_stat_file braucht Superuser oder pg_read_server_files; ohne Recht bleibt die Datenbank stehen
          try { created = (await su.query<{ t: Date }>('SELECT (pg_stat_file($1)).modification AS t', [`base/${r.oid}/PG_VERSION`])).rows[0]!.t.getTime(); } catch { continue; }
        }
        if (!(now - created > maxAgeMs)) continue;
        try { await su.query(`DROP DATABASE IF EXISTS "${r.name}"`); dropped.push(r.name); } catch { /* inzwischen in Gebrauch */ }
      }
    } finally { await su.end(); }
    return dropped;
  }

  // Eigene Datenbanken dieses Prozesses: beim Ende (auch Ctrl+C) löschen, falls ein Test drop() nicht mehr erreicht.
  // Wert: schliesst die Verbindungen zu dieser Datenbank (sonst melden sie beim Löschen mit FORCE einen Fehler).
  const own = new Map<string, () => Promise<unknown>>();
  let sweep: Promise<unknown> | null = null;
  let exitHooks = false;
  async function dropOwn() {
    const entries = [...own]; own.clear();
    if (!entries.length) return;
    await Promise.allSettled(entries.map(([, close]) => close()));
    const c = new pg.Client({ connectionString: superuserUrl()!, connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
      for (const [n] of entries) await c.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).catch(() => undefined);
    } catch { /* best effort */ } finally { await c.end().catch(() => undefined); }
  }
  function installExitHooks() {
    if (exitHooks) return;
    exitHooks = true;
    process.once('beforeExit', () => void dropOwn());
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.once(sig, () => {
        const code = sig === 'SIGINT' ? 130 : 143;
        // Getrennte Verbindungen der Tests (Server, eigene Pools) dürfen das Aufräumen nicht mehr abbrechen
        process.on('uncaughtException', () => undefined);
        void Promise.race([dropOwn(), new Promise(r => setTimeout(r, 5000).unref())]).finally(() => process.exit(code));
      });
    }
  }

  /** @param c.migrationsDir nur die Migrationen aus diesem Ordner ausführen (z. B. Stand vor einer Migration testen). */
  async function createTestDb(c: { migrationsDir?: string } = {}): Promise<TestDb<R>> {
    // Einmal je Prozess Reste entfernen; Fehler dabei halten die Tests nicht auf
    await (sweep ??= sweepStaleTestDbs().catch(() => undefined));
    installExitHooks();
    const su = new pg.Client({ connectionString: superuserUrl()! });
    await su.connect();
    const name = testDbName();
    await su.query(`CREATE DATABASE ${name} OWNER ${o.owner}`);
    own.set(name, async () => undefined);
    await su.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    if (o.connect.length) await su.query(`GRANT CONNECT ON DATABASE ${name} TO ${o.connect.join(', ')}`);
    // Nicht offen halten: Suiten laufen parallel und liegen nahe an max_connections; zum Löschen neu verbinden
    await su.end();
    const adminUrl = withDb(env.DATABASE_ADMIN_URL!, name);
    const runtimeUrl = withDb(env.DATABASE_URL!, name);
    const workerUrl = withDb(env.DATABASE_WORKER_URL ?? env.DATABASE_URL!, name);
    await o.migrate(adminUrl, c.migrationsDir);
    const runtime = o.runtime(runtimeUrl);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const inspect = new pg.Client({ connectionString: withDb(superuserUrl()!, name) });
    await inspect.connect();
    own.set(name, () => Promise.allSettled([o.closeRuntime(runtime), admin.end(), inspect.end()]));
    return {
      name, runtimeUrl, adminUrl, workerUrl, runtime, admin, inspect,
      async drop() {
        await o.closeRuntime(runtime); await admin.end(); await inspect.end();
        const d = new pg.Client({ connectionString: superuserUrl()! });
        await d.connect();
        await d.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await d.end();
        own.delete(name);
      },
    };
  }

  return { superuserUrl, dbAvailable, dbSkip, testDbName, sweepStaleTestDbs, createTestDb };
}
