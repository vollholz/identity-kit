/**
 * Rechtekatalog der App (Spezifikation Kap. 7.2, 8; Entwurf Kap. 4, 13.1; Mechanik aus Assets `authz/permissions.ts`).
 *
 * Die App beschreibt Rechte, Gruppen, Rollen, Scopes, Ressourcentypen, Fähigkeiten und MCP-Werkzeuge an einer Stelle;
 * `defineCatalog` ergänzt die reservierten Namen (Kap. 8.1), gibt `org-admin` alle Rechte, prüft die Regeln und bricht
 * bei Verstössen mit allen Befunden ab (`CatalogError`). Daraus entstehen die Antwort von `GET /v1/authz/catalog`
 * (`toJSON`), `infra/keycloak/platform.json` (`platformJson`) und die Hilfen der Entscheidung.
 *
 * Reihenfolge: wie in der Eingabe (die App bestimmt sie); `org-admin` steht zuerst unter den Rollen, `tenant` zuerst
 * unter den Ressourcentypen. Fehlt Reserviertes, wird es ergänzt: Rechte `tenant:*` vorne, die übrigen hinten; Gruppe
 * `tenant` vorne, die übrigen hinten.
 */

/** Rolle mit allen Rechten (Kap. 8.1). */
export const ADMIN_ROLE = 'org-admin';
export const ADMIN_LABEL = 'Organisations-Admin';
/** Präfix eigener Rollen der Organisationen (Kap. 8.3). */
export const CUSTOM_ROLE_PREFIX = 'c-';
export const isCustomRole = (key: string) => key.startsWith(CUSTOM_ROLE_PREFIX);
/** Realm-Rolle der Plattform-Administration; keine Rolle des Katalogs. */
export const PLATFORM_ADMIN_ROLE = 'platform-admin';

const PERMISSION_KEY = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const NAME_KEY = /^[a-z][a-z0-9-]*$/;

export interface PermissionDef<R extends string = string> {
  label: string;
  group: string;
  description: string;
  /** Ressourcentypen, auf denen eine Zugriffsregel für das Recht wirkt (mit `tenant`); ohne Zugriffsregeln `['tenant']`. */
  resources?: readonly R[];
  /** `false`: nur für Personen, in keinem Scope (Auflage 8; `members:admin` immer). */
  scope?: false;
}

export interface GroupDef {
  key: string;
  label: string;
  /** Stichwort(e) für die Beschreibung jeder Rolle mit Rechten dieser Gruppe (Gross/klein egal); ohne: keine Prüfung. */
  match?: string | RegExp | readonly string[];
}

export interface RoleDef<P extends string = string> { label: string; description: string; permissions: readonly P[] }

export interface ResourceDef { label: string; /** Blatt der Kette: dort nie `grant` (Kap. 7.1). */ leaf?: boolean }

export interface McpToolDef<P extends string = string> { title: string; permission: P; readOnly: boolean }

export interface CatalogInput<P extends string = string> {
  /** Technischer Name des Produkts (Lese-Scope `<product>:read`). */
  product: string;
  permissions: Record<P, PermissionDef>;
  groups: readonly GroupDef[];
  /** Vordefinierte Rollen; `org-admin` darf mit Beschreibung dabei sein (Rechte bekommt es immer alle). */
  roles: Record<string, RoleDef<P | string>>;
  scopes?: Record<string, { text: string; permissions: readonly (P | string)[] }>;
  /** Ressourcentypen der Zugriffsregeln (ohne oder mit `tenant`); fehlt es, gibt es keine Zugriffsregeln (Kap. 8.2). */
  resources?: Record<string, ResourceDef>;
  /** Fähigkeit → Recht je Ressourcentyp (Felder `can` der Antworten). */
  capabilities?: Record<string, Record<string, P | string>>;
  mcpTools?: Record<string, McpToolDef<P | string>>;
  features?: { members?: boolean; tenantSettings?: boolean; audit?: boolean };
}

/** Reservierte Rechte (Kap. 8.1) mit Label, Gruppe und Standardbeschreibung. */
export const RESERVED_PERMISSIONS = {
  'tenant:read': { label: 'Organisation lesen', group: 'tenant', description: 'Name und Einstellungen der Organisation sehen.' },
  'tenant:admin': { label: 'Organisation verwalten', group: 'tenant', description: 'Name und Einstellungen der Organisation ändern.' },
  'members:admin': { label: 'Mitglieder und Rollen verwalten', group: 'members', description: 'Mitglieder einladen und entfernen, Rollen vergeben, eigene Rollen anlegen, Anmeldung der Organisation einrichten, Maschinen-Clients freigeben.' },
  'acl:read': { label: 'Zugriff lesen', group: 'access', description: 'Zugriffsregeln und wirksame Rechte sehen.' },
  'acl:admin': { label: 'Zugriff verwalten', group: 'access', description: 'Zugriffsregeln anlegen und löschen.' },
  'audit:read': { label: 'Protokoll lesen', group: 'audit', description: 'Das Audit-Protokoll durchsuchen und prüfen.' },
} as const;

/** Reservierte Rechtegruppen mit Label und Stichwort für Rollenbeschreibungen. */
export const RESERVED_GROUPS: Record<string, { label: string; match: string }> = {
  tenant: { label: 'Organisation', match: '.' },
  members: { label: 'Mitglieder und Rollen', match: 'mitglieder' },
  access: { label: 'Zugriff', match: 'zugriff' },
  audit: { label: 'Protokoll', match: 'protokoll' },
};

export class CatalogError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) { super(`Rechtekatalog ungültig:\n  - ${errors.join('\n  - ')}`); this.errors = errors; }
}

export interface PermissionInfo { key: string; label: string; group: string; description: string; resources: string[]; adminOnly: boolean; personOnly: boolean }

/** Antwort von `GET /v1/authz/catalog`. `match` und `personOnly` ergänzen den Katalog von Assets (nur wo gesetzt). */
export interface AuthzCatalogJson {
  permissions: ({ key: string; label: string; group: string; description: string; resources: string[]; adminOnly: boolean; personOnly?: true })[];
  groups: { key: string; label: string; match?: string }[];
  roles: { key: string; label: string; description: string; permissions: string[]; adminOnly: boolean }[];
  scopes: { key: string; text: string; permissions: string[] }[];
  resourceTypes: { key: string; label: string }[];
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

export interface Catalog<P extends string = string> {
  readonly product: string;
  /** Rechte in Reihenfolge. */
  readonly permissions: readonly P[];
  readonly info: ReadonlyMap<P, PermissionInfo>;
  readonly groups: readonly { key: string; label: string; match: RegExp | null }[];
  readonly roles: ReadonlyMap<string, { label: string; description: string; permissions: readonly P[] }>;
  readonly scopes: ReadonlyMap<string, { text: string; permissions: readonly P[] }>;
  /** Ressourcentypen in Reihenfolge, `tenant` zuerst; nur `tenant` ohne Zugriffsregeln. */
  readonly resourceTypes: readonly { key: string; label: string; leaf: boolean }[];
  /** Gibt es Zugriffsregeln (Ressourcen in der Eingabe)? */
  readonly acl: boolean;
  readonly capabilities: Readonly<Record<string, Readonly<Record<string, P>>>>;
  readonly mcpTools: Readonly<Record<string, McpToolDef<P>>>;
  /** Rechte, die nur org-admin hat (nie freigebbar, nie in eigenen Rollen). */
  readonly adminOnly: ReadonlySet<P>;
  /** Rechte, die eigene Rollen enthalten dürfen. */
  readonly customRolePermissions: readonly P[];
  /** SOLL-Abweichungen (z. B. fehlender Lese-Scope). */
  readonly warnings: readonly string[];
  isPermission(v: string): v is P;
  /** Rechte der Rollen; eigene Rollen (`c-…`) aus `custom`, begrenzt auf customRolePermissions. */
  permissionsForRoles(roles: readonly string[], custom?: ReadonlyMap<string, readonly string[]>): Set<P>;
  permissionsForScopes(scopes: readonly string[]): Set<P>;
  /** Engster Scope, der das Recht freigibt; null für den Lese-Scope `<product>:read` und Rechte ohne Scope. */
  scopeForPermission(p: P): string | null;
  /** «Objekte ändern» (object:write) für Meldungen. */
  permissionText(p: string): string;
  toJSON(): AuthzCatalogJson;
  /** Inhalt von `infra/keycloak/platform.json` für das Realm-Modul. */
  platformJson(): string;
}

/** Typen des Katalogs der App für die Signaturen des Pakets: `declare module '@vollholz/iam' { interface Register { catalog: typeof catalog } }`. */
export interface Register {}
export type RegisteredPermission = Register extends { catalog: Catalog<infer P> } ? P : string;

export function defineCatalog<const P extends string>(input: CatalogInput<P>): Catalog<P | keyof typeof RESERVED_PERMISSIONS> {
  type Q = P | keyof typeof RESERVED_PERMISSIONS;
  const errors: string[] = [], warnings: string[] = [];
  const features = { members: true, tenantSettings: false, audit: false, ...input.features };
  const acl = !!input.resources;

  // ---------------------------------------------------------------- Ressourcentypen (tenant zuerst)
  const resIn = input.resources ?? {};
  if (resIn.tenant && resIn.tenant.label !== 'Organisation') errors.push(`Ressourcentyp «tenant»: Label «${resIn.tenant.label}» statt «Organisation»`);
  if (resIn.tenant?.leaf) errors.push('Ressourcentyp «tenant» ist die Wurzel, kein Blatt');
  const resourceTypes = [{ key: 'tenant', label: 'Organisation', leaf: false }, ...Object.entries(resIn).filter(([k]) => k !== 'tenant').map(([key, r]) => ({ key, label: r.label, leaf: !!r.leaf }))];
  for (const t of resourceTypes) {
    if (!NAME_KEY.test(t.key)) errors.push(`Ressourcentyp «${t.key}»: Schlüssel nicht ${NAME_KEY}`);
    if (!t.label?.trim()) errors.push(`Ressourcentyp «${t.key}»: Label fehlt`);
  }
  const typeKeys = new Set(resourceTypes.map(t => t.key));

  // ---------------------------------------------------------------- Rechte mit reservierten
  const own = Object.entries(input.permissions) as [string, PermissionDef][];
  const reservedWanted: (keyof typeof RESERVED_PERMISSIONS)[] = ['tenant:read'];
  if (features.tenantSettings) reservedWanted.push('tenant:admin');
  if (features.members) reservedWanted.push('members:admin');
  if (acl) reservedWanted.push('acl:read', 'acl:admin');
  if (features.audit) reservedWanted.push('audit:read');
  const defs = new Map<string, PermissionDef>(own);
  const front: [string, PermissionDef][] = [], back: [string, PermissionDef][] = [];
  for (const k of reservedWanted) {
    if (defs.has(k)) continue;
    const r = RESERVED_PERMISSIONS[k];
    (k.startsWith('tenant:') ? front : back).push([k, { ...r, resources: ['tenant'] }]);
  }
  const ordered: [string, PermissionDef][] = [...front, ...own, ...back];
  const permissions = ordered.map(([k]) => k as Q);
  if (new Set(permissions).size !== permissions.length) errors.push('Rechte mehrfach');
  for (const [k, d] of ordered) {
    const r = (RESERVED_PERMISSIONS as Record<string, { label: string; group: string }>)[k];
    if (r && d.label !== r.label) errors.push(`Recht «${k}»: Label «${d.label}» statt «${r.label}» (reserviert)`);
    if (r && d.group !== r.group) errors.push(`Recht «${k}»: Gruppe «${d.group}» statt «${r.group}» (reserviert)`);
  }

  // ---------------------------------------------------------------- Gruppen mit reservierten
  const usedGroups = new Set(ordered.map(([, d]) => d.group));
  const groupsIn = [...input.groups];
  const haveGroup = new Set(groupsIn.map(g => g.key));
  const gFront: GroupDef[] = [], gBack: GroupDef[] = [];
  for (const [k, r] of Object.entries(RESERVED_GROUPS)) {
    if (haveGroup.has(k) || !usedGroups.has(k)) continue;
    (k === 'tenant' ? gFront : gBack).push({ key: k, label: r.label, match: r.match });
  }
  const groupDefs = [...gFront, ...groupsIn, ...gBack];
  const groups = groupDefs.map(g => ({ key: g.key, label: g.label, match: matcher(g.match ?? RESERVED_GROUPS[g.key]?.match), source: g.match ?? RESERVED_GROUPS[g.key]?.match }));
  const groupKeys = new Set<string>();
  for (const g of groups) {
    if (groupKeys.has(g.key)) errors.push(`Gruppe «${g.key}» mehrfach`);
    groupKeys.add(g.key);
    if (!NAME_KEY.test(g.key)) errors.push(`Gruppe «${g.key}»: Schlüssel nicht ${NAME_KEY}`);
    if (!g.label?.trim()) errors.push(`Gruppe «${g.key}»: Label fehlt`);
    const r = RESERVED_GROUPS[g.key];
    if (r && g.label !== r.label) errors.push(`Gruppe «${g.key}»: Label «${g.label}» statt «${r.label}» (reserviert)`);
  }

  // ---------------------------------------------------------------- Rechte prüfen
  const info = new Map<Q, PermissionInfo>();
  for (const [k, d] of ordered) {
    if (!PERMISSION_KEY.test(k)) errors.push(`Recht «${k}»: Schlüssel nicht <bereich>:<verb> (${PERMISSION_KEY})`);
    if (!d.label?.trim()) errors.push(`Recht «${k}»: Label fehlt`);
    if (!d.description?.trim()) errors.push(`Recht «${k}»: Beschreibung fehlt`);
    if (!groupKeys.has(d.group)) errors.push(`Recht «${k}»: Gruppe «${d.group}» nicht im Katalog`);
    const resources = [...(d.resources ?? ['tenant'])];
    if (!resources.length) errors.push(`Recht «${k}»: ohne Ressourcentyp`);
    else if (!resources.includes('tenant')) errors.push(`Recht «${k}»: Ressourcentypen ohne «tenant»`);
    for (const r of resources) if (!typeKeys.has(r)) errors.push(`Recht «${k}»: Ressourcentyp «${r}» nicht im Katalog`);
    info.set(k as Q, { key: k, label: d.label, group: d.group, description: d.description, resources, adminOnly: false, personOnly: d.scope === false || k === 'members:admin' });
  }
  const isPermission = (v: string): v is Q => info.has(v as Q);

  // ---------------------------------------------------------------- Rollen (org-admin zuerst, alle Rechte)
  const rolesIn = Object.entries(input.roles);
  const adminIn = input.roles[ADMIN_ROLE];
  if (adminIn) {
    if (adminIn.label !== ADMIN_LABEL) errors.push(`Rolle «${ADMIN_ROLE}»: Label «${adminIn.label}» statt «${ADMIN_LABEL}» (reserviert)`);
    const missing = permissions.filter(p => !adminIn.permissions.includes(p));
    if (adminIn.permissions.length && missing.length) errors.push(`Rolle «${ADMIN_ROLE}» hat nicht alle Rechte (fehlen: ${missing.join(', ')}); Rechte weglassen, dann ergänzt sie der Katalog`);
  }
  const groupNames = (perms: readonly string[]) => [...new Set(perms.map(p => info.get(p as Q)?.group).filter(Boolean))].map(g => groups.find(x => x.key === g)?.label ?? g);
  const adminDescription = adminIn?.description ?? `Verwaltet die Organisation vollständig: ${groupNames(permissions).join(', ')}. Enthält alle anderen Rollen.`;
  const roles = new Map<string, { label: string; description: string; permissions: readonly Q[] }>();
  roles.set(ADMIN_ROLE, { label: ADMIN_LABEL, description: adminDescription, permissions: [...permissions] });
  for (const [key, r] of rolesIn) {
    if (key === ADMIN_ROLE) continue;
    if (!NAME_KEY.test(key)) errors.push(`Rolle «${key}»: Schlüssel nicht ${NAME_KEY} (wird Gruppenname, also nie «/»)`);
    if (isCustomRole(key)) errors.push(`Rolle «${key}»: Präfix «${CUSTOM_ROLE_PREFIX}» ist eigenen Rollen der Organisationen vorbehalten`);
    if (key === PLATFORM_ADMIN_ROLE) errors.push(`Rolle «${key}»: reserviert für die Realm-Rolle der Plattform-Administration`);
    if (!r.label?.trim()) errors.push(`Rolle «${key}»: Label fehlt`);
    if (!r.description?.trim()) errors.push(`Rolle «${key}»: Beschreibung fehlt`);
    if (!r.permissions.length) errors.push(`Rolle «${key}»: ohne Rechte`);
    for (const p of r.permissions) if (!isPermission(p)) errors.push(`Rolle «${key}»: Recht «${p}» nicht im Katalog`);
    roles.set(key, { label: r.label, description: r.description, permissions: [...new Set(r.permissions.filter(isPermission))] });
  }
  // Beschreibung nennt jede Rechtegruppe der Rolle (Stichwörter der Gruppen, Assets A7)
  for (const [key, r] of roles) {
    for (const g of new Set(r.permissions.map(p => info.get(p)!.group))) {
      const m = groups.find(x => x.key === g)?.match;
      if (m && !m.test(r.description)) errors.push(`Rolle «${key}»: Beschreibung nennt die Rechtegruppe «${g}» nicht (Stichwort ${m})`);
    }
  }
  const adminOnly = new Set(permissions.filter(p => ![...roles].some(([k, r]) => k !== ADMIN_ROLE && r.permissions.includes(p))));
  for (const p of adminOnly) info.get(p)!.adminOnly = true;
  const customRolePermissions = permissions.filter(p => !adminOnly.has(p));
  const customAllowed = new Set<string>(customRolePermissions);

  // ---------------------------------------------------------------- Scopes
  const scopes = new Map<string, { text: string; permissions: readonly Q[] }>();
  for (const [key, s] of Object.entries(input.scopes ?? {})) {
    if (!PERMISSION_KEY.test(key)) errors.push(`Scope «${key}»: Schlüssel nicht <bereich>:<verb> (${PERMISSION_KEY})`);
    if (!s.text?.trim()) errors.push(`Scope «${key}»: Text fehlt`);
    if (!s.permissions.length) errors.push(`Scope «${key}»: ohne Rechte`);
    for (const p of s.permissions) {
      if (!isPermission(p)) errors.push(`Scope «${key}»: Recht «${p}» nicht im Katalog`);
      else if (info.get(p)!.personOnly) errors.push(`Scope «${key}» enthält «${p}» (nur für Personen, in keinem Scope)`);
    }
    scopes.set(key, { text: s.text, permissions: s.permissions.filter(isPermission) });
  }
  const readScope = `${input.product}:read`;
  if (!scopes.has(readScope)) warnings.push(`Lese-Scope «${readScope}» fehlt`);

  // ---------------------------------------------------------------- Fähigkeiten, MCP-Werkzeuge
  const capabilities: Record<string, Record<string, Q>> = {};
  for (const [type, caps] of Object.entries(input.capabilities ?? {})) {
    if (!typeKeys.has(type)) errors.push(`Fähigkeiten: Ressourcentyp «${type}» nicht im Katalog`);
    for (const [cap, p] of Object.entries(caps)) if (!isPermission(p)) errors.push(`Fähigkeit ${type}.${cap}: Recht «${p}» nicht im Katalog`);
    capabilities[type] = caps as Record<string, Q>;
  }
  const mcpTools = (input.mcpTools ?? {}) as Record<string, McpToolDef<Q>>;
  for (const [name, t] of Object.entries(mcpTools)) {
    if (!isPermission(t.permission)) errors.push(`MCP-Werkzeug «${name}»: Recht «${t.permission}» nicht im Katalog`);
    if (!t.title?.trim()) errors.push(`MCP-Werkzeug «${name}»: Titel fehlt`);
  }

  if (errors.length) throw new CatalogError(errors);

  const permissionsForRoles = (rs: readonly string[], custom?: ReadonlyMap<string, readonly string[]>) => {
    const out = new Set<Q>();
    for (const r of rs) {
      if (roles.has(r)) for (const p of roles.get(r)!.permissions) out.add(p);
      // Tiefenverteidigung: eigene Rollen nie mit Rechten nur von org-admin, auch wenn die Datenbank mehr enthielte
      else if (isCustomRole(r)) for (const p of custom?.get(r) ?? []) if (customAllowed.has(p)) out.add(p as Q);
    }
    return out;
  };
  const permissionsForScopes = (ss: readonly string[]) => {
    const out = new Set<Q>();
    for (const s of ss) for (const p of scopes.get(s)?.permissions ?? []) out.add(p);
    return out;
  };
  const scopeForPermission = (p: Q): string | null => {
    const scope = [...scopes].filter(([, s]) => s.permissions.includes(p)).sort((a, b) => a[1].permissions.length - b[1].permissions.length)[0]?.[0];
    return scope && scope !== readScope ? scope : null;
  };
  const permissionText = (p: string) => `«${info.get(p as Q)?.label ?? p}» (${p})`;

  return {
    product: input.product, permissions, info, groups: groups.map(({ key, label, match }) => ({ key, label, match })), roles, scopes, resourceTypes, acl,
    capabilities, mcpTools, adminOnly, customRolePermissions, warnings, isPermission,
    permissionsForRoles, permissionsForScopes, scopeForPermission, permissionText,
    toJSON: () => ({
      permissions: permissions.map(k => {
        const i = info.get(k)!;
        return { key: i.key, label: i.label, group: i.group, description: i.description, resources: i.resources, adminOnly: i.adminOnly, ...(i.personOnly ? { personOnly: true as const } : {}) };
      }),
      groups: groups.map(g => ({ key: g.key, label: g.label, ...(g.match ? { match: g.match.source } : {}) })),
      roles: [...roles].map(([key, r]) => ({ key, label: r.label, description: r.description, permissions: [...permissionsForRoles([key])], adminOnly: key === ADMIN_ROLE })),
      scopes: [...scopes].map(([key, s]) => ({ key, text: s.text, permissions: [...s.permissions] })),
      resourceTypes: resourceTypes.map(({ key, label }) => ({ key, label })),
      mcpTools: Object.entries(mcpTools).map(([name, t]) => ({ name, title: t.title, permission: t.permission, scope: scopeForPermission(t.permission), readOnly: t.readOnly })),
    }),
    platformJson: () => `${JSON.stringify({ roles: Object.fromEntries([...roles].map(([k, r]) => [k, r.label])), scopes: [...scopes.keys()] }, null, 2)}\n`,
  };
}
