/**
 * Modul `people`: Personenverzeichnis des Mandanten (Spezifikation Kap. 9.2; aus Assets `modules/catalog/people.ts`):
 * Personen (und auf Wunsch Maschinen-Clients) aus `<schema>.principal`. Quelle sind die Anmeldungen (principal.ts) und
 * der Abgleich mit Keycloak (sync.ts), der Mitglieder schon vor der ersten Anmeldung bringt (`lastSeenAt` dann `null`);
 * aus der Organisation entfernte Personen fehlen in der Liste, bleiben aber einzeln lesbar (Werte der App verweisen
 * darauf). Mandantentrennung über RLS. Vertrag der Oberflächen-Bausteine (`@vollholz/iam-web`).
 *
 * Recht: irgendwo (`needSomewhere`) eines der Rechte aus der Option `people.permissions` – Standard die Fachrechte des
 * Lese-Scopes `<produkt>:read` und `acl:read` (Assets: `object:read`). Wer Daten der App liest, muss die Namen dazu
 * auflösen und für eigene Änderungen Personen auswählen können; `tenant:read` allein öffnet das Verzeichnis nicht.
 *
 * Datenschutz (Datenminimierung): Name und ID sehen alle mit dem Recht. Die E-Mail-Adresse sehen angemeldete Personen
 * (zum Unterscheiden gleicher Namen) und Verwaltende, nicht aber Maschinen-Clients und Zugriffe über den MCP-Dienst. Die
 * Suche nutzt die E-Mail nur, wenn sie sichtbar ist, sonst liesse sie sich erraten. Der letzte Zugriff (`lastSeenAt`)
 * ist Verhaltensdaten und nur für Verwaltende (`acl:read` oder `tenant:admin`) sichtbar.
 */
import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RESERVED_PERMISSIONS, type Catalog } from '../catalog.ts';
import { forbidden, invalid, notFound } from '../errors.ts';
import { Cursor, DateTime, decodeCursor, encodeCursor, IdParams, likePattern, Limit, NextCursor, Nullable, Params, routeSchema, type IamModule, type ModuleContext } from './routes.ts';

const TAG = 'Personen';

const Person = Type.Object({
  id: Type.String({ description: 'Principal-ID in dieser Organisation; Wert von Personenfeldern der App' }),
  kind: Type.Unsafe<'user' | 'client'>({ type: 'string', enum: ['user', 'client'], description: '`user` = Person, `client` = Maschinen-Client' }),
  name: Type.String(),
  email: Nullable(Type.String({ description: 'Nur für angemeldete Personen und Verwaltende, sonst `null`' })),
  clientId: Nullable(Type.String({ description: 'Client-ID bei Maschinen-Clients' })),
  lastSeenAt: Nullable(DateTime),
}, { $id: 'Person', title: 'Person', description: '`lastSeenAt`: letzter Zugriff, nur für Verwaltende (`acl:read` oder `tenant:admin`), sonst `null`; auch `null` bei eingeladenen Mitgliedern, die sich noch nie angemeldet haben.' });

const ListQuery = Type.Object({
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Teilstring in Name oder E-Mail (ohne Gross/Klein); bei Clients auch Client-ID. E-Mail nur, wenn sie sichtbar ist.' })),
  kind: Type.Optional(Type.Unsafe<'user' | 'client'>({ type: 'string', enum: ['user', 'client'], default: 'user', description: 'Standard: Personen' })),
  limit: Type.Optional(Limit), cursor: Type.Optional(Cursor),
  ids: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 100, description: 'Bestimmte Personen bzw. Clients auf einmal auflösen (höchstens 100, z. B. für Listen). Liefert Personen und Clients (`kind` wird ignoriert), nicht kombinierbar mit `q` und `cursor`; unbekannte IDs fehlen in `items`.' })),
});

interface Row { id: string; kind: 'user' | 'client'; display_name: string | null; email: string | null; client_id: string | null; last_seen_at: Date | null; _sort: string }

const SORT = "lower(coalesce(display_name, ''))";
const COLS = `id, kind, display_name, email, client_id, last_seen_at, ${SORT} AS _sort`;

/**
 * Rechte, die das Verzeichnis öffnen (Standard): Fachrechte des Lese-Scopes `<produkt>:read` (ohne reservierte wie
 * `tenant:read`), dazu `acl:read`, wenn der Katalog Zugriffsregeln hat.
 */
export function defaultPeoplePermissions(catalog: Catalog): string[] {
  const read = catalog.scopes.get(`${catalog.product}:read`)?.permissions ?? [];
  return [...read.filter(p => !Object.hasOwn(RESERVED_PERMISSIONS, p)), ...(catalog.acl ? ['acl:read'] : [])];
}

export const peopleModule: IamModule = {
  name: 'people',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const { catalog } = iam;
    const S = iam.schema;
    const perms = (ctx.people?.permissions ?? defaultPeoplePermissions(catalog)).filter(p => catalog.isPermission(p));
    if (!perms.length) throw new Error('Modul «people»: kein Recht öffnet das Verzeichnis (Option people.permissions oder Lese-Scope <produkt>:read)');
    app.addSchema(Person);

    const allowed = async (req: FastifyRequest) => {
      const p = req.requirePrincipal();
      for (const perm of perms) if (await iam.access.canSomewhere(p, perm)) return p;
      throw forbidden(`Für das Personenverzeichnis fehlt das Recht ${perms.map(x => catalog.permissionText(x)).join(' oder ')}.`);
    };
    /** Was der Aufrufer über andere sehen darf. */
    const visibility = async (req: FastifyRequest) => {
      const p = req.requirePrincipal();
      const admin = (catalog.isPermission('acl:read') && (await req.can('acl:read'))) || (catalog.isPermission('tenant:admin') && (await req.can('tenant:admin')));
      return { email: admin || (p.kind === 'user' && !p.scopeBound), lastSeen: admin };
    };
    const out = (r: Row, v: { email: boolean; lastSeen: boolean }) => ({
      id: r.id, kind: r.kind, name: r.display_name ?? (r.client_id ?? 'Unbekannt'), email: v.email ? r.email : null,
      clientId: r.client_id, lastSeenAt: v.lastSeen ? r.last_seen_at : null,
    });

    const list = `${prefix}/people`, item = `${prefix}/people/:id`;
    app.get(list, {
      schema: routeSchema(ctx, 'GET', list, {
        tags: [TAG], summary: 'Personen suchen und auflisten', querystring: ListQuery,
        description: 'Bekannte Personen der Organisation (alle, die sich mindestens einmal angemeldet haben, sowie Mitglieder aus dem Abgleich), sortiert nach Name. Aus der Organisation entfernte Personen fehlen. Seitenweise mit Cursor.',
        response: { 200: Type.Object({ items: Type.Array(Type.Ref('Person')), nextCursor: NextCursor }) },
      }),
    }, async req => {
      await allowed(req);
      const q = req.query as { q?: string; kind?: 'user' | 'client'; limit?: number; cursor?: string; ids?: string[] };
      const kind = q.kind ?? 'user', limit = q.limit ?? 50;
      const vis = await visibility(req);
      // Sammelabfrage: Namen vieler Principals auf einmal (Listen, Verlauf), unabhängig von der Art
      if (q.ids) {
        if (q.q || q.cursor) throw invalid('`ids` lässt sich nicht mit `q` oder `cursor` kombinieren.');
        const ids = [...new Set(q.ids.map(x => x.toLowerCase()))];
        const rows = await req.tx(async tx => (await tx.query<Row>(`SELECT ${COLS} FROM ${S}.principal WHERE id = ANY($1::uuid[]) ORDER BY ${SORT}, id`, [ids])).rows);
        return { items: rows.map(r => out(r, vis)), nextCursor: null };
      }
      const fingerprint = `${kind}:${vis.email ? 'e' : ''}${q.q ? `:${createHash('sha256').update(q.q).digest('base64url').slice(0, 12)}` : ''}`;
      const cur = decodeCursor<{ f: string; v: string; id: string }>(q.cursor, c => c.f === fingerprint && typeof c.v === 'string' && typeof c.id === 'string' && /^[0-9a-f-]{36}$/i.test(c.id));
      const P = new Params(), where = [`kind = ${P.add(kind)}`, 'removed_at IS NULL'];
      if (q.q) {
        const like = P.add(likePattern(q.q));
        where.push(`(display_name ILIKE ${like}${vis.email ? ` OR email ILIKE ${like}` : ''}${kind === 'client' ? ` OR client_id ILIKE ${like}` : ''})`);
      }
      if (cur) where.push(`(${SORT}, id) > (${P.add(cur.v)}, ${P.add(cur.id)}::uuid)`);
      const rows = await req.tx(async tx => (await tx.query<Row>(`SELECT ${COLS} FROM ${S}.principal WHERE ${where.join(' AND ')} ORDER BY ${SORT}, id LIMIT ${limit + 1}`, P.values)).rows);
      const more = rows.length > limit, page = rows.slice(0, limit), last = page[page.length - 1];
      return { items: page.map(r => out(r, vis)), nextCursor: more && last ? encodeCursor({ f: fingerprint, v: last._sort, id: last.id }) : null };
    });

    app.get(item, {
      schema: routeSchema(ctx, 'GET', item, { tags: [TAG], summary: 'Person lesen', description: 'Auch Maschinen-Clients und aus der Organisation entfernte Personen. Unbekannt oder aus einer anderen Organisation: 404.', params: IdParams, response: { 200: Type.Ref('Person') } }),
    }, async req => {
      await allowed(req);
      const vis = await visibility(req);
      const r = await req.tx(async tx => (await tx.query<Row>(`SELECT ${COLS} FROM ${S}.principal WHERE id = $1`, [(req.params as { id: string }).id])).rows[0]);
      if (!r) throw notFound('Person');
      return out(r, vis);
    });
  },
};
