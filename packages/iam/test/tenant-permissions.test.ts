/**
 * Haken «Rechte je Organisation» (`createIam({ tenantPermissions })`) mit Datenbank: schränkt die Rechte im Principal
 * (`GET /v1/me`), im Katalog der Organisation und in der Entscheidung der Fachrouten ein, je Organisation; der
 * Zwischenspeicher gilt bis zur nächsten Version des Hakens; ohne Haken unverändert.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startMockIdp, type MockIdp } from '@vollholz/iam-testkit';
import type { TenantPermissions } from '../src/access.ts';
import { skipDb } from './support/db.ts';
import { claims, member, notesApp, notesDb, tenant, type NotesApp } from './support/http.ts';

const skip = await skipDb();

describe('Rechte je Organisation (Haken tenantPermissions)', { skip }, () => {
  const db = notesDb();
  let t: Awaited<ReturnType<typeof db.create>>, idp: MockIdp, n: NotesApp, plain: NotesApp;
  let demoId: string;
  const tok: Record<string, string> = {};
  // Haken der App: Rechte je Organisation in einer Map, Version als Zähler; Aufrufe gezählt
  const limits = new Map<string, string[] | null>();
  let version = 1;
  const calls = { version: 0, allowed: 0, tenants: [] as string[], inTenant: true };
  const tenantPermissions: TenantPermissions = {
    async version() { calls.version++; return String(version); },
    async allowed(tenantId, tx) {
      calls.allowed++; calls.tenants.push(tenantId);
      // Läuft in der Transaktion der Organisation
      const cur = (await tx.query<{ t: string }>("SELECT current_setting('app.tenant_id', true) AS t")).rows[0]!.t;
      if (cur !== tenantId) calls.inTenant = false;
      const l = limits.get(tenantId);
      return l === undefined || l === null ? null : new Set(l);
    },
  };

  const get = async (who: string, url: string, app = n) => {
    const r = await app.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok[who]}` } });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const me = async (who: string, app = n) => { const r = await get(who, '/v1/me', app); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const catalog = async (who: string, app = n) => { const r = await get(who, '/v1/authz/catalog', app); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

  before(async () => {
    t = await db.create();
    idp = await startMockIdp({ realm: 'notes', audience: 'notes-api' });
    await member(t.runtime, 'demo', 'anna', 'org-admin');
    await member(t.runtime, 'demo', 'dana', 'viewer');
    await member(t.runtime, 'other', 'otto', 'org-admin');
    demoId = await tenant(t.runtime, 'demo');
    limits.set(demoId, ['note:read', 'team:read']);
    n = await notesApp({ db: t.runtime, issuer: idp.issuer, tenantPermissions });
    plain = await notesApp({ db: t.runtime, issuer: idp.issuer });
    for (const sub of ['anna', 'dana']) tok[sub] = await idp.token(claims.user({ sub, org: 'demo' }));
    tok.otto = await idp.token(claims.user({ sub: 'otto', org: 'other' }));
  });
  after(async () => { await n?.app.close(); await plain?.app.close(); await idp?.close(); await t?.drop(); });

  test('Principal (/v1/me): nur die gelassenen Rechte; reservierte bleiben; andere Organisation ohne Einschränkung', async () => {
    const a = await me('anna');
    assert.ok(a.permissions.includes('note:read') && a.permissions.includes('team:read'));
    assert.ok(!a.permissions.includes('note:write') && !a.permissions.includes('view:read'), JSON.stringify(a.permissions));
    assert.ok(a.permissions.includes('members:admin') && a.permissions.includes('tenant:read'), 'reservierte Rechte bleiben');
    assert.ok(!a.somewhere.includes('view:read'));
    assert.deepEqual((await me('dana')).permissions.sort(), ['note:read', 'team:read', 'tenant:read']);
    const o = await me('otto');
    assert.ok(o.permissions.includes('view:write') && o.permissions.includes('note:write'), 'null: keine Einschränkung');
    assert.ok(calls.inTenant, 'allowed läuft im Mandantenkontext der Organisation');
  });

  test('Katalog der Organisation: nur die gelassenen Rechte, auch in Rollen und Scopes', async () => {
    const cat = await catalog('anna');
    assert.ok(!cat.permissions.some((p: { key: string }) => p.key === 'view:read' || p.key === 'note:write'));
    assert.ok(cat.permissions.some((p: { key: string }) => p.key === 'note:read'));
    assert.deepEqual(cat.roles.find((r: { key: string }) => r.key === 'editor').permissions, ['tenant:read', 'note:read', 'team:read', 'access:admin']);
    assert.ok(!cat.scopes.some((s: { permissions: string[] }) => s.permissions.includes('view:read')));
    assert.ok((await catalog('otto')).permissions.some((p: { key: string }) => p.key === 'view:read'));
  });

  test('Zwischenspeicher: ohne neue Version kein neuer Aufruf von allowed; neue Version wirkt sofort', async () => {
    await me('anna');
    const before = calls.allowed;
    await me('anna'); await catalog('anna');
    assert.equal(calls.allowed, before, 'gleiche Version: aus dem Zwischenspeicher');
    limits.set(demoId, ['note:read', 'note:write', 'view:read']);
    assert.ok(!(await me('anna')).permissions.includes('view:read'), 'ohne neue Version gilt der alte Stand');
    version++;
    const a = await me('anna');
    assert.ok(a.permissions.includes('view:read') && a.permissions.includes('note:write') && !a.permissions.includes('team:read'), JSON.stringify(a.permissions));
    assert.equal(calls.allowed, before + 1);
    assert.ok((await catalog('anna')).permissions.some((p: { key: string }) => p.key === 'view:read'));
    limits.set(demoId, null); version++;
    assert.ok((await me('anna')).permissions.includes('team:read'), 'null hebt die Einschränkung auf');
    limits.set(demoId, ['note:read', 'team:read']); version++;
  });

  test('Fachroute: Entscheidung mit dem eingeschränkten Modell (403 statt Zugriff)', async () => {
    const r = await get('anna', `/v1/folders/00000000-0000-4000-8000-000000000001`);
    assert.notEqual(r.status, 403, 'note:read gelassen');
    limits.set(demoId, ['team:read']); version++;
    const denied = await get('anna', `/v1/folders/00000000-0000-4000-8000-000000000001`);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.permission, 'note:read');
    limits.set(demoId, ['note:read', 'team:read']); version++;
  });

  test('modelIn (Transaktion der Organisation, z. B. Rollenwechsel): eingeschränkt wie load', async () => {
    const m = await n.iam.access.fullTx(demoId, tx => n.iam.access.modelIn(tx));
    assert.ok(m.isPermission('note:read') && !m.isPermission('view:read'));
    assert.deepEqual([...m.allowedPermissions!].sort(), ['note:read', 'team:read']);
    const free = await plain.iam.access.fullTx(demoId, tx => plain.iam.access.modelIn(tx));
    assert.equal(free.allowedPermissions, null);
  });

  test('ohne Haken: unverändert (alle Rechte der Rollen)', async () => {
    const a = await me('anna', plain);
    assert.ok(a.permissions.includes('view:read') && a.permissions.includes('note:write'));
    assert.ok((await catalog('anna', plain)).permissions.some((p: { key: string }) => p.key === 'view:read'));
  });
});
