/**
 * Modul `roles`: Rollen als Ressource (Spezifikation Kap. 8.3, 9.2; aus Assets `modules/admin/roles.ts`): vordefinierte
 * Rollen aus dem Katalog der App (nur lesbar) und eigene Rollen der Organisation (`tenant_role`) mit Name, Beschreibung
 * und Rechten.
 *
 * - Lesen: jede Person und jeder Client mit `tenant:read`. Anlegen, ändern, löschen: Personen mit `members:admin`
 *   (nie Maschinen-Clients oder MCP, kein Scope deckt das Recht ab).
 * - Eigene Rollen enthalten keine Rechte, die nur «Organisations-Admin» hat (`adminOnly`): Sonst könnte eine eigene Rolle
 *   Mitglieder und Rollen verwalten oder Zugriffsregeln ändern und so die Grenze zu org-admin umgehen.
 * - Der technische Name (`c-…`) entsteht aus dem Namen und ändert sich nie; er ist der Name der Keycloak-Gruppe
 *   `<prefix>/<alias>/<key>`, über die die Rolle vergeben wird (Modul `admin`), und die Rolle in ACL-Einträgen.
 * - Ändern unter der Sperre der Organisation (`admin:<alias>`, Zeile mit FOR UPDATE), damit If-Match auch bei
 *   gleichzeitigen Anfragen gilt.
 * - Löschen entfernt zuerst die Gruppe in Keycloak (alle verlieren die Rolle), dann die ACL-Einträge der Rolle und ihrer
 *   Gruppe (mit `acl.changed`); die Rolle selbst bleibt als Grabstein (`deleted_at`), ihr technischer Name wird nie wieder vergeben. Noch gültige Tokens
 *   früherer Mitglieder tragen die Gruppe weiter im Claim; mit neuem Schlüssel erben sie so nie eine spätere Rolle.
 * Braucht keinen Verwaltungs-Client: ohne ihn keine Gruppen in Keycloak und keine Anzahl Personen.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MAX_CUSTOM_ROLES, roleList, TENANT_ROLE_COLS, type TenantRoleRow } from '../admin.ts';
import { ADMIN_ROLE, CUSTOM_ROLE_PREFIX } from '../catalog.ts';
import type { Tx } from '../db.ts';
import { conflict, HttpError, invalid, notFound } from '../errors.ts';
import { lockKey } from '../locks.ts';
import { RoleListSchema, RoleSchema } from './admin.ts';
import { Deleted, etag, ifMatchVersion, personOf, routeSchema, type IamModule, type ModuleContext } from './routes.ts';

const TAG = 'Verwaltung: Rollen';

/** Technischer Name aus dem Namen: `c-` + Kleinbuchstaben, Ziffern und «-» (Umlaute umschrieben). */
export function roleKey(label: string): string {
  const slug = label.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return `${CUSTOM_ROLE_PREFIX}${slug || 'rolle'}`;
}

const KeyParams = Type.Object({ key: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }) });
const IfMatch = Type.Object({ 'if-match': Type.Optional(Type.String({ description: 'ETag aus GET (W/"<version>"). Bei Abweichung 412.' })) });
const Label = Type.String({ minLength: 1, maxLength: 60 });
const Description = Type.String({ maxLength: 500 });

export const rolesModule: IamModule = {
  name: 'roles',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const { catalog } = iam;
    const S = iam.schema, svc = iam.admin;
    const SELECT = `SELECT ${TENANT_ROLE_COLS} FROM ${S}.tenant_role WHERE deleted_at IS NULL`;
    if (!app.getSchema('Role')) app.addSchema(RoleSchema);
    const Permission = Type.Unsafe<string>({ type: 'string', enum: [...catalog.permissions] });
    const Permissions = Type.Array(Permission, { minItems: 1, maxItems: 100, uniqueItems: true, description: 'Rechte der Rolle; nicht erlaubt sind Rechte, die nur «Organisations-Admin» hat (`adminOnly` im Katalog)' });
    const adminLabel = catalog.roles.get(ADMIN_ROLE)!.label;
    /** Rechte in Katalogreihenfolge. */
    const ordered = (ps: string[]) => catalog.permissions.filter(p => ps.includes(p));

    /** Nur Personen mit `members:admin`, nie Clients oder Zugriffe über MCP. */
    const manager = async (req: FastifyRequest) => {
      const p = personOf(req);
      await req.need('members:admin');
      return p;
    };
    /** Personen je Rolle, nur für `members:admin` und mit Verwaltung in Keycloak; scheitert Keycloak, ohne Zahlen. */
    const counts = async (req: FastifyRequest): Promise<Map<string, number> | null> => {
      const p = req.requirePrincipal();
      if (!svc || p.kind !== 'user' || p.scopeBound || !(await req.can('members:admin'))) return null;
      try { return await svc.roleMemberCounts(p.tenantAlias); } catch { return null; }
    };
    const one = (r: TenantRoleRow, c: Map<string, number> | null) => roleList(catalog, [r], c).items.at(-1)!;
    const load = async (tx: Tx, key: string, lock = false) => {
      const r = (await tx.query<TenantRoleRow>(`${SELECT} AND key = $1${lock ? ' FOR UPDATE' : ''}`, [key])).rows[0];
      if (!r) throw notFound(`Rolle «${key}»`);
      return r;
    };
    /**
     * Änderungen an Rollen laufen unter der Sperre der Organisation (wie die Verwaltung, die Rollen vergibt): sonst
     * überholten sich gleichzeitige Änderungen (If-Match), oder eine Gruppe in Keycloak verschwände für eine Rolle, die
     * eine gleichzeitige Änderung schon wieder anders sieht.
     */
    const locked = <T>(req: FastifyRequest, alias: string, fn: (tx: Tx) => Promise<T>) => req.tx(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey.admin(alias)]);
      return fn(tx);
    });
    const builtinGuard = (key: string) => {
      const b = catalog.roles.get(key);
      if (b) throw conflict(`«${b.label}» ist eine vordefinierte Rolle und lässt sich nicht ändern oder löschen. Eine eigene Rolle mit diesen Rechten als Ausgangspunkt anlegen.`, { reason: 'builtin-role' });
    };
    const versionGuard = (r: TenantRoleRow, expected: number | undefined) => {
      if (expected !== undefined && expected !== r.version) throw new HttpError(412, 'Rolle wurde inzwischen geändert', `Aktuelle Version ${r.version}.`, {}, { currentVersion: r.version });
    };
    /** Feldfehler für Name und Rechte einer eigenen Rolle; `self`: ID der geänderten Rolle (Name darf gleich bleiben). */
    const check = async (tx: Tx, b: { label?: string; permissions?: string[] }, self: string | null) => {
      const errors: { path: string; message: string }[] = [];
      if (b.label !== undefined) {
        const label = b.label.trim();
        if (!label) errors.push({ path: '/label', message: 'Namen angeben' });
        else if ([...catalog.roles.values()].some(r => r.label.toLowerCase() === label.toLowerCase())) errors.push({ path: '/label', message: `«${label}» ist eine vordefinierte Rolle. Einen anderen Namen wählen.` });
        else if ((await tx.query(`SELECT 1 FROM ${S}.tenant_role WHERE deleted_at IS NULL AND lower(btrim(label)) = lower($1) AND id IS DISTINCT FROM $2::uuid`, [label, self])).rowCount) {
          errors.push({ path: '/label', message: `Eine Rolle «${label}» gibt es schon.` });
        }
      }
      for (const p of b.permissions ?? []) {
        if (!catalog.customRolePermissions.includes(p)) errors.push({ path: '/permissions', message: `Das Recht ${catalog.permissionText(p)} hat nur die Rolle «${adminLabel}» und lässt sich keiner eigenen Rolle geben.` });
      }
      if (errors.length) throw invalid('Die Rolle lässt sich so nicht speichern.', errors);
    };
    const changed = (alias: string, tenantId: string) => { svc?.forgetRoles(alias); iam.access.invalidate(tenantId); };

    const list = `${prefix}/roles`, item = `${prefix}/roles/:key`;
    app.get(list, {
      schema: routeSchema(ctx, 'GET', list, {
        tags: [TAG], summary: 'Rollen der Organisation',
        description: 'Zuerst die vordefinierten Rollen (Reihenfolge wie im Katalog), dann die eigenen Rollen nach Namen. `memberCount` nur mit Recht `members:admin`.',
        response: { 200: RoleListSchema },
      }),
    }, async req => {
      await req.need('tenant:read');
      const rows = await req.tx(async tx => (await tx.query<TenantRoleRow>(`${SELECT} ORDER BY lower(label)`)).rows);
      return roleList(catalog, rows, await counts(req));
    });

    app.get(item, {
      schema: routeSchema(ctx, 'GET', item, { tags: [TAG], summary: 'Rolle lesen', params: KeyParams, response: { 200: Type.Ref('Role') } }),
    }, async (req, reply) => {
      await req.need('tenant:read');
      const { key } = req.params as { key: string };
      if (catalog.roles.has(key)) return roleList(catalog, [], await counts(req)).items.find(r => r.key === key);
      const r = await req.tx(tx => load(tx, key));
      return reply.header('etag', etag(r.version)).send(one(r, await counts(req)));
    });

    app.post(list, {
      schema: routeSchema(ctx, 'POST', list, {
        tags: [TAG], summary: 'Eigene Rolle anlegen',
        description: 'Der technische Name (`key`, `c-…`) entsteht aus dem Namen und bleibt. Abgelehnt (422): Name einer vordefinierten oder bestehenden Rolle, Rechte nur für «Organisations-Admin». Höchstens `maxCustom` eigene Rollen (409).',
        body: Type.Object({ label: Label, description: Type.Optional(Description), permissions: Permissions }, { additionalProperties: false }),
        response: { 201: Type.Ref('Role') },
      }),
    }, async (req, reply) => {
      const p = await manager(req);
      const b = req.body as { label: string; description?: string; permissions: string[] };
      const r = await locked(req, p.tenantAlias, async tx => {
        await check(tx, b, null);
        if (Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${S}.tenant_role WHERE deleted_at IS NULL`)).rows[0]!.n) >= MAX_CUSTOM_ROLES) {
          throw conflict(`Höchstens ${MAX_CUSTOM_ROLES} eigene Rollen je Organisation. Eine nicht mehr benutzte Rolle löschen.`, { reason: 'too-many-roles' });
        }
        // Kurzname schon vergeben (anderer Name mit gleicher Schreibweise ohne Sonderzeichen, oder gelöschte Rolle als
        // Grabstein – deren Schlüssel kann noch in gültigen Tokens stehen): Ziffer anhängen
        const base = roleKey(b.label);
        const taken = new Set((await tx.query<{ key: string }>(`SELECT key FROM ${S}.tenant_role WHERE key LIKE $1`, [`${base}%`])).rows.map(x => x.key));
        let key = base;
        for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
        const row = (await tx.query<TenantRoleRow>(`INSERT INTO ${S}.tenant_role (tenant_id, key, label, description, permissions, created_by, updated_by)
          VALUES (app.tenant_id(), $1, $2, $3, $4, $5, $5) RETURNING ${TENANT_ROLE_COLS}`,
        [key, b.label.trim(), (b.description ?? '').trim(), ordered(b.permissions), p.principalId])).rows[0]!;
        await req.audit(tx, { action: 'role.created', resourceType: 'role', resourceId: row.id, data: { key, label: row.label, permissions: row.permissions } });
        return row;
      });
      changed(p.tenantAlias, p.tenantId);
      return reply.status(201).header('etag', etag(r.version)).header('location', `${list}/${r.key}`).send(one(r, null));
    });

    app.patch(item, {
      schema: routeSchema(ctx, 'PATCH', item, {
        tags: [TAG], summary: 'Eigene Rolle ändern', params: KeyParams, headers: IfMatch,
        description: 'Name, Beschreibung und Rechte; der technische Name bleibt. Neue Rechte gelten sofort für alle Personen mit der Rolle. Vordefinierte Rollen: 409. Mit `If-Match` optimistisch gesperrt (412).',
        body: Type.Object({ label: Type.Optional(Label), description: Type.Optional(Description), permissions: Type.Optional(Permissions) }, { additionalProperties: false }),
        response: { 200: Type.Ref('Role') },
      }),
    }, async (req, reply) => {
      const p = await manager(req);
      const b = req.body as { label?: string; description?: string; permissions?: string[] };
      const { key } = req.params as { key: string };
      builtinGuard(key);
      const expected = ifMatchVersion(req.headers['if-match']);
      const r = await locked(req, p.tenantAlias, async tx => {
        const cur = await load(tx, key, true);
        versionGuard(cur, expected);
        await check(tx, { label: b.label, permissions: b.permissions }, cur.id);
        const next = { label: b.label?.trim() ?? cur.label, description: b.description?.trim() ?? cur.description, permissions: b.permissions ? ordered(b.permissions) : cur.permissions };
        const added = next.permissions.filter(x => !cur.permissions.includes(x)), removed = cur.permissions.filter(x => !next.permissions.includes(x));
        const row = (await tx.query<TenantRoleRow>(`UPDATE ${S}.tenant_role SET label = $2, description = $3, permissions = $4, version = version + 1, updated_at = now(), updated_by = $5
          WHERE id = $1 AND deleted_at IS NULL RETURNING ${TENANT_ROLE_COLS}`, [cur.id, next.label, next.description, next.permissions, p.principalId])).rows[0]!;
        await req.audit(tx, { action: 'role.updated', resourceType: 'role', resourceId: row.id, data: { key, label: row.label, ...(row.label !== cur.label ? { previousLabel: cur.label } : {}), added, removed } });
        return row;
      });
      changed(p.tenantAlias, p.tenantId);
      return reply.header('etag', etag(r.version)).send(one(r, null));
    });

    app.delete(item, {
      schema: routeSchema(ctx, 'DELETE', item, {
        tags: [TAG], summary: 'Eigene Rolle löschen', params: KeyParams, headers: IfMatch,
        description: 'Alle Personen verlieren die Rolle sofort (Gruppe in Keycloak gelöscht); ACL-Einträge für die Rolle werden mit gelöscht. Vordefinierte Rollen: 409. `If-Match` wird geprüft.',
        response: Deleted,
      }),
    }, async (req, reply) => {
      const p = await manager(req);
      const { key } = req.params as { key: string };
      builtinGuard(key);
      const expected = ifMatchVersion(req.headers['if-match']);
      const prefixPath = `${iam.cfg.tenancy.groupRolePrefix}/${p.tenantAlias}/${key}`;
      await locked(req, p.tenantAlias, async tx => {
        const r = await load(tx, key, true);
        versionGuard(r, expected);
        // Gruppe in Keycloak erst unter Sperre und nach der Prüfung: scheitert danach die Datenbank, bleibt nur eine Rolle
        // ohne Personen zurück, nie eine verwaiste Gruppe
        const members = svc && iam.cfg.tenancy.roleSource !== 'client' ? await svc.deleteRoleGroup(p.tenantAlias, key) : 0;
        // Zugriffsregeln auf die Rolle und auf ihre Gruppe (`<prefix>/<alias>/<key>`): beide wirkten sonst weiter, die Gruppe
        // in noch gültigen Tokens früherer Mitglieder
        const acl = (await tx.query<{ id: string; resource_type: string; resource_id: string | null; principal_type: string; principal_ref: string; permission: string; effect: string }>(
          `DELETE FROM ${S}.acl_entry WHERE (principal_type = 'role' AND principal_ref = $1) OR (principal_type = 'group' AND principal_ref = $2)
           RETURNING id, resource_type, resource_id, principal_type, principal_ref, permission, effect`, [key, prefixPath])).rows;
        for (const e of acl) {
          await iam.events?.(tx, 'acl.changed', e.resource_id, { action: 'acl.deleted', resourceType: e.resource_type, resourceId: e.resource_id, aclId: e.id, principalType: e.principal_type, principalRef: e.principal_ref, permission: e.permission, effect: e.effect, reason: 'role.deleted' });
        }
        await tx.query(`UPDATE ${S}.tenant_role SET deleted_at = now(), version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`, [r.id, p.principalId]);
        await req.audit(tx, { action: 'role.deleted', resourceType: 'role', resourceId: r.id, data: { key, label: r.label, permissions: r.permissions, members, aclEntries: acl.length } });
      });
      changed(p.tenantAlias, p.tenantId);
      return reply.status(204).send(null);
    });
  },
};
