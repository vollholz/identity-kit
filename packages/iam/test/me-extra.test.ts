/**
 * Haken `meExtra` (`createIam({ meExtra })`): app-eigene Angaben als `extra` in `GET /v1/me` (und `/auth/me`, gleicher
 * Weg), in der Transaktion der Anfrage im Mandantenkontext; ohne Haken `extra: {}`. Beispiel: aktive Module eines
 * eigenen Modulkonzepts der App.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import type { MeExtra } from '../src/iam.ts';
import { skipDb } from './support/db.ts';
import { claims, member, notesApp, notesDb, tenant, type NotesApp } from './support/http.ts';

const skip = await skipDb();

describe('Zusatzfelder der App in /v1/me (Haken meExtra)', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp, plain: NotesApp;
  let demoId: string;
  const tok: Record<string, string> = {};
  const seen: { tenant: string | null; principal: string }[] = [];
  const meExtra: MeExtra = async (tx, p) => {
    seen.push({ tenant: (await tx.query<{ t: string }>("SELECT current_setting('app.tenant_id', true) AS t")).rows[0]!.t, principal: p.principalId });
    return { modules: p.tenantAlias === 'demo' ? ['kern', 'zeit'] : ['kern'], nested: { a: 1, b: [true, null] } };
  };
  const me = async (who: string, app = n) => {
    const r = await app.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tok[who]}` } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    await member(t.runtime, 'demo', 'anna', 'org-admin');
    await member(t.runtime, 'other', 'otto', 'org-admin');
    demoId = await tenant(t.runtime, 'demo');
    n = await notesApp({ db: t.runtime, issuer: idp.issuer, meExtra });
    plain = await notesApp({ db: t.runtime, issuer: idp.issuer });
    tok.anna = await idp.token(claims.user({ sub: 'anna', org: 'demo' }));
    tok.otto = await idp.token(claims.user({ sub: 'otto', org: 'other' }));
  });
  after(async () => { await n?.app.close(); await plain?.app.close(); await idp?.close(); await t?.drop(); });

  test('extra aus dem Haken, je Organisation, im Mandantenkontext; beliebige JSON-Werte', async () => {
    const a = await me('anna');
    assert.deepEqual(a.extra, { modules: ['kern', 'zeit'], nested: { a: 1, b: [true, null] } });
    assert.deepEqual((await me('otto')).extra.modules, ['kern']);
    assert.equal(seen[0]!.tenant, demoId, 'Transaktion im Mandanten der Anfrage');
    assert.equal(seen[0]!.principal, a.principal.id);
  });

  test('ohne Haken: extra leer', async () => {
    assert.deepEqual((await me('anna', plain)).extra, {});
  });

  test('OpenAPI: extra als offenes Objekt in ApiMe dokumentiert', async () => {
    const doc = (await n.app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
    const extra = JSON.stringify(doc).match(/"extra":\{[^}]*Haken `meExtra`[^}]*\}/);
    assert.ok(extra, 'extra mit Beschreibung');
    assert.match(extra![0], /"type":"object"/);
  });
});
