/**
 * Sperren in PostgreSQL (Advisory-Locks) als Vertrag: Alle Instanzen einer App – auch alte und neue Version während
 * eines Deploys, auch App-Code ausserhalb des Pakets – müssen für dieselbe Sache dieselbe Sperre nehmen. Die Werte
 * stammen aus Assets und ändern sich nie (Test in test/locks.test.ts).
 *
 * - Zahlen: Sperren über die ganze Datenbank (`pg_advisory_lock(n)`, Sitzung).
 * - Texte: Sperren je Sache in der Transaktion (`pg_advisory_xact_lock(hashtextextended(<text>, 0))`).
 */

/** Sperren über die ganze Datenbank. */
export const LOCKS = {
  /** Migrations-Runner: höchstens ein Lauf gleichzeitig. */
  migrate: 727001,
  /** Abgleich der Mitglieder im Worker: höchstens ein Lauf über alle Instanzen. */
  memberSync: 727016,
} as const;

/** Schlüssel der Sperren je Sache (Text für `hashtextextended`). */
export const lockKey = {
  /**
   * Audit-Kette eines Mandanten (Trigger app.audit_chain). Dieselbe Sperre nimmt in Assets die Folgenummer der Outbox
   * (app.outbox_sequence, Migration 044): Ereignis und Audit-Eintrag entstehen meist in derselben Transaktion; zwei
   * verschiedene Sperren in wechselnder Reihenfolge könnten sich verklemmen.
   */
  audit: (tenantId: string) => `audit:${tenantId}`,
  /** Änderungen der Verwaltung an einer Organisation laufen nacheinander (Kap. 9.1 Nr. 7). */
  admin: (alias: string) => `admin:${alias}`,
  /** Abgleich der Mitglieder eines Mandanten. */
  peopleSync: (tenantId: string) => `people-sync:${tenantId}`,
  /** Anmeldung über Entra ID über alle Organisationen: Domänenprüfung, Vergabe der Plätze `entra-NNN`. */
  entraPlatform: () => 'entra:platform',
} as const;
