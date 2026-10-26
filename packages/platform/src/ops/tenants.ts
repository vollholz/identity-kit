/**
 * Mandanten über alle Organisationen für den Betrieb (Befehl `tenant` der CLI): auflisten,
 * anlegen, sperren, entsperren, löschen. Auflisten und Status über die Funktionen von @vollholz/iam (SECURITY DEFINER),
 * Anlegen und Status mit Protokoll in der Transaktion der Laufzeit; Löschen nur gesperrter Mandanten, mit
 * Bestätigung des Alias, als Besitzer-Rolle und im Protokoll der Plattform.
 */
import { createTenant, findTenant, listTenants, pgAudit, setTenantStatus, writePlatformAudit, type Actor, type Db, type TenantRow } from '@vollholz/iam';
import type { PlatformContext } from '../context.ts';

export interface TenantDbs {
  /** Besitzer-Rolle (DATABASE_ADMIN_URL). */
  admin: Db;
  /** Laufzeit (DATABASE_URL): Anlage und Statuswechsel mit Protokoll im Mandanten. */
  runtime: Db;
}

const ctxOf = (p: PlatformContext) => ({ schema: p.schema, audit: pgAudit({ schema: p.schema }) });
const OPS: Actor = { principal: null, source: 'system', correlationId: 'ops:tenant-admin' };

export const tenantList = (d: TenantDbs): Promise<TenantRow[]> => listTenants(d.admin);

export function tenantCreate(p: PlatformContext, d: TenantDbs, alias: string, name?: string): Promise<TenantRow> {
  return createTenant(ctxOf(p), d.admin, d.runtime, alias, name);
}

export function tenantSuspend(p: PlatformContext, d: TenantDbs, alias: string, reason = ''): Promise<TenantRow> {
  return setTenantStatus(ctxOf(p), d.admin, d.runtime, alias, 'suspended', reason);
}

export function tenantResume(p: PlatformContext, d: TenantDbs, alias: string): Promise<TenantRow> {
  return setTenantStatus(ctxOf(p), d.admin, d.runtime, alias, 'active');
}

/**
 * Löscht einen gesperrten Mandanten samt aller Daten (ON DELETE CASCADE an den Tabellen). `confirm` muss dem Alias
 * entsprechen. Der Eintrag bleibt im Protokoll der Plattform (das Protokoll des Mandanten geht mit ihm).
 */
export async function tenantDelete(p: PlatformContext, d: TenantDbs, alias: string, confirm: string): Promise<TenantRow> {
  const t = await findTenant(d.admin, alias);
  if (!t) throw new Error(`Mandant «${alias}» nicht gefunden`);
  if (confirm !== t.alias) throw new Error(`Bestätigung passt nicht: --confirm ${t.alias} angeben`);
  if (t.status !== 'suspended') throw new Error(`Mandant «${t.alias}» ist nicht gesperrt: zuerst sperren (suspend), dann löschen`);
  const c = await d.admin.connect();
  try {
    await c.query('BEGIN');
    await writePlatformAudit(c, OPS, { action: 'tenant.deleted', resourceType: 'tenant', resourceId: t.id, orgId: null, data: { alias: t.alias, name: t.name } });
    // Nur in dieser Transaktion (DDL ist transaktional, ROLLBACK stellt alles wieder her): FORCE RLS aus, damit die
    // Besitzer-Rolle alle Zeilen des Mandanten sieht, und Trigger aus (Verlauf und unveränderliches Protokoll würden
    // beim Löschen schreiben bzw. abbrechen). Andere Mandanten sind über die Bedingung tenant_id ausgeschlossen.
    const tables = (await c.query<{ t: string; trig: boolean }>(
      `SELECT c.relname AS t, EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal) AS trig
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname <> 'tenant'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`, [p.schema])).rows;
    for (const x of tables) {
      await c.query(`ALTER TABLE ${p.schema}.${x.t} NO FORCE ROW LEVEL SECURITY`);
      if (x.trig) await c.query(`ALTER TABLE ${p.schema}.${x.t} DISABLE TRIGGER USER`);
    }
    // Reihenfolge der Fremdschlüssel unbekannt: wiederholen, bis alles leer ist (je Tabelle mit Sicherungspunkt)
    let open = tables.map(x => x.t);
    while (open.length) {
      const failed: string[] = [];
      for (const table of open) {
        await c.query('SAVEPOINT t');
        try { await c.query(`DELETE FROM ${p.schema}.${table} WHERE tenant_id = $1`, [t.id]); await c.query('RELEASE SAVEPOINT t'); }
        catch { await c.query('ROLLBACK TO SAVEPOINT t'); failed.push(table); }
      }
      if (failed.length === open.length) throw new Error(`Daten des Mandanten nicht löschbar: ${failed.join(', ')}`);
      open = failed;
    }
    const n = (await c.query(`DELETE FROM ${p.schema}.tenant WHERE id = $1`, [t.id])).rowCount;
    if (n !== 1) throw new Error(`Mandant «${t.alias}» konnte nicht gelöscht werden`);
    for (const x of tables) {
      await c.query(`ALTER TABLE ${p.schema}.${x.t} FORCE ROW LEVEL SECURITY`);
      if (x.trig) await c.query(`ALTER TABLE ${p.schema}.${x.t} ENABLE TRIGGER USER`);
    }
    await c.query('COMMIT');
    return t;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { c.release(); }
}
