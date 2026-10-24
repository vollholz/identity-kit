/**
 * Modul `bff`: Anmeldung der Oberfläche unter `/auth/*` (aus Assets `modules/auth/index.ts`, ohne die Auslieferung der
 * Oberfläche, die in der App bleibt). Aktiv, wenn `createIam` ein `Bff` gebaut hat (`OIDC_BFF_CLIENT_ID` mit Secret
 * oder Schlüssel, `SESSION_SECRET`).
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrgAlias, LoginExpired, safeReturnTo, type Bff } from '../bff.ts';
import { HttpError } from '../errors.ts';
import { orgAlias } from '../principal.ts';
import { HIDDEN, routeSchema, type IamModule, type ModuleContext } from './routes.ts';
import { breakGlassAllowed } from './break-glass.ts';

const FORM = 'application/x-www-form-urlencoded';
/** Anbieter für Microsoft Entra ID: Plätze der App der Plattform (`entra-001` …) oder eigene App (`entra-app-<alias>`). */
const ENTRA_IDP_PATTERN = '^entra-([0-9]{3}|app-[a-z0-9][a-z0-9_-]{0,62})$';
const TAG_UI = 'Anmeldung (Oberfläche)';
const Query = Type.Object({
  returnTo: Type.Optional(Type.String({ maxLength: 2048 })), org: Type.Optional(Type.String({ maxLength: 63 })),
  idp: Type.Optional(Type.String({ pattern: ENTRA_IDP_PATTERN, description: 'Anmeldung direkt über diesen Anbieter (Testanmeldung über Microsoft Entra ID); erzwingt eine neue Anmeldung' })),
});

function wantsJson(accept: unknown) { return typeof accept === 'string' && accept.includes('application/json'); }

/**
 * Schlichte Fehlerseite für Browser-Routen der Anmeldung (nie rohes JSON): Du-Form, Knopf «Erneut anmelden», keine
 * technischen Details (die stehen im Log). Ohne Skripte, eigene CSP.
 */
export function loginErrorPage(status: number): string {
  const [title, text] = status === 503 || status >= 500
    ? ['Anmeldung gerade nicht möglich', 'Der Anmeldedienst ist im Moment nicht erreichbar. Versuche es in ein paar Minuten nochmals.']
    : ['Anmeldung hat nicht geklappt', 'Die Anmeldung ist abgelaufen oder wurde abgebrochen. Melde dich bitte erneut an.'];
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${title}</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f9;color:#1d2330;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:28rem;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 1.5rem;color:#4a5263}
a{display:inline-block;background:#1f5fbf;color:#fff;text-decoration:none;padding:.6rem 1.2rem;border-radius:8px;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#14171c;color:#e6e8ec}main{background:#1d2128;box-shadow:none}p{color:#aab1bd}a{background:#4c8dff}}
</style></head>
<body><main><h1>${title}</h1><p>${text}</p><a href="/auth/login">Erneut anmelden</a></main></body></html>
`;
}

export const bffModule: IamModule = {
  name: 'bff',
  async register(app: FastifyInstance, ctx: ModuleContext) {
    const { iam } = ctx;
    const bff: Bff | null = iam.bff;
    if (!bff) throw new Error('Modul «bff» braucht OIDC_BFF_CLIENT_SECRET oder OIDC_BFF_PRIVATE_KEY und SESSION_SECRET');
    const { cfg } = iam;
    bff.startCleanup();
    app.addHook('onClose', async () => bff.stopCleanup());
    const csrfMissing = () => new HttpError(403, 'CSRF-Token fehlt oder ist ungültig', 'Header «X-CSRF-Token» oder Feld «csrf» aus /auth/me mitsenden.');
    // Browser-Routen: Fehler als Seite statt Problem-JSON; Details nur ins Log. Mit Accept: application/json (Aufruf aus
    // der Oberfläche) weiter an die Fehlerbehandlung der App.
    const page = async (err: Error & { statusCode?: number; validation?: unknown }, req: FastifyRequest, reply: FastifyReply) => {
      if (wantsJson(req.headers.accept)) throw err;
      const status = err instanceof HttpError ? err.status : err.validation ? 422 : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
      if (err instanceof HttpError) reply.headers(err.headers);
      if (status >= 500) req.log.error({ err }, 'Anmeldung: Fehlerseite');
      else req.log.warn({ status, reason: err.message }, 'Anmeldung: Fehlerseite');
      bff.clearRetry(reply);
      return reply.status(status).type('text/html; charset=utf-8')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
        .send(loginErrorPage(status));
    };

    // Gekapselt: Formular-Parser und Cache-Control nur für /auth/*
    await app.register(async scope => {
      if (!scope.hasContentTypeParser(FORM)) {
        scope.addContentTypeParser(FORM, { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
      }
      scope.addHook('onSend', async (_req, reply, payload) => { reply.header('cache-control', 'no-store'); return payload; });
      const schema = <T extends Record<string, unknown>>(method: string, url: string, s: T) => routeSchema(ctx, method, url, s);

      scope.get('/auth/login', { errorHandler: page, schema: schema('GET', '/auth/login', { tags: [TAG_UI], summary: 'Anmeldung starten (Weiterleitung zu Keycloak)', querystring: Query, security: [] }) }, async (req: FastifyRequest, reply: FastifyReply) => {
        const q = req.query as { returnTo?: string; org?: string; idp?: string };
        const org = q.org ?? null;
        if (org !== null && !isOrgAlias(org)) throw new HttpError(400, 'Organisation ungültig');
        return reply.redirect(await bff.beginLogin(reply, q.returnTo, org, q.idp ?? null), 302);
      });

      // Einladung aus Microsoft Entra ID: Ziel nach dem Link in der E-Mail von Keycloak (Redirect-URI `…/auth/entra/*` des
      // Clients) und Link zum Weitergeben. Startet nur die Anmeldung über diesen Anbieter; Parameter der Weiterleitung
      // (etwa ein Code) werden nicht weitergegeben.
      scope.get('/auth/entra/:idp', {
        errorHandler: page,
        schema: schema('GET', '/auth/entra/:idp', {
          tags: [TAG_UI], summary: 'Anmeldung über Microsoft Entra ID (Link der Einladung)', security: [],
          params: Type.Object({ idp: Type.String({ pattern: ENTRA_IDP_PATTERN }) }),
          querystring: Type.Object({ org: Type.Optional(Type.String({ maxLength: 63 })) }),
        }),
      }, async (req: FastifyRequest, reply: FastifyReply) => {
        const org = (req.query as { org?: string }).org ?? null;
        return reply.redirect(await bff.beginLogin(reply, '/', org !== null && isOrgAlias(org) ? org : null, (req.params as { idp: string }).idp), 302);
      });

      // Abgelaufener oder unbekannter Anmeldezustand (z. B. Link «Passwort vergessen» in einem anderen Tab): mit gültiger
      // Sitzung in die App, sonst einmal automatisch neu anmelden (bei bestehender Keycloak-Sitzung ohne Rückfrage); erst
      // danach die Fehlerseite. Fehler von Keycloak (error=access_denied …) und alles andere: Fehlerseite.
      scope.get('/auth/callback', { schema: HIDDEN, errorHandler: page }, async (req, reply) => {
        try {
          return reply.redirect(await bff.completeLogin(req, reply), 302);
        } catch (e) {
          if (!(e instanceof LoginExpired)) throw e;
          if (await bff.current(req, reply).catch(() => null)) { req.log.info({}, 'Anmeldung: Anmeldezustand abgelaufen, Sitzung gültig'); return reply.redirect('/', 302); }
          if ((req.query as { error?: unknown }).error !== undefined || !bff.retryLogin(req, reply)) throw e;
          req.log.info({}, 'Anmeldung: Anmeldezustand abgelaufen, neue Anmeldung');
          return reply.redirect(await bff.beginLogin(reply, '/', null), 302);
        }
      });

      // Wechsel ändert die Sitzung: nur per POST mit CSRF-Token. GET (alte Links) ändert nichts.
      scope.get('/auth/switch', { schema: HIDDEN, errorHandler: page }, async () => {
        throw new HttpError(405, 'Methode nicht erlaubt', 'Organisation per POST /auth/switch mit X-CSRF-Token wechseln.', { allow: 'POST' });
      });

      scope.post('/auth/switch', {
        errorHandler: page,
        schema: schema('POST', '/auth/switch', {
          tags: [TAG_UI], summary: 'Organisation wechseln (Vorgabe der Sitzung)', security: [],
          description: 'JSON oder Formular. CSRF-Token im Header `X-CSRF-Token` oder Feld `csrf`. Setzt nur die Vorgabe der Sitzung für Anfragen ohne `X-Tenant` '
            + '(die Oberfläche führt die Organisation je Tab und sendet sie als `X-Tenant`; andere Tabs bleiben in ihrer Organisation). Nur Organisationen der Sitzung; '
            + 'ist sie nicht im aktuellen Token, folgt eine neue Anmeldung (Rückfall). Antwort mit `Accept: application/json` `{ redirect }`, sonst 303.',
          body: Type.Object({ org: Type.String({ maxLength: 63 }), returnTo: Type.Optional(Type.String({ maxLength: 2048 })), csrf: Type.Optional(Type.String({ maxLength: 256 })) }),
          response: { 200: Type.Object({ redirect: Type.String() }) },
        }),
      }, async (req: FastifyRequest, reply: FastifyReply) => {
        const { org, returnTo, csrf } = req.body as { org: string; returnTo?: string; csrf?: string };
        if (!isOrgAlias(org)) throw new HttpError(400, 'Organisation ungültig', 'Feld «org» mit dem Alias der Organisation angeben.');
        const s = await bff.current(req, reply);
        if (!s) throw new HttpError(401, 'Nicht angemeldet', 'Anmeldung über /auth/login.');
        if (!bff.csrfOk(req.headers['x-csrf-token'] ?? csrf, s.csrf)) throw csrfMissing();
        const alias = orgAlias(org)!;
        if (!s.data.orgs.includes(alias)) throw new HttpError(403, 'Organisation nicht erlaubt', `Deine Sitzung hat keinen Zugang zu «${alias}».`);
        // Rückfall, wenn die Organisation nicht im aktuellen Token steht: neue Anmeldung mit Vorwahl (bei bestehender Keycloak-Sitzung ohne Rückfrage)
        const target = await bff.switchOrg(s, alias) ? safeReturnTo(returnTo) : await bff.beginLogin(reply, returnTo, alias);
        return wantsJson(req.headers.accept) ? { redirect: target } : reply.redirect(target, 303);
      });

      scope.get('/auth/me', {
        schema: schema('GET', '/auth/me', {
          tags: [TAG_UI], summary: 'Angemeldete Person, Mandant, Organisationen, Rollen, Rechte und CSRF-Token', security: [],
          description: 'Mandant aus dem Header `X-Tenant` (Organisation des Tabs), ohne Header aus der Vorgabe der Sitzung. Steht die Organisation nicht im Token '
            + 'oder ist die Person kein Mitglied mehr, ist `tenant` null und `tenantError` nennt den Grund. `organizationNames`: Name je Organisation des Tokens. '
            + '`roles`, `permissions`: Rollen und Rechte an der Organisation; `somewhere`: Rechte, die an mindestens einem Ort gelten; `clearance`: wirksame Freigabestufe; `breakGlassAllowed`: direktes Tupel org-admin.',
        }),
      }, async (req: FastifyRequest, reply: FastifyReply) => {
        const s = await bff.current(req, reply);
        if (!s) throw new HttpError(401, 'Nicht angemeldet', 'Anmeldung über /auth/login.');
        const header = req.headers['x-tenant'];
        const requested = typeof header === 'string' && header ? header : s.data.org;
        let tenant: { id: string; alias: string; name: string; entraConnected: boolean } | null = null, roles: string[] = [], permissions: string[] = [], somewhere: string[] = [], tenantError: string | null = null;
        let clearance = 0, breakGlassUntil: string | null = null, allowed = false;
        try {
          const verified = await iam.verifier.verify(s.data.accessToken, { audience: cfg.oidc.apiAudience, method: 'GET', url: `${cfg.publicBaseUrl}/auth/me` });
          // Der Resolver bleibt die einzige Prüfung: nur Organisationen aus dem Token, Mitgliedschaft in der Plattform
          const p = await iam.resolver.resolve(verified, requested);
          const acl = await iam.access.load(p.tenantId);
          tenant = { id: p.tenantId, alias: p.tenantAlias, name: await bff.tenantName(p.tenantId) ?? p.tenantAlias, entraConnected: !!(await iam.entra?.connected(p.tenantId)) };
          roles = iam.access.rolesAtOrg(p, acl); permissions = iam.access.orgPermissions(p, acl); somewhere = iam.access.somewherePermissions(p, acl, await iam.access.personGrants(p, p.tenantId));
          clearance = iam.access.clearanceOf(p, acl); breakGlassUntil = iam.access.breakGlassUntil(acl, p.principalId)?.toISOString() ?? null;
          allowed = breakGlassAllowed(iam.access, acl, p);
        } catch (e) {
          if (!(e instanceof HttpError) || e.status === 401 || e.status >= 500) throw e;
          tenantError = e.detail ?? e.title; // z. B. mehrere Organisationen und noch keine gewählt, nicht (mehr) im Token, kein Mitglied mehr
        }
        return {
          person: { subject: s.data.sub, name: s.data.name, email: s.data.email },
          tenant, organizations: s.data.orgs, organizationNames: await bff.organizationNames(s), selectedOrganization: s.data.org, tenantError, roles, permissions, somewhere,
          clearance, breakGlassUntil, breakGlassAllowed: allowed,
          csrfToken: s.csrf, session: { expiresAt: new Date(s.expiresAt).toISOString(), idleTimeoutSeconds: Math.round(cfg.session.idleMs / 1000) },
        };
      });

      scope.post('/auth/logout', { errorHandler: page, schema: schema('POST', '/auth/logout', { tags: [TAG_UI], summary: 'Abmelden (Sitzung löschen, Abmeldung bei Keycloak)', security: [] }) }, async (req: FastifyRequest, reply: FastifyReply) => {
        const s = await bff.load(req, reply, { touch: false });
        let target = '/';
        if (s) {
          const body = (req.body ?? {}) as { csrf?: unknown };
          if (!bff.csrfOk(req.headers['x-csrf-token'] ?? body.csrf, s.csrf)) throw csrfMissing();
          target = await bff.logout(s, reply);
        }
        return wantsJson(req.headers.accept) ? { redirect: target } : reply.redirect(target, 303);
      });

      scope.post('/auth/backchannel-logout', { schema: HIDDEN }, async (req, reply) => {
        const token = (req.body as { logout_token?: unknown } | undefined)?.logout_token;
        try {
          if (typeof token !== 'string' || !token) throw new HttpError(400, 'logout_token fehlt');
          const n = await bff.backchannelLogout(token);
          req.log.info({ sessions: n }, 'Backchannel-Logout');
          return reply.status(200).send();
        } catch (e) {
          if (!(e instanceof HttpError) || e.status !== 400) throw e;
          return reply.status(400).send({ error: 'invalid_request', error_description: e.detail ?? e.title });
        }
      });
    });
  },
};
