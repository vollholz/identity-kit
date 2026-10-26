/**
 * Sicht der Hintergrundarbeit: volle Sicht im Mandanten ohne Person (alle Orte, höchste Stufe der Klassifizierung).
 */
import { fullView, type Model } from '@vollholz/iam';
import { withTenant, type Db, type Tx } from '../db/pool.ts';

/** Transaktion im Mandanten mit voller Sicht und ohne Person (Worker, Jobs, Systemaufgaben). */
export type FullTx = <T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;

export function fullTxOf(model: Model<string>): FullTx {
  const settings = fullView(model);
  return (db, tenantId, fn) => withTenant(db, { tenantId, settings }, fn);
}
