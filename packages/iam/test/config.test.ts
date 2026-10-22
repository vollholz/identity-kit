/**
 * Konfiguration (aus Assets test/platform/unit.test.ts, IAM-Teil): Standardwerte je Produkt, Pflicht je Dienst,
 * Prüfungen über mehrere Variablen, Produktion, `_FILE`, Warnungen bei Client-Geheimnissen (P3).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkProduct, ConfigError, IAM_VARS, iamConfig, iamWarnings, loadIamConfig, parseDuration, productIdent, readVars } from '../src/config.ts';

const base = { OIDC_ISSUER_URL: 'https://identity.example.ch/realms/notes', DATABASE_URL: 'postgres://notes_runtime:x@localhost/notes' };
const key = (id: string) => `${id}:${Buffer.alloc(32, 7).toString('base64')}`;
const errorsOf = (env: NodeJS.ProcessEnv, service: 'api' | 'worker' | 'mcp' | null = null) => {
  try { loadIamConfig(env, { product: 'notes', service }); return []; } catch (e) {
    assert.ok(e instanceof ConfigError);
    return (e as Error).message.split('\n').slice(1).map(l => l.replace(/^\s+- /, ''));
  }
};

test('Standardwerte mit dem Namen des Produkts', () => {
  const c = loadIamConfig(base, { product: 'notes', service: 'api' });
  assert.equal(c.oidc.apiAudience, 'notes-api');
  assert.equal(c.oidc.mcpAudience, 'notes-mcp');
  assert.equal(c.oidc.bffClientId, 'notes-platform');
  assert.equal(c.tenancy.roleClientId, 'notes-platform');
  assert.deepEqual(c.mcp.hostClients, ['notes-mcp-cli']);
  assert.equal(c.mcp.clientId, 'notes-mcp');
  assert.deepEqual([c.tenancy.claim, c.tenancy.roleSource, c.tenancy.groupRolePrefix, c.tenancy.platformAdminRole, c.tenancy.autoProvision], ['organization', 'groups', '/orgs', 'platform-admin', true]);
  assert.deepEqual([c.m2m.dpopMode, c.m2m.dpopMaxAgeSec, c.m2m.mtlsHeader], ['required-for-clients', 300, null]);
  assert.deepEqual([c.session.ttlMs, c.session.idleMs], [8 * 3_600_000, 3_600_000]);
  assert.deepEqual([c.mgmt.clientId, c.mgmt.inviteLifespanSec, c.mgmt.inviteMinMs, c.memberSync.intervalMs], [null, 72 * 3600, 2000, 3_600_000]);
  assert.equal(c.ops.sharedState, 'postgres');
  assert.equal(c.oidc.scopes, 'openid profile email organization');
  assert.throws(() => IAM_VARS('Notes'), ConfigError);
});

test('jede Variable wird gelesen, keine doppelt', () => {
  const vars = IAM_VARS('notes');
  assert.equal(new Set(vars.map(v => v.name)).size, vars.length);
  const src = iamConfig.toString();
  for (const v of vars) if (v.name !== 'NODE_ENV') assert.ok(src.includes(`'${v.name}'`) || src.includes(`raw.${v.name}`), `${v.name} wird nicht gelesen`);
});

test('Pflicht je Dienst: DATABASE_URL nur für die API, Worker mit eigener Verbindung', () => {
  assert.match(errorsOf({ OIDC_ISSUER_URL: base.OIDC_ISSUER_URL }, 'api').join('\n'), /DATABASE_URL fehlt/);
  assert.deepEqual(errorsOf({ OIDC_ISSUER_URL: base.OIDC_ISSUER_URL }, 'mcp'), []);
  assert.match(errorsOf({ OIDC_ISSUER_URL: base.OIDC_ISSUER_URL }, 'worker').join('\n'), /DATABASE_WORKER_URL oder DATABASE_URL/);
  assert.equal(loadIamConfig({ OIDC_ISSUER_URL: base.OIDC_ISSUER_URL, DATABASE_WORKER_URL: 'postgres://w@h/d' }, { product: 'notes', service: 'worker' }).db.workerUrl, 'postgres://w@h/d');
});

test('Form und Bereiche', () => {
  const e = errorsOf({ ...base, DPOP_MODE: 'immer', SESSION_TTL: '8 Stunden', DATABASE_POOL_MAX: 'viele', ENTRA_IDP_SLOTS: '300', MEMBER_SYNC_INTERVAL: '30s', KEYCLOAK_MGMT_INVITE_LIFESPAN: '31d', SESSION_SECRET: 'kurz', ENCRYPTION_KEYS: 'k1:abc' }).join('\n');
  for (const m of [/DPOP_MODE: erlaubt/, /SESSION_TTL: ungültige Dauer/, /DATABASE_POOL_MAX: ganze Zahl/, /ENTRA_IDP_SLOTS: 1 bis 250/, /MEMBER_SYNC_INTERVAL: mindestens 1m/, /INVITE_LIFESPAN: 1h bis 30d/, /SESSION_SECRET: jeder Schlüssel/, /ENCRYPTION_KEYS: Schlüssel k1 muss 32 Bytes/]) assert.match(e, m);
  assert.deepEqual(errorsOf({ ...base, MEMBER_SYNC_INTERVAL: '0' }), []);
  assert.equal(parseDuration('0'), 0);
  assert.equal(parseDuration('90s'), 90_000);
});

test('Schlüssel der Keycloak-Clients nur im Dienst, der den Client nutzt', () => {
  assert.match(errorsOf({ ...base, KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin' }, 'api').join('\n'), /KEYCLOAK_MGMT_PRIVATE_KEY oder KEYCLOAK_MGMT_CLIENT_SECRET/);
  assert.deepEqual(errorsOf({ ...base, KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin' }, 'worker'), []);
  assert.match(errorsOf({ ...base, KEYCLOAK_SYNC_CLIENT_ID: 'notes-sync' }, 'worker').join('\n'), /KEYCLOAK_SYNC_PRIVATE_KEY/);
  assert.deepEqual(errorsOf({ ...base, KEYCLOAK_SYNC_CLIENT_ID: 'notes-sync' }, 'api'), []);
  const entra = errorsOf({ ...base, ENTRA_CLIENT_ID: 'x' }, 'api').join('\n');
  assert.match(entra, /ENTRA_CLIENT_SECRET/);
  assert.match(entra, /KEYCLOAK_MGMT_CLIENT_ID fehlt/);
});

test('Produktion: Geheimnisse, HTTPS, DPoP', () => {
  const prod = { ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://notes.example.ch', OIDC_ISSUER_URL: 'http://identity.example.ch/realms/notes', DPOP_MODE: 'off' };
  const e = errorsOf(prod, 'api').join('\n');
  for (const m of [/SESSION_SECRET fehlt/, /ENCRYPTION_KEYS fehlt/, /OIDC_BFF_CLIENT_SECRET oder OIDC_BFF_PRIVATE_KEY/, /PUBLIC_BASE_URL muss in Produktion/, /OIDC_ISSUER_URL muss in Produktion/, /DPOP_MODE=off/]) assert.match(e, m);
  // Der MCP-Dienst braucht weder Sitzung noch Verschlüsselung
  const mcp = errorsOf({ NODE_ENV: 'production', OIDC_ISSUER_URL: 'https://identity.example.ch/realms/notes', PUBLIC_BASE_URL: 'https://notes.example.ch', MCP_PUBLIC_URL: 'https://mcp.notes.example.ch/mcp' }, 'mcp');
  assert.deepEqual(mcp, []);
  const ok = loadIamConfig({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://notes.example.ch/', SESSION_SECRET: 'x'.repeat(32) + ',' + 'y'.repeat(40), ENCRYPTION_KEYS: `${key('k2')},${key('k1')}`, OIDC_BFF_PRIVATE_KEY: 'pem' }, { product: 'notes', service: 'api' });
  assert.equal(ok.publicBaseUrl, 'https://notes.example.ch');
  assert.deepEqual(ok.encryptionKeys.map(k => k.id), ['k2', 'k1']);
  assert.equal(ok.session.secrets.length, 2);
});

test('Geheimnisse aus Dateien (_FILE)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iam-config-'));
  writeFileSync(join(dir, 'secret'), `${'s'.repeat(40)}\n`);
  const c = loadIamConfig({ ...base, SESSION_SECRET_FILE: join(dir, 'secret') }, { product: 'notes', service: 'api' });
  assert.deepEqual(c.session.secrets, ['s'.repeat(40)]);
  assert.match(errorsOf({ ...base, SESSION_SECRET_FILE: join(dir, 'fehlt') }).join('\n'), /SESSION_SECRET_FILE: Datei .* nicht lesbar/);
  // Nur für geheime Variablen
  assert.equal(readVars({ OIDC_SCOPES_FILE: join(dir, 'secret') }, IAM_VARS('notes'), null).raw.OIDC_SCOPES, 'openid profile email organization');
});

test('Warnungen: Client-Geheimnis statt privatem Schlüssel, Client-Rollen als Rollenquelle', () => {
  const c = loadIamConfig({ ...base, OIDC_BFF_CLIENT_SECRET: 's', KEYCLOAK_MGMT_CLIENT_ID: 'notes-admin', KEYCLOAK_MGMT_CLIENT_SECRET: 's', KEYCLOAK_SYNC_CLIENT_ID: 'notes-sync', KEYCLOAK_SYNC_CLIENT_SECRET: 's', MCP_CLIENT_SECRET: 's', ROLE_SOURCE: 'both' }, { product: 'notes', service: null });
  const all = iamWarnings(c, null).join('\n');
  for (const v of ['OIDC_BFF_CLIENT_SECRET', 'KEYCLOAK_MGMT_CLIENT_SECRET', 'KEYCLOAK_SYNC_CLIENT_SECRET', 'MCP_CLIENT_SECRET', 'ROLE_SOURCE=both']) assert.ok(all.includes(v), v);
  assert.deepEqual(iamWarnings(c, 'worker').map(w => w.split(':')[0]), ['KEYCLOAK_SYNC_CLIENT_SECRET', 'ROLE_SOURCE=both']);
  const withKey = loadIamConfig({ ...base, OIDC_BFF_CLIENT_SECRET: 's', OIDC_BFF_PRIVATE_KEY: 'pem' }, { product: 'notes', service: 'api' });
  assert.deepEqual(iamWarnings(withKey, 'api'), []);
});

test('eine Namensregel für das Produkt: Bindestrich im Namen, Unterstrich in der Datenbank', () => {
  assert.equal(productIdent('my-app'), 'my_app');
  assert.equal(productIdent('notes'), 'notes');
  for (const ok of ['a', 'notes', 'my-app', 'app2-x9']) assert.equal(checkProduct(ok), ok);
  for (const bad of ['', 'my_app', 'My', '-a', 'a-', 'a--b', '9a', 'a'.repeat(42)]) assert.throws(() => checkProduct(bad), ConfigError, JSON.stringify(bad));
  const c = loadIamConfig(base, { product: 'my-app', service: 'api' });
  assert.deepEqual([c.oidc.apiAudience, c.oidc.bffClientId, c.mcp.hostClients], ['my-app-api', 'my-app-platform', ['my-app-mcp-cli']]);
  assert.throws(() => loadIamConfig(base, { product: 'my_app', service: 'api' }), ConfigError);
  assert.match(IAM_VARS('my-app').find(v => v.name === 'DATABASE_URL')!.example!, /my_app_runtime@|my_app_runtime:/);
});
