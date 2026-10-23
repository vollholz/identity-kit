/**
 * Claims, wie Keycloak sie im Realm einer App ausstellt (Spezifikation Kap. 3.4, 6.2): Personen über den BFF-Client mit
 * Organisationen und – mit Entra ID – den Objekt-IDs ihrer Gruppen (`groups`), Service Accounts mit fester
 * Organisation und Scopes. Rollen stehen nie im Token (D6): weder Client-Rollen noch Rollengruppen.
 */
import { randomUUID } from 'node:crypto';

export interface ClaimsOptions {
  /** Client der Oberfläche (`azp` von Personen), z. B. `<produkt>-platform`. */
  personClientId: string;
}

/** `groups`: Objekt-IDs der Gruppen aus Entra ID (Claim `groups`, Subjekte `group:<id>`). */
export interface PersonClaims { sub?: string; org: string | string[]; groups?: string[]; email?: string; name?: string; scope?: string }
export interface ServiceAccountClaims { clientId: string; org: string | string[]; scopes: string[] }

export function claimsFor(o: ClaimsOptions) {
  return {
    /** Person einer oder mehrerer Organisationen. */
    user(p: PersonClaims) {
      const orgs = Array.isArray(p.org) ? p.org : [p.org];
      return {
        sub: p.sub ?? randomUUID(), name: p.name ?? 'Test Person', email: p.email ?? 'test@example.ch', given_name: 'Test', preferred_username: 'test', azp: o.personClientId,
        organization: orgs, ...(p.groups ? { groups: p.groups } : {}), scope: p.scope ?? 'openid profile email organization',
      };
    },
    /** Service Account eines Maschinen-Clients (Organisationen aus dem Hardcoded-Claim des Realm-Moduls). */
    client(p: ServiceAccountClaims) {
      return { sub: randomUUID(), azp: p.clientId, client_id: p.clientId, preferred_username: `service-account-${p.clientId}`, organization: Array.isArray(p.org) ? p.org : [p.org], scope: p.scopes.join(' ') };
    },
  };
}
