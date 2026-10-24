/**
 * Principal (Spezifikation Kap. 4, 6.2): Organisation aus dem Token, Wahl, Person oder Maschinen-Client, Subjekte
 * (Person, Gruppen aus Entra, «Alle Mitglieder»; Client), keine Rollen aus dem Token, Freigabe von Clients über Tupel an
 * org, Austritt, Bindung an die ID der Organisation, «Nur Entra».
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { claimsFor } from '@vollholz/iam-testkit';
import { withTenant } from '../src/db.ts';
import type { HttpError } from '../src/errors.ts';
import { AccessService, fullView } from '../src/access.ts';
import { groupsFromClaims, isClient, isServiceAccount, orgAlias, orgsFromClaims, PrincipalResolver } from '../src/principal.ts';
import { testConfig } from './support/config.ts';
import { productDb, skipDb } from './support/db.ts';
import { notesModel } from './support/models.ts';
import { fails, verified } from './support/principal.ts';

const skip = await skipDb();
const G1 = '0B6F2F7E-4C1D-4D2B-9A55-1F0C7C2D9E11', G2 = '1c7a3e8f-5d2e-4e3c-8b66-2a1d8d3e0f22';

describe('Claims', () => {
  test('Organisationen als Liste, Objekt oder Text', () => {
    assert.deepEqual(orgsFromClaims({ organization: ['a', 'b'] }, 'organization').map(o => o.alias), ['a', 'b']);
    assert.deepEqual(orgsFromClaims({ organization: { a: { id: 'x' } } }, 'organization'), [{ alias: 'a', id: 'x' }]);
    assert.deepEqual(orgsFromClaims({ organization: 'a' }, 'organization').map(o => o.alias), ['a']);
    assert.deepEqual(orgsFromClaims({ organization: 42 }, 'organization'), []);
  });

  test('Gruppen aus Entra: nur Objekt-IDs (GUID), klein, ohne Doppelte; Pfade von Keycloak-Gruppen zählen nicht', () => {
    assert.deepEqual(groupsFromClaims({ groups: [G1, G2, G1.toLowerCase(), '/orgs/acme/editor', 'Abteilung', 42] }, 'groups'), [G1.toLowerCase(), G2]);
    assert.deepEqual(groupsFromClaims({}, 'groups'), []);
  });

  test('fremder Client mit Personendaten gilt als Maschinen-Client; Service Account erkannt', () => {
    const person = { azp: 'fremd', preferred_username: 'dora', email: 'd@x.ch', resource_access: { 'notes-platform': { roles: ['org-admin'] } } };
    assert.equal(isClient(person, ['notes-platform']), true, 'fremder Client: Freigabe und Scope-Grenze wie für Maschinen');
    assert.equal(isServiceAccount(person), false);
    assert.equal(isServiceAccount({ azp: 'import', preferred_username: 'service-account-import' }), true);
  });

  test('Alias der Organisation: nur ASCII klein geschrieben, sonst ungültig (Kelvin-Zeichen)', () => {
    assert.equal(orgAlias('acme'), 'acme');
    assert.equal(orgAlias('ACME_1-x'), 'acme_1-x');
    for (const bad of ['Kcme', 'a.b', '-acme', '', 'x'.repeat(64), 'acme ', 'ac/me', 'ı', 42]) assert.equal(orgAlias(bad), null, JSON.stringify(bad));
    assert.equal('Kcme'.toLowerCase(), 'kcme', 'toLowerCase() faltet das Kelvin-Zeichen');
  });

  test('Person oder Maschinen-Client: Personen nur über die Clients der Plattform (azp)', () => {
    const persons = ['notes-platform', 'notes-mcp'];
    assert.equal(isClient({ azp: 'notes-platform', email: 'a@b.ch', given_name: 'A' }, persons), false);
    assert.equal(isClient({ azp: 'notes-mcp', email: 'a@b.ch' }, persons), false);
    assert.equal(isClient({ azp: 'import', sub: 'x' }, persons), true, 'Service Account ohne profile/service_account-Scope');
    assert.equal(isClient({ azp: 'import', email: 'a@b.ch', given_name: 'A' }, persons), true, 'fremder Client mit Personendaten');
    assert.equal(isClient({ azp: 'notes-platform', preferred_username: 'service-account-x' }, persons), true);
  });
});

describe('Resolver gegen PostgreSQL', { skip }, () => {
  const db = productDb({ model: notesModel });
  let t: Awaited<ReturnType<typeof db.create>>;
  let resolver: PrincipalResolver;
  const c = claimsFor({ personClientId: 'notes-platform' });
  const access = () => new AccessService(t.runtime, { model: notesModel, schema: 'notes' });
  /** Client freigeben: Principal (subject = Client-ID) und Tupel `client:<id> editor org`. */
  const grant = async (alias: string, clientId: string) => {
    const id = (await t.runtime.query<{ id: string }>('SELECT app.resolve_tenant($1, null, $1, true) AS id', [alias])).rows[0]!.id;
    await withTenant(t.runtime, { tenantId: id, settings: fullView(notesModel) }, async tx => {
      const pid = (await tx.query<{ id: string }>("INSERT INTO notes.principal AS p (tenant_id, kind, subject, client_id, last_seen_at) VALUES ($1, 'client', $2, $2, NULL) ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET client_id = p.client_id RETURNING id", [id, clientId])).rows[0]!.id;
      await tx.query("INSERT INTO notes.authz_tuple (tenant_id, subject, relation, object_type) VALUES ($1, $2, 'editor', 'org') ON CONFLICT DO NOTHING", [id, `client:${pid}`]);
    });
    return id;
  };
  const tenantCount = async (alias: string) => (await t.inspect.query('SELECT count(*)::int AS n FROM notes.tenant WHERE alias = $1', [alias])).rows[0].n;

  before(async () => {
    t = await db.create();
    resolver = new PrincipalResolver(t.runtime, testConfig('http://idp.test/realms/notes'), { schema: 'notes', access: access() });
  });
  after(async () => { await t?.drop(); });

  test('Person: Mandant just in time, keine Rollen aus dem Token, Subjekte mit Gruppen aus Entra, Principal gespiegelt', async () => {
    const p = await resolver.resolve(verified({ ...c.user({ org: 'acme', sub: 'u1', name: 'Anna', email: 'anna@acme.ch', groups: [G1, '/orgs/acme/editor'] }), resource_access: { 'notes-platform': { roles: ['org-admin'] } }, realm_access: { roles: ['pa', 'platform-admin'] } }));
    assert.deepEqual([p.kind, p.tenantAlias, p.groups, p.name, p.email, p.platformAdmin, p.scopeBound, p.clientId], ['user', 'acme', [G1.toLowerCase()], 'Anna', 'anna@acme.ch', true, false, 'notes-platform']);
    assert.deepEqual(p.subjects, [`user:${p.principalId}`, `group:${G1.toLowerCase()}`, 'org:members']);
    assert.ok(!('roles' in p), 'Rollen stehen nie im Principal');
    const row = (await t.inspect.query('SELECT kind, subject, display_name, email, client_id, clearance, last_seen_at IS NOT NULL AS seen FROM notes.principal WHERE id = $1', [p.principalId])).rows[0];
    assert.deepEqual(row, { kind: 'user', subject: 'u1', display_name: 'Anna', email: 'anna@acme.ch', client_id: 'notes-platform', clearance: 0, seen: true });
  });

  test('mehrere Organisationen: ohne Wahl 400 mit eigener Liste, Wahl, fremde 403, je Mandant eigener Principal', async () => {
    const v = verified(c.user({ org: ['acme', 'globex'], sub: 'u2' }));
    await assert.rejects(resolver.resolve(v), (e: HttpError) => e.status === 400 && e.title === 'Organisation wählen' && JSON.stringify(e.extra.organizations) === '["acme","globex"]');
    const a = await resolver.resolve(v, 'acme'), g = await resolver.resolve(v, 'GLOBEX');
    assert.deepEqual([a.tenantAlias, g.tenantAlias], ['acme', 'globex']);
    assert.notEqual(a.principalId, g.principalId);
    assert.notEqual(a.tenantId, g.tenantId);
    await fails(resolver.resolve(v, 'initech'), 403, 'Organisation nicht erlaubt');
    assert.equal(await tenantCount('initech'), 0);
  });

  test('Alias aus Claim und Wahl nur ASCII, sonst 403 «Organisation ungültig»; ohne Organisation 403', async () => {
    await fails(resolver.resolve(verified(c.user({ org: 'Kcme' }))), 403, 'Organisation ungültig', 'Kelvin im Claim');
    assert.equal(await tenantCount('kcme'), 0);
    const multi = verified(c.user({ org: ['kcme', 'acme'] }));
    for (const h of ['Kcme', 'a.b', 'x'.repeat(64), '-acme', 'acme/x', 'acmé']) await fails(resolver.resolve(multi, h), 403, 'Organisation ungültig', h);
    await fails(resolver.resolve(verified({ ...c.user({ org: 'acme' }), organization: undefined })), 403, 'Keine Organisation');
  });

  test('Maschinen-Client: nie Anlage eines Mandanten oder Principals, ohne Freigabe 403, Scopes am Principal', async () => {
    const claims = c.client({ clientId: 'importer', org: 'neu-org', scopes: ['notes:read'] });
    await fails(resolver.resolve(verified(claims)), 403, 'Organisation nicht verfügbar');
    assert.equal(await tenantCount('neu-org'), 0, 'Maschinen-Clients legen keinen Mandanten an');
    const acme = verified({ ...c.client({ clientId: 'importer', org: 'acme', scopes: ['notes:read', 'notes:write'] }), resource_access: { importer: { roles: ['org-admin'] } } });
    await fails(resolver.resolve(acme), 403, 'Client nicht freigegeben');
    assert.equal((await t.inspect.query("SELECT count(*)::int AS n FROM notes.principal WHERE kind = 'client' AND client_id = 'importer'")).rows[0].n, 0, 'kein Principal ohne Freigabe');
    await grant('acme', 'importer');
    const p = await resolver.resolve(acme);
    assert.deepEqual([p.kind, p.subject, p.subjects, p.scopes, p.scopeBound, p.clientId], ['client', 'importer', [`client:${p.principalId}`], ['notes:read', 'notes:write'], true, 'importer']);
    const row = (await t.inspect.query('SELECT client_id, last_scopes, last_seen_at IS NOT NULL AS seen FROM notes.principal WHERE id = $1', [p.principalId])).rows[0];
    assert.deepEqual(row, { client_id: 'importer', last_scopes: ['notes:read', 'notes:write'], seen: true });
    // Neue Scopes im Token: sofort am Principal
    await resolver.resolve(verified({ ...c.client({ clientId: 'importer', org: 'acme', scopes: ['notes:read'] }), sub: acme.claims.sub }));
    assert.deepEqual((await t.inspect.query('SELECT last_scopes FROM notes.principal WHERE id = $1', [p.principalId])).rows[0].last_scopes, ['notes:read']);
  });

  test('Person über einen fremden Client gilt als Maschinen-Client (Freigabe, Scope-Grenze, keine Gruppen)', async () => {
    const v = verified({ ...c.user({ org: 'acme', groups: [G2] }), azp: 'fremd', resource_access: { 'notes-platform': { roles: ['org-admin'] } } });
    await fails(resolver.resolve(v), 403, 'Client nicht freigegeben');
    await grant('acme', 'fremd');
    const p = await resolver.resolve(v);
    assert.deepEqual([p.kind, p.groups, p.subjects.length, p.scopeBound], ['client', [], 1, true]);
  });

  test('MCP: Person über den MCP-Dienst ist scope-gebunden; getauschtes Token eines Maschinen-Clients zählt für den ursprünglichen Client', async () => {
    const person = await resolver.resolve(verified({ ...c.user({ org: 'acme' }), azp: 'notes-mcp' }));
    assert.deepEqual([person.kind, person.scopeBound], ['user', true]);
    const exchanged = verified({ sub: 'sa-exp', azp: 'notes-mcp', client_id: 'exporter', preferred_username: 'service-account-exporter', organization: ['acme'], scope: 'notes:read' });
    await fails(resolver.resolve(exchanged), 403, 'Client nicht freigegeben');
    await grant('acme', 'exporter');
    const p = await resolver.resolve(exchanged);
    assert.deepEqual([p.kind, p.clientId, p.grantId], ['client', 'notes-mcp', 'exporter']);
    assert.equal((await t.inspect.query('SELECT client_id FROM notes.principal WHERE id = $1', [p.principalId])).rows[0].client_id, 'exporter');
  });

  test('Austritt: Tokens von vor dem Entfernen gelten nicht mehr; nach Wiederaufnahme (neues Token) schon', async () => {
    const before = Math.floor(Date.now() / 1000) - 60;
    const p = await resolver.resolve(verified(c.user({ org: 'acme', sub: 'u-leave' }), before));
    await t.inspect.query("UPDATE notes.principal SET removed_at = now() WHERE id = $1", [p.principalId]);
    resolver.forgetPrincipal(p.tenantId, 'u-leave');
    await fails(resolver.resolve(verified(c.user({ org: 'acme', sub: 'u-leave', name: 'Neu' }), before)), 403, 'Kein Mitglied mehr');
    assert.equal((await t.inspect.query('SELECT display_name FROM notes.principal WHERE id = $1', [p.principalId])).rows[0].display_name, 'Test Person', 'nichts überschrieben');
    const back = await resolver.resolve(verified(c.user({ org: 'acme', sub: 'u-leave' }), Math.floor(Date.now() / 1000) + 5));
    assert.equal(back.principalId, p.principalId, 'gleiche ID');
    assert.equal((await t.inspect.query('SELECT removed_at FROM notes.principal WHERE id = $1', [p.principalId])).rows[0].removed_at, null);
  });

  test('Organisation gelöscht und Alias neu vergeben: andere Keycloak-ID erhält den alten Mandanten nicht', async () => {
    const first = await resolver.resolve(verified({ ...c.user({ org: 'umbrella' }), organization: { umbrella: { id: 'kc-1' } } }));
    assert.equal((await t.inspect.query('SELECT kc_org_id FROM notes.tenant WHERE id = $1', [first.tenantId])).rows[0].kc_org_id, 'kc-1');
    await fails(resolver.resolve(verified({ ...c.user({ org: 'umbrella' }), organization: { umbrella: { id: 'kc-2' } } })), 403, 'Organisation nicht verfügbar');
  });

  test('gesperrt oder ohne Auto-Provisionierung: 403 «Organisation nicht verfügbar»', async () => {
    const p = await resolver.resolve(verified(c.user({ org: 'stark' })));
    await t.inspect.query("UPDATE notes.tenant SET status = 'suspended' WHERE id = $1", [p.tenantId]);
    resolver.forgetTenant('stark');
    await fails(resolver.resolve(verified(c.user({ org: 'stark' }))), 403, 'Organisation nicht verfügbar');
    const strict = new PrincipalResolver(t.runtime, testConfig('http://idp.test/realms/notes', { TENANT_AUTO_PROVISION: 'false' }), { schema: 'notes', access: access() });
    await fails(strict.resolve(verified(c.user({ org: 'wayne' }))), 403, 'Organisation nicht verfügbar');
    assert.equal(await tenantCount('wayne'), 0);
  });

  test('«Nur Entra»: Personen der Domäne nur nach Anmeldung über den Anbieter; Plattform-Administration ausgenommen', async () => {
    const tenant = await grant('entra-org', 'x');
    await withTenant(t.runtime, { tenantId: tenant }, tx => tx.query(
      "INSERT INTO notes.entra_connection (tenant_id, entra_tenant_id, idp_alias, domains, stage) VALUES ($1, gen_random_uuid(), 'entra-001', '{contoso.ch}', 'enforced')", [tenant]));
    resolver.forgetEntra();
    const user = c.user({ org: 'entra-org', email: 'eva@Contoso.CH' });
    await assert.rejects(resolver.resolve(verified(user)), (e: HttpError) => e.status === 403 && e.extra.reason === 'entra-login-required');
    assert.equal((await resolver.resolve(verified({ ...user, identity_provider: 'entra-001' }))).tenantAlias, 'entra-org');
    await assert.rejects(resolver.resolve(verified({ ...user, identity_provider: 'entra-002' })), (e: HttpError) => e.extra.reason === 'entra-login-required');
    assert.equal((await resolver.resolve(verified({ ...user, realm_access: { roles: ['platform-admin'] } }))).platformAdmin, true);
    assert.equal((await resolver.resolve(verified(c.user({ org: 'entra-org', email: 'eva@andere.ch' })))).tenantAlias, 'entra-org');
  });
});
