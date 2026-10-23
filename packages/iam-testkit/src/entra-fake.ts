/**
 * Nachgebildete Microsoft-Endpunkte für die Entra-Anbindung von `@vollholz/iam` (`src/graph.ts`, aus Assets
 * test/platform/entra-fake.ts) als `fetch`-Ersatz: OpenID-Konfiguration je Tenant (Tenant-ID oder verifizierte Domain),
 * Token mit Client Credentials (nur nach Zustimmung, richtiges Geheimnis) und Graph `/organization` und `/users` (Filter
 * nach UPN oder mail, `$search` mit ConsistencyLevel: eventual). Verhalten wie Microsoft, soweit die Plattform es nutzt:
 * unbekannter Tenant → 400, ohne Zustimmung AADSTS7000229/65001, falsches Geheimnis AADSTS7000215.
 */
import { randomUUID } from 'node:crypto';

/** Person in Entra ID, Felder wie `$select` der Entra-Anbindung. */
export interface FakeEntraUser {
  id: string;
  userPrincipalName: string;
  mail: string | null;
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  userType: string | null;
  accountEnabled: boolean | null;
  department?: string | null;
  jobTitle?: string | null;
}

export interface FakeTenant { id: string; name: string; domains: string[]; users: FakeEntraUser[]; consented: boolean }

export class EntraFake {
  readonly tenants = new Map<string, FakeTenant>();
  readonly calls: string[] = [];
  /** Suchausdrücke von `$search` (Teil 2). */
  readonly searches: string[] = [];
  secret = 'entra-geheim';
  /** So viele Token-Anfragen nach der Zustimmung scheitern noch (Rechte gelten erst nach Sekunden). */
  lagging = 0;
  private readonly tokens = new Map<string, string>();

  tenant(name: string, domains: string[]): FakeTenant {
    const t: FakeTenant = { id: randomUUID(), name, domains, users: [], consented: false };
    this.tenants.set(t.id, t);
    return t;
  }
  user(t: FakeTenant, upn: string, o: Partial<FakeEntraUser> = {}): FakeEntraUser {
    const u: FakeEntraUser = { id: randomUUID(), userPrincipalName: upn, mail: upn, displayName: upn, givenName: null, surname: null, userType: 'Member', accountEnabled: true, ...o };
    t.users.push(u);
    return u;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    this.calls.push(`${method} ${url.host}${url.pathname}`);
    if (url.host === 'login.microsoftonline.com') {
      const [first, ...rest] = url.pathname.split('/').filter(Boolean);
      const key = decodeURIComponent(first ?? '').toLowerCase();
      const t = this.tenants.get(key) ?? [...this.tenants.values()].find(x => x.domains.includes(key));
      if (rest.join('/') === 'v2.0/.well-known/openid-configuration') {
        if (!t) return json(400, { error: 'invalid_tenant', error_description: `AADSTS90002: Tenant '${key}' not found.` });
        return json(200, { issuer: `https://login.microsoftonline.com/${t.id}/v2.0`, token_endpoint: `https://login.microsoftonline.com/${t.id}/oauth2/v2.0/token` });
      }
      if (rest.join('/') === 'oauth2/v2.0/token' && method === 'POST') {
        const f = new URLSearchParams(String(init?.body));
        if (!t || t.id !== key) return json(400, { error: 'invalid_request', error_description: 'AADSTS900023: Specified tenant identifier is neither a valid DNS name, nor a valid external domain.' });
        if (f.get('client_secret') !== this.secret) return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
        if (!t.consented) return json(400, { error: 'invalid_client', error_description: 'AADSTS7000229: The client application is missing service principal in the tenant.' });
        if (this.lagging > 0) { this.lagging--; return json(400, { error: 'invalid_grant', error_description: 'AADSTS65001: The user or administrator has not consented to use the application.' }); }
        const token = `graph-${randomUUID()}`;
        this.tokens.set(token, t.id);
        return json(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
      }
      return json(404, { error: 'unbekannt' });
    }
    if (url.host === 'graph.microsoft.com') {
      const tid = this.tokens.get(String((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace(/^Bearer /, ''));
      const t = tid ? this.tenants.get(tid) : undefined;
      if (!t || !t.consented) return json(401, { error: { code: 'InvalidAuthenticationToken' } });
      if (url.pathname === '/v1.0/organization') return json(200, { value: [{ id: t.id, displayName: t.name, verifiedDomains: t.domains.map(name => ({ name, isVerified: true })) }] });
      if (url.pathname === '/v1.0/users' && url.searchParams.has('$search')) {
        // Wie Graph: $search nur mit ConsistencyLevel: eventual; Wortanfang in Name, mail oder UPN (je Ausdruck "feld:wert")
        if ((init?.headers as Record<string, string> | undefined)?.ConsistencyLevel !== 'eventual') return json(400, { error: { code: 'Request_UnsupportedQuery' } });
        const terms = [...(url.searchParams.get('$search') ?? '').matchAll(/"(displayName|mail|userPrincipalName):([^"]*)"/g)].map(x => [x[1]!, x[2]!.toLowerCase()] as const);
        if (!terms.length) return json(400, { error: { code: 'BadRequest' } });
        this.searches.push(url.searchParams.get('$search')!);
        const top = Number(url.searchParams.get('$top') ?? 100);
        const hits = t.users.filter(u => terms.some(([f, v]) => String((u as unknown as Record<string, unknown>)[f] ?? '').toLowerCase().split(/[\s.@_-]+/).some(w => w.startsWith(v.split(' ')[0]!))));
        return json(200, { value: hits.slice(0, top), ...(hits.length > top ? { '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=x' } : {}) });
      }
      if (url.pathname === '/v1.0/users') {
        const m = /^userPrincipalName eq '(.*)' or mail eq '(.*)'$/.exec(url.searchParams.get('$filter') ?? '');
        if (!m) return json(400, { error: { code: 'BadRequest' } });
        const a = m[1]!.replace(/''/g, "'").toLowerCase();
        return json(200, { value: t.users.filter(u => u.userPrincipalName.toLowerCase() === a || u.mail?.toLowerCase() === a) });
      }
      const u = /^\/v1\.0\/users\/([^/]+)$/.exec(url.pathname);
      if (u) { const hit = t.users.find(x => x.id === u[1]); return hit ? json(200, hit) : json(404, { error: { code: 'Request_ResourceNotFound' } }); }
      return json(404, { error: { code: 'NotFound' } });
    }
    return json(404, { error: 'unbekannter Host' });
  };
}

function json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
