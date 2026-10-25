/**
 * Konto ohne Organisation (Spezifikation Kap. 6.3): `GET /v1/account` (Konto, Organisationen, Plattform-Administration,
 * was selbst geht), eigene Organisation erstellen und – öffentlich – registrieren. Funktioniert mit und ohne
 * Organisation im Tab (die API ignoriert `X-Tenant` im Kontext Konto).
 */
import { useQuery } from '@tanstack/react-query';
import { iamFetch } from './client.ts';
import type { AccountInfo, OwnOrganization, OwnOrganizationInput, SignupInput, SignupResult } from './contract.ts';
import { iamKeys } from './keys.ts';

export const accountApi = {
  get: (signal?: AbortSignal) => iamFetch<AccountInfo>('/v1/account', { signal }),
  /** Eigene Organisation erstellen; danach mit `switchOrg(alias)` hineinwechseln (erneuert das Token). */
  createOrganization: (body: OwnOrganizationInput) => iamFetch<OwnOrganization>('/v1/account/organizations', { method: 'POST', body }),
  /** Registrieren ohne Sitzung: Antwort immer gleich, ob die Adresse schon ein Konto hat oder nicht. */
  signup: (body: SignupInput) => iamFetch<SignupResult>('/v1/signup', { method: 'POST', body, anonymous: true }),
};

/** Konto der angemeldeten Person (Plattform-Administration, Organisationen, Selbstbedienung). */
export function useAccount(enabled = true) {
  return useQuery({ queryKey: iamKeys.account, enabled, staleTime: 5 * 60_000, queryFn: ({ signal }) => accountApi.get(signal) });
}
