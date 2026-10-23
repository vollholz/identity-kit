/**
 * Rechtekatalog für die Oberfläche (Spezifikation 7.3, 11.2): Labels der Rechte, Rollen, Scopes, Orte (`types`) und
 * Stufen der Vertraulichkeit aus GET /v1/authz/catalog (in der Sprache der Texte, `Accept-Language`). Keine eigenen
 * Listen oder Labels. Solange der Katalog lädt, liefern die Helfer den Schlüssel bzw. leere Listen, nie einen Fehler.
 * Herkunft: vollholz/assets `web/src/auth/authz.ts`.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { iamFetch } from './client.ts';
import { useIamConfig, type RoleGroup } from './config.tsx';
import type { AuthzCatalog, CatalogRole, Level, PermissionInfo, TypeInfo } from './contract.ts';
import { iamKeys } from './keys.ts';
import { ADMIN_ROLE, MEMBER_RELATION, ORG_TYPE, OWNER_RELATION, type Permission } from './permissions.ts';
import { currentLocale, t } from './texts/index.ts';
import { useIamText } from './texts/react.tsx';

export interface Authz {
  catalog: AuthzCatalog | undefined;
  permission(p: Permission): PermissionInfo | undefined;
  permLabel(p: Permission): string;
  roleLabel(role: string): string;
  /** Rolle oder Beziehung ohne Rolle (`member` «Mitglied», `owner` «Besitzer:in»). */
  relationLabel(relation: string): string;
  /** Rollen, die das Recht enthalten: Katalogreihenfolge ohne org-admin zuerst, org-admin zuletzt. */
  rolesWith(p: Permission): CatalogRole[];
  scopeText(scope: string): string;
  /** Ort des Modells (`org`, `folder` …). */
  type(key: string): TypeInfo | undefined;
  typeLabel(key: string): string;
  /** Label der Stufe 0, 1, 2 (Standard «intern», «vertraulich», «streng vertraulich»). */
  classificationLabel(level: Level): string;
  /** Modell mit Orten ausser `org` (Stufe «mittel» oder «komplex», 8.3). */
  hasPlaces: boolean;
  /** Rollen in Gruppen für Rollendialog und Rollenmatrix (nur Darstellung). */
  groupRoles<R extends { key: string }>(roles: R[]): { key: string; label: string; roles: R[] }[];
}

/** Standard ohne Angabe der App: nur org-admin als eigene Gruppe. */
export const defaultRoleGroups = (): RoleGroup[] => [{ key: 'org', label: t('iam.roles.group.org'), roles: [ADMIN_ROLE] }];

/** Gruppen in der Reihenfolge der App; übrige Rollen unter «Weitere» (bzw. «Rollen», wenn die App keine Gruppen angibt). */
export function groupRoles<R extends { key: string }>(roles: R[], roleGroups: RoleGroup[] = defaultRoleGroups(), configured = false) {
  const byKey = new Map(roles.map(r => [r.key, r]));
  const known = new Set(roleGroups.flatMap(g => g.roles));
  const groups = roleGroups.map(g => ({ key: g.key, label: g.label, roles: g.roles.flatMap(k => byKey.get(k) ?? []) }));
  const rest = roles.filter(r => !known.has(r.key));
  if (rest.length) groups.push({ key: 'other', label: t(configured ? 'iam.roles.group.other' : 'iam.roles.group.all'), roles: rest });
  return groups.filter(g => g.roles.length);
}

/** Fehler in `roleGroups` gegenüber dem Katalog (für Tests der App, V3): unbekannte und doppelte Rollen. */
export function roleGroupProblems(roleGroups: RoleGroup[], catalog: AuthzCatalog): string[] {
  const keys = new Set(catalog.roles.map(r => r.key));
  const seen = new Set<string>(), out: string[] = [];
  for (const g of roleGroups) for (const r of g.roles) {
    if (!keys.has(r)) out.push(`Gruppe «${g.key}»: Rolle «${r}» gibt es im Katalog nicht`);
    if (seen.has(r)) out.push(`Rolle «${r}» steht in mehreren Gruppen`);
    seen.add(r);
  }
  return out;
}

const DEFAULT_CLASSIFICATIONS = ['iam.classification.0', 'iam.classification.1', 'iam.classification.2'] as const;

/** Helfer zu einem (evtl. noch nicht geladenen) Katalog; auch für Tests ohne Abruf. */
export function makeAuthz(catalog: AuthzCatalog | undefined, roleGroups?: RoleGroup[]): Authz {
  const perms = new Map(catalog?.permissions.map(p => [p.key, p]));
  const roles = new Map(catalog?.roles.map(r => [r.key, r]));
  const scopes = new Map(catalog?.scopes.map(s => [s.key, s]));
  const types = new Map(catalog?.types.map(x => [x.key, x]));
  const levels = new Map(catalog?.classifications.map(c => [c.level, c.label]));
  const roleLabel = (role: string) => roles.get(role)?.label ?? role;
  return {
    catalog,
    permission: p => perms.get(p),
    permLabel: p => perms.get(p)?.label ?? p,
    roleLabel,
    relationLabel: r => (r === MEMBER_RELATION ? t('iam.access.relation.member') : r === OWNER_RELATION ? t('iam.access.relation.owner') : roleLabel(r)),
    rolesWith: p => {
      const all = (catalog?.roles ?? []).filter(r => r.permissions.includes(p));
      return [...all.filter(r => r.key !== ADMIN_ROLE), ...all.filter(r => r.key === ADMIN_ROLE)];
    },
    scopeText: s => scopes.get(s)?.text ?? '',
    type: key => types.get(key),
    typeLabel: key => types.get(key)?.label ?? (key === ORG_TYPE ? t('iam.access.org') : key),
    classificationLabel: level => levels.get(level) ?? t(DEFAULT_CLASSIFICATIONS[level]),
    hasPlaces: (catalog?.types ?? []).some(x => x.key !== ORG_TYPE),
    groupRoles: list => groupRoles(list, roleGroups ?? defaultRoleGroups(), !!roleGroups),
  };
}

export function useAuthzCatalog() {
  const { locale } = useIamText();
  // Ändert sich nur mit einer neuen Version der App
  return useQuery({
    queryKey: iamKeys.catalog(locale), staleTime: 60 * 60_000, gcTime: Infinity,
    queryFn: ({ signal }) => iamFetch<AuthzCatalog>('/v1/authz/catalog', { signal, headers: { 'Accept-Language': locale || currentLocale() } }),
  });
}

export function useAuthz(): Authz {
  const { roleGroups } = useIamConfig();
  const q = useAuthzCatalog();
  return useMemo(() => makeAuthz(q.data, roleGroups), [q.data, roleGroups]);
}

/** Freigaben an Orten sind Thema der App: `features.access`, sonst ob das Modell Orte ausser `org` hat. */
export function useAccessFeature(): boolean {
  const { features } = useIamConfig();
  const authz = useAuthz();
  return features.access ?? authz.hasPlaces;
}
