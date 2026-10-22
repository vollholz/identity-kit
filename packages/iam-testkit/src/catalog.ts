/**
 * Prüfung des Rechtekatalogs einer App gegen die Spezifikation (Kap. 7.2, 8): reservierte Namen mit festem Schlüssel,
 * Label und Gruppe, Schlüsselregeln für eigene Namen, Vollständigkeit (Labels, Beschreibungen, Texte, Verweise).
 *
 * Geprüft wird die Antwort von `GET /v1/authz/catalog` (sprachneutraler Vertrag): so gilt die Prüfung für jede App,
 * auch für Apps, die nicht mit dem Backend-Paket gebaut sind.
 */

/** `personOnly`: nur für Personen, in keinem Scope (ab 0.2.0 geprüft, wenn vorhanden). */
export interface CatalogPermission { key: string; label: string; group: string; description: string; resources: string[]; adminOnly?: boolean; personOnly?: boolean }
/** `match`: Stichwort(e) als regulärer Ausdruck (Gross/klein egal), das die Beschreibung jeder Rolle mit Rechten der Gruppe enthält (ab 0.2.0). */
export interface CatalogGroup { key: string; label: string; match?: string }
export interface CatalogRole { key: string; label: string; description: string; permissions: string[]; adminOnly?: boolean }
export interface CatalogScope { key: string; text: string; permissions: string[] }
/** Antwort von `GET /v1/authz/catalog` (weitere Felder wie `mcpTools` werden nicht geprüft). */
export interface AuthzCatalog {
  permissions: CatalogPermission[];
  groups: CatalogGroup[];
  roles: CatalogRole[];
  scopes: CatalogScope[];
  resourceTypes?: { key: string; label: string }[];
}

/** Reservierte Rolle (Spezifikation Kap. 8.1). */
export const ADMIN_ROLE = { key: 'org-admin', label: 'Organisations-Admin' } as const;

/** Reservierte Rechte mit Label und Gruppe; `required`: muss jede App haben (die übrigen, sobald sie das Recht nutzt). */
export const RESERVED_PERMISSIONS = [
  { key: 'tenant:read', label: 'Organisation lesen', group: 'tenant', required: true },
  { key: 'tenant:admin', label: 'Organisation verwalten', group: 'tenant', required: false },
  { key: 'members:admin', label: 'Mitglieder und Rollen verwalten', group: 'members', required: false },
  { key: 'acl:read', label: 'Zugriff lesen', group: 'access', required: false },
  { key: 'acl:admin', label: 'Zugriff verwalten', group: 'access', required: false },
  { key: 'audit:read', label: 'Protokoll lesen', group: 'audit', required: false },
] as const;

/** Reservierte Rechtegruppen mit Label. */
export const RESERVED_GROUPS: Record<string, string> = { tenant: 'Organisation', members: 'Mitglieder und Rollen', access: 'Zugriff', audit: 'Protokoll' };

/** Präfix eigener Rollen der Organisationen; keine Rolle des Katalogs beginnt damit. */
export const CUSTOM_ROLE_PREFIX = 'c-';
/** Realm-Rolle der Plattform-Administration; keine Rolle des Katalogs. */
export const PLATFORM_ADMIN_ROLE = 'platform-admin';

const PERMISSION_KEY = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const NAME_KEY = /^[a-z][a-z0-9-]*$/;

export interface CatalogCheck {
  /** Verstösse gegen MUSS-Regeln. */
  errors: string[];
  /** Abweichungen von SOLL-Regeln. */
  warnings: string[];
}

/**
 * @param o.product technischer Name der App; dann SOLL es den Lese-Scope `<product>:read` geben.
 * @param o.acl App nutzt Zugriffsregeln: dann MUSS es `acl:read`, `acl:admin` und den Ressourcentyp `tenant` geben.
 * @param o.members App verwaltet Mitglieder (Standard true): dann MUSS es `members:admin` geben.
 */
export function checkCatalog(c: AuthzCatalog, o: { product?: string; acl?: boolean; members?: boolean } = {}): CatalogCheck {
  const errors: string[] = [], warnings: string[] = [];
  const perms = new Map(c.permissions.map(p => [p.key, p]));
  const groups = new Map(c.groups.map(g => [g.key, g]));
  const roles = new Map(c.roles.map(r => [r.key, r]));
  const dup = (kind: string, keys: string[]) => { for (const k of new Set(keys.filter((x, i) => keys.indexOf(x) !== i))) errors.push(`${kind} «${k}» mehrfach`); };
  dup('Recht', c.permissions.map(p => p.key)); dup('Rolle', c.roles.map(r => r.key)); dup('Scope', c.scopes.map(s => s.key)); dup('Gruppe', c.groups.map(g => g.key));

  // ---------------------------------------------------------------- Schlüssel und Vollständigkeit
  for (const p of c.permissions) {
    if (!PERMISSION_KEY.test(p.key)) errors.push(`Recht «${p.key}»: Schlüssel nicht <bereich>:<verb> (${PERMISSION_KEY})`);
    if (!p.label?.trim()) errors.push(`Recht «${p.key}»: Label fehlt`);
    if (!p.description?.trim()) errors.push(`Recht «${p.key}»: Beschreibung fehlt`);
    if (!groups.has(p.group)) errors.push(`Recht «${p.key}»: Gruppe «${p.group}» nicht im Katalog`);
    if (c.resourceTypes) for (const r of p.resources ?? []) if (!c.resourceTypes.some(t => t.key === r)) errors.push(`Recht «${p.key}»: Ressourcentyp «${r}» nicht im Katalog`);
  }
  for (const g of c.groups) {
    if (!NAME_KEY.test(g.key)) errors.push(`Gruppe «${g.key}»: Schlüssel nicht ${NAME_KEY}`);
    if (!g.label?.trim()) errors.push(`Gruppe «${g.key}»: Label fehlt`);
  }
  for (const r of c.roles) {
    if (!NAME_KEY.test(r.key)) errors.push(`Rolle «${r.key}»: Schlüssel nicht ${NAME_KEY} (wird Gruppenname, also nie «/»)`);
    if (r.key.startsWith(CUSTOM_ROLE_PREFIX)) errors.push(`Rolle «${r.key}»: Präfix «${CUSTOM_ROLE_PREFIX}» ist eigenen Rollen der Organisationen vorbehalten`);
    if (r.key === PLATFORM_ADMIN_ROLE) errors.push(`Rolle «${r.key}»: reserviert für die Realm-Rolle der Plattform-Administration`);
    if (!r.label?.trim()) errors.push(`Rolle «${r.key}»: Label fehlt`);
    if (!r.description?.trim()) errors.push(`Rolle «${r.key}»: Beschreibung fehlt`);
    if (!r.permissions.length) errors.push(`Rolle «${r.key}»: ohne Rechte`);
    for (const p of r.permissions) if (!perms.has(p)) errors.push(`Rolle «${r.key}»: Recht «${p}» nicht im Katalog`);
    // Beschreibung nennt jede Rechtegruppe der Rolle (Stichwort `match` der Gruppe; ohne `match` keine Prüfung)
    for (const g of new Set(r.permissions.map(p => perms.get(p)?.group))) {
      const m = g ? groups.get(g)?.match : undefined;
      if (m === undefined) continue;
      let re: RegExp;
      try { re = new RegExp(m, 'i'); } catch { errors.push(`Gruppe «${g}»: Stichwort «${m}» ist kein regulärer Ausdruck`); continue; }
      if (!re.test(r.description ?? '')) errors.push(`Rolle «${r.key}»: Beschreibung nennt die Rechtegruppe «${g}» nicht (Stichwort ${m})`);
    }
  }
  for (const s of c.scopes) {
    if (!PERMISSION_KEY.test(s.key)) errors.push(`Scope «${s.key}»: Schlüssel nicht <bereich>:<verb> (${PERMISSION_KEY})`);
    if (!s.text?.trim()) errors.push(`Scope «${s.key}»: Text fehlt`);
    if (!s.permissions.length) errors.push(`Scope «${s.key}»: ohne Rechte`);
    for (const p of s.permissions) if (!perms.has(p)) errors.push(`Scope «${s.key}»: Recht «${p}» nicht im Katalog`);
    for (const p of s.permissions) if (perms.get(p)?.personOnly) errors.push(`Scope «${s.key}» enthält «${p}» (nur für Personen, in keinem Scope)`);
  }
  for (const t of c.resourceTypes ?? []) {
    if (!NAME_KEY.test(t.key)) errors.push(`Ressourcentyp «${t.key}»: Schlüssel nicht ${NAME_KEY}`);
    if (!t.label?.trim()) errors.push(`Ressourcentyp «${t.key}»: Label fehlt`);
  }

  // ---------------------------------------------------------------- Reservierte Namen
  const admin = roles.get(ADMIN_ROLE.key);
  if (!admin) errors.push(`Rolle «${ADMIN_ROLE.key}» fehlt`);
  else {
    if (admin.label !== ADMIN_ROLE.label) errors.push(`Rolle «${ADMIN_ROLE.key}»: Label «${admin.label}» statt «${ADMIN_ROLE.label}»`);
    const missing = c.permissions.map(p => p.key).filter(p => !admin.permissions.includes(p));
    if (missing.length) errors.push(`Rolle «${ADMIN_ROLE.key}» hat nicht alle Rechte (fehlen: ${missing.join(', ')})`);
  }
  for (const r of RESERVED_PERMISSIONS) {
    const p = perms.get(r.key);
    const needed = r.required || (r.key === 'members:admin' && o.members !== false) || ((r.key === 'acl:read' || r.key === 'acl:admin') && o.acl === true);
    if (!p) { if (needed) errors.push(`Recht «${r.key}» fehlt`); continue; }
    if (p.label !== r.label) errors.push(`Recht «${r.key}»: Label «${p.label}» statt «${r.label}»`);
    if (p.group !== r.group) errors.push(`Recht «${r.key}»: Gruppe «${p.group}» statt «${r.group}»`);
  }
  for (const [k, label] of Object.entries(RESERVED_GROUPS)) {
    const g = groups.get(k);
    if (g && g.label !== label) errors.push(`Gruppe «${k}»: Label «${g.label}» statt «${label}»`);
    if (!g && c.permissions.some(p => RESERVED_PERMISSIONS.some(r => r.key === p.key && r.group === k))) errors.push(`Gruppe «${k}» fehlt`);
  }
  for (const s of c.scopes) if (s.permissions.includes('members:admin')) errors.push(`Scope «${s.key}» enthält «members:admin» (nur Personen, in keinem Scope)`);
  if (o.acl && !c.resourceTypes?.some(t => t.key === 'tenant')) errors.push('Ressourcentyp «tenant» fehlt (Wurzel der Zugriffsregeln)');
  const tenantType = c.resourceTypes?.find(t => t.key === 'tenant');
  if (tenantType && tenantType.label !== 'Organisation') errors.push(`Ressourcentyp «tenant»: Label «${tenantType.label}» statt «Organisation»`);

  // ---------------------------------------------------------------- SOLL
  if (o.product && !c.scopes.some(s => s.key === `${o.product}:read`)) warnings.push(`Lese-Scope «${o.product}:read» fehlt`);
  return { errors, warnings };
}
