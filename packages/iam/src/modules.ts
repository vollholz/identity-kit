/**
 * Produktmodule je Organisation (Konzept «Module je Organisation», Abschnitte 3–5, 7): Zustand aus `tenant_module`
 * (iam_022), Aktivieren und Deaktivieren durch die Organisation (`tenant:admin`), Freigeben und Entziehen durch den
 * Betrieb, Haken der App und Ereignisse.
 *
 * Zustand (Datenbank kennt das Modell nicht, das Paket löst auf):
 * - Kern: immer erlaubt und aktiv.
 * - Modul: erlaubt bzw. aktiv laut Zeile; ohne Zeile weder noch.
 * - Teilfunktion `modul.teil`: erlaubt, wenn ihr Modul erlaubt ist und ihre Zeile (falls vorhanden) es nicht verbietet;
 *   aktiv, wenn ihr Modul aktiv ist und ihre Zeile (falls vorhanden) aktiv ist.
 *
 * Regeln beim Aktivieren (`setActive`): unbekannt 404; Kern 409 `kern`; nicht erlaubt 403 `modul-nicht-erlaubt`;
 * Voraussetzung inaktiv 409 `voraussetzung-fehlt` (`fehlt`); Teilfunktion ohne aktives Modul 409 `modul-inaktiv`.
 * Beim Deaktivieren: aktives Modul braucht es 409 `abhaengig-aktiv` (`module`); Hindernisse der App 409 `hindernisse`.
 * Erstes Aktivieren ruft `einrichten`, erneutes `nachholen` (mit `seit` = letztes Deaktivieren), beides in der
 * Transaktion; danach `module.activated` bzw. `module.deactivated` an `IamEvents.after`. Audit `tenant.module_active`
 * (Organisation) bzw. `tenant.module_allowed` (Betrieb; mit `platformAdmin` auch im Protokoll der Plattform).
 *
 * Das Paket bleibt app-agnostisch: Namen, Texte und Hindernisse kommen aus dem Modell bzw. den Haken der App.
 */
import type { Actor, AuditPort } from './audit.ts';
import { schemaName, type Tx } from './db.ts';
import { conflict, forbidden, HttpError, notFound } from './errors.ts';
import { emitAfter, type IamEvents } from './events.ts';
import type { Model, ModuleInfo } from './model.ts';

/** Zeile von `tenant_module`. */
export interface ModuleRow {
  module: string; allowed: boolean; active: boolean;
  active_since: Date | null; inactive_since: Date | null; changed_at: Date; changed_by: string | null;
}

/** Hindernis vor dem Deaktivieren (aus `hindernisse` der App), z. B. offene Anträge. */
export interface ModuleBlocker { key: string; text: string; anzahl?: number }

/**
 * Haken der App je Produktmodul (Schlüssel des Moduls oder `modul.teil`), alle in der Transaktion der Änderung im
 * Kontext der Organisation. `@vollholz/platform` reicht sie aus `defineApp({ moduleHooks })` durch (`nachholen` reiht
 * dort einen Auftrag ein).
 */
export interface ModuleHook {
  /** Erstes Aktivieren (vorher nie aktiv), z. B. Standarddaten anlegen. */
  einrichten?(tx: Tx, tenantId: string): Promise<unknown>;
  /** Vor dem Deaktivieren und in `GET /v1/tenant/modules` (mit `tenant:admin`): leer = darf deaktiviert werden. */
  hindernisse?(tx: Tx, tenantId: string): Promise<readonly ModuleBlocker[]>;
  /** Erneutes Aktivieren: Wirkung der inaktiven Zeit nachholen (`seit` = letztes Deaktivieren). */
  nachholen?(tx: Tx, tenantId: string, seit: Date): Promise<unknown>;
}
export type ModuleHooks = Readonly<Record<string, ModuleHook>>;

/** Zustand eines Moduls bzw. einer Teilfunktion in einer Organisation (`GET /v1/tenant/modules`). */
export interface ModuleState {
  key: string; label: string; description: string; core: boolean;
  requires: readonly (string | readonly string[])[];
  /** Modul einer Teilfunktion, sonst null. */
  module: string | null;
  allowed: boolean; active: boolean; activeSince: Date | null;
}

const isPart = (k: string) => k.includes('.');
const parentOf = (k: string) => k.split('.')[0]!;

/** Zeilen von `tenant_module` der Organisation der Transaktion. */
export async function loadModuleRows(tx: Pick<Tx, 'query'>, schema: string): Promise<ModuleRow[]> {
  return (await tx.query<ModuleRow>(`SELECT module, allowed, active, active_since, inactive_since, changed_at, changed_by FROM ${schemaName(schema)}.tenant_module ORDER BY module`)).rows;
}

/** Zustand aller Module und Teilfunktionen des Modells (Reihenfolge des Modells, Teilfunktionen nach ihrem Modul). */
export function moduleStates(model: Pick<Model, 'modules'>, rows: readonly ModuleRow[]): ModuleState[] {
  const byKey = new Map(rows.map(r => [r.module, r]));
  const out: ModuleState[] = [];
  for (const m of model.modules) {
    const r = byKey.get(m.key);
    const allowed = m.core || !!r?.allowed, active = m.core || (!!r?.active && allowed);
    out.push({ key: m.key, label: m.label, description: m.description, core: m.core, requires: m.requires, module: null, allowed, active, activeSince: r?.active_since ?? null });
    for (const p of m.parts) {
      const pr = byKey.get(p.key);
      const pAllowed = allowed && (pr ? pr.allowed : true), pActive = active && pAllowed && (pr ? pr.active : true);
      out.push({ key: p.key, label: p.label, description: p.description, core: false, requires: [], module: m.key, allowed: pAllowed, active: pActive, activeSince: pr?.active_since ?? r?.active_since ?? null });
    }
  }
  return out;
}

/** Aktive Module und Teilfunktionen (aufgelöst, mit Kern) für `Model.withModules`. */
export function activeModules(model: Pick<Model, 'modules'>, rows: readonly ModuleRow[]): Set<string> {
  return new Set(moduleStates(model, rows).filter(s => s.active).map(s => s.key));
}

/** Schlüssel für die erste Belegung (alle Module mit Kern, ohne Teilfunktionen). */
export const backfillKeys = (model: Pick<Model, 'modules'>) => model.modules.map(m => m.key);

/** Organisation ohne Zeilen: alle Module erlaubt und aktiv (`app.backfill_modules`), protokolliert. Liefert true, wenn belegt. */
export async function backfillModules(tx: Tx, model: Pick<Model, 'modules'>, audit: AuditPort | null, actor: Actor): Promise<boolean> {
  const keys = backfillKeys(model);
  const n = (await tx.query<{ n: number }>('SELECT app.backfill_modules($1) AS n', [keys])).rows[0]!.n;
  if (n && audit) await audit.write(tx, actor, { action: 'tenant.module_backfill', resourceType: 'tenant', resourceId: (await tx.query<{ t: string }>('SELECT app.tenant_id()::text AS t')).rows[0]!.t, data: { modules: keys } });
  return n > 0;
}

/** Wer handelt und für wen (Organisation selbst oder Plattform-Administration). */
export interface ModuleActing {
  tenantId: string;
  actor: Actor;
  /** true: Plattform-Administration (Audit zusätzlich im Protokoll der Plattform). */
  platform: boolean;
}

export interface TenantModulesOptions {
  schema: string;
  /** Modell der App (mit `modules`). */
  model: Model;
  audit: AuditPort;
  events?: IamEvents | null;
  hooks?: ModuleHooks | null;
  /** Nach jeder Änderung (Zwischenspeicher der Rechte vergessen). */
  invalidate?: (tenantId: string) => void;
}

/** Module einer Organisation lesen und schalten (Transaktion im Kontext der Organisation). */
export class TenantModules {
  private readonly S: string;
  readonly model: Model;
  private readonly audit: AuditPort;
  private readonly events: IamEvents | null;
  readonly hooks: ModuleHooks;
  private readonly invalidate: (tenantId: string) => void;

  constructor(o: TenantModulesOptions) {
    this.S = schemaName(o.schema); this.model = o.model; this.audit = o.audit; this.events = o.events ?? null; this.hooks = o.hooks ?? {};
    this.invalidate = o.invalidate ?? (() => {});
    const known = new Set(o.model.modules.flatMap(m => [m.key, ...m.parts.map(p => p.key)]));
    const unknown = Object.keys(this.hooks).filter(k => !known.has(k));
    if (unknown.length) throw new Error(`moduleHooks: ${unknown.map(k => `«${k}»`).join(', ')} nicht im Modell (modules)`);
  }

  private info(key: string): { module: ModuleInfo; part: { key: string; label: string } | null } {
    const m = this.model.modules.find(x => x.key === parentOf(key));
    const part = m && isPart(key) ? m.parts.find(p => p.key === key) ?? null : null;
    if (!m || (isPart(key) && !part)) throw notFound(`Modul «${key}»`);
    return { module: m, part };
  }

  private label(key: string): string {
    return this.model.modules.find(m => m.key === key)?.label ?? this.model.modules.flatMap(m => m.parts).find(p => p.key === key)?.label ?? key;
  }

  /** Zustand aller Module (Transaktion im Mandanten); ohne Zeilen zuerst alle erlaubt und aktiv (Sicherheitsnetz). */
  async list(tx: Tx): Promise<ModuleState[]> {
    return moduleStates(this.model, await this.rows(tx));
  }

  private async rows(tx: Tx): Promise<ModuleRow[]> {
    let rows = await loadModuleRows(tx, this.S);
    if (!rows.length && this.model.features.modules) {
      await this.seed(tx, (await tx.query<{ t: string }>('SELECT app.tenant_id()::text AS t')).rows[0]!.t);
      rows = await loadModuleRows(tx, this.S);
    }
    return rows;
  }

  /**
   * Neue Organisation ohne Zeilen (nach dem Abgleich in `migrate` angelegt): alle Module erlaubt und aktiv, wie beim
   * ersten Aktivieren mit `einrichten` je Modul und Teilfunktion (Reihenfolge des Modells), protokolliert. Bestehende
   * Organisationen belegt `migrate` ohne Haken (sie haben ihre Daten schon). Liefert true, wenn belegt.
   */
  async seed(tx: Tx, tenantId: string): Promise<boolean> {
    if (!await backfillModules(tx, this.model, this.audit, { principal: null, source: 'system', correlationId: 'iam:module-backfill' })) return false;
    for (const m of this.model.modules) {
      for (const k of [m.key, ...m.parts.map(p => p.key)]) await this.hooks[k]?.einrichten?.(tx, tenantId);
    }
    return true;
  }

  /**
   * Schaltungen einer Organisation nacheinander: sperrt die Zeile des Mandanten bis zum Ende der Transaktion, bevor
   * Zustand und Voraussetzungen gelesen werden (sonst könnten zwei gleichzeitige Änderungen je für sich gültig sein und
   * zusammen `requires` verletzen).
   */
  private async lock(tx: Tx): Promise<void> {
    await tx.query(`SELECT 1 FROM ${this.S}.tenant WHERE id = app.tenant_id() FOR UPDATE`);
  }

  /** Hindernisse der App vor dem Deaktivieren (leer ohne Haken). */
  async blockers(tx: Tx, tenantId: string, key: string): Promise<ModuleBlocker[]> {
    return [...(await this.hooks[key]?.hindernisse?.(tx, tenantId) ?? [])];
  }

  /** Aktive Module, die `key` brauchen (Pflicht oder einzige aktive Alternative). */
  private dependents(states: ModuleState[], key: string): string[] {
    const active = new Set(states.filter(s => s.active).map(s => s.key));
    return this.model.modules.filter(m => active.has(m.key) && m.key !== key && m.requires.some(r => {
      const alts = typeof r === 'string' ? [r] : r;
      return alts.includes(key) && !alts.some(a => a !== key && active.has(a));
    })).map(m => m.key);
  }

  /** Organisation aktiviert bzw. deaktiviert ein Modul oder eine Teilfunktion (Regeln oben). */
  async setActive(tx: Tx, t: ModuleActing, key: string, active: boolean): Promise<ModuleState> {
    const { module, part } = this.info(key);
    await this.lock(tx);
    if (module.core && !part) throw conflict(`«${module.label}» ist der Kern und immer aktiv.`, { reason: 'kern' });
    const states = await this.list(tx);
    const cur = states.find(s => s.key === key)!;
    if (active && !cur.allowed) throw forbidden(`«${cur.label}» ist für deine Organisation nicht freigegeben. Wende dich an den Betrieb.`, { reason: 'modul-nicht-erlaubt', modul: key });
    if (cur.active === active) return cur;
    if (active) {
      if (part && !states.find(s => s.key === module.key)!.active) throw conflict(`Zuerst das Modul «${module.label}» aktivieren.`, { reason: 'modul-inaktiv', modul: module.key });
      const on = new Set(states.filter(s => s.active).map(s => s.key));
      const fehlt = part ? [] : module.requires.filter(r => (typeof r === 'string' ? !on.has(r) : !r.some(a => on.has(a)))).map(r => (typeof r === 'string' ? r : [...r]));
      if (fehlt.length) throw conflict(`«${module.label}» braucht ${fehlt.map(f => (typeof f === 'string' ? `«${this.label(f)}»` : `eines von ${f.map(a => `«${this.label(a)}»`).join(', ')}`)).join(' und ')}.`, { reason: 'voraussetzung-fehlt', fehlt });
    } else {
      const deps = part ? [] : this.dependents(states, key);
      if (deps.length) throw conflict(`«${module.label}» wird gebraucht von ${deps.map(d => `«${this.label(d)}»`).join(', ')}; diese zuerst deaktivieren.`, { reason: 'abhaengig-aktiv', module: deps });
      const hindernisse = await this.blockers(tx, t.tenantId, key);
      if (hindernisse.length) throw conflict(`«${cur.label}» lässt sich noch nicht deaktivieren.`, { reason: 'hindernisse', hindernisse });
    }
    let r: { active_before: boolean; active_since_before: Date | null; inactive_since_before: Date | null; active: boolean } | undefined;
    try {
      r = (await tx.query('SELECT * FROM app.set_module_active($1, $2)', [key, active])).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === '42501') throw forbidden(`«${cur.label}» ist für deine Organisation nicht freigegeben. Wende dich an den Betrieb.`, { reason: 'modul-nicht-erlaubt', modul: key });
      throw e;
    }
    // Erstes Aktivieren (nie aktiv gewesen, nie deaktiviert): einrichten; erneutes: nachholen ab dem letzten Deaktivieren
    if (active && !r!.active_since_before && !r!.inactive_since_before) await this.hooks[key]?.einrichten?.(tx, t.tenantId);
    else if (active && r!.inactive_since_before) await this.hooks[key]?.nachholen?.(tx, t.tenantId, r!.inactive_since_before);
    await this.audit.write(tx, t.actor, { action: 'tenant.module_active', resourceType: 'tenant', resourceId: t.tenantId, data: { module: key, before: cur.active, after: active, ...(t.platform ? { platformAdmin: true } : {}) } });
    await emitAfter(this.events, tx, { type: active ? 'module.activated' : 'module.deactivated', tenantId: t.tenantId, subject: null, actor: t.actor, data: { module: key, by: t.platform ? null : t.actor.principal?.principalId ?? null } });
    this.invalidate(t.tenantId);
    return (await this.list(tx)).find(s => s.key === key)!;
  }

  /**
   * Betrieb gibt ein Modul bzw. eine Teilfunktion frei oder entzieht sie. Entziehen deaktiviert mit: aktive Module, die es
   * brauchen, ergeben 409 `abhaengig-aktiv`; Hindernisse der App 409 `hindernisse`, ausser mit `force`. Der Kern ist
   * immer erlaubt (409 `kern`).
   */
  async setAllowed(tx: Tx, t: ModuleActing, key: string, allowed: boolean, o: { force?: boolean } = {}): Promise<ModuleState> {
    const { module, part } = this.info(key);
    await this.lock(tx);
    if (module.core && !part) throw conflict(`«${module.label}» ist der Kern und immer erlaubt.`, { reason: 'kern' });
    const states = await this.list(tx);
    const cur = states.find(s => s.key === key)!;
    const row = (await loadModuleRows(tx, this.S)).find(x => x.module === key);
    // Ohne Zeile ist ein Modul nicht erlaubt, eine Teilfunktion erlaubt (wie ihr Modul)
    if (row ? row.allowed === allowed : (part ? allowed : !allowed)) return cur;
    if (!allowed && cur.active) {
      const deps = part ? [] : this.dependents(states, key);
      if (deps.length) throw conflict(`«${module.label}» wird gebraucht von ${deps.map(d => `«${this.label(d)}»`).join(', ')}; diese zuerst entziehen oder deaktivieren.`, { reason: 'abhaengig-aktiv', module: deps });
      const hindernisse = await this.blockers(tx, t.tenantId, key);
      if (hindernisse.length && !o.force) throw conflict(`«${cur.label}» lässt sich noch nicht deaktivieren (mit force übergehen).`, { reason: 'hindernisse', hindernisse });
    }
    await tx.query('SELECT * FROM app.set_module_allowed($1, $2, $3)', [t.tenantId, key, allowed]);
    await this.audit.write(tx, t.actor, { action: 'tenant.module_allowed', resourceType: 'tenant', resourceId: t.tenantId, data: { module: key, before: cur.allowed, after: allowed, ...(t.platform ? { platformAdmin: true } : {}), ...(o.force ? { force: true } : {}) } });
    if (!allowed && cur.active) {
      await this.audit.write(tx, t.actor, { action: 'tenant.module_active', resourceType: 'tenant', resourceId: t.tenantId, data: { module: key, before: true, after: false, ...(t.platform ? { platformAdmin: true } : {}) } });
      await emitAfter(this.events, tx, { type: 'module.deactivated', tenantId: t.tenantId, subject: null, actor: t.actor, data: { module: key, by: t.platform ? null : t.actor.principal?.principalId ?? null } });
    }
    this.invalidate(t.tenantId);
    return (await this.list(tx)).find(s => s.key === key)!;
  }
}

/** 412, wenn `If-Match` nicht zur Version passt. */
export function versionMismatch(): HttpError {
  return new HttpError(412, 'Veraltet', 'Die Module wurden inzwischen geändert. Neu laden und erneut versuchen.');
}
