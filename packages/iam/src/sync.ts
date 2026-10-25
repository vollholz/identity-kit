/**
 * Abgleich der Organisationsmitglieder aus Keycloak ins Personenverzeichnis (`<schema>.principal`; Spezifikation
 * Kap. 9.3).
 *
 * - Zuordnung Organisation ↔ Mandant über den Alias (app.platform_tenants()); Organisationen ohne Mandant und
 *   gesperrte Mandanten werden übersprungen. Hat der Mandant noch keine Organisations-ID, wird sie gebunden
 *   (app.resolve_tenant, nur wenn keine andere Zeile sie trägt); trägt er eine andere, wird übersprungen.
 * - Mitglieder, die noch nie zugegriffen haben, entstehen mit `last_seen_at` NULL und sind damit in Auswahlen der App
 *   auswählbar. Name und E-Mail kommen aus Keycloak.
 * - Wer nicht mehr Mitglied ist, wird als entfernt markiert (`removed_at`) statt gelöscht: Verweise der App und Audit
 *   bleiben, neu auswählbar ist die Person nicht mehr. Wird sie wieder Mitglied oder meldet sich an, ist die Markierung
 *   weg.
 * - Maschinen-Clients (kind = client) bleiben unberührt.
 * - Offen eingeladene Personen (`member_invitation`) erscheinen erst nach Annahme, gleich ob für sie ein neues Konto
 *   angelegt wurde oder schon eines bestand. Aus Entra ID hinzugefügte gelten mit dem ersten Zugriff als angenommen.
 * - Tupel bleiben beim Austritt (A17): eine Rückkehr bringt die Rechte zurück. Im selben Lauf des Workers werden
 *   abgelaufene Tupel gelöscht (`access.expired`) und abgelaufenes Break-Glass zurückgesetzt (`break_glass.ended` mit
 *   `expired: true`, A8).
 * - Anzeigename: massgeblich ist der Name der Organisation in Keycloak. Weicht `tenant.name` ab (z. B. Alias als
 *   vorläufiger Name aus der Anlage beim ersten Login, Umbenennung in der Konsole), wird er nachgeführt
 *   (`organization.name_synced`, syncTenantName) – nur für den Mandanten mit derselben Keycloak-ID.
 *
 * Aufrufer: der Worker (MemberSync, alle Mandanten nach MEMBER_SYNC_INTERVAL, eigener Lese-Client KEYCLOAK_SYNC_*)
 * und die Verwaltung (admin.ts, nach dem Entfernen und beim Öffnen der Mitgliederliste).
 */
import type { Actor, AuditPort } from './audit.ts';
import { pgAudit } from './audit.ts';
import type { IamConfig } from './config.ts';
import { schemaName, withTenant, type Db } from './db.ts';
import { KeycloakAdmin, type KcOrg, type KcUser } from './keycloak.ts';
import { LOCKS, lockKey } from './locks.ts';
import { asciiLower } from './principal.ts';
import { findTenant, listTenants, type TenantRow } from './tenants.ts';
import { OidcProvider } from './tokens.ts';

/** Schema der Tabellen und Protokoll. */
export interface SyncContext { schema: string; audit: AuditPort }

/** Konto mit offenem «Passwort setzen» (eingeladen, Passwort noch nie gesetzt). */
export const pendingActions = (u: KcUser) => (u.requiredActions ?? []).includes('UPDATE_PASSWORD');
/** Anzeigename aus Keycloak: Vor- und Nachname, sonst Adresse, sonst Benutzername. */
export const displayName = (u: KcUser) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.username;

export interface SyncResult { alias: string; members: number; added: number; updated: number; removed: number; expired?: number; breakGlassEnded?: number; renamed?: boolean; skipped?: string }

const SYSTEM = (correlationId: string): Actor => ({ principal: null, source: 'system', correlationId });

/**
 * Gehört der Mandant zu dieser Organisation (Keycloak-ID)? Ohne gespeicherte ID wird sie jetzt gebunden –
 * app.resolve_tenant bindet nur, wenn keine andere Zeile sie trägt. false: andere ID, oder die ID gehört bereits einem
 * anderen Mandanten, oder der Mandant ist gesperrt und noch nicht gebunden (resolve_tenant bindet gesperrte nicht);
 * dann weder Personen übernehmen noch verwalten.
 */
export async function orgMatches(db: Db, t: TenantRow, org: KcOrg): Promise<boolean> {
  if (t.kc_org_id) return t.kc_org_id === org.id;
  // Gesperrt ohne ID: resolve_tenant bindet nicht, eine Prüfung ist nicht möglich – nicht als dieselbe Organisation werten
  if (t.status !== 'active') return false;
  const r = await db.query<{ id: string | null }>('SELECT app.resolve_tenant($1, $2, $3, false) AS id', [t.alias, org.id, org.name]);
  if (!r.rows[0]?.id) return false;
  return (await findTenant(db, t.alias))?.kc_org_id === org.id;
}

/**
 * Name des Mandanten aus Keycloak nachführen. Aufrufer prüfen vorher, dass der Mandant zu dieser Organisation gehört
 * (`kc_org_id`, orgMatches). Schreibt im Kontext des Mandanten (Richtlinie `tenant_self`) und nur bei Abweichung;
 * gleichzeitige Abgleiche (Worker, Plattformliste) schreiben dank Zeilensperre nur einmal. Weicht der Name ab, liest
 * der Abgleich die Organisation unter der Sperre neu: `org` kann vor einer gleichzeitigen Umbenennung über die Plattform
 * gelesen sein und überschriebe sonst den neuen Namen mit dem alten. true: geändert.
 */
export async function syncTenantName(ctx: SyncContext, db: Db, kc: Pick<KeycloakAdmin, 'getOrg'>, tenantId: string, org: KcOrg, correlationId = 'sync:organization-name'): Promise<boolean> {
  if (!org.name?.trim()) return false;
  const S = schemaName(ctx.schema);
  return withTenant(db, { tenantId }, async tx => {
    const cur = (await tx.query<{ name: string }>(`SELECT name FROM ${S}.tenant WHERE id = app.tenant_id() FOR UPDATE`)).rows[0];
    if (!cur || cur.name === org.name!.trim()) return false;
    const name = (await kc.getOrg(org.id))?.name?.trim();
    if (!name || cur.name === name) return false;
    await tx.query(`UPDATE ${S}.tenant SET name = $1 WHERE id = app.tenant_id()`, [name]);
    await ctx.audit.write(tx, SYSTEM(correlationId), { action: 'organization.name_synced', resourceType: 'tenant', resourceId: tenantId, data: { from: cur.name, to: name } });
    return true;
  });
}

/** Gleicht einen Mandanten mit den Mitgliedern seiner Organisation ab (eine Transaktion, Audit bei Änderungen). */
export async function syncTenantMembers(ctx: SyncContext, db: Db, tenantId: string, alias: string, members: KcUser[], correlationId = 'sync:members'): Promise<SyncResult> {
  const S = schemaName(ctx.schema);
  return withTenant(db, { tenantId }, async tx => {
    // Gleichzeitige Abgleiche desselben Mandanten (Worker und API) nacheinander
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey.peopleSync(tenantId)]);
    // Einladungen: angenommen, sobald Mitglied ohne offenes «Passwort setzen»; aus Entra ID (Konto ohne Passwort und
    // ohne Aktion) erst mit dem ersten Zugriff seit der Einladung. Offene erscheinen nicht im Verzeichnis.
    await tx.query(`UPDATE ${S}.member_invitation SET accepted_at = now() WHERE accepted_at IS NULL AND NOT entra AND user_id = ANY($1::text[])`, [members.filter(u => !pendingActions(u)).map(u => u.id)]);
    await tx.query(`UPDATE ${S}.member_invitation i SET accepted_at = now() WHERE i.accepted_at IS NULL AND i.entra AND i.user_id = ANY($1::text[])
      AND EXISTS (SELECT 1 FROM ${S}.principal p WHERE p.kind = 'user' AND p.subject = i.user_id AND p.removed_at IS NULL AND p.last_seen_at >= i.created_at)`, [members.map(u => u.id)]);
    const open = new Set((await tx.query<{ user_id: string }>(`SELECT user_id FROM ${S}.member_invitation WHERE accepted_at IS NULL`)).rows.map(r => r.user_id));
    // Offen eingeladene Mitglieder nicht als entfernt markieren: eine Person aus Entra ID kann schon zugreifen, während
    // dieser Abgleich ihre Einladung noch für offen hält
    const pending = members.filter(u => open.has(u.id)).map(u => u.id);
    members = members.filter(u => !open.has(u.id));
    const ids = members.map(u => u.id);
    const up = await tx.query<{ inserted: boolean }>(
      `INSERT INTO ${S}.principal AS p (tenant_id, kind, subject, display_name, email, last_seen_at)
       SELECT app.tenant_id(), 'user', u.sub, u.name, u.email, NULL FROM unnest($1::text[], $2::text[], $3::text[]) AS u(sub, name, email)
       ON CONFLICT (tenant_id, kind, subject) DO UPDATE
         SET display_name = excluded.display_name, email = excluded.email, removed_at = NULL
         WHERE p.removed_at IS NOT NULL OR p.display_name IS DISTINCT FROM excluded.display_name OR p.email IS DISTINCT FROM excluded.email
       RETURNING (xmax = 0) AS inserted`,
      [ids, members.map(displayName), members.map(u => u.email ?? null)]);
    const added = up.rows.filter(r => r.inserted).length;
    const removed = (await tx.query(
      `UPDATE ${S}.principal p SET removed_at = now() WHERE kind = 'user' AND removed_at IS NULL AND NOT (subject = ANY($1::text[]) OR subject = ANY($2::text[]))
         AND NOT EXISTS (SELECT 1 FROM ${S}.member_invitation i WHERE i.user_id = p.subject AND i.accepted_at IS NULL)`, [ids, pending])).rowCount ?? 0;
    if (added || removed) {
      await ctx.audit.write(tx, SYSTEM(correlationId), { action: 'people.synced', resourceType: 'tenant', resourceId: tenantId, data: { alias, members: ids.length, added, removed } });
    }
    return { alias, members: ids.length, added, updated: up.rows.length - added, removed };
  });
}

/**
 * Aufräumen eines Mandanten (A8): abgelaufene Tupel löschen (je Tupel `access.expired`), abgelaufenes Break-Glass
 * zurücksetzen (`break_glass.ended` mit `expired: true`). Eine Transaktion; Tupel erhöhen acl_version (Trigger).
 */
export async function expireAccess(ctx: SyncContext, db: Db, tenantId: string, correlationId = 'sync:expire'): Promise<{ expired: number; breakGlassEnded: number }> {
  const S = schemaName(ctx.schema);
  return withTenant(db, { tenantId }, async tx => {
    const actor = SYSTEM(correlationId);
    const tuples = (await tx.query<{ id: string; subject: string; relation: string; object_type: string; object_id: string | null; expires_at: Date }>(
      `DELETE FROM ${S}.authz_tuple WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING id, subject, relation, object_type, object_id, expires_at`)).rows;
    for (const t of tuples) {
      await ctx.audit.write(tx, actor, { action: 'access.expired', resourceType: 'tuple', resourceId: t.id, data: { subject: t.subject, relation: t.relation, type: t.object_type, id: t.object_id, expiresAt: t.expires_at.toISOString() } });
    }
    const ended = (await tx.query<{ id: string }>(
      `UPDATE ${S}.principal SET clearance_boost = NULL, clearance_until = NULL WHERE clearance_until IS NOT NULL AND clearance_until <= now() RETURNING id`)).rows;
    for (const p of ended) await ctx.audit.write(tx, actor, { action: 'break_glass.ended', resourceType: 'principal', resourceId: p.id, data: { expired: true } });
    return { expired: tuples.length, breakGlassEnded: ended.length };
  });
}

/** Aufräumen in allen aktiven Mandanten (Worker, auch ohne Abgleich mit Keycloak). */
export async function expireAllAccess(ctx: SyncContext, db: Db, log: (m: string, d?: Record<string, unknown>) => void = () => undefined): Promise<{ alias: string; expired: number; breakGlassEnded: number }[]> {
  const out: { alias: string; expired: number; breakGlassEnded: number }[] = [];
  for (const t of await listTenants(db)) {
    if (t.status !== 'active') continue;
    try {
      const r = await expireAccess(ctx, db, t.id);
      if (r.expired || r.breakGlassEnded) out.push({ alias: t.alias, ...r });
    } catch (e) { log('Aufräumen fehlgeschlagen', { alias: t.alias, error: (e as Error).message }); }
  }
  return out;
}

type Log = (m: string, d?: Record<string, unknown>) => void;

/** Alle Organisationen mit aktivem Mandanten abgleichen. Fehler einer Organisation halten die anderen nicht auf. */
export async function syncAllMembers(ctx: SyncContext, db: Db, kc: KeycloakAdmin, log: Log = () => undefined): Promise<SyncResult[]> {
  const [orgs, tenants] = await Promise.all([kc.listOrgs(), listTenants(db)]);
  const byAlias = new Map(tenants.map(t => [t.alias, t]));
  const out: SyncResult[] = [];
  const skip = (alias: string, skipped: string) => out.push({ alias, members: 0, added: 0, updated: 0, removed: 0, skipped });
  for (const o of orgs) {
    // Alias nur ASCII klein (wie findTenant; toLowerCase() faltete das Kelvin-Zeichen zu «k»)
    const t = byAlias.get(asciiLower(o.alias));
    if (!t) { skip(o.alias, 'kein Mandant'); continue; }
    if (t.status !== 'active') { skip(o.alias, 'gesperrt'); continue; }
    try {
      // Zuordnung über die ID der Organisation, nicht nur den Alias: ein neu vergebener Alias bekommt nicht die Personen
      // eines bestehenden Mandanten (und umgekehrt). Fehlt die ID, wird sie jetzt gebunden.
      if (!(await orgMatches(db, t, o))) { log('Organisation passt nicht zum Mandanten (andere Keycloak-ID)', { alias: o.alias }); skip(o.alias, 'andere Organisation'); continue; }
      const renamed = t.name !== o.name?.trim() && await syncTenantName(ctx, db, kc, t.id, o);
      out.push({ ...await syncTenantMembers(ctx, db, t.id, t.alias, await kc.members(o.id)), ...(renamed ? { renamed } : {}) });
    } catch (e) { log('Abgleich der Mitglieder fehlgeschlagen', { alias: o.alias, error: (e as Error).message }); skip(o.alias, 'Fehler'); }
  }
  return out;
}

/**
 * Worker-Job: Abgleich über alle Mandanten nach MEMBER_SYNC_INTERVAL mit dem eigenen Lese-Client KEYCLOAK_SYNC_* (nicht
 * dem Verwaltungs-Client der API). Eine Sperre über die Datenbank (`LOCKS.memberSync`, Sitzung) sorgt dafür, dass über
 * alle Worker-Instanzen höchstens ein Lauf gleichzeitig stattfindet.
 */
export class MemberSync {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private readonly db: Db;
  private readonly cfg: Pick<IamConfig, 'memberSync'>;
  private readonly ctx: SyncContext;
  private readonly log: Log;
  readonly kc: KeycloakAdmin | null;

  /** @param o.audit Protokoll (Standard `pgAudit` im Schema), @param o.fetch Abruf bei Keycloak (Tests) */
  constructor(cfg: Pick<IamConfig, 'oidc' | 'mgmt' | 'memberSync'>, db: Db, o: { schema: string; audit?: AuditPort; log?: Log; fetch?: typeof fetch }) {
    this.db = db; this.cfg = cfg; this.log = o.log ?? (() => undefined);
    this.ctx = { schema: o.schema, audit: o.audit ?? pgAudit({ schema: o.schema }) };
    const s = cfg.memberSync;
    const provider = new OidcProvider(cfg.oidc.issuer, o.fetch);
    this.kc = s.clientId ? new KeycloakAdmin(cfg, async () => (await provider.discovery()).token_endpoint, o.fetch, s) : null;
  }

  /** Ein Lauf über alle Mandanten; `null`, wenn gerade eine andere Instanz abgleicht. */
  async runOnce(): Promise<SyncResult[] | null> {
    const c = await this.db.connect();
    let locked = false;
    try {
      locked = (await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCKS.memberSync])).rows[0]!.ok;
      if (!locked) return null;
      const synced = this.kc ? await syncAllMembers(this.ctx, this.db, this.kc, this.log) : [];
      const expired = await expireAllAccess(this.ctx, this.db, this.log);
      for (const e of expired) {
        const hit = synced.find(r => r.alias === e.alias);
        if (hit) Object.assign(hit, { expired: e.expired, breakGlassEnded: e.breakGlassEnded });
        else synced.push({ alias: e.alias, members: 0, added: 0, updated: 0, removed: 0, expired: e.expired, breakGlassEnded: e.breakGlassEnded, skipped: 'nur aufgeräumt' });
      }
      return synced;
    } finally {
      if (locked) await c.query('SELECT pg_advisory_unlock($1)', [LOCKS.memberSync]).catch(() => undefined);
      c.release();
    }
  }

  /** Regelmässig abgleichen: erster Lauf nach `firstDelayMs`, danach alle MEMBER_SYNC_INTERVAL. */
  start(firstDelayMs = 30_000) {
    if (!this.kc) this.log('Abgleich der Mitglieder abgeschaltet (KEYCLOAK_SYNC_CLIENT_ID fehlt); abgelaufene Freigaben werden trotzdem aufgeräumt');
    if (this.cfg.memberSync.intervalMs <= 0) { this.log('Abgleich der Mitglieder abgeschaltet (MEMBER_SYNC_INTERVAL=0)'); return; }
    const loop = async () => {
      if (this.stopped) return;
      const started = performance.now();
      try {
        const res = await this.runOnce();
        if (res === null) this.log('Abgleich der Mitglieder übersprungen: läuft in einer anderen Instanz');
        else {
          const changed = res.filter(r => r.added || r.removed);
          if (changed.length) this.log('Mitglieder abgeglichen', { tenants: changed.map(r => ({ alias: r.alias, added: r.added, removed: r.removed })), durationMs: Math.round(performance.now() - started) });
          const renamed = res.filter(r => r.renamed).map(r => r.alias);
          if (renamed.length) this.log('Namen der Organisationen nachgeführt', { tenants: renamed });
        }
      } catch (e) { this.log('Abgleich der Mitglieder fehlgeschlagen', { error: (e as Error).message }); }
      if (!this.stopped) { this.timer = setTimeout(() => { this.running = loop(); }, this.cfg.memberSync.intervalMs); this.timer.unref(); }
    };
    this.timer = setTimeout(() => { this.running = loop(); }, firstDelayMs);
    this.timer.unref();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
