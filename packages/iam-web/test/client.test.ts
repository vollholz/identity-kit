import createClient from 'openapi-fetch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError, authFetch, describeError, fieldErrorText, iamFetch, iamMiddleware, ifMatch, loginUrl, onForbidden, onSessionExpired,
  reportStatus, setCsrfToken, setTenant, tenantHeaders, withQuery, withTenant,
} from '../src/index.ts';
import type { paths } from './fixtures/openapi-iam.d.ts';
import { json, mockFetch } from './utils.ts';

afterEach(() => { vi.unstubAllGlobals(); setCsrfToken(null); setTenant(null); });

/** Eigener Client einer App (wie Assets: openapi-fetch) mit der Middleware des Pakets. */
function appClient() {
  const api = createClient<paths>({ baseUrl: 'http://localhost', fetch: (req: Request) => globalThis.fetch(req) });
  api.use(iamMiddleware);
  return api;
}

describe('Client', () => {
  it('sendet das CSRF-Token nur bei schreibenden Aufrufen', async () => {
    setCsrfToken('tok-1');
    const { calls } = mockFetch({ 'GET /v1/roles': () => json({ items: [] }), 'POST /v1/roles': () => json({ key: 'c-x' }, 201) });
    await iamFetch('/v1/roles');
    await iamFetch('/v1/roles', { method: 'POST', body: { label: 'X', permissions: [] } });
    expect(calls[0]!.headers.get('x-csrf-token')).toBeNull();
    expect(calls[1]!.headers.get('x-csrf-token')).toBe('tok-1');
    expect(calls[1]!.headers.get('content-type')).toBe('application/json');
    expect(await calls[1]!.json()).toEqual({ label: 'X', permissions: [] });
  });

  it('sendet die Organisation des Tabs als X-Tenant bei jeder Anfrage an /v1 und /auth', async () => {
    const { calls } = mockFetch({ 'GET /v1/roles': () => json({ items: [] }), 'POST /v1/acl': () => json({}, 201), 'GET /auth/me': () => json({}) });
    await iamFetch('/v1/roles');
    expect(calls[0]!.headers.get('x-tenant')).toBeNull();
    setTenant('muster');
    setCsrfToken('tok-1');
    await iamFetch('/v1/roles');
    await iamFetch('/v1/acl', { method: 'POST', body: {} });
    await authFetch('/auth/me');
    expect(calls.slice(1).map(c => c.headers.get('x-tenant'))).toEqual(['muster', 'muster', 'muster']);
    expect(tenantHeaders()).toEqual({ 'X-CSRF-Token': 'tok-1', 'X-Tenant': 'muster' });
    expect(tenantHeaders('GET')).toEqual({ 'X-Tenant': 'muster' });
  });

  it('übernimmt einen selbst gesetzten X-Tenant (Plattformansicht) und das CSRF-Token bei /auth', async () => {
    setTenant('demo');
    setCsrfToken('tok-1');
    const { calls } = mockFetch({ 'POST /auth/switch': () => json({ redirect: '/' }) });
    await authFetch('/auth/switch', { method: 'POST', headers: { 'X-Tenant': 'muster' } });
    expect(calls[0]!.headers.get('x-tenant')).toBe('muster');
    expect(calls[0]!.headers.get('x-csrf-token')).toBe('tok-1');
  });

  it('setzt Suchparameter, Listen wiederholt, leere weggelassen', async () => {
    const { calls } = mockFetch({ 'GET /v1/acl/effective': () => json({}) });
    await iamFetch('/v1/acl/effective', { query: { roles: ['viewer', 'editor'], groups: '', principal: undefined, simulate: true } });
    expect(new URL(calls[0]!.url).search).toBe('?roles=viewer&roles=editor&simulate=true');
    expect(withQuery('/x?a=1', { b: 2 })).toBe('/x?a=1&b=2');
    expect(withQuery('/x', {})).toBe('/x');
  });

  it('liefert bei 204 nichts und setzt If-Match aus der Version', async () => {
    const { calls } = mockFetch({ 'DELETE /v1/roles/c-x': () => new Response(null, { status: 204 }) });
    await expect(iamFetch('/v1/roles/c-x', { method: 'DELETE', headers: ifMatch(3) })).resolves.toBeUndefined();
    expect(calls[0]!.headers.get('if-match')).toBe('W/"3"');
  });

  it('wirft problem+json als ApiError mit Feldfehlern und Referenz', async () => {
    mockFetch({ 'POST /v1/roles': () => json({ type: 'x', title: 'Ungültige Eingabe', status: 422, errors: [{ path: '/permissions/0', message: 'gibt es nicht' }] }, 422, { 'x-request-id': 'req-9' }) });
    const e = (await iamFetch('/v1/roles', { method: 'POST', body: {} }).catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(422);
    expect(e.title).toBe('Ungültige Eingabe');
    expect(e.requestId).toBe('req-9');
    expect(fieldErrorText(e.fieldErrors[0]!, { 0: 'Erstes Recht' })).toBe('Erstes Recht: gibt es nicht');
    expect(fieldErrorText({ path: '/label', message: 'fehlt' })).toBe('label: fehlt');
  });

  it('meldet 401 als abgelaufene Sitzung und 403 zur Prüfung der Organisation', async () => {
    mockFetch({ 'GET /v1/roles': () => json({ title: 'Nicht angemeldet', status: 401 }, 401), 'GET /v1/acl': () => json({ title: 'Kein Mitglied mehr', status: 403 }, 403) });
    const expired = vi.fn(), forbidden = vi.fn();
    const off1 = onSessionExpired(expired), off2 = onForbidden(forbidden);
    await iamFetch('/v1/roles').catch(() => undefined);
    await iamFetch('/v1/acl').catch(() => undefined);
    off1(); off2();
    await iamFetch('/v1/roles').catch(() => undefined);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it('meldet bei /auth nichts (die Sitzung wertet 401 selbst aus)', async () => {
    mockFetch({ 'GET /auth/me': () => json({ title: 'Nicht angemeldet', status: 401 }, 401) });
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    expect((await authFetch('/auth/me')).status).toBe(401);
    off();
    expect(expired).not.toHaveBeenCalled();
  });

  it('übersetzt Netzwerkfehler verständlich und lässt Abbrüche durch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const e = await iamFetch('/v1/roles').catch((x: unknown) => x);
    expect(describeError(e)).toMatchObject({ title: 'Keine Verbindung zum Server', status: 0 });
    await expect(authFetch('/auth/me')).rejects.toMatchObject({ status: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('abgebrochen', 'AbortError'); }));
    await expect(iamFetch('/v1/roles')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('behält Status und Referenz, wenn der Fehlerkörper kein Objekt ist (null, Liste, Text)', async () => {
    for (const body of ['null', '[1]', '42', 'kaputt']) {
      mockFetch({ 'GET /v1/roles': () => new Response(body, { status: 502, headers: { 'content-type': 'application/json', 'x-request-id': 'req-5' } }) });
      const e = await iamFetch('/v1/roles').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect(e).toMatchObject({ status: 502, title: 'Der Server ist nicht erreichbar.', requestId: 'req-5' });
    }
  });

  it('nutzt Standardtexte, wenn der Server keinen Titel liefert', () => {
    expect(new ApiError(403, {}).title).toBe('Dafür fehlt dir das Recht.');
    expect(new ApiError(412, {}).title).toBe('Inzwischen von jemand anderem geändert.');
    expect(new ApiError(418, {}).title).toBe('Fehler 418');
    expect(describeError(new Error('kaputt'))).toEqual({ title: 'Unerwarteter Fehler', detail: 'kaputt', fields: [] });
  });

  it('hängt die Organisation an Links ohne eigene Header und baut die Anmeldeadresse', () => {
    expect(withTenant('/v1/x')).toBe('/v1/x');
    setTenant('mu ster');
    expect(withTenant('/v1/x')).toBe('/v1/x?x-tenant=mu%20ster');
    expect(withTenant('/v1/x?a=1')).toBe('/v1/x?a=1&x-tenant=mu%20ster');
    expect(withTenant('/v1/x#page=2')).toBe('/v1/x?x-tenant=mu%20ster#page=2');
    expect(withTenant('/v1/x?a=1#page=2?b')).toBe('/v1/x?a=1&x-tenant=mu%20ster#page=2?b');
    expect(loginUrl('/verwalten?a=1#b')).toBe('/auth/login?returnTo=%2Fverwalten%3Fa%3D1%23b');
    expect(loginUrl('/', 'muster')).toBe('/auth/login?returnTo=%2F&org=muster');
  });
});

describe('Rückkanal für eigene Clients der App', () => {
  it('iamMiddleware setzt Header, wirft ApiError und meldet 401/403 (openapi-fetch)', async () => {
    setTenant('demo');
    setCsrfToken('tok-1');
    const { calls } = mockFetch({
      'GET /v1/admin/status': () => json({ title: 'Kein Mitglied mehr', status: 403 }, 403),
      'POST /v1/roles': () => json({ title: 'Nicht angemeldet', status: 401 }, 401),
    });
    const api = appClient();
    const expired = vi.fn(), forbidden = vi.fn();
    const off1 = onSessionExpired(expired), off2 = onForbidden(forbidden);
    const e1 = await api.GET('/v1/admin/status').catch((x: unknown) => x);
    const e2 = await api.POST('/v1/roles', { body: { label: 'X', permissions: [] } }).catch((x: unknown) => x);
    off1(); off2();
    expect(e1).toBeInstanceOf(ApiError);
    expect(e1).toMatchObject({ status: 403, title: 'Kein Mitglied mehr' });
    expect(e2).toBeInstanceOf(ApiError);
    expect(forbidden).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(calls[0]!.headers.get('x-tenant')).toBe('demo');
    expect(calls[0]!.headers.get('x-csrf-token')).toBeNull();
    expect(calls[1]!.headers.get('x-csrf-token')).toBe('tok-1');
    expect(calls[1]!.headers.get('accept')).toContain('application/json');
  });

  it('iamMiddleware übersetzt Netzwerkfehler und lässt Erfolge durch', async () => {
    mockFetch({ 'GET /v1/roles': () => json({ items: [], customPermissions: [], maxCustom: 50 }) });
    const ok = await appClient().GET('/v1/roles');
    expect(ok.data).toEqual({ items: [], customPermissions: [], maxCustom: 50 });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const e = await appClient().GET('/v1/roles').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 0 });
  });

  it('reportStatus meldet nur 401 und 403', () => {
    const expired = vi.fn(), forbidden = vi.fn();
    const off1 = onSessionExpired(expired), off2 = onForbidden(forbidden);
    for (const s of [200, 400, 401, 403, 404, 500]) reportStatus(s);
    off1(); off2();
    expect(expired).toHaveBeenCalledTimes(1);
    expect(forbidden).toHaveBeenCalledTimes(1);
  });
});
