/**
 * Ressourcen der App (Spezifikation Kap. 7.7): Die Kette einer Ressource bis zur Organisation, ihre Existenz, ihre
 * Vertraulichkeit und die Zuständigkeit über Fachbeziehungen kennt nur die App. Damit die Entscheidung synchron bleibt
 * (Fähigkeiten über Listen ohne Abfrage je Zeile), lädt das Paket den Zustand der Kette zusammen mit den Tupeln
 * (`load`, zwischengespeichert bis `acl_version` oder `version` sich ändert) und fragt die App nur synchron nach der Kette.
 *
 * `load`, `version`, `exists`, `hints`, `classification`, `ids` und die SQL von `edges` laufen im Mandantenkontext mit
 * voller Sicht (`app.read_all`, `app.write_all` = on, `app.clearance` = 2): sonst wäre eine für die Person verborgene
 * Ressource «unbekannt». Was darin gelesen wird, geht nie als Name oder Wert an die Person zurück.
 */
import type pg from 'pg';
import type { Level } from './model.ts';

/** Ort einer Freigabe; `id` leer genau bei `org`. */
export interface ResourceRef { type: string; id?: string | null }

export interface ResourceModel<S = unknown> {
  /** Zustand der Kette, geladen mit den Tupeln, zwischengespeichert bis acl_version oder version sich ändert. */
  load?(tx: pg.ClientBase): Promise<S>;
  /** Muss sich mit jeder Änderung der Daten ändern, aus denen `load` die Kette baut (Anlegen, Verschieben). */
  version?(tx: pg.ClientBase): Promise<string>;
  /** Kette von oben, beginnt mit { type: 'org' }, endet mit ref; mit self-Vorfahren. hint z. B. Typ eines Objekts. */
  chain(state: S, ref: ResourceRef, hint?: string | null): ResourceRef[];
  /** Gibt es die Ressource im Mandanten (volle Sicht)? Sonst 404 bei /v1/access. */
  exists(tx: pg.ClientBase, ref: ResourceRef): Promise<boolean>;
  /** Hinweise für viele Ressourcen (Assets: Typ je Objekt), Schlüssel `<type>:<id>`. */
  hints?(tx: pg.ClientBase, refs: ResourceRef[]): Promise<Map<string, string>>;
  /** Pflicht bei classified-Typen: Stufe je Ressource, Schlüssel `<type>:<id>` (volle Sicht). */
  classification?(tx: pg.ClientBase, refs: ResourceRef[]): Promise<Map<string, Level>>;
  /**
   * IDs aller Ressourcen eines Typs aus dem Zustand (nur Typen über dem Blatt). Pflicht, wenn der Elterntyp des Blatts
   * `self` hat oder selbst nicht direkt unter `org` hängt: sonst lässt sich `app.read_types()` für Rollen an Vorfahren
   * nicht berechnen (Ergänzung zu Kap. 7.7, siehe PR «Offene Punkte»).
   */
  ids?(state: S, type: string): Iterable<string>;
  /** Pflicht bei Typen mit scope: Zuständigkeit als SQL der App (volle Sicht, Parameter $1 uuid[]). */
  edges?: {
    /** Typ der Einheiten; hat `member` in `relations`. */
    unit: string;
    /** Direkt untergeordnete Einheiten von $1 über Kanten mit inherits_scope; Spalte `id uuid`. */
    children: string;
    /** Zugehörigkeit der Ressourcen $1; Spalten `id uuid`, `unit_id uuid`, `grants text` ('read' | 'edit'), `label text`. */
    belongs: string;
    /**
     * Zuständige Personen der Ressourcen $1 aus Fachdaten (Kit 1.1; Assets: Attribut «Verantwortlich» der Art user);
     * Spalten `id uuid` (Ressource), `principal_id uuid` (`principal.id` einer Person), `grants text`
     * ('read' | 'edit' | 'none'), `label text` (Name der Fachbeziehung, erscheint in «Warum?»). Dasselbe SQL dient einer
     * und vielen Ressourcen (`can`, `capabilities(refs)`). Lesesicht: `app.read_person()`, `app.write_person()`.
     */
    persons?: string;
    /**
     * Wirkungen der Person $1 (uuid, `principal.id`) über alle Ressourcen; Spalte `grants text`. Nur für «Recht
     * irgendwo» (`needSomewhere`, `somewhere` in `/auth/me`); ohne zählt die Zuständigkeit über Personen dort nicht.
     */
    personGrants?: string;
  };
}

/** Schlüssel einer Ressource in Karten (`<type>:<id>`, an `org`: `org:`). */
export const refKey = (r: ResourceRef) => `${r.type}:${r.id ?? ''}`;

/** Kette ohne Zustand: jede Ressource direkt unter der Organisation. */
export const flatChain = (ref: ResourceRef): ResourceRef[] => (ref.type === 'org' ? [{ type: 'org' }] : [{ type: 'org' }, ref]);

const IDENT = /^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62})?$/;

/**
 * Standard für Ressourcen direkt unter der Organisation (Kette `org → r`): `exists` über eine Tabelle je Typ mit
 * Spalte `id` (`tables: { note: 'notes.note' }`), unter RLS im Kontext des Mandanten (volle Sicht).
 */
export function flatResources(o: { tables: Record<string, string> }): ResourceModel<null> {
  for (const [type, table] of Object.entries(o.tables)) if (!IDENT.test(table)) throw new Error(`Tabelle «${table}» für «${type}» ungültig`);
  return {
    chain: (_s, ref) => flatChain(ref),
    async exists(tx, ref) {
      if (ref.type === 'org') return true;
      const table = o.tables[ref.type];
      if (!table || !ref.id) return false;
      return ((await tx.query(`SELECT 1 FROM ${table} WHERE id::text = $1`, [ref.id])).rowCount ?? 0) > 0;
    },
  };
}
