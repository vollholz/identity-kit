/**
 * Beispiel-App «notes» für die Tests (Spezifikation Kap. 7.5–7.7, 14): Ordner mit Unterordnern, Notizen (Blatt, mit
 * Vertraulichkeit und Zuständigkeit über Teams), Teams (Einheiten mit Mitgliedern), Ansichten (mit Besitz). Dazu das
 * Plugin des Pakets mit Mock-IdP und Wegwerf-Datenbank, Fachrouten mit `need`, `can`, `capabilities`, und die
 * RLS-Policies der Lesesicht nach dem Muster aus Kap. 7.6.
 */
import swagger from '@fastify/swagger';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { claimsFor } from '@vollholz/iam-testkit';
import { fullView } from '../../src/access.ts';
import { pgAudit } from '../../src/audit.ts';
import type { BffOptions } from '../../src/bff.ts';
import { withTenant, type Db, type Tx } from '../../src/db.ts';
import { iamPlugin, need, type IamPluginOptions } from '../../src/http/plugin.ts';
import { optionalBodies } from '../../src/http/routes.ts';
import { createIam, type Iam, type IamEvents } from '../../src/iam.ts';
import { migration } from '../../src/migrations.ts';
import type { Level, Model } from '../../src/model.ts';
import { refKey, type ResourceModel, type ResourceRef } from '../../src/resources.ts';
import { testConfig } from './config.ts';
import { productDb } from './db.ts';
import { notesModel } from './models.ts';

/** Fachtabellen der Notiz-App (RLS über app.secure_tenant_tables() des Runners) und Policies der Lesesicht. */
export const notesMigration = migration('001_notes.sql', `
  CREATE TABLE notes.folder (tenant_id uuid NOT NULL REFERENCES notes.tenant(id), id uuid NOT NULL DEFAULT gen_random_uuid(), parent_id uuid, name text NOT NULL,
    PRIMARY KEY (tenant_id, id), FOREIGN KEY (tenant_id, parent_id) REFERENCES notes.folder (tenant_id, id));
  CREATE TABLE notes.team (tenant_id uuid NOT NULL REFERENCES notes.tenant(id), id uuid NOT NULL DEFAULT gen_random_uuid(), parent_id uuid, inherits boolean NOT NULL DEFAULT true, name text NOT NULL,
    PRIMARY KEY (tenant_id, id), FOREIGN KEY (tenant_id, parent_id) REFERENCES notes.team (tenant_id, id));
  CREATE TABLE notes.note (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), folder_id uuid NOT NULL, title text NOT NULL,
    classification smallint NOT NULL DEFAULT 0 CHECK (classification BETWEEN 0 AND 2),
    team_id uuid, team_grants text NOT NULL DEFAULT 'read' CHECK (team_grants IN ('none', 'read', 'edit')),
    PRIMARY KEY (tenant_id, id), FOREIGN KEY (tenant_id, folder_id) REFERENCES notes.folder (tenant_id, id), FOREIGN KEY (tenant_id, team_id) REFERENCES notes.team (tenant_id, id));
  CREATE TABLE notes.view (tenant_id uuid NOT NULL REFERENCES notes.tenant(id), id uuid NOT NULL DEFAULT gen_random_uuid(), name text NOT NULL, PRIMARY KEY (tenant_id, id));
  SELECT app.secure_tenant_tables();
  CREATE POLICY note_read ON notes.note AS RESTRICTIVE FOR SELECT TO notes_app USING (classification <= app.clearance() AND (
    app.read_all() OR folder_id = ANY (app.read_types()) OR app.has_tuple('note', id, app.read_relations())
    OR (team_grants <> 'none' AND team_id = ANY (app.read_units()))));
  CREATE POLICY note_insert ON notes.note AS RESTRICTIVE FOR INSERT TO notes_app WITH CHECK (classification <= app.clearance() AND (
    app.write_all() OR folder_id = ANY (app.write_types()) OR app.has_tuple('note', id, app.write_relations())
    OR (team_grants = 'edit' AND team_id = ANY (app.write_units()))));
  CREATE POLICY note_update ON notes.note AS RESTRICTIVE FOR UPDATE TO notes_app
    USING (classification <= app.clearance() AND (app.write_all() OR folder_id = ANY (app.write_types()) OR app.has_tuple('note', id, app.write_relations())
      OR (team_grants = 'edit' AND team_id = ANY (app.write_units()))))
    WITH CHECK (classification <= app.clearance() AND (app.write_all() OR folder_id = ANY (app.write_types()) OR app.has_tuple('note', id, app.write_relations())
      OR (team_grants = 'edit' AND team_id = ANY (app.write_units()))));
  CREATE POLICY view_read ON notes.view AS RESTRICTIVE FOR SELECT TO notes_app USING (app.read_all_of('view:read') OR app.has_tuple('view', id, app.relations_of('view:read')));`);

export const notesDb = () => productDb({ model: notesModel, sources: [{ name: 'app', migrations: [notesMigration] }] });

/** Zustand der Kette: Eltern je Ordner, Ordner je Notiz. */
export interface NotesState { folderParent: Map<string, string | null>; noteFolder: Map<string, string> }

function folderChain(s: NotesState, id: string): ResourceRef[] {
  const out: ResourceRef[] = [];
  const seen = new Set<string>();
  for (let cur: string | null = id; cur && !seen.has(cur); cur = s.folderParent.get(cur) ?? null) { seen.add(cur); out.unshift({ type: 'folder', id: cur }); }
  return out;
}

export const notesResources: ResourceModel<NotesState> = {
  load: async tx => ({
    folderParent: new Map((await tx.query<{ id: string; parent_id: string | null }>('SELECT id, parent_id FROM notes.folder')).rows.map(r => [r.id, r.parent_id])),
    noteFolder: new Map((await tx.query<{ id: string; folder_id: string }>('SELECT id, folder_id FROM notes.note')).rows.map(r => [r.id, r.folder_id])),
  }),
  version: async tx => (await tx.query<{ v: string }>(`SELECT coalesce(md5(string_agg(x, ',' ORDER BY x)), '') AS v FROM (
    SELECT 'f' || id || ':' || coalesce(parent_id::text, '') AS x FROM notes.folder UNION ALL SELECT 'n' || id || ':' || folder_id FROM notes.note) s`)).rows[0]!.v,
  chain: (s, ref) => {
    if (ref.type === 'org') return [{ type: 'org' }];
    if (ref.type === 'folder' && ref.id) return [{ type: 'org' }, ...folderChain(s, ref.id)];
    if (ref.type === 'note' && ref.id) { const f = s.noteFolder.get(ref.id); return [{ type: 'org' }, ...(f ? folderChain(s, f) : []), ref]; }
    return [{ type: 'org' }, ref];
  },
  ids: (s, type) => (type === 'folder' ? s.folderParent.keys() : []),
  exists: async (tx, ref) => {
    const table = ({ folder: 'notes.folder', note: 'notes.note', team: 'notes.team', view: 'notes.view' } as Record<string, string>)[ref.type];
    return !!table && ((await tx.query(`SELECT 1 FROM ${table} WHERE id = $1`, [ref.id])).rowCount ?? 0) > 0;
  },
  classification: async (tx, refs) => new Map((await tx.query<{ id: string; c: Level }>('SELECT id, classification AS c FROM notes.note WHERE id = ANY($1::uuid[])', [refs.filter(r => r.type === 'note').map(r => r.id)])).rows
    .map(r => [refKey({ type: 'note', id: r.id }), r.c])),
  edges: {
    unit: 'team',
    children: 'SELECT id FROM notes.team WHERE parent_id = ANY($1::uuid[]) AND inherits',
    belongs: "SELECT id, team_id AS unit_id, team_grants AS grants, 'gehört zu' AS label FROM notes.note WHERE id = ANY($1::uuid[]) AND team_id IS NOT NULL",
  },
};

export const claims = claimsFor({ personClientId: 'notes-platform' });

export interface NotesApp { app: FastifyInstance; iam: Iam<string, NotesState>; events: { type: string; subject: string | null; data: Record<string, unknown> }[] }

/** Notiz-App mit dem Plugin; `env` für die Konfiguration, `plugin` für die Optionen des Plugins. */
export async function notesApp(o: {
  db: Db; issuer: string; env?: Record<string, string>; plugin?: Partial<IamPluginOptions>; before?: (app: FastifyInstance) => Promise<void>;
  model?: Model<string>; resources?: ResourceModel<NotesState> | null; bff?: BffOptions;
  /** Keycloak-Admin-API (Modul `admin`, z. B. `KeycloakFake.fetch`). */
  keycloakFetch?: typeof fetch;
  /** Microsoft (Modul `entra`, z. B. `EntraFake.fetch`) und Wartezeiten nach der Zustimmung. */
  entraFetch?: typeof fetch; entraRetryMs?: number[];
  /** Optionen der Fastify-Instanz. */
  fastify?: FastifyServerOptions;
  /** Nach allen Routen, vor `ready` (z. B. Testsonden). */
  after?: (app: FastifyInstance) => Promise<void> | void;
}): Promise<NotesApp> {
  const events: NotesApp['events'] = [];
  const onEvent: IamEvents = async (_tx, type, subject, data) => { events.push({ type, subject, data }); };
  const iam = createIam({ cfg: testConfig(o.issuer, { DPOP_MODE: 'optional', ...o.env }), model: o.model ?? notesModel, db: o.db, schema: 'notes', resources: o.resources === undefined ? notesResources : o.resources, audit: pgAudit({ schema: 'notes' }), events: onEvent, ...(o.bff ? { bff: o.bff } : {}), ...(o.keycloakFetch ? { keycloakFetch: o.keycloakFetch } : {}), ...(o.entraFetch ? { entraFetch: o.entraFetch } : {}), ...(o.entraRetryMs ? { entraRetryMs: o.entraRetryMs } : {}) });
  // Wie docs/backend.md verlangt: unbekannte Felder ergeben 422 statt still zu verschwinden
  const app = Fastify({ logger: process.env.TEST_LOG ? { level: 'error' } : false, ajv: { customOptions: { removeAdditional: false } }, ...o.fastify });
  await app.register(swagger, { openapi: { openapi: '3.1.0', info: { title: 'Notes', version: '1.0.0' } }, refResolver: { buildLocalReference: (json, _b, _f, i) => (typeof json.$id === 'string' ? json.$id : `def-${i}`) }, transformObject: optionalBodies as never });
  await o.before?.(app);
  await app.register(iamPlugin, { iam, publicPaths: ['/v1/openapi.json'], ...o.plugin });
  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // Fachrouten der Notiz-App
  app.get('/v1/folders/:id', {
    schema: { tags: ['Notizen'], summary: 'Ordner lesen', params: Type.Object({ id: Type.String({ format: 'uuid' }) }) },
    preHandler: need<any>('note:read', r => ({ type: 'folder', id: r.params.id })),
  }, async req => req.tx(async tx => (await tx.query('SELECT id, name FROM notes.folder WHERE id = $1', [(req.params as { id: string }).id])).rows[0] ?? null));
  app.get('/v1/notes', {
    schema: { tags: ['Notizen'], summary: 'Notizen (Lesesicht)' },
  }, async req => {
    await req.needSomewhere('note:read');
    const rows = await req.tx(async tx => (await tx.query<{ id: string }>('SELECT id FROM notes.note ORDER BY title')).rows);
    const can = await req.capabilities(rows.map(r => ({ type: 'note', id: r.id })));
    return { items: rows.map(r => ({ id: r.id, can: can('note', r.id) })) };
  });
  app.get('/v1/notes/:id', {
    schema: { tags: ['Notizen'], summary: 'Notiz lesen', params: Type.Object({ id: Type.String({ format: 'uuid' }) }) },
  }, async req => {
    const { id } = req.params as { id: string };
    await req.need('note:read', { type: 'note', id });
    const can = await req.capabilities([{ type: 'note', id }]);
    return { id, write: await req.can('note:write', { type: 'note', id }), can: can('note', id) };
  });
  app.post('/v1/folders', {
    schema: { tags: ['Notizen'], summary: 'Ordner anlegen', body: Type.Object({ name: Type.String({ minLength: 1 }) }) },
  }, async (req, reply) => {
    await req.need('note:write');
    const f = await req.tx(async tx => {
      const r = (await tx.query('INSERT INTO notes.folder (tenant_id, name) VALUES (app.tenant_id(), $1) RETURNING id, name', [(req.body as { name: string }).name])).rows[0];
      await req.audit(tx, { action: 'folder.created', resourceType: 'folder', resourceId: r.id });
      return r;
    });
    return reply.status(201).send(f);
  });
  await o.after?.(app);
  await app.ready();
  return { app, iam, events };
}

/** Transaktion mit voller Sicht (Testdaten anlegen, wie die internen Prüfungen des Baukastens). */
export const full = <T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenant(db, { tenantId, settings: fullView(notesModel) }, fn);

/** Tupel direkt anlegen (Testdaten); `subject` vollständig (`user:<id>` …). */
export async function grant(db: Db, tenantId: string, subject: string, relation: string, place: ResourceRef = { type: 'org' }, expiresAt: Date | null = null): Promise<string> {
  return full(db, tenantId, async tx => (await tx.query<{ id: string }>(
    'INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type, object_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [tenantId, subject, relation, place.type, place.type === 'org' ? null : place.id, expiresAt])).rows[0]!.id);
}

/** Principal einer Person anlegen (wie der Abgleich) und seine ID liefern. */
export async function person(db: Db, tenantId: string, subject: string, o: { name?: string; email?: string; clearance?: Level } = {}): Promise<string> {
  return full(db, tenantId, async tx => (await tx.query<{ id: string }>(
    `INSERT INTO notes.principal AS p (tenant_id, kind, subject, display_name, email, clearance, last_seen_at) VALUES ($1, 'user', $2, $3, $4, $5, NULL)
     ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET clearance = excluded.clearance RETURNING id`, [tenantId, subject, o.name ?? subject, o.email ?? null, o.clearance ?? 0])).rows[0]!.id);
}

/** Maschinen-Client freigeben (Principal und Tupel `client:<id> <rolle> org`). */
export async function grantClient(db: Db, tenantId: string, clientId: string, role = 'editor', clearance: Level = 0): Promise<string> {
  const id = await full(db, tenantId, async tx => (await tx.query<{ id: string }>(
    `INSERT INTO notes.principal AS p (tenant_id, kind, subject, client_id, display_name, clearance, last_seen_at) VALUES ($1, 'client', $2, $2, $2, $3, NULL)
     ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET clearance = excluded.clearance RETURNING id`, [tenantId, clientId, clearance])).rows[0]!.id);
  await grant(db, tenantId, `client:${id}`, role).catch(() => undefined);
  return id;
}

/** Mandant anlegen (wie die erste Anmeldung) und optional Maschinen-Clients mit Rolle `editor` freigeben. */
export async function tenant(db: Db, alias: string, ...clients: string[]): Promise<string> {
  const id = (await db.query<{ id: string }>('SELECT app.resolve_tenant($1, null, $1, true) AS id', [alias])).rows[0]!.id;
  for (const c of clients) await grantClient(db, id, c);
  return id;
}

/** Ordner und Notiz im Mandanten. */
export async function folderWithNote(db: Db, tenantId: string, name = 'Ordner', o: { parent?: string; classification?: Level; team?: string; grants?: 'none' | 'read' | 'edit' } = {}): Promise<{ folder: string; note: string }> {
  return full(db, tenantId, async tx => {
    const folder = (await tx.query('INSERT INTO notes.folder (tenant_id, name, parent_id) VALUES ($1, $2, $3) RETURNING id', [tenantId, name, o.parent ?? null])).rows[0].id;
    const note = (await tx.query('INSERT INTO notes.note (tenant_id, folder_id, title, classification, team_id, team_grants) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [tenantId, folder, `${name}: Notiz`, o.classification ?? 0, o.team ?? null, o.grants ?? 'read'])).rows[0].id;
    return { folder, note };
  });
}

/** Team (Einheit) im Mandanten. */
export async function team(db: Db, tenantId: string, name: string, parent: string | null = null, inherits = true): Promise<string> {
  return full(db, tenantId, async tx => (await tx.query<{ id: string }>('INSERT INTO notes.team (tenant_id, name, parent_id, inherits) VALUES ($1, $2, $3, $4) RETURNING id', [tenantId, name, parent, inherits])).rows[0]!.id);
}

/** Ansicht im Mandanten. */
export async function view(db: Db, tenantId: string, name: string): Promise<string> {
  return full(db, tenantId, async tx => (await tx.query<{ id: string }>('INSERT INTO notes.view (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenantId, name])).rows[0]!.id);
}

/** Person mit Rolle an org (Tupel `user:<id> <rolle> org`), Mandant bei Bedarf angelegt; liefert die ID des Principals. */
export async function member(db: Db, alias: string, sub: string, role: string | null = null, clearance: Level = 0): Promise<string> {
  const tenantId = await tenant(db, alias);
  const id = await person(db, tenantId, sub, { clearance });
  if (role) await grant(db, tenantId, `user:${id}`, role).catch(() => undefined);
  return id;
}

/** Rolle an org für die Person aus diesen Claims (je Organisation im Token) vergeben; liefert die Claims unverändert. */
export async function withRole<C extends Record<string, unknown>>(db: Db, c: C, role: string | null, clearance: Level = 0): Promise<C> {
  for (const org of c.organization as string[]) await member(db, org, c.sub as string, role, clearance);
  return c;
}
