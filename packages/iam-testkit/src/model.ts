/**
 * Prüfung des Modells einer App gegen die Spezifikation (Kap. 7.3 Regeln M1–M12, Kap. 8): reservierte Namen mit festem
 * Schlüssel, Label und Gruppe, Schlüsselregeln, Vollständigkeit, Typen (Kette, Rollen je Ort, Blatt, Lese- und
 * Schreibrecht), Scopes und `platform.json`.
 *
 * Geprüft wird die Antwort von `GET /v1/authz/catalog` (sprachneutraler Vertrag): so gilt die Prüfung für jede App,
 * auch für Apps, die nicht mit dem Backend-Paket gebaut sind. `defineModel` des Backend-Pakets prüft dasselbe schon beim
 * Start; dieser Test hält die ausgelieferte Antwort gleich.
 */

export type Level = 0 | 1 | 2;
export interface ModelPermission { key: string; label: string; group: string; description: string; resources: string[]; adminOnly?: boolean; personOnly?: boolean }
export interface ModelGroup { key: string; label: string; match?: string }
export interface ModelRole { key: string; label: string; description: string; permissions: string[]; adminOnly?: boolean }
export interface ModelScope { key: string; text: string; permissions: string[] }
export interface ModelType {
  key: string; label: string; parent: string | null; self?: boolean; roles: string[]; relations: string[];
  leaf?: boolean; classified?: boolean; owner?: boolean; membersRole?: string; scope?: { relation: string }; read?: string; write?: string;
}
/** Antwort von `GET /v1/authz/catalog` (Kap. 9.5). */
export interface AuthzModel {
  permissions: ModelPermission[];
  groups: ModelGroup[];
  roles: ModelRole[];
  scopes: ModelScope[];
  types: ModelType[];
  classifications: { level: Level; label: string }[];
  mcpTools?: { name: string; title: string; permission: string; scope: string | null; readOnly: boolean; openWorld?: boolean }[];
}

/** Reservierte Rolle (Kap. 8.1). */
export const ADMIN_ROLE = { key: 'org-admin', label: 'Organisations-Admin' } as const;
/** Reservierte Rechte mit Label und Gruppe; `required`: muss jede App haben. */
export const RESERVED_PERMISSIONS = [
  { key: 'tenant:read', label: 'Organisation lesen', group: 'tenant', required: true },
  { key: 'tenant:admin', label: 'Organisation verwalten', group: 'tenant', required: false },
  { key: 'members:admin', label: 'Mitglieder und Rollen verwalten', group: 'members', required: false },
  { key: 'access:admin', label: 'Zugriff verwalten', group: 'access', required: false },
  { key: 'audit:read', label: 'Protokoll lesen', group: 'audit', required: false },
] as const;
/** Reservierte Rechtegruppen mit Label. */
export const RESERVED_GROUPS: Record<string, string> = { tenant: 'Organisation', members: 'Mitglieder und Rollen', access: 'Zugriff', audit: 'Protokoll' };
/** Realm-Rolle der Plattform-Administration; keine Rolle des Modells. */
export const PLATFORM_ADMIN_ROLE = 'platform-admin';
/** Entfallen (Kap. 8.1). */
const GONE = ['acl:read', 'acl:admin', 'access:read'];

const PERMISSION_KEY = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const NAME_KEY = /^[a-z][a-z0-9-]*$/;

export interface ModelCheck {
  /** Verstösse gegen MUSS-Regeln (mit Regel M1–M12). */
  errors: string[];
  /** Abweichungen von SOLL-Regeln. */
  warnings: string[];
}

/**
 * @param o.product technischer Name der App; dann SOLL es den Lese-Scope `<product>:read` geben.
 * @param o.members App verwaltet Mitglieder (Standard true): dann MUSS es `members:admin` geben.
 * @param o.platformJson Inhalt von `infra/keycloak/platform.json`: muss genau `{ "scopes": [...] }` des Modells sein.
 */
export function checkModel(c: AuthzModel, o: { product?: string; members?: boolean; platformJson?: string } = {}): ModelCheck {
  const errors: string[] = [], warnings: string[] = [];
  const perms = new Map(c.permissions.map(p => [p.key, p]));
  const groups = new Map(c.groups.map(g => [g.key, g]));
  const roles = new Map(c.roles.map(r => [r.key, r]));
  const types = new Map(c.types.map(t => [t.key, t]));
  const dup = (kind: string, keys: string[]) => { for (const k of new Set(keys.filter((x, i) => keys.indexOf(x) !== i))) errors.push(`${kind} «${k}» mehrfach`); };
  dup('Recht', c.permissions.map(p => p.key)); dup('Rolle', c.roles.map(r => r.key)); dup('Scope', c.scopes.map(s => s.key)); dup('Gruppe', c.groups.map(g => g.key)); dup('Typ', c.types.map(t => t.key));

  // ---------------------------------------------------------------- M1, M2: Rechte und Gruppen
  for (const p of c.permissions) {
    if (!PERMISSION_KEY.test(p.key)) errors.push(`M1 Recht «${p.key}»: Schlüssel nicht <bereich>:<verb>`);
    if (GONE.includes(p.key)) errors.push(`M1 Recht «${p.key}» entfällt`);
    if (!p.label?.trim()) errors.push(`M2 Recht «${p.key}»: Label fehlt`);
    if (!p.description?.trim()) errors.push(`M2 Recht «${p.key}»: Beschreibung fehlt`);
    if (!groups.has(p.group)) errors.push(`M2 Recht «${p.key}»: Gruppe «${p.group}» nicht im Modell`);
    if (!p.resources?.includes('org')) errors.push(`M2 Recht «${p.key}»: resources ohne «org»`);
    for (const r of p.resources ?? []) if (!types.has(r)) errors.push(`M2 Recht «${p.key}»: Typ «${r}» nicht im Modell`);
  }
  for (const g of c.groups) {
    if (!NAME_KEY.test(g.key)) errors.push(`M1 Gruppe «${g.key}»: Schlüssel nicht ${NAME_KEY}`);
    if (!g.label?.trim()) errors.push(`M1 Gruppe «${g.key}»: Label fehlt`);
  }
  for (const r of RESERVED_PERMISSIONS) {
    const p = perms.get(r.key);
    const needed = r.required || (r.key === 'members:admin' && o.members !== false) || (r.key === 'access:admin' && c.types.some(t => t.key !== 'org'));
    if (!p) { if (needed) errors.push(`M1 Recht «${r.key}» fehlt`); continue; }
    if (p.label !== r.label) errors.push(`M1 Recht «${r.key}»: Label «${p.label}» statt «${r.label}»`);
    if (p.group !== r.group) errors.push(`M1 Recht «${r.key}»: Gruppe «${p.group}» statt «${r.group}»`);
  }
  for (const [k, label] of Object.entries(RESERVED_GROUPS)) {
    const g = groups.get(k);
    if (g && g.label !== label) errors.push(`M1 Gruppe «${k}»: Label «${g.label}» statt «${label}»`);
  }

  // ---------------------------------------------------------------- M3: Rollen
  if (c.roles[0]?.key !== ADMIN_ROLE.key) errors.push(`M3 Rolle «${ADMIN_ROLE.key}» fehlt oder steht nicht zuerst`);
  const admin = roles.get(ADMIN_ROLE.key);
  if (admin) {
    if (admin.label !== ADMIN_ROLE.label) errors.push(`M1 Rolle «${ADMIN_ROLE.key}»: Label «${admin.label}» statt «${ADMIN_ROLE.label}»`);
    const missing = c.permissions.map(p => p.key).filter(p => !admin.permissions.includes(p));
    if (missing.length) errors.push(`M3 Rolle «${ADMIN_ROLE.key}» hat nicht alle Rechte (fehlen: ${missing.join(', ')})`);
  }
  for (const r of c.roles) {
    if (!NAME_KEY.test(r.key)) errors.push(`M1 Rolle «${r.key}»: Schlüssel nicht ${NAME_KEY}`);
    if ([PLATFORM_ADMIN_ROLE, 'member', 'owner'].includes(r.key)) errors.push(`M1 Rolle «${r.key}»: reservierter Name, kein Rollenschlüssel`);
    if (!r.label?.trim()) errors.push(`M3 Rolle «${r.key}»: Label fehlt`);
    if (!r.description?.trim()) errors.push(`M3 Rolle «${r.key}»: Beschreibung fehlt`);
    if (!r.permissions.length) errors.push(`M3 Rolle «${r.key}»: ohne Rechte`);
    for (const p of r.permissions) if (!perms.has(p)) errors.push(`M3 Rolle «${r.key}»: Recht «${p}» nicht im Modell`);
    if (r.adminOnly !== undefined && r.adminOnly !== (r.key === ADMIN_ROLE.key)) errors.push(`M3 Rolle «${r.key}»: adminOnly nur bei ${ADMIN_ROLE.key}`);
    for (const g of new Set(r.permissions.map(p => perms.get(p)?.group))) {
      const m = g ? groups.get(g)?.match : undefined;
      if (m === undefined) continue;
      let re: RegExp;
      try { re = new RegExp(m, 'i'); } catch { errors.push(`M3 Gruppe «${g}»: Stichwort «${m}» ist kein regulärer Ausdruck`); continue; }
      if (!re.test(r.description ?? '')) errors.push(`M3 Rolle «${r.key}»: Beschreibung nennt die Rechtegruppe «${g}» nicht (Stichwort ${m})`);
    }
  }

  // ---------------------------------------------------------------- M4–M9: Typen
  const org = types.get('org');
  if (!org || c.types[0]?.key !== 'org') errors.push('M4 Typ «org» fehlt oder steht nicht zuerst');
  else {
    if (org.label !== 'Organisation') errors.push(`M1 Typ «org»: Label «${org.label}» statt «Organisation»`);
    if (org.parent !== null) errors.push('M4 Typ «org» hat keinen parent');
    if (!org.roles.includes(ADMIN_ROLE.key)) errors.push(`M5 Typ «org»: ${ADMIN_ROLE.key} muss dort hängen dürfen`);
    for (const r of org.roles) if (!roles.has(r)) errors.push(`M5 Typ «org»: Rolle «${r}» nicht im Modell`);
    if (org.roles.length !== new Set(org.roles).size) errors.push('M5 Typ «org»: Rollen doppelt');
    if (org.owner || org.classified) errors.push('M9 Typ «org»: owner und classified nicht erlaubt');
    if (org.membersRole !== undefined) errors.push('M13 Typ «org»: membersRole nicht erlaubt');
  }
  const leaves = c.types.filter(t => t.leaf);
  if (leaves.length > 1) errors.push(`M6 höchstens ein Blatt-Typ (${leaves.map(t => t.key).join(', ')})`);
  for (const t of c.types) {
    if (!NAME_KEY.test(t.key)) errors.push(`M1 Typ «${t.key}»: Schlüssel nicht ${NAME_KEY}`);
    if (!t.label?.trim()) errors.push(`M1 Typ «${t.key}»: Label fehlt`);
    if (t.key === 'org') continue;
    if (!t.parent || !types.has(t.parent)) errors.push(`M4 Typ «${t.key}»: parent fehlt oder nicht im Modell`);
    const seen = new Set<string>();
    for (let cur: string | null = t.key; cur && cur !== 'org'; cur = types.get(cur)?.parent ?? null) {
      if (seen.has(cur)) { errors.push(`M4 Typ «${t.key}»: Kette hat einen Kreis`); break; }
      seen.add(cur);
    }
    for (const r of t.roles) {
      if (!roles.has(r)) errors.push(`M5 Typ «${t.key}»: Rolle «${r}» nicht im Modell`);
      if (r === ADMIN_ROLE.key) errors.push(`M5 Typ «${t.key}»: ${ADMIN_ROLE.key} nur an org`);
    }
    if (t.leaf && c.types.some(x => x.parent === t.key)) errors.push(`M6 Typ «${t.key}» ist ein Blatt, aber Elterntyp eines anderen`);
    if (!t.read) errors.push(`M7 Typ «${t.key}»: read fehlt`);
    if ((t.leaf || t.scope) && !t.write) errors.push(`M7 Typ «${t.key}»: write fehlt`);
    for (const p of [t.read, t.write]) if (p && !perms.get(p)?.resources.includes(t.key)) errors.push(`M7 Typ «${t.key}»: «${p}» hat den Typ nicht in resources`);
    const extra = t.relations.filter(r => !t.roles.includes(r));
    for (const r of extra) if (r !== 'member' && !(r === 'owner' && t.owner)) errors.push(`M8 Typ «${t.key}»: Beziehung «${r}» nicht zulässig`);
    if (t.owner && !t.relations.includes('owner')) errors.push(`M8 Typ «${t.key}»: owner fehlt in relations`);
    if (t.membersRole !== undefined) {
      const role = c.roles.find(r => r.key === t.membersRole);
      const others = c.roles.filter(r => r.key !== ADMIN_ROLE.key).flatMap(r => r.permissions);
      if (!t.owner) errors.push(`M13 Typ «${t.key}»: membersRole nur bei Typen mit owner`);
      else if (!role || !t.roles.includes(role.key)) errors.push(`M13 Typ «${t.key}»: membersRole «${t.membersRole}» ist am Typ nicht zulässig`);
      else if (role.key === ADMIN_ROLE.key || role.permissions.some(p => !others.includes(p))) errors.push(`M13 Typ «${t.key}»: membersRole «${t.membersRole}» enthält Rechte nur von ${ADMIN_ROLE.key}`);
    }
  }
  if (c.types.some(t => t.scope) && !c.types.some(t => t.relations.includes('member'))) errors.push('M8 Zuständigkeit (scope) ohne Typ mit «member» (Einheit)');

  // ---------------------------------------------------------------- M10, M11: Scopes, MCP
  for (const s of c.scopes) {
    if (!PERMISSION_KEY.test(s.key)) errors.push(`M1 Scope «${s.key}»: Schlüssel nicht <bereich>:<verb>`);
    if (!s.text?.trim()) errors.push(`M10 Scope «${s.key}»: Text fehlt`);
    if (!s.permissions.length) errors.push(`M10 Scope «${s.key}»: ohne Rechte`);
    for (const p of s.permissions) {
      if (!perms.has(p)) errors.push(`M10 Scope «${s.key}»: Recht «${p}» nicht im Modell`);
      if (perms.get(p)?.personOnly || p === 'members:admin' || p === 'access:admin') errors.push(`M10 Scope «${s.key}» enthält «${p}» (nur für Personen, in keinem Scope)`);
    }
  }
  for (const t of c.mcpTools ?? []) {
    if (!perms.has(t.permission)) errors.push(`M11 MCP-Werkzeug «${t.name}»: Recht «${t.permission}» nicht im Modell`);
    if (!t.title?.trim()) errors.push(`M11 MCP-Werkzeug «${t.name}»: Titel fehlt`);
  }

  // ---------------------------------------------------------------- M12: Stufen
  if (c.classifications.length !== 3 || c.classifications.some((x, i) => x.level !== i || !x.label?.trim())) errors.push('M12 classifications: Stufen 0, 1, 2 mit nicht leeren Labels');

  // ---------------------------------------------------------------- platform.json
  if (o.platformJson !== undefined) {
    let pj: unknown;
    try { pj = JSON.parse(o.platformJson); } catch { pj = null; }
    const want = { scopes: c.scopes.map(s => s.key) };
    if (JSON.stringify(pj) !== JSON.stringify(want)) errors.push(`platform.json veraltet: erwartet ${JSON.stringify(want)} (nur Scopes, model.platformJson())`);
  }

  // ---------------------------------------------------------------- SOLL
  if (o.product && !c.scopes.some(s => s.key === `${o.product}:read`)) warnings.push(`Lese-Scope «${o.product}:read» fehlt`);
  return { errors, warnings };
}
