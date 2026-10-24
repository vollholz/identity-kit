/**
 * Modul `break-glass` (Spezifikation Kap. 7.8, 9.7): Eine Person mit direktem Tupel `user:<id> org-admin` an org (nicht
 * über Gruppen oder `org:members`, wie `/auth/me` › `breakGlassAllowed`) hebt ihre Freigabestufe befristet auf 2. Gibt
 * keine Rechte, gilt nicht für Clients und nicht über MCP. Ein neuer Aufruf beginnt neu ab jetzt; `DELETE` beendet.
 * Audit `break_glass.started` (`reason`, `until`) und `break_glass.ended` (`expired: false`; Ablauf meldet der Worker).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { live, type AccessService, type TenantAccess } from '../access.ts';
import { forbidden, invalid } from '../errors.ts';
import { ADMIN_ROLE } from '../model.ts';
import type { Principal } from '../principal.ts';
import { personOf, routeSchema, type IamModule, type ModuleContext } from './routes.ts';

const TAG = 'Zugriff';

/** Darf die Person Break-Glass starten? Direktes, nicht abgelaufenes Tupel `user:<id> org-admin` an org. */
export function breakGlassAllowed(access: AccessService<any, any>, acl: TenantAccess<any>, p: Principal): boolean {
  if (p.kind !== 'user' || p.scopeBound) return false;
  const me = `user:${p.principalId}`;
  return access.at(acl, { type: 'org' }).some(t => t.subject === me && t.relation === ADMIN_ROLE && live(t));
}

export const breakGlassModule: IamModule = {
  name: 'break-glass',
  register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam, prefix } = ctx;
    const S = iam.schema;
    const url = `${prefix}/break-glass`;
    const allowed = async (req: FastifyRequest) => {
      const p = personOf(req);
      if (!breakGlassAllowed(iam.access, await iam.access.load(p.tenantId), p)) throw forbidden('Break-Glass gibt es nur für Personen mit der Rolle «Organisations-Admin» an der Organisation.');
      return p;
    };
    const actor = (req: FastifyRequest, p: Principal) => ({ principal: { kind: p.kind, principalId: p.principalId, name: p.name, clientId: p.clientId }, source: req.source, correlationId: req.id });

    app.post(url, {
      schema: routeSchema(ctx, 'POST', url, {
        tags: [TAG], summary: 'Break-Glass: Freigabestufe befristet auf «streng vertraulich» heben',
        body: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 500 }), minutes: Type.Integer({ minimum: 1, maximum: 240 }) }, { additionalProperties: false }),
        response: { 200: Type.Object({ until: Type.String({ format: 'date-time' }), clearance: Type.Literal(2) }) },
      }),
    }, async req => {
      const p = await allowed(req);
      const b = req.body as { reason: string; minutes: number };
      const reason = b.reason.trim();
      if (!reason) throw invalid('Begründung fehlt', [{ path: '/reason', message: 'Begründung angeben' }]);
      const until = await iam.fullTx(p, async tx => {
        const u = (await tx.query<{ until: Date }>(`UPDATE ${S}.principal SET clearance_boost = 2, clearance_until = now() + make_interval(mins => $2) WHERE id = $1 RETURNING clearance_until AS until`, [p.principalId, b.minutes])).rows[0]!.until;
        await iam.audit.write(tx, actor(req, p), { action: 'break_glass.started', resourceType: 'principal', resourceId: p.principalId, data: { reason, until: u.toISOString(), minutes: b.minutes } });
        return u;
      });
      iam.access.invalidate(p.tenantId);
      return { until: until.toISOString(), clearance: 2 as const };
    });

    app.delete(url, {
      schema: routeSchema(ctx, 'DELETE', url, { tags: [TAG], summary: 'Break-Glass beenden', description: 'Auch ohne aktives Break-Glass 204.', response: { 204: Type.Null() } }),
    }, async (req, reply) => {
      const p = await allowed(req);
      await iam.fullTx(p, async tx => {
        const r = await tx.query(`UPDATE ${S}.principal SET clearance_boost = NULL, clearance_until = NULL WHERE id = $1 AND clearance_until > now() RETURNING id`, [p.principalId]);
        await tx.query(`UPDATE ${S}.principal SET clearance_boost = NULL, clearance_until = NULL WHERE id = $1 AND clearance_until IS NOT NULL`, [p.principalId]);
        if (r.rowCount) await iam.audit.write(tx, actor(req, p), { action: 'break_glass.ended', resourceType: 'principal', resourceId: p.principalId, data: { expired: false } });
      });
      iam.access.invalidate(p.tenantId);
      return reply.status(204).send(null);
    });
  },
};
