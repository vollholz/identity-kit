/**
 * Reine Regeln der Zugriffsseite (ohne React): wirkungslose Zugriffsregeln erkennen und die Folgen einer neuen
 * vorhersagen. Semantik wie im Server (Spezifikation 7.1, `@vollholz/iam` access.ts): `grant` gibt das Recht auf der
 * Ressource und darunter auch ohne Rolle; Kette von oben nach unten, `deny` gewinnt, gibt es auf einer Stufe
 * `restrict`-Einträge, behalten nur die passenden Principals das Recht (auch aus einer Freigabe). Personen mit org-admin
 * sind ausgenommen. Herkunft: vollholz/assets `web/src/features/acl/rules.ts`, produktneutral (Blätter statt «Objekt»).
 */
import type { AuthzCatalog } from '../contract.ts';
import { ADMIN_ROLE } from '../permissions.ts';
import { listAnd, t, tn, type IamTextKey } from '../texts/index.ts';

export interface AclLike { resourceType: string; resourceId: string | null; principalType: string; principalRef: string; permission: string; effect: string }
export interface ResStep { type: string; id: string | null }

export type Effect = 'grant' | 'restrict' | 'deny';
export const EFFECT_KEYS: readonly Effect[] = ['grant', 'restrict', 'deny'];
/** Klasse der Pille je Wirkung. */
export const EFFECT_PILL: Record<Effect, string> = { grant: 'iam-st-ok', restrict: 'iam-st-warn', deny: 'iam-st-bad' };
/** Bezeichnung (Auswahl, Tabelle), Erklärung und Partizip (Menü, Entfernen) einer Wirkung. */
export const effectText = (e: Effect, part: 'label' | 'hint' | 'verb') => t(`iam.acl.effect.${e}.${part}` as IamTextKey);
/** Wirkung eines Eintrags; `allow` ist der alte Name von `restrict`. */
export const effectOf = (e: { effect: string }): Effect => (e.effect === 'grant' || e.effect === 'deny' ? e.effect : 'restrict');

const roleLabel = (c: AuthzCatalog, key: string) => c.roles.find(r => r.key === key)?.label ?? key;
const resLabel = (c: AuthzCatalog, key: string) => c.resourceTypes.find(r => r.key === key)?.label ?? key;

/** Typen ohne Freigabe (Blatt der Kette): Angabe der App, sonst `leaf` aus dem Katalog. */
export const noGrantTypes = (c: AuthzCatalog | undefined, noGrant?: readonly string[]): string[] =>
  [...(noGrant ?? c?.resourceTypes.filter(r => r.leaf).map(r => r.key) ?? [])];

/** Grund, warum ein Eintrag nie wirkt oder nicht erlaubt ist (gleiche Regeln wie die 422-Prüfung beim Anlegen), sonst `null`. */
export function ineffectiveReason(e: AclLike, c: AuthzCatalog, noGrant: readonly string[] = noGrantTypes(c)): string | null {
  const admin = roleLabel(c, ADMIN_ROLE), effect = effectOf(e);
  if (e.principalType === 'role' && e.principalRef === ADMIN_ROLE) return t('iam.acl.why.adminRole', { admin });
  if (e.principalType === 'role' && !c.roles.some(r => r.key === e.principalRef)) return t('iam.acl.why.noRole', { role: e.principalRef });
  const p = c.permissions.find(x => x.key === e.permission);
  if (!p) return t('iam.acl.why.noPerm', { perm: e.permission });
  if (p.adminOnly && effect === 'grant') return t('iam.acl.why.adminGrant', { perm: p.label, admin });
  if (p.adminOnly && e.principalType !== 'client') return t('iam.acl.why.adminOnly', { perm: p.label, admin });
  if (!p.resources.includes(e.resourceType)) return t('iam.acl.why.wrongType', { perm: p.label, type: resLabel(c, e.resourceType), types: p.resources.map(r => resLabel(c, r)).join(', ') });
  if (effect === 'grant' && noGrant.includes(e.resourceType)) return t('iam.acl.why.leaf', { type: resLabel(c, e.resourceType) });
  return null;
}

/**
 * Ressourcentypen der Zugriffsregeln: die des Katalogs, auf denen mindestens ein Recht wirkt (`permissions[].resources`).
 * Der Katalog kann auch Typen nur für das Protokoll benennen; die sind hier nicht wählbar.
 */
export function aclResourceTypes(c: AuthzCatalog | undefined): AuthzCatalog['resourceTypes'] {
  if (!c) return [];
  const used = new Set(c.permissions.flatMap(p => p.resources));
  return c.resourceTypes.filter(r => used.has(r.key));
}

/**
 * Rechte, die auf einem Ressourcentyp als Eintrag wirken: passend und nicht nur org-admin – ausser für einen
 * Maschinen-Client bei Verbot oder Beschränkung (Clients mit org-admin sind nicht ausgenommen).
 */
export function permissionsFor(c: AuthzCatalog, resourceType: string, o: { effect?: Effect; principalType?: string } = {}) {
  const adminOk = o.principalType === 'client' && o.effect !== undefined && o.effect !== 'grant';
  return c.permissions.filter(p => (adminOk || !p.adminOnly) && p.resources.includes(resourceType));
}

/** Rolle allein (ohne Person, Gruppe, Client): hat sie das Recht auf der letzten Stufe der Kette (Rolle oder Freigabe)? */
function roleHas(c: AuthzCatalog, role: string, perm: string, chain: ResStep[], entries: AclLike[]): boolean {
  const at = (step: ResStep) => entries.filter(e => e.permission === perm && e.resourceType === step.type && (e.resourceId ?? null) === (step.id ?? null));
  const hit = (e: AclLike) => e.principalType === 'role' && e.principalRef === role;
  const fromRole = !!c.roles.find(r => r.key === role)?.permissions.includes(perm);
  if (!fromRole && !chain.some(step => at(step).some(e => effectOf(e) === 'grant' && hit(e)))) return false;
  for (const step of chain) {
    const here = at(step);
    if (here.some(e => effectOf(e) === 'deny' && hit(e))) return false;
    const restricts = here.filter(e => effectOf(e) === 'restrict');
    if (restricts.length && !restricts.some(hit)) return false;
  }
  return true;
}

/** Rolle und Gruppe stehen im Satz für mehrere Personen. */
const plural = (e: AclLike) => e.principalType === 'role' || e.principalType === 'group';

export type RoleOutcome = 'gains' | 'keeps' | 'loses' | 'without' | 'exempt';
export interface Preview {
  sentence: string;
  roles: { key: string; label: string; outcome: RoleOutcome }[];
  /** Weitere `restrict`-Einträge auf derselben Ressource und demselben Recht, die mit dem neuen zusammen gelten. */
  others: number;
  /** Keine Rolle gewinnt oder verliert durch den Eintrag das Recht. */
  unchanged: boolean;
  /** Ob Einträge für Personen, Gruppen oder Clients die Rollensicht ergänzen (dann gilt die Liste je Rolle «sonst»). */
  individual: boolean;
}

/** «In der ganzen Organisation» bzw. «Auf Ordner «Projekte»». */
export const whereText = (c: AuthzCatalog | undefined, type: string, name: string) =>
  (type === 'tenant' ? t('iam.acl.where.tenant') : t('iam.acl.where.res', { type: c ? resLabel(c, type) : type, name }));

/** Zusatz «(auch auf allem darunter)»: auf der Organisation und auf Typen, die kein Blatt sind. */
export const belowText = (type: string, leaves: readonly string[]) => (type === 'tenant' || !leaves.includes(type) ? t('iam.acl.below') : '');

/**
 * Folgen eines neuen Eintrags. `chain`: Ressource mit ihren übergeordneten Stufen (von oben, inkl. der Ressource selbst),
 * soweit bekannt; `entries`: bestehende Einträge; `leaves`: Typen ohne Stufe darunter. `who` beschreibt einen Principal
 * im Satz («Personen mit Rolle «…»»).
 */
export function previewEntry(o: {
  draft: AclLike; entries: AclLike[]; chain: ResStep[]; catalog: AuthzCatalog; resourceName: string; who: (e: AclLike) => string; leaves?: readonly string[];
}): Preview {
  const { draft, entries, chain, catalog: c } = o;
  const perm = c.permissions.find(p => p.key === draft.permission)?.label ?? draft.permission;
  const after = [...entries, draft];
  const same = (e: AclLike) => e.permission === draft.permission && e.resourceType === draft.resourceType && (e.resourceId ?? null) === (draft.resourceId ?? null);
  const vars = { where: whereText(c, draft.resourceType, o.resourceName), perm, below: belowText(draft.resourceType, o.leaves ?? noGrantTypes(c)) };
  let sentence: string;
  let others = 0;
  const effect = effectOf(draft);
  if (effect === 'deny') sentence = tn('iam.acl.preview.deny', plural(draft) ? 2 : 1, { ...vars, who: o.who(draft) });
  else if (effect === 'grant') sentence = tn('iam.acl.preview.grant', plural(draft) ? 2 : 1, { ...vars, who: o.who(draft) });
  else {
    const restricts = after.filter(e => same(e) && effectOf(e) === 'restrict');
    others = restricts.length - 1;
    const names = restricts.map(o.who).filter((x, i, a) => a.indexOf(x) === i);
    sentence = tn('iam.acl.preview.restrict', names.length > 1 || plural(restricts[0]!) ? 2 : 1, { ...vars, who: listAnd(names) });
  }
  const grantsRole = effect === 'grant' && draft.principalType === 'role';
  const roles = c.roles.filter(r => r.permissions.includes(draft.permission) || (grantsRole && r.key === draft.principalRef)).map(r => {
    if (r.key === ADMIN_ROLE) return { key: r.key, label: r.label, outcome: 'exempt' as const };
    const before = roleHas(c, r.key, draft.permission, chain, entries), now = roleHas(c, r.key, draft.permission, chain, after);
    return { key: r.key, label: r.label, outcome: (now && !before ? 'gains' : now ? 'keeps' : before ? 'loses' : 'without') as RoleOutcome };
  });
  const onChain = (e: AclLike) => e.permission === draft.permission && chain.some(s => s.type === e.resourceType && (s.id ?? null) === (e.resourceId ?? null));
  const individual = after.some(e => onChain(e) && e.principalType !== 'role');
  return { sentence, roles: [...roles.filter(r => r.key !== ADMIN_ROLE), ...roles.filter(r => r.key === ADMIN_ROLE)], others, individual, unchanged: !roles.some(r => r.outcome === 'loses' || r.outcome === 'gains') };
}

/** Kennung einer Ressource für Gruppierung und Filter. */
export const resKey = (e: { resourceType: string; resourceId: string | null }) => `${e.resourceType}:${e.resourceId ?? ''}`;
/** Kennung eines Principals für den Filter «Wer». */
export const whoKey = (e: { principalType: string; principalRef: string }) => `${e.principalType}:${e.principalRef}`;

export interface AclFilter { resourceType?: string; resourceId?: string; permission?: string; who?: string }

export function filterEntries<T extends AclLike>(entries: T[], f: AclFilter): T[] {
  return entries.filter(e => (!f.resourceType || e.resourceType === f.resourceType) && (!f.resourceId || e.resourceId === f.resourceId)
    && (!f.permission || e.permission === f.permission) && (!f.who || whoKey(e) === f.who));
}

/** Einträge nach Ressource gruppiert, Reihenfolge der Ressourcentypen wie im Katalog (Organisation zuerst). */
export function groupByResource<T extends AclLike>(entries: T[], c: AuthzCatalog | undefined): { key: string; resourceType: string; resourceId: string | null; items: T[] }[] {
  const order = (type: string) => { const i = c?.resourceTypes.findIndex(r => r.key === type) ?? -1; return i < 0 ? 99 : i; };
  const groups = new Map<string, { key: string; resourceType: string; resourceId: string | null; items: T[] }>();
  for (const e of entries) {
    const k = resKey(e);
    const g = groups.get(k) ?? { key: k, resourceType: e.resourceType, resourceId: e.resourceId, items: [] };
    g.items.push(e);
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => order(a.resourceType) - order(b.resourceType));
}

/** Stufe für den Hinweis an einer Ressource: Einträge darauf und wie sie im Text heissen («hier», «von «Projekte»»). */
export interface HintStage { type: string; id: string; text: string }

/**
 * Einträge je Stufe für «Zugriff eingeschränkt (1 hier, 3 von «Projekte»)»; Einträge auf Organisationsebene zählen
 * nicht (sie gelten überall). Liefert nur Stufen mit Einträgen, in der Reihenfolge der übergebenen Stufen.
 */
export function hintCounts(entries: AclLike[], stages: HintStage[]): (HintStage & { count: number })[] {
  return stages.map(s => ({ ...s, count: entries.filter(e => e.resourceType === s.type && e.resourceId === s.id).length })).filter(s => s.count > 0);
}
