/**
 * Datenbankzugriff (app-boilerplate 5.2). Pool, Transaktion und Mandantenkontext kommen aus @vollholz/iam: `withTenant`
 * setzt zu Beginn jeder Transaktion `app.tenant_id`, `app.principal_id` und die Lesesicht (`SET LOCAL`, tauglich für
 * PgBouncer im Transaktionsmodus). Ohne Kontext liefert RLS keine Zeilen; es gibt keinen Weg an ihr vorbei (ausser
 * Warteschlange und Outbox für den Scheduler, Rolle `<ident>_sched`).
 *
 * Anfragen von Personen und Clients laufen über `req.tx` (Lesesicht des Baukastens); Hintergrundarbeit über `fullTx`
 * (`platform.fullTx`).
 */
import { createPool as iamPool, withTenant, withTx, type Db, type Tx } from '@vollholz/iam';
import type { PlatformConfig } from '../config/env.ts';

export { withTx, withTenant, type Db, type Tx };

/** Pool mit `statement_timeout`, `idle_in_transaction_session_timeout` und TLS nach `DATABASE_SSL`. */
export function createPool(url: string, cfg: PlatformConfig, applicationName: string): Db {
  return iamPool(url, cfg, applicationName);
}
