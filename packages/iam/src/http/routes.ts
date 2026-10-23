/**
 * Gemeinsames der Module: Kontext, überschreibbare OpenAPI-Texte (Entwurf 13.4) und Schemabausteine wie in Assets
 * `http/route-kit.ts`. Die Standardtexte des Pakets sind produktneutral; die App ersetzt Tags, Zusammenfassungen,
 * Beschreibungen und Beschreibungen einzelner Felder, damit ihre OpenAPI-Beschreibung gleich bleibt.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance, FastifySchema } from 'fastify';
import type { Iam } from '../iam.ts';

export interface OpenApiOverrides {
  /** Tag des Pakets → Tag der App (z. B. `{ 'Verwaltung: Zugriff': 'Verwaltung: ACL' }`). */
  tags?: Record<string, string>;
  /** Je Route (`'<METHOD> <url>'`, z. B. `'GET /v1/acl'`): Zusammenfassung, Beschreibung, Tags. */
  routes?: Record<string, { summary?: string; description?: string; tags?: string[] }>;
  /**
   * Beschreibung eines Felds: `'<Titel des Schemas>.<pfad>'` oder `'<METHOD> <url> <Status|body|querystring|params|headers>.<pfad>'`,
   * Listen mit `[]` (z. B. `'AuthzCatalog.permissions[].resources'`, `'GET /v1/me 200.grantedPermissions'`).
   */
  fields?: Record<string, string>;
}

export interface ModuleContext {
  iam: Iam<any, any>;
  /** Präfix der API (`/v1`). */
  prefix: string;
  openapi: OpenApiOverrides;
}

export interface IamModule {
  name: string;
  register(app: FastifyInstance, ctx: ModuleContext): Promise<void> | void;
}

/** Tags des Pakets in der Reihenfolge der Doku, mit Beschreibung (für `openapi.tags` der App). */
export const IAM_API_TAGS: { name: string; description: string }[] = [
  { name: 'Konto', description: 'Angemeldete Person oder Maschine, Mandant und Rechte (`/v1/me`).' },
  { name: 'Anmeldung (Oberfläche)', description: 'Sitzung der Webapp (BFF): Anmelden, Abmelden, Mandant wechseln. Für API-Clients nicht nötig.' },
  { name: 'Verwaltung: Zugriff', description: 'Zugriffsregeln (Freigaben, Beschränkungen, Verbote) auf Ressourcen und wirksame Rechte.' },
];

/** Schema einer Route mit den Ersetzungen der App (Texte, Tags, Felder). */
export function routeSchema<T extends Record<string, unknown>>(ctx: ModuleContext, method: string, url: string, schema: T & { tags?: string[]; summary?: string; description?: string }): T & FastifySchema {
  const o = ctx.openapi, r = o.routes?.[`${method} ${url}`];
  const tags = (r?.tags ?? schema.tags)?.map(t => o.tags?.[t] ?? t);
  const out: Record<string, unknown> = { ...schema, ...(tags ? { tags } : {}), ...(r?.summary ? { summary: r.summary } : {}), ...(r?.description ? { description: r.description } : {}) };
  return (o.fields && Object.keys(o.fields).length ? describeFields(out, o.fields, null, `${method} ${url}`) : out) as T & FastifySchema;
}

/** Ersetzt Beschreibungen von Feldern in benannten Schemas (Kopie, das Original bleibt). */
function describeFields(node: unknown, fields: Record<string, string>, path: string | null = null, route?: string): any {
  if (Array.isArray(node)) return node.map(x => describeFields(x, fields, path));
  if (!node || typeof node !== 'object') return node;
  const n = node as Record<string, unknown>;
  const here = typeof n.title === 'string' ? n.title : path;
  const out: Record<string, unknown> = { ...n };
  // TypeBox-Markierungen (Symbole) bleiben erhalten
  for (const s of Object.getOwnPropertySymbols(n)) (out as Record<symbol, unknown>)[s] = (n as Record<symbol, unknown>)[s];
  if (n.properties && typeof n.properties === 'object') {
    out.properties = Object.fromEntries(Object.entries(n.properties).map(([k, v]) => {
      const p = here ? `${here}.${k}` : null;
      const d = describeFields(v, fields, p);
      return [k, p && fields[p] !== undefined ? { ...d, description: fields[p] } : d];
    }));
  }
  if (n.items) out.items = describeFields(n.items, fields, here ? `${here}[]` : null);
  for (const k of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(n[k])) out[k] = describeFields(n[k], fields, here);
  if (route) {
    for (const k of ['body', 'querystring', 'params', 'headers']) if (n[k]) out[k] = describeFields(n[k], fields, `${route} ${k}`);
    if (n.response && typeof n.response === 'object') out.response = Object.fromEntries(Object.entries(n.response).map(([s, v]) => [s, describeFields(v, fields, `${route} ${s}`)]));
  }
  return out;
}

/** Route ohne Eintrag in der OpenAPI-Beschreibung (`hide` von @fastify/swagger). */
export const HIDDEN = { hide: true } as FastifySchema;

export const Uuid = Type.String({ format: 'uuid' });
export const DateTime = Type.Unsafe<string | Date>({ type: 'string', format: 'date-time' });
export const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
export const IdParams = Type.Object({ id: Uuid });
export const Deleted = { 204: Type.Null({ description: 'Gelöscht' }) };

/** Liste setzt `$n`-Parameter zusammen. */
export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}
