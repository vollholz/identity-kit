/**
 * Verwaltung von Organisationen, Mitgliedern und Rollen über die Keycloak-Admin-API – mit der Mandantengrenze
 * (Spezifikation Kap. 9.1; aus Assets `modules/admin/service.ts`, ohne Fastify).
 *
 * Der Service Account in Keycloak darf mehr als eine einzelne Organisation (Keycloak 26 kennt keine Rechte je
 * Organisation). Die Grenze setzt deshalb diese Datei durch:
 * - Ein org-admin arbeitet immer in der Organisation seines Tokens (`Scope.alias` kommt aus dem Principal, nie aus der
 *   Anfrage). Jede Person wird vor jeder Änderung als Mitglied genau dieser Organisation geprüft; fremde IDs → 404.
 * - Rollen sind ausschliesslich die Gruppen `<GROUP_ROLE_PREFIX>/<alias>/<rolle>` des Rollenkatalogs und der eigenen
 *   Rollen der Organisation (`tenant_role`). Andere Gruppen, Realm-Rollen und Client-Rollen werden nie verändert.
 * - Die Rolle org-admin vergeben und entziehen, Organisationen anlegen, ändern und sperren: nur platform-admin.
 * - Die letzte aktive Person mit org-admin lässt sich weder entfernen noch herabstufen (409). Aktiv heisst wie in der
 *   Mitgliederliste: Mitglied, Konto nicht gesperrt, Einladung angenommen (Abweichung von Assets, Entwurf 13.13).
 * - Ein org-admin erfährt nichts über andere Organisationen: Einladen, erneut Senden und Zurückziehen antworten gleich,
 *   ob für die Adresse schon ein Konto besteht oder nicht (gleicher Status, gleiche Felder, Mindestdauer
 *   KEYCLOAK_MGMT_INVITE_MIN_TIME); eingeladene Personen erscheinen in beiden Fällen gleich (offene Einladung aus
 *   `member_invitation`, nicht aus dem Konto) und tragen nach aussen die ID ihrer Einladung, nie die ID des Kontos; ob
 *   ein Konto beim Entfernen gelöscht wurde, sieht nur die Plattform. Gelöscht wird nur ein Konto, das die Einladung
 *   selbst angelegt hat (`created_account`).
 * - Änderungen derselben Organisation laufen nacheinander (Advisory-Lock `admin:<alias>`), damit der Schutz des letzten
 *   Admins auch bei gleichzeitigen Anfragen hält. Jede Änderung wird im Audit-Protokoll des betroffenen Mandanten
 *   festgehalten; scheitert eine Änderung, nachdem Keycloak schon geändert wurde, folgt ein eigener Eintrag `…_failed`
 *   mit den erfolgten Schritten.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Actor, AuditEntry, AuditPort, Source } from './audit.ts';
import { ADMIN_ROLE, type Catalog } from './catalog.ts';
import type { IamConfig } from './config.ts';
import { schemaName, withTenant, type Db, type Tx } from './db.ts';
import { conflict, forbidden, HttpError, invalid, notFound } from './errors.ts';
import { KeycloakAdmin, KeycloakError, type KcGroup, type KcOrg, type KcUser } from './keycloak.ts';
import { lockKey } from './locks.ts';
import { ALIAS_PATTERN, asciiLower, rolesFromClaims, tenantGroups, type Principal, type PrincipalResolver } from './principal.ts';
import { displayName, orgMatches, pendingActions, syncTenantMembers, syncTenantName, type RoleCleanup, type SyncContext } from './sync.ts';
import { createTenant, findTenant, listTenants, setTenantStatus, type TenantActor, type TenantRow, type TenantsContext } from './tenants.ts';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Eigene Rolle der Organisation (`tenant_role`). */
export interface CustomRole { key: string; label: string; description: string; permissions: string[] }

/** Rolle mit Erklärung für die Oberfläche (`GET /v1/admin/status`). */
export interface RoleInfo { key: string; label: string; description: string; permissions: string[]; adminOnly: boolean; custom: boolean }

/**
 * Rollen mit Erklärung: vordefinierte wie `GET /v1/authz/catalog`, danach die eigenen der Organisation (Rechte in
 * Katalogreihenfolge, ohne Rechte nur für org-admin).
 */
export function roleCatalog(catalog: Catalog, custom: CustomRole[] = []): RoleInfo[] {
  return [
    ...catalog.toJSON().roles.map(r => ({ ...r, custom: false })),
    ...custom.map(r => ({ key: r.key, label: r.label, description: r.description, permissions: [...catalog.permissionsForRoles([r.key], new Map([[r.key, r.permissions]]))], adminOnly: false, custom: true })),
  ];
}

/** Was der Service vom IAM braucht (`createIam` übergibt sich selbst). */
export interface AdminDeps {
  readonly cfg: IamConfig;
  readonly catalog: Catalog<any>;
  readonly db: Db;
  readonly schema: string;
  readonly audit: AuditPort;
  readonly resolver: Pick<PrincipalResolver, 'forgetPrincipal' | 'forgetTenant'>;
}

/** Wer handelt und in welcher Organisation. */
export interface Scope {
  alias: string;
  actor: Principal;
  /** true: Plattform-Administration (darf org-admin vergeben, beliebige Organisation). */
  platform: boolean;
  source: Source;
  correlationId: string;
}

export type MemberStatus = 'active' | 'invited' | 'disabled';
export interface Member {
  id: string; principalId: string | null; username: string; name: string; email: string | null;
  status: MemberStatus; roles: string[]; lastSeenAt: Date | null; createdAt: Date | null;
  /** Offene Einladung aus Entra ID: Pfad der Anmeldung über Microsoft (zum Weitergeben), sonst null. */
  loginPath: string | null;
}

export interface Organization {
  id: string; alias: string; name: string; description: string | null; enabled: boolean; domains: string[];
  tenant: { id: string; status: string; createdAt: Date } | null;
}

/**
 * Anmeldung über den Entra-Anbieter der Organisation (Modul `bff`, `/auth/entra/{alias}`): Ziel der Einladung aus
 * Entra ID und Link zum Weitergeben. `org`: Organisation der Sitzung nach der Anmeldung.
 */
export const entraLoginPath = (idpAlias: string, org: string) => `/auth/entra/${idpAlias}?org=${encodeURIComponent(org)}`;

/**
 * Offene Einladung in diesem Mandanten (`member_invitation`). `id`: nach aussen die ID der eingeladenen Person (neu je
 * Einladung); `user_id`: Konto in Keycloak (nur intern); `created_account`: diese Einladung hat das Konto angelegt.
 */
interface Invitation { id: string; user_id: string; email: string; display_name: string; created_at: Date; created_account: boolean; entra: boolean }
const INVITATION_COLS = 'id, user_id, email, display_name, created_at, created_account, entra';

/** Ziel von …/members/{id}: offene Einladung (Einladungs-ID) oder Mitglied (Keycloak-ID). `id`: ID nach aussen. */
interface Target { id: string; userId: string; user: KcUser | null; member: boolean; invitation: Invitation | null }

/** In Keycloak erfolgte Änderung, für das Protokoll, falls danach etwas scheitert. Nur Angaben dieser Organisation. */
export interface Step {
  step: 'account_created' | 'membership_added' | 'membership_removed' | 'account_deleted' | 'role_added' | 'role_removed' | 'organization_updated'
    | 'idp_created' | 'idp_linked' | 'idp_deleted' | 'account_linked' | 'password_removed';
  role?: string;
}

/** Arbeit in locked(): Transaktion, Audit und erfolgte Schritte in Keycloak. */
export interface Work {
  tx: Tx;
  tenantId: string;
  log: (e: AuditEntry) => Promise<void>;
  /** Änderung in Keycloak erfolgt. `platformOnly`: verriete einem org-admin etwas über das Konto (neu/gelöscht). */
  done: (st: Step, platformOnly?: boolean) => void;
  /** Rückgängig gemacht: nicht mehr protokollieren. */
  undone: (st: Step) => void;
}

/** Protokolleintrag, wenn die Arbeit scheitert, nachdem Keycloak schon geändert wurde (eigene Transaktion). */
export type Failure = { action: string; resourceType: 'member'; resourceId: string | null } | { action: string; resourceType: 'tenant' };

export class AdminService {
  private readonly deps: AdminDeps;
  readonly kc: KeycloakAdmin;
  private readonly prefix: string;
  /** Schema der Tabellen (geprüft). */
  private readonly S: string;
  private orgs: { at: number; byAlias: Map<string, KcOrg> } | null = null;
  private readonly groups = new Map<string, { at: number; byRole: Map<string, KcGroup> }>();
  private readonly custom = new Map<string, { at: number; keys: string[] }>();

  constructor(deps: AdminDeps, kc: KeycloakAdmin) {
    this.deps = deps; this.kc = kc;
    this.S = schemaName(deps.schema);
    this.prefix = `/${deps.cfg.tenancy.groupRolePrefix.replace(/^\/|\/$/g, '')}`;
  }

  private get tenants(): TenantsContext { return { schema: this.deps.schema, audit: this.deps.audit, resolver: this.deps.resolver }; }
  private get sync(): SyncContext { return { schema: this.deps.schema, audit: this.deps.audit }; }

  /** Rollen über Gruppen wirken nur, wenn ROLE_SOURCE sie auswertet. */
  get rolesManageable() { return this.deps.cfg.tenancy.roleSource !== 'client'; }

  /** Label einer Rolle für Meldungen: «Organisations-Admin» statt org-admin. */
  private roleLabel(r: string) { return `«${this.deps.catalog.roles.get(r)?.label ?? r}»`; }

  // ---------------------------------------------------------------- Organisation und Rollengruppen
  async org(alias: string, fresh = false): Promise<KcOrg> {
    if (fresh || !this.orgs || Date.now() - this.orgs.at > 60_000) {
      const list = await this.kc.listOrgs();
      this.orgs = { at: Date.now(), byAlias: new Map(list.map(o => [asciiLower(o.alias), o])) };
    }
    const o = this.orgs.byAlias.get(asciiLower(alias));
    if (!o) {
      if (!fresh) return this.org(alias, true);
      throw notFound(`Organisation «${alias}»`);
    }
    return o;
  }

  private rolePath(alias: string, role?: string) { return `${this.prefix}/${alias}${role ? `/${role}` : ''}`; }

  /** Eigene Rollen der Organisation (`tenant_role`), 60 s zwischengespeichert; nach Änderungen forgetRoles(). */
  private async customRoleKeys(alias: string): Promise<string[]> {
    const hit = this.custom.get(alias);
    if (hit && Date.now() - hit.at < 60_000) return hit.keys;
    const t = await findTenant(this.deps.db, alias);
    const keys = t ? await withTenant(this.deps.db, { tenantId: t.id }, async tx => (await tx.query<{ key: string }>(`SELECT key FROM ${this.S}.tenant_role WHERE deleted_at IS NULL ORDER BY key`)).rows.map(r => r.key)) : [];
    this.custom.set(alias, { at: Date.now(), keys });
    return keys;
  }

  /** Vordefinierte und eigene Rollen der Organisation. */
  async roleKeys(alias: string): Promise<string[]> {
    return [...this.deps.catalog.roles.keys(), ...await this.customRoleKeys(alias)];
  }

  /** Nach Anlegen oder Löschen einer eigenen Rolle (andere Instanzen nach spätestens 60 s). */
  forgetRoles(alias: string) { this.custom.delete(alias); this.groups.delete(alias); }

  /**
   * Gruppe einer gelöschten eigenen Rolle entfernen: alle Personen verlieren die Rolle. Vordefinierte Rollen nie.
   * @returns Anzahl Personen, die die Rolle hatten
   */
  async deleteRoleGroup(alias: string, key: string): Promise<number> {
    if (this.deps.catalog.roles.has(key)) throw new Error(`Vordefinierte Rolle ${key} lässt sich nicht löschen`);
    const g = await this.kc.groupByPath(this.rolePath(alias, key));
    const n = g ? (await this.kc.groupMembers(g.id)).length : 0;
    if (g) await this.kc.deleteGroup(g.id);
    this.forgetRoles(alias);
    return n;
  }

  /** Anzahl Personen je Rolle (Gruppenmitglieder, auch eingeladene). Rollen ohne Gruppe fehlen. */
  async roleMemberCounts(alias: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const [role, g] of await this.roleGroups(alias)) out.set(role, (await this.kc.groupMembers(g.id)).length);
    return out;
  }

  /** Gruppen `<prefix>/<alias>/<rolle>`; fehlende werden angelegt (z. B. für in der Konsole angelegte Organisationen). */
  async roleGroups(alias: string, create = false): Promise<Map<string, KcGroup>> {
    const keys = await this.roleKeys(alias);
    const hit = this.groups.get(alias);
    if (hit && Date.now() - hit.at < 300_000 && (!create || hit.byRole.size === keys.length)) return hit.byRole;
    const byRole = new Map<string, KcGroup>();
    let parent = await this.kc.groupByPath(this.rolePath(alias));
    if (!parent && create) {
      let root = await this.kc.groupByPath(this.prefix);
      if (!root) root = { id: await this.kc.createGroup(null, this.prefix.slice(1)), name: this.prefix.slice(1), path: this.prefix };
      parent = { id: await this.kc.createGroup(root.id, alias), name: alias, path: this.rolePath(alias) };
    }
    if (parent) {
      for (const role of keys) {
        let g = await this.kc.groupByPath(this.rolePath(alias, role));
        if (!g && create) g = { id: await this.kc.createGroup(parent.id, role), name: role, path: this.rolePath(alias, role) };
        if (g) byRole.set(role, g);
      }
    }
    this.groups.set(alias, { at: Date.now(), byRole });
    return byRole;
  }

  /** Rollen einer Person in dieser Organisation (nur Gruppen vordefinierter und eigener Rollen). */
  private async rolesOf(alias: string, userId: string): Promise<string[]> {
    const base = `${this.rolePath(alias)}/`, known = new Set(await this.roleKeys(alias));
    return (await this.kc.userGroups(userId)).map(g => g.path).filter(p => p.startsWith(base)).map(p => p.slice(base.length)).filter(r => known.has(r));
  }

  /**
   * Aktive Mitglieder mit Rolle org-admin (Spezifikation 9.1 Nr. 6): Mitglied, Konto nicht gesperrt und – wie
   * `status: 'active'` in der Mitgliederliste – weder offen eingeladen noch mit offenem «Passwort setzen» ohne Zugriff.
   * Assets zählt auch nie angenommene Einladungen mit angelegtem Konto (dort Mitglied ab der Einladung).
   */
  private async activeAdmins(tx: Tx, org: KcOrg, groups: Map<string, KcGroup>): Promise<string[]> {
    const g = groups.get(ADMIN_ROLE);
    if (!g) return [];
    const candidates: KcUser[] = [];
    for (const u of await this.kc.groupMembers(g.id)) {
      const m = await this.kc.member(org.id, u.id);
      if (m && m.enabled !== false) candidates.push(m);
    }
    if (!candidates.length) return [];
    const ids = candidates.map(u => u.id);
    const open = new Set((await tx.query<{ user_id: string }>(`SELECT user_id FROM ${this.S}.member_invitation WHERE accepted_at IS NULL AND user_id = ANY($1::text[])`, [ids])).rows.map(r => r.user_id));
    const seen = new Set((await tx.query<{ subject: string }>(`SELECT subject FROM ${this.S}.principal WHERE kind = 'user' AND last_seen_at IS NOT NULL AND subject = ANY($1::text[])`, [ids])).rows.map(r => r.subject));
    return candidates.filter(u => !open.has(u.id) && !(pendingActions(u) && !seen.has(u.id))).map(u => u.id);
  }

  // ---------------------------------------------------------------- Mandant, Transaktion, Audit
  /** Mandant der Organisation; wird bei Bedarf angelegt (Organisation in Keycloak, aber noch nie benutzt). */
  async tenantFor(s: Scope, org: KcOrg): Promise<string> {
    const t = await findTenant(this.deps.db, org.alias) ?? (s.platform ? await createTenant(this.tenants, this.deps.db, this.deps.db, org.alias, org.name, org.id, this.actorOf(s)) : null);
    // Alias in Keycloak neu vergeben (gelöschte Organisation, neue mit gleichem Alias)? Dann nicht die Mitglieder der
    // neuen Organisation in den alten Mandanten übernehmen. Fehlt die gespeicherte ID, wird sie jetzt gebunden.
    if (t && !(await orgMatches(this.deps.db, t, org))) throw conflict(`Die Organisation «${org.alias}» in Keycloak passt nicht zur Organisation der Plattform (andere ID). Zuordnung durch die Plattform-Administration prüfen.`);
    if (!s.platform) return s.actor.tenantId;
    return t!.id;
  }

  actorOf(s: Scope): TenantActor {
    const p = s.actor;
    return {
      principal: { kind: p.kind, principalId: p.principalId, name: p.name, clientId: p.clientId }, source: s.source, correlationId: s.correlationId,
      data: s.platform ? { platformAdmin: true, actorTenant: p.tenantAlias } : {},
    };
  }

  private write(tx: Tx, a: TenantActor, e: AuditEntry) {
    const actor: Actor = { principal: a.principal, source: a.source, correlationId: a.correlationId };
    return this.deps.audit.write(tx, actor, { ...e, data: { ...e.data, ...a.data } });
  }

  /**
   * Arbeit an einer Organisation: nacheinander je Organisation, Audit in derselben Transaktion. Scheitert die Arbeit,
   * nachdem Keycloak schon geändert wurde (`done`), wird die Transaktion zurückgerollt, Keycloak aber bleibt geändert:
   * dann in eigener Transaktion `failure.action` mit den erfolgten Schritten, danach den Fehler weiterreichen.
   */
  async locked<T>(s: Scope, org: KcOrg, failure: Failure | null, fn: (w: Work) => Promise<T>): Promise<T> {
    const tenantId = await this.tenantFor(s, org);
    const ctx = { tenantId, principalId: s.platform ? null : s.actor.principalId };
    const a = this.actorOf(s);
    const steps: Step[] = [];
    try {
      return await withTenant(this.deps.db, ctx, async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey.admin(org.alias)]);
        return fn({
          tx, tenantId,
          log: e => this.write(tx, a, e),
          done: (st, platformOnly = false) => { if (s.platform || !platformOnly) steps.push(st); },
          undone: st => { const i = steps.findIndex(x => x.step === st.step && x.role === st.role); if (i >= 0) steps.splice(i, 1); },
        });
      });
    } catch (e) {
      if (failure && steps.length) {
        await withTenant(this.deps.db, ctx, tx => this.write(tx, a, {
          action: failure.action, resourceType: failure.resourceType, resourceId: failure.resourceType === 'tenant' ? tenantId : failure.resourceId,
          data: { steps, status: e instanceof HttpError ? e.status : 500 },
        })).catch(() => undefined); // Protokoll nicht erreichbar: der ursprüngliche Fehler zählt
      }
      throw e;
    }
  }

  private async checkRoles(s: Scope, roles: string[]) {
    // Set statt Objekt: `constructor`, `__proto__` u. a. sind keine Rollen
    const known = new Set(await this.roleKeys(s.alias));
    const unknown = roles.filter(r => !known.has(r));
    if (unknown.length) throw invalid(`Unbekannte Rolle: ${unknown.join(', ')}`, unknown.map(r => ({ path: '/roles', message: `«${r}» ist keine Rolle dieser Organisation` })));
    if (roles.length && !this.rolesManageable) throw conflict('Rollen kommen aus Client-Rollen von Keycloak (ROLE_SOURCE=client) und lassen sich hier nicht verwalten.');
  }

  private requireAdminChange(s: Scope) {
    if (!s.platform) throw forbidden(`Die Rolle ${this.roleLabel(ADMIN_ROLE)} vergibt und entzieht nur die Plattform-Administration.`);
  }

  // ---------------------------------------------------------------- Mitglieder
  /** Offene Einladungen und Anbieter der Entra-Verbindung (für den Link der Einladungen aus Entra ID). */
  private async openInvitations(tenantId: string): Promise<{ list: Invitation[]; idpAlias: string | null }> {
    return withTenant(this.deps.db, { tenantId }, async tx => ({
      list: (await tx.query<Invitation>(`SELECT ${INVITATION_COLS} FROM ${this.S}.member_invitation WHERE accepted_at IS NULL ORDER BY created_at`)).rows,
      idpAlias: (await tx.query<{ idp_alias: string }>(`SELECT idp_alias FROM ${this.S}.entra_connection`)).rows[0]?.idp_alias ?? null,
    }));
  }

  /**
   * Eingeladene Person: Angaben aus der Einladung dieses Mandanten, nicht aus dem Konto (gleich für neue und bestehende
   * Konten); ID der Einladung statt der Keycloak-ID (gleiche Keycloak-ID bei erneuter Einladung verriete ein Konto).
   */
  private static invited(i: Invitation, roles: string[], org: string, idpAlias: string | null): Member {
    return {
      id: i.id, principalId: null, username: i.email, name: i.display_name, email: i.email, status: 'invited', roles, lastSeenAt: null, createdAt: i.created_at,
      loginPath: i.entra && idpAlias ? entraLoginPath(idpAlias, org) : null,
    };
  }

  async listMembers(s: Scope): Promise<Member[]> {
    const org = await this.org(s.alias);
    const users = await this.kc.members(org.id);
    const groups = await this.roleGroups(org.alias);
    const roleSets = new Map<string, Set<string>>();
    for (const [role, g] of groups) roleSets.set(role, new Set((await this.kc.groupMembers(g.id)).map(u => u.id)));
    const rolesOf = (id: string) => [...roleSets].filter(([, ids]) => ids.has(id)).map(([r]) => r);
    const tenantId = await this.tenantFor(s, org);
    // Personenverzeichnis abgleichen: Mitglieder, die sich noch nie angemeldet haben, auswählbar; Ehemalige markiert;
    // angenommene Einladungen abgeschlossen; Rollengruppen von Nicht-Mitgliedern ohne Einladung entfernt (passt roleSets an)
    await syncTenantMembers(this.sync, this.deps.db, tenantId, org.alias, users, s.correlationId, { kc: this.kc, orgId: org.id, groups, members: roleSets });
    const inv = await this.openInvitations(tenantId);
    const open = new Map(inv.list.map(i => [i.user_id, i]));
    const seen = await withTenant(this.deps.db, { tenantId }, async tx => new Map((await tx.query<{ id: string; subject: string; last_seen_at: Date | null; invited_at: Date | null }>(
      `SELECT p.id, p.subject, p.last_seen_at, (SELECT max(i.created_at) FROM ${this.S}.member_invitation i WHERE i.user_id = p.subject) AS invited_at
       FROM ${this.S}.principal p WHERE p.kind = 'user' AND p.subject = ANY($1::text[])`, [users.map(u => u.id)])).rows.map(r => [r.subject, r])));
    const out: Member[] = users.filter(u => !open.has(u.id)).map(u => {
      const p = seen.get(u.id);
      const status: MemberStatus = u.enabled === false ? 'disabled' : pendingActions(u) && !p?.last_seen_at ? 'invited' : 'active';
      // createdAt: Einladung in DIESE Organisation; das Alter des Kontos in Keycloak verriete ein früheres Konto
      return { id: u.id, principalId: p?.id ?? null, username: u.username, name: displayName(u), email: u.email ?? null, status, roles: rolesOf(u.id), lastSeenAt: p?.last_seen_at ?? null, createdAt: p?.invited_at ?? null, loginPath: null };
    });
    for (const i of open.values()) out.push(AdminService.invited(i, rolesOf(i.user_id), org.alias, inv.idpAlias));
    return out.sort((a, b) => a.name.localeCompare(b.name, 'de-CH'));
  }

  /**
   * Rollen und Gruppen einer Person in der Organisation, wie sie im Token stünden (Gruppen `<prefix>/<alias>/<rolle>`
   * und Gruppen ohne fremde Organisation). Für `GET /v1/acl/effective` mit echten statt simulierten Rollen
   * (`iam.memberAccess`); nur mit ROLE_SOURCE=groups, sonst fehlten die Client-Rollen. `null`: kein Mitglied.
   */
  async accessOf(alias: string, subject: string): Promise<{ roles: string[]; groups: string[] } | null> {
    const t = this.deps.cfg.tenancy;
    const org = await this.org(alias);
    if (!(await this.kc.member(org.id, subject))) return null;
    const claims = { [t.groupsClaim]: (await this.kc.userGroups(subject)).map(g => g.path) };
    const known = new Set(await this.roleKeys(org.alias));
    return { roles: rolesFromClaims(claims, asciiLower(org.alias), t).filter(r => known.has(r)), groups: tenantGroups(claims, asciiLower(org.alias), t) };
  }

  /** Mitglied bzw. eingeladene Person nach der ID von aussen (Mitglieds- oder Einladungs-ID). */
  async member(s: Scope, id: string): Promise<Member> {
    const m = (await this.listMembers(s)).find(x => x.id === id);
    if (!m) throw notFound('Mitglied');
    return m;
  }

  /**
   * Mindestdauer: Antwortzeit verrät nicht, welcher Weg genommen wurde (neues oder bestehendes Konto). Auch bei Fehlern.
   * `when`: nach der Arbeit geprüft, z. B. nur für Einladungen (Mitglieder entfernen braucht keine Mindestdauer).
   */
  private async padded<T>(fn: () => Promise<T>, when: () => boolean = () => true): Promise<T> {
    const until = Date.now() + this.deps.cfg.mgmt.inviteMinMs;
    try { return await fn(); }
    finally { const rest = until - Date.now(); if (rest > 0 && when()) await sleep(rest); }
  }

  /**
   * Einladung an ein bestehendes Konto senden. Lehnt Keycloak das Konto ab (gesperrt, ohne E-Mail), ohne einen Versand
   * zu versuchen, gilt dasselbe wie für ein neues Konto: versendet, wenn der Realm E-Mails versenden kann – sonst
   * verriete `emailSent` den Zustand eines fremden Kontos.
   */
  private async inviteExisting(orgId: string, userId: string): Promise<boolean> {
    const r = await this.kc.inviteExistingUser(orgId, userId);
    return r === 'sent' || (r === 'refused' && await this.kc.mailConfigured());
  }

  /**
   * Einladen. Besteht für die Adresse kein Konto: Konto ohne Passwort anlegen, als Mitglied eintragen, E-Mail «Passwort
   * setzen». Besteht eines (auch einer anderen Organisation): Keycloak sendet eine Einladung, Mitglied nach Annahme.
   * In beiden Fällen gleiche Antwort (202, «invitation-sent», eingeladene Person aus der Einladung), Rollen sofort
   * gesetzt (wirken erst mit der Mitgliedschaft), Personenverzeichnis erst nach Annahme. Die App setzt nie ein Passwort.
   */
  async invite(s: Scope, input: { email: string; firstName?: string; lastName?: string; roles: string[] }): Promise<{ result: 'invitation-sent'; emailSent: boolean; member: Member }> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw invalid('E-Mail-Adresse ungültig', [{ path: '/email', message: 'Gültige E-Mail-Adresse angeben' }]);
    const roles = [...new Set(input.roles)];
    await this.checkRoles(s, roles);
    if (roles.includes(ADMIN_ROLE)) this.requireAdminChange(s);
    const org = await this.org(s.alias);
    if (!org.enabled) throw conflict('Die Organisation ist gesperrt.');
    const name = [input.firstName, input.lastName].map(x => x?.trim()).filter(Boolean).join(' ') || email;
    return this.padded(() => this.locked(s, org, { action: 'member.invite_failed', resourceType: 'member', resourceId: null }, async w => {
      const { tx, log } = w;
      if ((await tx.query(`SELECT 1 FROM ${this.S}.member_invitation WHERE accepted_at IS NULL AND lower(email) = $1`, [email])).rowCount) throw conflict('Diese Adresse ist bereits eingeladen. Einladung in der Liste erneut senden.');
      // «Nur Entra» für die Domäne aktiv: kein Konto mit Passwort; Personen kommen über Entra ID dazu (Modul entra)
      if ((await tx.query(`SELECT 1 FROM ${this.S}.entra_connection WHERE stage = 'enforced' AND $1 = ANY (domains)`, [email.split('@')[1]])).rowCount) {
        throw conflict(`Personen mit Adressen @${email.split('@')[1]} melden sich über Microsoft Entra ID an und lassen sich nicht mit Passwort einladen. Über «Person hinzufügen» in Entra ID suchen.`, { reason: 'entra-domain' });
      }
      const existing = await this.kc.findUserByEmail(email);
      if (existing && await this.kc.member(org.id, existing.id)) throw conflict('Diese Person ist bereits Mitglied der Organisation.');
      const groups = roles.length ? await this.roleGroups(org.alias, true) : new Map<string, KcGroup>();
      // createdAccount: das Konto entsteht mit dieser Einladung – nur dann darf ein Fehler oder das Zurückziehen es löschen
      let userId = existing?.id ?? null, createdAccount = false;
      const joined: string[] = [];
      try {
        if (!userId) {
          userId = await this.createAccount(email, input);
          createdAccount = true;
          w.done({ step: 'account_created' }, true);
          await this.kc.addMember(org.id, userId);
          w.done({ step: 'membership_added' }, true);
        }
        for (const r of roles) { await this.kc.joinGroup(userId, groups.get(r)!.id); joined.push(r); w.done({ step: 'role_added', role: r }); }
        const emailSent = createdAccount
          ? await this.kc.sendActionsEmail(userId, ['UPDATE_PASSWORD', 'VERIFY_EMAIL'], { lifespanSec: this.deps.cfg.mgmt.inviteLifespanSec, clientId: this.deps.cfg.oidc.bffClientId })
          : await this.inviteExisting(org.id, userId);
        // Erneute Einladung (frühere angenommen): neue ID, damit sie sich nicht mit der früheren verknüpfen lässt
        const inv = (await tx.query<Invitation>(
          `INSERT INTO ${this.S}.member_invitation (tenant_id, user_id, email, display_name, created_by_name, created_account) VALUES (app.tenant_id(), $1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET id = gen_random_uuid(), email = excluded.email, display_name = excluded.display_name, created_at = now(),
             created_by_name = excluded.created_by_name, created_account = excluded.created_account, accepted_at = NULL
           RETURNING ${INVITATION_COLS}`, [userId, email, name, s.actor.name, createdAccount])).rows[0]!;
        // Ohne Angabe, ob das Konto neu ist: das Protokoll lesen auch Personen dieser Organisation
        await log({ action: 'member.invited', resourceType: 'member', resourceId: inv.id, data: { email, roles, emailSent } });
        return { result: 'invitation-sent' as const, emailSent, member: AdminService.invited(inv, roles, org.alias, null) };
      } catch (e) {
        // nichts Halbes zurücklassen (Transaktion wird ebenfalls zurückgerollt); was sich nicht rückgängig machen lässt,
        // protokolliert locked(). Gelöscht wird nur das mit dieser Einladung angelegte Konto (samt Mitgliedschaft und Gruppen).
        if (createdAccount && userId) {
          if (await this.kc.deleteUser(userId).then(() => true, () => false)) {
            w.undone({ step: 'account_created' }); w.undone({ step: 'membership_added' });
            for (const r of joined) w.undone({ step: 'role_added', role: r });
          }
        } else if (userId) {
          for (const r of joined) if (await this.kc.leaveGroup(userId, groups.get(r)!.id).then(() => true, () => false)) w.undone({ step: 'role_added', role: r });
        }
        throw e;
      }
    }));
  }

  /**
   * Konto ohne Passwort. Benutzername = Adresse; ist er schon vergeben (Konto mit anderer Adresse), ein eindeutiger
   * Benutzername – ein Konflikt von Keycloak verriete sonst das fremde Konto.
   */
  async createAccount(email: string, input: { firstName?: string; lastName?: string }, requiredActions = ['UPDATE_PASSWORD']): Promise<string> {
    const rep = { email, firstName: input.firstName?.trim() || undefined, lastName: input.lastName?.trim() || undefined, enabled: true, emailVerified: false, requiredActions };
    try { return await this.kc.createUser({ ...rep, username: email }); }
    catch (e) {
      if (!(e instanceof KeycloakError) || e.kcStatus !== 409) throw e;
      return this.kc.createUser({ ...rep, username: `${email.split('@')[0]}.${randomUUID().slice(0, 8)}@${email.split('@')[1]}` });
    }
  }

  /**
   * E-Mail der Einladung aus Entra ID (Keycloak, `execute-actions-email`): einzige Aktion «E-Mail bestätigen», danach
   * leitet Keycloak zur Anmeldung über Microsoft weiter (`entraLoginPath`). Kein Passwort. Gesperrtes bestehendes Konto
   * (Keycloak lehnt es vor dem Versand ab): Antwort wie für ein neues Konto, sonst verriete `emailSent` den Zustand eines
   * fremden Kontos (wie inviteExisting).
   */
  async sendEntraInvitation(user: KcUser, idpAlias: string, org: string): Promise<boolean> {
    if (user.enabled === false) return this.kc.mailConfigured();
    return this.kc.sendActionsEmail(user.id, ['VERIFY_EMAIL'], {
      lifespanSec: this.deps.cfg.mgmt.inviteLifespanSec, clientId: this.deps.cfg.oidc.bffClientId, redirectUri: `${this.deps.cfg.publicBaseUrl}${entraLoginPath(idpAlias, org)}`,
    });
  }

  /**
   * Offen eingeladene Person (ID der Einladung) oder Mitglied dieser Organisation (Keycloak-ID); sonst 404 (gleich für
   * «gibt es nicht» und «fremd»). Eine offene Einladung gilt nur über ihre eigene ID – auch wenn das Konto schon Mitglied
   * ist (neues Konto): so verhalten sich neue und bestehende Konten auch hier gleich.
   */
  private async target(tx: Tx, org: KcOrg, id: string): Promise<Target> {
    const invitation = (await tx.query<Invitation>(`SELECT ${INVITATION_COLS} FROM ${this.S}.member_invitation WHERE accepted_at IS NULL AND id = $1`, [id])).rows[0] ?? null;
    if (invitation) {
      const m = await this.kc.member(org.id, invitation.user_id);
      return { id, userId: invitation.user_id, user: m ?? await this.kc.getUser(invitation.user_id), member: !!m, invitation };
    }
    if ((await tx.query(`SELECT 1 FROM ${this.S}.member_invitation WHERE accepted_at IS NULL AND user_id = $1`, [id])).rowCount) throw notFound('Mitglied');
    const m = await this.kc.member(org.id, id);
    if (!m) throw notFound('Mitglied');
    return { id, userId: id, user: m, member: true, invitation: null };
  }

  /**
   * Einladung erneut senden (offene Einladung, bzw. Mitglied, das sein Passwort noch nicht gesetzt hat). Für offene
   * Einladungen mit Mindestdauer wie beim Einladen.
   */
  async resendInvitation(s: Scope, id: string): Promise<{ emailSent: boolean }> {
    const org = await this.org(s.alias);
    let invitation = false;
    return this.padded(() => this.locked(s, org, null, async ({ tx, log }) => {
      const t = await this.target(tx, org, id);
      invitation = !!t.invitation;
      let emailSent = false;
      if (t.invitation?.entra) {
        // Aus Entra ID: wieder der Link zur Anmeldung über Microsoft (nie «Passwort setzen»)
        const idp = (await tx.query<{ idp_alias: string }>(`SELECT idp_alias FROM ${this.S}.entra_connection`)).rows[0]?.idp_alias;
        if (!idp) throw conflict('Die Organisation ist nicht mehr mit Microsoft Entra ID verbunden. Einladung zurückziehen.');
        emailSent = t.user ? await this.sendEntraInvitation(t.user, idp, org.alias) : false;
      } else if (t.invitation && !t.member) emailSent = t.user ? await this.inviteExisting(org.id, t.userId) : false;
      else {
        // Auch bei offener Einladung: kein «Passwort setzen» an ein Konto, das schon ein Passwort hat
        if (!pendingActions(t.user!) || await this.kc.hasPassword(t.userId)) throw conflict('Diese Person hat ihr Passwort bereits gesetzt.');
        emailSent = await this.kc.sendActionsEmail(t.userId, ['UPDATE_PASSWORD', 'VERIFY_EMAIL'], { lifespanSec: this.deps.cfg.mgmt.inviteLifespanSec, clientId: this.deps.cfg.oidc.bffClientId });
      }
      if (!emailSent) throw new HttpError(502, 'Einladung nicht versendet', 'Keycloak konnte die E-Mail nicht senden (E-Mail-Versand im Realm einrichten).');
      await log({ action: 'member.invitation_resent', resourceType: 'member', resourceId: t.id, data: { email: t.invitation?.email ?? t.user?.email ?? null } });
      return { emailSent };
    }), () => invitation);
  }

  /**
   * Mitglied entfernen bzw. Einladung zurückziehen: Rollen dieser Organisation und Mitgliedschaft entfernen. Hat diese
   * Einladung das Konto angelegt (`created_account`), hat die Person ihr Passwort noch nie gesetzt und gehört sie keiner
   * anderen Organisation an, wird das unbenutzte Konto gelöscht – fremde Konten nie, auch wenn sie nie benutzt wurden.
   * `accountDeleted` erfährt nur die Plattform-Administration (für einen org-admin verriete es andere Organisationen).
   * Einladung zurückziehen mit Mindestdauer wie beim Einladen.
   */
  async removeMember(s: Scope, id: string): Promise<{ accountDeleted: boolean }> {
    const org = await this.org(s.alias);
    let invitation = false;
    return this.padded(async () => {
      const failure: Failure = { action: 'member.remove_failed', resourceType: 'member', resourceId: id };
      const r = await this.locked(s, org, failure, async ({ tx, tenantId, log, done }) => {
        const t = await this.target(tx, org, id);
        const userId = t.userId;
        invitation = !!t.invitation;
        if (t.invitation) failure.action = 'member.invitation_withdraw_failed';
        if (!s.platform && userId === s.actor.subject) throw conflict('Du kannst dich nicht selbst aus der Organisation entfernen.');
        const roles = await this.rolesOf(org.alias, userId);
        const groups = await this.roleGroups(org.alias);
        if (roles.includes(ADMIN_ROLE)) {
          this.requireAdminChange(s);
          if (t.member) await this.lastAdminGuard(tx, org, groups, userId);
        }
        for (const r of roles) { const g = groups.get(r); if (g) { await this.kc.leaveGroup(userId, g.id); done({ step: 'role_removed', role: r }); } }
        if (t.member) { await this.kc.removeMember(org.id, userId); done({ step: 'membership_removed' }); }
        // Verknüpfung mit Entra ID dieser Organisation lösen: sonst bliebe die Anmeldung über Entra bestehen
        const idp = (await tx.query<{ idp_alias: string }>(`SELECT idp_alias FROM ${this.S}.entra_connection`)).rows[0]?.idp_alias;
        if (idp) await this.kc.removeFederatedIdentity(userId, idp);
        let accountDeleted = false;
        // Einladung aus Entra ID: kein «Passwort setzen» offen, das Konto war nie benutzt, solange die Einladung offen ist
        if (t.invitation?.created_account && t.user && (t.invitation.entra || pendingActions(t.user)) && !(await this.kc.hasPassword(userId)) && !(await this.kc.memberOrgs(userId)).length) {
          await this.kc.deleteUser(userId);
          accountDeleted = true;
          done({ step: 'account_deleted' }, true);
        }
        await tx.query(`DELETE FROM ${this.S}.member_invitation WHERE user_id = $1 AND accepted_at IS NULL`, [userId]);
        // Austritt erst jetzt, nach dem Entfernen in Keycloak: clock_timestamp() statt now() (Beginn der Transaktion,
        // vor dem Entfernen) – sonst höbe ein Token aus der Zwischenzeit (iat ≥ removed_at) den Austritt wieder auf
        await tx.query(`UPDATE ${this.S}.principal SET removed_at = clock_timestamp() WHERE kind = 'user' AND subject = $1`, [userId]);
        await log({ action: t.invitation ? 'member.invitation_withdrawn' : 'member.removed', resourceType: 'member', resourceId: t.id,
          data: { email: t.invitation?.email ?? t.user?.email ?? null, roles, ...(s.platform ? { accountDeleted } : {}) } });
        return { accountDeleted: s.platform && accountDeleted, tenantId, userId };
      });
      // Nach dem Commit: vorher sähe eine gleichzeitige Anfrage den Austritt noch nicht und legte ihn neu in den Cache
      this.deps.resolver.forgetPrincipal(r.tenantId, r.userId);
      await this.syncNow(s, org);
      return { accountDeleted: r.accountDeleted };
    }, () => invitation);
  }

  /** Sofortiger Abgleich des Personenverzeichnisses nach dem Entfernen; die Änderung selbst ist schon gespeichert. */
  private async syncNow(s: Scope, org: KcOrg) {
    try {
      const roles: RoleCleanup = { kc: this.kc, orgId: org.id, groups: await this.roleGroups(org.alias) };
      await syncTenantMembers(this.sync, this.deps.db, await this.tenantFor(s, org), org.alias, await this.kc.members(org.id), s.correlationId, roles);
    } catch { /* nächster Abgleich (Liste, Worker) holt es nach */ }
  }

  private async lastAdminGuard(tx: Tx, org: KcOrg, groups: Map<string, KcGroup>, userId: string) {
    const admins = await this.activeAdmins(tx, org, groups);
    if (!admins.filter(id => id !== userId).length) throw conflict(`Die Organisation braucht mindestens eine aktive Person mit der Rolle ${this.roleLabel(ADMIN_ROLE)}. Zuerst eine andere Person zur Administration machen.`, { reason: 'last-admin' });
  }

  /** Rollen einer Person (Mitglieds- oder Einladungs-ID) in dieser Organisation auf genau diese Liste setzen. */
  async setRoles(s: Scope, id: string, wanted: string[]): Promise<Member> {
    const roles = [...new Set(wanted)];
    await this.checkRoles(s, roles);
    if (!this.rolesManageable) throw conflict('Rollen kommen aus Client-Rollen von Keycloak (ROLE_SOURCE=client) und lassen sich hier nicht verwalten.');
    const org = await this.org(s.alias);
    await this.locked(s, org, { action: 'member.roles_change_failed', resourceType: 'member', resourceId: id }, async ({ tx, log, done }) => {
      const t = await this.target(tx, org, id);
      const current = await this.rolesOf(org.alias, t.userId);
      const add = roles.filter(r => !current.includes(r)), del = current.filter(r => !roles.includes(r));
      if (!add.length && !del.length) return;
      if (add.includes(ADMIN_ROLE) || del.includes(ADMIN_ROLE)) this.requireAdminChange(s);
      const groups = await this.roleGroups(org.alias, true);
      if (del.includes(ADMIN_ROLE) && t.member) await this.lastAdminGuard(tx, org, groups, t.userId);
      const gone = add.find(r => !groups.has(r));
      if (gone) throw conflict(`Die Rolle «${gone}» gibt es nicht mehr. Seite neu laden.`);
      for (const r of add) { await this.kc.joinGroup(t.userId, groups.get(r)!.id); done({ step: 'role_added', role: r }); }
      for (const r of del) { await this.kc.leaveGroup(t.userId, groups.get(r)!.id); done({ step: 'role_removed', role: r }); }
      await log({ action: 'member.roles_changed', resourceType: 'member', resourceId: t.id, data: { added: add, removed: del, roles } });
    });
    return this.member(s, id);
  }

  // ---------------------------------------------------------------- Organisationen (nur platform-admin)
  async listOrganizations(correlationId?: string): Promise<Organization[]> {
    const [orgs, tenants] = await Promise.all([this.kc.listOrgs(), listTenants(this.deps.db)]);
    this.orgs = { at: Date.now(), byAlias: new Map(orgs.map(o => [asciiLower(o.alias), o])) };
    const byAlias = new Map(tenants.map(t => [t.alias, t]));
    for (const o of orgs) await this.syncName(o, byAlias.get(asciiLower(o.alias)) ?? null, correlationId);
    return orgs.map(o => this.orgOut(o, byAlias.get(asciiLower(o.alias)) ?? null)).sort((a, b) => a.alias.localeCompare(b.alias));
  }

  /**
   * Name des Mandanten nachführen, wo die Plattform die Organisation ohnehin liest (Name in Keycloak massgeblich).
   * Nur für den Mandanten mit derselben Keycloak-ID (eine leere wird wie beim Mitgliederabgleich gebunden, orgMatches);
   * Fehler halten das Lesen nicht auf – der Worker holt es nach.
   */
  private async syncName(o: KcOrg, t: TenantRow | null, correlationId?: string) {
    if (!t || t.name === o.name?.trim()) return;
    try {
      const bound = t.kc_org_id ? t.kc_org_id === o.id : t.status === 'active' && await orgMatches(this.deps.db, t, o);
      if (bound) await syncTenantName(this.sync, this.deps.db, this.kc, t.id, o, correlationId);
    } catch { /* nächster Abgleich */ }
  }

  private orgOut(o: KcOrg, t: TenantRow | null): Organization {
    return {
      id: o.id, alias: o.alias, name: o.name, description: o.description ?? null, enabled: o.enabled !== false, domains: (o.domains ?? []).map(d => d.name),
      tenant: t ? { id: t.id, status: t.status, createdAt: t.created_at } : null,
    };
  }

  async organization(alias: string, correlationId?: string): Promise<Organization> {
    const o = await this.org(alias, true);
    const t = await findTenant(this.deps.db, o.alias);
    await this.syncName(o, t, correlationId);
    return this.orgOut(o, t);
  }

  private checkDomains(domains: string[]): string[] {
    const list = [...new Set(domains.map(d => d.trim().toLowerCase()).filter(Boolean))];
    const bad = list.filter(d => !DOMAIN_RE.test(d));
    if (bad.length) throw invalid('Domäne ungültig', bad.map(d => ({ path: '/domains', message: `«${d}» ist keine gültige Domäne` })));
    return list;
  }

  async createOrganization(s: Scope, input: { alias: string; name: string; description?: string; domains: string[] }): Promise<Organization> {
    // Nur ASCII klein (toLowerCase() machte aus dem Kelvin-Zeichen ein gültiges «k»)
    const alias = asciiLower(input.alias.trim());
    if (!ALIAS_PATTERN.test(alias)) throw invalid('Alias ungültig', [{ path: '/alias', message: 'Kleinbuchstaben, Ziffern, - und _ (beginnt mit Buchstabe oder Ziffer, höchstens 63 Zeichen)' }]);
    const name = input.name.trim();
    if (!name) throw invalid('Name fehlt', [{ path: '/name', message: 'Name angeben' }]);
    const domains = this.checkDomains(input.domains);
    if ((await this.kc.listOrgs()).some(o => asciiLower(o.alias) === alias)) throw conflict(`Eine Organisation mit dem Alias «${alias}» besteht bereits.`);
    if (await findTenant(this.deps.db, alias)) throw conflict(`Der Alias «${alias}» ist in der Plattform bereits vergeben.`);
    let id: string;
    try {
      id = await this.kc.createOrg({ alias, name, enabled: true, ...(input.description ? { description: input.description.trim() } : {}), domains: domains.map(d => ({ name: d, verified: false })) });
    } catch (e) {
      if (e instanceof KeycloakError && e.kcStatus === 409) throw conflict('Name, Alias oder eine Domäne ist in Keycloak bereits vergeben.');
      throw e;
    }
    try {
      await this.roleGroups(alias, true);
      const a = this.actorOf(s);
      await createTenant(this.tenants, this.deps.db, this.deps.db, alias, name, id, { ...a, data: { ...a.data, domains } });
    } catch (e) {
      await this.kc.deleteOrg(id).catch(() => undefined);
      throw e;
    }
    this.orgs = null;
    return this.organization(alias, s.correlationId);
  }

  async updateOrganization(s: Scope, alias: string, input: { name?: string; description?: string | null; domains?: string[] }): Promise<Organization> {
    const org = await this.org(alias, true);
    const next: KcOrg = { ...org };
    const changes: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw invalid('Name fehlt', [{ path: '/name', message: 'Name angeben' }]);
      if (name !== org.name) { next.name = name; changes.name = { from: org.name, to: name }; }
    }
    if (input.description !== undefined && (input.description ?? '') !== (org.description ?? '')) { next.description = input.description ?? ''; changes.description = true; }
    if (input.domains !== undefined) {
      const domains = this.checkDomains(input.domains), before = (org.domains ?? []).map(d => d.name);
      // An Entra ID gebundene Domänen (Anbieter an der Domäne) ändert nur die Entra-Verbindung
      const bound = (org.domains ?? []).filter(d => d.identityProviderAlias?.startsWith('entra-') && !domains.includes(d.name)).map(d => d.name);
      if (bound.length) throw conflict(`An Microsoft Entra ID gebunden: ${bound.join(', ')}. Diese Domänen ändert die Anmeldung über Entra ID der Organisation.`);
      if (domains.join() !== before.join()) {
        const keep = new Map((org.domains ?? []).map(d => [d.name, d]));
        next.domains = domains.map(d => keep.get(d) ?? { name: d, verified: false });
        changes.domains = { added: domains.filter(d => !before.includes(d)), removed: before.filter(d => !domains.includes(d)) };
      }
    }
    if (!Object.keys(changes).length) return this.organization(alias, s.correlationId);
    await this.locked({ ...s, alias: org.alias }, org, { action: 'organization.update_failed', resourceType: 'tenant' }, async ({ tx, tenantId, log, done }) => {
      try { await this.kc.updateOrg(next); }
      catch (e) { if (e instanceof KeycloakError && e.kcStatus === 409) throw conflict('Name oder eine Domäne ist in Keycloak bereits vergeben.'); throw e; }
      done({ step: 'organization_updated' });
      if (changes.name) await tx.query(`UPDATE ${this.S}.tenant SET name = $1 WHERE id = app.tenant_id()`, [next.name]);
      await log({ action: 'organization.updated', resourceType: 'tenant', resourceId: tenantId, data: changes });
    });
    this.orgs = null;
    return this.organization(alias, s.correlationId);
  }

  /** Sperren/Entsperren in Keycloak (Organisation deaktiviert) und in der Plattform (Mandant gesperrt) zugleich. */
  async setOrganizationStatus(s: Scope, alias: string, status: 'active' | 'suspended', reason = ''): Promise<Organization> {
    const org = await this.org(alias, true);
    if (status === 'suspended' && asciiLower(org.alias) === s.actor.tenantAlias) throw conflict('Die Organisation, in der du gerade angemeldet bist, kannst du nicht sperren.');
    await this.tenantFor(s, org); // Mandant existiert (sonst anlegen)
    const enabled = status === 'active';
    if (org.enabled !== enabled) await this.kc.updateOrg({ ...org, enabled });
    try {
      // setTenantStatus vergisst den Mandanten im Resolver dieser Instanz
      await setTenantStatus(this.tenants, this.deps.db, this.deps.db, org.alias, status, reason, this.actorOf(s));
    } catch (e) {
      if (org.enabled !== enabled) await this.kc.updateOrg({ ...org, enabled: org.enabled }).catch(() => undefined); // Keycloak und Plattform gleich halten
      throw e;
    }
    this.orgs = null;
    return this.organization(alias, s.correlationId);
  }
}
