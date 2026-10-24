/**
 * «Wer hat Zugriff?» und «Warum?» (Spezifikation Kap. 7.1, 9.5; A13): Auskunft aus denselben Regeln wie die
 * Entscheidung (access.ts). Dazu, wer an einem Ort Rollen vergeben darf («niemand gibt mehr, als er hat», 7.5).
 *
 * - `whoHasAccess`: direkte Tupel am Ort, dann geerbte (Rollen mit dem Leserecht des Typs) von unten nach oben, dann
 *   Zuständigkeit (Mitglieder der Einheiten, zu denen die Ressource gehört, auch über übergeordnete Einheiten), dann
 *   zuständige Personen aus Fachdaten (`edges.persons`, Quelle `data`, nicht entfernbar).
 * - `explain`: alle Wege (Regeln 1, 2, 4) und was trotz Weg verhindert (Klassifizierung, Scope).
 * Namen von Orten liefert die Antwort nicht; die Oberfläche löst sie selbst auf.
 */
import { live, noFacts, type AccessService, type Facts, type Reason, type TenantAccess, type Tuple, type Who } from './access.ts';
import type { Tx } from './db.ts';
import { HttpError, invalid, notFound } from './errors.ts';
import { ADMIN_ROLE, MEMBER, ORG, OWNER, type Level } from './model.ts';
import type { Principal } from './principal.ts';
import { refKey, type ResourceRef } from './resources.ts';
import { SUBJECT_PATTERN } from './tuples.ts';

export interface AccessSubjectOut { ref: string; kind: 'user' | 'client' | 'group' | 'members'; name: string; scopes?: string[] | null }
export interface AccessEntry {
  id: string | null;
  subject: AccessSubjectOut;
  relation: string;
  place: { type: string; id: string | null };
  via: 'direct' | 'inherited' | 'scope' | 'data';
  unit?: { ref: { type: string; id: string | null }; relation: string; grants: 'read' | 'edit' };
  /** Nur bei `data`: Fachbeziehung an der Ressource selbst (z. B. «Verantwortlich») und ihre Wirkung. */
  data?: { relation: string; grants: 'read' | 'edit' };
  expiresAt: string | null; createdAt: string | null; createdBy: string | null;
  removable: boolean;
}
export interface AccessList { resource: { type: string; id: string | null }; classification: Level | null; items: AccessEntry[]; grantable: string[] }
export interface ExplainOut {
  allowed: boolean;
  permission: string;
  subject: { ref: string; name: string };
  reasons: (Omit<Reason, 'place'> & { place: { type: string; id: string | null }; label: string })[];
  blocked: { reason: 'clearance'; classification: Level; clearance: Level } | { reason: 'scope'; scope: string | null } | null;
}

/** Anzeigenamen von Gruppen aus Entra (Graph-Zwischenspeicher je Mandant); ohne: Objekt-ID. */
export type GroupNames = (tenantId: string, ids: string[]) => Promise<Map<string, string>>;

export const MEMBERS_NAME = 'Alle Mitglieder';
const placeOut = (r: ResourceRef) => ({ type: r.type, id: r.type === ORG ? null : r.id ?? null });
const iso = (d: Date | null) => (d ? d.toISOString() : null);
type Item = { t: Tuple; via: AccessEntry['via']; removable: boolean; unit?: AccessEntry['unit']; data?: AccessEntry['data'] };
const kindOf = (subject: string): AccessSubjectOut['kind'] => (subject === 'org:members' ? 'members' : subject.slice(0, subject.indexOf(':')) as 'user' | 'client' | 'group');

/** Ressource prüfen: Typ bekannt, `id` leer genau bei `org`, Ressource besteht (volle Sicht); sonst 404 bzw. 422. */
export async function checkRef(access: AccessService, tenantId: string, ref: ResourceRef): Promise<ResourceRef> {
  if (!access.model.types.has(ref.type as never)) throw invalid('Typ unbekannt', [{ path: '/type', message: `«${ref.type}» ist kein Typ des Modells` }]);
  if (ref.type === ORG) return { type: ORG, id: null };
  if (!ref.id) throw invalid('id fehlt', [{ path: '/id', message: 'id angeben (leer nur bei org)' }]);
  const r = access.resources;
  if (!r || !(await access.fullTx(tenantId, tx => r.exists(tx, ref)))) throw notFound('Ressource');
  return { type: ref.type, id: ref.id };
}

export class AccessInfo {
  readonly access: AccessService<any, any>;
  private readonly groupNames: GroupNames | null;
  private readonly schema: string;

  constructor(access: AccessService<any, any>, o: { groupNames?: GroupNames | null } = {}) {
    this.access = access; this.groupNames = o.groupNames ?? null; this.schema = access.schema;
  }

  /** Personen-Rechte: nur Personen (nicht scopeBound) verwalten Freigaben. */
  private person(p: Principal) { return p.kind === 'user' && !p.scopeBound; }

  /**
   * Darf `p` die Relation an diesem Ort vergeben, entziehen oder ihren Ablauf ändern? (7.5, 9.1 Nr. 5–7)
   * @returns null (ja) oder der Grund (403-Fehler)
   */
  manageProblem(p: Principal, acl: TenantAccess<any>, ref: ResourceRef, relation: string, facts: Facts, hint?: string | null): HttpError | null {
    const a = this.access;
    if (!this.person(p)) return new HttpError(403, 'Keine Berechtigung', 'Nur angemeldete Personen verwalten Freigaben.');
    if (relation === ADMIN_ROLE && !p.platformAdmin) return new HttpError(403, 'Keine Berechtigung', `Die Rolle «${a.model.roles.get(ADMIN_ROLE)?.label}» vergibt und entzieht nur die Plattform-Administration.`, {}, { reason: 'platform-admin-only' });
    if (p.platformAdmin) return null; // A9: die Plattform-Administration ist von «niemand gibt mehr, als er hat» ausgenommen
    if (!a.decide(p, acl, 'access:admin', ref, hint, facts)) return a.missingPermission('access:admin', ref.type === ORG ? '' : ' an diesem Ort');
    const missing = [...a.model.permissionsOf(relation, ref.type)].filter(perm => !a.decide(p, acl, perm, ref, hint, facts));
    if (missing.length) return new HttpError(403, 'Keine Berechtigung', `Die Rolle enthält Rechte, die du hier nicht hast: ${missing.map(x => a.model.permissionText(x)).join(', ')}.`, {}, { reason: 'exceeds-own', missing });
    return null;
  }

  /** Relationen, die `p` an diesem Ort vergeben darf (ohne `owner`, das setzt nur die App). */
  grantable(p: Principal, acl: TenantAccess<any>, ref: ResourceRef, facts: Facts, hint?: string | null): string[] {
    return this.access.model.relationsAt(ref.type).filter(r => r !== OWNER && !this.manageProblem(p, acl, ref, r, facts, hint));
  }

  /** Namen der Subjekte (Personen, Clients aus `principal`; Gruppen aus Graph; «Alle Mitglieder»). */
  async names(tenantId: string, subjects: string[], createdBy: (string | null)[] = []): Promise<{ subject: Map<string, AccessSubjectOut>; principal: Map<string, string> }> {
    const ids = [...new Set([...subjects.filter(s => s.startsWith('user:') || s.startsWith('client:')).map(s => s.slice(s.indexOf(':') + 1)), ...createdBy.filter((x): x is string => !!x)])];
    const rows = ids.length ? await this.access.fullTx(tenantId, async tx => (await tx.query<{ id: string; kind: string; display_name: string | null; email: string | null; client_id: string | null; last_scopes: string[] | null }>(
      `SELECT id, kind, display_name, email, client_id, last_scopes FROM ${this.schema}.principal WHERE id = ANY($1::uuid[])`, [ids])).rows) : [];
    const byId = new Map(rows.map(r => [r.id, r]));
    const groups = subjects.filter(s => s.startsWith('group:')).map(s => s.slice(6));
    const gnames = groups.length && this.groupNames ? await this.groupNames(tenantId, groups).catch(() => new Map<string, string>()) : new Map<string, string>();
    const subject = new Map<string, AccessSubjectOut>();
    for (const s of new Set(subjects)) {
      const kind = kindOf(s), id = s.slice(s.indexOf(':') + 1), row = byId.get(id);
      const name = kind === 'members' ? MEMBERS_NAME : kind === 'group' ? gnames.get(id) ?? id : row?.display_name ?? row?.client_id ?? row?.email ?? id;
      subject.set(s, { ref: s, kind, name, ...(kind === 'client' ? { scopes: row?.last_scopes ?? null } : {}) });
    }
    const principal = new Map(rows.map(r => [r.id, r.display_name ?? r.client_id ?? r.email ?? r.id]));
    return { subject, principal };
  }

  /** Eintrag eines Tupels (direkt) mit Namen. */
  async entryOf(tenantId: string, t: Tuple, removable: boolean): Promise<AccessEntry> {
    return (await this.entries(tenantId, [{ t, via: 'direct', removable }]))[0]!;
  }

  /** Einträge aus Tupeln mit Namen. */
  private async entries(tenantId: string, list: Item[]): Promise<AccessEntry[]> {
    const n = await this.names(tenantId, list.map(x => x.t.subject), list.map(x => x.t.created_by));
    return list.map(({ t, via, removable, unit, data }) => ({
      id: via === 'scope' || via === 'data' ? null : t.id, subject: n.subject.get(t.subject)!, relation: t.relation, place: { type: t.object_type, id: t.object_id }, via,
      ...(unit ? { unit } : {}), ...(data ? { data } : {}), expiresAt: iso(t.expires_at), createdAt: iso(t.created_at), createdBy: t.created_by ? n.principal.get(t.created_by) ?? null : null, removable,
    }));
  }

  /**
   * «Wer hat Zugriff?» an einer Ressource (`GET /v1/access?type=&id=`): Leserecht des Typs (an org `tenant:read`),
   * sonst 404 (wie unbekannt).
   */
  async whoHasAccess(p: Principal, input: ResourceRef): Promise<AccessList> {
    const a = this.access;
    const ref = await checkRef(a, p.tenantId, input);
    const type = a.model.types.get(ref.type)!;
    const acl = await a.load(p.tenantId);
    const hint = await a.hint(p.tenantId, ref);
    const facts = await a.facts(p, acl, [ref], p.tenantId);
    if (!type.read || !a.decide(p, acl, type.read, ref, hint, facts)) throw notFound('Ressource');
    const now = Date.now();
    const list: Item[] = [];
    const chain = a.chain(acl, ref, hint);
    for (let i = chain.length - 1; i >= 0; i--) {
      const step = chain[i]!, here = i === chain.length - 1;
      for (const t of a.at(acl, step)) {
        if (!live(t, now) || !a.model.relationsAt(t.object_type).includes(t.relation)) continue;
        if (here) list.push({ t, via: 'direct', removable: t.relation !== OWNER && !this.manageProblem(p, acl, ref, t.relation, facts, hint) });
        else if (t.relation !== MEMBER && t.relation !== OWNER && a.model.roles.get(t.relation)?.permissions.includes(type.read)) list.push({ t, via: 'inherited', removable: false });
      }
    }
    for (const s of await this.scopeEntries(p.tenantId, acl, ref)) list.push(s);
    for (const x of a.resources?.edges?.persons && type.scope ? facts.persons.get(refKey(ref)) ?? [] : []) {
      if (x.grants === 'none') continue;
      // Kein Tupel: Herkunft sind Fachdaten der App, im Panel nicht entfernbar
      const t: Tuple = { id: '', subject: `user:${x.principal_id}`, relation: x.label, object_type: ref.type, object_id: ref.id!, expires_at: null, created_at: null as never, created_by: null };
      list.push({ t, via: 'data', removable: false, data: { relation: x.label, grants: x.grants } });
    }
    const r = a.resources;
    const classification = type.classified && r?.classification ? (await a.fullTx(p.tenantId, tx => r.classification!(tx, [ref]))).get(refKey(ref)) ?? 0 : null;
    return { resource: placeOut(ref), classification, items: await this.entries(p.tenantId, list), grantable: this.grantable(p, acl, ref, facts, hint) };
  }

  /** Zuständigkeit: Mitglieder (Tupel `member`) der Einheiten, zu denen die Ressource gehört, und der Einheiten darüber. */
  private async scopeEntries(tenantId: string, acl: TenantAccess<any>, ref: ResourceRef): Promise<{ t: Tuple; via: 'scope'; removable: false; unit: AccessEntry['unit'] }[]> {
    const a = this.access, e = a.unitEdges;
    if (!e || !ref.id || !a.model.types.get(ref.type)?.scope) return [];
    const now = Date.now();
    const members = acl.tuples.filter(t => t.relation === MEMBER && t.object_type === e.unit && t.object_id && live(t, now));
    if (!members.length) return [];
    return a.fullTx(tenantId, async tx => {
      const belongs = (await tx.query<{ unit_id: string; grants: 'read' | 'edit' | 'none'; label: string }>(e.belongs, [[ref.id]])).rows.filter(b => b.grants !== 'none');
      if (!belongs.length) return [];
      const below = await this.descendants(tx, [...new Set(members.map(t => t.object_id!))]);
      const out: { t: Tuple; via: 'scope'; removable: false; unit: AccessEntry['unit'] }[] = [];
      for (const b of belongs) {
        for (const t of members) {
          if (!below.get(t.object_id!)?.has(b.unit_id)) continue;
          out.push({ t, via: 'scope', removable: false, unit: { ref: { type: e.unit, id: b.unit_id }, relation: b.label, grants: b.grants as 'read' | 'edit' } });
        }
      }
      return out;
    });
  }

  /** Je Einheit sie selbst und alle darunter (Tiefe ≤ 16). */
  private async descendants(tx: Tx, roots: string[]): Promise<Map<string, Set<string>>> {
    const e = this.access.unitEdges!;
    const out = new Map(roots.map(r => [r, new Set([r])]));
    let frontier = new Map(roots.map(r => [r, [r]]));
    for (let d = 0; d < 16 && frontier.size; d++) {
      const all = [...new Set([...frontier.values()].flat())];
      const children = new Map<string, string[]>();
      for (const id of all) children.set(id, (await tx.query<{ id: string }>(e.children, [[id]])).rows.map(r => r.id));
      const next = new Map<string, string[]>();
      for (const [root, ids] of frontier) {
        const seen = out.get(root)!, add: string[] = [];
        for (const id of ids) for (const c of children.get(id) ?? []) if (!seen.has(c)) { seen.add(c); add.push(c); }
        if (add.length) next.set(root, add);
      }
      frontier = next;
    }
    return out;
  }

  /** Freigaben eines Subjekts (`GET /v1/access?subject=`), nur `via: 'direct'`. */
  async ofSubject(p: Principal, subject: string): Promise<{ items: AccessEntry[] }> {
    const acl = await this.access.load(p.tenantId);
    const now = Date.now();
    const list = acl.tuples.filter(t => t.subject === subject && live(t, now)).map(t => ({ t, via: 'direct' as const, removable: false }));
    const items = await this.entries(p.tenantId, list);
    for (const [i, x] of list.entries()) {
      const ref = { type: x.t.object_type, id: x.t.object_id };
      items[i]!.removable = x.t.relation !== OWNER && !this.manageProblem(p, acl, ref, x.t.relation, noFacts());
    }
    return { items };
  }

  /** Wer ist das Subjekt für «Warum?» (andere)? Person, Client, Gruppe, «Alle Mitglieder»; unbekannt → 404. */
  async who(tenantId: string, subject: string): Promise<Who> {
    if (!SUBJECT_PATTERN.test(subject)) throw invalid('Subjekt ungültig', [{ path: '/subject', message: 'user:<id>, client:<id>, group:<id> oder org:members' }]);
    const kind = kindOf(subject), id = subject.slice(subject.indexOf(':') + 1);
    if (kind === 'members') return { kind: 'user', principalId: '', subjects: ['org:members'], scopes: [] };
    if (kind === 'group') return { kind: 'user', principalId: '', subjects: [subject], scopes: [] };
    const row = await this.access.fullTx(tenantId, async tx => (await tx.query<{ last_scopes: string[] | null }>(
      `SELECT last_scopes FROM ${this.schema}.principal WHERE id = $1 AND kind = $2 AND removed_at IS NULL`, [id, kind])).rows[0]);
    if (!row) throw notFound('Subjekt');
    // Gruppen einer anderen Person kennt nur ihr Token: «Warum?» für andere ohne ihre Gruppen
    return kind === 'client' ? { kind: 'client', principalId: id, subjects: [subject], scopes: row.last_scopes ?? [], scopeBound: true } : { kind: 'user', principalId: id, subjects: [subject, 'org:members'], scopes: [] };
  }

  /**
   * «Warum?» (`GET /v1/access/explain`). Ohne `subject` ich selbst (Ressource muss für mich lesbar sein, sonst 404); für
   * andere `access:admin` am Ort. Ohne `permission` das Leserecht des Typs (fehlt es: 422).
   */
  async explain(p: Principal, input: ResourceRef, o: { permission?: string; subject?: string } = {}): Promise<ExplainOut> {
    const a = this.access;
    const ref = await checkRef(a, p.tenantId, input);
    const type = a.model.types.get(ref.type)!;
    const perm = o.permission ?? type.read;
    if (!perm) throw invalid('Recht fehlt', [{ path: '/permission', message: 'Recht angeben (der Typ hat kein Leserecht)' }]);
    if (!a.model.isPermission(perm)) throw invalid('Recht unbekannt', [{ path: '/permission', message: `«${perm}» ist kein Recht des Modells` }]);
    const acl = await a.load(p.tenantId);
    const hint = await a.hint(p.tenantId, ref);
    const mine = await a.facts(p, acl, [ref], p.tenantId);
    const self = !o.subject || o.subject === p.subjects[0];
    if (!type.read || !a.decide(p, acl, type.read, ref, hint, mine)) throw notFound('Ressource');
    if (!self && !(this.person(p) && a.decide(p, acl, 'access:admin', ref, hint, mine))) throw a.missingPermission('access:admin', ref.type === ORG ? '' : ' an diesem Ort');
    const who: Who = self ? p : await this.who(p.tenantId, o.subject!);
    const facts = self ? mine : await a.facts(who, acl, [ref], p.tenantId);
    const reasons = [...a.tupleReasons(who, acl, perm, ref, hint), ...a.scopeReasons(acl, perm, ref, facts), ...a.personReasons(who, perm, ref, facts)];
    // Zuständigkeit: passendes Subjekt = eines mit Tupel member an einer Einheit von units(who)
    const memberOf = acl.tuples.find(t => t.relation === MEMBER && who.subjects.includes(t.subject) && t.object_id && facts.units?.has(t.object_id) && live(t));
    for (const r of reasons) if (r.via === 'scope') r.matched = memberOf?.subject ?? who.subjects[0]!;
    const allowed = a.decide(who, acl, perm, ref, hint, facts);
    let blocked: ExplainOut['blocked'] = null;
    if (!allowed && reasons.length) {
      if (!a.scopeAllows(who, perm)) blocked = { reason: 'scope', scope: a.model.scopeForPermission(perm as never) };
      else {
        const c = facts.classification.get(refKey(ref));
        if (c !== undefined) blocked = { reason: 'clearance', classification: c, clearance: a.clearanceOf(who, acl) };
      }
    }
    const subjectRef = self ? p.subjects[0]! : o.subject!;
    const n = await this.names(p.tenantId, [subjectRef, ...reasons.map(r => r.matched)]);
    return {
      allowed, permission: perm, subject: { ref: subjectRef, name: n.subject.get(subjectRef)?.name ?? subjectRef },
      reasons: reasons.map(r => ({ ...r, place: placeOut(r.place), label: n.subject.get(r.matched)?.name ?? r.matched })),
      blocked,
    };
  }
}
