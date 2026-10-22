/**
 * Zugriffsentscheidung: (Rolle ∨ Freigabe) ∧ Scopes (für Clients und MCP) ∧ Zugriffsregeln (Spezifikation Kap. 7.1;
 * aus Assets `authz/access.ts`; öffentliche API nach Entwurf 13.2).
 *
 * Semantik der Wirkung `effect` eines Eintrags:
 * - Ressourcen bilden eine Kette ab dem Mandanten (`ResourceModel.chain` der App).
 * - `grant` (Freigabe) gibt passenden Principals das Recht auf der Ressource und allem darunter, auch ohne Rolle mit
 *   dem Recht. Nie auf Blättern, nie für Rechte nur von org-admin; bei Clients und MCP nur, soweit ein Scope das Recht
 *   abdeckt. Freigaben ersetzen nur die Rolle: Verbote und Beschränkungen gelten auch für sie.
 * - `deny` (Verbot) auf irgendeiner Stufe verbietet (für passende Principals).
 * - `restrict` (Beschränkung): Gibt es auf einer Stufe solche Einträge für ein Recht, behalten es nur passende
 *   Principals. Ohne Einträge gilt das Recht aus Rolle oder Freigabe.
 * - Personen mit `org-admin` sind von Verboten und Beschränkungen ausgenommen, damit sich niemand aussperren kann.
 *   Maschinen-Clients mit `org-admin` nicht.
 *
 * Zugriffsregeln, eigene Rollen und Zustand der Kette werden je Mandant zwischengespeichert, gültig solange
 * `tenant.acl_version` (Trigger bei jeder Änderung) und `ResourceModel.version` gleich sind – Änderungen wirken sofort
 * auf allen Instanzen.
 */
import { createHash } from 'node:crypto';
import type { Catalog } from './catalog.ts';
import { ADMIN_ROLE } from './catalog.ts';
import { schemaName, withTenant, type Db } from './db.ts';
import { forbidden } from './errors.ts';
import type { Principal } from './principal.ts';
import { flatChain, type ResourceModel, type ResourceRef } from './resources.ts';

/** Wirkungen eines Eintrags; `allow` nimmt die API noch als alten Namen für `restrict` an. */
export const ACL_EFFECTS = ['restrict', 'deny', 'grant'] as const;
export type AclEffect = typeof ACL_EFFECTS[number];
export interface AclRow { resource_type: string; resource_id: string | null; principal_type: string; principal_ref: string; permission: string; effect: AclEffect }

/** Stand der Zugriffsregeln eines Mandanten. `byKey`: Einträge je Recht und Ressource; `roles`: eigene Rollen. */
export interface TenantAccess<S = unknown> {
  version: string;
  entries: readonly AclRow[];
  byKey: ReadonlyMap<string, AclRow[]>;
  roles: ReadonlyMap<string, readonly string[]>;
  state: S;
}

const aclKey = (perm: string, type: string, id: string | null | undefined) => `${perm}|${type}|${id ?? ''}`;

/** Einträge nach Recht und Ressource gruppiert (für TenantAccess.byKey). */
export function indexAcl(entries: readonly AclRow[]): Map<string, AclRow[]> {
  const m = new Map<string, AclRow[]>();
  for (const e of entries) {
    const k = aclKey(e.permission, e.resource_type, e.resource_id);
    const list = m.get(k);
    if (list) list.push(e); else m.set(k, [e]);
  }
  return m;
}

export class AccessService<P extends string = string, S = unknown> {
  private readonly cache = new Map<string, TenantAccess<S>>();
  private readonly db: Db;
  private readonly schema: string;
  readonly catalog: Catalog<P>;
  readonly resources: ResourceModel<S> | null;

  constructor(db: Db, o: { catalog: Catalog<P>; schema: string; resources?: ResourceModel<S> | null }) {
    this.db = db; this.catalog = o.catalog; this.schema = schemaName(o.schema); this.resources = o.resources ?? null;
  }

  /** 403 für ein fehlendes Recht: «Dir fehlt das Recht «Objekte ändern» (object:write).», optional mit Zusatz vor dem Punkt. */
  missingPermission(perm: P, suffix = '') {
    return forbidden(`Dir fehlt das Recht ${this.catalog.permissionText(perm)}${suffix}.`);
  }

  /** Lädt Zugriffsregeln, eigene Rollen und Zustand der Kette (zwischengespeichert bis zur nächsten Änderung). */
  async load(tenantId: string): Promise<TenantAccess<S>> {
    const r = this.resources;
    return withTenant(this.db, { tenantId, settings: r?.fullContext }, async tx => {
      const acl = (await tx.query<{ v: string }>(`SELECT acl_version::text AS v FROM ${this.schema}.tenant WHERE id = $1`, [tenantId])).rows[0]?.v ?? '0';
      const v = `${acl}:${(await r?.version?.(tx)) ?? ''}`;
      const hit = this.cache.get(tenantId);
      if (hit && hit.version === v) return hit;
      const entries = (await tx.query<AclRow>(`SELECT resource_type, resource_id, principal_type, principal_ref, permission, effect FROM ${this.schema}.acl_entry`)).rows;
      const roles = (await tx.query<{ key: string; permissions: string[] }>(`SELECT key, permissions FROM ${this.schema}.tenant_role WHERE deleted_at IS NULL`)).rows;
      const state = (r?.load ? await r.load(tx) : null) as S;
      const loaded: TenantAccess<S> = { version: v, entries, byKey: indexAcl(entries), roles: new Map(roles.map(x => [x.key, x.permissions])), state };
      this.cache.set(tenantId, loaded);
      return loaded;
    });
  }

  invalidate(tenantId: string) { this.cache.delete(tenantId); }

  /** Rechte aus Rollen (vordefinierte und eigene), bei Clients und Zugriffen über den MCP-Dienst geschnitten mit den Scopes. */
  basePermissions(p: Principal, acl: Pick<TenantAccess, 'roles'>): Set<P> {
    const fromRoles = this.catalog.permissionsForRoles(p.roles, acl.roles);
    if (p.kind !== 'client' && !p.scopeBound) return fromRoles;
    const fromScopes = this.catalog.permissionsForScopes(p.scopes);
    return new Set([...fromRoles].filter(x => fromScopes.has(x)));
  }

  /** Personen mit org-admin sind von Verboten und Beschränkungen ausgenommen (Maschinen-Clients nicht). */
  isExempt(p: Principal): boolean {
    return p.kind === 'user' && p.roles.includes(ADMIN_ROLE);
  }

  /** Deckt ein Scope das Recht ab? Für Personen ausserhalb des MCP-Dienstes immer. */
  private scopeAllows(p: Principal, perm: P): boolean {
    return (p.kind !== 'client' && !p.scopeBound) || this.catalog.permissionsForScopes(p.scopes).has(perm);
  }

  private matches(p: Principal, e: AclRow): boolean {
    switch (e.principal_type) {
      case 'user': return e.principal_ref === p.principalId || e.principal_ref === p.subject;
      // Maschinen-Clients: der Client der Freigabe (bei Token-Austausch über MCP der ursprüngliche, nicht der MCP-Dienst)
      case 'client': return e.principal_ref === (p.grantId ?? p.clientId);
      case 'role': return p.roles.includes(e.principal_ref);
      case 'group': return p.groups.includes(e.principal_ref);
      default: return false;
    }
  }

  /** Kette der Ressource von oben nach unten (ResourceModel der App, sonst direkt unter dem Mandanten). */
  chain(acl: TenantAccess<S>, r: ResourceRef, hint?: string | null): ResourceRef[] {
    return this.resources ? this.resources.chain(acl.state, r, hint) : flatChain(r);
  }

  private at(acl: TenantAccess<S>, perm: P, step: ResourceRef): AclRow[] {
    return acl.byKey.get(aclKey(perm, step.type, step.id)) ?? [];
  }

  /** Verbote und Beschränkungen einer Stufe: lassen sie den Principal durch? */
  private passes(p: Principal, here: AclRow[]): boolean {
    if (here.some(e => e.effect === 'deny' && this.matches(p, e))) return false;
    const restricts = here.filter(e => e.effect === 'restrict');
    return !restricts.length || restricts.some(e => this.matches(p, e));
  }

  decide(p: Principal, acl: TenantAccess<S>, perm: P, r: ResourceRef = { type: 'tenant' }, hint?: string | null): boolean {
    const chain = this.chain(acl, r, hint);
    // Freigaben nie für Rechte, die nur org-admin hat (Spez. 7.1; auch wenn die Datenbank solche Einträge enthält)
    const granted = () => !this.catalog.adminOnly.has(perm) && this.scopeAllows(p, perm) && chain.some(step => this.at(acl, perm, step).some(e => e.effect === 'grant' && this.matches(p, e)));
    if (!this.basePermissions(p, acl).has(perm) && !granted()) return false;
    if (this.isExempt(p)) return true;
    return chain.every(step => this.passes(p, this.at(acl, perm, step)));
  }

  /**
   * Nur eine Stufe (Assets: das Objekt selbst; Typ und Schema prüft dort die Lesesicht der Datenbank): für Listen, die
   * Einträge auf einzelnen Ressourcen verbergen, ohne die Kette jeder Ressource zu laden.
   */
  stepAllows(p: Principal, acl: TenantAccess<S>, perm: P, ref: ResourceRef): boolean {
    return this.isExempt(p) || this.passes(p, this.at(acl, perm, ref));
  }

  /** Hat der Principal eine wirksame Freigabe für das Recht auf irgendeiner Ressource? */
  private grantedSomewhere(p: Principal, acl: TenantAccess<S>, perm: P): boolean {
    return acl.entries.some(e => e.effect === 'grant' && e.permission === perm && this.matches(p, e)
      && this.decide(p, acl, perm, { type: e.resource_type, id: e.resource_id }));
  }

  /**
   * Recht irgendwo: auf Mandantenebene oder über eine Freigabe auf einer Ressource. Für Listen und Einstiege, die danach
   * je Ressource prüfen oder filtern; nie für Aktionen ohne Ressource (anlegen).
   */
  somewhere(p: Principal, acl: TenantAccess<S>, perm: P): boolean {
    return this.decide(p, acl, perm) || this.grantedSomewhere(p, acl, perm);
  }

  async can(p: Principal, perm: P, r?: ResourceRef, hint?: string | null): Promise<boolean> {
    return this.decide(p, await this.load(p.tenantId), perm, r, hint);
  }

  async require(p: Principal, perm: P, r?: ResourceRef, hint?: string | null): Promise<void> {
    if (!(await this.can(p, perm, r, hint))) throw this.missingPermission(perm, r && r.type !== 'tenant' ? ` für ${r.type}${r.id ? ` ${r.id}` : ''}` : '');
  }

  async canSomewhere(p: Principal, perm: P): Promise<boolean> {
    return this.somewhere(p, await this.load(p.tenantId), perm);
  }

  /** Wie require ohne Ressource, aber auch mit einer Freigabe auf einer Ressource erfüllt (siehe somewhere). */
  async requireSomewhere(p: Principal, perm: P): Promise<void> {
    if (!(await this.canSomewhere(p, perm))) throw this.missingPermission(perm);
  }

  /**
   * Kurzer Fingerabdruck des Zugriffsstands für ETags von Antworten mit `can` (Entwurf 13.7): ändert sich eine
   * Zugriffsregel, eine eigene Rolle, der Zustand der Kette oder das Token, gilt eine zwischengespeicherte Antwort nicht mehr.
   */
  async accessTag(p: Principal): Promise<string> {
    const acl = await this.load(p.tenantId);
    // Mit Identität: Einträge für Personen und Clients machen `can` je Principal verschieden
    const parts = [acl.version, p.kind, p.principalId, p.subject, p.clientId ?? '', p.grantId ?? '', p.scopeBound ? 's' : '', [...p.roles].sort().join(','), [...p.groups].sort().join(','), [...p.scopes].sort().join(',')];
    return createHash('sha256').update(parts.join('|')).digest('base64url').slice(0, 10);
  }

  /** Rechte auf Mandantenebene (aus Rollen oder einer Freigabe auf dem Mandanten), in Katalogreihenfolge. */
  async effective(p: Principal): Promise<P[]> {
    const acl = await this.load(p.tenantId);
    return this.catalog.permissions.filter(x => this.decide(p, acl, x));
  }

  /** Rechte nur über Freigaben auf einzelnen Ressourcen (nicht auf Mandantenebene), in Katalogreihenfolge. */
  async granted(p: Principal): Promise<P[]> {
    const acl = await this.load(p.tenantId);
    return this.catalog.permissions.filter(x => !this.decide(p, acl, x) && this.grantedSomewhere(p, acl, x));
  }
}

/** Fähigkeiten eines Principals auf einer Ressource nach dem Katalog (`capabilities` je Ressourcentyp), Entscheid E3. */
export function capabilities<P extends string, S>(access: AccessService<P, S>, p: Principal, acl: TenantAccess<S>, kind: string, id: string, hint?: string | null): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [cap, perm] of Object.entries(access.catalog.capabilities[kind] ?? {})) out[cap] = access.decide(p, acl, perm as P, { type: kind, id }, hint);
  return out;
}

/** Lädt die Zugriffsregeln einmal und liefert eine Funktion für viele Ressourcen (Listen). */
export async function capabilitiesFor<P extends string, S>(access: AccessService<P, S>, p: Principal) {
  const acl = await access.load(p.tenantId);
  return (kind: string, id: string, hint?: string | null) => capabilities(access, p, acl, kind, id, hint);
}

/** JSON-Schema des Felds `can` für einen Ressourcentyp (für OpenAPI). */
export function canSchema(catalog: Catalog, kind: string) {
  const caps = Object.entries(catalog.capabilities[kind] ?? {});
  return {
    type: 'object', description: 'Fähigkeiten des Aufrufers auf dieser Ressource (Rolle, Scopes und ACL)', additionalProperties: false,
    properties: Object.fromEntries(caps.map(([cap, perm]) => [cap, { type: 'boolean', description: `Recht «${perm}» auf dieser Ressource` }])),
    required: caps.map(([cap]) => cap),
  };
}
