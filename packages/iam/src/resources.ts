/**
 * Ressourcen der Zugriffsregeln (Spezifikation Kap. 7.1; Entwurf Kap. 5.4, 13.3): Die Kette einer Ressource bis zum
 * Mandanten kennt nur die App. Damit die Entscheidung synchron bleibt (Fähigkeiten über Listen ohne Abfrage je Zeile),
 * lädt das Paket den Zustand der Kette zusammen mit den Zugriffsregeln und fragt die App nur synchron nach der Kette.
 *
 * `load`, `version`, `exists` und `hints` laufen im Mandantenkontext mit `fullContext` (volle Lesesicht der App,
 * Assets: `app.read_all = on`): sonst wäre eine für die Person verborgene Ressource «unbekannt» (404). Was darin
 * gelesen wird, geht nie als Name oder Wert an die Person zurück.
 */
import type pg from 'pg';
import type { AccessService, TenantAccess } from './access.ts';
import type { Principal } from './principal.ts';

export interface ResourceRef { type: string; id?: string | null }

export interface ResourceModel<S = unknown> {
  /** Einstellungen der App für die volle Lesesicht (Assets: `{ 'app.read_all': 'on' }`). */
  fullContext?: Record<string, string>;
  /** Zusatz zur Version des Zwischenspeichers (Assets: max(object_type.updated_at)); leer = nur acl_version. */
  version?(tx: pg.ClientBase): Promise<string>;
  /** Zustand für die Kette, geladen mit den Zugriffsregeln (Assets: Schema und Eltern je Objekttyp). */
  load?(tx: pg.ClientBase): Promise<S>;
  /** Kette von oben nach unten, beginnt mit { type: 'tenant' }; `hint` z. B. Typ eines Objekts. */
  chain(state: S, ref: ResourceRef, hint?: string | null): ResourceRef[];
  /** Gibt es die Ressource im Mandanten? (POST /v1/acl, sonst 404) */
  exists(tx: pg.ClientBase, ref: ResourceRef): Promise<boolean>;
  /** Hinweise für viele Ressourcen auf einmal (GET /v1/acl/effective; Assets: Typ je Objekt), Schlüssel `<type>:<id>`. */
  hints?(tx: pg.ClientBase, refs: ResourceRef[]): Promise<Map<string, string>>;
  /** Zusätzlicher Datenbank-Kontext je Anfrage (Assets: Lesesicht nach Zugriffsregeln). */
  dbContext?(p: Principal, access: AccessService): Promise<Record<string, string>>;
  /** Zusätzliche Felder von `GET /v1/acl/effective` für den geprüften Principal (Assets: `readTypes`, Entwurf 13.2). */
  effectiveExtra?(target: Principal, acl: TenantAccess<S>, access: AccessService): Promise<Record<string, unknown>>;
  /** JSON-Schemas dieser Felder (Name → Schema) für die Antwort und die OpenAPI-Beschreibung. */
  effectiveExtraSchema?: Record<string, unknown>;
}

/** Kette ohne Zustand: jede Ressource direkt unter dem Mandanten. */
export const flatChain = (ref: ResourceRef): ResourceRef[] => (ref.type === 'tenant' ? [{ type: 'tenant' }] : [{ type: 'tenant' }, ref]);

const IDENT = /^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62})?$/;

/**
 * Standard für Ressourcen direkt unter dem Mandanten (Kette `tenant → r`): `exists` über eine Tabelle je Typ mit
 * Spalte `id` (`tables: { note: 'notes.note' }`), unter RLS im Kontext des Mandanten.
 */
export function flatResources(o: { tables: Record<string, string>; fullContext?: Record<string, string> }): ResourceModel<null> {
  for (const [type, table] of Object.entries(o.tables)) if (!IDENT.test(table)) throw new Error(`Tabelle «${table}» für «${type}» ungültig`);
  return {
    ...(o.fullContext ? { fullContext: o.fullContext } : {}),
    chain: (_s, ref) => flatChain(ref),
    async exists(tx, ref) {
      const table = o.tables[ref.type];
      if (!table || !ref.id) return false;
      return ((await tx.query(`SELECT 1 FROM ${table} WHERE id::text = $1`, [ref.id])).rowCount ?? 0) > 0;
    },
  };
}
