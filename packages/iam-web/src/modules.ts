/**
 * Produktmodule je Organisation (Konzept «Module je Organisation», docs/module-je-organisation.md): Aufrufe, Abfragen
 * und die Regeln, die die Oberfläche vor dem Schalten anzeigt. Der Server prüft dieselben Regeln selbst (409/403); die
 * Oberfläche erklärt sie vorher: was mitaktiviert wird, was nicht freigegeben ist, was ein Deaktivieren verhindert.
 *
 * - eigene Organisation: `GET /v1/tenant/modules` (`tenant:read`), `PUT /v1/tenant/modules/{key}` (`tenant:admin`)
 * - Plattform-Administration: `GET/PUT /v1/platform/organizations/{alias}/modules[/{key}]` (freigeben, entziehen)
 *
 * `If-Match` mit dem `ETag` der Liste (`W/"<acl_version>"`): Hat sich inzwischen etwas geändert, antwortet der Server
 * mit 412 und die Oberfläche lädt neu.
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { iamFetchWithEtag } from './client.ts';
import { useAuthzCatalog } from './authz.ts';
import { useIamConfig } from './config.tsx';
import type { AuthzCatalog, ModuleActiveInput, ModuleAllowedInput, ModuleBlocker, ModuleRequirement, TenantModule, TenantModuleList } from './contract.ts';
import { iamKeys } from './keys.ts';
import { ApiError } from './problem.ts';
import { listAnd, listOr, t } from './texts/index.ts';

/** Liste mit Version für `If-Match`. */
export interface ModuleListResult { items: TenantModule[]; etag: string | null }

const headersFor = (etag?: string | null): Record<string, string> | undefined => (etag ? { 'If-Match': etag } : undefined);

/** Aufrufe der Module; `alias` = Organisation der Plattform-Administration, sonst die eigene. */
export function moduleApi(alias: string | null) {
  const base = alias ? `/v1/platform/organizations/${encodeURIComponent(alias)}/modules` : '/v1/tenant/modules';
  const one = (key: string) => `${base}/${encodeURIComponent(key)}`;
  return {
    list: async (signal?: AbortSignal): Promise<ModuleListResult> => {
      const r = await iamFetchWithEtag<TenantModuleList>(base, { signal });
      return { items: r.data.items, etag: r.etag };
    },
    /** Organisation: aktivieren bzw. deaktivieren (`tenant:admin`). Liefert den neuen Zustand und die neue Version. */
    setActive: async (key: string, active: boolean, etag?: string | null) => {
      const r = await iamFetchWithEtag<TenantModule>(one(key), { method: 'PUT', body: { active } satisfies ModuleActiveInput, headers: headersFor(etag) });
      return { module: r.data, etag: r.etag };
    },
    /** Plattform-Administration: freigeben bzw. entziehen; `force` übergeht Hindernisse der App. */
    setAllowed: async (key: string, allowed: boolean, o: { force?: boolean; etag?: string | null } = {}) => {
      const r = await iamFetchWithEtag<TenantModule>(one(key), { method: 'PUT', body: { allowed } satisfies ModuleAllowedInput, query: o.force ? { force: true } : undefined, headers: headersFor(o.etag) });
      return { module: r.data, etag: r.etag };
    },
  };
}

export function useModules(alias: string | null, enabled = true) {
  return useQuery({ queryKey: iamKeys.modules(alias), enabled, queryFn: ({ signal }) => moduleApi(alias).list(signal) });
}

/** Das Modell hat Produktmodule (mehr als den stillen Kern). */
export const hasModules = (catalog: AuthzCatalog | undefined): boolean => !!catalog?.modules?.some(m => !m.core);

/**
 * Seite «Module» und Abschnitt der Plattform-Administration zeigen: `features.modules`, sonst ob das Modell Module hat.
 * `undefined`, solange der Katalog lädt oder nicht geladen werden konnte (nie «keine Module» wegen eines Fehlers; den
 * Fehler zeigt die Seite mit `useAuthzCatalog().error`).
 */
export function useModulesFeature(enabled = true): boolean | undefined {
  const { features } = useIamConfig();
  const q = useAuthzCatalog(enabled && features.modules === undefined);
  if (features.modules !== undefined) return features.modules;
  return q.data ? hasModules(q.data) : undefined;
}

/**
 * Nach einer Schaltung neu laden: Liste, Sitzung (`modules`, Rechte) und Katalog – er enthält nur die Rechte aktiver
 * Module der Organisation.
 */
export function modulesChanged(qc: QueryClient, alias: string | null): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: iamKeys.modules(alias) }), qc.invalidateQueries({ queryKey: iamKeys.me }),
    qc.invalidateQueries({ queryKey: ['iam', 'catalog'] }),
  ]);
}

// ------------------------------------------------------------------------------------------------ Regeln (Anzeige)

/** Name eines Moduls bzw. einer Teilfunktion aus der Liste (sonst der Schlüssel). */
export const moduleLabel = (items: readonly TenantModule[], key: string): string => items.find(m => m.key === key)?.label ?? key;

const quote = (s: string) => t('iam.modules.quoted', { name: s });

/** Voraussetzung als Text: «Zeiterfassung» bzw. «eines von «A» oder «B»». */
export function requirementText(items: readonly TenantModule[], r: ModuleRequirement): string {
  return typeof r === 'string' ? quote(moduleLabel(items, r)) : t('iam.modules.oneOf', { list: listOr(r.map(k => quote(moduleLabel(items, k)))) });
}

/** «Braucht «Zeiterfassung» und eines von …» oder `null` ohne Voraussetzungen. */
export function requiresText(items: readonly TenantModule[], m: TenantModule): string | null {
  return m.requires.length ? t('iam.modules.requires', { list: listAnd(m.requires.map(r => requirementText(items, r))) }) : null;
}

/** Wahl bei Voraussetzungen «eines von»: bisher gewählter Schlüssel je Liste (Index in `requires` über alle Stufen). */
export type ModuleChoice = Record<string, string>;
/** Schlüssel einer Liste «eines von» für `ModuleChoice`. */
export const choiceKey = (alts: readonly string[]) => alts.join('|');

export interface ActivationPlan {
  /** Mitzuaktivierende Module in der Reihenfolge des Aktivierens (Voraussetzungen zuerst), ohne das Modul selbst. */
  also: string[];
  /** Offene Wahl «eines von» (keines aktiv): Listen mit den freigegebenen Möglichkeiten und der gewählten. */
  choices: { alts: string[]; chosen: string }[];
  /** Nötige Voraussetzungen, die nicht freigegeben sind: Aktivieren unmöglich. */
  blocked: string[];
}

/**
 * Was das Aktivieren von `key` mitaktivieren muss (Voraussetzungen rekursiv, inaktive zuerst). Bei «eines von» ohne
 * aktives Modul gilt die Wahl aus `choice`, sonst das erste freigegebene.
 */
export function activationPlan(items: readonly TenantModule[], key: string, choice: ModuleChoice = {}): ActivationPlan {
  const by = new Map(items.map(m => [m.key, m]));
  const on = new Set(items.filter(m => m.active).map(m => m.key));
  const also: string[] = [], choices: ActivationPlan['choices'] = [], blocked: string[] = [];
  const seen = new Set<string>();
  const visit = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    for (const r of by.get(k)?.requires ?? []) {
      if (typeof r === 'string') { need(r); continue; }
      if (r.some(a => on.has(a))) continue;
      const allowed = r.filter(a => by.get(a)?.allowed);
      if (!allowed.length) { blocked.push(...r.filter(a => !blocked.includes(a))); continue; }
      const picked = choice[choiceKey(r)];
      const chosen = picked && allowed.includes(picked) ? picked : allowed[0]!;
      choices.push({ alts: allowed, chosen });
      need(chosen);
    }
  };
  const need = (k: string) => {
    if (on.has(k)) return;
    const m = by.get(k);
    if (!m?.allowed) { if (!blocked.includes(k)) blocked.push(k); return; }
    visit(k);
    if (!also.includes(k)) also.push(k);
    on.add(k);
  };
  visit(key);
  return { also: also.filter(k => k !== key), choices, blocked };
}

/** Aktive Module, die `key` brauchen (Pflicht oder einzige aktive Möglichkeit von «eines von»), wie der Server. */
export function dependentsOf(items: readonly TenantModule[], key: string): string[] {
  const on = new Set(items.filter(m => m.active).map(m => m.key));
  return items.filter(m => !m.module && m.active && m.key !== key && m.requires.some(r => {
    const alts = typeof r === 'string' ? [r] : r;
    return alts.includes(key) && !alts.some(a => a !== key && on.has(a));
  })).map(m => m.key);
}

/** Module, die `key` als Voraussetzung nennen (aktiv oder nicht), für «Gebraucht von». */
export const usedBy = (items: readonly TenantModule[], key: string): string[] =>
  items.filter(m => !m.module && m.requires.some(r => (typeof r === 'string' ? r === key : r.includes(key)))).map(m => m.key);

/** Teilfunktionen eines Moduls. */
export const partsOf = (items: readonly TenantModule[], key: string): TenantModule[] => items.filter(m => m.module === key);

/** Rechte des Moduls (Katalog, `modul`), deren Namen ein Deaktivieren unwirksam macht. */
export const moduleRights = (catalog: AuthzCatalog | undefined, key: string): string[] =>
  (catalog?.permissions ?? []).filter(p => p.modul === key).map(p => p.label);

// ------------------------------------------------------------------------------------------------ Fehler des Servers

export interface ModuleErrorText {
  title: string;
  /** Hindernisse (409 `hindernisse`). */
  blockers?: ModuleBlocker[];
  /** Neu laden, weil sich der Stand geändert hat (412). */
  stale?: boolean;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(x => (typeof x === 'string' ? [x] : Array.isArray(x) ? [x.join('|')] : [])) : []);

/**
 * Antwort des Servers beim Schalten verständlich: Grund (`reason`) mit den Namen aus der Liste. `null`, wenn kein
 * bekannter Grund vorliegt (dann zeigt die Oberfläche den Fehler wie sonst).
 */
export function moduleErrorText(e: unknown, items: readonly TenantModule[], key: string): ModuleErrorText | null {
  if (!(e instanceof ApiError)) return null;
  const name = quote(moduleLabel(items, key));
  if (e.status === 412) return { title: t('iam.modules.err.stale'), stale: true };
  const reason = e.problem.reason;
  if (reason === 'modul-nicht-erlaubt') return { title: t('iam.modules.err.notAllowed', { name }) };
  if (reason === 'kern') return { title: t('iam.modules.err.core', { name }) };
  if (reason === 'modul-inaktiv') {
    const m = typeof e.problem.modul === 'string' ? e.problem.modul : items.find(x => x.key === key)?.module ?? '';
    return { title: t('iam.modules.err.moduleOff', { module: quote(moduleLabel(items, m)) }) };
  }
  if (reason === 'voraussetzung-fehlt') {
    const fehlt = Array.isArray(e.problem.fehlt) ? (e.problem.fehlt as ModuleRequirement[]) : [];
    return { title: t('iam.modules.err.missing', { name, list: listAnd(fehlt.map(r => requirementText(items, r))) }) };
  }
  if (reason === 'abhaengig-aktiv') return { title: t('iam.modules.err.dependents', { name, list: listAnd(asList(e.problem.module).map(k => quote(moduleLabel(items, k)))) }) };
  if (reason === 'hindernisse') {
    const raw = Array.isArray(e.problem.hindernisse) ? e.problem.hindernisse as unknown[] : [];
    const blockers = raw.filter((b): b is ModuleBlocker => !!b && typeof b === 'object' && typeof (b as ModuleBlocker).text === 'string');
    return { title: t('iam.modules.err.blocked', { name }), blockers };
  }
  return null;
}
