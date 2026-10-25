/**
 * Geteilter, kurzlebiger Zustand für mehrere Instanzen (SHARED_STATE):
 * - Replay-Schutz für DPoP-Proofs und Logout-Tokens (jeder `jti` höchstens einmal),
 * - Zähler des Rate-Limits (@fastify/rate-limit, eigener Store).
 *
 * `postgres` nutzt die UNLOGGED-Tabellen aus iam_006 und funktioniert mit beliebig vielen Instanzen. `memory` hält
 * alles im Prozess und ist nur für genau eine Instanz geeignet.
 */
import { schemaName, type Db } from './db.ts';

export interface ReplayStore {
  /** true, wenn `key` neu ist (und jetzt für `ttlMs` gesperrt wird); false bei Wiederverwendung. */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** Gibt einen Schlüssel wieder frei (die Arbeit nach `claim` ist gescheitert, eine Wiederholung soll gelten). */
  release?(key: string): Promise<void>;
}

export class MemoryReplayStore implements ReplayStore {
  private seen = new Map<string, number>();
  async claim(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    if (this.seen.size > 50_000) for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
    const exp = this.seen.get(key);
    if (exp && exp > now) return false;
    this.seen.set(key, now + ttlMs);
    return true;
  }
  async release(key: string): Promise<void> { this.seen.delete(key); }
}

export class PgReplayStore implements ReplayStore {
  private readonly db: Db;
  private readonly table: string;
  constructor(db: Db, schema: string) { this.db = db; this.table = `${schemaName(schema)}.replay_guard`; }
  async claim(key: string, ttlMs: number): Promise<boolean> {
    // Neu oder abgelaufen → Zeile (neu) setzen und true; noch gültig → keine Zeile, false.
    const r = await this.db.query(
      `INSERT INTO ${this.table} (key, expires_at) VALUES ($1, now() + ($2 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE SET expires_at = excluded.expires_at WHERE ${this.table}.expires_at <= now()
       RETURNING 1`, [key, String(ttlMs)]);
    return r.rowCount === 1;
  }
  async release(key: string): Promise<void> { await this.db.query(`DELETE FROM ${this.table} WHERE key = $1`, [key]); }
}

type IncrCallback = (err: Error | null, res?: { current: number; ttl: number }) => void;

/**
 * Store-Klasse für @fastify/rate-limit (Option `store`). Das Plugin instanziiert sie selbst, deshalb als Fabrik mit
 * gebundener Datenbank. Festes Zeitfenster pro Schlüssel, atomar per Upsert.
 */
export function pgRateLimitStore(db: Db, schema: string) {
  const table = `${schemaName(schema)}.rate_limit`;
  return class PgRateLimitStore {
    readonly prefix: string;
    constructor(_globalParams?: unknown, prefix = '') { this.prefix = prefix; }

    incr(key: string, cb: IncrCallback, timeWindow: number) {
      db.query<{ hits: number; ttl: number }>(
        `INSERT INTO ${table} AS r (key, hits, reset_at) VALUES ($1, 1, now() + ($2 || ' milliseconds')::interval)
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.hits + 1 END,
           reset_at = CASE WHEN r.reset_at <= now() THEN excluded.reset_at ELSE r.reset_at END
         RETURNING hits, greatest(0, ceil(extract(epoch FROM reset_at - now()) * 1000))::int AS ttl`,
        [this.prefix + key, String(timeWindow)],
      ).then(r => cb(null, { current: r.rows[0]!.hits, ttl: r.rows[0]!.ttl }), e => cb(e as Error));
    }

    read(key: string, cb: IncrCallback) {
      db.query<{ hits: number; ttl: number }>(
        `SELECT hits, greatest(0, ceil(extract(epoch FROM reset_at - now()) * 1000))::int AS ttl FROM ${table} WHERE key = $1 AND reset_at > now()`,
        [this.prefix + key],
      ).then(r => cb(null, r.rows[0] ? { current: r.rows[0].hits, ttl: r.rows[0].ttl } : { current: 0, ttl: 0 }), e => cb(e as Error));
    }

    /** Routen mit eigener Konfiguration bekommen einen eigenen Schlüsselraum. */
    child(routeOptions: object) {
      const r = (routeOptions as { routeInfo?: { method?: string | string[]; url?: string } }).routeInfo;
      return new PgRateLimitStore(undefined, `${this.prefix}${String(r?.method ?? '')} ${r?.url ?? ''}|`);
    }
  };
}

/** Abgelaufene Einträge löschen (periodisch im Worker). Liefert die Zahl gelöschter Zeilen. */
export async function purgeSharedState(db: Db, schema: string): Promise<number> {
  const s = schemaName(schema);
  const a = await db.query(`DELETE FROM ${s}.replay_guard WHERE expires_at < now()`);
  const b = await db.query(`DELETE FROM ${s}.rate_limit WHERE reset_at < now() - interval '1 minute'`);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0);
}
