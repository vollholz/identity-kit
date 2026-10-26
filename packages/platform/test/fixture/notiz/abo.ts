/**
 * Abo der Notizen als Text (Muster für Kalender-Abos): `GET /abo/notizen/<alias>.<token>.txt` ohne Sitzung. Das Paket
 * löst die Organisation auf und begrenzt das Rate-Limit; das Modul sucht das Token und liest in der Lesesicht der
 * Person (Scope `probe:read`).
 */
import { Type } from '@sinclair/typebox';
import { aliasToken, publicToken, type PublicRoute, type Tx } from '../../../src/index.ts';

/** Token für eine Person anlegen oder ersetzen; liefert das Token (nur einmal sichtbar). */
export async function issueAbo(tx: Tx, principalId: string): Promise<string> {
  const t = publicToken();
  await tx.query(
    `INSERT INTO probe.notiz_abo (tenant_id, principal_id, token_hash) VALUES (app.tenant_id(), $1, $2)
     ON CONFLICT (tenant_id, principal_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = now()`, [principalId, t.hash]);
  return t.token;
}

export const aboRoute: PublicRoute = {
  name: 'notiz-abo',
  url: '/abo/notizen/:datei',
  credentials: req => aliasToken((req.params as { datei?: string }).datei, { suffix: '.txt' }),
  scopes: ['probe:read'],
  rateLimit: { max: 5 },
  schema: {
    tags: ['Notizen'], summary: 'Abo der Notizen (ohne Anmeldung)',
    description: 'Liste der Notizen, die die Person des Tokens lesen darf, als Text. Unbekannte Links ergeben 404.',
    params: Type.Object({ datei: Type.String({ maxLength: 300 }) }),
  },
  async handler(ctx, _req, reply) {
    const abo = (await ctx.tx.query<{ principal_id: string }>('SELECT principal_id FROM probe.notiz_abo WHERE token_hash = $1', [ctx.tokenHash])).rows[0];
    if (!abo || !(await ctx.viewAs(abo.principal_id))) return null;
    const rows = (await ctx.tx.query<{ label: string }>('SELECT label FROM probe.notiz ORDER BY label, id')).rows;
    return reply.type('text/plain; charset=utf-8').send(rows.map(r => r.label).join('\n'));
  },
};
