/**
 * Verwaltung (Spezifikation 9.2, 8.3): Status mit `platformAdmin`, Mitglieder und Rollen. Mitglieder-Aufrufe gibt es
 * zweimal: für die eigene Organisation (`/v1/admin/…`) und für eine beliebige Organisation der Plattform-Administration
 * (`/v1/platform/organizations/{alias}/…`, `alias`); die Oberfläche nutzt für beide dieselben Hooks. Herkunft:
 * vollholz/assets `web/src/api/admin.ts`, `api/roles.ts`.
 */
import { useQuery } from '@tanstack/react-query';
import { ifMatch, iamFetch } from './client.ts';
import type {
  AdminStatus, ClientGrant, ClientGrantList, InviteInput, InviteResult, Member, MemberList, Organization, OrganizationInput, OrganizationList,
  OrganizationPatch, RemoveResult, ResendResult, Role, RoleInput, RolePatch,
} from './contract.ts';
import { iamKeys } from './keys.ts';

export function useAdminStatus(enabled = true) {
  return useQuery({ queryKey: iamKeys.adminStatus, enabled, staleTime: 5 * 60_000, queryFn: ({ signal }) => iamFetch<AdminStatus>('/v1/admin/status', { signal }) });
}

/** Aufrufe für Mitglieder; `alias` = Organisation der Plattform-Administration, sonst die eigene. */
export function memberApi(alias: string | null) {
  const base = alias ? `/v1/platform/organizations/${encodeURIComponent(alias)}/members` : '/v1/admin/members';
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    list: (signal?: AbortSignal) => iamFetch<MemberList>(base, { signal }).then(r => r.items),
    invite: (body: InviteInput) => iamFetch<InviteResult>(base, { method: 'POST', body }),
    setRoles: (id: string, roles: string[]) => iamFetch<Member>(`${one(id)}/roles`, { method: 'PUT', body: { roles } }),
    remove: (id: string) => iamFetch<RemoveResult>(one(id), { method: 'DELETE' }),
    resend: (id: string) => iamFetch<ResendResult>(`${one(id)}/invitation`, { method: 'POST' }),
  };
}

export function useMembers(alias: string | null, enabled = true) {
  return useQuery({ queryKey: iamKeys.members(alias), enabled, queryFn: ({ signal }) => memberApi(alias).list(signal) });
}

/** Eigene Rollen der Organisation (8.3); Ändern und Löschen mit If-Match aus der Version der Rolle. */
export const roleApi = {
  create: (body: RoleInput) => iamFetch<Role>('/v1/roles', { method: 'POST', body }),
  update: (r: Pick<Role, 'key' | 'version'>, body: RolePatch) =>
    iamFetch<Role>(`/v1/roles/${encodeURIComponent(r.key)}`, { method: 'PATCH', body, headers: ifMatch(r.version ?? 0) }),
  remove: (r: Pick<Role, 'key' | 'version'>) =>
    iamFetch<void>(`/v1/roles/${encodeURIComponent(r.key)}`, { method: 'DELETE', headers: ifMatch(r.version ?? 0) }),
};

/** Freigegebene Maschinen-Clients (9.3); `alias` = Organisation der Plattform-Administration, sonst die eigene. */
export function clientApi(alias: string | null) {
  const base = alias ? `/v1/platform/organizations/${encodeURIComponent(alias)}/clients` : '/v1/admin/clients';
  const one = (clientId: string) => `${base}/${encodeURIComponent(clientId)}`;
  return {
    list: (signal?: AbortSignal) => iamFetch<ClientGrantList>(base, { signal }).then(r => r.items),
    grant: (clientId: string, description: string) => iamFetch<ClientGrant>(one(clientId), { method: 'PUT', body: { description } }),
    revoke: (clientId: string) => iamFetch<void>(one(clientId), { method: 'DELETE' }),
  };
}

export function useClientGrants(alias: string | null, enabled = true) {
  return useQuery({ queryKey: iamKeys.clients(alias), enabled, queryFn: ({ signal }) => clientApi(alias).list(signal) });
}

/** Organisationen der Plattform-Administration (9.5). */
export const orgApi = {
  list: (signal?: AbortSignal) => iamFetch<OrganizationList>('/v1/platform/organizations', { signal }).then(r => r.items),
  get: (alias: string, signal?: AbortSignal) => iamFetch<Organization>(`/v1/platform/organizations/${encodeURIComponent(alias)}`, { signal }),
  create: (body: OrganizationInput) => iamFetch<Organization>('/v1/platform/organizations', { method: 'POST', body }),
  update: (alias: string, body: OrganizationPatch) => iamFetch<Organization>(`/v1/platform/organizations/${encodeURIComponent(alias)}`, { method: 'PATCH', body }),
  /** Sperren mit freiwilligem Grund fürs Protokoll (höchstens 500 Zeichen) bzw. entsperren. */
  setStatus: (alias: string, suspend: boolean, reason?: string) => iamFetch<Organization>(`/v1/platform/organizations/${encodeURIComponent(alias)}/${suspend ? 'suspend' : 'resume'}`, {
    method: 'POST', body: suspend && reason ? { reason } : {},
  }),
};

export function useOrganizations(enabled = true) {
  return useQuery({ queryKey: iamKeys.orgs, enabled, queryFn: ({ signal }) => orgApi.list(signal) });
}

export function useOrganization(alias: string, enabled = true) {
  return useQuery({ queryKey: iamKeys.org(alias), enabled, queryFn: ({ signal }) => orgApi.get(alias, signal) });
}
