/**
 * Rechtekatalog für die Oberfläche (Spezifikation 7.2, 11.2): Labels der Rechte, Rollen, Scopes und Ressourcentypen aus
 * GET /v1/authz/catalog (in der Sprache der Texte, `Accept-Language`), ergänzt um die eigenen Rollen der Organisation
 * aus GET /v1/roles. Keine eigenen Listen oder Labels. Solange der Katalog lädt, liefern die Helfer den Schlüssel bzw.
 * leere Listen, nie einen Fehler. Herkunft: vollholz/assets `web/src/auth/authz.ts`.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { iamFetch } from './client.ts';
import { useIamConfig, type RoleGroup } from './config.tsx';
import type { AuthzCatalog, CatalogRole, PermissionInfo, Role, RoleList } from './contract.ts';
import { iamKeys } from './keys.ts';
import { useIamMaybe } from './session.tsx';
import { ADMIN_ROLE, isCustomRole, type Permission } from './permissions.ts';
import { currentLocale, t } from './texts/index.ts';
import { useIamText } from './texts/react.tsx';

export interface Authz {
  catalog: AuthzCatalog | undefined;
  permission(p: Permission): PermissionInfo | undefined;
  permLabel(p: Permission): string;
  roleLabel(role: string): string;
  /** Rollen, die das Recht enthalten: Katalogreihenfolge ohne org-admin zuerst, org-admin zuletzt. */
  rolesWith(p: Permission): CatalogRole[];
  scopeText(scope: string): string;
  resourceLabel(type: string): string;
  /** Rollen in Gruppen für Rollendialog und Rollenmatrix (nur Darstellung). */
  groupRoles<R extends { key: string }>(roles: R[]): { key: string; label: string; roles: R[] }[];
}

/** Katalog mit den eigenen Rollen der Organisation (nach den vordefinierten). */
export function withCustomRoles(catalog: AuthzCatalog | undefined, roles: readonly Role[] | undefined): AuthzCatalog | undefined {
  const own = (roles ?? []).filter(r => r.custom);
  if (!catalog || !own.length) return catalog;
  return { ...catalog, roles: [...catalog.roles, ...own.map(r => ({ key: r.key, label: r.label, description: r.description, permissions: r.permissions, adminOnly: false }))] };
}

/** Standard ohne Angabe der App: nur org-admin als eigene Gruppe. */
export const defaultRoleGroups = (): RoleGroup[] => [{ key: 'org', label: t('iam.roles.group.org'), roles: [ADMIN_ROLE] }];

/**
 * Gruppen in der Reihenfolge der App; danach eigene Rollen der Organisation (`c-…`) unter «Eigene Rollen» und übrige
 * unter «Weitere» (bzw. «Rollen», wenn die App keine Gruppen angibt).
 */
export function groupRoles<R extends { key: string }>(roles: R[], roleGroups: RoleGroup[] = defaultRoleGroups(), configured = false) {
  const byKey = new Map(roles.map(r => [r.key, r]));
  const known = new Set(roleGroups.flatMap(g => g.roles));
  const groups = roleGroups.map(g => ({ key: g.key, label: g.label, roles: g.roles.flatMap(k => byKey.get(k) ?? []) }));
  const rest = roles.filter(r => !known.has(r.key));
  const own = rest.filter(r => isCustomRole(r.key)), other = rest.filter(r => !isCustomRole(r.key));
  if (own.length) groups.push({ key: 'custom', label: t('iam.roles.group.custom'), roles: own });
  if (other.length) groups.push({ key: 'other', label: t(configured ? 'iam.roles.group.other' : 'iam.roles.group.all'), roles: other });
  return groups.filter(g => g.roles.length);
}

/** Fehler in `roleGroups` gegenüber dem Katalog (für Tests der App, V3): unbekannte Rollen, doppelte, eigene Rollen. */
export function roleGroupProblems(roleGroups: RoleGroup[], catalog: AuthzCatalog): string[] {
  const keys = new Set(catalog.roles.map(r => r.key));
  const seen = new Set<string>(), out: string[] = [];
  for (const g of roleGroups) for (const r of g.roles) {
    if (!keys.has(r)) out.push(`Gruppe «${g.key}»: Rolle «${r}» gibt es im Katalog nicht`);
    if (isCustomRole(r)) out.push(`Gruppe «${g.key}»: eigene Rolle «${r}» gehört nicht in roleGroups`);
    if (seen.has(r)) out.push(`Rolle «${r}» steht in mehreren Gruppen`);
    seen.add(r);
  }
  return out;
}

/**
 * Voraussetzungen der Oberfläche (`requires` im Katalog), die in einer Auswahl von Rechten fehlen: je gewähltem Recht die
 * fehlenden, in Katalogreihenfolge. `possible` begrenzt auf Rechte, die überhaupt wählbar sind (eigene Rollen ohne die
 * Rechte nur für org-admin); ohne Angabe alle.
 */
export function missingRequirements(catalog: AuthzCatalog | undefined, picked: ReadonlySet<string>, possible?: ReadonlySet<string>): { perm: PermissionInfo; missing: PermissionInfo[] }[] {
  if (!catalog) return [];
  const byKey = new Map(catalog.permissions.map(p => [p.key, p]));
  return catalog.permissions.filter(p => picked.has(p.key)).flatMap(perm => {
    const missing = (perm.requires ?? []).filter(k => !picked.has(k) && (!possible || possible.has(k))).flatMap(k => byKey.get(k) ?? []);
    return missing.length ? [{ perm, missing }] : [];
  });
}

/** Helfer zu einem (evtl. noch nicht geladenen) Katalog; auch für Tests ohne Abruf. */
export function makeAuthz(catalog: AuthzCatalog | undefined, roleGroups?: RoleGroup[]): Authz {
  const perms = new Map(catalog?.permissions.map(p => [p.key, p]));
  const roles = new Map(catalog?.roles.map(r => [r.key, r]));
  const scopes = new Map(catalog?.scopes.map(s => [s.key, s]));
  const resources = new Map(catalog?.resourceTypes.map(r => [r.key, r.label]));
  return {
    catalog,
    permission: p => perms.get(p),
    permLabel: p => perms.get(p)?.label ?? p,
    roleLabel: role => roles.get(role)?.label ?? role,
    rolesWith: p => {
      const all = (catalog?.roles ?? []).filter(r => r.permissions.includes(p));
      return [...all.filter(r => r.key !== ADMIN_ROLE), ...all.filter(r => r.key === ADMIN_ROLE)];
    },
    scopeText: s => scopes.get(s)?.text ?? '',
    resourceLabel: type => resources.get(type) ?? type,
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

/** Rollen der Organisation (vordefinierte und eigene), GET /v1/roles. */
export function useRoles(enabled = true) {
  // Eigene Rollen ändern sich selten; nach eigenen Änderungen invalidiert die Seite den Schlüssel
  return useQuery({ queryKey: iamKeys.roles, enabled, staleTime: 60_000, retry: false, queryFn: ({ signal }) => iamFetch<RoleList>('/v1/roles', { signal }) });
}

export function useAuthz(): Authz {
  const { roleGroups } = useIamConfig();
  const q = useAuthzCatalog();
  // Eigene Rollen der Organisation (GET /v1/roles braucht tenant:read auf Ebene der Organisation; ohne würde jede Seite
  // ein 403 und damit eine erneute Prüfung von /auth/me auslösen). Fehlen sie, zeigen die Helfer ihren Schlüssel.
  const session = useIamMaybe();
  const roles = useRoles(session ? session.can('tenant:read') : true);
  return useMemo(() => makeAuthz(withCustomRoles(q.data, roles.data?.items), roleGroups), [q.data, roles.data, roleGroups]);
}
