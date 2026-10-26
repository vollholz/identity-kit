/**
 * Konfiguration (app-boilerplate 5.1, 7): alle Fehler zugleich, Exit 78, Produktionsverbote, `_FILE`, Dienstzuordnung
 * der Geheimnisse.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, EXIT_CONFIG, defineApp, definePlatform, envDocs, platformVars } from '../src/index.ts';
import { app } from './fixture/app.ts';
import { notizModule } from './fixture/notiz/index.ts';

const VARS = app.vars;
const loadPlatformConfig = app.loadConfig;

const base = { OIDC_ISSUER_URL: 'http://localhost:8180/realms/probe', DATABASE_URL: 'postgres://x@localhost/probe' };
const prod = {
  NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://probe.example.ch', OIDC_ISSUER_URL: 'https://id.example.ch/realms/probe',
  DATABASE_URL: 'postgres://x@db/probe', DATABASE_SSL: 'verify-full', SESSION_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`, OIDC_BFF_PRIVATE_KEY: 'pem',
};
const errorsOf = (env: Record<string, string>, service: 'api' | 'worker' | 'mcp' | null = 'api') => {
  try { loadPlatformConfig(env, service); return []; } catch (e) { assert.ok(e instanceof ConfigError); return e.message.split('\n').slice(1).map(l => l.replace(/^\s+- /, '')); }
};

test('Entwicklung mit Mindestangaben', () => {
  const cfg = loadPlatformConfig(base, 'api');
  assert.equal(cfg.mode, 'development');
  assert.equal(cfg.app.http.port, 8080);
  assert.equal(cfg.app.ops.port, 9090);
  assert.equal(cfg.oidc.apiAudience, 'probe-api');
});

test('alle Fehler zugleich', () => {
  const errors = errorsOf({ HTTP_PORT: 'x', OPS_PORT: '70000', LOG_LEVEL: 'laut' });
  assert.ok(errors.some(e => e.startsWith('OIDC_ISSUER_URL fehlt')));
  assert.ok(errors.some(e => e.startsWith('DATABASE_URL fehlt')));
  assert.ok(errors.some(e => e.startsWith('HTTP_PORT:')));
  assert.ok(errors.some(e => e.startsWith('OPS_PORT: 1 bis 65535')));
  assert.ok(errors.some(e => e.startsWith('LOG_LEVEL:')));
});

test('Produktion: gültig und Verbote', () => {
  assert.deepEqual(errorsOf(prod), []);
  const errors = errorsOf({ ...prod, PUBLIC_BASE_URL: 'http://x.ch', DATABASE_SSL: 'require', DPOP_MODE: 'off', TENANT_AUTO_PROVISION: 'true', WEBHOOK_ALLOW_PRIVATE: 'true' });
  for (const p of ['PUBLIC_BASE_URL muss', 'DATABASE_SSL muss', 'DPOP_MODE=off', 'TENANT_AUTO_PROVISION=true', 'WEBHOOK_ALLOW_PRIVATE=true']) assert.ok(errors.some(e => e.startsWith(p)), p);
  assert.ok(errorsOf({ ...prod, SESSION_SECRET: '' }).some(e => e.startsWith('SESSION_SECRET fehlt')));
  assert.ok(errorsOf({ ...prod, ENCRYPTION_KEYS: '' }).some(e => e.startsWith('ENCRYPTION_KEYS fehlt')));
});

test('Geheimnisse als _FILE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  writeFileSync(join(dir, 'db'), 'postgres://datei@localhost/probe\n');
  const cfg = loadPlatformConfig({ ...base, DATABASE_URL: '', DATABASE_URL_FILE: join(dir, 'db') }, 'api');
  assert.equal(cfg.db.url, 'postgres://datei@localhost/probe');
  assert.ok(errorsOf({ ...base, DATABASE_URL: '', DATABASE_URL_FILE: join(dir, 'fehlt') }).some(e => e.startsWith('DATABASE_URL_FILE: Datei')));
});

test('Geheimnisse je Dienst: jeder verlangt nur, was er liest', () => {
  const { DATABASE_URL: _, ...noDb } = prod;
  // MCP hat keinen Datenbank-Login und braucht keine Sitzung
  assert.deepEqual(errorsOf({ ...noDb, SESSION_SECRET: '', ENCRYPTION_KEYS: '', OIDC_BFF_PRIVATE_KEY: '', MCP_PUBLIC_URL: 'https://probe.example.ch/mcp' }, 'mcp'), []);
  // Worker: eigene Verbindung genügt, keine Sitzung, kein BFF
  assert.deepEqual(errorsOf({ ...noDb, SESSION_SECRET: '', OIDC_BFF_PRIVATE_KEY: '', DATABASE_WORKER_URL: 'postgres://w@db/probe' }, 'worker'), []);
  assert.ok(errorsOf({ ...noDb, DATABASE_WORKER_URL: '' }, 'worker').some(e => e.startsWith('DATABASE_WORKER_URL oder DATABASE_URL')));
  // Jede geheime Variable ist als Datei möglich
  for (const v of VARS.filter(x => x.secret)) assert.ok(v.fileAllowed, `${v.name} ohne _FILE`);
});

test('Einstiegspunkt endet mit Exit 78 und nennt alle Fehler', () => {
  const r = spawnSync(process.execPath, ['-e', `
    const { app } = await import(${JSON.stringify(new URL('./fixture/app.ts', import.meta.url).href)});
    app.configOrExit({ HTTP_PORT: 'x' }, 'api');`], { encoding: 'utf8', env: { PATH: process.env.PATH }, input: '' });
  assert.equal(r.status, EXIT_CONFIG);
  assert.match(r.stderr, /OIDC_ISSUER_URL fehlt/);
  assert.match(r.stderr, /HTTP_PORT/);
});

test('Variablen der App: ergänzt, geprüft und in der Doku; doppelte Namen sind ein Fehler', () => {
  const { model } = app.platform;
  const extra = { name: 'PROBE_LIMIT', kind: 'int' as const, group: 'Probe', default: '3', description: 'Grenze der Probe.' };
  const withVar = defineApp({
    platform: definePlatform({ product: 'probe', title: 'Probe', model }), modules: [notizModule], vars: [extra],
    check: raw => (raw.PROBE_LIMIT === '0' ? ['PROBE_LIMIT: mindestens 1'] : []),
  });
  assert.equal(withVar.loadConfig(base, 'api').raw.PROBE_LIMIT, '3');
  assert.throws(() => withVar.loadConfig({ ...base, PROBE_LIMIT: '0' }, 'api'), /PROBE_LIMIT: mindestens 1/);
  assert.throws(() => platformVars('probe', [{ ...extra, name: 'HTTP_PORT' }]), /HTTP_PORT ist doppelt/);
  const docs = envDocs(withVar.vars);
  assert.match(docs.md, /\| `PROBE_LIMIT` \| int \| `3` \|/);
  assert.match(docs.env, /# PROBE_LIMIT=3/);
  // OTEL_SERVICE_NAME nimmt das Produkt als Standard
  assert.equal(withVar.loadConfig(base, 'api').app.ops.serviceName, 'probe');
});
