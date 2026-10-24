/**
 * Standardfälle der Entscheidung (Spezifikation Kap. 7.5, 14 › `access`), erzeugt aus dem Modell der App
 * (`GET /v1/authz/catalog`): Rollen an der Organisation, Ablauf, Subjekte (Person, Gruppe aus Entra, «Alle Mitglieder»,
 * Client), Scope-Grenze. Die App führt sie mit ihrer Entscheidung aus (`runAccessCases`): Tupel anlegen, Principal
 * bauen, `can` fragen. Fälle an Orten unter der Organisation (Kette, Blatt, Zuständigkeit) hängen an den Ressourcen der
 * App und gehören in ihre eigenen Tests.
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

/** Führt die Fälle aus; liefert die Befunde (leer = alles wie erwartet). */
export async function runAccessCases(cases: AccessCase[], decide: (c: AccessCase) => Promise<boolean>): Promise<string[]> {
  const out: string[] = [];
  for (const c of cases) {
    const got = await decide(c);
    if (got !== c.expect) out.push(`${c.name}: erwartet ${c.expect}, erhalten ${got}`);
  }
  return out;
}
