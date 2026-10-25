/**
 * Datenbankzugriff. Jede fachliche Arbeit läuft in einer Transaktion mit gesetztem
 * Mandantenkontext; ohne Kontext liefert RLS keine Zeilen. Es gibt bewusst keinen Weg, Abfragen ohne Kontext auf
 * Mandantentabellen auszuführen (ausser über die SECURITY-DEFINER-Funktionen der Migrationen).
 */
import pg from 'pg';
import type { IamConfig } from './config.ts';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string, cfg: Pick<IamConfig, 'db'>, applicationName: string): Db {
  const ssl = cfg.db.ssl === 'disable' ? false : cfg.db.ssl === 'require' ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
  const pool = new pg.Pool({
    connectionString: url, max: cfg.db.poolMax, ssl, application_name: applicationName,
    statement_timeout: cfg.db.statementTimeoutMs, idle_in_transaction_session_timeout: Math.max(cfg.db.statementTimeoutMs * 2, 60_000),
  });
  pool.on('error', () => { /* Verbindungsabbrüche im Leerlauf: pg baut neu auf */ });
  return pool;
}

const IDENT = /^[a-z][a-z0-9_]{0,62}$/;

/** Schema der Tabellen für SQL-Texte; nur einfache Bezeichner (wird nie aus Anfragen gebildet). */
export function schemaName(schema: string): string {
  if (!IDENT.test(schema)) throw new Error(`Schema «${schema}» ungültig`);
  return schema;
}

/** Kontext einer Transaktion. */
export interface DbContext {
  tenantId: string;
  principalId?: string | null;
  /**
   * Weitere Einstellungen der App für dieselbe Transaktion (z. B. eigene Einstellungen `app.*`).
   * Namen `app.<name>`; `app.tenant_id` und `app.principal_id` setzt nur das Paket.
   */
  settings?: Record<string, string>;
}

const SETTING = /^app\.[a-z][a-z0-9_]{0,62}$/;
const OWN = new Set(['app.tenant_id', 'app.principal_id']);

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  // Scheitert ROLLBACK, ist der Zustand der Verbindung unklar: verwerfen statt in den Pool zurückgeben
  let broken: Error | undefined;
  try {
    await tx.query('BEGIN');
    const r = await fn(tx);
    await tx.query('COMMIT');
    return r;
  } catch (e) {
    await tx.query('ROLLBACK').catch((err: Error) => { broken = err; });
    throw e;
  } finally { tx.release(broken); }
}

/** Transaktion im Kontext eines Mandanten (`set_config(…, true)` – gilt nur bis COMMIT/ROLLBACK, sicher mit Poolern). */
export function withTenant<T>(db: Db, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(db, async tx => {
    await setContext(tx, ctx);
    return fn(tx);
  });
}

/** Setzt den Kontext in einer Abfrage. */
export async function setContext(tx: pg.ClientBase, ctx: DbContext) {
  const extra = Object.entries(ctx.settings ?? {});
  for (const [k] of extra) if (!SETTING.test(k) || OWN.has(k)) throw new Error(`Einstellung «${k}» nicht erlaubt`);
  const sets = ["set_config('app.tenant_id', $1, true)", "set_config('app.principal_id', $2, true)"];
  const params: string[] = [ctx.tenantId, ctx.principalId ?? ''];
  for (const [k, v] of extra) { params.push(k, v); sets.push(`set_config($${params.length - 1}, $${params.length}, true)`); }
  await tx.query(`SELECT ${sets.join(', ')}`, params);
}
