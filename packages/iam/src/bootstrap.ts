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
import { closeSync, constants, lstatSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_ROLE } from './catalog.ts';
import { GROUP_PREFIX_RE } from './config.ts';
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
  /**
   * Rollen des Katalogs (`Object.keys(JSON.parse(catalog.platformJson()).roles)`); für jede entsteht eine Gruppe.
   * `org-admin` kommt aus dem Baukasten und wird immer ergänzt (platform.json führt es ab 0.4.0 nicht mehr).
   */
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

/** Rollen des Katalogs mit der reservierten Rolle org-admin vorne. */
const withAdmin = (roles: readonly string[]) => [ADMIN_ROLE, ...roles.filter(r => r !== ADMIN_ROLE)];

/** Prüft die Eingaben; Fehlertexte für die Kommandozeile. */
export function orgBootstrapErrors(o: Pick<OrgBootstrapOptions, 'alias' | 'email' | 'roles' | 'catalogRoles'>): string[] {
  const out: string[] = [];
  if (!ALIAS_PATTERN.test(o.alias)) out.push('Alias: Kleinbuchstaben, Ziffern, «-» und «_», beginnt mit Buchstabe oder Ziffer (höchstens 63 Zeichen)');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)) out.push('E-Mail-Adresse ungültig');
  const known = withAdmin(o.catalogRoles);
  for (const r of o.roles ?? []) if (!known.includes(r)) out.push(`Unbekannte Rolle ${r} (erlaubt: ${known.join(', ')})`);
  return out;
}

const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');

/**
 * Verzeichnis für Geheimnisse: anlegen (0700) oder bestehendes prüfen – kein symbolischer Link, eigene Person als
 * Besitzerin, für andere nicht zugänglich (sonst Abbruch, nie still lockern lassen).
 */
function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} ist kein Verzeichnis (symbolischer Link?)`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${dir} gehört nicht dir`);
  if (st.mode & 0o077) throw new Error(`${dir} ist für andere zugänglich (Rechte ${(st.mode & 0o777).toString(8)}); chmod 700 ${dir}`);
  return dir;
}

/** Neue Datei 0600 schreiben: nie über einen symbolischen Link, nie eine bestehende überschreiben. */
function writeSecret(file: string, content: string) {
  let fd: number;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${file} besteht schon (älteres Passwort?); prüfen und entfernen, dann erneut ausführen`);
    throw e;
  }
  try { writeSync(fd, content); } finally { closeSync(fd); }
}

export async function orgBootstrap(kc: KeycloakAdmin, o: OrgBootstrapOptions): Promise<OrgBootstrapResult> {
  const alias = o.alias.toLowerCase(), email = o.email.trim().toLowerCase();
  const roles = o.roles?.length ? o.roles : [ADMIN_ROLE];
  const errors = orgBootstrapErrors({ alias, email, roles, catalogRoles: o.catalogRoles });
  if (errors.length) throw new Error(errors.join('\n'));
  const prefix = (o.groupRolePrefix ?? '/orgs').replace(/^\/+|\/+$/g, '');
  if (!GROUP_PREFIX_RE.test(`/${prefix}`)) throw new Error(`GROUP_ROLE_PREFIX: Gruppenpfad wie /orgs oder /kunden/orgs («${o.groupRolePrefix}»)`);
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
  for (const r of withAdmin(o.catalogRoles)) {
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
    // Konto mit Anmeldung über einen Identitätsanbieter (z. B. Entra ID): ein Passwort umginge dessen MFA
    else if ((await kc.federatedIdentities(res.userId)).length) step(`${email} meldet sich über einen Identitätsanbieter an – kein Passwort gesetzt`);
    else if (dry) step(`${email}: temporäres Passwort würde gesetzt`);
    else {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.:+';
      const password = Array.from({ length: 20 }, () => alphabet[randomInt(alphabet.length)]).join('');
      const { realm, secretDir } = o.initialPassword;
      const file = join(privateDir(secretDir), `initial-password-${safeName(realm)}-${safeName(email)}.txt`);
      writeSecret(file, `${password}\n`);
      try {
        await kc.call('PUT', `/users/${seg(res.userId)}/reset-password`, { type: 'password', value: password, temporary: true }, { what: 'Passwort setzen' });
      } catch (e) {
        rmSync(file, { force: true }); // ohne gesetztes Passwort keine Datei, die eines vortäuscht
        throw e;
      }
      res.passwordFile = file;
      step(`${email}: temporäres Passwort gesetzt, abgelegt in ${file}`);
    }
  }
  step('Fertig.');
  return res;
}
