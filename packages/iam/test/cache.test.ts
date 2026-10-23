/**
 * Zwischenspeicher und Wirkungszeiten (Spezifikation Kap. 6.2, 7.9): Mandant 60 s, Principal 5 min, «Nur Entra» je
 * Domäne 60 s – auf anderen Instanzen; die eigene Instanz vergisst sofort (`forget…`). Die Freigabe eines Clients (Tupel
 * an org) wirkt sofort auf allen Instanzen (`acl_version`). Die Uhr (Date) ist gestellt; die Datenbank läuft echt.
 */
import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import { claimsFor } from '@vollholz/iam-testkit';
import { AccessService, fullView } from '../src/access.ts';
import { withTenant } from '../src/db.ts';
import { PrincipalResolver } from '../src/principal.ts';
import { fails, verified } from './support/principal.ts';
import { testConfig } from './support/config.ts';
import { productDb, skipDb } from './support/db.ts';
import { notesModel } from './support/models.ts';

const skip = await skipDb();

describe('Zwischenspeicher des Resolvers', { skip }, () => {
  const db = productDb({ model: notesModel });
  let t: Awaited<ReturnType<typeof db.create>>;
  const c = claimsFor({ personClientId: 'notes-platform' });
  const resolver = () => new PrincipalResolver(t.runtime, testConfig('http://idp.test/realms/notes'), { schema: 'notes', access: new AccessService(t.runtime, { model: notesModel, schema: 'notes' }) });
  const tenantOf = async (alias: string) => (await t.runtime.query<{ id: string }>('SELECT app.resolve_tenant($1, null, $1, true) AS id', [alias])).rows[0]!.id;

  before(async () => { t = await db.create(); });
  after(async () => { await t?.drop(); mock.timers.reset(); });

  /** Zeit vorstellen: nur Date, Timer und Netzwerk laufen weiter. */
  const clock = () => { mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: Date.now() }); return (ms: number) => mock.timers.tick(ms); };

  test('Mandant: Sperre wirkt nach 60 s, sofort mit forgetTenant', async () => {
    const tick = clock(), r = resolver(), other = resolver();
    const v = () => verified(c.user({ org: 'cache-a', sub: 'u1' }));
    const id = (await r.resolve(v())).tenantId;
    await other.resolve(v());
    await t.inspect.query("UPDATE notes.tenant SET status = 'suspended' WHERE id = $1", [id]);
    assert.equal((await r.resolve(v())).tenantId, id, 'innerhalb von 60 s aus dem Zwischenspeicher');
    tick(59_000);
    assert.equal((await r.resolve(v())).tenantId, id);
    tick(2_000);
    await fails(r.resolve(v()), 403, 'Organisation nicht verfügbar');
    other.forgetTenant('CACHE-A');
    await fails(other.resolve(v()), 403, 'Organisation nicht verfügbar', 'forgetTenant (ASCII-Gross)');
  });

  test('Freigabe eines Clients: Tupel an org; Entzug wirkt sofort auf allen Instanzen (acl_version)', async () => {
    const r = resolver(), other = resolver();
    const id = await tenantOf('cache-b');
    const full = <T>(fn: (tx: import('../src/db.ts').Tx) => Promise<T>) => withTenant(t.runtime, { tenantId: id, settings: fullView(notesModel) }, fn);
    const v = () => verified(c.client({ clientId: 'sync', org: 'cache-b', scopes: ['notes:read'] }));
    await fails(r.resolve(v()), 403, 'Client nicht freigegeben', 'ohne Principal');
    const pid = (await full(tx => tx.query<{ id: string }>("INSERT INTO notes.principal (tenant_id, kind, subject, client_id, last_seen_at) VALUES ($1, 'client', 'sync', 'sync', NULL) RETURNING id", [id]))).rows[0]!.id;
    await fails(r.resolve(v()), 403, 'Client nicht freigegeben', 'Principal ohne Tupel');
    await full(tx => tx.query("INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type) VALUES ($1, $2, 'viewer', 'org')", [id, `client:${pid}`]));
    const p = await r.resolve(v()); await other.resolve(v());
    assert.deepEqual([p.kind, p.principalId, p.subjects], ['client', pid, [`client:${pid}`]]);
    assert.deepEqual((await full(tx => tx.query('SELECT last_scopes FROM notes.principal WHERE id = $1', [pid]))).rows[0].last_scopes, ['notes:read']);
    await full(tx => tx.query('DELETE FROM notes.authz_tuple WHERE subject = $1', [`client:${pid}`]));
    await fails(r.resolve(v()), 403, 'Client nicht freigegeben');
    await fails(other.resolve(v()), 403, 'Client nicht freigegeben', 'andere Instanz sofort');
    await full(tx => tx.query("INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type, expires_at) VALUES ($1, $2, 'viewer', 'org', now() - interval '1 second')", [id, `client:${pid}`]));
    await fails(r.resolve(v()), 403, 'Client nicht freigegeben', 'abgelaufenes Tupel');
  });

  test('Principal: Entfernen wirkt nach 5 min, sofort mit forgetPrincipal; Tokens von davor nie mehr', async () => {
    const tick = clock(), r = resolver(), other = resolver();
    const iat = Math.floor(Date.now() / 1000) - 10;
    const v = () => verified(c.user({ org: 'cache-c', sub: 'u-gone' }), iat);
    const p = await r.resolve(v());
    await other.resolve(v());
    await t.inspect.query('UPDATE notes.principal SET removed_at = now() WHERE id = $1', [p.principalId]);
    tick(299_000);
    assert.equal((await r.resolve(v())).principalId, p.principalId);
    tick(2_000);
    await fails(r.resolve(v()), 403, 'Kein Mitglied mehr');
    other.forgetPrincipal(p.tenantId, 'u-gone');
    await fails(other.resolve(v()), 403, 'Kein Mitglied mehr');
  });

  test('«Nur Entra»: neue Bindung einer Domäne wirkt nach 60 s, sofort mit forgetEntra', async () => {
    const tick = clock(), r = resolver();
    const id = await tenantOf('cache-d');
    const v = () => verified(c.user({ org: 'cache-d', email: 'a@fabrikam.ch' }));
    await r.resolve(v());
    await withTenant(t.runtime, { tenantId: id }, tx => tx.query(
      "INSERT INTO notes.entra_connection (tenant_id, entra_tenant_id, idp_alias, domains, stage) VALUES ($1, gen_random_uuid(), 'entra-007', '{fabrikam.ch}', 'enforced')", [id]));
    tick(59_000);
    assert.equal((await r.resolve(v())).tenantAlias, 'cache-d');
    tick(2_000);
    await fails(r.resolve(v()), 403, 'Anmeldung über Microsoft nötig');
    await withTenant(t.runtime, { tenantId: id }, tx => tx.query('DELETE FROM notes.entra_connection'));
    r.forgetEntra();
    assert.equal((await r.resolve(v())).tenantAlias, 'cache-d');
  });
});
