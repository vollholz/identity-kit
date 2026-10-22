/**
 * Claims, wie Keycloak sie im Realm einer App ausstellt (Spezifikation Kap. 3.4, 6.2): Personen über den BFF-Client mit
 * Organisationen und Rollengruppen `<prefix>/<alias>/<rolle>`, Service Accounts mit fester Organisation und Client-Rollen.
 */
import { randomUUID } from 'node:crypto';

export interface ClaimsOptions {
  /** Client der Oberfläche (`azp` von Personen), z. B. `<produkt>-platform`. */
  personClientId: string;
  /** Client mit den Rollen (`resource_access`), Standard wie `personClientId`. */
  roleClientId?: string;
  /** Präfix der Rollengruppen, Standard `/orgs`. */
  groupPrefix?: string;
}

export interface PersonClaims { sub?: string; org: string | string[]; roles?: string[]; groupRoles?: string[]; email?: string; name?: string }
export interface ServiceAccountClaims { clientId: string; org: string; roles: string[]; scopes: string[] }

export function claimsFor(o: ClaimsOptions) {
  const roleClient = o.roleClientId ?? o.personClientId;
  const prefix = (o.groupPrefix ?? '/orgs').replace(/\/$/, '');
  return {
    /** Person einer oder mehrerer Organisationen; Rollengruppen gelten für die erste. */
    user(p: PersonClaims) {
      const orgs = Array.isArray(p.org) ? p.org : [p.org];
      return {
        sub: p.sub ?? randomUUID(), name: p.name ?? 'Test Person', email: p.email ?? 'test@example.ch', given_name: 'Test', preferred_username: 'test', azp: o.personClientId,
        organization: orgs, groups: (p.groupRoles ?? []).map(r => `${prefix}/${orgs[0]}/${r}`), resource_access: { [roleClient]: { roles: p.roles ?? [] } }, scope: 'openid profile email organization',
      };
    },
    /** Service Account eines Maschinen-Clients. */
    client(p: ServiceAccountClaims) {
      return { sub: randomUUID(), azp: p.clientId, client_id: p.clientId, preferred_username: `service-account-${p.clientId}`, organization: [p.org], resource_access: { [roleClient]: { roles: p.roles } }, scope: p.scopes.join(' ') };
    },
  };
}
