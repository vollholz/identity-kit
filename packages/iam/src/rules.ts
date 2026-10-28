/**
 * Regeln der Verwaltung für Rollen an der Organisation und Freigabestufen (Spezifikation Kap. 7.5, 9.1 Nr. 5–7), gemeinsam
 * für Mitglieder (admin.ts), Clients (clients.ts) und Freigaben (http/access.ts). Alles in der Transaktion des
 * Aufrufers im Mandantenkontext.
 *
 * - `org-admin` vergeben und entziehen nur `platform-admin` (403 `platform-admin-only`), ohne Ablaufdatum (422).
 * - Niemand gibt mehr, als er hat: jedes Recht einer vergebenen oder entzogenen Rolle muss für die handelnde Person an
 *   org gelten (403 `exceeds-own` mit `missing`); nicht für die Plattform-Administration (A9).
 * - Die letzte aktive Person mit Tupel `org-admin` an org bleibt (409 `last-admin`), auch für die Plattform.
 * - Freigabestufe: nie für sich selbst (403 `self`), nie über die eigene gespeicherte Stufe (403 `exceeds-own`; die
 *   Stufe der Zielperson zählt wie die neue: wer herabstuft, muss sie auch haben, wie beim Entziehen, A9/A12).
 */
import type { AccessService } from './access.ts';
import type { Actor } from './audit.ts';
import { live } from './access.ts';
import type { Tx } from './db.ts';
import { conflict, HttpError, invalid } from './errors.ts';
import { ADMIN_ROLE, ORG, type Level, type Model } from './model.ts';
import type { Principal } from './principal.ts';
import type { TupleStore } from './tuples.ts';

/** Wer handelt: Person mit Principal im Zielmandanten, oder Plattform-Administration (aus einem anderen Mandanten). */
export interface Acting { actor: Principal; platform: boolean }

/**
 * Rollen der Liste prüfen (nur Rollen des Modells bzw. eigene Rollen der Organisation, keine Doppelten). `model`:
 * Modell der Organisation (`access.modelIn(tx)`), sonst das der App.
 */
export function checkRoles(access: AccessService, roles: string[], path = '/roles', model: Model = access.model): string[] {
  const unknown = roles.filter(r => !model.isRole(r));
  if (unknown.length) throw invalid(`Unbekannte Rolle: ${unknown.join(', ')}`, unknown.map(r => ({ path, message: `«${r}» ist keine Rolle des Modells` })));
  const here = model.relationsAt(ORG);
  const bad = roles.filter(r => !here.includes(r));
  if (bad.length) throw invalid(`Rolle an der Organisation nicht zulässig: ${bad.join(', ')}`, bad.map(r => ({ path, message: `«${r}» darf an der Organisation nicht hängen` })));
  return [...new Set(roles)];
}

/** Rollen vergeben oder entziehen: platform-admin-only, exceeds-own (an org). `model` wie bei `checkRoles`. */
export async function checkRoleChange(access: AccessService, a: Acting, changed: string[], model: Model = access.model): Promise<void> {
  if (changed.includes(ADMIN_ROLE) && !a.platform) {
    throw new HttpError(403, 'Keine Berechtigung', `Die Rolle «${access.model.roles.get(ADMIN_ROLE)?.label}» vergibt und entzieht nur die Plattform-Administration.`, {}, { reason: 'platform-admin-only' });
  }
  if (a.platform || !changed.length) return;
  const mine = new Set(access.orgPermissions(a.actor, await access.load(a.actor.tenantId)));
  const missing = [...new Set(changed.flatMap(r => [...model.permissionsOf(r, 'org')]))].filter(p => !mine.has(p));
  if (missing.length) {
    throw new HttpError(403, 'Keine Berechtigung', `Die Rolle enthält Rechte, die du nicht hast: ${missing.map(x => access.model.permissionText(x)).join(', ')}.`, {}, { reason: 'exceeds-own', missing });
  }
}

/** Ist das Konto aktiv (in Keycloak nicht gesperrt)? Ohne Prüfung zählt jedes Konto mit Principal. */
export type ActiveCheck = (subject: string) => Promise<boolean>;

/**
 * Personen mit Tupel `org-admin` an org, nicht entfernt, ohne offene Einladung (Spez. 9.1 Nr. 6); ob das Konto gesperrt
 * ist, weiss nur Keycloak (`ActiveCheck` in `lastAdminGuard`).
 */
export async function activeAdmins(tx: Tx, schema: string): Promise<{ id: string; subject: string }[]> {
  return (await tx.query<{ id: string; subject: string }>(
    `SELECT p.id, p.subject FROM ${schema}.principal p
      WHERE p.kind = 'user' AND p.removed_at IS NULL
        AND EXISTS (SELECT 1 FROM ${schema}.authz_tuple t WHERE t.subject = 'user:' || p.id AND t.relation = $1 AND t.object_type = 'org' AND (t.expires_at IS NULL OR t.expires_at > now()))
        AND NOT EXISTS (SELECT 1 FROM ${schema}.member_invitation i WHERE i.user_id = p.subject AND i.accepted_at IS NULL)`, [ADMIN_ROLE])).rows;
}

/**
 * Die letzte aktive Person mit org-admin bleibt (409 `last-admin`). Ist die Zielperson nicht aktiv, sperrt nichts; andere
 * zählen nur, wenn ihr Konto aktiv ist (`isActive`, z. B. nicht gesperrt in Keycloak).
 */
export async function lastAdminGuard(tx: Tx, schema: string, principalId: string, label = 'Organisations-Admin', isActive?: ActiveCheck): Promise<void> {
  const admins = await activeAdmins(tx, schema);
  if (!admins.some(a => a.id === principalId)) return;
  for (const a of admins) if (a.id !== principalId && (!isActive || await isActive(a.subject))) return;
  throw conflict(`Die Organisation braucht mindestens eine aktive Person mit der Rolle «${label}». Zuerst eine andere Person zur Administration machen.`, { reason: 'last-admin' });
}

/**
 * Rollen eines Subjekts an org auf genau diese Liste setzen (fehlende anlegen, übrige löschen), mit allen Regeln.
 * `actor`: wer handelt, für die Ereignisse `access.granted` und `access.revoked` an die App (kein Audit je Tupel; der
 * Aufrufer protokolliert die Änderung als Ganzes).
 * @returns hinzugefügte und entfernte Rollen
 */
export async function setOrgRoles(tx: Tx, o: { access: AccessService; tuples: TupleStore; schema: string; acting: Acting; subject: string; roles: string[]; createdBy: string | null; isActive?: ActiveCheck; actor?: Actor }): Promise<{ added: string[]; removed: string[] }> {
  const model = await o.access.modelIn(tx);
  const roles = checkRoles(o.access, o.roles, '/roles', model);
  const current = (await tx.query<{ id: string; relation: string; expires_at: Date | null }>(
    `SELECT id, relation, expires_at FROM ${o.schema}.authz_tuple WHERE subject = $1 AND object_type = 'org'`, [o.subject])).rows;
  // Abgelaufene, noch nicht aufgeräumte Tupel zählen nicht; sie werden ersetzt
  const have = current.filter(t => live(t)).map(t => t.relation);
  const added = roles.filter(r => !have.includes(r)), removed = have.filter(r => !roles.includes(r));
  if (!added.length && !removed.length) return { added, removed };
  await checkRoleChange(o.access, o.acting, [...added, ...removed], model);
  const who = o.actor ? { ...o.actor, audit: false } : undefined;
  if (removed.includes(ADMIN_ROLE) && o.subject.startsWith('user:')) await lastAdminGuard(tx, o.schema, o.subject.slice(5), o.access.model.roles.get(ADMIN_ROLE)?.label, o.isActive);
  for (const t of current) {
    if (removed.includes(t.relation) || (added.includes(t.relation) && !live(t))) await o.tuples.revoke(tx, t.id, who);
  }
  for (const r of added) await o.tuples.grant(tx, { subject: o.subject, relation: r, place: { type: 'org' }, createdBy: o.createdBy }, who);
  return { added, removed };
}

/**
 * Freigabestufe setzen (Person oder Client): nie für sich selbst, nie über die eigene gespeicherte Stufe (ausser
 * Plattform). @returns bisherige Stufe
 */
export async function setClearance(tx: Tx, o: { access: AccessService; schema: string; acting: Acting; principalId: string; clearance: Level }): Promise<Level> {
  const { acting: a } = o;
  if (!a.platform && a.actor.principalId === o.principalId) throw new HttpError(403, 'Keine Berechtigung', 'Deine eigene Freigabestufe setzt eine andere Person; heben geht nur über Break-Glass.', {}, { reason: 'self' });
  const before = (await tx.query<{ clearance: Level }>(`SELECT clearance FROM ${o.schema}.principal WHERE id = $1 FOR UPDATE`, [o.principalId])).rows[0];
  if (!before) throw new HttpError(404, 'Mitglied nicht gefunden');
  if (!a.platform) {
    const own = o.access.storedClearance(await o.access.load(a.actor.tenantId), a.actor.principalId);
    if (Math.max(o.clearance, before.clearance) > own) {
      throw new HttpError(403, 'Keine Berechtigung', 'Freigabestufen setzt du nur bis zu deiner eigenen.', {}, { reason: 'exceeds-own', clearance: own });
    }
  }
  if (before.clearance !== o.clearance) await tx.query(`UPDATE ${o.schema}.principal SET clearance = $2 WHERE id = $1`, [o.principalId, o.clearance]);
  return before.clearance;
}
