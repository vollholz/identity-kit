/**
 * Ereignisse des Baukastens an die App (`events` in `createIam`, `MemberSync`): Haken vor und nach einer Änderung, beide
 * in der Transaktion der Änderung und im Kontext ihres Mandanten (RLS). So legt die App in derselben Transaktion
 * Aufgaben an, schreibt in ihre Outbox (z. B. `platform.emit`) oder lehnt eine Änderung ab – gleich, ob sie über die
 * Verwalten-Seiten (Routen des Pakets) oder über die API des Pakets (`iam.admin`, `iam.tuples`) ausgelöst wurde.
 *
 *   before   `member.removing`                         darf ablehnen (wirft); vor jeder Änderung in Keycloak
 *   after    `member.removed`, `member.left`,          nach der Änderung; wirft der Haken, wird die Transaktion
 *            `access.granted`, `access.revoked`,       zurückgerollt
 *            `access.expired`
 *
 * Rollen sind Tupel (Subjekt hat Relation an Ort, Kap. 7.4): Jede Rolle, die an einem Ort vergeben, im Ablauf geändert
 * oder entzogen wird, meldet `TupleStore` als `access.*` (auch Rollen an org aus «Rollen setzen», Einladen und
 * Entfernen). Daten wie das Audit (`accessData`) plus `tupleId`.
 */
import type { Actor } from './audit.ts';
import type { Tx } from './db.ts';

/** Daten zu einer Rolle an einem Ort (`access.*`). Typen statt Interfaces: passen auf `Record<string, unknown>` (Outbox). */
export type AccessEventData = {
  tupleId: string;
  /** `user:<principal-id>`, `client:<id>`, `group:<id>` oder `org:members`. */
  subject: string;
  /** Rolle bzw. Relation (z. B. `org-admin`, `owner`). */
  relation: string;
  /** Typ des Orts (`org` oder ein Typ des Modells) und seine ID (null bei `org`). */
  type: string;
  id: string | null;
  expiresAt: string | null;
  /** Nur `access.granted` aus einer Änderung des Ablaufs: Ablauf vorher. */
  previousExpiresAt?: string | null;
};

/** Daten zum Entfernen einer Person bzw. Zurückziehen ihrer Einladung (`member.removing`, `member.removed`). */
export type MemberEventData = {
  /** ID nach aussen (`DELETE …/members/{id}`): Keycloak-ID des Mitglieds bzw. ID der Einladung. */
  memberId: string;
  /** Konto in Keycloak (`sub`). */
  userId: string;
  /** Principal im Mandanten; null, wenn die Person nie einen hatte. */
  principalId: string | null;
  email: string | null;
  /** Rollen an der Organisation vor dem Entfernen (Reihenfolge der Tupel). */
  roles: string[];
  /** true: offene Einladung wird zurückgezogen. */
  invitation: boolean;
  /** true: durch die Plattform-Administration. */
  platform: boolean;
};

/** Daten zum Austritt, den der Abgleich mit Keycloak feststellt (`member.left`, z. B. in der Konsole entfernt). */
export type MemberLeftEventData = { userId: string; principalId: string };

export interface IamEventMap {
  'member.removing': MemberEventData;
  'member.removed': MemberEventData;
  'member.left': MemberLeftEventData;
  'access.granted': AccessEventData;
  'access.revoked': AccessEventData;
  'access.expired': AccessEventData;
}
export type IamEventType = keyof IamEventMap;
/** Ereignisse vor einer Änderung (dürfen ablehnen). */
export type IamBeforeType = 'member.removing';
export type IamAfterType = Exclude<IamEventType, IamBeforeType>;

/** Ereignis des Baukastens. */
export type IamEvent<T extends IamEventType = IamEventType> = { [K in T]: {
  type: K;
  /** Mandant der Transaktion (`app.tenant_id()`). */
  tenantId: string;
  /** Betroffenes Subjekt (`user:<principal-id>`, `client:<id>` …); null nur ohne Principal (z. B. Einladung ohne Rollen). */
  subject: string | null;
  /** Wer handelt, wie im Audit (Quelle, Korrelation); Abgleich, Aufräumen und App ohne Angabe: `principal` null, `source` `system`. */
  actor: Actor;
  data: IamEventMap[K];
} }[T];

/**
 * Haken der App. Beide laufen in der Transaktion der Änderung, im Mandantenkontext; Abfragen der App über `tx` sehen den
 * Stand der Änderung.
 */
export interface IamEvents {
  /**
   * Vor einer Änderung, die die App ablehnen darf (bisher `member.removing`), unter der Sperre der Organisation und vor
   * jeder Änderung in Keycloak. Wirft der Haken, unterbleibt die Änderung ganz: ein `HttpError` (z. B.
   * `conflict('…', { reason: '…' })`) geht unverändert als application/problem+json an den Aufrufer, jeder andere Fehler
   * als 500.
   */
  before?(tx: Tx, e: IamEvent<IamBeforeType>): Promise<unknown>;
  /**
   * Nach einer Änderung, in derselben Transaktion (Outbox, Aufgaben). Wirft der Haken, wird die Transaktion
   * zurückgerollt; bereits erfolgte Änderungen in Keycloak (z. B. Mitgliedschaft entfernt) bleiben dann bestehen und
   * stehen im Audit `…_failed`. Ablehnen gehört deshalb in `before`.
   */
  after?(tx: Tx, e: IamEvent<IamAfterType>): Promise<unknown>;
}

/** Wer handelt, wenn der Aufrufer niemanden nennt (z. B. `iam.tuples.grant` der App ohne `actor`). */
export const SYSTEM_ACTOR: Actor = { principal: null, source: 'system', correlationId: null };

/** Mandant der Transaktion. */
export async function txTenant(tx: Pick<Tx, 'query'>): Promise<string> {
  return (await tx.query<{ t: string }>('SELECT app.tenant_id()::text AS t')).rows[0]!.t;
}

/** Ereignis an `after` (ohne Haken: nichts). `tenantId` aus der Transaktion, wenn nicht angegeben. */
export async function emitAfter<T extends IamAfterType>(events: IamEvents | null | undefined, tx: Tx, e: Omit<IamEvent<T>, 'tenantId'> & { tenantId?: string }): Promise<void> {
  if (!events?.after) return;
  await events.after(tx, { ...e, tenantId: e.tenantId ?? await txTenant(tx) } as IamEvent<IamAfterType>);
}

/** Ereignis an `before` (ohne Haken: nichts). */
export async function emitBefore(events: IamEvents | null | undefined, tx: Tx, e: IamEvent<IamBeforeType>): Promise<void> {
  if (events?.before) await events.before(tx, e);
}
