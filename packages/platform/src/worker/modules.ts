/**
 * Produktmodule im Worker (Konzept «Module je Organisation», Abschnitt 6): aktive Module einer Organisation aus
 * `tenant_module` (iam_022), ohne die Rechte zu laden. Wie `Access.modelIn` von @vollholz/iam: Eine Organisation ohne
 * Zeilen (vor der ersten Belegung) gilt als «alles aktiv» – die API belegt sie beim ersten Laden.
 */
import { activeModules, loadModuleRows, type Model } from '@vollholz/iam';
import type { PlatformContext } from '../context.ts';
import type { Db, Tx } from '../db/pool.ts';

type ModuleModel = Pick<Model, 'features' | 'modules' | 'activeModules'>;

/** Aktive Module und Teilfunktionen (aufgelöst, mit Kern) der Organisation der Transaktion. */
export async function activeModulesIn(tx: Pick<Tx, 'query'>, ctx: Pick<PlatformContext, 'schema'>, model: ModuleModel): Promise<ReadonlySet<string>> {
  if (!model.features.modules) return model.activeModules;
  const rows = await loadModuleRows(tx, ctx.schema);
  return rows.length ? activeModules(model, rows) : model.activeModules;
}

/**
 * Aktive Module einer Organisation in einer laufenden Transaktion ohne Mandantenkontext (Rolle _sched, z. B. Outbox):
 * setzt `app.tenant_id` nur für die Abfrage und stellt den vorherigen Wert wieder her.
 */
export async function activeModulesOf(tx: Pick<Tx, 'query'>, ctx: Pick<PlatformContext, 'schema'>, model: ModuleModel, tenantId: string): Promise<ReadonlySet<string>> {
  if (!model.features.modules) return model.activeModules;
  const prev = (await tx.query<{ v: string }>("SELECT coalesce(current_setting('app.tenant_id', true), '') AS v")).rows[0]!.v;
  await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  try { return await activeModulesIn(tx, ctx, model); } finally { await tx.query("SELECT set_config('app.tenant_id', $1, true)", [prev]); }
}

/** Organisation für feste Aufgaben (`ctx.tenants`). */
export interface TaskTenant { id: string; alias: string }

/**
 * Aktive (nicht gesperrte) Organisationen, ohne `modul` alle, sonst nur die, in denen das Modul bzw. die Teilfunktion
 * aktiv ist. Je Organisation eine kurze Transaktion im Mandanten (Pool des Workers).
 */
export async function tenantsWith(db: Db, ctx: Pick<PlatformContext, 'schema'>, model: ModuleModel, modul?: string): Promise<TaskTenant[]> {
  const all = (await db.query<TaskTenant>(
    "SELECT id::text AS id, alias FROM app.platform_tenants() WHERE status = 'active' ORDER BY alias")).rows;
  if (!modul || !model.features.modules) return all;
  const out: TaskTenant[] = [];
  for (const t of all) {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const on = await activeModulesOf(c, ctx, model, t.id);
      await c.query('COMMIT');
      if (on.has(modul)) out.push(t);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally { c.release(); }
  }
  return out;
}
