/**
 * Aus einem geprüften Token wird der Principal: wer (Person oder Maschinen-Client), in welchem Mandanten
 * (Keycloak-Organisation), mit welchen Gruppen aus Entra ID und Scopes (Spezifikation Kap. 4, 6.2). Rollen stehen nicht
 * im Principal und nie im Token; sie kommen aus Tupeln (`authz_tuple`, Kap. 7.4). Client-Rollen (`resource_access`) und
 * Rollengruppen werden nicht gelesen.
 *
 * Zwischenspeicher und Wirkungszeiten (Kap. 6.2, 7.9): Mandant 60 s, Principal 5 min, «Nur Entra» je Domäne 60 s; die
 * Freigabe eines Clients (Tupel an org) sofort über `acl_version`. `forget…` nach Sperren, Entfernen, Änderung der
 * Entra-Verbindung (andere Instanzen nach Ablauf). Alle Schlüssel enthalten den Mandanten bzw. die ID der Organisation.
 */
import type { AccessService } from './access.ts';
import { subjectsOf } from './access.ts';
import type { IamConfig } from './config.ts';
import { schemaName, withTx, type Db } from './db.ts';
import { HttpError } from './errors.ts';
import type { Level } from './model.ts';
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
  /** Objekt-IDs der Gruppen aus Entra ID (Claim `GROUPS_CLAIM`), nur als Subjekte `group:<id>`. */
  groups: string[];
  /** Subjekte nach Kap. 7.5: `user:<id>`, `group:<id>` je Gruppe, `org:members`; Client nur `client:<id>`. */
  subjects: string[];
  scopes: string[];
  platformAdmin: boolean;
  binding: VerifiedToken['binding'];
  /** Rechte zusätzlich durch die Scopes des Tokens begrenzt (Maschinen-Clients und Zugriffe über den MCP-Dienst). */
  scopeBound?: boolean;
  /** Wirksame Freigabestufe (mit Break-Glass) beim Auflösen der Anfrage; entschieden wird mit dem aktuellen Stand. */
  clearance?: Level;
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

/** Service Account eines Keycloak-Clients (Client-Credentials), nicht eine Person über einen fremden Client. */
export function isServiceAccount(claims: Claims): boolean {
  // Ohne Scope `profile` fehlt `preferred_username`; dann zählt der Claim `client_id` ohne Personenmerkmale (wie isClient)
  return String(claims.preferred_username ?? '').startsWith('service-account-')
    || (claims.preferred_username == null && typeof claims.client_id === 'string' && !claims.email && !claims.given_name);
}

const OBJECT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Objekt-IDs der Gruppen aus Entra ID (Claim `GROUPS_CLAIM`); nur GUIDs, klein geschrieben, ohne Doppelte. */
export function groupsFromClaims(claims: Claims, claim: string): string[] {
  const g = claims[claim];
  return Array.isArray(g) ? [...new Set(g.filter((x): x is string => typeof x === 'string' && OBJECT_ID.test(x)).map(x => x.toLowerCase()))] : [];
}

/**
 * Person oder Maschinen-Client? Personen-Tokens stellen nur die Clients der Plattform aus (`azp` in
 * OIDC_PERSON_CLIENT_IDS, Standard BFF und MCP-Dienst); alles andere gilt als Maschinen-Client – auch ein
 * Service Account ohne die Scopes `profile`/`service_account`, der sonst wie eine Person aussähe.
 */
export function isClient(claims: Claims, personClients?: string[]): boolean {
  if (isServiceAccount(claims)) return true;
  if (personClients && !personClients.includes(String(claims.azp ?? ''))) return true;
  return typeof claims.client_id === 'string' && !claims.email && !claims.given_name;
}

/** 403 für einen nicht freigegebenen Maschinen-Client (Kap. 6.2). */
export const clientNotGranted = (clientId: string | null, alias: string) => new HttpError(403, 'Client nicht freigegeben',
  `Der Maschinen-Client «${clientId ?? '?'}» ist für die Organisation «${alias}» nicht freigegeben. Eine Person mit dem Recht «Mitglieder und Rollen verwalten» gibt ihn unter «Verwalten › Mitglieder» frei (PUT /v1/admin/clients/{clientId}).`);

export class PrincipalResolver {
  private readonly db: Db;
  private readonly cfg: Pick<IamConfig, 'tenancy' | 'oidc' | 'mcp'>;
  private readonly schema: string;
  private readonly access: Pick<AccessService, 'load' | 'clientGranted' | 'clearanceOf'> | null;
  private readonly seen = new Map<string, { id: string; token: string; at: number }>();
  private readonly personClients: string[];

  /**
   * @param o.schema Schema der Tabellen (`principal`)
   * @param o.access Entscheidung (Freigabe von Clients über Tupel, Freigabestufe); ohne gilt kein Client als freigegeben
   */
  constructor(db: Db, cfg: Pick<IamConfig, 'tenancy' | 'oidc' | 'mcp'>, o: { schema: string; access?: Pick<AccessService, 'load' | 'clientGranted' | 'clearanceOf'> | null }) {
    this.db = db; this.cfg = cfg; this.schema = schemaName(o.schema); this.access = o.access ?? null;
    this.personClients = cfg.tenancy.personClients.length ? cfg.tenancy.personClients : [cfg.oidc.bffClientId, cfg.mcp.clientId];
  }

  /** Person oder Maschinen-Client nach den Claims (wie in `resolve`), ohne Datenbank. */
  kindOf(claims: VerifiedToken['claims']): Principal['kind'] {
    return isClient(claims, this.personClients) ? 'client' : 'user';
  }

  /**
   * @param requestedTenant optional gewünschter Mandant (Header `X-Tenant` bzw. Wahl der Sitzung), muss im Token
   *   enthalten sein. Ungültige Aliasse (ALIAS_PATTERN nach ASCII-Kleinschreibung) im Wunsch oder im Claim → 403.
   */
  async resolve(v: VerifiedToken, requestedTenant?: string | null): Promise<Principal> {
    const c = v.claims, t = this.cfg.tenancy;
    const realmRoles = ((c.realm_access as { roles?: string[] } | undefined)?.roles) ?? [];
    const platformAdmin = realmRoles.includes(t.platformAdminRole);
    // Aliasse nur ASCII klein geschrieben vergleichen; ungültige passen nie zu einem gültigen Wunsch
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
    // Maschinen-Clients legen nie einen Mandanten an und gelten nur, wo ihre Client-ID freigegeben ist (Tupel an org)
    const tenantId = await this.tenantId(org.alias, org.id, kind === 'user', org.name);
    const alias = org.alias;
    const scopes = String(c.scope ?? '').split(' ').filter(Boolean);
    let principalId: string;
    let grantId: string | null = null;
    if (kind === 'client') {
      grantId = this.machineClientId(c, clientId);
      principalId = await this.clientPrincipal(tenantId, alias, grantId, scopes);
    } else {
      principalId = await this.userPrincipal(tenantId, String(c.sub), name, (c.email as string) ?? null, (c.azp as string) ?? null, Number(c.iat ?? 0));
    }
    const groups = kind === 'user' ? groupsFromClaims(c, t.groupsClaim) : [];
    const p: Principal = {
      tenantId, tenantAlias: alias, principalId, kind, subject: kind === 'client' ? grantId! : String(c.sub), name, email: (c.email as string) ?? null,
      clientId, grantId, groups, subjects: [], identityProvider: typeof c.identity_provider === 'string' ? c.identity_provider : null,
      scopes, platformAdmin, binding: v.binding, token: v.token,
      scopeBound: kind === 'client' || (clientId !== null && clientId === this.cfg.mcp.clientId),
    };
    p.subjects = subjectsOf(p);
    return p;
  }

  private readonly entra = new Map<string, { alias: string | null; at: number }>();
  /** Nach Verbinden, Ändern oder Trennen einer Entra-Verbindung (andere Instanzen nach spätestens 60 s). */
  forgetEntra() { this.entra.clear(); }
  /**
   * Nur Entra: Ist die Domäne der Adresse an Microsoft Entra ID gebunden, gilt das Token nur nach einer Anmeldung über
   * genau diesen Anbieter (Claim `identity_provider`). Ausgenommen ist die Plattform-Administration (Notfallzugang).
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
  private async tenantId(alias: string, kcId: string | null, mayCreate: boolean, name = alias): Promise<string> {
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

  /**
   * Principal eines Maschinen-Clients: entsteht nur mit der Freigabe (A18), nie über ein Token. Ohne Principal oder ohne
   * nicht abgelaufenes Tupel `client:<id> <rolle> org` → 403 «Client nicht freigegeben» (Regel 6, sofort über acl_version).
   * Danach letzter Zugriff und Scopes des Tokens (Anzeige in der Verwaltung).
   */
  private async clientPrincipal(tenantId: string, alias: string, clientId: string | null, scopes: string[]): Promise<string> {
    if (!clientId || !this.access) throw clientNotGranted(clientId, alias);
    const acl = await this.access.load(tenantId);
    const k = `${tenantId}:client:${clientId}`, hit = this.seen.get(k), seen = JSON.stringify(scopes);
    let id = hit && Date.now() - hit.at < 300_000 ? hit.id : null;
    if (!id) {
      id = await withTx(this.db, async tx => {
        await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        return (await tx.query<{ id: string }>(`SELECT id FROM ${this.schema}.principal WHERE kind = 'client' AND client_id = $1`, [clientId])).rows[0]?.id ?? null;
      });
    }
    if (!id || !this.access.clientGranted(acl, id)) throw clientNotGranted(clientId, alias);
    if (!hit || hit.token !== seen || Date.now() - hit.at >= 300_000) {
      await withTx(this.db, async tx => {
        await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await tx.query(`UPDATE ${this.schema}.principal SET last_seen_at = now(), last_scopes = $2 WHERE id = $1`, [id, scopes]);
      });
      this.seen.set(k, { id, token: seen, at: Date.now() });
    }
    return id;
  }

  /** Nach dem Entfernen einer Person (andere Instanzen nach spätestens 5 min; Tokens von davor gelten danach nie mehr). */
  forgetPrincipal(tenantId: string, subject: string) { this.seen.delete(`${tenantId}:user:${subject}`); }

  /**
   * Person im Mandanten spiegeln. Wurde sie entfernt (removed_at), gilt ein Token nur, wenn es danach ausgestellt wurde –
   * dann ist sie wieder Mitglied (Keycloak nimmt die Organisation sonst nicht ins Token).
   */
  private async userPrincipal(tenantId: string, subject: string, name: string, email: string | null, clientId: string | null, iat: number): Promise<string> {
    const k = `${tenantId}:user:${subject}`, hit = this.seen.get(k);
    if (hit && Date.now() - hit.at < 300_000) return hit.id;
    const row = await withTx(this.db, async tx => {
      await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const r = await tx.query<{ id: string; removed: boolean }>(
        `INSERT INTO ${this.schema}.principal AS p (tenant_id, kind, subject, display_name, email, client_id) VALUES ($1, 'user', $2, $3, $4, $5)
         ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET
           display_name = CASE WHEN p.removed_at > to_timestamp($6) THEN p.display_name ELSE excluded.display_name END,
           email = CASE WHEN p.removed_at > to_timestamp($6) THEN p.email ELSE excluded.email END,
           client_id = excluded.client_id,
           last_seen_at = CASE WHEN p.removed_at > to_timestamp($6) THEN p.last_seen_at ELSE now() END,
           removed_at = CASE WHEN p.removed_at > to_timestamp($6) THEN p.removed_at END
         RETURNING id, removed_at IS NOT NULL AS removed`, [tenantId, subject, name, email, clientId, iat]);
      return r.rows[0]!;
    });
    if (row.removed) throw new HttpError(403, 'Kein Mitglied mehr', 'Du wurdest aus dieser Organisation entfernt. Bitte melde dich neu an.');
    this.seen.set(k, { id: row.id, token: '', at: Date.now() });
    return row.id;
  }
}
