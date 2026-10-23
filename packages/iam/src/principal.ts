/**
 * Aus einem geprüften Token wird der Principal: wer (Person oder Maschinen-Client), in welchem Mandanten
 * (Keycloak-Organisation), mit welchen Rollen, Gruppen und Scopes. Spezifikation Kap. 4, 6.2; aus Assets
 * `auth/principal.ts`.
 *
 * Zwischenspeicher und Wirkungszeiten (Entwurf 13.6): Mandant 60 s, Freigabe eines Clients 60 s, Principal 5 min,
 * «Nur Entra» je Domäne 60 s; `forget…` nach Sperren, Entzug, Entfernen, Änderung der Entra-Verbindung (andere
 * Instanzen nach Ablauf). Alle Schlüssel enthalten den Mandanten bzw. die ID der Organisation.
 */
import type { IamConfig } from './config.ts';
import { schemaName, withTx, type Db } from './db.ts';
import { HttpError } from './errors.ts';
import type { VerifiedToken } from './tokens.ts';

export interface Principal {
  tenantId: string;
  tenantAlias: string;
  principalId: string;
  kind: 'user' | 'client';
  subject: string;
  name: string;
  email: string | null;
  clientId: string | null;
  /**
   * Client-ID der Freigabe bei Maschinen-Clients: bei Token-Austausch über den MCP-Dienst der ursprüngliche Client
   * (`client_id`), nicht `azp`; sonst gleich `clientId`. Bei Personen null.
   */
  grantId?: string | null;
  roles: string[];
  groups: string[];
  scopes: string[];
  platformAdmin: boolean;
  binding: VerifiedToken['binding'];
  /** Rechte zusätzlich durch die Scopes des Tokens begrenzt (Maschinen-Clients und Zugriffe über den MCP-Dienst). */
  scopeBound?: boolean;
  /** Anbieter, über den die Sitzung angemeldet wurde (Claim `identity_provider`, z. B. `entra-001`); sonst null. */
  identityProvider?: string | null;
  /** Token für Weitergabe (z. B. Token Exchange im MCP-Dienst). */
  token: string;
}

type Claims = VerifiedToken['claims'];

/** Organisationen aus dem Claim lesen. Keycloak 26 liefert je nach Mapper eine Liste von Aliassen oder ein Objekt. */
export function orgsFromClaims(claims: Claims, claim: string): { alias: string; id: string | null }[] {
  const v = claims[claim];
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string').map(alias => ({ alias, id: null }));
  if (v && typeof v === 'object') return Object.entries(v as Record<string, { id?: string }>).map(([alias, o]) => ({ alias, id: o?.id ?? null }));
  if (typeof v === 'string') return [{ alias: v, id: null }];
  return [];
}

/** Alias einer Organisation (wie `tenant.alias` in der Datenbank). */
export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Nur A–Z → a–z. `toLowerCase()` faltet auch Unicode (Kelvin-Zeichen U+212A → «k») und machte fremde Aliasse gleich. */
export const asciiLower = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());

/** Alias aus Claim, `X-Tenant` oder `?org=`: ASCII klein geschrieben und geprüft, sonst null. */
export function orgAlias(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const a = asciiLower(v);
  return ALIAS_PATTERN.test(a) ? a : null;
}

const invalidOrg = () => new HttpError(403, 'Organisation ungültig', 'Der Alias der Organisation besteht aus Kleinbuchstaben, Ziffern, «-» und «_» (höchstens 63 Zeichen).');

/** Service Account eines Keycloak-Clients (Client-Credentials), nicht eine Person über einen fremden Client (E5). */
export function isServiceAccount(claims: Claims): boolean {
  // Ohne Scope `profile` fehlt `preferred_username`; dann zählt der Claim `client_id` ohne Personenmerkmale (wie isClient)
  return String(claims.preferred_username ?? '').startsWith('service-account-')
    || (claims.preferred_username == null && typeof claims.client_id === 'string' && !claims.email && !claims.given_name);
}

/**
 * Rolle aus einem Gruppenpfad `<prefix>/<alias>/<rolle>`, wenn der Alias (nur ASCII klein geschrieben) der gewählten
 * Organisation entspricht; sonst null.
 */
function groupRole(path: string, tenantAlias: string, cfg: IamConfig['tenancy']): string | null {
  const root = `${cfg.groupRolePrefix}/`;
  if (!path.startsWith(root)) return null;
  const rest = path.slice(root.length), slash = rest.indexOf('/');
  return slash > 0 && asciiLower(rest.slice(0, slash)) === tenantAlias ? rest.slice(slash + 1) : null;
}

/**
 * Rollen im gewählten Mandanten. Gruppen `<prefix>/<alias>/<rolle>` gelten nur für diese Organisation. Client-Rollen
 * (`resource_access`) kennen keine Organisation: Für Service Accounts gelten sie immer (der Client ist je Mandant
 * freigegeben, E5), für Personen – auch über einen fremden, freigegebenen Client – nur mit ROLE_SOURCE=client|both
 * und nur, wenn das Token genau eine Organisation enthält (`orgCount`); sonst trügen sie Rechte in jede Organisation
 * der Person. Mit mehreren Organisationen zählen für Personen nur die Gruppen.
 */
export function rolesFromClaims(claims: Claims, tenantAlias: string, cfg: IamConfig['tenancy'], serviceAccount = false, orgCount = 1): string[] {
  const out = new Set<string>();
  if (serviceAccount || (cfg.roleSource !== 'groups' && orgCount <= 1)) {
    const ra = claims.resource_access as Record<string, { roles?: string[] }> | undefined;
    for (const r of ra?.[cfg.roleClientId]?.roles ?? []) out.add(r);
  }
  if (cfg.roleSource !== 'client') {
    for (const g of groupsFromClaims(claims, cfg.groupsClaim)) {
      const r = groupRole(g, tenantAlias, cfg);
      if (r) out.add(r);
    }
  }
  return [...out];
}

export function groupsFromClaims(claims: Claims, claim: string): string[] {
  const g = claims[claim];
  return Array.isArray(g) ? g.filter((x): x is string => typeof x === 'string') : [];
}

/** Gruppen für ACL-Einträge im Mandanten: ohne Gruppen anderer Organisationen (`<prefix>/<anderer-alias>/…`). */
export function tenantGroups(claims: Claims, tenantAlias: string, cfg: IamConfig['tenancy']): string[] {
  const root = `${cfg.groupRolePrefix}/`;
  return groupsFromClaims(claims, cfg.groupsClaim).filter(g => !g.startsWith(root) || groupRole(g, tenantAlias, cfg) !== null);
}

/**
 * Warnung beim Start (O7): Mit ROLE_SOURCE=client|both gelten Client-Rollen von Personen nur, solange das Token genau
 * eine Organisation enthält; Personen in mehreren Organisationen verlieren sie (rolesFromClaims).
 */
export function roleSourceWarning(cfg: IamConfig['tenancy']): string | null {
  if (cfg.roleSource === 'groups') return null;
  return `ROLE_SOURCE=${cfg.roleSource}: Client-Rollen (${cfg.roleClientId}) von Personen gelten nur, wenn das Token genau eine Organisation enthält; `
    + 'Personen in mehreren Organisationen erhalten Rollen nur über Gruppen. Empfohlen: ROLE_SOURCE=groups (Rollen je Organisation über Gruppen).';
}

/**
 * Person oder Maschinen-Client? Personen-Tokens stellen nur die Clients der Plattform aus (`azp` in
 * OIDC_PERSON_CLIENT_IDS, Standard BFF und MCP-Dienst); alles andere gilt als Maschinen-Client – auch ein
 * Service Account ohne die Scopes `profile`/`service_account`, der sonst wie eine Person aussähe. Freigabe je Mandant
 * und Scope-Grenze gelten für alle Maschinen-Clients; Client-Rollen nur für Service Accounts (rolesFromClaims).
 */
export function isClient(claims: Claims, personClients?: string[]): boolean {
  if (isServiceAccount(claims)) return true;
  if (personClients && !personClients.includes(String(claims.azp ?? ''))) return true;
  return typeof claims.client_id === 'string' && !claims.email && !claims.given_name;
}

export class PrincipalResolver {
  private readonly db: Db;
  private readonly cfg: Pick<IamConfig, 'tenancy' | 'oidc' | 'mcp'>;
  private readonly schema: string;
  private readonly seen = new Map<string, { id: string; token: string; at: number }>();

  private readonly personClients: string[];
  private readonly grants = new Map<string, { ok: boolean; at: number }>();

  /** @param o.schema Schema der Tabellen (`principal`, `client_grant`) */
  constructor(db: Db, cfg: Pick<IamConfig, 'tenancy' | 'oidc' | 'mcp'>, o: { schema: string }) {
    this.db = db; this.cfg = cfg; this.schema = schemaName(o.schema);
    this.personClients = cfg.tenancy.personClients.length ? cfg.tenancy.personClients : [cfg.oidc.bffClientId, cfg.mcp.clientId];
  }

  /**
   * @param requestedTenant optional gewünschter Mandant (Header `X-Tenant` bzw. Wahl der Sitzung), muss im Token
   *   enthalten sein. Ungültige Aliasse (ALIAS_PATTERN nach ASCII-Kleinschreibung) im Wunsch oder im Claim → 403.
   */
  async resolve(v: VerifiedToken, requestedTenant?: string | null): Promise<Principal> {
    const c = v.claims, t = this.cfg.tenancy;
    const realmRoles = ((c.realm_access as { roles?: string[] } | undefined)?.roles) ?? [];
    const platformAdmin = realmRoles.includes(t.platformAdminRole);
    // Aliasse nur ASCII klein geschrieben vergleichen (A4); ungültige passen nie zu einem gültigen Wunsch
    const orgs = orgsFromClaims(c, t.claim).map(o => ({ ...o, alias: asciiLower(o.alias), name: o.alias }));
    const wanted = requestedTenant ? orgAlias(requestedTenant) : null;
    if (requestedTenant && !wanted) throw invalidOrg();
    const org = wanted ? orgs.find(o => o.alias === wanted) : orgs.length === 1 ? orgs[0] : undefined;
    if (!org) {
      if (!orgs.length) throw new HttpError(403, 'Keine Organisation', `Das Token enthält keine Organisation (Claim «${t.claim}»). Scope «organization» anfordern.`);
      if (wanted) throw new HttpError(403, 'Organisation nicht erlaubt', `Kein Zugriff auf «${wanted}».`);
      throw new HttpError(400, 'Organisation wählen', 'Das Token enthält mehrere Organisationen. Header «X-Tenant» mit dem Alias setzen.', {}, { organizations: orgs.map(o => o.alias) });
    }
    if (!ALIAS_PATTERN.test(org.alias)) throw invalidOrg();
    const kind: Principal['kind'] = isClient(c, this.personClients) ? 'client' : 'user';
    if (kind === 'user' && !platformAdmin) await this.requireEntraLogin(c);
    const name = String(c.name ?? c.preferred_username ?? c.azp ?? c.sub);
    const clientId = (c.azp as string) ?? (c.client_id as string) ?? null;
    // Maschinen-Clients legen nie einen Mandanten an und gelten nur, wo ihre Client-ID freigegeben ist (Nr. 58)
    const tenantId = await this.tenantId(org.alias, org.id, kind === 'user', org.name);
    // Client-ID der Freigabe (bei Token-Austausch über MCP nicht `azp`, sondern der ursprüngliche Client); am Principal
    // gespeichert, damit die Verwaltung Zugriffe, Rollen und Scopes der richtigen Freigabe zuordnet (Nr. 102 A4)
    const grantId = kind === 'client' ? this.machineClientId(c, clientId) : null;
    if (kind === 'client') await this.requireGrant(tenantId, org.alias, grantId);
    const alias = org.alias;
    const roles = rolesFromClaims(c, alias, t, isServiceAccount(c), orgs.length), scopes = String(c.scope ?? '').split(' ').filter(Boolean);
    // Rollen und Scopes nur bei Maschinen-Clients am Principal speichern (Anzeige in der Verwaltung, Nr. 102 A4)
    const principalId = await this.principalId(tenantId, kind, String(c.sub), name, (c.email as string) ?? null, kind === 'client' ? grantId : (c.azp as string) ?? null, Number(c.iat ?? 0),
      kind === 'client' ? { roles, scopes } : null);
    return {
      tenantId, tenantAlias: alias, principalId, kind, subject: String(c.sub), name, email: (c.email as string) ?? null,
      clientId, grantId, roles, groups: tenantGroups(c, alias, t), identityProvider: typeof c.identity_provider === 'string' ? c.identity_provider : null,
      scopes, platformAdmin, binding: v.binding, token: v.token,
      scopeBound: kind === 'client' || (clientId !== null && clientId === this.cfg.mcp.clientId),
    };
  }

  private readonly entra = new Map<string, { alias: string | null; at: number }>();
  /** Nach Verbinden, Ändern oder Trennen einer Entra-Verbindung (andere Instanzen nach spätestens 60 s). */
  forgetEntra() { this.entra.clear(); }
  /**
   * Nur Entra (Nr. 104, Entscheid 2): Ist die Domäne der Adresse an Microsoft Entra ID gebunden, gilt das Token nur nach
   * einer Anmeldung über genau diesen Anbieter (Claim `identity_provider`, Session-Note von Keycloak, Mapper an den
   * Personen-Clients). So bleibt auch ein über «Passwort vergessen» neu gesetztes Passwort wirkungslos. Ausgenommen ist
   * die Plattform-Administration (Notfallzugang).
   */
  private async requireEntraLogin(c: Claims): Promise<void> {
    const email = typeof c.email === 'string' ? c.email : '';
    const domain = email.includes('@') ? asciiLower(email.slice(email.lastIndexOf('@') + 1)) : '';
    if (!domain) return;
    let hit = this.entra.get(domain);
    if (!hit || Date.now() - hit.at > 60_000) {
      hit = { alias: (await this.db.query<{ a: string | null }>('SELECT app.entra_login_alias($1) AS a', [domain])).rows[0]?.a ?? null, at: Date.now() };
      this.entra.set(domain, hit);
    }
    if (hit.alias && c.identity_provider !== hit.alias) {
      throw new HttpError(403, 'Anmeldung über Microsoft nötig', `Adressen @${domain} melden sich über Microsoft Entra ID an. Bitte abmelden und über Microsoft neu anmelden.`, {}, { reason: 'entra-login-required' });
    }
  }

  private readonly tenants = new Map<string, { id: string; at: number }>();
  /** Nach Sperren/Entsperren: Mandant beim nächsten Zugriff neu auflösen (andere Instanzen nach spätestens 60 s). */
  forgetTenant(alias: string) { for (const k of this.tenants.keys()) if (k.split('|')[0] === asciiLower(alias)) this.tenants.delete(k); }
  /** @param alias geprüfter Alias (ALIAS_PATTERN), @param name Name eines neu angelegten Mandanten (Alias wie im Token) */
  private async tenantId(alias: string, kcId: string | null, mayCreate: boolean, name = alias): Promise<string> {
    // Schlüssel mit der ID der Organisation (falls im Token): eine neue Organisation mit altem Alias trifft keinen Cache-Eintrag
    const k = `${alias}|${kcId ?? ''}`, hit = this.tenants.get(k);
    if (hit && Date.now() - hit.at < 60_000) return hit.id;
    const r = await this.db.query<{ id: string | null }>('SELECT app.resolve_tenant($1, $2, $3, $4) AS id', [alias, kcId, name, mayCreate && this.cfg.tenancy.autoProvision]);
    const id = r.rows[0]?.id;
    if (!id) throw new HttpError(403, 'Organisation nicht verfügbar', `Organisation «${alias}» ist nicht freigeschaltet oder gesperrt.`);
    this.tenants.set(k, { id, at: Date.now() });
    return id;
  }

  /**
   * Client-ID des Maschinen-Clients für die Freigabe. Über den MCP-Dienst (Token Exchange) ist `azp` der MCP-Dienst;
   * dann zählt der ursprüngliche Client (`client_id` bzw. Benutzername des Service Accounts).
   */
  private machineClientId(c: Claims, azp: string | null): string | null {
    if (!azp || !this.personClients.includes(azp)) return azp;
    if (typeof c.client_id === 'string' && c.client_id !== azp) return c.client_id;
    const u = String(c.preferred_username ?? '');
    return u.startsWith('service-account-') ? u.slice('service-account-'.length) : null;
  }

  /** Nach Freigabe oder Entzug eines Maschinen-Clients (andere Instanzen nach spätestens 60 s). */
  forgetClient(tenantId: string, clientId: string) { this.grants.delete(`${tenantId}:${clientId}`); }
  private async requireGrant(tenantId: string, alias: string, clientId: string | null): Promise<void> {
    const k = `${tenantId}:${clientId}`, hit = this.grants.get(k);
    let ok = hit && Date.now() - hit.at < 60_000 ? hit.ok : null;
    if (ok === null) {
      ok = !!clientId && await withTx(this.db, async tx => {
        await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        return ((await tx.query(`SELECT 1 FROM ${this.schema}.client_grant WHERE client_id = $1`, [clientId])).rowCount ?? 0) > 0;
      });
      this.grants.set(k, { ok, at: Date.now() });
    }
    if (!ok) {
      throw new HttpError(403, 'Client nicht freigegeben', `Der Maschinen-Client «${clientId ?? '?'}» ist für die Organisation «${alias}» nicht freigegeben. `
        + 'Ein org-admin dieser Organisation gibt ihn unter «Verwalten › Maschinen-Clients» frei (PUT /v1/admin/clients/{clientId}).');
    }
  }

  /** Nach dem Entfernen einer Person (andere Instanzen nach spätestens 5 min; Tokens von davor gelten danach nie mehr). */
  forgetPrincipal(tenantId: string, subject: string) { this.seen.delete(`${tenantId}:user:${subject}`); }

  /**
   * Principal im Mandanten spiegeln. Wurde die Person entfernt (removed_at), gilt ein Token nur, wenn es danach
   * ausgestellt wurde – dann ist sie wieder Mitglied (Keycloak nimmt die Organisation sonst nicht ins Token).
   * @param token Rollen und Scopes des Tokens (nur Maschinen-Clients); geänderte Werte werden sofort gespeichert.
   */
  private async principalId(tenantId: string, kind: string, subject: string, name: string, email: string | null, clientId: string | null, iat: number,
    token: { roles: string[]; scopes: string[] } | null): Promise<string> {
    const k = `${tenantId}:${kind}:${subject}`, hit = this.seen.get(k);
    const seen = token ? JSON.stringify(token) : '';
    if (hit && hit.token === seen && Date.now() - hit.at < 300_000) return hit.id;
    const row = await withTx(this.db, async tx => {
      await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const r = await tx.query<{ id: string; removed: boolean }>(
        `INSERT INTO ${this.schema}.principal AS p (tenant_id, kind, subject, display_name, email, client_id, last_roles, last_scopes) VALUES ($1, $2, $3, $4, $5, $6, $8, $9)
         ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET
           display_name = CASE WHEN p.removed_at > to_timestamp($7) THEN p.display_name ELSE excluded.display_name END,
           email = CASE WHEN p.removed_at > to_timestamp($7) THEN p.email ELSE excluded.email END,
           client_id = CASE WHEN p.kind = 'client' THEN excluded.client_id ELSE p.client_id END,
           last_roles = CASE WHEN p.removed_at > to_timestamp($7) THEN p.last_roles ELSE excluded.last_roles END,
           last_scopes = CASE WHEN p.removed_at > to_timestamp($7) THEN p.last_scopes ELSE excluded.last_scopes END,
           last_seen_at = CASE WHEN p.removed_at > to_timestamp($7) THEN p.last_seen_at ELSE now() END,
           removed_at = CASE WHEN p.removed_at > to_timestamp($7) THEN p.removed_at END
         RETURNING id, removed_at IS NOT NULL AS removed`, [tenantId, kind, subject, name, email, clientId, iat, token?.roles ?? null, token?.scopes ?? null]);
      return r.rows[0]!;
    });
    if (row.removed) throw new HttpError(403, 'Kein Mitglied mehr', 'Du wurdest aus dieser Organisation entfernt. Bitte melde dich neu an.');
    this.seen.set(k, { id: row.id, token: seen, at: Date.now() });
    return row.id;
  }
}
