/**
 * Mandanten verwalten: auflisten, anlegen, sperren, entsperren, an eine andere Keycloak-Organisation hängen (aus Assets
 * `ops/tenants.ts`). Genutzt von Betriebsskripten (`org-bootstrap`) und der Plattform-Administration der API (Module
 * `admin` und `clients`, nur platform-admin). Fachdaten löschen (`purgeTenantData`) bleibt in der App, weil nur sie
 * ihre Tabellen kennt (Entwurf 7.1).
 *
 * Lesen über alle Mandanten und den Status setzen laufen über `app.platform_tenants()` und `app.set_tenant_status()`
 * (SECURITY DEFINER, iam_002) – so geht dasselbe mit der Besitzer-Rolle (Skript) und der Laufzeit (API). Das Protokoll
 * schreibt die Laufzeit-Rolle im Mandantenkontext über den `AuditPort`.
 */
import type pg from 'pg';
import type { Actor, AuditPort } from './audit.ts';
import { schemaName, withTenant, type Db } from './db.ts';
import { asciiLower, type PrincipalResolver } from './principal.ts';

type Admin = pg.ClientBase | Db;

/**
 * Schema der Tabellen und Protokoll. `resolver`: Zwischenspeicher der Mandanten dieser Instanz (`iam.resolver`); nach
 * Sperren, Entsperren und Umhängen vergessen (Spezifikation Kap. 6). Ohne Angabe (Betriebsskript) gilt die Änderung in
 * laufenden Instanzen nach spätestens 60 s.
 */
export interface TenantsContext { schema: string; audit: AuditPort; resolver?: Pick<PrincipalResolver, 'forgetTenant'> | null }

/** Wer handelt: ohne Angabe der Betrieb (Skript), sonst die angemeldete Plattform-Administration; `data` ergänzt das Protokoll. */
export interface TenantActor extends Actor { data?: Record<string, unknown> }
const who = (op: string, actor?: TenantActor): Actor => actor ?? { principal: null, source: 'system', correlationId: `ops:${op}` };

export interface TenantRow { id: string; alias: string; name: string; status: string; kc_org_id: string | null; created_at: Date }

const COLS = 'id, alias, name, status, kc_org_id, created_at';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export async function listTenants(admin: Admin): Promise<TenantRow[]> {
  return (await admin.query<TenantRow>(`SELECT ${COLS} FROM app.platform_tenants()`)).rows;
}

/** Mandant nach Alias; nur ASCII klein geschrieben verglichen (wie der Resolver; `lower()` faltete das Kelvin-Zeichen). */
export async function findTenant(admin: Admin, alias: string): Promise<TenantRow | null> {
  return (await admin.query<TenantRow>(`SELECT ${COLS} FROM app.platform_tenants() WHERE alias = $1`, [asciiLower(alias)])).rows[0] ?? null;
}

async function record(ctx: TenantsContext, runtime: Db, tenantId: string, actor: Actor, e: { action: string; data: Record<string, unknown> }) {
  await withTenant(runtime, { tenantId }, tx => ctx.audit.write(tx, actor, { action: e.action, resourceType: 'tenant', resourceId: tenantId, data: e.data }));
}

/** Legt den Mandanten an (wie beim ersten Zugriff mit TENANT_AUTO_PROVISION) und protokolliert es. */
export async function createTenant(ctx: TenantsContext, admin: Admin, runtime: Db, alias: string, name?: string, kcOrgId?: string, actor?: TenantActor): Promise<TenantRow> {
  const id = (await runtime.query<{ id: string | null }>('SELECT app.resolve_tenant($1, $2, $3, true) AS id', [alias, kcOrgId ?? null, name ?? alias])).rows[0]!.id;
  const t = await findTenant(admin, alias);
  if (t && kcOrgId && t.kc_org_id && t.kc_org_id !== kcOrgId) throw new Error(`Mandant «${t.alias}» gehört zu einer anderen Keycloak-Organisation (${t.kc_org_id}); umhängen mit relinkTenant`);
  if (!id || !t) throw new Error(`Mandant «${alias}» ist gesperrt oder konnte nicht angelegt werden`);
  await record(ctx, runtime, t.id, who('tenant-create', actor), { action: 'tenant.provisioned', data: { alias: t.alias, ...actor?.data } });
  return t;
}

/**
 * Sperren: keine Anmeldung, keine API-Zugriffe, Worker holt keine Jobs ab. Entsperren stellt alles wieder her. Vergisst
 * den Mandanten in `ctx.resolver`; andere Instanzen (und ohne `resolver`) nach spätestens 60 s. Gleicher Status: nichts
 * geändert, kein Protokolleintrag.
 */
export async function setTenantStatus(ctx: TenantsContext, admin: Admin, runtime: Db, alias: string, status: 'active' | 'suspended', reason = '', actor?: TenantActor): Promise<TenantRow> {
  const t = await findTenant(admin, alias);
  if (!t) throw new Error(`Mandant «${alias}» nicht gefunden`);
  if (t.status === status) return t;
  await admin.query('SELECT app.set_tenant_status($1, $2)', [t.id, status]);
  ctx.resolver?.forgetTenant(t.alias);
  // Bestehende Sitzungen der Oberfläche enden beim nächsten Zugriff (Mandant nicht verfügbar).
  await record(ctx, runtime, t.id, who(`tenant-${status}`, actor), { action: status === 'suspended' ? 'tenant.suspended' : 'tenant.resumed', data: { reason, ...actor?.data } });
  return { ...t, status };
}

/**
 * Hängt den Mandanten an eine andere Keycloak-Organisation (neue ID, z. B. nach dem Umzug des Realms auf eine neue
 * Instanz). `app.resolve_tenant()` verweigert den Zugriff, solange Alias und Organisations-ID nicht zusammenpassen; Daten
 * und Mandant bleiben erhalten. Idempotent (gleiche ID: nichts geändert), protokolliert alte und neue ID. Nur mit der
 * Besitzer-Rolle (Betriebsskript): die Laufzeit darf die Mandantenzeile nicht ändern. Vergisst den Mandanten in
 * `ctx.resolver` (sonst nach spätestens 60 s). E-Mail-Adressen werden nur ASCII klein geschrieben verglichen (`lower()`
 * faltete das Kelvin-Zeichen zu «k»).
 */
export async function relinkTenant(
  ctx: TenantsContext, admin: pg.ClientBase | Db, runtime: Db, alias: string, kcOrgId: string, subjects: Record<string, string> = {}, actor?: TenantActor,
): Promise<TenantRow & { changed: boolean; principals: number }> {
  const schema = schemaName(ctx.schema);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(kcOrgId)) throw new Error('Organisations-ID muss eine UUID sein');
  for (const [email, sub] of Object.entries(subjects)) {
    if (!email.includes('@') || !uuid.test(sub)) throw new Error(`Zuordnung «${email}=${sub}»: E-Mail=Benutzer-ID (UUID)`);
  }
  const t = await findTenant(admin, alias);
  if (!t) throw new Error(`Mandant «${alias}» nicht gefunden`);
  const other = (await admin.query<{ alias: string }>('SELECT alias FROM app.platform_tenants() WHERE kc_org_id = $1 AND id <> $2', [kcOrgId, t.id])).rows[0];
  if (other) throw new Error(`Organisations-ID gehört schon zum Mandanten «${other.alias}»`);

  // Personen (Spiegel aus Keycloak) behalten ihre ID und damit alles, was an ihnen hängt (Zugriffsregeln, Protokoll,
  // Daten der App); nur das Keycloak-Subjekt wechselt. Zuordnung über die E-Mail, nur wo sich etwas ändert.
  // principal ist nur für die Laufzeit im Mandantenkontext sichtbar (RLS mit FORCE); zuerst die Personen, dann die
  // Mandantenzeile – bricht etwas ab, bleibt die alte Organisation verbunden und ein zweiter Lauf setzt fort.
  const moved = await withTenant(runtime, { tenantId: t.id }, async tx => {
    const out: { email: string; from: string; to: string }[] = [];
    for (const [email, sub] of Object.entries(subjects)) {
      const hit = (await tx.query<{ id: string; subject: string }>(
        `SELECT id, subject FROM ${schema}.principal WHERE tenant_id = $1 AND kind = 'user' AND translate(email, $3, $4) = $2 FOR UPDATE`,
        [t.id, asciiLower(email), UPPER, UPPER.toLowerCase()])).rows;
      if (hit.length > 1) throw new Error(`Mehrere Personen mit der E-Mail ${email} – von Hand klären`);
      if (!hit[0] || hit[0].subject === sub) continue;
      await tx.query(`UPDATE ${schema}.principal SET subject = $3 WHERE tenant_id = $1 AND id = $2`, [t.id, hit[0].id, sub]);
      out.push({ email: asciiLower(email), from: hit[0].subject, to: sub });
    }
    return out;
  });
  if (t.kc_org_id !== kcOrgId) await admin.query(`UPDATE ${schema}.tenant SET kc_org_id = $2 WHERE id = $1`, [t.id, kcOrgId]);
  const changed = t.kc_org_id !== kcOrgId || moved.length > 0;
  if (t.kc_org_id !== kcOrgId) ctx.resolver?.forgetTenant(t.alias);
  if (changed) await record(ctx, runtime, t.id, who('tenant-relink', actor), { action: 'tenant.relinked', data: { from: t.kc_org_id, to: kcOrgId, principals: moved, ...actor?.data } });
  return { ...t, kc_org_id: kcOrgId, changed, principals: moved.length };
}
