/**
 * Ersteinrichtung einer Organisation (aus Assets `scripts/org-bootstrap.ts`): Organisation, Rollengruppen
 * `<prefix>/<alias>/<rolle>` für alle Rollen des Katalogs und eine erste Person mit Rollen – idempotent. Danach verwaltet
 * org-admin die Mitglieder in der Oberfläche; den Mandanten legt die App bei der ersten Anmeldung selbst an.
 *
 * Die Person erhält die Pflichtaktion «Passwort festlegen» (per E-Mail, sobald SMTP eingerichtet ist). Ohne SMTP setzt
 * `initialPassword` ein zufälliges temporäres Passwort, nur wenn das Konto noch keines hat, und legt es ausschliesslich in
 * `<secretDir>/initial-password-<realm>-<e-mail>.txt` ab (Datei 0600, Verzeichnis 0700; nie ausgegeben).
 * Kommandozeile: `iam-org-bootstrap` (src/bin/org-bootstrap.ts).
 */
import { randomInt } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_ROLE } from './catalog.ts';
import { seg, type KeycloakAdmin } from './keycloak.ts';
import { ALIAS_PATTERN } from './principal.ts';

export interface OrgBootstrapOptions {
  alias: string;
  name?: string;
  /** Domäne der Organisation (unbestätigt); Standard `<alias>.invalid`. */
  domain?: string;
  email: string;
  firstName?: string;
  lastName?: string;
  /** Rollen der Person, Standard org-admin. */
  roles?: string[];
  /** Alle Rollen des Katalogs (`Object.keys(JSON.parse(catalog.platformJson()).roles)`); für jede entsteht eine Gruppe. */
  catalogRoles: string[];
  /** GROUP_ROLE_PREFIX, Standard `/orgs`. */
  groupRolePrefix?: string;
  /** Realm-Rolle der Plattform-Administration zusätzlich vergeben (Name aus PLATFORM_ADMIN_ROLE). */
  platformAdminRole?: string | null;
  initialPassword?: { realm: string; secretDir: string } | null;
  /** Probelauf: nur lesen, Schritte melden. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface OrgBootstrapResult { orgId: string | null; userId: string | null; steps: string[]; passwordFile: string | null }

/** Prüft die Eingaben; Fehlertexte für die Kommandozeile. */
export function orgBootstrapErrors(o: Pick<OrgBootstrapOptions, 'alias' | 'email' | 'roles' | 'catalogRoles'>): string[] {
  const out: string[] = [];
  if (!ALIAS_PATTERN.test(o.alias)) out.push('Alias: Kleinbuchstaben, Ziffern, «-» und «_», beginnt mit Buchstabe oder Ziffer (höchstens 63 Zeichen)');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)) out.push('E-Mail-Adresse ungültig');
  if (!o.catalogRoles.includes(ADMIN_ROLE)) out.push(`Katalog ohne Rolle ${ADMIN_ROLE} (platform.json des Katalogs angeben)`);
  for (const r of o.roles ?? []) if (!o.catalogRoles.includes(r)) out.push(`Unbekannte Rolle ${r} (erlaubt: ${o.catalogRoles.join(', ')})`);
  return out;
}

export async function orgBootstrap(kc: KeycloakAdmin, o: OrgBootstrapOptions): Promise<OrgBootstrapResult> {
  const alias = o.alias.toLowerCase(), email = o.email.trim().toLowerCase();
  const roles = o.roles?.length ? o.roles : [ADMIN_ROLE];
  const errors = orgBootstrapErrors({ alias, email, roles, catalogRoles: o.catalogRoles });
  if (errors.length) throw new Error(errors.join('\n'));
  const prefix = (o.groupRolePrefix ?? '/orgs').replace(/^\/+|\/+$/g, '');
  const dry = !!o.dryRun;
  const steps: string[] = [];
  const step = (m: string) => { steps.push(m); o.log?.(`${dry ? '[Probelauf] ' : ''}${m}`); };
  const res: OrgBootstrapResult = { orgId: null, userId: null, steps, passwordFile: null };

  // Organisation
  res.orgId = (await kc.listOrgs()).find(x => x.alias.toLowerCase() === alias)?.id ?? null;
  if (!res.orgId) {
    step(`Organisation «${o.name ?? alias}» (${alias}) anlegen`);
    if (!dry) res.orgId = await kc.createOrg({ name: o.name ?? alias, alias, enabled: true, domains: [{ name: o.domain ?? `${alias}.invalid`, verified: false }] });
  } else step(`Organisation ${alias} vorhanden`);

  // Rollengruppen <prefix>/<alias>/<rolle>, jede Stufe einzeln
  const groups = new Map<string, string | null>();
  for (const r of o.catalogRoles) {
    let parent: string | null = null, path = '', missing = false;
    for (const name of [...prefix.split('/'), alias, r]) {
      path += `/${name}`;
      const g = missing ? null : await kc.groupByPath(path);
      if (g) { parent = g.id; continue; }
      missing = true;
      // Elterngruppe schon für eine frühere Rolle angelegt (oder im Probelauf gemeldet)
      if (groups.has(path)) { parent = groups.get(path)!; continue; }
      step(`Gruppe ${path} anlegen`);
      parent = dry ? null : await kc.createGroup(parent, name);
      groups.set(path, parent);
    }
    groups.set(`/${prefix}/${alias}/${r}`, parent);
  }

  // Person (ohne Passwort, Pflichtaktion «Passwort festlegen»)
  res.userId = (await kc.findUserByEmail(email))?.id ?? null;
  if (!res.userId) {
    step(`Person ${email} anlegen (ohne Passwort)`);
    if (!dry) res.userId = await kc.createUser({ username: email, email, emailVerified: true, enabled: true, firstName: o.firstName, lastName: o.lastName, requiredActions: ['UPDATE_PASSWORD'] });
  } else step(`Person ${email} vorhanden`);
  if (!res.userId || !res.orgId) {
    if (!dry) throw new Error('Organisation oder Person fehlt nach dem Anlegen');
    step(`${email} → Organisation ${alias}, Rollen ${roles.join(', ')}`);
    return res;
  }
  if (!(await kc.member(res.orgId, res.userId))) {
    step(`${email} → Organisation ${alias}`);
    if (!dry) await kc.addMember(res.orgId, res.userId);
  }
  const have = new Set((await kc.userGroups(res.userId)).map(g => g.path));
  for (const r of roles) {
    const path = `/${prefix}/${alias}/${r}`, id = groups.get(path);
    if (have.has(path)) continue;
    step(`${email} → Gruppe ${path}`);
    if (!dry && id) await kc.joinGroup(res.userId, id);
  }
  if (o.platformAdminRole) {
    const role = o.platformAdminRole;
    const mapped = ((await kc.call<{ name: string }[]>('GET', `/users/${seg(res.userId)}/role-mappings/realm`)).data ?? []).some(x => x.name === role);
    if (!mapped) {
      step(`${email} → Realm-Rolle ${role}`);
      if (!dry) await kc.call('POST', `/users/${seg(res.userId)}/role-mappings/realm`, [(await kc.call('GET', `/roles/${seg(role)}`, undefined, { what: 'Realm-Rolle lesen' })).data], { what: 'Realm-Rolle zuweisen' });
    }
  }
  if (o.initialPassword) {
    if (await kc.hasPassword(res.userId)) step(`${email} hat schon ein Passwort – nichts geändert`);
    else if (dry) step(`${email}: temporäres Passwort würde gesetzt`);
    else {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.:+';
      const password = Array.from({ length: 20 }, () => alphabet[randomInt(alphabet.length)]).join('');
      const { realm, secretDir } = o.initialPassword;
      mkdirSync(secretDir, { recursive: true, mode: 0o700 });
      const file = join(secretDir, `initial-password-${realm}-${email.replace(/[^a-z0-9@._-]/g, '_')}.txt`);
      writeFileSync(file, `${password}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      await kc.call('PUT', `/users/${seg(res.userId)}/reset-password`, { type: 'password', value: password, temporary: true }, { what: 'Passwort setzen' });
      res.passwordFile = file;
      step(`${email}: temporäres Passwort gesetzt, abgelegt in ${file}`);
    }
  }
  step('Fertig.');
  return res;
}
