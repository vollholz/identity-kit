/**
 * Ersteinrichtung (Spezifikation Kap. 2 Schritt 7, A20). Zwei Arten von Personen, nie beides zugleich:
 * - Betrieb (`operatorBootstrap`): Konto mit der Realm-Rolle der Plattform-Administration, ohne Organisation
 *   (Kap. 6.3). Verwaltet danach Organisationen über die Oberfläche bzw. `/v1/platform/…`.
 * - Organisation (`orgBootstrap`): in Keycloak Organisation, erste Person
 * (ohne Passwort, Pflichtaktion «Passwort festlegen») und Mitgliedschaft; in
 * der Datenbank der App (Besitzer-Rolle, `DATABASE_ADMIN_URL`) Mandant (gebunden an die ID der Organisation), Principal,
 * Tupel `user:<id> org-admin org` und Freigabestufe 2, Audit `tenant.provisioned`. Idempotent. Rollen stehen nie in
 * Keycloak; danach verwaltet org-admin die Mitglieder in der Oberfläche.
 *
 * Die Person erhält die Pflichtaktion «Passwort festlegen» und, wenn sie neu angelegt ist, eine Einladung von Keycloak
 * (`execute-actions-email` mit `UPDATE_PASSWORD`, gültig `invite.lifespanSec`, Standard 7 Tage); nie an Konten mit
 * Passwort oder Identitätsanbieter. `sendEmail: false` schaltet sie ab, `resend` sendet auch an bestehende Konten ohne
 * Passwort. Scheitert der Versand (meist kein SMTP im Realm), meldet der Lauf das und läuft weiter. Alternative ohne
 * SMTP: `initialPassword` (dann keine Einladung) setzt ein zufälliges temporäres Passwort, nur wenn das Konto noch keines
 * hat, und legt es ausschliesslich in `<secretDir>/initial-password-<realm>-<e-mail>.txt` ab (Datei 0600, Verzeichnis
 * 0700; nie ausgegeben).
 * Mehrere Organisationen mit je mehreren Admins aus einer Datei (`orgBootstrapFile`, `iam-org-bootstrap --file`): Format
 * `InitFile`, als JSON Schema im Paket (`schema/init.schema.json`); je Admin wie `orgBootstrap`.
 * Kommandozeile: `iam-org-bootstrap` (src/bin/org-bootstrap.ts).
 */
import { randomInt } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import pg from 'pg';
import { pgSsl, schemaName, type DbSsl } from './db.ts';
import { ADMIN_ROLE } from './model.ts';
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
  /**
   * Datenbank der App: Adresse der Besitzer-Rolle (`DATABASE_ADMIN_URL`) und Schema der Tabellen. Ausdrücklich `null`:
   * nur Keycloak – Mandant, Principal und das Tupel `org-admin` setzt dann der Aufrufer selbst (z. B. ein eigener
   * Schritt auf dem Server der Datenbank). Fehlt die Angabe, bricht der Lauf ab (ausser im Probelauf): sonst entstünde
   * still eine Organisation ohne Admin.
   */
  database?: { url: string; schema: string; /** TLS wie `DATABASE_SSL`; Standard `disable`. */ ssl?: DbSsl } | null;
  /** Realm-Rolle des Betriebs (PLATFORM_ADMIN_ROLE): eine Person mit dieser Rolle wird nie Admin einer Organisation. */
  operatorRole?: string | null;
  initialPassword?: { realm: string; secretDir: string } | null;
  /** Einladung per E-Mail an neu angelegte Personen ohne Passwort (Standard an). */
  sendEmail?: boolean;
  /** Einladung auch an bestehende Personen ohne Passwort und ohne Identitätsanbieter (erneut) senden. */
  resend?: boolean;
  /** Gültigkeit der Einladung (Standard 7 Tage); Client und Weiterleitung nach dem Festlegen des Passworts. */
  invite?: { lifespanSec?: number; clientId?: string; redirectUri?: string };
  /** Probelauf: nur lesen, Schritte melden. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface OrgBootstrapResult {
  orgId: string | null; userId: string | null; tenantId: string | null; principalId: string | null; steps: string[]; passwordFile: string | null;
  /** Adresse der Person (klein geschrieben). */
  email: string;
  /** Einladung: `sent` gesendet, `failed` Versand gescheitert (meist kein SMTP), null keine (nicht nötig, abgeschaltet, Probelauf). */
  invitation: 'sent' | 'failed' | null;
}

/** Standard-Gültigkeit der Einladung: 7 Tage. */
export const INVITE_LIFESPAN_SEC = 7 * 24 * 3600;

/** Prüft die Eingaben; Fehlertexte für die Kommandozeile. */
export function orgBootstrapErrors(o: Pick<OrgBootstrapOptions, 'alias' | 'email' | 'invite'>): string[] {
  const out = inviteErrors(o.invite);
  if (!ALIAS_PATTERN.test(o.alias)) out.push('Alias: Kleinbuchstaben, Ziffern, «-» und «_», beginnt mit Buchstabe oder Ziffer (höchstens 63 Zeichen)');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)) out.push('E-Mail-Adresse ungültig');
  return out;
}

/** Prüft die Angaben zur Einladung (Gültigkeit, Weiterleitung nur mit Client). */
export function inviteErrors(invite: OrgBootstrapOptions['invite']): string[] {
  const out: string[] = [];
  const life = invite?.lifespanSec;
  if (life !== undefined && !(Number.isInteger(life) && life > 0)) out.push('Gültigkeit der Einladung: ganze Zahl Sekunden grösser 0');
  if (invite?.redirectUri && !invite.clientId) out.push('Weiterleitung der Einladung (--redirect-uri) nur zusammen mit dem Client (--client-id)');
  return out;
}

const EMAIL = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';

/** Datei für `iam-org-bootstrap --file` (mitgeliefert als `schema/init.schema.json`). */
export const InitFileSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  operators: Type.Optional(Type.Array(Type.Object({
    email: Type.String({ pattern: EMAIL }),
    first: Type.Optional(Type.String()),
    last: Type.Optional(Type.String()),
  }, { additionalProperties: false }), { description: 'Betrieb: Konto mit der Realm-Rolle der Plattform-Administration (PLATFORM_ADMIN_ROLE), ohne Organisation' })),
  organizations: Type.Optional(Type.Array(Type.Object({
    alias: Type.String({ pattern: ALIAS_PATTERN.source, description: 'Alias der Organisation in Keycloak und des Mandanten' }),
    name: Type.Optional(Type.String({ minLength: 1, description: 'Anzeigename; Standard der Alias' })),
    admins: Type.Array(Type.Object({
      email: Type.String({ pattern: EMAIL }),
      first: Type.Optional(Type.String()),
      last: Type.Optional(Type.String()),
    }, { additionalProperties: false }), { minItems: 1, description: 'Je Person Konto, Mitgliedschaft, Rolle org-admin und Freigabestufe 2 (nie die Plattform-Administration)' }),
  }, { additionalProperties: false }))),
}, { $id: 'https://github.com/vollholz/identity-kit/packages/iam/schema/init.schema.json', title: 'iam-org-bootstrap --file', additionalProperties: false });
export type InitFile = Static<typeof InitFileSchema>;

/** Prüft eine Datei für `--file` (Schema, doppelte Aliasse); Fehlertexte für die Kommandozeile. */
export function initFileErrors(data: unknown): string[] {
  if (!Value.Check(InitFileSchema, data)) return [...Value.Errors(InitFileSchema, data)].map(e => `${e.path || '/'}: ${e.message}`);
  const seen = new Set<string>(), out: string[] = [];
  const operators = (data.operators ?? []).map(x => x.email.trim().toLowerCase());
  if (!operators.length && !data.organizations?.length) out.push('/: mindestens ein Eintrag in operators oder organizations');
  operators.forEach((m, i) => { if (operators.indexOf(m) !== i) out.push(`/operators/${i}/email: ${m} doppelt`); });
  (data.organizations ?? []).forEach((o, i) => {
    if (seen.has(o.alias)) out.push(`/organizations/${i}/alias: ${o.alias} doppelt`);
    seen.add(o.alias);
    const mails = new Set<string>();
    o.admins.forEach((a, j) => {
      const m = a.email.trim().toLowerCase();
      if (mails.has(m)) out.push(`/organizations/${i}/admins/${j}/email: ${m} doppelt`);
      if (operators.includes(m)) out.push(`/organizations/${i}/admins/${j}/email: ${m} ist Betrieb (operators) – Betrieb und Organisation nie mit demselben Konto`);
      mails.add(m);
    });
  });
  return out;
}

/**
 * Betrieb und Organisationen aus dem Manifest der App (`identity.app.json`, Felder `operators` und `organizations`,
 * gleiches Format wie die Datei für `--file`); die übrigen Felder des Manifests prüft das Test-Kit
 * (`iam-conformity-test`). Fehlertexte wie `initFileErrors`.
 */
export function manifestInitFile(data: unknown): { file: InitFile | null; errors: string[] } {
  const m = data && typeof data === 'object' && !Array.isArray(data) ? data as { operators?: unknown; organizations?: unknown } : {};
  if (m.operators === undefined && m.organizations === undefined) return { file: null, errors: ['/organizations: fehlt (Betrieb unter operators und/oder erste Organisation mit ihren Admins)'] };
  const file = { ...(m.operators !== undefined ? { operators: m.operators } : {}), ...(m.organizations !== undefined ? { organizations: m.organizations } : {}) };
  const errors = initFileErrors(file);
  return errors.length ? { file: null, errors } : { file: file as InitFile, errors };
}

export type OrgBootstrapFileOptions = Pick<OrgBootstrapOptions, 'database' | 'initialPassword' | 'sendEmail' | 'resend' | 'invite' | 'dryRun' | 'log'> & {
  /** Realm-Rolle der Personen in `operators` (PLATFORM_ADMIN_ROLE). */
  platformAdminRole: string;
};

/** Betrieb, dann alle Organisationen und Admins einer Datei (je wie `operatorBootstrap` bzw. `orgBootstrap`, idempotent). */
export async function orgBootstrapFile(kc: KeycloakAdmin, file: InitFile, o: OrgBootstrapFileOptions): Promise<OrgBootstrapResult[]> {
  const errors = initFileErrors(file);
  if (errors.length) throw new Error(errors.join('\n'));
  const out: OrgBootstrapResult[] = [];
  for (const a of file.operators ?? []) {
    o.log?.(`— Betrieb: ${a.email.trim().toLowerCase()}`);
    out.push(await operatorBootstrap(kc, {
      email: a.email, firstName: a.first, lastName: a.last, platformAdminRole: o.platformAdminRole,
      initialPassword: o.initialPassword, sendEmail: o.sendEmail, resend: o.resend, invite: o.invite, dryRun: o.dryRun, log: o.log,
    }));
  }
  for (const org of file.organizations ?? []) {
    for (const a of org.admins) {
      o.log?.(`— ${org.alias}: ${a.email.trim().toLowerCase()}`);
      out.push(await orgBootstrap(kc, {
        alias: org.alias, name: org.name, email: a.email, firstName: a.first, lastName: a.last, operatorRole: o.platformAdminRole,
        database: o.database, initialPassword: o.initialPassword, sendEmail: o.sendEmail, resend: o.resend, invite: o.invite, dryRun: o.dryRun, log: o.log,
      }));
    }
  }
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
  const errors = orgBootstrapErrors({ alias, email, invite: o.invite });
  if (o.database === undefined && !o.dryRun) errors.push('Datenbank fehlt: ohne sie bekäme die Person keine Rolle org-admin (database angeben oder ausdrücklich database: null für nur Keycloak)');
  if (errors.length) throw new Error(errors.join('\n'));
  const dry = !!o.dryRun;
  const steps: string[] = [];
  const step = (m: string) => { steps.push(m); o.log?.(`${dry ? '[Probelauf] ' : ''}${m}`); };
  const res: OrgBootstrapResult = { orgId: null, userId: null, tenantId: null, principalId: null, steps, passwordFile: null, email, invitation: null };

  // Organisation
  res.orgId = (await kc.listOrgs()).find(x => x.alias.toLowerCase() === alias)?.id ?? null;
  if (!res.orgId) {
    step(`Organisation «${o.name ?? alias}» (${alias}) anlegen`);
    if (!dry) res.orgId = await kc.createOrg({ name: o.name ?? alias, alias, enabled: true, domains: [{ name: o.domain ?? `${alias}.invalid`, verified: false }] });
  } else step(`Organisation ${alias} vorhanden`);

  // Person (ohne Passwort, Pflichtaktion «Passwort festlegen»)
  const person = await ensurePerson(kc, email, o, dry, step);
  res.userId = person.userId;
  const created = person.created;
  if (res.userId && await isOperator(kc, res.userId, o.operatorRole ?? null)) {
    throw new Error(`${email} ist Betrieb (Realm-Rolle ${o.operatorRole}): Betrieb und Organisation nie mit demselben Konto. Eine andere Adresse für die Organisation verwenden.`);
  }
  if (!res.userId || !res.orgId) {
    if (!dry) throw new Error('Organisation oder Person fehlt nach dem Anlegen');
    step(`${email} → Organisation ${alias}, Rolle ${ADMIN_ROLE}, Freigabestufe 2`);
    if (o.sendEmail !== false && !o.initialPassword && (created || o.resend)) {
      if (res.userId) await invite(kc, res.userId, email, o, dry, step);
      else step(`${email}: Einladung «Passwort festlegen» würde gesendet`);
    }
    return res;
  }
  if (!(await kc.member(res.orgId, res.userId))) {
    step(`${email} → Organisation ${alias}`);
    if (!dry) await kc.addMember(res.orgId, res.userId);
  }
  res.passwordFile = await initialPassword(kc, res.userId, email, o, dry, step);
  if (o.database) {
    const r = await provisionDb(o.database, { alias, name: o.name ?? alias, orgId: res.orgId, userId: res.userId, email, displayName: [o.firstName, o.lastName].filter(Boolean).join(' ') || email, dry, step });
    res.tenantId = r.tenantId; res.principalId = r.principalId;
  } else step(o.database === null
    ? 'Nur Keycloak (ausdrücklich): Mandant, Rolle org-admin und Freigabestufe setzt der Aufrufer in der Datenbank der App'
    : 'Ohne Datenbank (Probelauf): Rolle org-admin und Freigabestufe würden mit DATABASE_ADMIN_URL gesetzt');
  // Einladung zuletzt: die Person findet beim Anmelden ihre Rolle schon vor
  if (o.sendEmail !== false && !o.initialPassword && (created || o.resend)) res.invitation = await invite(kc, res.userId, email, o, dry, step);
  step('Fertig.');
  return res;
}

/** Optionen für ein Konto des Betriebs (ohne Organisation). */
export type OperatorBootstrapOptions = Pick<OrgBootstrapOptions, 'email' | 'firstName' | 'lastName' | 'initialPassword' | 'sendEmail' | 'resend' | 'invite' | 'dryRun' | 'log'> & {
  /** Realm-Rolle der Plattform-Administration (PLATFORM_ADMIN_ROLE). */
  platformAdminRole: string;
};

/**
 * Konto des Betriebs (Kap. 6.3): Person ohne Passwort mit der Realm-Rolle der Plattform-Administration, keiner
 * Organisation zugeordnet; Einladung bzw. temporäres Passwort wie bei `orgBootstrap`. Ist die Person schon Mitglied einer
 * Organisation, bricht der Lauf ab: Betrieb und Organisation nie mit demselben Konto. Idempotent.
 */
export async function operatorBootstrap(kc: KeycloakAdmin, o: OperatorBootstrapOptions): Promise<OrgBootstrapResult> {
  const email = o.email.trim().toLowerCase();
  const errors = [...inviteErrors(o.invite), ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? [] : ['E-Mail-Adresse ungültig'])];
  if (errors.length) throw new Error(errors.join('\n'));
  const dry = !!o.dryRun;
  const steps: string[] = [];
  const step = (m: string) => { steps.push(m); o.log?.(`${dry ? '[Probelauf] ' : ''}${m}`); };
  const res: OrgBootstrapResult = { orgId: null, userId: null, tenantId: null, principalId: null, steps, passwordFile: null, email, invitation: null };
  const person = await ensurePerson(kc, email, o, dry, step);
  res.userId = person.userId;
  if (res.userId) {
    const orgs = await kc.memberOrgs(res.userId);
    if (orgs.length) throw new Error(`${email} ist Mitglied von ${orgs.map(x => x.alias).join(', ')}: Betrieb und Organisation nie mit demselben Konto. Eine eigene Adresse für den Betrieb verwenden.`);
    if (!(await isOperator(kc, res.userId, o.platformAdminRole))) {
      step(`${email} → Realm-Rolle ${o.platformAdminRole} (Betrieb, ohne Organisation)`);
      if (!dry) await kc.call('POST', `/users/${seg(res.userId)}/role-mappings/realm`, [(await kc.call('GET', `/roles/${seg(o.platformAdminRole)}`, undefined, { what: 'Realm-Rolle lesen' })).data], { what: 'Realm-Rolle zuweisen' });
    } else step(`${email} hat die Realm-Rolle ${o.platformAdminRole}`);
    res.passwordFile = await initialPassword(kc, res.userId, email, o, dry, step);
  } else step(`${email} → Realm-Rolle ${o.platformAdminRole} (Betrieb, ohne Organisation)`);
  if (o.sendEmail !== false && !o.initialPassword && (person.created || o.resend)) {
    if (res.userId) res.invitation = await invite(kc, res.userId, email, o, dry, step);
    else step(`${email}: Einladung «Passwort festlegen» würde gesendet`);
  }
  step('Fertig.');
  return res;
}

/** Person zur Adresse finden oder ohne Passwort anlegen (Pflichtaktion «Passwort festlegen»). Probelauf: `userId` null, wenn neu. */
async function ensurePerson(kc: KeycloakAdmin, email: string, o: Pick<OrgBootstrapOptions, 'firstName' | 'lastName'>, dry: boolean, step: (m: string) => void): Promise<{ userId: string | null; created: boolean }> {
  const existing = (await kc.findUserByEmail(email))?.id ?? null;
  if (existing) { step(`Person ${email} vorhanden`); return { userId: existing, created: false }; }
  step(`Person ${email} anlegen (ohne Passwort)`);
  if (dry) return { userId: null, created: true };
  return { userId: await kc.createUser({ username: email, email, emailVerified: true, enabled: true, firstName: o.firstName, lastName: o.lastName, requiredActions: ['UPDATE_PASSWORD'] }), created: true };
}

/**
 * Hat die Person die Realm-Rolle des Betriebs – auch geerbt über eine Gruppe oder eine zusammengesetzte Rolle? Das Token
 * enthält sie dann ebenso; die direkte Zuweisung allein genügte nicht für die Trennung von Betrieb und Organisation.
 */
async function isOperator(kc: KeycloakAdmin, userId: string, role: string | null): Promise<boolean> {
  return !!role && (await kc.realmRoles(userId)).includes(role);
}

/**
 * Temporäres Passwort (`initialPassword`): nur ohne Passwort und ohne Identitätsanbieter; nur in die Datei
 * `<secretDir>/initial-password-<realm>-<e-mail>.txt` (0600), nie ausgegeben. Liefert die Datei oder null.
 */
async function initialPassword(kc: KeycloakAdmin, userId: string, email: string, o: Pick<OrgBootstrapOptions, 'initialPassword'>, dry: boolean, step: (m: string) => void): Promise<string | null> {
  if (!o.initialPassword) return null;
  if (await kc.hasPassword(userId)) { step(`${email} hat schon ein Passwort – nichts geändert`); return null; }
  // Konto mit Anmeldung über einen Identitätsanbieter (z. B. Entra ID): ein Passwort umginge dessen MFA
  if ((await kc.federatedIdentities(userId)).length) { step(`${email} meldet sich über einen Identitätsanbieter an – kein Passwort gesetzt`); return null; }
  if (dry) { step(`${email}: temporäres Passwort würde gesetzt`); return null; }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.:+';
  const password = Array.from({ length: 20 }, () => alphabet[randomInt(alphabet.length)]).join('');
  const { realm, secretDir } = o.initialPassword;
  const file = join(privateDir(secretDir), `initial-password-${safeName(realm)}-${safeName(email)}.txt`);
  writeSecret(file, `${password}\n`);
  try {
    await kc.call('PUT', `/users/${seg(userId)}/reset-password`, { type: 'password', value: password, temporary: true }, { what: 'Passwort setzen' });
  } catch (e) {
    rmSync(file, { force: true }); // ohne gesetztes Passwort keine Datei, die eines vortäuscht
    throw e;
  }
  step(`${email}: temporäres Passwort gesetzt, abgelegt in ${file}`);
  return file;
}

/**
 * Einladung «Passwort festlegen» per E-Mail (Keycloak `execute-actions-email`), nur an Konten ohne Passwort und ohne
 * Identitätsanbieter. Scheitert der Versand, bleibt es bei einer Meldung (Lauf geht weiter).
 */
async function invite(kc: KeycloakAdmin, userId: string, email: string, o: Pick<OrgBootstrapOptions, 'invite'>, dry: boolean, step: (m: string) => void): Promise<'sent' | 'failed' | null> {
  if (await kc.hasPassword(userId)) { step(`${email} hat schon ein Passwort – keine Einladung`); return null; }
  if ((await kc.federatedIdentities(userId)).length) { step(`${email} meldet sich über einen Identitätsanbieter an – keine Einladung`); return null; }
  const lifespanSec = o.invite?.lifespanSec ?? INVITE_LIFESPAN_SEC;
  const days = Math.round(lifespanSec / 864) / 100;
  if (dry) { step(`${email}: Einladung «Passwort festlegen» würde gesendet (gültig ${days} Tage)`); return null; }
  if (await kc.sendActionsEmail(userId, ['UPDATE_PASSWORD'], { lifespanSec, clientId: o.invite?.clientId, redirectUri: o.invite?.redirectUri })) {
    step(`${email}: Einladung «Passwort festlegen» gesendet (gültig ${days} Tage)`);
    return 'sent';
  }
  step(`${email}: Einladung NICHT gesendet – Versand gescheitert (SMTP im Realm eingerichtet? Client/Weiterleitung gültig?). `
    + 'Nach dem Einrichten erneut mit --resend, oder --initial-password');
  return 'failed';
}

/**
 * Datenbank der App (A20): als Besitzer-Rolle im Kontext des Mandanten (Policies `owner_tenant`) Mandant, Principal,
 * Tupel `org-admin` an org und Freigabestufe 2; Audit `tenant.provisioned` beim ersten Mal. Idempotent.
 */
async function provisionDb(d: { url: string; schema: string; ssl?: DbSsl }, o: { alias: string; name: string; orgId: string; userId: string; email: string; displayName: string; dry: boolean; step: (m: string) => void }): Promise<{ tenantId: string | null; principalId: string | null }> {
  const S = schemaName(d.schema);
  const c = new pg.Client({ connectionString: d.url, application_name: 'iam-org-bootstrap', ssl: pgSsl(d.ssl) });
  await c.connect();
  try {
    await c.query('BEGIN');
    const before = (await c.query<{ id: string; kc_org_id: string | null }>(`SELECT id, kc_org_id FROM ${S}.tenant WHERE alias = $1`, [o.alias])).rows[0];
    if (before?.kc_org_id && before.kc_org_id !== o.orgId) throw new Error(`Mandant ${o.alias} gehört zu einer anderen Organisation in Keycloak (kc_org_id); nicht übernommen`);
    if (!before) o.step(`Mandant ${o.alias} anlegen`);
    if (o.dry) { await c.query('ROLLBACK'); o.step('Principal, Tupel org-admin an org und Freigabestufe 2 setzen'); return { tenantId: before?.id ?? null, principalId: null }; }
    const tenantId = (await c.query<{ id: string | null }>('SELECT app.resolve_tenant($1, $2, $3, true) AS id', [o.alias, o.orgId, o.name])).rows[0]?.id;
    if (!tenantId) throw new Error(`Mandant ${o.alias} nicht verfügbar (gesperrt oder an eine andere Organisation gebunden)`);
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const principalId = (await c.query<{ id: string }>(
      `INSERT INTO ${S}.principal AS p (tenant_id, kind, subject, display_name, email, last_seen_at) VALUES ($1, 'user', $2, $3, $4, NULL)
       ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET removed_at = NULL RETURNING id`, [tenantId, o.userId, o.displayName, o.email])).rows[0]!.id;
    const subject = `user:${principalId}`;
    const tuple = await c.query(`INSERT INTO ${S}.authz_tuple (tenant_id, subject, relation, object_type) VALUES ($1, $2, $3, 'org') ON CONFLICT ON CONSTRAINT authz_tuple_unique DO NOTHING`, [tenantId, subject, ADMIN_ROLE]);
    if (tuple.rowCount) o.step(`${o.email} → Rolle ${ADMIN_ROLE} an der Organisation`);
    const lvl = await c.query(`UPDATE ${S}.principal SET clearance = 2 WHERE id = $1 AND clearance <> 2`, [principalId]);
    if (lvl.rowCount) o.step(`${o.email} → Freigabestufe 2`);
    if (!before || tuple.rowCount) {
      await c.query(`INSERT INTO ${S}.audit_log (tenant_id, actor_kind, source, action, resource_type, resource_id, data) VALUES ($1, 'system', 'system', 'tenant.provisioned', 'tenant', $1, $2)`,
        [tenantId, JSON.stringify({ alias: o.alias, kcOrgId: o.orgId, admin: subject, via: 'iam-org-bootstrap' })]);
    }
    await c.query('COMMIT');
    return { tenantId, principalId };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { await c.end(); }
}
