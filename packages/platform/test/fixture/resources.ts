/**
 * Ressourcen der App (identity-kit 7.7): Kette der Orte `org → notiz`, Existenz und Klassifizierung. Läuft im
 * Mandantenkontext mit voller Sicht; was hier gelesen wird, geht nie als Wert an die Person zurück.
 * Neuer Typ: Kette, `exists` und – bei `classified` – `classification` ergänzen.
 */
import { flatResources, refKey, type Level, type ResourceModel } from '@vollholz/iam';

const SCHEMA = 'probe';

const TABLES = { notiz: `${SCHEMA}.notiz` };
const CLASSIFIED: Record<string, string> = { notiz: `${SCHEMA}.notiz` };

const flat = flatResources({ tables: TABLES });

export const resources: ResourceModel<null> = {
  ...flat,
  async classification(tx, refs) {
    const out = new Map<string, Level>();
    for (const [type, table] of Object.entries(CLASSIFIED)) {
      const ids = refs.filter(r => r.type === type && r.id).map(r => r.id!);
      if (!ids.length) continue;
      const rows = (await tx.query<{ id: string; c: Level }>(`SELECT id::text, classification AS c FROM ${table} WHERE id = ANY($1::uuid[])`, [ids])).rows;
      for (const r of rows) out.set(refKey({ type, id: r.id }), r.c);
    }
    return out;
  },
};
