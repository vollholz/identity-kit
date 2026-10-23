/**
 * Nachgebildete Microsoft-Endpunkte für die Entra-Anbindung von `@vollholz/iam` (`src/graph.ts`, aus Assets
 * test/platform/entra-fake.ts) als `fetch`-Ersatz: OpenID-Konfiguration je Tenant (Tenant-ID oder verifizierte Domain),
 * Token mit Client Credentials (nur nach Zustimmung, richtiges Geheimnis) und Graph `/organization` und `/users` (Filter
 * nach UPN oder mail, `$search` mit ConsistencyLevel: eventual). Verhalten wie Microsoft, soweit die Plattform es nutzt:
 * unbekannter Tenant → 400, ohne Zustimmung AADSTS7000229/65001, falsches Geheimnis AADSTS7000215. Zustimmung mit
 * Anmeldung: `approve` spielt den Browser nach, der Token-Endpunkt löst den Code (PKCE) gegen ein signiertes ID-Token ein.
 * Eigene App einer Organisation (`app`): App-Registrierung in einem Tenant mit eigenem Geheimnis, erteilten
 * Anwendungsberechtigungen (`roles` im Token, Graph prüft sie: sonst 403) und Ablauf des Geheimnisses
 * (`/applications(appId='…')`, nur mit Application.Read.All). Wie Microsoft: App eines anderen Tenants AADSTS700016,
 * falsches Geheimnis AADSTS7000215, abgelaufenes AADSTS7000222.
 */
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

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

/** App-Registrierung einer Organisation in ihrem Tenant (eigene App). `roles`: erteilte Anwendungsberechtigungen. */
export interface FakeApp {
  clientId: string; tenantId: string; secret: string; roles: string[]; expired: boolean;
  passwordCredentials: { keyId: string; hint: string; endDateTime: string }[];
}

export class EntraFake {
  readonly tenants = new Map<string, FakeTenant>();
  /** Eigene Apps der Organisationen, nach Anwendungs-ID. */
  readonly apps = new Map<string, FakeApp>();
  /** Rollen der Tokens eigener Apps (Graph prüft sie). */
  private readonly tokenRoles = new Map<string, string[]>();
  readonly calls: string[] = [];
  /** Suchausdrücke von `$search` (Teil 2). */
  readonly searches: string[] = [];
  secret = 'entra-geheim';
  /** So viele Token-Anfragen nach der Zustimmung scheitern noch (Rechte gelten erst nach Sekunden). */
  lagging = 0;
  private readonly tokens = new Map<string, string>();
  private readonly codes = new Map<string, { tid: string; clientId: string; redirectUri: string; challenge: string; nonce: string; claims: Record<string, unknown>; used: boolean }>();
  private key: Promise<{ privateKey: CryptoKey; jwk: JWK }> | null = null;

  /** Signaturschlüssel der ID-Tokens (wie die Schlüssel eines Tenants unter `/{tid}/discovery/v2.0/keys`). */
  private signer() {
    this.key ??= generateKeyPair('RS256').then(async k => ({ privateKey: k.privateKey, jwk: { ...await exportJWK(k.publicKey), kid: 'fake-1', alg: 'RS256', use: 'sig' } }));
    return this.key;
  }

  /**
   * Anmeldung und Zustimmung im Browser nachspielen: `url` ist die Adresse aus `consentUrl` (Code-Flow mit PKCE). Danach
   * hat der Tenant zugestimmt; zurück kommen die Parameter der Rückkehr (`code`, `state`). Das ID-Token beim Einlösen trägt
   * die Person, `wids` (Rollen im Tenant), `guest` (acct 1) und `claims` (überschreibt, z. B. `tid` oder `nonce`).
   */
  approve(url: string, user: FakeEntraUser, o: { wids?: string[]; guest?: boolean; claims?: Record<string, unknown> } = {}): { code: string; state: string } {
    const u = new URL(url), q = u.searchParams;
    const tid = u.pathname.split('/').filter(Boolean)[0]!;
    const t = this.tenants.get(tid);
    if (!t || u.pathname !== `/${tid}/oauth2/v2.0/authorize` || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') throw new Error(`EntraFake: keine Anmeldung mit Code-Flow (${url})`);
    t.consented = true;
    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      tid, clientId: q.get('client_id')!, redirectUri: q.get('redirect_uri')!, challenge: q.get('code_challenge')!, nonce: q.get('nonce') ?? '', used: false,
      claims: { oid: user.id, name: user.displayName, preferred_username: user.userPrincipalName, wids: o.wids ?? [], acct: o.guest ? 1 : 0, ...o.claims },
    });
    return { code, state: q.get('state')! };
  }

  tenant(name: string, domains: string[]): FakeTenant {
    const t: FakeTenant = { id: randomUUID(), name, domains, users: [], consented: false };
    this.tenants.set(t.id, t);
    return t;
  }
  /**
   * Eigene App im Tenant `t` registrieren. Standard: Organization.Read.All und User.Read.All erteilt, Geheimnis gültig
   * bis `endDateTime` (Standard in einem Jahr).
   */
  app(t: FakeTenant, o: { clientId?: string; secret?: string; roles?: string[]; expired?: boolean; endDateTime?: string } = {}): FakeApp {
    const secret = o.secret ?? `kunde~${randomUUID()}`;
    const a: FakeApp = {
      clientId: o.clientId ?? randomUUID(), tenantId: t.id, secret, roles: o.roles ?? ['Organization.Read.All', 'User.Read.All'], expired: o.expired ?? false,
      passwordCredentials: [{ keyId: randomUUID(), hint: secret.slice(0, 3), endDateTime: o.endDateTime ?? new Date(Date.now() + 365 * 86_400_000).toISOString() }],
    };
    this.apps.set(a.clientId, a);
    return a;
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
      if (rest.join('/') === 'discovery/v2.0/keys' && t) return json(200, { keys: [(await this.signer()).jwk] });
      if (rest.join('/') === 'oauth2/v2.0/token' && method === 'POST') {
        const f = new URLSearchParams(String(init?.body));
        if (!t || t.id !== key) return json(400, { error: 'invalid_request', error_description: 'AADSTS900023: Specified tenant identifier is neither a valid DNS name, nor a valid external domain.' });
        const own = this.apps.get(f.get('client_id') ?? '');
        if (own && f.get('grant_type') === 'client_credentials') {
          if (own.tenantId !== t.id) return json(400, { error: 'unauthorized_client', error_description: `AADSTS700016: Application with identifier '${own.clientId}' was not found in the directory.` });
          if (f.get('client_secret') !== own.secret) return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
          if (own.expired) return json(401, { error: 'invalid_client', error_description: 'AADSTS7000222: The provided client secret keys are expired.' });
          // Wie Microsoft ein JWT mit `roles` (hier unsigniert; die Plattform liest nur die Rollen)
          const part = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
          const token = `${part({ alg: 'none', typ: 'JWT' })}.${part({ tid: t.id, appid: own.clientId, roles: [...own.roles] })}.x`;
          this.tokens.set(token, t.id); this.tokenRoles.set(token, [...own.roles]);
          return json(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
        }
        if (f.get('client_secret') !== this.secret) return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
        if (f.get('grant_type') === 'authorization_code') {
          // Code nur einmal, im selben Tenant, mit derselben Redirect-URI und passendem PKCE-Verifier
          const c = this.codes.get(f.get('code') ?? '');
          if (!c || c.used || c.tid !== t.id || c.clientId !== f.get('client_id') || c.redirectUri !== f.get('redirect_uri')) return json(400, { error: 'invalid_grant', error_description: 'AADSTS70000: The provided authorization code is invalid or has expired.' });
          if (createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'AADSTS501481: The Code_Verifier does not match the code_challenge supplied in the authorization request.' });
          c.used = true;
          const k = await this.signer();
          const now = Math.floor(Date.now() / 1000);
          const idToken = await new SignJWT({
            iss: `https://login.microsoftonline.com/${t.id}/v2.0`, aud: c.clientId, sub: `sub-${String(c.claims.oid)}`, iat: now, exp: now + 3600,
            tid: t.id, nonce: c.nonce, ver: '2.0', ...c.claims,
          }).setProtectedHeader({ alg: 'RS256', kid: 'fake-1', typ: 'JWT' }).sign(k.privateKey);
          return json(200, { access_token: `delegated-${randomUUID()}`, id_token: idToken, token_type: 'Bearer', expires_in: 3599 });
        }
        if (!t.consented) return json(400, { error: 'invalid_client', error_description: 'AADSTS7000229: The client application is missing service principal in the tenant.' });
        if (this.lagging > 0) { this.lagging--; return json(400, { error: 'invalid_grant', error_description: 'AADSTS65001: The user or administrator has not consented to use the application.' }); }
        const token = `graph-${randomUUID()}`;
        this.tokens.set(token, t.id);
        return json(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
      }
      return json(404, { error: 'unbekannt' });
    }
    if (url.host === 'graph.microsoft.com') {
      const bearer = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace(/^Bearer /, '');
      const tid = this.tokens.get(bearer);
      const t = tid ? this.tenants.get(tid) : undefined;
      const roles = this.tokenRoles.get(bearer);
      if (!t || (!t.consented && !roles)) return json(401, { error: { code: 'InvalidAuthenticationToken' } });
      // Eigene App: nur mit der passenden Anwendungsberechtigung (sonst 403 wie Graph)
      const path = decodeURIComponent(url.pathname);
      const needed = path === '/v1.0/organization' ? 'Organization.Read.All' : path.startsWith('/v1.0/users') ? 'User.Read.All' : path.startsWith('/v1.0/applications') ? 'Application.Read.All' : null;
      if (roles && needed && !roles.includes(needed)) return json(403, { error: { code: 'Authorization_RequestDenied' } });
      const appRead = /^\/v1\.0\/applications\(appId='([^']+)'\)$/.exec(path);
      if (appRead) {
        const a = this.apps.get(appRead[1]!);
        return a && a.tenantId === t.id ? json(200, { passwordCredentials: a.passwordCredentials }) : json(404, { error: { code: 'Request_ResourceNotFound' } });
      }
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
