/**
 * Standardfälle der Entscheidung (Spezifikation Kap. 7.5, 14 › `access`), erzeugt aus dem Modell der App
 * (`GET /v1/authz/catalog`): Rollen an der Organisation, Ablauf, Subjekte (Person, Gruppe aus Entra, «Alle Mitglieder»,
 * Client), Scope-Grenze. Die App führt sie mit ihrer Entscheidung aus (`runAccessCases`): Tupel anlegen, Principal
 * bauen, `can` fragen. Fälle an Orten unter der Organisation (Kette, Blatt, Zuständigkeit) hängen an den Ressourcen der
 * App und gehören in ihre eigenen Tests; für die Zuständigkeit über Personen aus Fachdaten (`edges.persons`, Kit 1.1)
 * liefert `personCases` Standardfälle, die die App an einer eigenen Ressource ausführt.
 */
import type { AuthzModel } from './model.ts';

export interface CaseTuple { subject: 'me' | 'group' | 'org:members'; relation: string; expired?: boolean }
export interface AccessCase {
  name: string;
  /** Wer fragt: Person (mit Gruppe `group` im Token) oder Client; `scopes` macht die Anfrage scope-gebunden. */
  who: { kind: 'user' | 'client'; groupInToken?: boolean; scopes?: string[] };
  /** Tupel an org; `me` = Subjekt des Fragenden, `group` = die Gruppe aus dem Token. */
  tuples: CaseTuple[];
  permission: string;
  expect: boolean;
}

/** Fälle für ein Modell; je Rolle und Recht höchstens einige, damit der Lauf kurz bleibt. */
export function accessCases(m: Pick<AuthzModel, 'roles' | 'permissions' | 'scopes'>): AccessCase[] {
  const out: AccessCase[] = [];
  const all = m.permissions.map(p => p.key);
  for (const r of m.roles) {
    const has = r.permissions[0], lacks = all.find(p => !r.permissions.includes(p));
    if (!has) continue;
    out.push({ name: `Rolle ${r.key} an org gibt ${has}`, who: { kind: 'user' }, tuples: [{ subject: 'me', relation: r.key }], permission: has, expect: true });
    if (lacks) out.push({ name: `Rolle ${r.key} an org gibt ${lacks} nicht`, who: { kind: 'user' }, tuples: [{ subject: 'me', relation: r.key }], permission: lacks, expect: false });
    out.push({ name: `Rolle ${r.key}: abgelaufenes Tupel zählt nicht`, who: { kind: 'user' }, tuples: [{ subject: 'me', relation: r.key, expired: true }], permission: has, expect: false });
  }
  const role = m.roles.find(r => r.key !== 'org-admin') ?? m.roles[0];
  if (role) {
    const perm = role.permissions[0]!;
    out.push({ name: 'ohne Tupel kein Recht', who: { kind: 'user' }, tuples: [], permission: perm, expect: false });
    out.push({ name: `«Alle Mitglieder» mit ${role.key} gilt für Personen`, who: { kind: 'user' }, tuples: [{ subject: 'org:members', relation: role.key }], permission: perm, expect: true });
    out.push({ name: `«Alle Mitglieder» mit ${role.key} gilt nicht für Clients`, who: { kind: 'client', scopes: m.scopes.map(s => s.key) }, tuples: [{ subject: 'org:members', relation: role.key }], permission: perm, expect: false });
    out.push({ name: `Gruppe aus dem Token mit ${role.key}`, who: { kind: 'user', groupInToken: true }, tuples: [{ subject: 'group', relation: role.key }], permission: perm, expect: true });
    out.push({ name: `Gruppe nicht im Token: kein Recht`, who: { kind: 'user' }, tuples: [{ subject: 'group', relation: role.key }], permission: perm, expect: false });
    const scope = m.scopes.find(s => s.permissions.includes(perm));
    if (scope) {
      out.push({ name: `Client mit ${role.key} und Scope ${scope.key}`, who: { kind: 'client', scopes: [scope.key] }, tuples: [{ subject: 'me', relation: role.key }], permission: perm, expect: true });
      out.push({ name: `Scope-Grenze: Person über MCP mit ${role.key} ohne Scope`, who: { kind: 'user', scopes: [] }, tuples: [{ subject: 'me', relation: role.key }], permission: perm, expect: false });
    }
    out.push({ name: `Client mit ${role.key} ohne passenden Scope`, who: { kind: 'client', scopes: [] }, tuples: [{ subject: 'me', relation: role.key }], permission: perm, expect: false });
  }
  for (const p of ['members:admin', 'access:admin']) {
    if (!all.includes(p)) continue;
    out.push({ name: `${p} nie für Clients (in keinem Scope)`, who: { kind: 'client', scopes: m.scopes.map(s => s.key) }, tuples: [{ subject: 'me', relation: 'org-admin' }], permission: p, expect: false });
  }
  return out;
}

/** Fall der Zuständigkeit über Personen aus Fachdaten (`ResourceModel.edges.persons`) an einer Ressource vom Typ `type`. */
export interface PersonCase {
  name: string;
  /** Typ mit Zuständigkeit (`scope`). */
  type: string;
  /** Wer fragt: Person ohne Tupel, Freigabestufe 0, oder Client; `scopes` macht die Anfrage scope-gebunden. */
  who: { kind: 'user' | 'client'; scopes?: string[] };
  /** Wer an der Ressource zuständig eingetragen ist: der Fragende (`me`) oder eine andere Person. */
  holder: 'me' | 'other';
  grants: 'read' | 'edit' | 'none';
  /** Vertraulichkeit der Ressource (nur Typen mit `classified`); Standard 0. */
  classification?: 0 | 1 | 2;
  permission: string;
  expect: boolean;
}

/**
 * Fälle je Typ mit `scope` (Spezifikation Kap. 7.5 Regel 2): read ⇒ Leserecht, edit ⇒ Lese- und Schreibrecht, none
 * und andere Personen nichts, Clients nie, ∧ Klassifizierung ∧ Scope. Die App legt je Fall eine Ressource mit dem
 * Eintrag an und fragt `can` (ohne Tupel des Fragenden).
 */
export function personCases(m: Pick<AuthzModel, 'types' | 'scopes'>): PersonCase[] {
  const out: PersonCase[] = [];
  for (const t of m.types) {
    if (!t.scope || !t.read || !t.write) continue;
    const { read, write } = t;
    const c = (name: string, x: Omit<PersonCase, 'name' | 'type'>) => out.push({ name: `${t.key}: ${name}`, type: t.key, ...x });
    c(`zuständig read gibt ${read}`, { who: { kind: 'user' }, holder: 'me', grants: 'read', permission: read, expect: true });
    c(`zuständig read gibt ${write} nicht`, { who: { kind: 'user' }, holder: 'me', grants: 'read', permission: write, expect: false });
    c(`zuständig edit gibt ${read}`, { who: { kind: 'user' }, holder: 'me', grants: 'edit', permission: read, expect: true });
    c(`zuständig edit gibt ${write}`, { who: { kind: 'user' }, holder: 'me', grants: 'edit', permission: write, expect: true });
    c('grants none gibt nichts', { who: { kind: 'user' }, holder: 'me', grants: 'none', permission: read, expect: false });
    c('andere Person zuständig: nichts', { who: { kind: 'user' }, holder: 'other', grants: 'edit', permission: read, expect: false });
    c('Client nie über Personen', { who: { kind: 'client', scopes: m.scopes.map(s => s.key) }, holder: 'me', grants: 'edit', permission: read, expect: false });
    if (t.classified) c('Klassifizierung über der Freigabestufe verhindert', { who: { kind: 'user' }, holder: 'me', grants: 'edit', classification: 1, permission: read, expect: false });
    c('scope-gebunden ohne Scope: nichts', { who: { kind: 'user', scopes: [] }, holder: 'me', grants: 'edit', permission: read, expect: false });
    const readOnly = m.scopes.find(s => s.permissions.includes(read) && !s.permissions.includes(write));
    if (readOnly) {
      c(`scope-gebunden mit ${readOnly.key}: ${read}`, { who: { kind: 'user', scopes: [readOnly.key] }, holder: 'me', grants: 'edit', permission: read, expect: true });
      c(`scope-gebunden mit ${readOnly.key}: ${write} nicht`, { who: { kind: 'user', scopes: [readOnly.key] }, holder: 'me', grants: 'edit', permission: write, expect: false });
    }
  }
  return out;
}

/** Führt die Fälle aus; liefert die Befunde (leer = alles wie erwartet). */
export async function runAccessCases<C extends { name: string; expect: boolean } = AccessCase>(cases: C[], decide: (c: C) => Promise<boolean>): Promise<string[]> {
  const out: string[] = [];
  for (const c of cases) {
    const got = await decide(c);
    if (got !== c.expect) out.push(`${c.name}: erwartet ${c.expect}, erhalten ${got}`);
  }
  return out;
}
