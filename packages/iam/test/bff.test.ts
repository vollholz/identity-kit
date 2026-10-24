/**
 * Anmeldung der Oberfläche (Modul `bff`; aus Assets test/platform/bff.test.ts, produktneutral mit der Beispiel-App
 * «notes») gegen einen Mock-IdP mit Authorization-, Token- und End-Session-Endpunkt. Der Test spielt den Browser:
 * /auth/login → Keycloak → /auth/callback → Sitzungs-Cookie. Die Auslieferung der Oberfläche (CSP) bleibt in der App.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { Bff, decodeClaims, safeReturnTo, scopesFor, type Session, type SessionData } from '../src/bff.ts';
import { MemoryReplayStore } from '../src/state.ts';
import { pgAudit } from '../src/audit.ts';
import { ConfigError } from '../src/config.ts';
import { Sealer } from '../src/crypto.ts';
import { IAM_API_TAGS } from '../src/http/routes.ts';
import { createIam } from '../src/iam.ts';
import { notesModel } from './support/models.ts';
import { testConfig } from './support/config.ts';
import { skipDb } from './support/db.ts';
import { claims, grant, notesApp, notesDb, notesResources, type NotesApp } from './support/http.ts';

const skip = await skipDb();
const CLIENT_ID = 'notes-platform', CLIENT_SECRET = 'bff-geheimnis-für-tests';
const BCL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
/** Person wie Keycloak sie ausstellt: Organisationen, ohne Rollen (Rollen sind Tupel). */
const userClaims = (o: { org: string | string[]; email?: string; name?: string; sub?: string }) =>
  claims.user({ org: o.org, sub: o.sub, name: o.name, email: o.email });

// ---------------------------------------------------------------- Mock-IdP (Keycloak-ähnlich)
interface Grant { claims: Record<string, unknown>; sid: string; nonce?: string; challenge?: string; redirectUri?: string }
interface MockOp {
  issuer: string;
  /** Person für die nächste Anmeldung. */
  user: Record<string, unknown>;
  authRequests: URLSearchParams[];
  endSessionRequests: URLSearchParams[];
  refreshCount: number;
  accessTtlSec: number;
  /** Claims für die nächsten Erneuerungen (z. B. nach Entfernen aus einer Organisation); null = wie bei der Anmeldung. */
  refreshAs: Record<string, unknown> | null;
  revokeRefreshTokens(): void;
  logoutToken(claims: Record<string, unknown>, o?: { aud?: string }): Promise<string>;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Claim «organization» (Liste von Aliassen oder Objekt mit IDs) auf eine Organisation beschränken; ohne Alias: nur bei genau einer. */
function narrowOrgs(v: unknown, alias: string | null | undefined): unknown {
  const keys = Array.isArray(v) ? v as string[] : v && typeof v === 'object' ? Object.keys(v) : [];
  const keep = alias ? keys.filter(k => k === alias) : keys.length === 1 ? keys : [];
  if (Array.isArray(v) || !v || typeof v !== 'object') return keep;
  return Object.fromEntries(Object.entries(v).filter(([k]) => keep.includes(k)));
}

async function startMockOp(): Promise<MockOp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, Grant>();
  const refresh = new Map<string, Grant & { used: boolean }>();
  const sign = (claims: Record<string, unknown>, aud: string, key: CryptoKey = privateKey, exp = '5m') => new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'JWT' }).setIssuer(op.issuer).setAudience(aud)
    .setIssuedAt().setExpirationTime(exp).setJti(randomUUID()).sign(key);

  async function tokens(g: Grant) {
    const rt = randomBytes(24).toString('base64url');
    refresh.set(rt, { ...g, used: false });
    const sub = String(g.claims.sub);
    return {
      token_type: 'Bearer', expires_in: op.accessTtlSec, refresh_token: rt, refresh_expires_in: 1800, scope: 'openid profile email organization',
      access_token: await new SignJWT({ ...g.claims, sid: g.sid }).setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'JWT' }).setIssuer(op.issuer)
        .setAudience(['notes-api', CLIENT_ID]).setSubject(sub).setIssuedAt().setExpirationTime('5m').setJti(randomUUID()).sign(privateKey),
      id_token: await sign({ sub, sid: g.sid, azp: CLIENT_ID, name: g.claims.name, email: g.claims.email, organization: g.claims.organization, ...(g.nonce ? { nonce: g.nonce } : {}) }, CLIENT_ID),
    };
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, op.issuer);
    const json = (status: number, b: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    const p = url.pathname.replace('/realms/test', '');
    if (p === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: op.issuer, authorization_endpoint: `${op.issuer}/protocol/openid-connect/auth`, token_endpoint: `${op.issuer}/protocol/openid-connect/token`,
        end_session_endpoint: `${op.issuer}/protocol/openid-connect/logout`, jwks_uri: `${op.issuer}/protocol/openid-connect/certs`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true, backchannel_logout_supported: true, backchannel_logout_session_supported: true,
      });
    }
    if (p === '/protocol/openid-connect/certs') return json(200, { keys: [jwk] });
    if (p === '/protocol/openid-connect/auth') {
      const q = url.searchParams;
      op.authRequests.push(q);
      if (q.get('client_id') !== CLIENT_ID || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
      // Wie Keycloak 26: organization:* liefert alle Organisationen der Person, organization:<alias> nur diese,
      // organization ohne Wert bei mehreren nur die beim Anmelden gewählte (hier: keine Wahl → leerer Claim)
      const claims = { ...op.user };
      const orgScope = (q.get('scope') ?? '').split(' ').find(s => s === 'organization' || s.startsWith('organization:'));
      if (orgScope !== 'organization:*') claims.organization = narrowOrgs(claims.organization, orgScope === 'organization' ? null : orgScope?.slice('organization:'.length));
      const code = randomBytes(16).toString('hex');
      codes.set(code, { claims, sid: randomUUID(), nonce: q.get('nonce')!, challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')! });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code); back.searchParams.set('state', q.get('state')!); back.searchParams.set('iss', op.issuer);
      res.statusCode = 302; res.setHeader('location', back.href); return res.end();
    }
    if (p === '/protocol/openid-connect/token' && req.method === 'POST') {
      const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':').map(decodeURIComponent);
      if (auth[0] !== CLIENT_ID || auth[1] !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
      const f = new URLSearchParams(await body(req));
      if (f.get('grant_type') === 'authorization_code') {
        const g = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        if (!g || g.redirectUri !== f.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
        if (createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== g.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
        return json(200, await tokens(g));
      }
      if (f.get('grant_type') === 'refresh_token') {
        const g = refresh.get(f.get('refresh_token') ?? '');
        if (!g || g.used) return json(400, { error: 'invalid_grant', error_description: 'Token is not active' });
        g.used = true; op.refreshCount++;
        await new Promise(r => setTimeout(r, 30)); // Erneuerung dauert etwas: parallele Anfragen überlappen
        return json(200, await tokens({ claims: op.refreshAs ?? g.claims, sid: g.sid }));
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (p === '/protocol/openid-connect/logout') { op.endSessionRequests.push(url.searchParams); res.statusCode = 200; return res.end('abgemeldet'); }
    json(404, {});
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const op: MockOp = {
    issuer: `http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/test`,
    user: {}, authRequests: [], endSessionRequests: [], refreshCount: 0, accessTtlSec: 300, refreshAs: null,
    revokeRefreshTokens: () => { for (const g of refresh.values()) g.used = true; },
    logoutToken: (claims, o = {}) => sign({ events: { [BCL_EVENT]: {} }, ...claims }, o.aud ?? CLIENT_ID),
    close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
  return op;
}

// ---------------------------------------------------------------- Einheiten ohne Datenbank
describe('BFF-Bausteine', () => {
  test('Rücksprungziel: nur relative Pfade innerhalb der Anwendung', () => {
    for (const bad of ['//evil.example', 'https://evil.example/', '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)', 'evil', '', '/\tx', '/%0a', undefined, 42])
      assert.equal(safeReturnTo(bad), bad === '/%0a' ? '/%0a' : '/', String(bad));
    assert.equal(safeReturnTo('/katalog?typ=server#neu'), '/katalog?typ=server#neu');
    assert.equal(safeReturnTo('/a/../b'), '/b');
    assert.equal(safeReturnTo('/a/.//b'), '/a//b', 'doppelter Schrägstrich nur am Anfang gefährlich');
  });

  test('Rücksprungziel: Punktsegmente ergeben nach dem Normalisieren keine protokollrelative Adresse (A1)', () => {
    for (const bad of ['/.//evil.example', '/..//evil.example', '/a/..//evil.example', '/%2e//evil.example', '/%2E%2E//evil.example', '/./%2e//evil.example/x?y#z'])
      assert.equal(safeReturnTo(bad), '/', bad);
  });

  test('createIam: BFF nur mit Clientauthentifizierung; dann SESSION_SECRET Pflicht; abschaltbar', () => {
    const base = { model: notesModel, resources: notesResources, db: null as never, schema: 'notes', audit: pgAudit({ schema: 'notes' }) };
    assert.equal(createIam({ ...base, cfg: testConfig('http://idp.test/realms/notes') }).bff, null, 'ohne Secret kein BFF');
    assert.throws(() => createIam({ ...base, cfg: testConfig('http://idp.test/realms/notes', { OIDC_BFF_CLIENT_SECRET: 'x' }) }), (e: unknown) => e instanceof ConfigError && /SESSION_SECRET fehlt/.test(e.message));
    const cfg = testConfig('http://idp.test/realms/notes', { OIDC_BFF_CLIENT_SECRET: 'x', SESSION_SECRET: 's'.repeat(32) });
    const iam = createIam({ ...base, cfg, bff: { log: { warn() {}, error() {} } } });
    assert.deepEqual([iam.bff?.cookieName, iam.bff?.loginCookieName], ['notes_sid', 'notes_login'], 'Cookies nach dem Produkt');
    assert.equal(createIam({ ...base, cfg, bff: false }).bff, null, 'abgeschaltet (MCP-Dienst)');
  });

  test('Produktname im Cookie: nur nach dem Muster der Produkte, sonst ConfigError beim Start', () => {
    const cfg = testConfig('http://idp.test/realms/notes', { OIDC_BFF_CLIENT_SECRET: 'x', SESSION_SECRET: 's'.repeat(32) });
    for (const product of ['Notes', 'no;tes', 'a b', 'x'.repeat(42)]) {
      assert.throws(() => new Bff(cfg, null as never, null as never, { schema: 'notes', product, log: { warn() {}, error() {} } }), ConfigError, product);
    }
  });

  test('NODE_ENV=production: Cookies mit __Host- und Secure, ENCRYPTION_KEYS Pflicht', async () => {
    const env = { NODE_ENV: 'production', OIDC_BFF_CLIENT_SECRET: 'x', SESSION_SECRET: 's'.repeat(32) };
    assert.throws(() => testConfig('https://idp.test/realms/notes', env), /ENCRYPTION_KEYS fehlt/, 'Konfiguration');
    const cfg = testConfig('https://idp.test/realms/notes', { ...env, ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}` });
    assert.throws(() => new Bff({ ...cfg, encryptionKeys: [] }, null as never, null as never, { schema: 'notes', product: 'notes' }), /ENCRYPTION_KEYS fehlt/, 'auch ohne Konfigurationsprüfung');
    const prod = new Bff(cfg, null as never, null as never, { schema: 'notes', product: 'notes' });
    assert.deepEqual([prod.cookieName, prod.loginCookieName], ['__Host-notes_sid', '__Host-notes_login']);
    const app = Fastify();
    await app.register(cookie, { secret: cfg.session.secrets });
    app.get('/', async (_req, reply) => { (prod as unknown as { setSessionCookie(r: unknown, sid: string): void }).setSessionCookie(reply, 'abc'); return 'ok'; });
    try {
      const c = (await app.inject({ url: '/' })).cookies.find(x => x.name === '__Host-notes_sid')!;
      assert.deepEqual([c.secure, c.httpOnly, c.path, c.sameSite, c.domain], [true, true, '/', 'Lax', undefined], '__Host- verlangt Secure, Path=/ und keine Domain');
    } finally { await app.close(); }
  });

  test('Scopes: organization wird immer zu organization:* (alle Organisationen der Person, E1)', () => {
    assert.equal(scopesFor('openid profile email organization'), 'openid profile email organization:*');
    assert.equal(scopesFor('openid organization:acme profile'), 'openid organization:* profile');
    assert.equal(scopesFor('openid organization organization:*'), 'openid organization:*');
    assert.equal(scopesFor('openid profile'), 'openid profile', 'ohne Organisations-Scope unverändert');
  });

});

// ---------------------------------------------------------------- Ablauf mit Datenbank
describe('Anmeldung der Oberfläche (BFF)', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, op: MockOp, n: NotesApp, bff: Bff, sealer: Sealer;
  let offset = 0;
  let app: NotesApp['app'];
  let env: Record<string, string>;

  before(async () => {
    t = await db.create();
    op = await startMockOp();
    const key = randomBytes(32);
    sealer = new Sealer([{ id: 'k1', key }]);
    n = await notesApp({
      db: t.runtime, issuer: op.issuer,
      env: (env = { OIDC_BFF_CLIENT_SECRET: CLIENT_SECRET, SESSION_SECRET: randomBytes(32).toString('hex'), ENCRYPTION_KEYS: `k1:${key.toString('base64')}`, SESSION_TTL: '8h', SESSION_IDLE_TIMEOUT: '30m' }),
      bff: { now: () => Date.now() + offset, log: { warn() {}, error() {} } },
      after: a => {
        a.post('/v1/echo', async req => ({ ok: true, tenant: req.principal?.tenantAlias, source: req.source }));
        a.get('/v1/echo', { schema: { querystring: { type: 'object', properties: { delimiter: { type: 'string' } }, additionalProperties: false } } }, async req => ({ tenant: req.principal?.tenantAlias, query: req.query }));
      },
    });
    bff = n.iam.bff!;
    app = n.app;
  });
  after(async () => { await n?.app.close(); await op?.close(); await t?.drop(); });
  beforeEach(() => { offset = 0; op.accessTtlSec = 300; op.refreshAs = null; op.user = userClaims({ org: 'acme', email: 'anna@example.ch', name: 'Anna Muster' }); });

  const sessionId = (cookie: string) => createHash('sha256').update(cookie.split('.')[0]!).digest('hex');
  async function readSession(cookie: string): Promise<SessionData> {
    const id = sessionId(cookie);
    const row = (await t.inspect.query('SELECT data FROM notes.session WHERE id = $1', [id])).rows[0];
    return JSON.parse(sealer.open(row.data, id).toString('utf8')) as SessionData;
  }
  /** Sitzungsinhalt direkt ändern (z. B. eine Sitzung aus der Zeit vor organization:* nachbilden). */
  async function editSession(cookie: string, fn: (d: SessionData) => SessionData) {
    const id = sessionId(cookie);
    await t.inspect.query('UPDATE notes.session SET data = $2 WHERE id = $1', [id, sealer.seal(JSON.stringify(fn(await readSession(cookie))), id)]);
  }
  /** Spielt den Browser durch den Code-Flow. */
  async function login(o: { returnTo?: string; org?: string; cookie?: string } = {}) {
    const qs = new URLSearchParams({ ...(o.returnTo !== undefined ? { returnTo: o.returnTo } : {}), ...(o.org ? { org: o.org } : {}) });
    const start = await app.inject({ url: `/auth/login?${qs}` });
    assert.equal(start.statusCode, 302, start.body);
    const loginCookie = start.cookies.find(c => c.name === 'notes_login')!;
    const atIdp = await fetch(start.headers.location as string, { redirect: 'manual' });
    const cb = new URL(atIdp.headers.get('location')!);
    const done = await app.inject({ url: `${cb.pathname}${cb.search}`, cookies: { notes_login: loginCookie.value, ...(o.cookie ? { notes_sid: o.cookie } : {}) } });
    const sid = done.cookies.find(c => c.name === 'notes_sid' && c.value);
    return { start, done, cookie: sid?.value ?? '', sidCookie: sid, authUrl: new URL(start.headers.location as string) };
  }
  const sessionCount = async () => Number((await t.inspect.query('SELECT count(*) FROM notes.session')).rows[0].count);
  const me = (cookie: string, headers: Record<string, string> = {}) => app.inject({ url: '/v1/me', cookies: { notes_sid: cookie }, headers });
  const csrfOf = async (cookie: string) => (await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie } })).json().csrfToken as string;
  /** Organisation wechseln wie die Oberfläche: POST mit X-CSRF-Token, Antwort als JSON. */
  const switchTo = async (cookie: string, body: Record<string, string>, csrf: string | null = null) => app.inject({
    method: 'POST', url: '/auth/switch', cookies: { notes_sid: cookie }, payload: body,
    headers: { accept: 'application/json', ...(csrf === null ? { 'x-csrf-token': await csrfOf(cookie) } : csrf ? { 'x-csrf-token': csrf } : {}) },
  });

  test('Login-Ablauf: PKCE S256, state, nonce → Sitzung mit sicherem Cookie und verschlüsseltem Inhalt', async () => {
    const before = await sessionCount();
    const { start, done, cookie, sidCookie, authUrl } = await login({ returnTo: '/katalog?typ=server' });
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authUrl.searchParams.get('state') && authUrl.searchParams.get('nonce') && authUrl.searchParams.get('code_challenge'));
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://api.test/auth/callback');
    assert.equal(authUrl.searchParams.get('scope'), 'openid profile email organization:*');
    const lc = start.cookies.find(c => c.name === 'notes_login')!;
    assert.ok(lc.httpOnly && lc.sameSite === 'Lax' && lc.path === '/');

    assert.equal(done.statusCode, 302, done.body);
    assert.equal(done.headers.location, '/katalog?typ=server');
    assert.ok(sidCookie!.httpOnly && sidCookie!.sameSite === 'Lax' && sidCookie!.path === '/');
    const [rawSid] = cookie.split('.');
    assert.ok(Buffer.from(rawSid!, 'base64url').length === 32, 'Sitzungs-ID mit 256 Bit');
    assert.equal(await sessionCount(), before + 1);

    const row = (await t.inspect.query('SELECT id, data FROM notes.session WHERE id = $1', [createHash('sha256').update(rawSid!).digest('hex')])).rows[0];
    assert.ok(row, 'Datenbank speichert nur den Hash der Sitzungs-ID');
    assert.ok(!row.data.toString('latin1').includes('eyJ') && !row.data.toString('latin1').includes('Anna'), 'Inhalt verschlüsselt');

    const r = await me(cookie);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().tenant.alias, 'acme');
    // Rollen kommen aus Tupeln, nie aus dem Token
    await grant(t.runtime, r.json().tenant.id, 'org:members', 'editor').catch(() => undefined);

    const m = await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie } });
    assert.equal(m.statusCode, 200, m.body);
    const b = m.json();
    assert.equal(b.person.name, 'Anna Muster');
    assert.equal(b.tenant.alias, 'acme');
    assert.equal(b.tenant.name, 'acme', 'neuer Mandant heisst wie der Alias');
    assert.deepEqual(b.organizations, ['acme']);
    assert.ok(b.roles.includes('editor') && b.permissions.includes('note:write'));
    assert.deepEqual([b.somewhere.includes('note:write'), b.clearance, b.breakGlassUntil, b.breakGlassAllowed, b.tenant.entraConnected], [true, 0, null, false, false]);
    // Banner-Daten für Break-Glass (Kap. 9.7): erlaubt mit direktem Tupel org-admin; aktiv mit Ende und Stufe 2
    await grant(t.runtime, r.json().tenant.id, `user:${r.json().principal.id}`, 'org-admin');
    const allowed = (await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie } })).json();
    assert.deepEqual([allowed.breakGlassAllowed, allowed.breakGlassUntil], [true, null]);
    const bg = await app.inject({ method: 'POST', url: '/v1/break-glass', cookies: { notes_sid: cookie }, headers: { 'x-csrf-token': allowed.csrfToken }, payload: { reason: 'Banner', minutes: 5 } });
    assert.equal(bg.statusCode, 200, bg.body);
    const banner = (await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie } })).json();
    assert.deepEqual([banner.clearance, banner.breakGlassUntil], [2, bg.json().until]);
    await app.inject({ method: 'DELETE', url: '/v1/break-glass', cookies: { notes_sid: cookie }, headers: { 'x-csrf-token': allowed.csrfToken } });
    assert.ok(!('grantedPermissions' in b));
    assert.ok(typeof b.csrfToken === 'string' && b.csrfToken.length >= 40);
    assert.equal(m.headers['cache-control'], 'no-store');
  });

  test('Routen /auth/* in der OpenAPI-Beschreibung mit Tag aus IAM_API_TAGS; Callback und Backchannel versteckt', async () => {
    const doc = (await app.inject({ url: '/v1/openapi.json' })).json();
    for (const [path, method] of [['/auth/login', 'get'], ['/auth/entra/{idp}', 'get'], ['/auth/switch', 'post'], ['/auth/me', 'get'], ['/auth/logout', 'post']] as const) {
      assert.deepEqual(doc.paths[path]?.[method]?.tags, ['Anmeldung (Oberfläche)'], path);
      assert.deepEqual(doc.paths[path][method].security, [], `${path}: ohne Token`);
    }
    assert.ok(IAM_API_TAGS.some(x => x.name === 'Anmeldung (Oberfläche)'));
    assert.ok(!doc.paths['/auth/callback'] && !doc.paths['/auth/backchannel-logout']);
  });

  test('Callback ohne passenden Anmeldezustand oder mit falschem state → 400', async () => {
    const start = await app.inject({ url: '/auth/login' });
    const atIdp = await fetch(start.headers.location as string, { redirect: 'manual' });
    const cb = new URL(atIdp.headers.get('location')!);
    assert.equal((await app.inject({ url: `${cb.pathname}${cb.search}` })).statusCode, 400);
    cb.searchParams.set('state', 'manipuliert');
    const lc = start.cookies.find(c => c.name === 'notes_login')!.value;
    assert.equal((await app.inject({ url: `${cb.pathname}${cb.search}`, cookies: { notes_login: lc } })).statusCode, 400);
  });

  test('Session-Fixation: Anmeldung ersetzt eine bestehende Sitzung, gefälschte Cookies zählen nicht', async () => {
    const first = await login();
    const second = await login({ cookie: first.cookie });
    assert.notEqual(first.cookie, second.cookie);
    assert.equal((await me(first.cookie)).statusCode, 401);
    assert.equal((await me(second.cookie)).statusCode, 200);
    const forged = `${randomBytes(32).toString('base64url')}.${second.cookie.split('.')[1]}`;
    assert.equal((await me(forged)).statusCode, 401);
    assert.equal((await me(second.cookie.split('.')[0]!)).statusCode, 401, 'unsignierte ID wird abgelehnt');
  });

  test('CSRF: schreibende Anfragen nur mit X-CSRF-Token der Sitzung', async () => {
    const { cookie } = await login();
    const csrf = (await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie } })).json().csrfToken as string;
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/v1/echo', cookies: { notes_sid: cookie }, headers, payload: {} });
    assert.equal((await post({})).statusCode, 403);
    assert.equal((await post({ 'x-csrf-token': `${csrf.slice(0, -1)}x` })).statusCode, 403);
    const ok = await post({ 'x-csrf-token': csrf });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(ok.json(), { ok: true, tenant: 'acme', source: 'ui' });
    assert.equal((await me(cookie)).statusCode, 200, 'lesende Anfragen ohne CSRF-Token');
  });

  test('Refresh: kurz vor Ablauf genau eine Erneuerung, auch bei parallelen Anfragen; Rotation', async () => {
    const { cookie } = await login();
    const n0 = op.refreshCount;
    offset = 290_000; // Access Token läuft in 10 s ab (Erneuerung 30 s vorher)
    const rs = await Promise.all(Array.from({ length: 6 }, () => me(cookie)));
    for (const r of rs) assert.equal(r.statusCode, 200, r.body);
    assert.equal(op.refreshCount - n0, 1, 'nur eine Erneuerung');
    assert.equal((await me(cookie)).statusCode, 200);
    assert.equal(op.refreshCount - n0, 1, 'neues Token gilt wieder 5 min');
    offset = 590_000; // zweite Erneuerung mit dem rotierten Refresh Token
    assert.equal((await me(cookie)).statusCode, 200);
    assert.equal(op.refreshCount - n0, 2);
  });

  test('Refresh abgelehnt (in Keycloak abgemeldet) → Sitzung beendet', async () => {
    const { cookie } = await login();
    op.revokeRefreshTokens();
    offset = 290_000;
    const r = await me(cookie);
    assert.equal(r.statusCode, 401);
    assert.equal((await t.inspect.query('SELECT count(*) FROM notes.session WHERE id = $1', [createHash('sha256').update(cookie.split('.')[0]!).digest('hex')])).rows[0].count, '0');
  });

  test('Idle-Timeout und Aufräumen abgelaufener Sitzungen', async () => {
    const { cookie } = await login();
    offset = 20 * 60_000;
    assert.equal((await me(cookie)).statusCode, 200, 'Aktivität verlängert die Sitzung');
    offset = 45 * 60_000; // 25 min nach der letzten Aktivität
    assert.equal((await me(cookie)).statusCode, 200);
    offset = 45 * 60_000 + 31 * 60_000;
    const r = await me(cookie);
    assert.equal(r.statusCode, 401);
    assert.ok(r.cookies.some(c => c.name === 'notes_sid' && c.value === ''), 'Cookie wird gelöscht');

    await login(); await login();
    const total = await sessionCount();
    offset += 31 * 60_000;
    assert.equal(await bff.cleanup(), total);
    assert.equal(await sessionCount(), 0);
  });

  test('Logout: CSRF-Pflicht, Sitzung gelöscht, RP-initiated Logout bei Keycloak', async () => {
    const { cookie } = await login();
    const csrf = (await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie } })).json().csrfToken as string;
    assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', cookies: { notes_sid: cookie } })).statusCode, 403);
    const r = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { notes_sid: cookie }, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `csrf=${encodeURIComponent(csrf)}` });
    assert.equal(r.statusCode, 303, r.body);
    const loc = new URL(r.headers.location as string);
    assert.equal(`${loc.origin}${loc.pathname}`, `${op.issuer}/protocol/openid-connect/logout`);
    assert.equal(loc.searchParams.get('post_logout_redirect_uri'), 'http://api.test/abgemeldet');
    assert.ok(loc.searchParams.get('id_token_hint'));
    assert.ok(r.cookies.some(c => c.name === 'notes_sid' && c.value === ''));
    assert.equal((await me(cookie)).statusCode, 401);

    const second = await login();
    const csrf2 = (await app.inject({ url: '/auth/me', cookies: { notes_sid: second.cookie } })).json().csrfToken as string;
    const j = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { notes_sid: second.cookie }, headers: { 'x-csrf-token': csrf2, accept: 'application/json' } });
    assert.equal(j.statusCode, 200);
    assert.match(j.json().redirect, /protocol\/openid-connect\/logout\?/);
    assert.equal((await app.inject({ method: 'POST', url: '/auth/logout' })).headers.location, '/', 'ohne Sitzung zur Startseite');
  });

  test('Backchannel-Logout: Logout-Token prüfen, Sitzungen per sid bzw. sub beenden', async () => {
    const sub = randomUUID();
    op.user = userClaims({ sub, org: 'acme' });
    const a = await login(), b = await login();
    const sidOf = async (cookie: string) => (await t.inspect.query('SELECT idp_sid FROM notes.session WHERE id = $1', [createHash('sha256').update(cookie.split('.')[0]!).digest('hex')])).rows[0].idp_sid as string;
    const bcl = (token: string) => app.inject({ method: 'POST', url: '/auth/backchannel-logout', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `logout_token=${token}` });

    for (const bad of [
      await op.logoutToken({ sid: await sidOf(a.cookie) }, { aud: 'anderer-client' }),
      await op.logoutToken({ sid: await sidOf(a.cookie), nonce: 'x' }),
      await op.logoutToken({ sid: await sidOf(a.cookie), events: { andere: {} } }),
      await op.logoutToken({}),
      'kein-jwt',
    ]) {
      const r = await bcl(bad);
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(r.json().error, 'invalid_request');
    }
    assert.equal((await me(a.cookie)).statusCode, 200);

    const tok = await op.logoutToken({ sid: await sidOf(a.cookie), sub });
    assert.equal((await bcl(tok)).statusCode, 200);
    assert.equal((await me(a.cookie)).statusCode, 401);
    assert.equal((await me(b.cookie)).statusCode, 200, 'andere Keycloak-Sitzung bleibt');
    assert.equal((await bcl(tok)).statusCode, 400, 'Wiederholung abgelehnt');

    const c = await login();
    assert.equal((await bcl(await op.logoutToken({ sub }))).statusCode, 200);
    assert.equal((await me(b.cookie)).statusCode, 401);
    assert.equal((await me(c.cookie)).statusCode, 401);
  });

  test('Offene Weiterleitungen werden verhindert', async () => {
    for (const target of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)', '/.//evil.example', '/..//evil.example', '/a/..//evil.example', '/%2e//evil.example']) {
      const { done } = await login({ returnTo: target });
      assert.equal(done.headers.location, '/', target);
    }
    const { cookie } = await login();
    for (const returnTo of ['//evil.example', 'https://evil.example/', '/\\evil.example', '/.//evil.example', '/%2e//evil.example']) {
      const sw = await switchTo(cookie, { org: 'acme', returnTo });
      assert.equal(sw.statusCode, 200, sw.body);
      assert.equal(sw.json().redirect, '/', returnTo);
    }
    assert.equal((await switchTo(cookie, { org: 'https://evil.example' })).statusCode, 400);
  });

  test('Mehrere Organisationen: Auswahl, Wechsel ohne und mit neuer Anmeldung', async () => {
    op.user = userClaims({ org: ['acme', 'globex'] });
    const { cookie } = await login();
    let m = (await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie } })).json();
    assert.equal(m.tenant, null);
    assert.deepEqual(m.organizations, ['acme', 'globex']);
    assert.ok(m.tenantError);
    assert.equal((await me(cookie)).statusCode, 400, 'API verlangt eine Wahl');

    // GET ändert nichts mehr (früher per Link auslösbar)
    const get = await app.inject({ url: '/auth/switch?org=globex&returnTo=/start', cookies: { notes_sid: cookie } });
    assert.equal(get.statusCode, 405);
    assert.equal(get.headers.allow, 'POST');
    // ohne oder mit falschem CSRF-Token abgelehnt
    assert.equal((await switchTo(cookie, { org: 'globex' }, '')).statusCode, 403);
    assert.equal((await switchTo(cookie, { org: 'globex' }, 'falsch')).statusCode, 403);
    assert.equal((await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie } })).json().selectedOrganization, null, 'nichts gewechselt');

    const sw = await switchTo(cookie, { org: 'globex', returnTo: '/start' });
    assert.equal(sw.statusCode, 200, sw.body);
    assert.deepEqual(sw.json(), { redirect: '/start' });
    assert.equal((await me(cookie)).json().tenant.alias, 'globex');
    m = (await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie } })).json();
    assert.equal(m.selectedOrganization, 'globex');

    // Formular mit Feld csrf → 303
    const form = await app.inject({ method: 'POST', url: '/auth/switch', cookies: { notes_sid: cookie }, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ org: 'acme', returnTo: '/katalog', csrf: m.csrfToken }).toString() });
    assert.equal(form.statusCode, 303, form.body);
    assert.equal(form.headers.location, '/katalog');
    assert.equal((await me(cookie)).json().tenant.alias, 'acme');

    // fremde Organisation (nicht in der Sitzung) abgelehnt, auch ohne Umweg über Keycloak
    const foreign = await switchTo(cookie, { org: 'initech' });
    assert.equal(foreign.statusCode, 403);
    assert.equal((await me(cookie)).json().tenant.alias, 'acme');

    // Rückfall: Organisation der Sitzung, aber nicht im aktuellen Token (Sitzung von vor organization:*) → neue Anmeldung
    // mit Vorwahl; angefordert werden wieder alle Organisationen
    op.user = { ...op.user, organization: ['acme'] };
    const narrow = (await readSession((await login()).cookie)).accessToken;
    await editSession(cookie, d => ({ ...d, accessToken: narrow }));
    assert.deepEqual(decodeClaims(narrow).organization, ['acme']);
    const relogin = await switchTo(cookie, { org: 'globex' });
    assert.equal(relogin.statusCode, 200, relogin.body);
    assert.equal(new URL(relogin.json().redirect).searchParams.get('scope'), 'openid profile email organization:*');
    assert.equal((await app.inject({ method: 'POST', url: '/auth/switch', payload: { org: 'acme' } })).statusCode, 401, 'ohne Sitzung');

    const viaLogin = await login({ org: 'acme' });
    assert.equal((await me(viaLogin.cookie)).json().tenant.alias, 'acme');
  });

  test('Aus der gewählten Organisation entfernt: nach der Erneuerung nicht mehr gewählt und nicht mehr angeboten', async () => {
    op.user = userClaims({ org: ['acme', 'globex'] });
    const { cookie } = await login();
    assert.equal((await switchTo(cookie, { org: 'globex' })).statusCode, 200);
    assert.equal((await me(cookie)).json().tenant.alias, 'globex');
    // In Keycloak aus globex entfernt: das erneuerte Token enthält globex nicht mehr
    op.refreshAs = { ...op.user, organization: ['acme'] };
    offset = 290_000;
    const r = await me(cookie);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().tenant.alias, 'acme', 'einzige verbliebene Organisation');
    assert.equal((await me(cookie, { 'x-tenant': 'globex' })).statusCode, 403, 'globex auch nicht per Header');
    const m = (await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie } })).json();
    assert.equal(m.selectedOrganization, null);
    assert.deepEqual(m.organizations, ['acme']);
    assert.equal((await switchTo(cookie, { org: 'globex' })).statusCode, 403, 'Wechsel zurück nicht mehr angeboten');
  });

  const authMe = async (cookie: string, tenant?: string) =>
    (await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie }, headers: tenant ? { 'x-tenant': tenant } : {} })).json();
  const rnd = () => randomBytes(3).toString('hex');
  /** Mandant mit Namen anlegen (wie nach dem ersten Zugriff und Umbenennen unter Verwalten). */
  const namedTenant = async (alias: string, name: string) => {
    const id = (await t.inspect.query<{ id: string }>('SELECT app.resolve_tenant($1, null, $1, true) AS id', [alias])).rows[0]!.id;
    await t.inspect.query('UPDATE notes.tenant SET name = $2 WHERE id = $1', [id, name]);
    return id;
  };

  test('Anmeldung fordert alle Organisationen an (organization:*); ?org= wählt nur vor (E1, T3)', async () => {
    op.user = userClaims({ org: ['acme', 'globex'] });
    const plain = await login();
    assert.equal(plain.authUrl.searchParams.get('scope'), 'openid profile email organization:*');
    let m = await authMe(plain.cookie);
    assert.deepEqual(m.organizations, ['acme', 'globex'], 'beide Organisationen wählbar, ohne Wahl beim Anmelden');
    assert.equal(m.tenant, null, 'mehrere ohne Vorwahl → Auswahlseite');
    assert.equal(m.selectedOrganization, null);

    const pre = await login({ org: 'globex' });
    assert.equal(pre.authUrl.searchParams.get('scope'), 'openid profile email organization:*', '?org= schränkt den Scope nicht ein');
    m = await authMe(pre.cookie);
    assert.deepEqual(m.organizations, ['acme', 'globex']);
    assert.equal(m.selectedOrganization, 'globex');
    assert.equal(m.tenant.alias, 'globex');
    assert.equal((await authMe(pre.cookie, 'acme')).tenant.alias, 'acme', 'die andere bleibt ohne neue Anmeldung erreichbar');

    // Alias nur nach dem Muster und nach ASCII-Kleinschreibung (Kelvin-Zeichen U+212A ist kein «k»)
    for (const bad of ['demo.ag', '\u212Acme', '-acme', 'a_b!'])
      assert.equal((await app.inject({ url: `/auth/login?org=${encodeURIComponent(bad)}` })).statusCode, 400, bad);
    const upper = await login({ org: 'GLOBEX' });
    assert.equal((await authMe(upper.cookie)).selectedOrganization, 'globex');
    assert.equal((await switchTo(upper.cookie, { org: '\u212Acme' })).statusCode, 400);

    const foreign = await login({ org: 'initech' });
    assert.equal((await authMe(foreign.cookie)).selectedOrganization, null, 'Vorwahl ausserhalb des Tokens wird keine Vorgabe');
  });

  test('/auth/login?idp=: Testanmeldung über einen Entra-Anbieter (kc_idp_hint, prompt=login), nur Aliasse entra-NNN (Nr. 104)', async () => {
    const r = await app.inject({ url: '/auth/login?idp=entra-007&returnTo=/verwalten/anmeldung/test' });
    assert.equal(r.statusCode, 302);
    const u = new URL(r.headers.location as string);
    assert.deepEqual([u.searchParams.get('kc_idp_hint'), u.searchParams.get('prompt')], ['entra-007', 'login']);
    const plain = new URL((await app.inject({ url: '/auth/login' })).headers.location as string);
    assert.deepEqual([plain.searchParams.get('kc_idp_hint'), plain.searchParams.get('prompt')], [null, null]);
    for (const bad of ['google', 'entra-1', 'entra-0001', 'entra-001&prompt=none'])
      assert.equal((await app.inject({ url: `/auth/login?idp=${encodeURIComponent(bad)}` })).statusCode, 422, bad);
  });

  test('/auth/entra/{alias}: Link der Einladung aus Entra ID startet die Anmeldung über den Anbieter; Code und Fremdparameter verworfen (Nr. 104, Teil 2)', async () => {
    const r = await app.inject({ url: '/auth/entra/entra-003?org=acme&code=abc&state=xyz' });
    assert.equal(r.statusCode, 302);
    const u = new URL(r.headers.location as string);
    assert.deepEqual([u.searchParams.get('kc_idp_hint'), u.searchParams.get('prompt'), u.searchParams.get('code')], ['entra-003', 'login', null]);
    assert.notEqual(u.searchParams.get('state'), 'xyz');
    assert.equal((await app.inject({ url: '/auth/entra/google' })).statusCode, 422);
    assert.equal((await app.inject({ url: '/auth/entra/entra-001?org=%E2%84%AAcme' })).statusCode, 302, 'ungültige Organisation wird ignoriert');
  });

  test('/auth/me: Organisation des Tabs per X-Tenant, mit Namen; fremde Organisation → kein Mandant, mit Grund (T1, T2)', async () => {
    const a = `tab-a-${rnd()}`, b = `tab-b-${rnd()}`, unused = `tab-n-${rnd()}`;
    await namedTenant(a, 'Alpha AG');
    const ta = await namedTenant(b, 'Beta GmbH').then(() => t.inspect.query<{ id: string }>('SELECT id FROM notes.tenant WHERE alias = $1', [a])).then(x => x.rows[0]!.id);
    await grant(t.runtime, ta, 'org:members', 'viewer');
    op.user = userClaims({ org: [a, b, unused] });
    const { cookie } = await login({ org: a });

    // zwei Tabs derselben Sitzung: jeder erhält seine Organisation mit Namen
    let m = await authMe(cookie, a);
    assert.deepEqual(m.tenant && { alias: m.tenant.alias, name: m.tenant.name }, { alias: a, name: 'Alpha AG' });
    assert.ok(m.permissions.includes('note:read'));
    m = await authMe(cookie, b);
    assert.deepEqual(m.tenant && { alias: m.tenant.alias, name: m.tenant.name }, { alias: b, name: 'Beta GmbH' });
    assert.equal(m.selectedOrganization, a, 'Vorgabe der Sitzung bleibt');
    assert.equal((await authMe(cookie)).tenant.alias, a, 'ohne X-Tenant die Vorgabe');
    // Namen der wählbaren Organisationen; ohne Mandant in der Plattform der Alias
    assert.deepEqual(m.organizationNames, { [a]: 'Alpha AG', [b]: 'Beta GmbH', [unused]: unused });
    assert.equal((await t.inspect.query('SELECT count(*) FROM notes.tenant WHERE alias = $1', [unused])).rows[0].count, '0', 'Namen legen keinen Mandanten an');

    // Organisation nicht im Token: gleiche Form wie ohne Wahl (tenant null, Grund), keine Daten einer anderen
    const r = await app.inject({ url: '/auth/me', cookies: { notes_sid: cookie }, headers: { 'x-tenant': 'initech' } });
    assert.equal(r.statusCode, 200, r.body);
    m = r.json();
    assert.equal(m.tenant, null);
    assert.match(m.tenantError, /initech/);
    assert.deepEqual([m.roles, m.permissions], [[], []]);
    assert.ok(m.csrfToken && m.organizations.includes(a));

    // aus der Organisation entfernt (noch im Token): ebenso, mit dem Grund aus dem Resolver
    const tenantId = (await t.inspect.query('SELECT id FROM notes.tenant WHERE alias = $1', [b])).rows[0].id as string;
    await t.inspect.query("UPDATE notes.principal SET removed_at = now() + interval '1 hour' WHERE tenant_id = $1 AND subject = $2", [tenantId, op.user.sub]);
    n.iam.resolver.forgetPrincipal(tenantId, String(op.user.sub));
    m = await authMe(cookie, b);
    assert.equal(m.tenant, null);
    assert.match(m.tenantError, /entfernt/);
    assert.equal((await authMe(cookie, a)).tenant.alias, a, 'andere Organisation unberührt');
  });

  test('Links ohne Header (Downloads, Bilder): ?x-tenant= wählt die Organisation des Tabs, nur bei GET, vor der Schemaprüfung entfernt (T1)', async () => {
    op.user = userClaims({ org: ['acme', 'globex'] });
    const { cookie } = await login({ org: 'acme' });
    const get = (url: string) => app.inject({ url, cookies: { notes_sid: cookie } });
    let r = await get('/v1/echo?delimiter=comma&x-tenant=globex');
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { tenant: 'globex', query: { delimiter: 'comma' } });
    assert.equal((await get('/v1/echo')).json().tenant, 'acme', 'ohne Parameter die Vorgabe');
    r = await get('/v1/echo?x-tenant=initech');
    assert.equal(r.statusCode, 403, 'nicht im Token: der Resolver weist ab');
    // Header geht vor; bei Schreibanfragen gilt der Parameter nicht
    assert.equal((await app.inject({ url: '/v1/echo?x-tenant=globex', cookies: { notes_sid: cookie }, headers: { 'x-tenant': 'acme' } })).json().tenant, 'acme');
    const csrf = await csrfOf(cookie);
    const post = await app.inject({ method: 'POST', url: '/v1/echo?x-tenant=globex', cookies: { notes_sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: {} });
    assert.equal(post.json().tenant, 'acme');
  });

  test('/auth/switch setzt nur die Vorgabe der Sitzung: ein anderer Tab liest und schreibt weiter in seiner Organisation (T1)', async () => {
    op.user = userClaims({ org: ['acme', 'globex'] });
    const { cookie } = await login({ org: 'acme' });
    // Tab B wechselt nach globex
    const sw = await switchTo(cookie, { org: 'globex', returnTo: '/' });
    assert.equal(sw.statusCode, 200, sw.body);
    assert.deepEqual(sw.json(), { redirect: '/' }, 'ohne neue Anmeldung');
    const csrf = await csrfOf(cookie);
    // Tab A sendet weiter X-Tenant acme: /auth/me und Schreibanfragen bleiben in acme
    assert.equal((await authMe(cookie, 'acme')).tenant.alias, 'acme');
    const write = await app.inject({ method: 'POST', url: '/v1/echo', cookies: { notes_sid: cookie }, headers: { 'x-tenant': 'acme', 'x-csrf-token': csrf }, payload: {} });
    assert.equal(write.statusCode, 200, write.body);
    assert.equal(write.json().tenant, 'acme');
    // ohne X-Tenant (neuer Tab, API-Aufruf mit dem Cookie) gilt die neue Vorgabe
    const plain = await app.inject({ method: 'POST', url: '/v1/echo', cookies: { notes_sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: {} });
    assert.equal(plain.json().tenant, 'globex');
    const m = await authMe(cookie);
    assert.deepEqual([m.selectedOrganization, m.tenant.alias, m.organizations], ['globex', 'globex', ['acme', 'globex']]);
  });

  test('Nach jeder Erneuerung folgt die Liste der Organisationen dem Token: Austritt, neue Mitgliedschaft (T6)', async () => {
    op.user = userClaims({ org: ['acme', 'globex'] });
    const { cookie } = await login({ org: 'acme' });
    assert.deepEqual((await authMe(cookie)).organizations, ['acme', 'globex']);
    // aus globex (nicht die Vorgabe) entfernt, in initech aufgenommen
    op.refreshAs = { ...op.user, organization: ['acme', 'initech'] };
    offset = 290_000;
    const m = await authMe(cookie);
    assert.deepEqual(m.organizations, ['acme', 'initech']);
    assert.equal(m.selectedOrganization, 'acme', 'Vorgabe bleibt, solange sie im Token steht');
    assert.equal((await authMe(cookie, 'globex')).tenant, null, 'globex auch nicht per X-Tenant');
    assert.equal((await switchTo(cookie, { org: 'globex' })).statusCode, 403, 'kein Wechsel mehr angeboten');
    assert.equal((await authMe(cookie, 'initech')).tenant.alias, 'initech', 'neue Mitgliedschaft ohne neue Anmeldung');
  });

  test('Wechsel schreibt ein inzwischen rotiertes Refresh Token nicht zurück (andere Instanz)', async () => {
    op.user = userClaims({ org: ['acme', 'globex'] });
    const { cookie } = await login();
    const id = sessionId(cookie);
    const stale = { id, csrf: '', data: await readSession(cookie), createdAt: 0, expiresAt: 0, lastSeenAt: 0 } satisfies Session;
    await editSession(cookie, d => ({ ...d, refreshToken: 'rotiert-von-instanz-b' }));
    assert.equal(await bff.switchOrg(stale, 'globex'), true);
    const now = await readSession(cookie);
    assert.deepEqual([now.org, now.refreshToken], ['globex', 'rotiert-von-instanz-b']);
  });

  test('Backchannel-Logout: events[backchannel-logout] muss ein Objekt sein (nicht null)', async () => {
    const sub = randomUUID();
    op.user = userClaims({ sub, org: 'acme' });
    const a = await login();
    const r = await app.inject({ method: 'POST', url: '/auth/backchannel-logout', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `logout_token=${await op.logoutToken({ sub, events: { [BCL_EVENT]: null } })}` });
    assert.deepEqual([r.statusCode, r.json().error], [400, 'invalid_request']);
    assert.equal((await me(a.cookie)).statusCode, 200, 'Sitzung bleibt');
  });

  test('Backchannel-Logout: scheitert das Löschen, darf Keycloak denselben Logout-Token wiederholen', async () => {
    let fail = true;
    const db = { query: async (sql: string, params?: unknown[]) => { if (fail && sql.startsWith('DELETE')) { fail = false; throw new Error('Verbindung verloren'); } return t.runtime.query(sql, params); } };
    const replay = new MemoryReplayStore();
    const b = new Bff(n.iam.cfg, db as never, n.iam.verifier.provider, { schema: 'notes', product: 'notes', replay, log: { warn() {}, error() {} } });
    const sub = randomUUID();
    op.user = userClaims({ sub, org: 'acme' });
    const a = await login();
    const tok = await op.logoutToken({ sub });
    await assert.rejects(b.backchannelLogout(tok), /Verbindung verloren/);
    assert.equal((await me(a.cookie)).statusCode, 200, 'noch angemeldet');
    assert.equal(await b.backchannelLogout(tok), 1, 'Wiederholung gilt');
    assert.equal((await me(a.cookie)).statusCode, 401);
    await assert.rejects(b.backchannelLogout(tok), /bereits verwendet/, 'danach Replay-Schutz');
  });

  test('Sitzungscookies nur mit Modul bff (z. B. nicht im MCP-Dienst)', async () => {
    const { cookie } = await login();
    const mcp = await notesApp({ db: t.runtime, issuer: op.issuer, env, plugin: { modules: ['account', 'access'] } });
    try {
      assert.ok(mcp.iam.bff, 'BFF gebaut, aber Modul nicht aktiv');
      assert.equal((await mcp.app.inject({ url: '/v1/me', cookies: { notes_sid: cookie } })).statusCode, 401);
      assert.equal((await me(cookie)).statusCode, 200, 'in der App mit Modul bff angemeldet');
    } finally { await mcp.app.close(); }
  });
});
