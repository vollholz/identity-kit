/**
 * Modul `acl`: Zugriffsregeln anlegen, auflisten, löschen und wirksame Rechte prüfen (echt und Simulation), aus Assets
 * `modules/catalog/governance.ts` (Teil ACL). Ressourcentypen, Rechte und Rollen kommen aus dem Katalog der App; ob eine
 * Ressource existiert, prüft das `ResourceModel` mit voller Lesesicht der App (Entwurf 13.3).
 *
 * Mandantentrennung: alles unter RLS im Kontext des Principals; Gruppen anderer Organisationen 422; die Ressource muss im
 * eigenen Mandanten existieren (sonst 404); echte Rollen anderer Personen nur für Mitglieder der eigenen Organisation.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ACL_EFFECTS, type AclEffect, type TenantAccess } from '../access.ts';
import { ADMIN_ROLE, type Catalog } from '../catalog.ts';
import type { Tx } from '../db.ts';
import { invalid, notFound } from '../errors.ts';
import type { Iam } from '../iam.ts';
import type { Principal } from '../principal.ts';
import type { ResourceRef } from '../resources.ts';
import { DateTime, Deleted, IdParams, Nullable, Params, routeSchema, Uuid, type IamModule, type ModuleContext } from './routes.ts';

const TAG_ACL = 'Verwaltung: Zugriff';
const PRINCIPAL_TYPES = ['user', 'group', 'role', 'client'] as const;

interface AclBody { resourceType: string; resourceId?: string | null; principalType: typeof PRINCIPAL_TYPES[number]; principalRef: string; permission: string; effect?: AclEffect | 'allow' }

/**
 * Feldfehler für Zugriffsregeln, die nie wirken würden oder nicht erlaubt sind: Recht passt nicht zur Ressource,
 * Freigabe auf einem Blatt oder eines Rechts nur von org-admin, Verbot/Beschränkung eines Rechts nur von org-admin für
 * andere als Maschinen-Clients (Personen mit org-admin sind ausgenommen), Rolle org-admin oder unbekannt.
 * `customRoles`: eigene Rollen der Organisation.
 */
export function pointlessAcl(catalog: Catalog, b: { resourceType: string; principalType: string; principalRef: string; permission: string; effect: AclEffect }, customRoles: ReadonlyMap<string, unknown> = new Map()) {
  const errors: { path: string; message: string }[] = [];
  const label = (t: string) => catalog.resourceTypes.find(r => r.key === t)?.label ?? t;
  const fits = catalog.info.get(b.permission)?.resources ?? [], admin = catalog.roles.get(ADMIN_ROLE)!.label;
  const text = catalog.permissionText(b.permission);
  if (catalog.adminOnly.has(b.permission) && b.effect === 'grant') errors.push({ path: '/permission', message: `Das Recht ${text} hat nur die Rolle «${admin}» und lässt sich nicht freigeben.` });
  else if (catalog.adminOnly.has(b.permission) && b.principalType !== 'client') errors.push({ path: '/permission', message: `Das Recht ${text} hat nur die Rolle «${admin}»; Personen mit dieser Rolle sind von Zugriffsregeln ausgenommen. Wirksam nur für einen Maschinen-Client.` });
  else if (!fits.includes(b.resourceType)) errors.push({ path: '/permission', message: `Das Recht ${text} wirkt nicht auf «${label(b.resourceType)}»; passend: ${fits.map(label).join(', ')}.` });
  if (b.effect === 'grant' && catalog.resourceTypes.find(r => r.key === b.resourceType)?.leaf) {
    const areas = catalog.resourceTypes.filter(r => !r.leaf).map(r => r.label).join(', ');
    errors.push({ path: '/effect', message: `Freigaben gelten für Bereiche (${areas}), nicht für einzelne Ressourcen vom Typ «${label(b.resourceType)}».` });
  }
  if (b.principalType === 'role' && b.principalRef === ADMIN_ROLE) errors.push({ path: '/principalRef', message: `Die Rolle «${admin}» (${ADMIN_ROLE}) hat schon alle Rechte, und Personen damit sind von Zugriffsregeln ausgenommen; Maschinen-Clients mit dieser Rolle begrenzt ein Eintrag für den Client.` });
  else if (b.principalType === 'role' && !catalog.roles.has(b.principalRef) && !customRoles.has(b.principalRef)) {
    errors.push({ path: '/principalRef', message: `Unbekannte Rolle «${b.principalRef}»; erlaubt: ${[...[...catalog.roles.keys()].filter(r => r !== ADMIN_ROLE), ...customRoles.keys()].join(', ')}.` });
  }
  return errors;
}

/** Audit-Eintrag und Ereignis der App (`events`) in derselben Transaktion. */
async function record(iam: Iam, req: FastifyRequest, tx: Tx, e: { action: string; resourceType: string; resourceId: string | null; data: Record<string, unknown> }) {
  await req.audit(tx, { action: e.action, resourceType: e.resourceType, resourceId: e.resourceId, data: e.data });
  await iam.events?.(tx, 'acl.changed', e.resourceId, { action: e.action, resourceType: e.resourceType, resourceId: e.resourceId, ...e.data });
}

export const aclModule: IamModule = {
  name: 'acl',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const { catalog, cfg } = iam;
    const resources = iam.resources;
    if (!resources) throw new Error('Modul «acl» braucht ein ResourceModel (Option `resources` von createIam)');
    const T = `${iam.schema}.acl_entry`;
    const PermissionT = Type.Unsafe<string>({ type: 'string', enum: [...catalog.permissions] });
    const ResourceTypeT = Type.Unsafe<string>({ type: 'string', enum: catalog.resourceTypes.map(r => r.key) });
    const PrincipalTypeT = Type.Unsafe<typeof PRINCIPAL_TYPES[number]>({ type: 'string', enum: [...PRINCIPAL_TYPES] });
    const leaves = catalog.resourceTypes.filter(r => r.leaf).map(r => r.label);

    const AclOut = Type.Object({
      id: Type.String(), resourceType: Type.String(), resourceId: Nullable(Type.String()), principalType: Type.String(), principalRef: Type.String(),
      permission: Type.String(), effect: Type.Unsafe<AclEffect>({ type: 'string', enum: [...ACL_EFFECTS] }), createdAt: DateTime, createdBy: Nullable(Type.String()),
    }, { title: 'AclEntry' });
    const AclIn = Type.Object({
      resourceType: ResourceTypeT, resourceId: Type.Optional(Nullable(Uuid)), principalType: PrincipalTypeT,
      principalRef: Type.String({ minLength: 1, maxLength: 300, description: 'user: Principal-ID oder Subject; client: Client-ID; role: Rollenname; group: Gruppenpfad' }),
      permission: PermissionT,
      effect: Type.Optional(Type.Unsafe<AclEffect | 'allow'>({ type: 'string', enum: [...ACL_EFFECTS, 'allow'], default: 'restrict',
        description: `\`restrict\` beschränkt (nur passende Principals behalten das Recht), \`deny\` verbietet, \`grant\` gibt das Recht auch ohne Rolle${leaves.length ? ` (nicht auf ${leaves.join(', ')})` : ''}. \`allow\` ist der alte Name von \`restrict\` und wird als \`restrict\` gespeichert.` })),
    }, { additionalProperties: false });
    const SELECT = `SELECT id, resource_type AS "resourceType", resource_id AS "resourceId", principal_type AS "principalType", principal_ref AS "principalRef",
      permission, effect, created_at AS "createdAt", created_by AS "createdBy" FROM ${T}`;

    app.get(`${prefix}/acl`, {
      schema: routeSchema(ctx, 'GET', `${prefix}/acl`, {
        tags: [TAG_ACL], summary: 'ACL-Einträge auflisten',
        querystring: Type.Object({ resourceType: Type.Optional(ResourceTypeT), resourceId: Type.Optional(Uuid), principalType: Type.Optional(PrincipalTypeT), principalRef: Type.Optional(Type.String()), permission: Type.Optional(PermissionT) }),
        response: { 200: Type.Object({ items: Type.Array(AclOut) }) },
      }),
    }, async req => {
      await req.need('acl:read');
      const q = req.query as Partial<Record<'resourceType' | 'resourceId' | 'principalType' | 'principalRef' | 'permission', string>>, P = new Params(), where: string[] = [];
      if (q.resourceType) where.push(`resource_type = ${P.add(q.resourceType)}`);
      if (q.resourceId) where.push(`resource_id = ${P.add(q.resourceId)}`);
      if (q.principalType) where.push(`principal_type = ${P.add(q.principalType)}`);
      if (q.principalRef) where.push(`principal_ref = ${P.add(q.principalRef)}`);
      if (q.permission) where.push(`permission = ${P.add(q.permission)}`);
      return req.tx(async tx => ({ items: (await tx.query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY resource_type, resource_id NULLS FIRST, permission, created_at`, P.values)).rows }));
    });

    app.post(`${prefix}/acl`, {
      schema: routeSchema(ctx, 'POST', `${prefix}/acl`, {
        tags: [TAG_ACL], summary: 'ACL-Eintrag anlegen', body: AclIn, response: { 201: AclOut },
        description: `\`grant\` gibt das Recht auch ohne Rolle (Rechte je Bereich${leaves.length ? `; nicht auf ${leaves.join(', ')}` : ''}, bei Clients und MCP nur mit passendem Scope), \`restrict\` beschränkt (nur passende Principals behalten das Recht aus Rolle oder Freigabe; alter Name \`allow\`), \`deny\` verbietet. Wirkt auf die Ressource und alles darunter; Verbote und Beschränkungen gelten auch für Freigaben. Personen mit \`org-admin\` sind ausgenommen, Maschinen-Clients nicht. Abgelehnt (422 mit Feldfehlern) werden wirkungslose oder unzulässige Einträge: Recht passt nicht zum Ressourcentyp (\`resources\` im Katalog \`GET ${prefix}/authz/catalog\`)${leaves.length ? ', Freigabe auf einem Blatt der Kette' : ''}, Recht nur für \`org-admin\` (\`adminOnly\`; nie freigebbar, sonst nur für Maschinen-Clients), Rolle \`org-admin\` oder unbekannte Rolle.`,
      }),
    }, async (req, reply) => {
      await req.need('acl:admin');
      const p = req.requirePrincipal();
      const body = req.body as AclBody;
      const b = { ...body, effect: (!body.effect || body.effect === 'allow' ? 'restrict' : body.effect) as AclEffect };
      if ((b.resourceType === 'tenant') !== !b.resourceId) throw invalid('`resourceId` ist für «tenant» leer und sonst Pflicht.');
      const pointless = pointlessAcl(catalog, b, (await iam.access.load(p.tenantId)).roles);
      if (pointless.length) throw invalid('Der ACL-Eintrag würde nie wirken.', pointless);
      // Gruppen anderer Organisationen wirken im Mandanten nicht (principal.ts) und dürfen hier nicht stehen
      const root = `${cfg.tenancy.groupRolePrefix}/`;
      if (b.principalType === 'group' && b.principalRef.startsWith(root) && !b.principalRef.startsWith(`${root}${p.tenantAlias}/`)) {
        throw invalid('Gruppe einer anderen Organisation', [{ path: '/principalRef', message: `Nur Gruppen dieser Organisation (${root}${p.tenantAlias}/…) oder ohne Organisationspräfix` }]);
      }
      // Existenz mit voller Lesesicht (Entwurf 13.3): sonst wäre eine für die Person verborgene Ressource «unbekannt»
      const e = await iam.fullTx(p, async tx => {
        if (b.resourceId && !(await resources.exists(tx, { type: b.resourceType, id: b.resourceId }))) throw notFound(`Ressource ${b.resourceType}`);
        const id = (await tx.query<{ id: string }>(`INSERT INTO ${T} (tenant_id, resource_type, resource_id, principal_type, principal_ref, permission, effect, created_by)
          VALUES (app.tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`, [b.resourceType, b.resourceId ?? null, b.principalType, b.principalRef, b.permission, b.effect, p.principalId])).rows[0]!.id;
        await record(iam, req, tx, { action: 'acl.created', resourceType: b.resourceType, resourceId: b.resourceId ?? null, data: { aclId: id, principalType: b.principalType, principalRef: b.principalRef, permission: b.permission, effect: b.effect } });
        return (await tx.query(`${SELECT} WHERE id = $1`, [id])).rows[0];
      });
      iam.access.invalidate(p.tenantId);
      return reply.status(201).header('location', `${prefix}/acl/${e.id}`).send(e);
    });

    app.delete(`${prefix}/acl/:id`, {
      schema: routeSchema(ctx, 'DELETE', `${prefix}/acl/:id`, { tags: [TAG_ACL], summary: 'ACL-Eintrag löschen', params: IdParams, response: Deleted }),
    }, async (req, reply) => {
      await req.need('acl:admin');
      const p = req.requirePrincipal();
      const { id } = req.params as { id: string };
      await req.tx(async tx => {
        const e = (await tx.query(`DELETE FROM ${T} WHERE id = $1 RETURNING resource_type, resource_id, principal_type, principal_ref, permission, effect`, [id])).rows[0];
        if (!e) throw notFound('ACL-Eintrag');
        await record(iam, req, tx, { action: 'acl.deleted', resourceType: e.resource_type, resourceId: e.resource_id, data: { aclId: id, principalType: e.principal_type, principalRef: e.principal_ref, permission: e.permission, effect: e.effect } });
      });
      iam.access.invalidate(p.tenantId);
      return reply.status(204).send(null);
    });

    type Source = 'token' | 'keycloak' | 'last-token' | 'simulation';
    const extra = resources.effectiveExtraSchema ?? {};
    app.get(`${prefix}/acl/effective`, {
      schema: routeSchema(ctx, 'GET', `${prefix}/acl/effective`, {
        tags: [TAG_ACL], summary: 'Effektive Rechte eines Principals',
        description: 'Ohne Parameter (oder nur mit der eigenen ID als `principal`) die echten Rechte des Aufrufers (`source: token`). Nur mit `principal` bzw. `client` (Client-ID; ohne `roles`, `groups`, `scopes`, `simulate`) die echten Rechte dieses Principals: bei Personen mit Rollen und Gruppen aus Keycloak (`source: keycloak`, nur mit eingerichteter Verwaltung und `ROLE_SOURCE=groups`), bei Maschinen-Clients mit Rollen und Scopes ihres zuletzt gesehenen Tokens (`source: last-token`). Lassen sie sich nicht bestimmen, oder sind `roles`, `groups`, `scopes` oder `simulate` gesetzt, ist das Ergebnis eine Simulation (`simulated`, `source: simulation`) mit genau diesen Angaben (mit `simulate=true` auch ganz ohne Rolle); mit `client` als Maschinen-Client (Scopes begrenzen, keine Ausnahme für org-admin). Ohne `principal` simuliert ein gedachter Principal «Simulation» (Person; mit `scopes` durch die Scopes begrenzt), der nur über Rollen und Gruppen von ACL-Einträgen erfasst wird.',
        querystring: Type.Object({
          principal: Type.Optional(Uuid),
          client: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: 'Client-ID eines Maschinen-Clients statt `principal` (auch, wenn er noch nie zugegriffen hat)' })),
          roles: Type.Optional(Type.Array(Type.String())), groups: Type.Optional(Type.Array(Type.String())), scopes: Type.Optional(Type.Array(Type.String())),
          simulate: Type.Optional(Type.Boolean({ description: 'Simulation erzwingen, auch ohne `roles`, `groups`, `scopes` (z. B. eine Person ganz ohne Rolle)' })),
        }),
        response: { 200: Type.Object({
          principal: Type.Object({ id: Type.String(), kind: Type.String(), name: Type.String(), clientId: Nullable(Type.String()) }),
          simulated: Type.Boolean(), roles: Type.Array(Type.String()), groups: Type.Array(Type.String()), scopes: Type.Array(Type.String()),
          source: Type.Unsafe<Source>({ type: 'string', enum: ['token', 'keycloak', 'last-token', 'simulation'], description: 'Herkunft von Rollen, Gruppen und Scopes' }),
          permissions: Type.Array(Type.String(), { description: 'Rechte auf Mandantenebene' }),
          granted: Type.Array(Type.String(), { description: 'Rechte nur über Freigaben auf einzelnen Ressourcen (nicht auf Mandantenebene); wo genau, steht in `resources`' }),
          ...(extra as Record<string, never>),
          resources: Type.Array(Type.Object({ resourceType: Type.String(), resourceId: Type.String(), permission: Type.String(), allowed: Type.Boolean() }), { description: 'Entscheid für jede Ressource mit ACL-Einträgen' }),
        }) },
      }),
    }, async req => {
      await req.need('acl:read');
      const me = req.requirePrincipal(), q = req.query as { principal?: string; client?: string; roles?: string[]; groups?: string[]; scopes?: string[]; simulate?: boolean };
      let target: Principal = me, simulated = false, source: Source = 'token';
      const given = !!(q.simulate || q.roles?.length || q.groups?.length || q.scopes?.length);
      type Row = { id: string; kind: 'user' | 'client'; subject: string; display_name: string | null; email: string | null; client_id: string | null; last_roles: string[] | null; last_scopes: string[] | null; removed_at: Date | null };
      const COLS = 'id, kind, subject, display_name, email, client_id, last_roles, last_scopes, removed_at';
      const base = { tenantId: me.tenantId, tenantAlias: me.tenantAlias, platformAdmin: false, binding: 'none' as const, token: '' };
      if (q.client && !q.principal) {
        // Maschinen-Client nach Client-ID: echte Rechte aus dem letzten Token; noch nie benutzt: Simulation als Client
        const row = (await req.tx(tx => tx.query<Row>(`SELECT ${COLS} FROM ${iam.schema}.principal WHERE kind = 'client' AND client_id = $1 ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [q.client]))).rows[0];
        const real = !given && row?.last_roles ? { roles: row.last_roles, scopes: row.last_scopes ?? [] } : null;
        simulated = !real;
        source = real ? 'last-token' : 'simulation';
        target = {
          ...base, principalId: row?.id ?? '', kind: 'client', subject: row?.subject ?? '', name: row?.display_name ?? q.client, email: null,
          clientId: q.client, grantId: q.client, roles: real?.roles ?? q.roles ?? [], groups: [], scopes: real?.scopes ?? q.scopes ?? [],
        };
      } else if (q.principal && (q.principal !== me.principalId || given)) {
        const row = (await req.tx(tx => tx.query<Row>(`SELECT ${COLS} FROM ${iam.schema}.principal WHERE id = $1`, [q.principal]))).rows[0];
        if (!row) throw notFound('Principal');
        // Echte Rollen und Gruppen: Personen aus Keycloak, Maschinen-Clients aus dem zuletzt gesehenen Token
        const real = given || row.removed_at ? null
          : row.kind === 'client' ? (row.last_roles ? { roles: row.last_roles, groups: [], scopes: row.last_scopes ?? [] } : null)
            // Keycloak nicht erreichbar: Simulation statt Fehler (die Antwort sagt es mit `source`)
            : await iam.memberAccess?.(me.tenantAlias, row.subject).then(a => (a ? { ...a, scopes: [] } : null), () => null) ?? null;
        simulated = !real;
        source = real ? (row.kind === 'client' ? 'last-token' : 'keycloak') : 'simulation';
        target = {
          ...base, principalId: row.id, kind: row.kind, subject: row.subject, name: row.display_name ?? row.subject, email: row.email,
          clientId: row.client_id, grantId: row.kind === 'client' ? row.client_id : null, roles: real?.roles ?? q.roles ?? [], groups: real?.groups ?? q.groups ?? [], scopes: real?.scopes ?? q.scopes ?? [],
        };
      } else if (!q.principal && !q.client && given) {
        source = 'simulation';
        // Leere ID und Subject: ACL-Einträge für Personen brauchen eine nicht leere Referenz und treffen nie zu
        simulated = true;
        target = {
          ...base, principalId: '', kind: 'user', subject: '', name: 'Simulation', email: null, clientId: null,
          roles: q.roles ?? [], groups: q.groups ?? [], scopes: q.scopes ?? [], scopeBound: !!q.scopes?.length,
        };
      }
      const acl = await iam.access.load(me.tenantId) as TenantAccess<unknown>;
      const pairs = new Map<string, { r: ResourceRef & { id: string }; perm: string }>();
      for (const e of acl.entries) if (e.resource_id) pairs.set(`${e.resource_type}:${e.resource_id}:${e.permission}`, { r: { type: e.resource_type, id: e.resource_id }, perm: e.permission });
      const refs = [...new Map([...pairs.values()].map(x => [`${x.r.type}:${x.r.id}`, x.r])).values()];
      const hints = resources.hints && refs.length ? await iam.fullTx(me, tx => resources.hints!(tx, refs)) : new Map<string, string>();
      return {
        principal: { id: target.principalId, kind: target.kind, name: target.name, clientId: target.clientId }, simulated, source, roles: target.roles, groups: target.groups, scopes: target.scopes,
        permissions: await iam.access.effective(target), granted: await iam.access.granted(target),
        ...(resources.effectiveExtra ? await resources.effectiveExtra(target, acl, iam.access) : {}),
        resources: [...pairs.values()].map(({ r, perm }) => ({ resourceType: r.type, resourceId: r.id, permission: perm, allowed: iam.access.decide(target, acl, perm, r, hints.get(`${r.type}:${r.id}`) ?? null) })),
      };
    });
  },
};
