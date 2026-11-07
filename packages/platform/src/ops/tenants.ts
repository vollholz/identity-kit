/**
 * Mandanten über alle Organisationen für den Betrieb (Befehl `tenant` der CLI): auflisten,
 * anlegen, sperren, entsperren, löschen. Auflisten und Status über die Funktionen von @vollholz/iam (SECURITY DEFINER),
 * Anlegen und Status mit Protokoll in der Transaktion der Laufzeit; Löschen nur gesperrter Mandanten, mit
 * Bestätigung des Alias, als Besitzer-Rolle und im Protokoll der Plattform.
 *
 * Produktmodule (Konzept «Module je Organisation», Abschnitt 7): `tenant create --paket` legt nur die Module des Pakets
 * erlaubt und aktiv an (mit `einrichten` der App), dessen `off`-Teilfunktionen erlaubt und aus; `tenant modules` liest,
 * gibt frei, entzieht oder wendet ein Paket erneut an – über `TenantModules` von @vollholz/iam (Voraussetzungen,
 * Hindernisse, Audit, Ereignisse) in einer Transaktion der Laufzeit.
 */
import {
  createTenant, findTenant, listTenants, pgAudit, setTenantStatus, TenantModules, withTenant, writePlatformAudit,
  type Actor, type AuditPort, type Db, type IamEvents, type Model, type ModuleActing, type ModuleHooks, type ModuleState, type TenantRow,
} from '@vollholz/iam';
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

/** Was die Befehle für Produktmodule brauchen (`defineApp` setzt es). */
export interface TenantModulesContext {
  model: Model;
  audit: AuditPort;
  events?: IamEvents | null;
  /** Haken der App, wie `createIam` sie erhält (`nachholen` reiht den Auftrag ein). */
  hooks?: ModuleHooks | null;
}

/** Änderung durch `tenant modules` (ohne Angabe: nur lesen). */
export interface TenantModulesChange {
  /** Module bzw. Teilfunktionen freigeben (aktiviert nichts). */
  erlauben?: readonly string[];
  /** Module bzw. Teilfunktionen entziehen (deaktiviert mit; abhängige aktive Module 409, Hindernisse 409 ohne `force`). */
  entziehen?: readonly string[];
  /**
   * Paket erneut anwenden: erlaubt genau dessen Module (andere werden entzogen), aktiviert sie und schaltet die
   * Teilfunktionen wie im Paket (`off` aus, sonst an).
   */
  paket?: string;
  /** Mit `paket`: nur Freigaben setzen, aktiv unverändert lassen (Entziehen deaktiviert trotzdem). */
  nurErlauben?: boolean;
  /** Hindernisse der App beim Entziehen übergehen. */
  force?: boolean;
}

export interface TenantModulesResult {
  tenant: TenantRow;
  /** Paket, falls angewendet. */
  paket?: string;
  /** Zustand je Modul und Teilfunktion nach der Änderung. */
  modules: ModuleState[];
}

/** Aufruf falsch (unbekanntes Paket oder Modul, Modell ohne `modules`): Befehlszeile Exit 64. */
export class TenantUsageError extends Error {}

const OPS_MODULES: Actor = { principal: null, source: 'system', correlationId: 'ops:tenant-modules' };

function servicesOf(p: PlatformContext, m: TenantModulesContext): TenantModules {
  if (!m.model.features.modules) throw new TenantUsageError('Das Modell der App hat keine Produktmodule (modules)');
  return new TenantModules({ schema: p.schema, model: m.model, audit: m.audit, events: m.events ?? null, hooks: m.hooks ?? null });
}

function packageOf(model: Model, key: string) {
  const pkg = model.packages.find(x => x.key === key);
  if (!pkg) throw new TenantUsageError(`Paket «${key}» nicht im Modell (bekannt: ${model.packages.map(x => x.key).join(', ') || 'keine'})`);
  return pkg;
}

function checkKeys(model: Model, keys: readonly string[]): void {
  const known = new Set(model.modules.flatMap(m => [m.key, ...m.parts.map(x => x.key)]));
  const unknown = keys.filter(k => !known.has(k));
  if (unknown.length) throw new TenantUsageError(`Unbekannte Module: ${unknown.join(', ')}`);
}

/** Module in einer Reihenfolge, in der Voraussetzungen vor dem Modul stehen (das Modell ist zyklenfrei). */
function ordered(model: Model, keys: readonly string[]): string[] {
  const want = new Set(keys), out: string[] = [], done = new Set<string>();
  const satisfied = (k: string) => model.modules.find(m => m.key === k)!.requires
    .every(r => (typeof r === 'string' ? done.has(r) || !want.has(r) : r.some(a => done.has(a)) || !r.some(a => want.has(a))));
  while (out.length < want.size) {
    const next = model.modules.find(m => want.has(m.key) && !done.has(m.key) && satisfied(m.key));
    if (!next) { out.push(...model.modules.filter(m => want.has(m.key) && !done.has(m.key)).map(m => m.key)); break; }
    out.push(next.key); done.add(next.key);
  }
  return out;
}

/**
 * Legt einen Mandanten an. Mit `paket` (nur mit `modules` im Modell): Kern und die Module des Pakets erlaubt und aktiv
 * (`einrichten` der App je Modul und eingeschalteter Teilfunktion, Ereignisse `module.activated`), `off`-Teilfunktionen
 * erlaubt und aus, alle anderen Module nicht erlaubt. Ohne Paket wie bisher: beim ersten Laden alle Module.
 */
export async function tenantCreate(p: PlatformContext, d: TenantDbs, alias: string, name?: string, o: Partial<TenantModulesContext> & { paket?: string } = {}): Promise<TenantRow> {
  if (!o.paket) return createTenant(ctxOf(p), d.admin, d.runtime, alias, name);
  if (!o.model || !o.audit) throw new TenantUsageError('tenant create --paket: Modell und Audit fehlen');
  const m = { model: o.model, audit: o.audit, events: o.events ?? null, hooks: o.hooks ?? null };
  const svc = servicesOf(p, m);
  const pkg = packageOf(m.model, o.paket);
  const before = await findTenant(d.admin, alias);
  if (before && await hasModuleRows(p, d.admin, before.id)) throw new Error(`Mandant «${before.alias}» hat schon Module: tenant modules ${before.alias} --paket ${pkg.key}`);
  const t = await createTenant(ctxOf(p), d.admin, d.runtime, alias, name);
  // Besitzer-Rolle: Kern und off-Teilfunktionen ohne Zeitstempel (die Laufzeit schreibt nur über die Funktionen, die
  // ein Ausschalten als Deaktivieren zählen würden; beim ersten Aktivieren soll `einrichten` laufen, nicht `nachholen`).
  // Danach hat die Organisation Zeilen: Das Sicherheitsnetz beim Laden schaltet nicht mehr alles ein.
  await withTenant(d.admin, { tenantId: t.id }, async tx => {
    await tx.query(
      `INSERT INTO ${p.schema}.tenant_module (tenant_id, module, allowed, active, active_since)
       SELECT $1, k, true, k = $2, CASE WHEN k = $2 THEN now() END FROM unnest($3::text[]) AS k ON CONFLICT DO NOTHING`,
      [t.id, m.model.coreModule, [m.model.coreModule, ...pkg.off]]);
  });
  const acting: ModuleActing = { tenantId: t.id, actor: OPS_MODULES, platform: true };
  try {
    await provision();
  } catch (e) {
    // Scheitert die Belegung (z. B. ein Haken der App), die Zeilen der Besitzer-Rolle wieder entfernen: Die
    // Organisation war vorher ohne Module (oben geprüft), ein erneutes `tenant create --paket` beginnt von vorn
    await withTenant(d.admin, { tenantId: t.id }, tx => tx.query(`DELETE FROM ${p.schema}.tenant_module WHERE tenant_id = $1`, [t.id]));
    throw e;
  }
  return t;

  async function provision() { await withTenant(d.runtime, { tenantId: t.id }, async tx => {
    for (const k of ordered(m.model, pkg.modules.filter(x => x !== m.model.coreModule))) {
      await svc.setAllowed(tx, acting, k, true);
      await svc.setActive(tx, acting, k, true);
    }
    // Kern und eingeschaltete Teilfunktionen (ohne eigene Zeile aktiv mit ihrem Modul): einrichten wie beim ersten Laden
    const off = new Set(pkg.off);
    for (const mod of m.model.modules.filter(x => pkg.modules.includes(x.key))) {
      for (const k of [...(mod.core ? [mod.key] : []), ...mod.parts.map(x => x.key).filter(x => !off.has(x))]) await svc.hooks[k]?.einrichten?.(tx, t.id);
    }
    await m.audit.write(tx, OPS_MODULES, { action: 'tenant.module_package', resourceType: 'tenant', resourceId: t.id, data: { paket: pkg.key, modules: [...pkg.modules], off: [...pkg.off] } });
  }); }
}

async function hasModuleRows(p: PlatformContext, admin: Db, tenantId: string): Promise<boolean> {
  return withTenant(admin, { tenantId }, async tx => (await tx.query(`SELECT 1 FROM ${p.schema}.tenant_module WHERE tenant_id = $1 LIMIT 1`, [tenantId])).rowCount! > 0);
}

/**
 * Module einer Organisation (Betrieb): ohne Änderung lesen; `erlauben`/`entziehen` je Schlüssel; `paket` wendet ein
 * Paket erneut an (siehe `TenantModulesChange`). Alles in einer Transaktion: scheitert ein Schritt (Voraussetzung,
 * abhängiges Modul, Hindernis), bleibt alles unverändert.
 */
export async function tenantModules(p: PlatformContext, d: TenantDbs, alias: string, m: TenantModulesContext, c: TenantModulesChange = {}): Promise<TenantModulesResult> {
  const svc = servicesOf(p, m);
  const { model } = m;
  checkKeys(model, [...(c.erlauben ?? []), ...(c.entziehen ?? [])]);
  const pkg = c.paket ? packageOf(model, c.paket) : null;
  if (c.nurErlauben && !pkg) throw new TenantUsageError('--nur-erlauben nur mit --paket');
  const t = await findTenant(d.admin, alias);
  if (!t) throw new Error(`Mandant «${alias}» nicht gefunden`);
  const acting: ModuleActing = { tenantId: t.id, actor: OPS_MODULES, platform: true };
  const force = c.force ? { force: true } : {};
  const modules = await withTenant(d.runtime, { tenantId: t.id }, async tx => {
    for (const k of c.erlauben ?? []) await svc.setAllowed(tx, acting, k, true);
    for (const k of c.entziehen ?? []) await svc.setAllowed(tx, acting, k, false, force);
    if (pkg) {
      const inPkg = new Set(pkg.modules), off = new Set(pkg.off);
      // Zuerst freigeben und aktivieren, was im Paket ist (Ersatz für eine Voraussetzung «eines von» steht dann schon),
      // danach entziehen, was nicht im Paket ist (abhängige Module zuerst)
      const keep = ordered(model, pkg.modules.filter(x => x !== model.coreModule));
      for (const k of keep) await svc.setAllowed(tx, acting, k, true);
      for (const mod of model.modules.filter(x => inPkg.has(x.key))) for (const part of mod.parts) await svc.setAllowed(tx, acting, part.key, true);
      if (!c.nurErlauben) for (const k of keep) await svc.setActive(tx, acting, k, true);
      const out = model.modules.filter(x => !x.core && !inPkg.has(x.key)).map(x => x.key);
      for (const k of ordered(model, out).reverse()) await svc.setAllowed(tx, acting, k, false, force);
      if (!c.nurErlauben) {
        for (const mod of model.modules.filter(x => inPkg.has(x.key))) {
          for (const part of mod.parts) await svc.setActive(tx, acting, part.key, !off.has(part.key));
        }
      }
      await m.audit.write(tx, OPS_MODULES, { action: 'tenant.module_package', resourceType: 'tenant', resourceId: t.id, data: { paket: pkg.key, nurErlauben: !!c.nurErlauben } });
    }
    return svc.list(tx);
  });
  return { tenant: t, ...(pkg ? { paket: pkg.key } : {}), modules };
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
