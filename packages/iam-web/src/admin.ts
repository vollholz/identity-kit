/** Verwaltung (Spezifikation 9.2): Status der Verwaltung mit `platformAdmin`, GET /v1/admin/status. */
import { useQuery } from '@tanstack/react-query';
import { iamFetch } from './client.ts';
import type { AdminStatus } from './contract.ts';
import { iamKeys } from './keys.ts';

export function useAdminStatus(enabled = true) {
  return useQuery({ queryKey: iamKeys.adminStatus, enabled, staleTime: 5 * 60_000, queryFn: ({ signal }) => iamFetch<AdminStatus>('/v1/admin/status', { signal }) });
}
