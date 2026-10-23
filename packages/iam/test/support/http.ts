/**
 * Beispiel-App «notes» für die Tests auf der HTTP-Ebene (Entwurf Kap. 9, Teil 4): Ordner und Notizen (Blatt der Kette),
 * das Plugin des Pakets mit Mock-IdP und Wegwerf-Datenbank, dazu zwei Fachrouten, die `need` als preHandler bzw.
 * `req.can` und `req.capabilities` nutzen.
 */
import swagger from '@fastify/swagger';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import { claimsFor } from '@vollholz/iam-testkit';
import { pgAudit } from '../../src/audit.ts';
import type { BffOptions } from '../../src/bff.ts';
import type { Catalog } from '../../src/catalog.ts';
import { withTenant } from '../../src/db.ts';
import { iamPlugin, need, type IamPluginOptions } from '../../src/http/plugin.ts';
import { optionalBodies } from '../../src/http/routes.ts';
import { createIam, type Iam, type IamEvents } from '../../src/iam.ts';
import { migration } from '../../src/migrations.ts';
import type { ResourceModel } from '../../src/resources.ts';
import { notesCatalog } from './catalogs.ts';
import { testConfig } from './config.ts';
import { productDb } from './db.ts';

/** Fachtabellen der Notiz-App (RLS über app.secure_tenant_tables() des Runners). */
export const notesMigration = migration('001_notes.sql', `
  CREATE TABLE notes.folder (tenant_id uuid NOT NULL REFERENCES notes.tenant(id), id uuid NOT NULL DEFAULT gen_random_uuid(), name text NOT NULL, PRIMARY KEY (tenant_id, id));
  CREATE TABLE notes.note (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), folder_id uuid NOT NULL, title text NOT NULL,
    PRIMARY KEY (tenant_id, id), FOREIGN KEY (tenant_id, folder_id) REFERENCES notes.folder (tenant_id, id));`);

export const notesDb = () => productDb({ resourceTypes: ['tenant', 'folder', 'note'], leafTypes: ['note'], sources: [{ name: 'app', migrations: [notesMigration] }] });

/** Kette Ordner → Notiz; Zustand: Ordner je Notiz. */
export const notesResources: ResourceModel<Map<string, string>> = {
  load: async tx => new Map((await tx.query<{ id: string; folder_id: string }>('SELECT id, folder_id FROM notes.note')).rows.map(r => [r.id, r.folder_id])),
  version: async tx => (await tx.query("SELECT count(*)::text AS v FROM notes.note")).rows[0].v,
  chain: (state, ref) => {
    if (ref.type === 'note') { const f = ref.id ? state.get(ref.id) : undefined; return [{ type: 'tenant' }, ...(f ? [{ type: 'folder', id: f }] : []), ref]; }
    return ref.type === 'folder' ? [{ type: 'tenant' }, ref] : [{ type: 'tenant' }];
  },
  exists: async (tx, ref) => {
    const table = { folder: 'notes.folder', note: 'notes.note' }[ref.type];
    return !!table && ((await tx.query(`SELECT 1 FROM ${table} WHERE id = $1`, [ref.id])).rowCount ?? 0) > 0;
  },
};

export const claims = claimsFor({ personClientId: 'notes-platform' });

export interface NotesApp { app: FastifyInstance; iam: Iam<string, Map<string, string>>; events: { type: string; subject: string | null; data: Record<string, unknown> }[] }

/** Notiz-App mit dem Plugin; `env` für die Konfiguration, `plugin` für die Optionen des Plugins. */
export async function notesApp(o: {
  db: Parameters<typeof createIam>[0]['db']; issuer: string; env?: Record<string, string>; plugin?: Partial<IamPluginOptions>; before?: (app: FastifyInstance) => Promise<void>;
  catalog?: Catalog<string>; resources?: ResourceModel<Map<string, string>>; bff?: BffOptions;
  /** Keycloak-Admin-API (Modul `admin`, z. B. `KeycloakFake.fetch`). */
  keycloakFetch?: typeof fetch;
  /** Nach allen Routen, vor `ready` (z. B. Testsonden). */
  after?: (app: FastifyInstance) => Promise<void> | void;
}): Promise<NotesApp> {
  const events: NotesApp['events'] = [];
  const onEvent: IamEvents = async (_tx, type, subject, data) => { events.push({ type, subject, data }); };
  const iam = createIam({ cfg: testConfig(o.issuer, { DPOP_MODE: 'optional', ...o.env }), catalog: o.catalog ?? notesCatalog, db: o.db, schema: 'notes', resources: o.resources ?? notesResources, audit: pgAudit({ schema: 'notes' }), events: onEvent, ...(o.bff ? { bff: o.bff } : {}), ...(o.keycloakFetch ? { keycloakFetch: o.keycloakFetch } : {}) });
  const app = Fastify({ logger: false });
  await app.register(swagger, { openapi: { openapi: '3.1.0', info: { title: 'Notes', version: '1.0.0' } }, refResolver: { buildLocalReference: (json, _b, _f, i) => (typeof json.$id === 'string' ? json.$id : `def-${i}`) }, transformObject: optionalBodies as never });
  await o.before?.(app);
  await app.register(iamPlugin, { iam, publicPaths: ['/v1/openapi.json'], ...o.plugin });
  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // Fachrouten der Notiz-App
  app.get('/v1/folders/:id', {
    schema: { tags: ['Notizen'], summary: 'Ordner lesen', params: Type.Object({ id: Type.String({ format: 'uuid' }) }) },
    preHandler: need<any>('note:read', r => ({ type: 'folder', id: r.params.id })),
  }, async req => req.tx(async tx => (await tx.query('SELECT id, name FROM notes.folder WHERE id = $1', [(req.params as { id: string }).id])).rows[0] ?? null));
  app.get('/v1/notes/:id', {
    schema: { tags: ['Notizen'], summary: 'Notiz lesen', params: Type.Object({ id: Type.String({ format: 'uuid' }) }) },
  }, async req => {
    const { id } = req.params as { id: string };
    await req.need('note:read', { type: 'note', id });
    const can = await req.capabilities();
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

/** Mandant anlegen (wie die erste Anmeldung) und optional einen Maschinen-Client freigeben. */
export async function tenant(db: Parameters<typeof createIam>[0]['db'], alias: string, ...clients: string[]): Promise<string> {
  const id = (await db.query<{ id: string }>('SELECT app.resolve_tenant($1, null, $1, true) AS id', [alias])).rows[0]!.id;
  for (const c of clients) await withTenant(db, { tenantId: id }, tx => tx.query('INSERT INTO notes.client_grant (tenant_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, c]));
  return id;
}

/** Ordner und Notiz im Mandanten. */
export async function folderWithNote(db: Parameters<typeof createIam>[0]['db'], tenantId: string, name = 'Ordner'): Promise<{ folder: string; note: string }> {
  return withTenant(db, { tenantId }, async tx => {
    const folder = (await tx.query('INSERT INTO notes.folder (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenantId, name])).rows[0].id;
    const note = (await tx.query('INSERT INTO notes.note (tenant_id, folder_id, title) VALUES ($1, $2, $3) RETURNING id', [tenantId, folder, `${name}: Notiz`])).rows[0].id;
    return { folder, note };
  });
}
