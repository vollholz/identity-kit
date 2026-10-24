/**
 * Entscheidung nach Spezifikation Kap. 7.5 (Konzept 3.3): `can(p, perm, ref)` ist wahr, wenn (1 ∨ 2 ∨ 4) ∧ 3 ∧ 5 ∧ 6:
 *
 * 1. Rolle am Ort: nicht abgelaufenes Tupel eines Subjekts von p an ref oder einer Ressource der Kette darüber
 *    (`ResourceModel.chain`), dessen Relation eine Rolle mit perm ist.
 * 2. Zuständigkeit (Typen mit `scope`): ref gehört über eine Kante mit grants ≠ none zu einer Einheit aus units(p);
 *    `read` ergibt das Leserecht des Typs, `edit` Lese- und Schreibrecht. units(p) = Einheiten mit Tupel `member`
 *    eines Subjekts von p und transitiv alle darunter (Tiefe ≤ 16).
 *    Dazu Zuständigkeit über Personen aus Fachdaten (`edges.persons`, Kit 1.1): Die Person p steht mit grants ≠ none
 *    an ref (Assets: Attribut «Verantwortlich»); `read` bzw. `edit` wie oben. Nur Personen, nie Gruppen oder Clients.
 * 3. Klassifizierung (Typen mit `classified`): classification(ref) ≤ clearance(p).
 * 4. Besitz (Typen mit `owner`): Tupel `owner` eines Subjekts von p an ref.
 * 5. Scope (nur scopeBound): perm ∈ permissionsForScopes(p.scopes), für jeden Weg.
 * 6. Client freigegeben: prüft der Resolver (`clientGranted`).
 *
 * Keine Verbote, keine Ausnahme für org-admin: an der Klassifizierung scheitert auch diese Rolle (Break-Glass).
 *
 * Tupel, Freigabestufen und Zustand der Kette werden je Mandant zwischengespeichert, gültig solange
 * `tenant.acl_version` (Trigger auf Tupeln und Freigabestufen) und `ResourceModel.version` gleich sind – Änderungen
 * wirken sofort auf allen Instanzen. Klassifizierung und Zuständigkeit hängen an Fachdaten und werden je Anfrage gelesen
 * (`facts`).
 */
import { createHash } from 'node:crypto';
import { schemaName, withTenant, type Db, type Tx } from './db.ts';
import { forbidden, HttpError } from './errors.ts';
import { MEMBER, ORG, OWNER, type Level, type Model, type TypeInfo } from './model.ts';
import type { Principal } from './principal.ts';
import { flatChain, refKey, type ResourceModel, type ResourceRef } from './resources.ts';

/** Ein Tupel (Freigabe), Spalten wie `authz_tuple`. */
export interface Tuple {
  id: string; subject: string; relation: string; object_type: string; object_id: string | null;
  expires_at: Date | null; created_at: Date; created_by: string | null;
}
export const TUPLE_COLS = 'id, subject, relation, object_type, object_id, expires_at, created_at, created_by';

/** Gespeicherte Freigabestufe eines Principals mit Break-Glass. */
export interface ClearanceRow { clearance: Level; boost: Level | null; until: Date | null }

/** Stand eines Mandanten: Tupel, Freigabestufen (nur ≠ 0 oder mit Break-Glass), Zustand der Kette. */
export interface TenantAccess<S = unknown> {
  version: string;
  tuples: readonly Tuple[];
  /** Tupel je Ort (`<type>:<id>`). */
  byPlace: ReadonlyMap<string, Tuple[]>;
  clearances: ReadonlyMap<string, ClearanceRow>;
  state: S;
}

/** Wer entscheidet wird: Principal oder ein anderes Subjekt («Warum?» für andere). */
export type Who = Pick<Principal, 'kind' | 'principalId' | 'subjects' | 'scopes'> & { scopeBound?: boolean };

/** Zugehörigkeit einer Ressource zu einer Einheit (`edges.belongs`). */
export interface Belong { id: string; unit_id: string; grants: 'read' | 'edit' | 'none'; label: string }

/** Zuständige Person einer Ressource aus Fachdaten (`edges.persons`). */
export interface PersonEdge { id: string; principal_id: string; grants: 'read' | 'edit' | 'none'; label: string }

/** Fachdaten je Anfrage: Klassifizierung, Zugehörigkeit und zuständige Personen je Ressource, units(p). */
export interface Facts {
  classification: Map<string, Level>;
  belongs: Map<string, Belong[]>;
  /** Zuständige Personen je Ressource (`<type>:<id>`). */
  persons: Map<string, PersonEdge[]>;
  /** units(p); null, wenn nicht gelesen. */
  units: Set<string> | null;
}
export const noFacts = (): Facts => ({ classification: new Map(), belongs: new Map(), persons: new Map(), units: null });

/** Ein Weg, der ein Recht ergibt (Regeln 1, 2, 4); `data`: zuständig als Person über Fachdaten (Regel 2). */
export interface Reason {
  via: 'direct' | 'inherited' | 'scope' | 'owner' | 'data';
  relation: string; place: ResourceRef; tupleId: string | null; matched: string;
  unit?: { ref: ResourceRef; relation: string; grants: 'read' | 'edit' };
  /** Nur bei `data`: Name der Fachbeziehung (z. B. «Verantwortlich») und ihre Wirkung. */
  data?: { relation: string; grants: 'read' | 'edit' };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Tiefe der Zuständigkeit über untergeordnete Einheiten. */
export const UNIT_DEPTH = 16;

/** Subjekte eines Principals (Kap. 7.5): Person `user:`, Gruppen aus Entra, `org:members`; Client nur `client:`. */
export function subjectsOf(p: Pick<Principal, 'kind' | 'principalId' | 'groups'>): string[] {
  if (p.kind === 'client') return [`client:${p.principalId}`];
  return [`user:${p.principalId}`, ...p.groups.filter(g => UUID.test(g)).map(g => `group:${g}`), 'org:members'];
}

/** Tupel zählt (nicht abgelaufen). */
export const live = (t: Pick<Tuple, 'expires_at'>, now = Date.now()) => !t.expires_at || t.expires_at.getTime() > now;

/** PostgreSQL-Array-Literal für Einstellungen (`{"a","b"}`). */
export const pgArray = (v: Iterable<string>) => `{${[...v].map(x => `"${x.replace(/["\\]/g, m => `\\${m}`)}"`).join(',')}}`;

/** Volle Sicht für interne Prüfungen (Kap. 7.6): was darin gelesen wird, geht nie an die Person zurück. */
export function fullView(model: Model): Record<string, string> {
  const rel: Record<string, string[]> = {};
  for (const perm of model.permissions) rel[perm] = model.allRelations();
  return { 'app.read_all': 'on', 'app.write_all': 'on', 'app.clearance': '2', 'app.org_permissions': pgArray(model.permissions), 'app.permission_relations': JSON.stringify(rel) };
}

export class AccessService<P extends string = string, S = unknown> {
  private readonly cache = new Map<string, TenantAccess<S>>();
  private readonly db: Db;
  readonly schema: string;
  readonly model: Model<P>;
  readonly resources: ResourceModel<S> | null;
  /** Typ der Zuständigkeit (mit `scope`), sonst null. */
  readonly scopeType: TypeInfo<P> | null;
  /** Alle Typen mit Zuständigkeit (`scope`). */
  readonly scopeTypes: TypeInfo<P>[];

  constructor(db: Db, o: { model: Model<P>; schema: string; resources?: ResourceModel<S> | null }) {
    this.db = db; this.model = o.model; this.schema = schemaName(o.schema); this.resources = o.resources ?? null;
    this.scopeTypes = [...o.model.types.values()].filter(t => t.scope);
    this.scopeType = this.scopeTypes[0] ?? null;
  }

  /** Transaktion mit voller Sicht im Mandanten. */
  fullTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, settings: fullView(this.model) }, fn);
  }

  /** 403 für ein fehlendes Recht: «Dir fehlt das Recht «Objekte ändern» (object:write).» */
  missingPermission(perm: string, suffix = '') {
    return forbidden(`Dir fehlt das Recht ${this.model.permissionText(perm)}${suffix}.`, { reason: 'permission', permission: perm });
  }

  /** 403 Klassifizierung: «Die Vertraulichkeit «streng vertraulich» übersteigt deine Freigabestufe.» */
  clearanceExceeded(level: Level, clearance: Level) {
    return forbidden(`Die Vertraulichkeit «${this.model.classifications[level]}» übersteigt deine Freigabestufe.`, { reason: 'clearance', classification: level, clearance });
  }

  /** Lädt Tupel, Freigabestufen und Zustand der Kette (zwischengespeichert bis zur nächsten Änderung). */
  async load(tenantId: string): Promise<TenantAccess<S>> {
    const r = this.resources;
    return this.fullTx(tenantId, async tx => {
      const acl = (await tx.query<{ v: string }>(`SELECT acl_version::text AS v FROM ${this.schema}.tenant WHERE id = $1`, [tenantId])).rows[0]?.v ?? '0';
      const v = `${acl}:${(await r?.version?.(tx)) ?? ''}`;
      const hit = this.cache.get(tenantId);
      if (hit && hit.version === v) return hit;
      const tuples = (await tx.query<Tuple>(`SELECT ${TUPLE_COLS} FROM ${this.schema}.authz_tuple ORDER BY created_at, id`)).rows;
      const byPlace = new Map<string, Tuple[]>();
      for (const t of tuples) {
        const k = refKey({ type: t.object_type, id: t.object_id });
        const list = byPlace.get(k);
        if (list) list.push(t); else byPlace.set(k, [t]);
      }
      const clearances = new Map((await tx.query<{ id: string; clearance: Level; boost: Level | null; until: Date | null }>(
        `SELECT id, clearance, clearance_boost AS boost, clearance_until AS until FROM ${this.schema}.principal WHERE clearance > 0 OR clearance_boost IS NOT NULL`)).rows
        .map(x => [x.id, { clearance: x.clearance, boost: x.boost, until: x.until }]));
      const state = (r?.load ? await r.load(tx) : null) as S;
      const loaded: TenantAccess<S> = { version: v, tuples, byPlace, clearances, state };
      this.cache.set(tenantId, loaded);
      return loaded;
    });
  }

  invalidate(tenantId: string) { this.cache.delete(tenantId); }

  // ---------------------------------------------------------------- Bausteine
  /** Gespeicherte Freigabestufe (ohne Break-Glass). */
  storedClearance(acl: TenantAccess<S>, principalId: string | null): Level {
    return (principalId && acl.clearances.get(principalId)?.clearance) || 0;
  }

  /** Ende eines aktiven Break-Glass oder null. */
  breakGlassUntil(acl: TenantAccess<S>, principalId: string | null, now = Date.now()): Date | null {
    const c = principalId ? acl.clearances.get(principalId) : undefined;
    return c?.until && c.until.getTime() > now ? c.until : null;
  }

  /** clearance(p) = max(clearance, boost), solange clearance_until > now(), sonst clearance. Clients ohne Break-Glass. */
  clearanceOf(who: Pick<Who, 'kind' | 'principalId'>, acl: TenantAccess<S>, now = Date.now()): Level {
    const c = who.principalId ? acl.clearances.get(who.principalId) : undefined;
    if (!c) return 0;
    if (who.kind === 'user' && c.boost !== null && c.until && c.until.getTime() > now) return Math.max(c.clearance, c.boost) as Level;
    return c.clearance;
  }

  /** Regel 5: deckt ein Scope das Recht? Für Personen ausserhalb von MCP immer. */
  scopeAllows(who: Pick<Who, 'kind' | 'scopes' | 'scopeBound'>, perm: string): boolean {
    return (who.kind !== 'client' && !who.scopeBound) || this.model.permissionsForScopes(who.scopes).has(perm as P);
  }

  /** Kette der Ressource von oben nach unten (ResourceModel der App, sonst direkt unter der Organisation). */
  chain(acl: TenantAccess<S>, ref: ResourceRef, hint?: string | null): ResourceRef[] {
    if (ref.type === ORG) return [{ type: ORG }];
    return this.resources ? this.resources.chain(acl.state, ref, hint) : flatChain(ref);
  }

  /** Tupel an einem Ort. */
  at(acl: TenantAccess<S>, ref: ResourceRef): Tuple[] {
    return acl.byPlace.get(refKey({ type: ref.type, id: ref.type === ORG ? null : ref.id ?? null })) ?? [];
  }

  /** Rechte einer Relation an einem Typ (Rolle, owner; member: keine). */
  private grants(relation: string, type: string, perm: string): boolean {
    if (relation === MEMBER) return false;
    if (relation === OWNER) return !!this.model.types.get(type)?.owner && this.model.permissionsOf(OWNER, type).has(perm as P);
    return this.model.roles.get(relation)?.permissions.includes(perm as P) ?? false;
  }

  /** Wege über Tupel (Regeln 1 und 4), ohne Scope. */
  tupleReasons(who: Pick<Who, 'subjects'>, acl: TenantAccess<S>, perm: string, ref: ResourceRef, hint?: string | null, now = Date.now()): Reason[] {
    const subjects = new Set(who.subjects);
    const chain = this.chain(acl, ref, hint);
    const out: Reason[] = [];
    // Von unten nach oben: direkt zuerst, dann geerbt
    for (let i = chain.length - 1; i >= 0; i--) {
      const step = chain[i]!, here = i === chain.length - 1;
      for (const t of this.at(acl, step)) {
        if (!subjects.has(t.subject) || !live(t, now)) continue;
        if (t.relation === OWNER) {
          if (here && this.grants(OWNER, step.type, perm)) out.push({ via: 'owner', relation: OWNER, place: { type: step.type, id: step.id ?? null }, tupleId: t.id, matched: t.subject });
        } else if (this.grants(t.relation, step.type, perm)) {
          out.push({ via: here ? 'direct' : 'inherited', relation: t.relation, place: { type: step.type, id: step.id ?? null }, tupleId: t.id, matched: t.subject });
        }
      }
    }
    return out;
  }

  /** Regel 2 für eine Ressource mit gelesenen Fachdaten. */
  scopeReasons(acl: TenantAccess<S>, perm: string, ref: ResourceRef, facts: Facts): Reason[] {
    const t = this.model.types.get(ref.type);
    const e = this.resources?.edges;
    if (!t?.scope || !e || !ref.id || !facts.units) return [];
    const wantsEdit = perm === t.write && perm !== t.read;
    if (perm !== t.read && perm !== t.write) return [];
    const out: Reason[] = [];
    for (const b of facts.belongs.get(refKey(ref)) ?? []) {
      if (b.grants === 'none' || (wantsEdit && b.grants !== 'edit')) continue;
      if (!facts.units.has(b.unit_id)) continue;
      out.push({ via: 'scope', relation: MEMBER, place: { type: e.unit, id: b.unit_id }, tupleId: null, matched: '', unit: { ref: { type: e.unit, id: b.unit_id }, relation: b.label, grants: b.grants } });
    }
    void acl;
    return out;
  }

  /** Regel 2 über Personen aus Fachdaten (`edges.persons`): p selbst steht mit passender Wirkung an ref. */
  personReasons(who: Pick<Who, 'kind' | 'principalId'>, perm: string, ref: ResourceRef, facts: Facts): Reason[] {
    const t = this.model.types.get(ref.type);
    if (!t?.scope || !this.resources?.edges?.persons || !ref.id || who.kind !== 'user' || !who.principalId) return [];
    if (perm !== t.read && perm !== t.write) return [];
    const wantsEdit = perm === t.write && perm !== t.read;
    const out: Reason[] = [];
    for (const x of facts.persons.get(refKey(ref)) ?? []) {
      if (x.principal_id !== who.principalId || x.grants === 'none' || (wantsEdit && x.grants !== 'edit')) continue;
      out.push({ via: 'data', relation: x.label, place: { type: ref.type, id: ref.id }, tupleId: null, matched: `user:${x.principal_id}`, data: { relation: x.label, grants: x.grants } });
    }
    return out;
  }

  /**
   * Entscheidung mit gelesenen Fachdaten. Ohne Fakten zur Klassifizierung gilt Regel 3 als erfüllt (Ressourcen aus der
   * Lesesicht der Datenbank sind es), ohne units(p) ergibt Regel 2 nichts.
   */
  decide(who: Who, acl: TenantAccess<S>, perm: string, ref: ResourceRef = { type: ORG }, hint?: string | null, facts: Facts = noFacts()): boolean {
    if (!this.model.isPermission(perm)) return false;
    if (!this.scopeAllows(who, perm)) return false;
    const t = this.model.types.get(ref.type);
    if (t?.classified && ref.id) {
      const c = facts.classification.get(refKey(ref));
      if (c !== undefined && c > this.clearanceOf(who, acl)) return false;
    }
    return this.tupleReasons(who, acl, perm, ref, hint).length > 0 || this.scopeReasons(acl, perm, ref, facts).length > 0
      || this.personReasons(who, perm, ref, facts).length > 0;
  }

  /** units(p): Einheiten mit Tupel `member` eines Subjekts, transitiv alle darunter (Tiefe ≤ 16, Kreise erlaubt). */
  async units(tx: Tx, who: Pick<Who, 'subjects'>, acl: TenantAccess<S>): Promise<Set<string>> {
    const e = this.resources?.edges;
    const out = new Set<string>();
    if (!e) return out;
    const subjects = new Set(who.subjects);
    let frontier = acl.tuples.filter(t => t.relation === MEMBER && t.object_type === e.unit && t.object_id && subjects.has(t.subject) && live(t)).map(t => t.object_id!);
    for (const u of frontier) out.add(u);
    for (let depth = 0; depth < UNIT_DEPTH && frontier.length; depth++) {
      const next = (await tx.query<{ id: string }>(e.children, [frontier])).rows.map(r => r.id).filter(id => !out.has(id));
      for (const u of next) out.add(u);
      frontier = [...new Set(next)];
    }
    return out;
  }

  /** Fachdaten für Ressourcen (volle Sicht): Klassifizierung, Zugehörigkeit, zuständige Personen und units(p), soweit die Typen sie brauchen. */
  async facts(who: Who, acl: TenantAccess<S>, refs: ResourceRef[], tenantId: string, o: { units?: Set<string> } = {}): Promise<Facts> {
    const out = noFacts();
    const r = this.resources;
    const classified = refs.filter(x => x.id && this.model.types.get(x.type)?.classified);
    const scoped = refs.filter(x => x.id && this.model.types.get(x.type)?.scope);
    if (!r || (!classified.length && !scoped.length)) return out;
    await this.fullTx(tenantId, async tx => {
      if (classified.length) {
        if (!r.classification) throw new Error('ResourceModel.classification fehlt (Pflicht bei Typen mit classified)');
        for (const [k, v] of await r.classification(tx, classified)) out.classification.set(k, v);
      }
      if (scoped.length && r.edges) {
        out.units = o.units ?? await this.units(tx, who, acl);
        const ids = scoped.map(x => x.id!);
        for (const b of (await tx.query<Belong>(r.edges.belongs, [ids])).rows) {
          for (const x of scoped.filter(s => s.id === b.id)) {
            const k = refKey(x), list = out.belongs.get(k);
            if (list) list.push(b); else out.belongs.set(k, [b]);
          }
        }
      }
      if (scoped.length && r.edges?.persons) {
        const ids = scoped.map(x => x.id!);
        for (const x of (await tx.query<PersonEdge>(r.edges.persons, [ids])).rows) {
          for (const s of scoped.filter(y => y.id === x.id)) {
            const k = refKey(s), list = out.persons.get(k);
            if (list) list.push(x); else out.persons.set(k, [x]);
          }
        }
      }
    });
    return out;
  }

  /**
   * Wirkungen, mit denen p als Person über Fachdaten irgendwo zuständig ist (`edges.personGrants`, volle Sicht), für
   * «Recht irgendwo». Ohne `personGrants` zählt dieser Weg dort nicht.
   */
  async personGrants(who: Pick<Who, 'kind' | 'principalId'>, tenantId: string): Promise<Set<'read' | 'edit'>> {
    const sql = this.resources?.edges?.personGrants;
    if (!sql || !this.resources?.edges?.persons || who.kind !== 'user' || !who.principalId || !this.scopeTypes.length) return new Set();
    const rows = await this.fullTx(tenantId, async tx => (await tx.query<{ grants: string }>(sql, [who.principalId])).rows);
    return new Set(rows.map(r => r.grants).filter((g): g is 'read' | 'edit' => g === 'read' || g === 'edit'));
  }

  /** Hinweis zur Kette (Assets: Typ eines Objekts), falls die App ihn nicht mitgibt. */
  async hint(tenantId: string, ref: ResourceRef): Promise<string | null> {
    const h = this.resources?.hints;
    if (!h || !ref.id) return null;
    return this.fullTx(tenantId, async tx => (await h(tx, [ref])).get(refKey(ref)) ?? null);
  }

  // ---------------------------------------------------------------- API der App (Signaturen unverändert)
  async can(p: Principal, perm: P, ref?: ResourceRef, hint?: string | null): Promise<boolean> {
    return (await this.check(p, perm, ref, hint)).allowed;
  }

  /** Entscheidung mit Grund des Scheiterns (für 403-Texte). */
  async check(p: Principal, perm: string, ref: ResourceRef = { type: ORG }, hint?: string | null): Promise<{ allowed: boolean; blocked: 'clearance' | null; classification: Level | null }> {
    const acl = await this.load(p.tenantId);
    const h = hint === undefined && ref.type !== ORG ? await this.hint(p.tenantId, ref) : hint;
    const facts = await this.facts(p, acl, [ref], p.tenantId);
    if (this.decide(p, acl, perm, ref, h, facts)) return { allowed: true, blocked: null, classification: null };
    const c = facts.classification.get(refKey(ref)) ?? null;
    const unclassified = { ...facts, classification: new Map() };
    const blocked = c !== null && this.decide(p, acl, perm, ref, h, unclassified) ? 'clearance' as const : null;
    return { allowed: false, blocked, classification: c };
  }

  async require(p: Principal, perm: P, ref?: ResourceRef, hint?: string | null): Promise<void> {
    const r = await this.check(p, perm, ref, hint);
    if (r.allowed) return;
    if (r.blocked === 'clearance') throw this.clearanceExceeded(r.classification!, this.clearanceOf(p, await this.load(p.tenantId)));
    throw this.missingPermission(perm, ref && ref.type !== ORG ? ` für ${ref.type}${ref.id ? ` ${ref.id}` : ''}` : '');
  }

  /** Freigabestufe mindestens `level`, sonst 403 mit Grund `clearance` (A14). */
  async requireClearance(p: Principal, level: Level): Promise<void> {
    const c = this.clearanceOf(p, await this.load(p.tenantId));
    if (c < level) throw this.clearanceExceeded(level, c);
  }

  /**
   * Recht irgendwo (Regeln 1, 2 oder 4 an mindestens einem Ort) ∧ Scope. `persons`: Wirkungen der Zuständigkeit über
   * Personen aus Fachdaten (`personGrants`), sonst zählt dieser Weg nicht.
   */
  somewhere(who: Who, acl: TenantAccess<S>, perm: string, persons: ReadonlySet<'read' | 'edit'> = new Set()): boolean {
    if (!this.model.isPermission(perm) || !this.scopeAllows(who, perm)) return false;
    if (persons.size && this.scopeTypes.some(st => perm === st.read || (perm === st.write && persons.has('edit')))) return true;
    const subjects = new Set(who.subjects), now = Date.now();
    for (const t of acl.tuples) {
      if (!subjects.has(t.subject) || !live(t, now)) continue;
      if (t.relation === MEMBER) {
        // Zuständigkeit: irgendein Typ mit scope, dessen Lese- oder Schreibrecht perm ist
        if (this.resources?.edges?.unit === t.object_type && this.scopeTypes.some(st => perm === st.read || perm === st.write)) return true;
      } else if (this.grants(t.relation, t.object_type, perm)) return true;
    }
    return false;
  }

  async canSomewhere(p: Principal, perm: P): Promise<boolean> {
    const acl = await this.load(p.tenantId);
    return this.somewhere(p, acl, perm) || this.somewhere(p, acl, perm, await this.personGrants(p, p.tenantId));
  }

  async requireSomewhere(p: Principal, perm: P): Promise<void> {
    if (!(await this.canSomewhere(p, perm))) throw this.missingPermission(perm);
  }

  /** Rollen an org (nicht abgelaufene Tupel eines Subjekts), in Reihenfolge des Modells. */
  rolesAtOrg(who: Pick<Who, 'subjects'>, acl: TenantAccess<S>): string[] {
    const subjects = new Set(who.subjects), now = Date.now();
    const have = new Set(this.at(acl, { type: ORG }).filter(t => subjects.has(t.subject) && live(t, now)).map(t => t.relation));
    return [...this.model.roles.keys()].filter(r => have.has(r));
  }

  /** Rechte an org (∧ Scope), in Reihenfolge des Modells. */
  orgPermissions(who: Who, acl: TenantAccess<S>): P[] {
    return this.model.permissions.filter(x => this.decide(who, acl, x));
  }

  /** Rechte, die an mindestens einem Ort gelten (Obermenge der Rechte an org); `persons` wie bei `somewhere`. */
  somewherePermissions(who: Who, acl: TenantAccess<S>, persons?: ReadonlySet<'read' | 'edit'>): P[] {
    return this.model.permissions.filter(x => this.decide(who, acl, x) || this.somewhere(who, acl, x, persons));
  }

  async effective(p: Principal): Promise<P[]> { return this.orgPermissions(p, await this.load(p.tenantId)); }
  async granted(p: Principal): Promise<P[]> { return this.somewherePermissions(p, await this.load(p.tenantId), await this.personGrants(p, p.tenantId)); }

  /** Regel 6: Client mit mindestens einem nicht abgelaufenen Tupel `client:<id> <rolle> org`. */
  clientGranted(acl: TenantAccess<S>, principalId: string): boolean {
    const s = `client:${principalId}`, now = Date.now();
    return this.at(acl, { type: ORG }).some(t => t.subject === s && this.model.roles.has(t.relation as never) && live(t, now));
  }

  /**
   * Kurzer Fingerabdruck des Zugriffsstands für ETags von Antworten mit `can` (Kap. 7.9): ändert sich ein Tupel, eine
   * Freigabestufe, der Zustand der Kette oder das Token, gilt eine zwischengespeicherte Antwort nicht mehr. Tupel mit
   * Ablauf ändern das Ergebnis ohne neue Version: die noch gültigen Tupel der eigenen Subjekte zählen mit.
   */
  async accessTag(p: Principal): Promise<string> {
    const acl = await this.load(p.tenantId);
    const until = this.breakGlassUntil(acl, p.principalId)?.toISOString() ?? '';
    const subjects = new Set(p.subjects), now = Date.now();
    const timed = acl.tuples.filter(t => t.expires_at && subjects.has(t.subject) && live(t, now)).map(t => t.id).sort().join(',');
    const parts = [acl.version, p.kind, p.principalId, [...p.subjects].sort().join(','), p.scopeBound ? 's' : '', [...p.scopes].sort().join(','), until, timed];
    return createHash('sha256').update(parts.join('|')).digest('base64url').slice(0, 10);
  }

  // ---------------------------------------------------------------- Lesesicht (Kap. 7.6)
  /** Relationen, die ein Recht enthalten (Rollen, owner wo zulässig, nie member). */
  relationsWith(perm: string): string[] {
    const out: string[] = this.model.rolesWith(perm);
    if ([...this.model.types.values()].some(t => t.owner && this.model.permissionsOf(OWNER, t.key).has(perm as P))) out.push(OWNER);
    return out;
  }

  /** Einstellungen der Lesesicht für eine Anfrage (units(p) über `edges` in eigener Transaktion mit voller Sicht). */
  async readView(tenantId: string, who: Who, acl: TenantAccess<S>): Promise<Record<string, string>> {
    const m = this.model, leaf = m.leaf;
    const orgPerms = this.orgPermissions(who, acl);
    const allowed = (perm: string | null) => !!perm && this.scopeAllows(who, perm);
    const rel: Record<string, string[]> = {};
    for (const perm of m.permissions) if (allowed(perm)) rel[perm] = this.relationsWith(perm);
    const out: Record<string, string> = {
      'app.subjects': pgArray(who.subjects),
      'app.clearance': String(this.clearanceOf(who, acl)),
      'app.org_permissions': pgArray(orgPerms),
      'app.permission_relations': JSON.stringify(rel),
    };
    if (leaf) {
      const readAll = !!leaf.read && orgPerms.includes(leaf.read), writeAll = !!leaf.write && orgPerms.includes(leaf.write);
      out['app.read_all'] = readAll ? 'on' : 'off';
      out['app.write_all'] = writeAll ? 'on' : 'off';
      out['app.read_relations'] = pgArray(allowed(leaf.read) ? this.relationsWith(leaf.read!) : []);
      out['app.write_relations'] = pgArray(allowed(leaf.write) ? this.relationsWith(leaf.write!) : []);
      if (leaf.parent && leaf.parent !== ORG) {
        out['app.read_types'] = pgArray(readAll || !allowed(leaf.read) ? [] : this.placesWith(who, acl, leaf.parent, leaf.read!));
        out['app.write_types'] = pgArray(writeAll || !allowed(leaf.write) ? [] : this.placesWith(who, acl, leaf.parent, leaf.write!));
      }
    }
    const st = this.scopeType;
    if (st && this.resources?.edges) {
      const units = allowed(st.read) || allowed(st.write) ? [...await this.fullTx(tenantId, tx => this.units(tx, who, acl))] : [];
      out['app.read_units'] = pgArray(allowed(st.read) ? units : []);
      out['app.write_units'] = pgArray(allowed(st.write) ? units : []);
    }
    if (st && this.resources?.edges?.persons) {
      // Zuständigkeit über Personen aus Fachdaten: nur die Person selbst, leer (NULL) bei Clients oder ohne Scope
      const me = who.kind === 'user' && who.principalId ? who.principalId : '';
      out['app.read_person'] = allowed(st.read) ? me : '';
      out['app.write_person'] = allowed(st.write) ? me : '';
    }
    return out;
  }

  /**
   * IDs der Ressourcen vom Typ `type`, an denen `perm` über Regel 1 gilt (Rolle dort, an einem Vorfahren oder einer
   * Ressource der Kette darüber). Kandidaten: alle IDs aus `ResourceModel.ids` und die Orte von Tupeln dieses Typs.
   */
  placesWith(who: Who, acl: TenantAccess<S>, type: string, perm: string): string[] {
    const candidates = new Set<string>(this.resources?.ids?.(acl.state, type) ?? []);
    for (const t of acl.tuples) if (t.object_type === type && t.object_id) candidates.add(t.object_id);
    return [...candidates].filter(id => this.tupleReasons(who, acl, perm, { type, id }).length > 0).sort();
  }

  /** Fehlt `ResourceModel.ids`, obwohl `app.read_types()` es braucht? (Prüfung beim Start) */
  readTypesProblem(): string | null {
    const leaf = this.model.leaf;
    if (!leaf?.parent || leaf.parent === ORG || this.resources?.ids) return null;
    const parent = this.model.types.get(leaf.parent);
    if (parent && !parent.self && parent.parent === ORG) return null;
    return `ResourceModel.ids fehlt: Typ «${leaf.parent}» über dem Blatt «${leaf.key}» hat ${parent?.self ? 'self' : `den Elterntyp «${parent?.parent}»`}; ohne ids lässt sich app.read_types() für Rollen an Vorfahren nicht berechnen`;
  }
}

/** Fähigkeiten eines Principals an einer Ressource nach dem Modell (`capabilities` je Typ). */
export function capabilities<P extends string, S>(access: AccessService<P, S>, p: Principal, acl: TenantAccess<S>, kind: string, id: string, hint?: string | null, facts?: Facts): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const caps = (access.model.capabilities as Record<string, Record<string, string> | undefined>)[kind] ?? {};
  for (const [cap, perm] of Object.entries(caps)) out[cap] = access.decide(p, acl, perm, { type: kind, id }, hint, facts);
  return out;
}

/**
 * Lädt Tupel einmal und liefert eine Funktion für viele Ressourcen (Listen). `refs`: Ressourcen, deren Fachdaten
 * (Klassifizierung, Zuständigkeit) vorab gelesen werden; ohne zählt die Zuständigkeit nicht.
 */
export async function capabilitiesFor<P extends string, S>(access: AccessService<P, S>, p: Principal, refs: ResourceRef[] = []) {
  const acl = await access.load(p.tenantId);
  const facts = refs.length ? await access.facts(p, acl, refs, p.tenantId) : noFacts();
  return (kind: string, id: string, hint?: string | null) => capabilities(access, p, acl, kind, id, hint, facts);
}

/** JSON-Schema des Felds `can` für einen Typ (für OpenAPI). */
export function canSchema(model: Model, kind: string) {
  const caps = Object.entries((model.capabilities as Record<string, Record<string, string> | undefined>)[kind] ?? {});
  return {
    type: 'object', description: 'Fähigkeiten des Aufrufers an dieser Ressource (Freigaben, Vertraulichkeit, Scopes)', additionalProperties: false,
    properties: Object.fromEntries(caps.map(([cap, perm]) => [cap, { type: 'boolean', description: `Recht «${perm}» an dieser Ressource` }])),
    required: caps.map(([cap]) => cap),
  };
}

/** Fehler für «Recht fehlt» mit Status (für Module ohne AccessService). */
export const accessDenied = (detail: string, reason: string, extra: Record<string, unknown> = {}) => new HttpError(403, 'Keine Berechtigung', detail, {}, { reason, ...extra });
