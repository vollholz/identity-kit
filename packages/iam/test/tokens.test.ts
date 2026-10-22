/**
 * Token-Prüfung (Spezifikation Kap. 6.1; aus Assets test/platform/auth.test.ts und unit.test.ts, auf Ebene des
 * Verifiers): Signatur, Aussteller, Zielgruppe, Ablauf, nur Access Tokens, DPoP (RFC 9449) mit Replay-Schutz,
 * mTLS-gebundene Tokens (RFC 8705), unbekannte Bindung. Die HTTP-Fälle (Schema «DPoP», DPOP_MODE) folgen mit dem Plugin.
 */
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { claimsFor, dpopKey, startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import { HttpError } from '../src/errors.ts';
import { MemoryReplayStore } from '../src/state.ts';
import { normalizeHtu, OidcProvider, parseClientCert, TokenVerifier } from '../src/tokens.ts';
import { testConfig } from './support/config.ts';

/** Selbstsigniertes Client-Zertifikat (P-256) aus Assets, nur für Tests. */
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBkTCCATegAwIBAgIUVAra84SoY/XHw8mEbYjqxOzH48kwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSYXNzZXRzLXRlc3QtY2xpZW50MCAXDTI2MTAyMTEzMDMwMloY
DzIxMjYwOTI3MTMwMzAyWjAdMRswGQYDVQQDDBJhc3NldHMtdGVzdC1jbGllbnQw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARqj3msJyb16jI0lsTxZM1ryKO8Dlbc
Or8LOtEnHsyhcHCUqxTt27tZ2LRweL5tFx/Ctt9lIzFb6LqDHYdNyCWso1MwUTAd
BgNVHQ4EFgQUUhOOdKO7wT+eWxlla7RcUAlH8ewwHwYDVR0jBBgwFoAUUhOOdKO7
wT+eWxlla7RcUAlH8ewwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBF
AiB+tkUCeoLTED7fht7P4vhFdvOzO5Ji2zc2h6QYvdEEIwIhAIaGprQb34f4GRVx
C4dOM4ms2lr/aSboOV9rFsASsosw
-----END CERTIFICATE-----`;

const claims = claimsFor({ personClientId: 'notes-platform' });
const URL = 'http://api.test/v1/me';

describe('Token-Prüfung', () => {
  let idp: MockIdp, verifier: TokenVerifier;
  const verify = (token: string, o: { dpop?: string; method?: string; url?: string; cert?: string | null; audience?: string } = {}) =>
    verifier.verify(token, { audience: o.audience ?? 'notes-api', method: o.method ?? 'GET', url: o.url ?? URL, dpopHeader: o.dpop, clientCert: o.cert ?? null });
  const rejects = async (p: Promise<unknown>, status: number, re: RegExp, label: string) => {
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof HttpError, label);
      assert.equal(e.status, status, `${label}: ${e.message}`);
      assert.match(e.message, re, label);
      return true;
    });
  };

  before(async () => {
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    verifier = new TokenVerifier(new OidcProvider(idp.issuer), testConfig(idp.issuer), new MemoryReplayStore());
  });
  after(async () => { await idp?.close(); });

  test('gültiges Token: Claims, ohne Bindung', async () => {
    const v = await verify(await idp.token(claims.user({ org: 'acme', sub: 'u1' })));
    assert.equal(v.binding, 'none');
    assert.equal(v.claims.sub, 'u1');
  });

  test('falsche Zielgruppe, abgelaufen, fremder Schlüssel, fehlende Pflichtclaims → 401', async () => {
    await rejects(verify(await idp.token(claims.user({ org: 'acme' }), { aud: 'notes-mcp' })), 401, /Token ungültig/, 'Zielgruppe');
    await rejects(verify(await idp.token(claims.user({ org: 'acme' }), { expiresIn: '-10m' })), 401, /Token ungültig/, 'abgelaufen');
    await rejects(verify(await idp.token(claims.user({ org: 'acme' }), { kid: 'fremd' })), 401, /Token ungültig/, 'fremder Schlüssel');
    await rejects(verify('kein.jwt.token'), 401, /Token ungültig/, 'kaputt');
    const mcp = await idp.token(claims.user({ org: 'acme' }), { aud: 'notes-mcp' });
    assert.equal((await verify(mcp, { audience: 'notes-mcp' })).binding, 'none', 'eigene Zielgruppe je Dienst');
  });

  test('A7: nur Access Tokens (typ Bearer/DPoP oder ohne typ), unbekannte Bindung (cnf) → 401', async () => {
    for (const typ of ['ID', 'Refresh', 'Offline', 'Logout', 'Serialized-ID', 'logout+jwt', 42]) {
      await rejects(verify(await idp.token({ ...claims.user({ org: 'acme' }), typ })), 401, /kein Access Token/, `typ ${typ}`);
    }
    for (const typ of ['Bearer', 'bearer', undefined]) assert.equal((await verify(await idp.token({ ...claims.user({ org: 'acme' }), typ }))).binding, 'none', `typ ${typ}`);
    for (const cnf of [{ 'x5t#S512': 'x' }, { jwk: { kty: 'EC' } }, {}, { jkt: '' }, 'jkt', null]) {
      await rejects(verify(await idp.token({ ...claims.user({ org: 'acme' }), cnf })), 401, /Unbekannte Bindung/, `cnf ${JSON.stringify(cnf)}`);
    }
  });

  test('DPoP: falsche Methode, URL, Schlüssel, ath, Alter, ohne Proof und Replay werden abgelehnt', async () => {
    const k = await dpopKey(), other = await dpopKey();
    const tok = await idp.token({ ...claims.client({ clientId: 'importer', org: 'acme', roles: ['viewer'], scopes: ['notes:read'] }), typ: 'DPoP' }, { jkt: k.jkt });
    const cases: [string, string | undefined, RegExp][] = [
      ['Methode', await k.proof('POST', URL, tok), /htm/],
      ['URL', await k.proof('GET', 'http://api.test/v1/other', tok), /htu/],
      ['Schlüssel', await other.proof('GET', URL, tok), /cnf.jkt/],
      ['ath', await k.proof('GET', URL, 'anderes-token'), /ath/],
      ['alt', await k.proof('GET', URL, tok, { iat: Math.floor(Date.now() / 1000) - 3600 }), /zu alt/],
      ['ohne jti', await k.proof('GET', URL, tok, { jti: undefined }), /jti fehlt/],
      ['ohne Proof', undefined, /DPoP-Nachweis fehlt/],
      ['kein JWS', 'abc', /kein JWS/],
      ['htu keine URL', await k.proof('GET', 'keine url', tok), /htu/],
    ];
    for (const [label, dpop, re] of cases) await rejects(verify(tok, { dpop }), 401, re, label);
    const proof = await k.proof('GET', `${URL}?x=1#f`, tok);
    assert.equal((await verify(tok, { dpop: proof })).binding, 'dpop', 'htu ohne Query und Fragment');
    await rejects(verify(tok, { dpop: proof }), 401, /bereits verwendet/, 'Replay');
  });

  test('A6: mTLS – Zertifikat als PEM (URL-kodiert) oder DER/base64, Unlesbares → 401', async () => {
    const cert = new X509Certificate(CERT_PEM);
    const der = cert.raw.toString('base64');
    const c = claims.client({ clientId: 'mtls-client', org: 'acme', roles: ['viewer'], scopes: ['notes:read'] });
    const tok = await idp.token({ ...c, cnf: { 'x5t#S256': createHash('sha256').update(cert.raw).digest('base64url') } });
    for (const [label, h] of [['PEM, URL-kodiert (nginx)', encodeURIComponent(CERT_PEM)], ['DER, base64 (Caddy)', der], ['RFC 9440', `:${der}:`], ['PEM ohne Zeilenumbrüche', CERT_PEM.replace(/\n/g, ' ')]]) {
      assert.equal((await verify(tok, { cert: h })).binding, 'mtls', label);
    }
    const broken: [string, string][] = [['kaputte URL-Kodierung', '%E0%A4%A'], ['kein Zertifikat', 'abc$'], ['base64 ohne Zertifikat', 'AAAA'], ['PEM ohne Inhalt', encodeURIComponent('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')]];
    for (const [label, h] of broken) {
      await rejects(verify(tok, { cert: h }), 401, /Client-Zertifikat ungültig/, label);
    }
    await rejects(verify(tok), 401, /Client-Zertifikat fehlt/, 'ohne Zertifikat');
    const other = await idp.token({ ...c, cnf: { 'x5t#S256': createHash('sha256').update('anderes').digest('base64url') } });
    await rejects(verify(other, { cert: der }), 401, /passt nicht zum Token/, 'anderes Zertifikat');
    assert.equal(parseClientCert('AAAA'), null);
  });

  test('Discovery: Aussteller muss genau OIDC_ISSUER_URL sein, sonst 503; nicht erreichbar 503', async () => {
    const wrong = new TokenVerifier(new OidcProvider(`${idp.issuer}x`, async () => new Response(JSON.stringify({ issuer: idp.issuer, jwks_uri: '', token_endpoint: '', authorization_endpoint: '' }))), testConfig(idp.issuer));
    await rejects(wrong.verify(await idp.token(claims.user({ org: 'acme' })), { audience: 'notes-api', method: 'GET', url: URL }), 503, /falsch konfiguriert/, 'Issuer');
    const down = new OidcProvider(idp.issuer, async () => new Response('', { status: 500 }));
    await rejects(down.discovery(), 503, /nicht erreichbar/, 'Discovery');
    // Netzwerkfehler (DNS, Verbindung, Zeitüberschreitung): 503 statt 401, sonst gelten alle als nicht angemeldet
    const offline = new TokenVerifier(new OidcProvider(idp.issuer, async () => { throw new TypeError('fetch failed'); }), testConfig(idp.issuer));
    await rejects(offline.verify(await idp.token(claims.user({ org: 'acme' })), { audience: 'notes-api', method: 'GET', url: URL }), 503, /nicht erreichbar/, 'Netzwerk');
    const garbled = new OidcProvider(idp.issuer, async () => new Response('<html>'));
    await rejects(garbled.discovery(), 503, /nicht erreichbar/, 'kein JSON');
    const hanging = new OidcProvider(idp.issuer, (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))), 50);
    await rejects(hanging.discovery(), 503, /nicht erreichbar/, 'Zeitlimit');
  });

  test('Discovery: gleichzeitige Abfragen teilen sich einen Abruf; bei Ausfall gilt die bisherige weiter', async () => {
    let calls = 0, fail = false;
    const prov = new OidcProvider(idp.issuer, async (u, init) => { calls++; if (fail) throw new TypeError('fetch failed'); return fetch(u, init); });
    const [a, b] = await Promise.all([prov.discovery(), prov.discovery()]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    fail = true;
    (prov as unknown as { fetchedAt: number }).fetchedAt = 0;
    assert.equal(await prov.discovery(), a, 'alte Discovery bei Fehler');
    assert.equal(calls, 2);
    await rejects(new OidcProvider(idp.issuer, async () => { throw new TypeError('fetch failed'); }).discovery(), 503, /nicht erreichbar/, 'ohne bisherige');
  });
});

test('htu ohne Query und Fragment, Host case-insensitiv', () => {
  assert.equal(normalizeHtu('https://API.example.ch/v1/x?a=1#f'), 'https://api.example.ch/v1/x');
});
