/**
 * Modul `access`: Zugriff an Orten (Spezifikation Kap. 9.5; A4, A13, A22–A24).
 *
 * - GET    /v1/access?type=&id=          «Wer hat Zugriff?» (Leserecht der Ressource; an org `tenant:read`)
 * - GET    /v1/access?subject=me         eigene Freigaben (jeder Principal)
 * - GET    /v1/access?subject=<subjekt>  Freigaben eines Mitglieds (`members:admin`)
 * - GET    /v1/access/explain            «Warum?» (für sich selbst; für andere `access:admin` am Ort)
 * - GET    /v1/access/groups             Gruppen aus Entra ID suchen bzw. auflösen (`access:admin` irgendwo)
 * - POST   /v1/access                    Freigabe anlegen; PATCH/DELETE /v1/access/{id} Ablauf ändern, entfernen
 *
 * Schreiben nur Personen mit `access:admin` am Ort; niemand gibt mehr, als er hat; `org-admin` nur die
 * Plattform-Administration, ohne Ablauf; letzter Admin bleibt (Regeln in explain.ts und rules.ts). Ressourcen, Tupel und
 * Subjekte fremder Organisationen oder ohne Leserecht: 404 wie unbekannt.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from '../audit.ts';
import type { Tx } from '../db.ts';
import { HttpError, invalid, notFound } from '../errors.ts';
import { checkRef } from '../explain.ts';
import { lockKey } from '../locks.ts';
import { ADMIN_ROLE, ORG, OWNER } from '../model.ts';
import type { Principal } from '../principal.ts';
import type { ResourceRef } from '../resources.ts';
import { lastAdminGuard } from '../rules.ts';
import { SUBJECT_PATTERN } from '../tuples.ts';
import { DateTime, Nullable, personOf, routeSchema, Uuid, type IamModule, type ModuleContext } from './routes.ts';

const TAG = 'Zugriff';
const LevelT = Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]);
const RefOut = Type.Object({ type: Type.String(), id: Nullable(Type.String()) });
const Unit = Type.Object({ ref: RefOut, relation: Type.String({ description: 'Name der Kante (Zuständigkeit)' }), grants: Type.Union([Type.Literal('read'), Type.Literal('edit')]) });

export const AccessEntrySchema = Type.Object({
  id: Nullable(Type.String({ description: 'Tupel-ID; null bei Zuständigkeit' })),
  subject: Type.Object({
    ref: Type.String({ description: '`user:<id>`, `client:<id>`, `group:<entra-object-id>` oder `org:members`' }),
    kind: Type.Union([Type.Literal('user'), Type.Literal('client'), Type.Literal('group'), Type.Literal('members')]),
    name: Type.String({ description: 'Name der Person bzw. des Clients, Anzeigename der Gruppe (sonst Objekt-ID), «Alle Mitglieder»' }),
    scopes: Type.Optional(Nullable(Type.Array(Type.String(), { description: 'Nur Clients: Scopes im letzten Token' }))),
  }),
  relation: Type.String({ description: 'Rolle, `member` oder `owner`' }),
  place: RefOut,
  via: Type.Union([Type.Literal('direct'), Type.Literal('inherited'), Type.Literal('scope')]),
  unit: Type.Optional(Unit),
  expiresAt: Nullable(DateTime), createdAt: Nullable(DateTime), createdBy: Nullable(Type.String({ description: 'Name' })),
  removable: Type.Boolean({ description: 'Ich darf entfernen und den Ablauf ändern (nur `direct`)' }),
}, { $id: 'AccessEntry', title: 'AccessEntry' });

const AccessList = Type.Object({
  resource: RefOut,
  classification: Nullable(LevelT),
  items: Type.Array(Type.Ref('AccessEntry'), { description: 'Direkt zuerst, dann geerbt von unten nach oben, dann Zuständigkeit' }),
  grantable: Type.Array(Type.String(), { description: 'Relationen, die ich hier vergeben darf; leer ohne access:admin' }),
}, { title: 'AccessList' });
const EntryList = Type.Object({ items: Type.Array(Type.Ref('AccessEntry')) });
const ListOut = Type.Union([AccessList, EntryList]);

const Explain = Type.Object({
  allowed: Type.Boolean(),
  permission: Type.String(),
  subject: Type.Object({ ref: Type.String(), name: Type.String() }),
  reasons: Type.Array(Type.Object({
    via: Type.Union([Type.Literal('direct'), Type.Literal('inherited'), Type.Literal('scope'), Type.Literal('owner')]),
    relation: Type.String(), place: RefOut, tupleId: Nullable(Type.String()),
    matched: Type.String({ description: 'Welches Subjekt passt, z. B. `group:<entra-object-id>` oder `org:members`' }),
    label: Type.String({ description: 'Anzeigename von `matched`' }),
    unit: Type.Optional(Unit),
  })),
  blocked: Type.Union([
    Type.Object({ reason: Type.Literal('clearance'), classification: LevelT, clearance: LevelT }),
    Type.Object({ reason: Type.Literal('scope'), scope: Nullable(Type.String()) }),
    Type.Null(),
  ]),
}, { title: 'Explain' });

const TypeQ = Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9-]*$' });
const SubjectT = Type.String({ minLength: 1, maxLength: 64 });
const ExpiresT = Nullable(Type.String({ format: 'date-time', description: 'Ablauf (ISO 8601 mit Zeitzone); null ohne Ablauf' }));

/** Ablauf prüfen: in der Zukunft, nie bei org-admin (A15). */
function expiry(v: string | null | undefined, relation: string): Date | null {
  if (v === undefined || v === null) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) throw invalid('Ablauf ungültig', [{ path: '/expiresAt', message: 'Zeitpunkt in der Zukunft angeben' }]);
  if (relation === ADMIN_ROLE) throw invalid('Ablauf nicht erlaubt', [{ path: '/expiresAt', message: 'Die Rolle org-admin hat kein Ablaufdatum' }]);
  return d;
}

export const accessModule: IamModule = {
  name: 'access',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const { access, info, tuples } = iam;
    const S = iam.schema;
    if (!app.getSchema('AccessEntry')) app.addSchema(AccessEntrySchema);
    const base = `${prefix}/access`;

    const actorOf = (req: FastifyRequest, p: Principal): Actor => ({ principal: { kind: p.kind, principalId: p.principalId, name: p.name, clientId: p.clientId }, source: req.source, correlationId: req.id });
    /** Lesbarer Ort (sonst 404) mit Hinweis, Fakten und Stand. */
    const place = async (p: Principal, ref: ResourceRef) => {
      const r = await checkRef(access, p.tenantId, ref);
      const acl = await access.load(p.tenantId);
      const hint = await access.hint(p.tenantId, r);
      const facts = await access.facts(p, acl, [r], p.tenantId);
      const read = access.model.types.get(r.type)!.read;
      if (!read || !access.decide(p, acl, read, r, hint, facts)) throw notFound('Ressource');
      return { ref: r, acl, hint, facts };
    };
    /** Schreiben unter der Sperre der Organisation (letzter Admin auch bei gleichzeitigen Anfragen). */
    const write = <T>(p: Principal, fn: (tx: Tx) => Promise<T>) => iam.tx(p, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey.admin(p.tenantAlias)]);
      const r = await fn(tx);
      return r;
    }).finally(() => access.invalidate(p.tenantId));

    // ---------------------------------------------------------------- Lesen
    app.get(base, {
      schema: routeSchema(ctx, 'GET', base, {
        tags: [TAG], summary: 'Wer hat Zugriff? bzw. Freigaben eines Subjekts',
        description: 'Mit `type` (und `id` ausser bei `org`): alle Freigaben an der Ressource mit Herkunft und was ich hier vergeben darf; braucht das Leserecht der Ressource. Mit `subject=me`: eigene Freigaben; mit `subject=<subjekt>`: Freigaben eines Mitglieds (Recht «Mitglieder und Rollen verwalten»).',
        querystring: Type.Object({ type: Type.Optional(TypeQ), id: Type.Optional(Uuid), subject: Type.Optional(SubjectT) }, { additionalProperties: false }),
        response: { 200: ListOut },
      }),
    }, async req => {
      const p = req.requirePrincipal();
      const q = req.query as { type?: string; id?: string; subject?: string };
      if (q.subject !== undefined) {
        if (q.type !== undefined || q.id !== undefined) throw invalid('Entweder type/id oder subject', [{ path: '/subject', message: 'nicht zusammen mit type oder id' }]);
        if (q.subject === 'me') return info.ofSubject(p, p.subjects[0]!);
        personOf(req);
        await req.need('members:admin');
        if (!SUBJECT_PATTERN.test(q.subject)) throw invalid('Subjekt ungültig', [{ path: '/subject', message: 'user:<id>, client:<id>, group:<id>, org:members oder me' }]);
        return info.ofSubject(p, q.subject);
      }
      if (!q.type) throw invalid('type oder subject fehlt', [{ path: '/type', message: 'type (und id) oder subject angeben' }]);
      return info.whoHasAccess(p, { type: q.type, id: q.id ?? null });
    });

    app.get(`${base}/explain`, {
      schema: routeSchema(ctx, 'GET', `${base}/explain`, {
        tags: [TAG], summary: 'Warum? Alle Wege zu einem Recht an einer Ressource',
        description: 'Ohne `subject`: ich selbst (die Ressource muss für mich lesbar sein, sonst 404). Für andere braucht es «Zugriff verwalten» am Ort. Ohne `permission`: das Leserecht des Typs.',
        querystring: Type.Object({ type: TypeQ, id: Type.Optional(Uuid), permission: Type.Optional(Type.String({ maxLength: 64 })), subject: Type.Optional(SubjectT) }, { additionalProperties: false }),
        response: { 200: Explain },
      }),
    }, async req => {
      const q = req.query as { type: string; id?: string; permission?: string; subject?: string };
      return info.explain(req.requirePrincipal(), { type: q.type, id: q.id ?? null }, { permission: q.permission, subject: q.subject });
    });

    app.get(`${base}/groups`, {
      schema: routeSchema(ctx, 'GET', `${base}/groups`, {
        tags: [TAG], summary: 'Gruppen aus Microsoft Entra ID suchen oder auflösen',
        description: 'Nur mit Entra-Verbindung (sonst 409 `entra-not-connected`; ohne Anwendungsberechtigung GroupMember.Read.All 409 `entra-consent-missing`). `q` ab 2 Zeichen (höchstens 50 Treffer) oder `ids` (kommagetrennt, bis 100).',
        querystring: Type.Object({ q: Type.Optional(Type.String({ minLength: 2, maxLength: 120 })), ids: Type.Optional(Type.String({ maxLength: 3800 })) }, { additionalProperties: false }),
        response: { 200: Type.Object({ items: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })) }) },
      }),
    }, async req => {
      const p = personOf(req);
      await req.needSomewhere('access:admin');
      const q = req.query as { q?: string; ids?: string };
      if (!iam.entra) throw new HttpError(409, 'Konflikt', 'Die Organisation ist nicht mit Microsoft Entra ID verbunden.', {}, { reason: 'entra-not-connected' });
      if (q.ids !== undefined) {
        const ids = [...new Set(q.ids.split(',').map(x => x.trim().toLowerCase()).filter(Boolean))];
        if (ids.length > 100 || ids.some(x => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x))) throw invalid('ids ungültig', [{ path: '/ids', message: 'bis 100 Objekt-IDs (GUID), kommagetrennt' }]);
        return { items: await iam.entra.groupsByIds(p.tenantId, ids) };
      }
      if (!q.q) throw invalid('q oder ids fehlt', [{ path: '/q', message: 'Suchbegriff ab 2 Zeichen oder ids angeben' }]);
      return { items: await iam.entra.searchGroups(p.tenantId, q.q) };
    });

    // ---------------------------------------------------------------- Schreiben
    app.post(base, {
      schema: routeSchema(ctx, 'POST', base, {
        tags: [TAG], summary: 'Freigeben: Wer – Rolle – Ort',
        description: 'Braucht «Zugriff verwalten» am Ort; jedes Recht der Rolle muss für mich am Ort gelten (403 `exceeds-own` mit `missing`). `org-admin` vergibt nur die Plattform-Administration (403 `platform-admin-only`), ohne Ablauf. Clients erhalten Rollen nur über die Verwaltung (422). `owner` setzt nur die App (422).',
        body: Type.Object({ subject: SubjectT, relation: Type.String({ minLength: 1, maxLength: 64 }), type: TypeQ, id: Type.Optional(Nullable(Uuid)), expiresAt: Type.Optional(ExpiresT) }, { additionalProperties: false }),
        response: { 201: Type.Ref('AccessEntry') },
      }),
    }, async (req, reply) => {
      const p = personOf(req);
      const b = req.body as { subject: string; relation: string; type: string; id?: string | null; expiresAt?: string | null };
      const { ref, acl, hint, facts } = await place(p, { type: b.type, id: b.id ?? null });
      if (!access.model.relationsAt(ref.type).includes(b.relation) || b.relation === OWNER) {
        throw invalid('Relation am Typ nicht zulässig', [{ path: '/relation', message: b.relation === OWNER ? '«owner» setzt nur die App' : `«${b.relation}» darf an «${ref.type}» nicht hängen` }]);
      }
      if (!SUBJECT_PATTERN.test(b.subject)) throw invalid('Subjekt ungültig', [{ path: '/subject', message: 'user:<id>, group:<entra-object-id> oder org:members' }]);
      if (b.subject.startsWith('client:')) throw invalid('Clients über die Verwaltung', [{ path: '/subject', message: 'Clients erhalten Rollen nur über PUT /v1/admin/clients/{clientId}' }]);
      if (b.subject.startsWith('group:') && !(await iam.entra?.connected(p.tenantId))) throw invalid('Keine Entra-Verbindung', [{ path: '/subject', message: 'Gruppen gibt es nur mit einer Verbindung zu Microsoft Entra ID' }]);
      const expiresAt = expiry(b.expiresAt, b.relation);
      const problem = info.manageProblem(p, acl, ref, b.relation, facts, hint);
      if (problem) throw problem;
      const row = await write(p, async tx => {
        if (b.subject.startsWith('user:') && !(await tx.query(`SELECT 1 FROM ${S}.principal WHERE id = $1 AND kind = 'user' AND removed_at IS NULL`, [b.subject.slice(5)])).rowCount) throw notFound('Person');
        return tuples.grant(tx, { subject: b.subject, relation: b.relation, place: ref, expiresAt, createdBy: p.principalId }, actorOf(req, p));
      });
      return reply.status(201).send(await info.entryOf(p.tenantId, row, true));
    });

    /** Tupel der eigenen Organisation an einem für mich lesbaren Ort, mit Recht zu ändern; sonst 404 bzw. 403. */
    const own = async (p: Principal, id: string) => {
      const t = (await access.load(p.tenantId)).tuples.find(x => x.id === id);
      if (!t) throw notFound('Freigabe');
      const ref = { type: t.object_type, id: t.object_id };
      const { acl, hint, facts } = await place(p, ref).catch(e => { throw e instanceof HttpError && e.status === 404 ? notFound('Freigabe') : e; });
      if (t.relation === OWNER || t.subject.startsWith('client:')) throw invalid('Nicht über /v1/access', [{ path: '/id', message: t.relation === OWNER ? '«owner» setzt nur die App' : 'Clients über PUT /v1/admin/clients/{clientId}' }]);
      const problem = info.manageProblem(p, acl, ref, t.relation, facts, hint);
      if (problem) throw problem;
      return t;
    };

    app.patch(`${base}/:id`, {
      schema: routeSchema(ctx, 'PATCH', `${base}/:id`, {
        tags: [TAG], summary: 'Ablauf einer Freigabe ändern', params: Type.Object({ id: Uuid }),
        body: Type.Object({ expiresAt: ExpiresT }, { additionalProperties: false }),
        description: 'Gilt als Vergeben: dieselben Regeln wie `POST` am Ort des Tupels. Audit `access.granted` mit `previousExpiresAt`.',
        response: { 200: Type.Ref('AccessEntry') },
      }),
    }, async req => {
      const p = personOf(req);
      const t = await own(p, (req.params as { id: string }).id);
      const expiresAt = expiry((req.body as { expiresAt: string | null }).expiresAt, t.relation);
      const row = await write(p, tx => tuples.setExpiry(tx, t.id, expiresAt, actorOf(req, p)));
      if (!row) throw notFound('Freigabe');
      return info.entryOf(p.tenantId, row, true);
    });

    app.delete(`${base}/:id`, {
      schema: routeSchema(ctx, 'DELETE', `${base}/:id`, {
        tags: [TAG], summary: 'Freigabe entfernen', params: Type.Object({ id: Uuid }),
        description: 'Dieselben Regeln wie `POST` am Ort des Tupels; die letzte aktive Person mit org-admin bleibt (409 `last-admin`).',
        response: { 204: Type.Null() },
      }),
    }, async (req, reply) => {
      const p = personOf(req);
      const t = await own(p, (req.params as { id: string }).id);
      await write(p, async tx => {
        if (t.relation === ADMIN_ROLE && t.object_type === ORG && t.subject.startsWith('user:')) await lastAdminGuard(tx, S, t.subject.slice(5), access.model.roles.get(ADMIN_ROLE)?.label, iam.admin?.accountActive);
        if (!(await tuples.revoke(tx, t.id, actorOf(req, p)))) throw notFound('Freigabe');
      });
      return reply.status(204).send(null);
    });
  },
};
