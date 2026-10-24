/**
 * Modell der App (Spezifikation Kap. 7.3, 8; Konzept 3.3): Rechte, Rechtegruppen, Rollen, Scopes und Typen (Orte) an
 * einer Stelle. `defineModel` ergänzt die reservierten Namen (Kap. 8.1), gibt `org-admin` alle Rechte, prüft die Regeln
 * M1–M12 und bricht bei Verstössen mit allen Befunden ab (`ModelError`). Daraus entstehen `GET /v1/authz/catalog`
 * (`toJSON`), `infra/keycloak/platform.json` (`platformJson`, nur Scopes), die CHECKs von `authz_tuple`
 * (`syncModelChecks`) und die Hilfen der Entscheidung.
 *
 * Reservierte Rechte und Gruppen führt die App nur auf, wenn sie Reihenfolge, Beschreibung oder `resources` bestimmen
 * will; Label und Gruppe kommen dann aus dem Baukasten (angeben darf sie sie nur gleich).
 *
 * Reihenfolge: wie in der Eingabe (die App bestimmt sie); `org-admin` steht zuerst unter den Rollen, `org` zuerst unter
 * den Typen. Fehlt Reserviertes, wird es ergänzt: Rechte `tenant:*` vorne, die übrigen hinten; Gruppe `tenant` vorne,
 * die übrigen hinten.
 */

/** Rolle mit allen Rechten (Kap. 8.1). */
export const ADMIN_ROLE = 'org-admin';
export const ADMIN_LABEL = 'Organisations-Admin';
/** Realm-Rolle der Plattform-Administration; keine Rolle des Modells. */
export const PLATFORM_ADMIN_ROLE = 'platform-admin';
/** Wurzel jeder Kette. */
export const ORG = 'org';
/** Beziehung ohne Rechte (Mitglied einer Einheit, macht zuständig). */
export const MEMBER = 'member';
/** Besitzer:in einer Ressource (alle Rechte, deren `resources` den Typ enthalten). */
export const OWNER = 'owner';
/** Labels der reservierten Beziehungen. */
export const RELATION_LABELS = { [MEMBER]: 'Mitglied', [OWNER]: 'Besitzer:in' } as const;
/** Standard-Labels der Vertraulichkeitsstufen 0, 1, 2. */
export const CLASSIFICATIONS = ['intern', 'vertraulich', 'streng vertraulich'] as const;

export type Level = 0 | 1 | 2;

const PERMISSION_KEY = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const NAME_KEY = /^[a-z][a-z0-9-]*$/;

/** Reservierte Rechte (Kap. 8.1) mit Label, Gruppe und Standardbeschreibung. */
export const RESERVED_PERMISSIONS = {
  'tenant:read': { label: 'Organisation lesen', group: 'tenant', description: 'Name und Einstellungen der Organisation sehen.' },
  'tenant:admin': { label: 'Organisation verwalten', group: 'tenant', description: 'Name und Einstellungen der Organisation ändern.' },
  'members:admin': { label: 'Mitglieder und Rollen verwalten', group: 'members', description: 'Mitglieder einladen und entfernen, Rollen an der Organisation vergeben, Freigabestufen setzen, Anmeldung einrichten, Maschinen-Clients freigeben.' },
  'access:admin': { label: 'Zugriff verwalten', group: 'access', description: 'Freigaben an einem Ort anlegen, ändern und entfernen; «Warum?» für andere.' },
  'audit:read': { label: 'Protokoll lesen', group: 'audit', description: 'Das Audit-Protokoll durchsuchen und prüfen.' },
} as const;
export type ReservedPermission = keyof typeof RESERVED_PERMISSIONS;
/** Rechte, die in keinem Scope stehen dürfen (Rechteverwaltung nur durch Personen, Kap. 8.2). */
const PERSON_ONLY: readonly string[] = ['members:admin', 'access:admin'];

/** Reservierte Rechtegruppen mit Label und Stichwort für Rollenbeschreibungen. */
export const RESERVED_GROUPS: Record<string, { label: string; match: string }> = {
  tenant: { label: 'Organisation', match: '.' },
  members: { label: 'Mitglieder und Rollen', match: 'mitglieder' },
  access: { label: 'Zugriff', match: 'zugriff' },
  audit: { label: 'Protokoll', match: 'protokoll' },
};

export interface PermissionDef<T extends string = string> {
  /** Bei reservierten Rechten weglassen: kommt aus dem Baukasten. */
  label?: string;
  /** Bei reservierten Rechten weglassen. */
  group?: string;
  /** Bei reservierten Rechten optional (Standardtext des Baukastens), sonst Pflicht. */
  description?: string;
  /** Typen, an denen das Recht geprüft wird (immer mit `org`); Standard `['org']`. Bestimmt die Rechte von `owner`. */
  resources?: readonly (T | 'org')[];
  /** `false`: nur Personen, in keinem Scope. `members:admin` und `access:admin` immer. */
  scope?: false;
}

export interface GroupDef {
  key: string;
  /** Bei reservierten Gruppen weglassen: kommt aus dem Baukasten. */
  label?: string;
  /** Stichwort(e) für die Beschreibung jeder Rolle mit Rechten dieser Gruppe (Gross/klein egal); ohne: keine Prüfung. */
  match?: string | RegExp | readonly string[];
}

export interface RoleDef<P extends string = string> { label: string; description: string; permissions: readonly P[] | '*' }

export interface TypeDef<P extends string = string, R extends string = string, T extends string = string> {
  label: string;
  /** Typ darüber in der Kette; Pflicht ausser bei `org`. */
  parent?: T | 'org';
  /** Eigener Schlüssel: Vorfahren desselben Typs zählen zur Kette. */
  self?: T;
  /** Rollen, die hier hängen dürfen; `'*'` nur bei `org`. */
  roles: readonly R[] | '*';
  /** Beziehungen ohne Rechte, die hier hängen dürfen (nur `member`). */
  relations?: readonly 'member'[];
  /** Blatt: kein Typ hat es als `parent`; höchstens eines je Modell. */
  leaf?: true;
  /** Ressource trägt eine Vertraulichkeit (0..2). */
  classified?: true;
  /** Ressource hat Besitzer:in (Relation `owner`). */
  owner?: true;
  /** Zuständigkeit über Fachbeziehungen (`ResourceModel.edges`); `relation` benennt sie in «Warum?». */
  scope?: { via: 'reference'; relation: string };
  /** Lese- und Schreibrecht des Typs; `read` Pflicht ausser bei `org`, `write` Pflicht bei `leaf` und `scope`. */
  read?: P;
  write?: P;
}

export interface McpToolDef<P extends string = string> { title: string; permission: P; readOnly: boolean }

export interface ModelInput<P extends string = string, R extends string = string, T extends string = string> {
  /** Technischer Name des Produkts (Lese-Scope `<product>:read`). */
  product: string;
  /** Reservierte Rechte nur ohne label/group (Beschreibung, resources, Reihenfolge), 8.1. */
  permissions: Record<P, PermissionDef<NoInfer<T>>>;
  /** Rechtegruppen in Anzeigereihenfolge; reservierte ergänzt der Baukasten. */
  groups: readonly GroupDef[];
  /** Rollen = Beziehungsnamen. `'*'` nur bei `org-admin` (darf fehlen, wird ergänzt). */
  roles: Record<R, RoleDef<NoInfer<P> | ReservedPermission>>;
  scopes?: Record<string, { text: string; permissions: readonly (NoInfer<P> | ReservedPermission)[] }>;
  /** Orte. `org` darf fehlen (wird mit `roles: '*'` ergänzt). Ohne `types` gibt es nur Rollen an `org`. */
  types?: Record<T, TypeDef<NoInfer<P> | ReservedPermission, NoInfer<R> | typeof ADMIN_ROLE, NoInfer<T>>>;
  /** Labels der Stufen 0, 1, 2; Standard «intern», «vertraulich», «streng vertraulich». */
  classifications?: readonly [string, string, string];
  /** Fähigkeit → Recht je Typ (Felder `can` der Antworten). */
  capabilities?: Partial<Record<NoInfer<T> | 'org', Record<string, NoInfer<P> | ReservedPermission>>>;
  mcpTools?: Record<string, McpToolDef<NoInfer<P> | ReservedPermission>>;
  features?: { members?: boolean; tenantSettings?: boolean; audit?: boolean };
}

export class ModelError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) { super(`Modell ungültig:\n  - ${errors.join('\n  - ')}`); this.errors = errors; }
}

export interface PermissionInfo { key: string; label: string; group: string; description: string; resources: string[]; adminOnly: boolean; personOnly: boolean }

/** Typ (Ort) nach der Prüfung. `relations`: Rollen, `member` und `owner`, wo zulässig. */
export interface TypeInfo<P extends string = string> {
  key: string; label: string; parent: string | null; self: boolean;
  roles: readonly string[]; relations: readonly string[];
  leaf: boolean; classified: boolean; owner: boolean; member: boolean;
  scope: { relation: string } | null;
  /** Leserecht (an `org`: `tenant:read`), Schreibrecht (null, wo nicht deklariert). */
  read: P | null; write: P | null;
}

/** Antwort von `GET /v1/authz/catalog` (Kap. 9.5). */
export interface AuthzCatalogJson {
  permissions: { key: string; label: string; group: string; description: string; resources: string[]; adminOnly: boolean; personOnly?: true }[];
  groups: { key: string; label: string; match?: string }[];
  roles: { key: string; label: string; description: string; permissions: string[]; adminOnly: boolean }[];
  scopes: { key: string; text: string; permissions: string[] }[];
  types: {
    key: string; label: string; parent: string | null; self?: true; roles: string[]; relations: string[];
    leaf?: true; classified?: true; owner?: true; scope?: { relation: string }; read?: string; write?: string;
  }[];
  classifications: { level: Level; label: string }[];
  mcpTools: { name: string; title: string; permission: string; scope: string | null; readOnly: boolean }[];
}

/** Stichwort einer Gruppe als regulärer Ausdruck (Gross/klein egal); Texte werden wörtlich gesucht. */
function matcher(m: GroupDef['match']): RegExp | null {
  if (m === undefined) return null;
  // Ohne g und y: sonst hinge das Ergebnis vom lastIndex der vorigen Rolle ab
  if (m instanceof RegExp) return new RegExp(m.source, `${m.flags.replace(/[gyi]/g, '')}i`);
  const words = (typeof m === 'string' ? [m] : [...m]).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(typeof m === 'string' && m === '.' ? '.' : words.join('|'), 'i');
}

export interface Model<P extends string = string, R extends string = string, T extends string = string> {
  readonly product: string;
  /** Rechte in Reihenfolge. */
  readonly permissions: readonly P[];
  readonly info: ReadonlyMap<P, PermissionInfo>;
  readonly groups: readonly { key: string; label: string; match: RegExp | null }[];
  /** Rollen in Reihenfolge, `org-admin` zuerst (mit allen Rechten). */
  readonly roles: ReadonlyMap<R, { label: string; description: string; permissions: readonly P[] }>;
  readonly scopes: ReadonlyMap<string, { text: string; permissions: readonly P[] }>;
  /** Typen in Reihenfolge, `org` zuerst. */
  readonly types: ReadonlyMap<T, TypeInfo<P>>;
  /** Blatt-Typ (höchstens einer) oder null. */
  readonly leaf: TypeInfo<P> | null;
  readonly classifications: readonly [string, string, string];
  readonly capabilities: Readonly<Partial<Record<T, Readonly<Record<string, P>>>>>;
  readonly mcpTools: Readonly<Record<string, McpToolDef<P>>>;
  /** Rechte, die bei keiner Rolle ausser `org-admin` stehen (ihre Rolle vergibt nur `platform-admin`). */
  readonly adminOnly: ReadonlySet<P>;
  readonly features: { members: boolean; tenantSettings: boolean; audit: boolean };
  /** SOLL-Abweichungen (z. B. fehlender Lese-Scope). */
  readonly warnings: readonly string[];
  isPermission(v: string): v is P;
  isRole(v: string): v is R;
  isType(v: string): v is T;
  permissionsForRoles(roles: readonly string[]): Set<P>;
  permissionsForScopes(scopes: readonly string[]): Set<P>;
  /** Rechte einer Relation an einem Typ: Rolle → ihre Rechte; `owner` → Rechte mit dem Typ in `resources`; sonst keine. */
  permissionsOf(relation: string, type: string): Set<P>;
  /** Engster Scope, der das Recht freigibt; null für den Lese-Scope `<product>:read` und Rechte ohne Scope. */
  scopeForPermission(p: P): string | null;
  /** «Objekte ändern» (object:write) für Meldungen. */
  permissionText(p: string): string;
  /** Rollen, `member` und `owner`, die an diesem Typ hängen dürfen (leer bei unbekanntem Typ). */
  relationsAt(type: string): readonly string[];
  /** Rollen, die das Recht enthalten (Reihenfolge des Modells). */
  rolesWith(permission: string): R[];
  /** Alle Relationen, die irgendwo hängen dürfen (CHECK von `authz_tuple`). */
  allRelations(): string[];
  toJSON(): AuthzCatalogJson;
  /** Inhalt von `infra/keycloak/platform.json` für das Realm-Modul: nur Scopes (O4). */
  platformJson(): string;
}

/** Typen des Modells der App für die Signaturen des Pakets: `declare module '@vollholz/iam' { interface Register { model: typeof model } }`. */
export interface Register {}
export type RegisteredPermission = Register extends { model: Model<infer P, any, any> } ? P : string;

export function defineModel<const P extends string, const R extends string, const T extends string = never>(
  input: ModelInput<P, R, T>,
): Model<P | ReservedPermission, R | typeof ADMIN_ROLE, T | typeof ORG> {
  type Q = P | ReservedPermission;
  type RR = R | typeof ADMIN_ROLE;
  type TT = T | typeof ORG;
  const errors: string[] = [], warnings: string[] = [];
  const features = { members: true, tenantSettings: false, audit: false, ...input.features };
  const typesIn = Object.entries(input.types ?? {}) as [string, TypeDef][];
  const hasPlaces = typesIn.some(([k]) => k !== ORG);

  // ---------------------------------------------------------------- Typen (org zuerst)
  const orgIn = (input.types as Record<string, TypeDef> | undefined)?.[ORG];
  if (orgIn) {
    if (orgIn.label !== 'Organisation') errors.push(`Typ «org»: Label «${orgIn.label}» statt «Organisation» (reserviert)`);
    if (orgIn.parent) errors.push('Typ «org» ist die Wurzel und hat keinen parent (M4)');
    if (orgIn.roles !== '*') errors.push('Typ «org»: roles muss «*» sein (jede Rolle darf an der Organisation hängen)');
    for (const [k, v] of [['leaf', orgIn.leaf], ['self', orgIn.self], ['scope', orgIn.scope], ['relations', orgIn.relations?.length]] as const) {
      if (v) errors.push(`Typ «org»: ${k} nicht erlaubt`);
    }
    if (orgIn.owner) errors.push('Typ «org»: owner nicht erlaubt (M9)');
    if (orgIn.classified) errors.push('Typ «org»: classified nicht erlaubt (M9)');
    if (orgIn.read && orgIn.read !== 'tenant:read') errors.push('Typ «org»: read ist immer «tenant:read»');
  }
  const typeDefs: [string, TypeDef][] = [[ORG, { label: 'Organisation', roles: '*' }], ...typesIn.filter(([k]) => k !== ORG)];
  const typeKeys = new Set(typeDefs.map(([k]) => k));
  for (const [k, t] of typeDefs) {
    if (!NAME_KEY.test(k)) errors.push(`Typ «${k}»: Schlüssel nicht ${NAME_KEY} (M1)`);
    if (!t.label?.trim()) errors.push(`Typ «${k}»: Label fehlt`);
  }

  // ---------------------------------------------------------------- Rechte mit reservierten
  const own = Object.entries(input.permissions) as [string, PermissionDef][];
  const reservedWanted: ReservedPermission[] = ['tenant:read'];
  if (features.tenantSettings) reservedWanted.push('tenant:admin');
  if (features.members) reservedWanted.push('members:admin');
  if (hasPlaces) reservedWanted.push('access:admin');
  if (features.audit) reservedWanted.push('audit:read');
  const given = new Set(own.map(([k]) => k));
  const front: [string, PermissionDef][] = [], back: [string, PermissionDef][] = [];
  for (const k of reservedWanted) {
    if (given.has(k)) continue;
    (k.startsWith('tenant:') ? front : back).push([k, { ...RESERVED_PERMISSIONS[k] }]);
  }
  // Reservierte Rechte der App: Label, Gruppe und (ohne eigene) Beschreibung aus dem Baukasten
  const reservedDef = (k: string, d: PermissionDef): PermissionDef => {
    const r = (RESERVED_PERMISSIONS as Record<string, { label: string; group: string; description: string }>)[k];
    return r ? { ...d, label: d.label ?? r.label, group: d.group ?? r.group, description: d.description ?? r.description } : d;
  };
  const ordered: [string, PermissionDef][] = [...front, ...own.map(([k, d]): [string, PermissionDef] => [k, reservedDef(k, d)]), ...back];
  const permissions = ordered.map(([k]) => k as Q);
  if (new Set(permissions).size !== permissions.length) errors.push('Rechte mehrfach');
  for (const [k, d] of ordered) {
    const r = (RESERVED_PERMISSIONS as Record<string, { label: string; group: string }>)[k];
    if (r && d.label !== r.label) errors.push(`Recht «${k}»: Label «${d.label}» statt «${r.label}» (reserviert, M1)`);
    if (r && d.group !== r.group) errors.push(`Recht «${k}»: Gruppe «${d.group}» statt «${r.group}» (reserviert, M1)`);
  }
  for (const k of ['acl:read', 'acl:admin', 'access:read']) if (given.has(k)) errors.push(`Recht «${k}» entfällt (Kap. 8.1); Panel lesen über das Leserecht der Ressource, ändern mit access:admin`);

  // ---------------------------------------------------------------- Gruppen mit reservierten
  const usedGroups = new Set(ordered.map(([, d]) => d.group));
  const groupsIn = input.groups.map(g => ({ ...g, label: g.label ?? RESERVED_GROUPS[g.key]?.label }));
  const haveGroup = new Set(groupsIn.map(g => g.key));
  const gFront: GroupDef[] = [], gBack: GroupDef[] = [];
  for (const [k, r] of Object.entries(RESERVED_GROUPS)) {
    if (haveGroup.has(k) || !usedGroups.has(k)) continue;
    (k === 'tenant' ? gFront : gBack).push({ key: k, label: r.label, match: r.match });
  }
  const groupDefs = [...gFront, ...groupsIn, ...gBack];
  const groups = groupDefs.map(g => ({ key: g.key, label: g.label ?? '', match: matcher(g.match ?? RESERVED_GROUPS[g.key]?.match), source: g.match ?? RESERVED_GROUPS[g.key]?.match }));
  const groupKeys = new Set<string>();
  for (const g of groups) {
    if (groupKeys.has(g.key)) errors.push(`Gruppe «${g.key}» mehrfach`);
    // Die Antwort enthält nur die Quelle (Gross/klein egal); andere Flags gingen dort verloren
    if (g.source instanceof RegExp && /[^giy]/.test(g.source.flags)) errors.push(`Gruppe «${g.key}»: Stichwörter mit Flags «${g.source.flags}»; erlaubt ist nur i (g und y werden ignoriert)`);
    groupKeys.add(g.key);
    if (!NAME_KEY.test(g.key)) errors.push(`Gruppe «${g.key}»: Schlüssel nicht ${NAME_KEY} (M1)`);
    if (!g.label?.trim()) errors.push(`Gruppe «${g.key}»: Label fehlt`);
    const r = RESERVED_GROUPS[g.key];
    if (r && g.label !== r.label) errors.push(`Gruppe «${g.key}»: Label «${g.label}» statt «${r.label}» (reserviert, M1)`);
  }

  // ---------------------------------------------------------------- Rechte prüfen (M1, M2)
  const info = new Map<Q, PermissionInfo>();
  for (const [k, d] of ordered) {
    if (!PERMISSION_KEY.test(k)) errors.push(`Recht «${k}»: Schlüssel nicht <bereich>:<verb> (${PERMISSION_KEY}, M1)`);
    if (!d.label?.trim()) errors.push(`Recht «${k}»: Label fehlt (M2)`);
    if (!d.description?.trim()) errors.push(`Recht «${k}»: Beschreibung fehlt (M2)`);
    if (!d.group) errors.push(`Recht «${k}»: Gruppe fehlt (M2)`);
    else if (!groupKeys.has(d.group)) errors.push(`Recht «${k}»: Gruppe «${d.group}» nicht im Modell (M2)`);
    const resources = [...(d.resources ?? [ORG])] as string[];
    if (!resources.includes(ORG)) errors.push(`Recht «${k}»: resources ohne «org» (M2)`);
    for (const r of resources) if (!typeKeys.has(r)) errors.push(`Recht «${k}»: Typ «${r}» in resources nicht im Modell (M2)`);
    info.set(k as Q, { key: k, label: d.label ?? '', group: d.group ?? '', description: d.description ?? '', resources: [...new Set(resources)], adminOnly: false, personOnly: d.scope === false || PERSON_ONLY.includes(k) });
  }
  const isPermission = (v: string): v is Q => info.has(v as Q);

  // ---------------------------------------------------------------- Rollen (M1, M3; org-admin zuerst, alle Rechte)
  const rolesIn = Object.entries(input.roles) as [string, RoleDef][];
  const adminIn = (input.roles as Record<string, RoleDef | undefined>)[ADMIN_ROLE];
  if (adminIn) {
    if (adminIn.label !== ADMIN_LABEL) errors.push(`Rolle «${ADMIN_ROLE}»: Label «${adminIn.label}» statt «${ADMIN_LABEL}» (reserviert, M1)`);
    if (adminIn.permissions !== '*') errors.push(`Rolle «${ADMIN_ROLE}»: permissions muss «*» sein (M3)`);
  }
  // Labels der Rechtegruppen in Anzeigereihenfolge, das letzte mit «und»: «A, B und C»
  const groupNames = (perms: readonly string[]) => {
    const used = new Set(perms.map(p => info.get(p as Q)?.group));
    const labels = groups.filter(g => used.has(g.key)).map(g => g.label);
    return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} und ${labels.at(-1)}` : labels.join('');
  };
  const adminDescription = adminIn?.description ?? `Verwaltet die Organisation vollständig: ${groupNames(permissions)}. Enthält alle anderen Rollen.`;
  const roles = new Map<string, { label: string; description: string; permissions: readonly Q[] }>();
  roles.set(ADMIN_ROLE, { label: ADMIN_LABEL, description: adminDescription, permissions: [...permissions] });
  for (const [key, r] of rolesIn) {
    if (key === ADMIN_ROLE) continue;
    if (!NAME_KEY.test(key)) errors.push(`Rolle «${key}»: Schlüssel nicht ${NAME_KEY} (M1)`);
    if (key === PLATFORM_ADMIN_ROLE || key === MEMBER || key === OWNER) errors.push(`Rolle «${key}»: reservierter Name, kein Rollenschlüssel (M1)`);
    if (!r.label?.trim()) errors.push(`Rolle «${key}»: Label fehlt (M3)`);
    if (!r.description?.trim()) errors.push(`Rolle «${key}»: Beschreibung fehlt (M3)`);
    if (r.permissions === '*') { errors.push(`Rolle «${key}»: «*» nur bei ${ADMIN_ROLE} (M3)`); continue; }
    if (!r.permissions.length) errors.push(`Rolle «${key}»: ohne Rechte (M3)`);
    for (const p of r.permissions) if (!isPermission(p)) errors.push(`Rolle «${key}»: Recht «${p}» nicht im Modell (M3)`);
    roles.set(key, { label: r.label, description: r.description, permissions: [...new Set(r.permissions.filter(isPermission))] });
  }
  // Beschreibung nennt jede Rechtegruppe der Rolle (Stichwörter der Gruppen)
  for (const [key, r] of roles) {
    for (const g of new Set(r.permissions.map(p => info.get(p)!.group))) {
      const m = groups.find(x => x.key === g)?.match;
      if (!m || m.test(r.description)) continue;
      errors.push(key === ADMIN_ROLE && !adminIn?.description
        ? `Rolle «${key}»: die erzeugte Beschreibung nennt die Rechtegruppe «${g}» nicht (Stichwort ${m}, Label «${groups.find(x => x.key === g)?.label}»); eigene Beschreibung für ${ADMIN_ROLE} angeben (M3)`
        : `Rolle «${key}»: Beschreibung nennt die Rechtegruppe «${g}» nicht (Stichwort ${m}, M3)`);
    }
  }
  const adminOnly = new Set(permissions.filter(p => ![...roles].some(([k, r]) => k !== ADMIN_ROLE && r.permissions.includes(p))));
  for (const p of adminOnly) info.get(p)!.adminOnly = true;

  // ---------------------------------------------------------------- Typen prüfen (M4–M9)
  const types = new Map<string, TypeInfo<Q>>();
  for (const [key, t] of typeDefs) {
    const isOrg = key === ORG;
    if (!isOrg) {
      if (!t.parent) errors.push(`Typ «${key}»: parent fehlt (M4)`);
      else if (!typeKeys.has(t.parent)) errors.push(`Typ «${key}»: parent «${t.parent}» nicht im Modell (M4)`);
      if (t.self !== undefined && t.self !== key) errors.push(`Typ «${key}»: self nur gleich dem eigenen Schlüssel (M4)`);
      if (t.roles === '*') errors.push(`Typ «${key}»: roles «*» nur bei org (M5)`);
    }
    const roleList = t.roles === '*' ? [...roles.keys()] : [...t.roles];
    for (const r of roleList) {
      if (!roles.has(r)) errors.push(`Typ «${key}»: Rolle «${r}» nicht im Modell (M5)`);
      else if (r === ADMIN_ROLE && !isOrg) errors.push(`Typ «${key}»: ${ADMIN_ROLE} nur an org (M5)`);
    }
    for (const rel of t.relations ?? []) {
      if (rel !== MEMBER) errors.push(`Typ «${key}»: Beziehung «${rel}» nicht zulässig, nur «member» (M8)`);
      if (roles.has(rel)) errors.push(`Typ «${key}»: Beziehung «${rel}» ist ein Rollenschlüssel (M8)`);
    }
    const member = (t.relations ?? []).includes(MEMBER);
    const relations = [...roleList.filter(r => roles.has(r)), ...(member ? [MEMBER] : []), ...(t.owner && !isOrg ? [OWNER] : [])];
    const read = (isOrg ? 'tenant:read' : t.read ?? null) as Q | null;
    if (!isOrg) {
      if (!t.read) errors.push(`Typ «${key}»: read fehlt (M7)`);
      if ((t.leaf || t.scope) && !t.write) errors.push(`Typ «${key}»: write fehlt (Pflicht bei leaf und scope, M7)`);
      for (const [f, p] of [['read', t.read], ['write', t.write]] as const) {
        if (!p) continue;
        if (!isPermission(p)) errors.push(`Typ «${key}»: ${f} «${p}» nicht im Modell (M7)`);
        else if (!info.get(p)!.resources.includes(key)) errors.push(`Typ «${key}»: ${f} «${p}» hat «${key}» nicht in resources (M7)`);
      }
    }
    if (t.scope && (!t.scope.relation?.trim() || t.scope.via !== 'reference')) errors.push(`Typ «${key}»: scope braucht via «reference» und eine relation`);
    types.set(key, {
      key, label: t.label, parent: isOrg ? null : t.parent ?? null, self: !isOrg && t.self === key,
      roles: roleList.filter(r => roles.has(r)), relations, leaf: !!t.leaf, classified: !!t.classified && !isOrg, owner: !!t.owner && !isOrg, member,
      scope: t.scope ? { relation: t.scope.relation } : null, read, write: (t.write ?? null) as Q | null,
    });
  }
  // Kette kreisfrei bis org (M4)
  for (const key of typeKeys) {
    const seen = new Set<string>();
    let cur: string | null = key;
    while (cur && cur !== ORG) {
      if (seen.has(cur)) { errors.push(`Typ «${key}»: Kette über parent hat einen Kreis (M4)`); break; }
      seen.add(cur);
      cur = types.get(cur)?.parent ?? null;
    }
  }
  // Blatt (M6)
  const leaves = [...types.values()].filter(t => t.leaf);
  if (leaves.length > 1) errors.push(`Höchstens ein Blatt-Typ je Modell (M6): ${leaves.map(t => t.key).join(', ')}`);
  for (const l of leaves) {
    const children = [...types.values()].filter(t => t.parent === l.key).map(t => t.key);
    if (children.length) errors.push(`Typ «${l.key}» ist ein Blatt, aber Typ ${children.map(c => `«${c}»`).join(', ')} hat ihn als parent (M6)`);
    if (l.self) errors.push(`Typ «${l.key}» ist ein Blatt und kann keine Vorfahren desselben Typs haben (M6)`);
  }

  // ---------------------------------------------------------------- Scopes (M10)
  const scopes = new Map<string, { text: string; permissions: readonly Q[] }>();
  for (const [key, s] of Object.entries(input.scopes ?? {})) {
    if (!PERMISSION_KEY.test(key)) errors.push(`Scope «${key}»: Schlüssel nicht <bereich>:<verb> (${PERMISSION_KEY}, M1)`);
    if (!s.text?.trim()) errors.push(`Scope «${key}»: Text fehlt (M10)`);
    if (!s.permissions.length) errors.push(`Scope «${key}»: ohne Rechte (M10)`);
    for (const p of s.permissions) {
      if (!isPermission(p)) errors.push(`Scope «${key}»: Recht «${p}» nicht im Modell (M10)`);
      else if (info.get(p)!.personOnly) errors.push(`Scope «${key}» enthält «${p}» (nur für Personen, in keinem Scope, M10)`);
    }
    scopes.set(key, { text: s.text, permissions: s.permissions.filter(isPermission) });
  }
  const readScope = `${input.product}:read`;
  if (!scopes.has(readScope)) warnings.push(`Lese-Scope «${readScope}» fehlt`);

  // ---------------------------------------------------------------- Fähigkeiten, MCP-Werkzeuge (M11)
  const capabilities: Record<string, Record<string, Q>> = {};
  for (const [type, caps] of Object.entries(input.capabilities ?? {}) as [string, Record<string, string>][]) {
    if (!typeKeys.has(type)) errors.push(`Fähigkeiten: Typ «${type}» nicht im Modell (M11)`);
    for (const [cap, p] of Object.entries(caps)) if (!isPermission(p)) errors.push(`Fähigkeit ${type}.${cap}: Recht «${p}» nicht im Modell (M11)`);
    capabilities[type] = caps as Record<string, Q>;
  }
  const mcpTools = (input.mcpTools ?? {}) as Record<string, McpToolDef<Q>>;
  for (const [name, t] of Object.entries(mcpTools)) {
    if (!isPermission(t.permission)) errors.push(`MCP-Werkzeug «${name}»: Recht «${t.permission}» nicht im Modell (M11)`);
    if (!t.title?.trim()) errors.push(`MCP-Werkzeug «${name}»: Titel fehlt (M11)`);
  }

  // ---------------------------------------------------------------- Stufen (M12)
  const classifications = (input.classifications ?? CLASSIFICATIONS) as readonly [string, string, string];
  if (classifications.length !== 3 || classifications.some(c => typeof c !== 'string' || !c.trim())) errors.push('classifications: genau drei nicht leere Labels (M12)');

  if (errors.length) throw new ModelError(errors);

  const permissionsForRoles = (rs: readonly string[]) => {
    const out = new Set<Q>();
    for (const r of rs) for (const p of roles.get(r)?.permissions ?? []) out.add(p);
    return out;
  };
  const permissionsForScopes = (ss: readonly string[]) => {
    const out = new Set<Q>();
    for (const s of ss) for (const p of scopes.get(s)?.permissions ?? []) out.add(p);
    return out;
  };
  const ownerPerms = new Map<string, Set<Q>>();
  for (const t of types.values()) if (t.owner) ownerPerms.set(t.key, new Set(permissions.filter(p => info.get(p)!.resources.includes(t.key))));
  const permissionsOf = (relation: string, type: string): Set<Q> => {
    if (relation === OWNER) return new Set(ownerPerms.get(type) ?? []);
    if (relation === MEMBER) return new Set();
    return permissionsForRoles([relation]);
  };
  const scopeForPermission = (p: Q): string | null => {
    const scope = [...scopes].filter(([, s]) => s.permissions.includes(p)).sort((a, b) => a[1].permissions.length - b[1].permissions.length)[0]?.[0];
    return scope && scope !== readScope ? scope : null;
  };
  const permissionText = (p: string) => `«${info.get(p as Q)?.label ?? p}» (${p})`;
  const leaf = leaves[0] ?? null;
  const allRelations = () => [...new Set([...roles.keys(), ...[...types.values()].flatMap(t => t.relations)])];

  return {
    product: input.product, permissions, info, groups: groups.map(({ key, label, match }) => ({ key, label, match })),
    roles: roles as Map<RR, { label: string; description: string; permissions: readonly Q[] }>, scopes,
    types: types as Map<TT, TypeInfo<Q>>, leaf, classifications, capabilities: capabilities as Partial<Record<TT, Record<string, Q>>>, mcpTools, adminOnly, features, warnings,
    isPermission, isRole: (v: string): v is RR => roles.has(v), isType: (v: string): v is TT => types.has(v),
    permissionsForRoles, permissionsForScopes, permissionsOf, scopeForPermission, permissionText,
    relationsAt: type => types.get(type)?.relations ?? [],
    rolesWith: perm => [...roles].filter(([, r]) => r.permissions.includes(perm as Q)).map(([k]) => k as RR),
    allRelations,
    toJSON: () => ({
      permissions: permissions.map(k => {
        const i = info.get(k)!;
        return { key: i.key, label: i.label, group: i.group, description: i.description, resources: i.resources, adminOnly: i.adminOnly, ...(i.personOnly ? { personOnly: true as const } : {}) };
      }),
      groups: groups.map(g => ({ key: g.key, label: g.label, ...(g.match ? { match: g.match.source } : {}) })),
      roles: [...roles].map(([key, r]) => ({ key, label: r.label, description: r.description, permissions: [...r.permissions], adminOnly: key === ADMIN_ROLE })),
      scopes: [...scopes].map(([key, s]) => ({ key, text: s.text, permissions: [...s.permissions] })),
      types: [...types.values()].map(t => ({
        key: t.key, label: t.label, parent: t.parent, ...(t.self ? { self: true as const } : {}), roles: [...t.roles], relations: [...t.relations],
        ...(t.leaf ? { leaf: true as const } : {}), ...(t.classified ? { classified: true as const } : {}), ...(t.owner ? { owner: true as const } : {}),
        ...(t.scope ? { scope: { relation: t.scope.relation } } : {}), ...(t.read ? { read: t.read } : {}), ...(t.write ? { write: t.write } : {}),
      })),
      classifications: classifications.map((label, level) => ({ level: level as Level, label })),
      mcpTools: Object.entries(mcpTools).map(([name, t]) => ({ name, title: t.title, permission: t.permission, scope: scopeForPermission(t.permission), readOnly: t.readOnly })),
    }),
    platformJson: () => `${JSON.stringify({ scopes: [...scopes.keys()] }, null, 2)}\n`,
  };
}
