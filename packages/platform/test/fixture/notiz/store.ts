/**
 * Datenzugriff der Notizen. Läuft immer in einer Transaktion mit Mandantenkontext; was die Person nicht sehen
 * darf, filtert die Lesesicht (RLS) – die Abfragen hier kennen keine Rechte.
 */
import type { Tx } from '../../../src/index.ts';

const SCHEMA = 'probe';
import type { NotizCreateIn, NotizPatchIn } from './schemas.ts';

export interface Row {
  id: string; label: string; beginn: string | null; ende: string | null; classification: 0 | 1 | 2; version: number;
  created_at: Date; created_by: string | null; updated_at: Date; updated_by: string | null;
}

const T = `${SCHEMA}.notiz`;
const COLS = `id, label, to_char(beginn, 'HH24:MI') AS beginn, to_char(ende, 'HH24:MI') AS ende, classification, version, created_at, created_by, updated_at, updated_by`;

export async function list(tx: Tx, o: { q?: string; after?: { label: string; id: string } | null; limit: number }): Promise<Row[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (o.q) { args.push(`%${o.q.replace(/[\\%_]/g, m => `\\${m}`)}%`); where.push(`label ILIKE $${args.length}`); }
  if (o.after) { args.push(o.after.label, o.after.id); where.push(`(label, id) > ($${args.length - 1}, $${args.length}::uuid)`); }
  args.push(o.limit + 1);
  return (await tx.query<Row>(`SELECT ${COLS} FROM ${T} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY label, id LIMIT $${args.length}`, args)).rows;
}

export async function get(tx: Tx, id: string): Promise<Row | null> {
  return (await tx.query<Row>(`SELECT ${COLS} FROM ${T} WHERE id = $1`, [id])).rows[0] ?? null;
}

export async function create(tx: Tx, input: NotizCreateIn): Promise<Row> {
  return (await tx.query<Row>(
    `INSERT INTO ${T} (tenant_id, label, beginn, ende, classification) VALUES (app.tenant_id(), btrim($1), $2, $3, $4) RETURNING ${COLS}`,
    [input.label, input.beginn ?? null, input.ende ?? null, input.classification ?? 0])).rows[0]!;
}

/** Ändert nur bei passender Version; null, wenn nicht (mehr) vorhanden oder Version abweicht. */
export async function update(tx: Tx, id: string, version: number, patch: NotizPatchIn): Promise<Row | null> {
  const sets: string[] = [];
  const args: unknown[] = [id, version];
  for (const k of ['label', 'beginn', 'ende', 'classification'] as const) {
    if (patch[k] === undefined) continue;
    args.push(k === 'label' ? String(patch[k]).trim() : patch[k]);
    sets.push(`${k} = $${args.length}`);
  }
  return (await tx.query<Row>(`UPDATE ${T} SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING ${COLS}`, args)).rows[0] ?? null;
}

export async function remove(tx: Tx, id: string, version: number): Promise<boolean> {
  return ((await tx.query(`DELETE FROM ${T} WHERE id = $1 AND version = $2`, [id, version])).rowCount ?? 0) > 0;
}

export interface VersionRow { version: number; action: 'created' | 'updated' | 'deleted'; label: string; beginn: string | null; ende: string | null; classification: 0 | 1 | 2; changed_at: Date; changed_by: string | null }

export async function history(tx: Tx, id: string): Promise<VersionRow[]> {
  return (await tx.query<VersionRow>(
    `SELECT version, action, label, to_char(beginn, 'HH24:MI') AS beginn, to_char(ende, 'HH24:MI') AS ende, classification, changed_at, changed_by
       FROM ${SCHEMA}.notiz_version WHERE notiz_id = $1 ORDER BY version DESC`, [id])).rows;
}

/** Nachtarbeit nach ArG Art. 16: Zeitraum zwischen 23 und 6 Uhr berührt. */
export function nachtarbeit(beginn: string | null, ende: string | null): boolean {
  if (!beginn || !ende) return false;
  const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const b = min(beginn), e = min(ende);
  const ranges = e > b ? [[b, e]] : [[b, 1440], [0, e]];
  return ranges.some(([from, to]) => from! < 360 || to! > 1380);
}
