/**
 * Zugriff und Break-Glass (Spezifikation 9.5, 9.7, 11.4): wer an einem Ort Zugriff hat und warum, Freigaben anlegen,
 * ändern und entfernen, Gruppen aus Entra ID suchen, eigene Orte und die Orte eines Mitglieds. Mutationen invalidieren
 * alles unter `iamKeys.access` und `/auth/me` (Rechte wirken sofort, auch für die eigene Person).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { iamFetch } from '../client.ts';
import type {
  AccessEntry, AccessEntryList, AccessGroupList, AccessInput, AccessList, AccessPatch, BreakGlassInput, BreakGlassResult, Explain, ResourceRef,
} from '../contract.ts';
import { iamKeys } from '../keys.ts';
import { ORG_TYPE } from '../permissions.ts';

/** Suchparameter `type`, `id` eines Orts (`id` fehlt genau bei `org`). */
const refQuery = (ref: ResourceRef) => ({ type: ref.type, id: ref.type === ORG_TYPE ? null : ref.id });

export const accessApi = {
  list: (ref: ResourceRef, signal?: AbortSignal) => iamFetch<AccessList>('/v1/access', { query: refQuery(ref), signal }),
  /** Direkte Freigaben eines Subjekts (`me` für mich; andere mit `members:admin`). */
  of: (subject: string, signal?: AbortSignal) => iamFetch<AccessEntryList>('/v1/access', { query: { subject }, signal }).then(r => r.items),
  explain: (ref: ResourceRef, o: { permission?: string; subject?: string } = {}, signal?: AbortSignal) =>
    iamFetch<Explain>('/v1/access/explain', { query: { ...refQuery(ref), permission: o.permission, subject: o.subject }, signal }),
  grant: (body: AccessInput) => iamFetch<AccessEntry>('/v1/access', { method: 'POST', body }),
  patch: (id: string, body: AccessPatch) => iamFetch<AccessEntry>(`/v1/access/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  revoke: (id: string) => iamFetch<void>(`/v1/access/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Gruppen aus Entra ID: Suche ab 2 Zeichen bzw. Namen zu Objekt-IDs. */
  groups: (q: { q?: string; ids?: string[] }, signal?: AbortSignal) => iamFetch<AccessGroupList>('/v1/access/groups', { query: { q: q.q, ids: q.ids }, signal }).then(r => r.items),
};

export const breakGlassApi = {
  start: (body: BreakGlassInput) => iamFetch<BreakGlassResult>('/v1/break-glass', { method: 'POST', body }),
  end: () => iamFetch<void>('/v1/break-glass', { method: 'DELETE' }),
};

/** «Wer hat Zugriff?» an einem Ort. */
export function useAccessList(ref: ResourceRef, enabled = true) {
  return useQuery({ queryKey: iamKeys.accessList(ref.type, ref.id), enabled, retry: false, queryFn: ({ signal }) => accessApi.list(ref, signal) });
}

/** Meine Rollen an Orten (direkte Freigaben, «Meine Rechte»). */
export function useMyAccess(enabled = true) {
  return useQuery({
    queryKey: iamKeys.accessOf('me'), enabled, retry: false, staleTime: 30_000,
    queryFn: async ({ signal }) => ({ items: await accessApi.of('me', signal) }),
  });
}

/** Orte eines Mitglieds («+3 Orte»): `subject` wie `user:<id>` bzw. `client:<id>`. */
export function useSubjectAccess(subject: string, enabled = true) {
  return useQuery({ queryKey: iamKeys.accessOf(subject), enabled, retry: false, queryFn: ({ signal }) => accessApi.of(subject, signal) });
}

/** «Warum?» für mich (ohne `subject`) oder für andere (`access:admin` am Ort); ohne `permission` das Leserecht des Typs. */
export function useExplain(ref: ResourceRef, o: { permission?: string; subject?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: iamKeys.explain(ref.type, ref.id, o.permission ?? '', o.subject ?? ''), enabled, retry: false,
    queryFn: ({ signal }) => accessApi.explain(ref, o, signal),
  });
}

/** Nach jeder Änderung: alles unter «Zugriff», Mitgliederlisten («+n Orte») und /auth/me. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: iamKeys.access }),
    qc.invalidateQueries({ queryKey: ['iam', 'admin', 'members'] }),
    qc.invalidateQueries({ queryKey: iamKeys.me }),
  ]);
}

export function useGrant() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (body: AccessInput) => accessApi.grant(body), onSuccess: () => refresh() });
}

export function usePatchAccess() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: ({ id, expiresAt }: { id: string; expiresAt: string | null }) => accessApi.patch(id, { expiresAt }), onSuccess: () => refresh() });
}

export function useRevoke() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (id: string) => accessApi.revoke(id), onSuccess: () => refresh() });
}

/** Break-Glass starten oder beenden; danach gelten Freigabestufe und Sichten neu. */
export function useBreakGlassMutations() {
  const refresh = useRefresh();
  const start = useMutation({ mutationFn: (body: BreakGlassInput) => breakGlassApi.start(body), onSuccess: () => refresh() });
  const end = useMutation({ mutationFn: () => breakGlassApi.end(), onSuccess: () => refresh() });
  return { start, end };
}
