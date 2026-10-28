/**
 * Gemeinsames der Module: Kontext, überschreibbare OpenAPI-Texte (Entwurf 13.4) und Schemabausteine. Die
 * Standardtexte des Pakets sind produktneutral; die App ersetzt Tags, Zusammenfassungen,
 * Beschreibungen und Beschreibungen einzelner Felder, damit ihre OpenAPI-Beschreibung gleich bleibt.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest, FastifySchema } from 'fastify';
import { forbidden, HttpError, invalid } from '../errors.ts';
import type { Account, Principal } from '../principal.ts';
import type { Iam } from '../iam.ts';

export interface OpenApiOverrides {
  /** Tag des Pakets → Tag der App (z. B. `{ 'Zugriff': 'Freigaben' }`). */
  tags?: Record<string, string>;
  /** Je Route (`'<METHOD> <url>'`, z. B. `'GET /v1/access'`): Zusammenfassung, Beschreibung, Tags. */
  routes?: Record<string, { summary?: string; description?: string; tags?: string[] }>;
  /**
   * Beschreibung eines Felds: `'<Titel des Schemas>.<pfad>'` oder `'<METHOD> <url> <Status|body|querystring|params|headers>.<pfad>'`,
   * Listen mit `[]` (z. B. `'AuthzCatalog.permissions[].resources'`, `'GET /v1/me 200.somewhere'`).
   */
  fields?: Record<string, string>;
}

export interface ModuleContext {
  iam: Iam<any, any>;
  /** Präfix der API (`/v1`). */
  prefix: string;
  openapi: OpenApiOverrides;
  /** Modul `people`: Rechte, die das Personenverzeichnis öffnen (Option `people` des Plugins). */
  people?: { permissions?: readonly string[] };
}

export interface IamModule {
  name: string;
  register(app: FastifyInstance, ctx: ModuleContext): Promise<void> | void;
}

/** Tags des Pakets in der Reihenfolge der Doku, mit Beschreibung (für `openapi.tags` der App). */
export const IAM_API_TAGS: { name: string; description: string }[] = [
  { name: 'Konto', description: 'Angemeldete Person oder Maschine, Mandant und Rechte (`/v1/me`).' },
  { name: 'Anmeldung (Oberfläche)', description: 'Sitzung der Webapp (BFF): Anmelden, Abmelden, Mandant wechseln. Für API-Clients nicht nötig.' },
  { name: 'Zugriff', description: 'Wer hat Zugriff, warum, Freigaben an Orten (Wer – Rolle – Ort), Break-Glass.' },
  { name: 'Verwaltung: Mitglieder und Rollen', description: 'Mitglieder und Maschinen-Clients der eigenen Organisation: einladen, entfernen, Rollen an der Organisation und Freigabestufe setzen (Recht «Mitglieder und Rollen verwalten»); eigene Rollen der Organisation zusammenstellen (Recht «Rollen zusammenstellen»).' },
  { name: 'Verwaltung: Anmeldung über Microsoft Entra ID', description: 'Organisation mit ihrem Entra-Tenant verbinden, «Nur Entra» aktivieren, Personen aus Entra ID hinzufügen.' },
  { name: 'Personen', description: 'Personenverzeichnis der Organisation für Auswahlen und Anzeigen (Namen zu IDs).' },
  { name: 'Plattform: Organisationen', description: 'Organisationen anlegen, ändern, sperren und ihre Mitglieder verwalten (Realm-Rolle platform-admin).' },
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

/**
 * `transformObject` für `@fastify/swagger`: Es schreibt `requestBody.required: true` für jede Route mit Body-Schema.
 * Routen mit `'x-body-optional': true` im Schema (z. B. `POST …/suspend`) werden hier als optional ausgewiesen. Die App
 * übergibt es als `transformObject` (oder ruft es in ihrem eigenen auf).
 */
export function optionalBodies<T>(doc: { openapiObject?: T; swaggerObject?: T }): T {
  // Swagger 2 (`swaggerObject`) kennt `requestBody` nicht: unverändert zurück
  if (!doc.openapiObject) return doc.swaggerObject as T;
  const { openapiObject } = doc;
  const paths = (openapiObject as { paths?: Record<string, Record<string, { requestBody?: { required?: boolean }; 'x-body-optional'?: boolean }>> }).paths ?? {};
  for (const ops of Object.values(paths)) {
    for (const op of Object.values(ops)) {
      if (!op || typeof op !== 'object' || !op['x-body-optional']) continue;
      if (op.requestBody) op.requestBody.required = false;
      delete op['x-body-optional'];
    }
  }
  return openapiObject;
}

/** Route ohne Eintrag in der OpenAPI-Beschreibung (`hide` von @fastify/swagger). */
export const HIDDEN = { hide: true } as FastifySchema;

export const Uuid = Type.String({ format: 'uuid' });
export const DateTime = Type.Unsafe<string | Date>({ type: 'string', format: 'date-time' });
/** Genau null, ohne Umwandlung durch AJV (`const` wandelt nicht um, `type: 'null'` schon: 0, "" und false → null). */
const ExactlyNull = Type.Unsafe<null>({ const: null });
/**
 * Wert oder `null`: `anyOf [null (genau), X, null]`. Mit `coerceTypes` (Standard von Fastify) machte `anyOf [X, null]`
 * aus null den Wert von X (0, "", false), `anyOf [null, X]` aus 0, "" und false null. Der erste Zweig nimmt null
 * unverändert, alle anderen Werte prüfen und wandeln X und `null` wie bisher. Gleich wie in @vollholz/platform.
 */
export const Nullable = <T extends TSchema>(s: T) => Type.Union([ExactlyNull, s, Type.Null()]);
export const IdParams = Type.Object({ id: Uuid });
export const Deleted = { 204: Type.Null({ description: 'Gelöscht' }) };

export const Limit = Type.Integer({ minimum: 1, maximum: 200, default: 50, description: 'Seitengrösse (höchstens 200).' });
export const Cursor = Type.String({ maxLength: 512, description: 'Opaker Cursor aus `nextCursor` der vorherigen Seite.' });
export const NextCursor = Nullable(Type.String({ description: 'Cursor der nächsten Seite; `null` auf der letzten Seite.' }));

/** Opaker Cursor (base64url-JSON). Inhalt ist kein Vertrag und kann sich ändern. */
export function encodeCursor(v: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

/** Cursor lesen; unlesbar oder aus einer anderen Abfrage (`check`) → 422. */
export function decodeCursor<T extends Record<string, unknown>>(c: string | undefined, check: (v: Record<string, unknown>) => boolean): T | null {
  if (!c) return null;
  let v: unknown;
  try { v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')); } catch { v = null; }
  if (!v || typeof v !== 'object' || !check(v as Record<string, unknown>)) throw invalid('Cursor ungültig oder aus einer anderen Abfrage.');
  return v as T;
}

/** LIKE-Muster für Teilstrings: Platzhalter im Suchbegriff maskiert. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;

export const etag = (version: number) => `W/"${version}"`;

/** If-Match → erwartete Version. `*` oder fehlend = keine Prüfung; Unlesbares kann nie passen (412). */
export function ifMatchVersion(h: string | string[] | undefined): number | undefined {
  const v = Array.isArray(h) ? h[0] : h;
  if (v === undefined || v.trim() === '*' || v.trim() === '') return undefined;
  // Auch ein ETag mit Zugriffsstand (W/"<version>-<zugriff>", Entwurf 13.7): es zählt nur die Version
  const m = /^\s*(?:W\/)?"?(\d+)(?:-[\w-]+)?"?\s*$/.exec(v);
  if (!m) throw new HttpError(412, 'If-Match passt nicht', 'Erwartet ein ETag der Form W/"<version>".');
  return Number(m[1]);
}

/** Liste setzt `$n`-Parameter zusammen. */
export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

/**
 * Handelnde Plattform-Administration (Kontext `platform`, Routen unter `/v1/platform/…`): Konto mit der Realm-Rolle als
 * Principal ohne Mandant – `tenantId` und `tenantAlias` leer, `principalId` ist die ID des Kontos. Nur als `actor` mit
 * `platform: true` verwenden; Rechte im Mandanten hat dieser Principal keine.
 */
export function platformActor(a: Account): Principal {
  return {
    tenantId: '', tenantAlias: '', principalId: a.accountId, kind: 'user', subject: a.subject, name: a.name, email: a.email, clientId: null,
    grantId: null, groups: [], subjects: [], scopes: [], platformAdmin: true, binding: a.binding, identityProvider: a.identityProvider, token: a.token,
  };
}

/** Plattform-Administration der Anfrage (Kontext `platform`), sonst 403. */
export function platformOf(req: FastifyRequest, role: string): Principal {
  const a = req.requireAccount();
  if (!a.platformAdmin) throw forbidden(`Nur für die Plattform-Administration (Realm-Rolle ${role}).`, { reason: 'platform-admin-only' });
  return platformActor(a);
}

/** Angemeldete Person (nicht Maschinen-Client, nicht über den MCP-Dienst), sonst 403: für die Verwaltung. */
export function personOf(req: FastifyRequest): Principal {
  const p = req.requirePrincipal();
  if (p.kind !== 'user' || p.scopeBound) throw forbidden('Nur für angemeldete Personen.');
  return p;
}
