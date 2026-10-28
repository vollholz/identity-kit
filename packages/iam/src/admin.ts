/**
 * Verwaltung von Organisationen und Mitgliedern – mit der Mandantengrenze (Spezifikation Kap. 9.1, 9.6).
 *
 * Keycloak hält nur Konto und Mitgliedschaft (D6); Rollen sind Tupel `user:<id> <rolle> org` in der Datenbank der App,
 * die Freigabestufe steht am Principal. Der Service Account in Keycloak darf mehr als eine Organisation (Keycloak 26
 * kennt keine Rechte je Organisation); die Grenze setzt diese Datei durch:
 * - Wer `members:admin` hat, arbeitet immer in der Organisation seines Tokens (`Scope.alias` kommt aus dem Principal,
 *   nie aus der Anfrage). Jede Person wird vor jeder Änderung als Mitglied bzw. offene Einladung genau dieser
 *   Organisation geprüft; fremde IDs → 404.
 * - Regeln für Rollen und Freigabestufen (org-admin nur platform-admin, niemand gibt mehr, als er hat, letzter Admin,
 *   nie für sich selbst): rules.ts.
 * - Ein org-admin erfährt nichts über andere Organisationen: Einladen, erneut Senden und Zurückziehen antworten gleich,
 *   ob für die Adresse schon ein Konto besteht oder nicht (gleicher Status, gleiche Felder, Mindestdauer
 *   KEYCLOAK_MGMT_INVITE_MIN_TIME); eingeladene Personen erscheinen in beiden Fällen gleich (offene Einladung aus
 *   `member_invitation`) und tragen nach aussen die ID ihrer Einladung, nie die ID des Kontos; ob ein Konto beim
 *   Entfernen gelöscht wurde, sieht nur die Plattform. Gelöscht wird nur ein Konto, das die Einladung selbst angelegt
 *   hat (`created_account`).
 * - Die Einladung legt den Principal an (A16) und setzt die Rollen sofort als Tupel; Zurückziehen und Entfernen löschen
 *   alle Tupel der Person (A17).
 * - Änderungen derselben Organisation laufen nacheinander (Advisory-Lock `admin:<alias>`). Jede Änderung steht im
 *   Audit des betroffenen Mandanten; scheitert eine Änderung, nachdem Keycloak schon geändert wurde, folgt ein eigener
 *   Eintrag `…_failed` mit den erfolgten Schritten.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AccessService } from './access.ts';
import { writePlatformAudit, type Actor, type AuditEntry, type AuditPort, type Source } from './audit.ts';
import type { IamConfig } from './config.ts';
import { schemaName, setContext, withTenant, withTx, type Db, type Tx } from './db.ts';
import { conflict, HttpError, invalid, notFound } from './errors.ts';
import { emitAfter, emitBefore, type IamEvents, type MemberEventData } from './events.ts';
import { notLinkable, type EntraGraph, type EntraUser } from './graph.ts';
import { listClients } from './http/clients.ts';
import { KeycloakAdmin, KeycloakError, type KcOrg, type KcUser } from './keycloak.ts';
import { lockKey } from './locks.ts';
import { ADMIN_ROLE, CUSTOM_ROLE_KEY, type Level, type Model } from './model.ts';
import { ALIAS_PATTERN, asciiLower, type Account, type Principal, type PrincipalResolver } from './principal.ts';
import { checkRoleChange, checkRoles, lastAdminGuard, setClearance, setOrgRoles, type Acting } from './rules.ts';
import { displayName, orgMatches, pendingActions, syncTenantMembers, syncTenantName, type SyncContext } from './sync.ts';
import { createTenant, findTenant, listTenants, setTenantStatus, type TenantActor, type TenantRow, type TenantsContext } from './tenants.ts';
import type { TupleStore } from './tuples.ts';

const selfServiceOff = (what: string) => new HttpError(403, 'Nicht eingerichtet', `${what} ist in dieser Instanz nicht eingeschaltet.`, {}, { reason: 'self-service-off' });

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Was der Service vom IAM braucht (`createIam` übergibt sich selbst). */
export interface AdminDeps {
  readonly cfg: IamConfig;
  readonly model: Model<any>;
  readonly db: Db;
  readonly schema: string;
  readonly audit: AuditPort;
  readonly resolver: Pick<PrincipalResolver, 'forgetPrincipal' | 'forgetTenant' | 'forgetEntra'>;
  readonly access: AccessService<any, any>;
  readonly tuples: TupleStore;
  /** Haken der App (`member.removing`, `member.removed`; Rollen über `tuples`). */
  readonly events?: IamEvents | null;
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
/** Person oder freigegebener Maschinen-Client der Organisation (Kap. 9.6). */
export interface Member {
  /** Person: Keycloak-ID bzw. Einladungs-ID; Client: Client-ID. */
  id: string;
  kind: 'user' | 'client';
  /** Subjekt `user:<id>` bzw. `client:<id>`; nie null (A16). */
  principalId: string;
  username: string; name: string; email: string | null;
  status: MemberStatus;
  /** Rollen an der Organisation (Tupel), Reihenfolge des Modells. */
  roles: string[];
  /** Gespeicherte Stufe, ohne Break-Glass. */
  clearance: Level;
  breakGlassUntil: Date | null;
  /** Tupel an anderen Orten als org («+3 Orte»). */
  places: number;
  lastSeenAt: Date | null; createdAt: Date | null;
  /** Offene Einladung aus Entra ID: Pfad der Anmeldung über Microsoft (zum Weitergeben), sonst null. */
  loginPath: string | null;
  /** Nur Clients. */
  clientId: string | null; scopes: string[] | null; description: string | null;
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
/** Adresse des Kontos für eine Person aus Entra: `mail`, wenn in einer gebundenen Domäne, sonst der UPN. */
export function entraAddress(u: EntraUser, domains: readonly string[]): string {
  const mail = u.mail?.toLowerCase();
  return mail && domains.includes(mail.slice(mail.lastIndexOf('@') + 1)) ? mail : u.userPrincipalName.toLowerCase();
}

/** Was addFromEntra von der Entra-Verbindung braucht (EntraService in entra.ts; ohne Abhängigkeit in diese Richtung). */
interface EntraLinkConnection {
  tenantId: string; appClientId: string | null; appSecretEnc: string | null;
  entraTenantId: string; idpAlias: string; domains: string[]; stage: 'pending' | 'enforced';
}
export interface EntraLink {
  connectionOf(tx: Tx): Promise<EntraLinkConnection | null>;
  /** Graph mit der App der Verbindung (eigene App der Organisation oder die der Plattform). */
  graphFor(c: EntraLinkConnection): Pick<EntraGraph, 'user'>;
  linkAccount(w: Pick<Work, 'done'>, c: { idpAlias: string; domains: string[] }, user: KcUser, entra: EntraUser): Promise<void>;
  removeFirstFactor(w: Pick<Work, 'done'>, user: KcUser): Promise<boolean>;
}

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
  step: 'account_created' | 'membership_added' | 'membership_removed' | 'account_deleted' | 'organization_updated'
    | 'idp_created' | 'idp_linked' | 'idp_updated' | 'idp_deleted' | 'account_linked' | 'password_removed' | 'mapper_created';
  role?: string;
}

/** Arbeit in locked(): Transaktion, Audit und erfolgte Schritte in Keycloak. */
export interface Work {
  tx: Tx;
  tenantId: string;
  /** Wer handelt (Regeln für Rollen und Freigabestufen). */
  acting: Acting;
  log: (e: AuditEntry) => Promise<void>;
  /** Änderung in Keycloak erfolgt. `platformOnly`: verriete einem org-admin etwas über das Konto (neu/gelöscht). */
  done: (st: Step, platformOnly?: boolean) => void;
  /** Rückgängig gemacht: nicht mehr protokollieren. */
  undone: (st: Step) => void;
}

/** Protokolleintrag, wenn die Arbeit scheitert, nachdem Keycloak schon geändert wurde (eigene Transaktion). */
export type Failure = { action: string; resourceType: 'member'; resourceId: string | null } | { action: string; resourceType: 'tenant' };

interface PrincipalRow { id: string; subject: string; last_seen_at: Date | null; clearance: Level; clearance_until: Date | null; invited_at: Date | null }

export class AdminService {
  private readonly deps: AdminDeps;
  readonly kc: KeycloakAdmin;
  /** Schema der Tabellen (geprüft). */
  private readonly S: string;
  private orgs: { at: number; byAlias: Map<string, KcOrg>; ambiguous: Set<string> } | null = null;

  constructor(deps: AdminDeps, kc: KeycloakAdmin) {
    this.deps = deps; this.kc = kc;
    this.S = schemaName(deps.schema);
  }

  private get tenants(): TenantsContext { return { schema: this.deps.schema, audit: this.deps.audit, resolver: this.deps.resolver }; }
  private get sync(): SyncContext { return { schema: this.deps.schema, audit: this.deps.audit, events: this.deps.events ?? null }; }
  /** Reihenfolge der Rollen im Modell der Organisation (Rollen des Modells, dann eigene). */
  private roleOrder(model: Model): string[] { return [...model.roles.keys()]; }

  /**
   * Rollen vor jeder Änderung prüfen (422, 403 ohne Aufruf bei Keycloak). Eigene Organisation: mit ihrem Modell; Plattform
   * (Organisation erst unter der Sperre bekannt): Rollen des Modells hier, eigene Rollen in `setOrgRoles` unter der Sperre.
   */
  private async precheckRoles(s: Scope, wanted: string[], all = true): Promise<string[]> {
    const a = this.deps.access;
    if (!s.platform) {
      const model = await a.modelOf(s.actor.tenantId);
      const roles = checkRoles(a, wanted, '/roles', model);
      // Neue Person: alle Rollen sind neu (beim Setzen zählen nur die Änderungen, in setOrgRoles)
      if (all) await checkRoleChange(a, { actor: s.actor, platform: false }, roles, model);
      return roles;
    }
    const custom = a.model.features.customRoles ? wanted.filter(r => CUSTOM_ROLE_KEY.test(r)) : [];
    const own = checkRoles(a, wanted.filter(r => !custom.includes(r)));
    if (all) await checkRoleChange(a, { actor: s.actor, platform: true }, own);
    return [...new Set([...own, ...custom])];
  }

  // ---------------------------------------------------------------- Organisation
  async org(alias: string, fresh = false): Promise<KcOrg> {
    if (fresh || !this.orgs || Date.now() - this.orgs.at > 60_000) this.cacheOrgs(await this.kc.listOrgs());
    const key = asciiLower(alias);
    // Aliase, die sich nur in der Gross-/Kleinschreibung unterscheiden: nicht stillschweigend eine davon nehmen
    if (this.orgs!.ambiguous.has(key)) throw conflict(`In Keycloak gibt es mehrere Organisationen mit dem Alias «${alias}» (nur Gross-/Kleinschreibung verschieden). In Keycloak bereinigen.`, { reason: 'ambiguous-alias' });
    const o = this.orgs!.byAlias.get(key);
    if (!o) {
      if (!fresh) return this.org(alias, true);
      throw notFound(`Organisation «${alias}»`);
    }
    return o;
  }

  private cacheOrgs(list: KcOrg[]) {
    const byAlias = new Map<string, KcOrg>(), ambiguous = new Set<string>();
    for (const o of list) { const k = asciiLower(o.alias); if (byAlias.has(k)) ambiguous.add(k); byAlias.set(k, o); }
    this.orgs = { at: Date.now(), byAlias, ambiguous };
  }

  // ---------------------------------------------------------------- Mandant, Transaktion, Audit
  /** Mandant der Organisation; wird bei Bedarf angelegt (Organisation in Keycloak, aber noch nie benutzt). */
  async tenantFor(s: Scope, org: KcOrg): Promise<string> {
    const t = await findTenant(this.deps.db, org.alias) ?? (s.platform ? await createTenant(this.tenants, this.deps.db, this.deps.db, org.alias, org.name, org.id, this.actorOf(s)) : null);
    if (t && !t.kc_org_id && t.status !== 'active') throw conflict(`Die Organisation «${org.alias}» ist gesperrt und noch an keine Organisation in Keycloak gebunden. Zuordnung durch den Betrieb prüfen (relinkTenant), dann entsperren.`, { reason: 'unbound-suspended' });
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
      data: s.platform ? { platformAdmin: true } : {},
    };
  }

  /** Wer handelt, wie im Audit (für Ereignisse an die App). */
  private eventActor(s: Scope): Actor {
    const a = this.actorOf(s);
    return { principal: a.principal, source: a.source, correlationId: a.correlationId };
  }

  /** Protokolleintrag mit den Kennzeichen der Plattform-Administration aus `a.data`. */
  write(tx: Tx, a: TenantActor, e: AuditEntry) {
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
      const r = await withTenant(this.deps.db, ctx, async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey.admin(org.alias)]);
        return fn({
          tx, tenantId, acting: { actor: s.actor, platform: s.platform },
          log: e => this.write(tx, a, e),
          done: (st, platformOnly = false) => { if (s.platform || !platformOnly) steps.push(st); },
          undone: st => { const i = steps.findIndex(x => x.step === st.step && x.role === st.role); if (i >= 0) steps.splice(i, 1); },
        });
      });
      this.deps.access.invalidate(tenantId);
      return r;
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

  /** Principal einer Person im Mandanten anlegen (A16) oder finden; `last_seen_at` bleibt leer bis zum ersten Zugriff. */
  private async principalOf(tx: Tx, userId: string, name: string | null, email: string | null): Promise<string> {
    return (await tx.query<{ id: string }>(
      `INSERT INTO ${this.S}.principal AS p (tenant_id, kind, subject, display_name, email, last_seen_at) VALUES (app.tenant_id(), 'user', $1, $2, $3, NULL)
       ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET display_name = coalesce(p.display_name, excluded.display_name), email = coalesce(p.email, excluded.email)
       RETURNING id`, [userId, name, email])).rows[0]!.id;
  }

  // ---------------------------------------------------------------- Mitglieder
  /** Offene Einladungen und Anbieter der Entra-Verbindung (für den Link der Einladungen aus Entra ID). */
  private async openInvitations(tx: Tx): Promise<{ list: Invitation[]; idpAlias: string | null }> {
    return {
      list: (await tx.query<Invitation>(`SELECT ${INVITATION_COLS} FROM ${this.S}.member_invitation WHERE accepted_at IS NULL ORDER BY created_at`)).rows,
      idpAlias: (await tx.query<{ idp_alias: string }>(`SELECT idp_alias FROM ${this.S}.entra_connection`)).rows[0]?.idp_alias ?? null,
    };
  }

  /** Rollen an org und Anzahl Orte je Subjekt aus dem Stand der Tupel. */
  private async tupleView(tenantId: string): Promise<(subject: string) => { roles: string[]; places: number }> {
    const acl = await this.deps.access.load(tenantId);
    const now = Date.now();
    return subject => {
      const mine = acl.tuples.filter(t => t.subject === subject);
      const roles = new Set(mine.filter(t => t.object_type === 'org' && (!t.expires_at || t.expires_at.getTime() > now)).map(t => t.relation));
      return { roles: this.roleOrder(acl.model).filter(r => roles.has(r)), places: mine.filter(t => t.object_type !== 'org').length };
    };
  }

  /**
   * Eingeladene Person: Angaben aus der Einladung dieses Mandanten, nicht aus dem Konto (gleich für neue und bestehende
   * Konten); ID der Einladung statt der Keycloak-ID (gleiche Keycloak-ID bei erneuter Einladung verriete ein Konto).
   */
  private static invited(i: Invitation, p: { principalId: string; roles: string[]; places: number; clearance: Level }, org: string, idpAlias: string | null): Member {
    return {
      id: i.id, kind: 'user', principalId: p.principalId, username: i.email, name: i.display_name, email: i.email, status: 'invited', roles: p.roles,
      clearance: p.clearance, breakGlassUntil: null, places: p.places, lastSeenAt: null, createdAt: i.created_at,
      loginPath: i.entra && idpAlias ? entraLoginPath(idpAlias, org) : null, clientId: null, scopes: null, description: null,
    };
  }

  /** Personen (Mitglieder und offene Einladungen) und freigegebene Clients, sortiert nach Name. */
  async listMembers(s: Scope): Promise<Member[]> {
    const org = await this.org(s.alias);
    const users = await this.kc.members(org.id);
    const tenantId = await this.tenantFor(s, org);
    // Personenverzeichnis abgleichen: Mitglieder, die sich noch nie angemeldet haben, auswählbar; Ehemalige markiert
    await syncTenantMembers(this.sync, this.deps.db, tenantId, org.alias, users, s.correlationId);
    const view = await this.tupleView(tenantId);
    const now = Date.now();
    return withTenant(this.deps.db, { tenantId }, async tx => {
      const inv = await this.openInvitations(tx);
      const open = new Map(inv.list.map(i => [i.user_id, i]));
      const subjects = [...users.map(u => u.id), ...inv.list.map(i => i.user_id)];
      const principals = new Map((await tx.query<PrincipalRow>(
        `SELECT p.id, p.subject, p.last_seen_at, p.clearance, CASE WHEN p.clearance_until > now() THEN p.clearance_until END AS clearance_until,
                (SELECT max(i.created_at) FROM ${this.S}.member_invitation i WHERE i.user_id = p.subject) AS invited_at
           FROM ${this.S}.principal p WHERE p.kind = 'user' AND p.subject = ANY($1::text[])`, [subjects])).rows.map(r => [r.subject, r]));
      const missing = subjects.filter(id => !principals.has(id));
      for (const id of missing) {
        const u = users.find(x => x.id === id);
        const pid = await this.principalOf(tx, id, u ? displayName(u) : open.get(id)?.display_name ?? null, u?.email ?? open.get(id)?.email ?? null);
        principals.set(id, { id: pid, subject: id, last_seen_at: null, clearance: 0, clearance_until: null, invited_at: null });
      }
      const out: Member[] = users.filter(u => !open.has(u.id)).map(u => {
        const p = principals.get(u.id)!, tv = view(`user:${p.id}`);
        const status: MemberStatus = u.enabled === false ? 'disabled' : pendingActions(u) && !p.last_seen_at ? 'invited' : 'active';
        // createdAt: Einladung in DIESE Organisation; das Alter des Kontos in Keycloak verriete ein früheres Konto
        return {
          id: u.id, kind: 'user' as const, principalId: p.id, username: u.username, name: displayName(u), email: u.email ?? null, status, roles: tv.roles,
          clearance: p.clearance, breakGlassUntil: p.clearance_until && p.clearance_until.getTime() > now ? p.clearance_until : null, places: tv.places,
          lastSeenAt: p.last_seen_at, createdAt: p.invited_at, loginPath: null, clientId: null, scopes: null, description: null,
        };
      });
      for (const i of open.values()) {
        const p = principals.get(i.user_id)!, tv = view(`user:${p.id}`);
        out.push(AdminService.invited(i, { principalId: p.id, roles: tv.roles, places: tv.places, clearance: p.clearance }, org.alias, inv.idpAlias));
      }
      for (const c of await listClients(tx, this.S, this.roleOrder(await this.deps.access.modelIn(tx)))) {
        out.push({
          id: c.clientId, kind: 'client', principalId: c.principalId, username: c.clientId, name: c.clientId, email: null, status: 'active', roles: c.roles,
          clearance: c.clearance, breakGlassUntil: null, places: c.places, lastSeenAt: c.lastUsedAt, createdAt: c.createdAt, loginPath: null,
          clientId: c.clientId, scopes: c.lastScopes, description: c.description,
        });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name, 'de-CH'));
    });
  }

  /** Hat die Person (Keycloak-ID) in dieser Organisation `members:admin`? (Tupel an org eigener Subjekte, ohne Gruppen) */
  async managesMembers(tenantId: string, subject: string): Promise<boolean> {
    const id = await withTenant(this.deps.db, { tenantId }, async tx => (await tx.query<{ id: string }>(`SELECT id FROM ${this.S}.principal WHERE kind = 'user' AND subject = $1 AND removed_at IS NULL`, [subject])).rows[0]?.id);
    if (!id) return false;
    const acl = await this.deps.access.load(tenantId);
    return this.deps.access.orgPermissions({ kind: 'user', principalId: id, subjects: [`user:${id}`, 'org:members'], scopes: [] }, acl).includes('members:admin');
  }

  /**
   * Offene Links an die Entra-Administration, die diese Person für die Organisation erzeugt hat, widerrufen: Sie darf
   * keine mehr erzeugen (entfernt oder ohne `members:admin`). Links der Plattform-Administration bleiben.
   */
  async revokeConsentLinksOf(w: Pick<Work, 'tx' | 'tenantId' | 'log'>, subject: string) {
    const ids = (await w.tx.query<{ id: string }>(`UPDATE ${this.S}.entra_consent_link SET revoked_at = now(), error_reason = 'creator-lost-access', error_detail = NULL
      WHERE created_by_subject = $1 AND NOT platform AND used_at IS NULL AND revoked_at IS NULL RETURNING id`, [subject])).rows.map(r => r.id);
    if (!ids.length) return;
    await w.tx.query(`UPDATE ${this.S}.entra_consent SET expires_at = now() WHERE link_id = ANY($1::uuid[]) AND used_at IS NULL`, [ids]);
    await w.log({ action: 'entra.consent_link_revoked', resourceType: 'tenant', resourceId: w.tenantId, data: { linkIds: ids, reason: 'creator-lost-access' } });
  }

  /** Mitglied bzw. eingeladene Person nach der ID von aussen (Mitglieds- oder Einladungs-ID); Clients nicht. */
  async member(s: Scope, id: string): Promise<Member> {
    const m = (await this.listMembers(s)).find(x => x.id === id && x.kind === 'user');
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
   * In beiden Fällen gleiche Antwort (202, «invitation-sent», eingeladene Person aus der Einladung). Die Einladung legt
   * den Principal an und setzt die Rollen als Tupel (A16). Die App setzt nie ein Passwort.
   */
  async invite(s: Scope, input: { email: string; firstName?: string; lastName?: string; roles: string[] }): Promise<{ result: 'invitation-sent'; emailSent: boolean; member: Member }> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw invalid('E-Mail-Adresse ungültig', [{ path: '/email', message: 'Gültige E-Mail-Adresse angeben' }]);
    const roles = await this.precheckRoles(s, input.roles);
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
      // createdAccount: das Konto entsteht mit dieser Einladung – nur dann darf ein Fehler oder das Zurückziehen es löschen
      let userId = existing?.id ?? null, createdAccount = false;
      try {
        if (!userId) {
          userId = await this.createAccount(email, input);
          createdAccount = true;
          w.done({ step: 'account_created' }, true);
          await this.kc.addMember(org.id, userId);
          w.done({ step: 'membership_added' }, true);
        }
        const principalId = await this.principalOf(tx, userId, name, email);
        await setOrgRoles(tx, { access: this.deps.access, tuples: this.deps.tuples, schema: this.S, acting: w.acting, subject: `user:${principalId}`, roles, createdBy: s.platform ? null : s.actor.principalId, actor: this.eventActor(s) });
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
        const clearance = (await tx.query<{ clearance: Level }>(`SELECT clearance FROM ${this.S}.principal WHERE id = $1`, [principalId])).rows[0]!.clearance;
        const order = this.roleOrder(await this.deps.access.modelIn(tx));
        return { result: 'invitation-sent' as const, emailSent, member: AdminService.invited(inv, { principalId, roles: order.filter(r => roles.includes(r)), places: 0, clearance }, org.alias, null) };
      } catch (e) {
        // Nichts Halbes zurücklassen (Transaktion wird zurückgerollt): nur das mit dieser Einladung angelegte Konto löschen
        if (createdAccount && userId && await this.kc.deleteUser(userId).then(() => true, () => false)) {
          w.undone({ step: 'account_created' }); w.undone({ step: 'membership_added' });
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
   * leitet Keycloak zur Anmeldung über Microsoft weiter (`entraLoginPath`). Gesperrtes bestehendes Konto: Antwort wie für
   * ein neues Konto (wie inviteExisting).
   */
  async sendEntraInvitation(user: KcUser, idpAlias: string, org: string): Promise<boolean> {
    if (user.enabled === false) return this.kc.mailConfigured();
    return this.kc.sendActionsEmail(user.id, ['VERIFY_EMAIL'], {
      lifespanSec: this.deps.cfg.mgmt.inviteLifespanSec, clientId: this.deps.cfg.oidc.bffClientId, redirectUri: `${this.deps.cfg.publicBaseUrl}${entraLoginPath(idpAlias, org)}`,
    });
  }

  /**
   * Person aus Entra ID hinzufügen, noch vor ihrer ersten Anmeldung (Kap. 9.4). Die Person wird in Graph neu gelesen
   * (nicht den Angaben des Clients trauen) und muss verknüpfbar sein. Besteht für ihre Adresse ein Konto, wird es
   * verwendet, sonst eines ohne Passwort angelegt; dann Mitglied, über die Objekt-ID verknüpft, Principal und Rollen als
   * Tupel. Antwort und Dauer gleich für neue und bestehende Konten (Mandantentrennung).
   */
  async addFromEntra(s: Scope, ent: EntraLink, input: { id: string; roles: string[]; sendEmail?: boolean }): Promise<{ result: 'added'; emailSent: boolean; member: Member }> {
    const roles = await this.precheckRoles(s, input.roles);
    const org = await this.org(s.alias);
    if (!org.enabled) throw conflict('Die Organisation ist gesperrt.');
    return this.padded(() => this.locked(s, org, { action: 'member.entra_add_failed', resourceType: 'member', resourceId: null }, async w => {
      const { tx } = w;
      const c = await ent.connectionOf(tx);
      if (!c) throw conflict('Die Organisation ist nicht mit Microsoft Entra ID verbunden.', { reason: 'entra-not-connected' });
      const p = await ent.graphFor(c).user(c.entraTenantId, input.id);
      if (!p) throw notFound('Person in Entra ID');
      const why = notLinkable(p, c.domains);
      if (why) throw conflict(`Diese Person lässt sich nicht hinzufügen: ${why}.`, { reason: 'not-linkable' });
      const email = entraAddress(p, c.domains);
      if ((await tx.query(`SELECT 1 FROM ${this.S}.member_invitation WHERE accepted_at IS NULL AND lower(email) = $1`, [email])).rowCount) throw conflict('Diese Person ist bereits eingeladen.');
      const existing = await this.kc.findUserByEmail(email);
      const linked = await this.kc.userByIdentity(c.idpAlias, p.id);
      if (linked && linked.id !== existing?.id) throw conflict('Diese Person in Entra ID ist bereits mit einem anderen Konto verknüpft.', { reason: 'entra-linked' });
      if (existing) {
        if ((await tx.query(`SELECT 1 FROM ${this.S}.member_invitation WHERE accepted_at IS NULL AND user_id = $1`, [existing.id])).rowCount) throw conflict('Diese Person ist bereits eingeladen.');
        if (await this.kc.member(org.id, existing.id)) throw conflict('Diese Person ist bereits Mitglied der Organisation.');
      }
      const name = p.displayName?.trim() || [p.givenName, p.surname].filter(Boolean).join(' ') || email;
      let user = existing, createdAccount = false, member = false, linkedNow = false;
      try {
        if (!user) {
          // Ohne Passwort und ohne «Passwort setzen»: angemeldet wird nur über Microsoft
          const id = await this.createAccount(email, { firstName: p.givenName ?? undefined, lastName: p.surname ?? undefined }, []);
          createdAccount = true;
          w.done({ step: 'account_created' }, true);
          user = (await this.kc.getUser(id))!;
        }
        await this.kc.addMember(org.id, user.id);
        member = true;
        w.done({ step: 'membership_added' });
        if (!linked) { await ent.linkAccount(w, c, user, p); linkedNow = true; }
        // Passwort eines bestehenden Kontos: nur für die Plattform protokolliert (verriete sonst das Konto)
        if (c.stage === 'enforced' && !createdAccount) await ent.removeFirstFactor({ done: st => w.done(st, true) }, user);
        const principalId = await this.principalOf(tx, user.id, name.slice(0, 200), email);
        await setOrgRoles(tx, { access: this.deps.access, tuples: this.deps.tuples, schema: this.S, acting: w.acting, subject: `user:${principalId}`, roles, createdBy: s.platform ? null : s.actor.principalId, actor: this.eventActor(s) });
        const inv = (await tx.query<Invitation>(
          `INSERT INTO ${this.S}.member_invitation (tenant_id, user_id, email, display_name, created_by_name, created_account, entra) VALUES (app.tenant_id(), $1, $2, $3, $4, $5, true)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET id = gen_random_uuid(), email = excluded.email, display_name = excluded.display_name, created_at = now(),
             created_by_name = excluded.created_by_name, created_account = excluded.created_account, entra = true, accepted_at = NULL
           RETURNING ${INVITATION_COLS}`, [user.id, email, name.slice(0, 200), s.actor.name, createdAccount])).rows[0]!;
        const emailSent = input.sendEmail === false ? false : await this.sendEntraInvitation(user, c.idpAlias, org.alias);
        await w.log({ action: 'member.added_from_entra', resourceType: 'member', resourceId: inv.id, data: { email, roles, emailSent, entraId: p.id } });
        const clearance = (await tx.query<{ clearance: Level }>(`SELECT clearance FROM ${this.S}.principal WHERE id = $1`, [principalId])).rows[0]!.clearance;
        const order = this.roleOrder(await this.deps.access.modelIn(tx));
        return { result: 'added' as const, emailSent, member: AdminService.invited(inv, { principalId, roles: order.filter(r => roles.includes(r)), places: 0, clearance }, org.alias, c.idpAlias) };
      } catch (e) {
        // Wie beim Einladen: ein selbst angelegtes Konto löschen, bei einem bestehenden nur zurücknehmen, was dieser
        // Aufruf geändert hat. Ein entferntes Passwort lässt sich nicht zurückgeben.
        const id = user?.id;
        if (createdAccount && id) {
          if (await this.kc.deleteUser(id).then(() => true, () => false)) { w.undone({ step: 'account_created' }); w.undone({ step: 'membership_added' }); w.undone({ step: 'account_linked' }); }
        } else if (id) {
          if (linkedNow && await this.kc.removeFederatedIdentity(id, c.idpAlias).then(() => true, () => false)) w.undone({ step: 'account_linked' });
          if (member && await this.kc.removeMember(org.id, id).then(() => true, () => false)) w.undone({ step: 'membership_added' });
        }
        throw e;
      }
    }));
  }

  /**
   * Offen eingeladene Person (ID der Einladung) oder Mitglied dieser Organisation (Keycloak-ID); sonst 404 (gleich für
   * «gibt es nicht» und «fremd»). Eine offene Einladung gilt nur über ihre eigene ID.
   */
  private async target(tx: Tx, org: KcOrg, id: string): Promise<Target> {
    const invitation = (await tx.query<Invitation>(`SELECT ${INVITATION_COLS} FROM ${this.S}.member_invitation WHERE accepted_at IS NULL AND id::text = $1`, [id])).rows[0] ?? null;
    if (invitation) {
      const m = await this.kc.member(org.id, invitation.user_id);
      return { id, userId: invitation.user_id, user: m ?? await this.kc.getUser(invitation.user_id), member: !!m, invitation };
    }
    if ((await tx.query(`SELECT 1 FROM ${this.S}.member_invitation WHERE accepted_at IS NULL AND user_id = $1`, [id])).rowCount) throw notFound('Mitglied');
    const m = await this.kc.member(org.id, id);
    if (!m) throw notFound('Mitglied');
    return { id, userId: id, user: m, member: true, invitation: null };
  }

  /** Einladung erneut senden (offene Einladung bzw. Mitglied ohne gesetztes Passwort); Mindestdauer wie beim Einladen. */
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

  /** Principal einer Person im Mandanten (nur lesen). */
  private async principalIdOf(tx: Tx, userId: string): Promise<string | null> {
    return (await tx.query<{ id: string }>(`SELECT id FROM ${this.S}.principal WHERE kind = 'user' AND subject = $1`, [userId])).rows[0]?.id ?? null;
  }

  /**
   * Mitglied entfernen bzw. Einladung zurückziehen: Mitgliedschaft in Keycloak und alle Tupel der Person (A17, je Tupel
   * `access.revoked`). Hat diese Einladung das Konto angelegt, hat die Person ihr Passwort noch nie gesetzt und gehört
   * sie keiner anderen Organisation an, wird das unbenutzte Konto gelöscht – fremde Konten nie. `accountDeleted`
   * erfährt nur die Plattform-Administration. Zurückziehen mit Mindestdauer wie beim Einladen.
   */
  /** Konto in Keycloak vorhanden und nicht gesperrt (zählt für «letzte aktive Person mit org-admin»). */
  readonly accountActive = async (subject: string): Promise<boolean> => { const u = await this.kc.getUser(subject); return !!u && u.enabled !== false; };

  async removeMember(s: Scope, id: string): Promise<{ accountDeleted: boolean }> {
    const org = await this.org(s.alias);
    let invitation = false;
    return this.padded(async () => {
      const failure: Failure = { action: 'member.remove_failed', resourceType: 'member', resourceId: id };
      const r = await this.locked(s, org, failure, async ({ tx, tenantId, log, done, acting }) => {
        const t = await this.target(tx, org, id);
        const userId = t.userId;
        invitation = !!t.invitation;
        if (t.invitation) failure.action = 'member.invitation_withdraw_failed';
        // Auch über die Plattform-Route: niemand entfernt sich selbst (Spez. 9.1 Nr. 6)
        if (userId === s.actor.subject && s.actor.kind === 'user') throw conflict('Du kannst dich nicht selbst aus der Organisation entfernen.', { reason: 'self' });
        const principalId = await this.principalIdOf(tx, userId);
        const roles = principalId ? await this.deps.tuples.rolesAtOrg(tx, `user:${principalId}`) : [];
        await checkRoleChange(this.deps.access, acting, roles, await this.deps.access.modelIn(tx));
        if (principalId && roles.includes(ADMIN_ROLE)) await lastAdminGuard(tx, this.S, principalId, this.deps.model.roles.get(ADMIN_ROLE)?.label, this.accountActive);
        // Haken der App vor jeder Änderung in Keycloak: lehnt er ab (wirft), bleibt alles, wie es war
        const event: MemberEventData = { memberId: t.id, userId, principalId, email: t.invitation?.email ?? t.user?.email ?? null, roles, invitation: !!t.invitation, platform: s.platform };
        const subject = principalId ? `user:${principalId}` : null;
        await emitBefore(this.deps.events, tx, { type: 'member.removing', tenantId, subject, actor: this.eventActor(s), data: event });
        if (t.member) { await this.kc.removeMember(org.id, userId); done({ step: 'membership_removed' }); }
        // Verknüpfung mit Entra ID dieser Organisation lösen: sonst bliebe die Anmeldung über Entra bestehen
        const idp = (await tx.query<{ idp_alias: string }>(`SELECT idp_alias FROM ${this.S}.entra_connection`)).rows[0]?.idp_alias;
        if (idp) await this.kc.removeFederatedIdentity(userId, idp);
        let accountDeleted = false;
        if (t.invitation?.created_account && t.user && (t.invitation.entra || pendingActions(t.user)) && !(await this.kc.hasPassword(userId)) && !(await this.kc.memberOrgs(userId)).length) {
          await this.kc.deleteUser(userId);
          accountDeleted = true;
          done({ step: 'account_deleted' }, true);
        }
        await tx.query(`DELETE FROM ${this.S}.member_invitation WHERE user_id = $1 AND accepted_at IS NULL`, [userId]);
        const a = this.actorOf(s);
        if (principalId) await this.deps.tuples.revokeSubject(tx, `user:${principalId}`, { principal: a.principal, source: a.source, correlationId: a.correlationId, extra: a.data });
        // Austritt erst jetzt, nach dem Entfernen in Keycloak: clock_timestamp() statt now() (Beginn der Transaktion,
        // vor dem Entfernen) – sonst höbe ein Token aus der Zwischenzeit (iat ≥ removed_at) den Austritt wieder auf
        await tx.query(`UPDATE ${this.S}.principal SET removed_at = clock_timestamp(), clearance_boost = NULL, clearance_until = NULL WHERE kind = 'user' AND subject = $1`, [userId]);
        await this.revokeConsentLinksOf({ tx, tenantId, log }, userId);
        await log({ action: t.invitation ? 'member.invitation_withdrawn' : 'member.removed', resourceType: 'member', resourceId: t.id,
          data: { email: t.invitation?.email ?? t.user?.email ?? null, roles, ...(s.platform ? { accountDeleted } : {}) } });
        // Nach allen Änderungen, in derselben Transaktion (Tupel schon entzogen: je Tupel `access.revoked` vorher)
        await emitAfter(this.deps.events, tx, { type: 'member.removed', tenantId, subject, actor: this.eventActor(s), data: event });
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
    try { await syncTenantMembers(this.sync, this.deps.db, await this.tenantFor(s, org), org.alias, await this.kc.members(org.id), s.correlationId); }
    catch { /* nächster Abgleich (Liste, Worker) holt es nach */ }
  }

  /** Rollen einer Person (Mitglieds- oder Einladungs-ID) an der Organisation auf genau diese Liste setzen (Tupel). */
  async setRoles(s: Scope, id: string, wanted: string[]): Promise<Member> {
    const roles = await this.precheckRoles(s, wanted, false);
    const org = await this.org(s.alias);
    await this.locked(s, org, null, async ({ tx, tenantId, log, acting }) => {
      const t = await this.target(tx, org, id);
      const principalId = await this.principalOf(tx, t.userId, t.user ? displayName(t.user) : t.invitation?.display_name ?? null, t.user?.email ?? t.invitation?.email ?? null);
      const { added, removed } = await setOrgRoles(tx, { access: this.deps.access, tuples: this.deps.tuples, schema: this.S, acting, subject: `user:${principalId}`, roles, createdBy: s.platform ? null : s.actor.principalId, isActive: this.accountActive, actor: this.eventActor(s) });
      if (!added.length && !removed.length) return;
      await log({ action: 'member.roles_changed', resourceType: 'member', resourceId: principalId, data: { added, removed } });
      if (!(await this.deps.access.modelIn(tx)).permissionsForRoles(roles).has('members:admin')) await this.revokeConsentLinksOf({ tx, tenantId, log }, t.userId);
    });
    return this.member(s, id);
  }

  /** Freigabestufe einer Person (Mitglieds- oder Einladungs-ID) setzen; Regeln in rules.ts. */
  async setClearance(s: Scope, id: string, clearance: Level): Promise<Member> {
    const org = await this.org(s.alias);
    await this.locked(s, org, null, async ({ tx, log, acting }) => {
      const t = await this.target(tx, org, id);
      const principalId = await this.principalOf(tx, t.userId, t.user ? displayName(t.user) : t.invitation?.display_name ?? null, t.user?.email ?? t.invitation?.email ?? null);
      const from = await setClearance(tx, { access: this.deps.access, schema: this.S, acting, principalId, clearance });
      if (from !== clearance) await log({ action: 'member.clearance_changed', resourceType: 'member', resourceId: principalId, data: { from, to: clearance } });
    });
    return this.member(s, id);
  }

  // ---------------------------------------------------------------- Organisationen (nur platform-admin)
  async listOrganizations(correlationId?: string): Promise<Organization[]> {
    const [orgs, tenants] = await Promise.all([this.kc.listOrgs(), listTenants(this.deps.db)]);
    this.cacheOrgs(orgs);
    const byAlias = new Map(tenants.map(t => [t.alias, t]));
    for (const o of orgs) await this.syncName(o, byAlias.get(asciiLower(o.alias)) ?? null, correlationId);
    return orgs.map(o => this.orgOut(o, byAlias.get(asciiLower(o.alias)) ?? null)).sort((a, b) => a.alias.localeCompare(b.alias));
  }

  /** Name des Mandanten nachführen, wo die Plattform die Organisation ohnehin liest (Name in Keycloak massgeblich). */
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
      const a = this.actorOf(s);
      await createTenant(this.tenants, this.deps.db, this.deps.db, alias, name, id, { ...a, data: { ...a.data, domains } });
    } catch (e) {
      await this.kc.deleteOrg(id).catch(() => undefined);
      throw e;
    }
    this.orgs = null;
    return this.organization(alias, s.correlationId);
  }

  // ---------------------------------------------------------------- Konto ohne Organisation (Kap. 6.3)
  /**
   * Registrieren mit E-Mail (`SELF_SERVICE_SIGNUP`). Ohne Konto: Konto ohne Passwort, Pflichtaktionen «E-Mail bestätigen»
   * und «Passwort festlegen», E-Mail von Keycloak; danach meldet sich die Person an (ohne Organisation). Besteht schon ein
   * Konto oder gilt «Nur Entra» für die Domäne, geschieht nichts. Antwort und Dauer sind in allen Fällen gleich
   * (`KEYCLOAK_MGMT_INVITE_MIN_TIME`), damit niemand erfährt, ob eine Adresse ein Konto hat.
   */
  async signup(input: { email: string; firstName?: string; lastName?: string }, ctx: { source: Source; correlationId: string }): Promise<{ result: 'signup-received' }> {
    if (!this.deps.cfg.selfService.signup) throw selfServiceOff('Registrieren');
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw invalid('E-Mail-Adresse ungültig', [{ path: '/email', message: 'Gültige E-Mail-Adresse angeben' }]);
    const domain = email.slice(email.lastIndexOf('@') + 1);
    return this.padded(async () => {
      const who: Actor = { principal: null, source: ctx.source, correlationId: ctx.correlationId };
      const entra = (await this.deps.db.query<{ a: string | null }>('SELECT app.entra_login_alias($1) AS a', [domain])).rows[0]?.a;
      if (entra || await this.kc.findUserByEmail(email)) {
        await writePlatformAudit(this.deps.db, who, { action: 'account.signup_ignored', data: { domain, reason: entra ? 'entra-domain' : 'exists' } });
        return { result: 'signup-received' as const };
      }
      const userId = await this.createAccount(email, input, ['VERIFY_EMAIL', 'UPDATE_PASSWORD']);
      const emailSent = await this.kc.sendActionsEmail(userId, ['VERIFY_EMAIL', 'UPDATE_PASSWORD'], {
        lifespanSec: this.deps.cfg.mgmt.inviteLifespanSec, clientId: this.deps.cfg.oidc.bffClientId, redirectUri: this.deps.cfg.publicBaseUrl,
      });
      await writePlatformAudit(this.deps.db, who, { action: 'account.signup', data: { domain, emailSent } });
      return { result: 'signup-received' as const };
    });
  }

  /** Darf `alias` selbst erstellt werden? Reservierte Aliasse und das Produkt nur über die Plattform-Administration. */
  private ownAlias(raw: string): string {
    const alias = asciiLower(raw.trim());
    if (!ALIAS_PATTERN.test(alias)) throw invalid('Alias ungültig', [{ path: '/alias', message: 'Kleinbuchstaben, Ziffern, - und _ (beginnt mit Buchstabe oder Ziffer, höchstens 63 Zeichen)' }]);
    if ([...this.deps.cfg.selfService.reservedAliases, this.deps.model.product].includes(alias)) throw invalid('Alias reserviert', [{ path: '/alias', message: `«${alias}» ist reserviert. Bitte einen anderen wählen.` }]);
    return alias;
  }

  /**
   * Eigene Organisation erstellen (`SELF_SERVICE_ORGS`, Kontext «Konto»): bestätigte E-Mail, Alias frei und nicht
   * reserviert, höchstens `SELF_SERVICE_ORG_LIMIT` je Konto. Organisation in Keycloak ohne Domäne (Domänen setzt nur die
   * Plattform bzw. die Anmeldung über Entra ID mit verifizierten Domänen), die Person als Mitglied, dann in einer
   * Transaktion Mandant, Principal, Tupel `org-admin` an org, Freigabestufe 2 und Protokoll (Mandant und Plattform).
   * Scheitert etwas, wird die Organisation in Keycloak gelöscht und die Reservierung freigegeben. Danach erneuert die
   * Oberfläche das Token; die Organisation steht dann darin.
   */
  async createOwnOrganization(a: Account, input: { alias: string; name: string }, ctx: { source: Source; correlationId: string }): Promise<{ alias: string; name: string; tenantId: string }> {
    const ss = this.deps.cfg.selfService;
    if (!ss.orgs) throw selfServiceOff('Organisationen selbst erstellen');
    if (!a.emailVerified) throw new HttpError(403, 'E-Mail nicht bestätigt', 'Bestätige zuerst deine E-Mail-Adresse (Link in der E-Mail von der Registrierung), dann melde dich neu an.', {}, { reason: 'email-unverified' });
    const alias = this.ownAlias(input.alias);
    const name = input.name.trim();
    if (!name) throw invalid('Name fehlt', [{ path: '/name', message: 'Name angeben' }]);
    if ((await this.kc.listOrgs()).some(o => asciiLower(o.alias) === alias) || await findTenant(this.deps.db, alias)) throw conflict(`Der Alias «${alias}» ist bereits vergeben.`, { reason: 'alias-taken' });
    const reserved = (await this.deps.db.query<{ ok: boolean }>('SELECT app.account_reserve_org($1, $2) AS ok', [a.accountId, ss.orgLimit])).rows[0]?.ok;
    if (!reserved) throw conflict(`Du hast schon ${ss.orgLimit} Organisationen erstellt (Höchstzahl). Weitere richtet die Plattform-Administration ein.`, { reason: 'org-limit' });
    let orgId: string | null = null;
    try {
      try { orgId = await this.kc.createOrg({ alias, name, enabled: true, domains: [] }); }
      catch (e) { if (e instanceof KeycloakError && e.kcStatus === 409) throw conflict(`Der Alias «${alias}» oder der Name ist bereits vergeben.`, { reason: 'alias-taken' }); throw e; }
      await this.kc.addMember(orgId, a.subject);
      const kcOrgId = orgId;
      const tenantId = await withTx(this.deps.db, async tx => {
        const id = (await tx.query<{ id: string | null }>('SELECT app.resolve_tenant($1, $2, $3, true) AS id', [alias, kcOrgId, name])).rows[0]?.id;
        if (!id) throw conflict(`Der Alias «${alias}» ist bereits vergeben.`, { reason: 'alias-taken' });
        await setContext(tx, { tenantId: id });
        const principalId = await this.principalOf(tx, a.subject, a.name, a.email);
        await tx.query(`UPDATE ${this.S}.principal SET clearance = 2, last_seen_at = now() WHERE id = $1`, [principalId]);
        const actor: Actor = { principal: { kind: 'user', principalId, name: a.name, clientId: null }, source: ctx.source, correlationId: ctx.correlationId };
        await this.deps.audit.write(tx, actor, { action: 'tenant.provisioned', resourceType: 'tenant', resourceId: id, data: { alias, kcOrgId, selfService: true } });
        await this.deps.tuples.grant(tx, { subject: `user:${principalId}`, relation: ADMIN_ROLE, place: { type: 'org' }, createdBy: principalId }, actor);
        await writePlatformAudit(tx, { ...actor, principal: { kind: 'user', principalId: a.accountId, name: a.name, clientId: null } }, { action: 'organization.self_created', resourceType: 'tenant', resourceId: id, org: 'current', data: { alias, kcOrgId } });
        return id;
      });
      this.orgs = null;
      return { alias, name, tenantId };
    } catch (e) {
      if (orgId) await this.kc.deleteOrg(orgId).catch(() => undefined);
      await this.deps.db.query('SELECT app.account_release_org($1)', [a.accountId]).catch(() => undefined);
      throw e;
    }
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

  /**
   * Sperren/Entsperren in Keycloak (Organisation deaktiviert) und in der Plattform (Mandant gesperrt) zugleich, unter der
   * Sperre der Organisation. Scheitert der Mandant, wird Keycloak zurückgesetzt.
   */
  async setOrganizationStatus(s: Scope, alias: string, status: 'active' | 'suspended', reason = ''): Promise<Organization> {
    const org = await this.org(alias, true);
    const enabled = status === 'active';
    await this.locked({ ...s, alias: org.alias }, org, null, async () => {
      const cur = (await this.kc.getOrg(org.id)) ?? org;
      if (cur.enabled !== enabled) await this.kc.updateOrg({ ...cur, enabled });
      try {
        await setTenantStatus(this.tenants, this.deps.db, this.deps.db, org.alias, status, reason, this.actorOf(s));
      } catch (e) {
        if (cur.enabled !== enabled) await this.kc.updateOrg({ ...cur, enabled: cur.enabled }).catch(() => undefined);
        throw e;
      }
    });
    this.orgs = null;
    return this.organization(alias, s.correlationId);
  }
}
