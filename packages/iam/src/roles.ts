/**
 * Eigene Rollen der Organisation (Kit 5.0; docs/authz-offene-punkte.md O17): Eine Organisation stellt zur Laufzeit Rollen
 * aus den Rechten des Modells zusammen – Name, Beschreibung, Rechte und die Orte (Typen), an denen die Rolle vergeben
 * werden darf. Das Modell der App bleibt im Code; seine Rollen bleiben als Vorgabe und lassen sich nicht ändern.
 *
 * Regeln (konservativ, wo das Konzept schweigt):
 * - Nur ergänzen, nie überschreiben: Schlüssel immer «c-…», nie gleich einer Rolle des Modells.
 * - Nur Rechte des Modells, keine, die nur org-admin hat (z. B. `members:admin`, `roles:admin`, sofern keine Rolle des
 *   Modells sie enthält); unbekannte Rechte und Orte → 422.
 * - Niemand gibt mehr, als er hat: Wer eine Rolle anlegt, ändert oder löscht, hat jedes ihrer Rechte (vorher und nachher)
 *   an der Organisation; sonst 403 `exceeds-own`. Die Plattform-Administration ist davon frei.
 * - Vergeben wird eine eigene Rolle wie jede andere (Rollen setzen, Einladen, Freigaben an Orten); ändert sich ihr
 *   Inhalt, gilt er sofort für alle, die sie haben (acl_version).
 * - Löschen und Orte entfernen nur, wo sie nicht (mehr) vergeben ist (409 `in-use`, auch in der Datenbank gesichert).
 * - Höchstens CUSTOM_ROLE_LIMIT je Organisation (409 `limit`); Namen eindeutig je Organisation (409 `duplicate-label`).
 * Audit `role.created`, `role.updated` (vorher und nachher), `role.deleted`, je mit `data.key`.
 */
import type { AccessService } from './access.ts';
import { loadCustomRoles } from './access.ts';
import type { Actor, AuditPort } from './audit.ts';
import { schemaName, type Tx } from './db.ts';
import { conflict, HttpError, invalid, notFound } from './errors.ts';
import { CUSTOM_ROLE_KEY, CUSTOM_ROLE_LIMIT, type CustomRoleDef } from './model.ts';
import type { Acting } from './rules.ts';

/** Eigene Rolle mit Verwaltungsangaben (`GET /v1/admin/roles`). */
export interface CustomRole extends CustomRoleDef {
  /** Vergaben (nicht abgelaufene und abgelaufene Tupel) je Ort. */
  assignments: number;
  createdAt: Date; updatedAt: Date;
}

export interface CustomRoleInput { key?: string; label: string; description?: string; permissions: string[]; places: string[] }

/** Schlüssel aus dem Namen: «c-» und Kleinbuchstaben, Umlaute ausgeschrieben (Schweizer Schreibweise: ä → ae). */
export function customRoleKey(label: string): string {
  const base = label.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/\u00df/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
  return `c-${base || 'rolle'}`;
}

export class CustomRoles {
  private readonly S: string;
  private readonly access: AccessService<any, any>;
  private readonly audit: AuditPort;

  constructor(o: { schema: string; access: AccessService<any, any>; audit: AuditPort }) {
    this.S = schemaName(o.schema); this.access = o.access; this.audit = o.audit;
  }

  /** Eigene Rollen der Organisation (Transaktion im Mandanten) mit Zahl der Vergaben. */
  async list(tx: Tx): Promise<CustomRole[]> {
    return (await tx.query<CustomRole>(
      `SELECT r.key, r.label, r.description, r.permissions, r.places, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
              (SELECT count(*)::int FROM ${this.S}.authz_tuple t WHERE t.relation = r.key) AS assignments
         FROM ${this.S}.authz_role r ORDER BY r.created_at, r.key`)).rows;
  }

  async get(tx: Tx, key: string): Promise<CustomRole | null> {
    return (await this.list(tx)).find(r => r.key === key) ?? null;
  }

  /** Prüfung gegen das Modell der App (422 je Feld). */
  private check(def: CustomRoleDef) {
    const problems = this.access.model.customRoleProblems(def);
    if (problems.length) throw invalid('Rolle ungültig', problems.map(message => ({ path: /^Recht/.test(message) ? '/permissions' : /^Ort|ohne Ort/.test(message) ? '/places' : /^Schlüssel/.test(message) ? '/key' : /Beschreibung/.test(message) ? '/description' : /^Name/.test(message) ? '/label' : '/permissions', message })));
  }

  /** Niemand gibt mehr, als er hat: alle Rechte an der Organisation (ausser Plattform). */
  private async owns(a: Acting, perms: readonly string[]) {
    if (a.platform) return;
    const mine = new Set(this.access.orgPermissions(a.actor, await this.access.load(a.actor.tenantId)));
    const missing = [...new Set(perms)].filter(p => !mine.has(p));
    if (missing.length) {
      throw new HttpError(403, 'Keine Berechtigung', `Die Rolle enthält Rechte, die du nicht hast: ${missing.map(x => this.access.model.permissionText(x)).join(', ')}.`, {}, { reason: 'exceeds-own', missing });
    }
  }

  /** Änderungen derselben Organisation nacheinander (Höchstzahl, Schlüssel). */
  private async lock(tx: Tx) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('roles:' || app.tenant_id()::text, 0))");
  }

  /** Fehler der Datenbank als Antwort: Name doppelt, Rolle vergeben. */
  private async guarded<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
    await tx.query('SAVEPOINT custom_role');
    try {
      const r = await fn();
      await tx.query('RELEASE SAVEPOINT custom_role');
      return r;
    } catch (e) {
      await tx.query('ROLLBACK TO SAVEPOINT custom_role');
      const code = (e as { code?: string }).code, constraint = (e as { constraint?: string }).constraint;
      if (code === '23505' && constraint === 'authz_role_label') throw conflict('Eine Rolle mit diesem Namen gibt es schon.', { reason: 'duplicate-label' });
      if (code === '23505') throw conflict('Eine Rolle mit diesem Schlüssel gibt es schon.', { reason: 'duplicate' });
      if (code === '23503') throw conflict('Die Rolle ist an diesem Ort noch vergeben. Zuerst die Vergaben entfernen.', { reason: 'in-use' });
      throw e;
    }
  }

  async create(tx: Tx, a: Acting, actor: Actor, input: CustomRoleInput): Promise<CustomRole> {
    await this.lock(tx);
    const existing = await loadCustomRoles(tx, this.S);
    if (existing.length >= CUSTOM_ROLE_LIMIT) throw conflict(`Eine Organisation hat höchstens ${CUSTOM_ROLE_LIMIT} eigene Rollen.`, { reason: 'limit' });
    let key = input.key ?? customRoleKey(input.label);
    if (!input.key) for (let i = 2; existing.some(r => r.key === key) || this.access.model.isRole(key); i++) key = `${customRoleKey(input.label)}-${i}`;
    const def: CustomRoleDef = { key, label: input.label.trim(), description: (input.description ?? '').trim(), permissions: [...new Set(input.permissions)], places: [...new Set(input.places)] };
    this.check(def);
    await this.owns(a, def.permissions);
    // Tupel mit diesem Schlüssel ohne Rolle (z. B. aus einer früheren Rolle): nie an eine neue Rolle binden
    if ((await tx.query(`SELECT 1 FROM ${this.S}.authz_tuple WHERE relation = $1 LIMIT 1`, [def.key])).rowCount) {
      throw conflict('Unter diesem Schlüssel bestehen noch Vergaben einer früheren Rolle. Anderen Schlüssel wählen oder die Vergaben zuerst entfernen.', { reason: 'in-use' });
    }
    await this.guarded(tx, () => tx.query(
      `INSERT INTO ${this.S}.authz_role (tenant_id, key, label, description, permissions, places, created_by) VALUES (app.tenant_id(), $1, $2, $3, $4, $5, $6)`,
      [def.key, def.label, def.description, def.permissions, def.places, a.platform ? null : a.actor.principalId]));
    await this.audit.write(tx, actor, { action: 'role.created', resourceType: 'role', resourceId: null, data: { ...def, ...(a.platform ? { platformAdmin: true } : {}) } });
    return (await this.get(tx, def.key))!;
  }

  async update(tx: Tx, a: Acting, actor: Actor, key: string, input: Omit<CustomRoleInput, 'key'>): Promise<CustomRole> {
    if (!CUSTOM_ROLE_KEY.test(key)) throw notFound('Rolle');
    await this.lock(tx);
    const before = (await loadCustomRoles(tx, this.S)).find(r => r.key === key);
    if (!before) throw notFound('Rolle');
    const def: CustomRoleDef = { key, label: input.label.trim(), description: (input.description ?? '').trim(), permissions: [...new Set(input.permissions)], places: [...new Set(input.places)] };
    this.check(def);
    // Wer ändert, hat die Rechte vorher und nachher (sonst gäbe er mehr bzw. nähme anderen, was er selbst nicht hat)
    await this.owns(a, [...before.permissions, ...def.permissions]);
    await this.guarded(tx, () => tx.query(
      `UPDATE ${this.S}.authz_role SET label = $2, description = $3, permissions = $4, places = $5, updated_at = now() WHERE key = $1`,
      [key, def.label, def.description, def.permissions, def.places]));
    await this.audit.write(tx, actor, { action: 'role.updated', resourceType: 'role', resourceId: null, data: { key, before: { label: before.label, description: before.description, permissions: before.permissions, places: before.places }, after: { label: def.label, description: def.description, permissions: def.permissions, places: def.places }, ...(a.platform ? { platformAdmin: true } : {}) } });
    return (await this.get(tx, key))!;
  }

  async remove(tx: Tx, a: Acting, actor: Actor, key: string): Promise<void> {
    if (!CUSTOM_ROLE_KEY.test(key)) throw notFound('Rolle');
    await this.lock(tx);
    const r = await this.get(tx, key);
    if (!r) throw notFound('Rolle');
    if (r.assignments) throw conflict(`Die Rolle «${r.label}» ist noch ${r.assignments === 1 ? 'einmal' : `${r.assignments}-mal`} vergeben. Zuerst die Vergaben entfernen.`, { reason: 'in-use', assignments: r.assignments });
    await this.owns(a, r.permissions);
    await this.guarded(tx, () => tx.query(`DELETE FROM ${this.S}.authz_role WHERE key = $1`, [key]));
    await this.audit.write(tx, actor, { action: 'role.deleted', resourceType: 'role', resourceId: null, data: { key, label: r.label, permissions: r.permissions, places: r.places, ...(a.platform ? { platformAdmin: true } : {}) } });
  }
}
