import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { promisify } from 'node:util';
import {
  CURRENT, FIXED_REALM_SETTINGS, ManifestSchema, fileHash, formatLock, formatMarkdown, manifestErrors, realmChecks, repoChecks, versionProblem,
  type AdminReader, type Finding, type Manifest,
} from '../src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'iam-conformity-'));
after(() => rmSync(root, { recursive: true, force: true }));

const catalog = {
  permissions: [
    { key: 'tenant:read', label: 'Organisation lesen', group: 'tenant', description: 'Organisation lesen.', resources: ['org'] },
    { key: 'members:admin', label: 'Mitglieder und Rollen verwalten', group: 'members', description: 'Mitglieder.', resources: ['org'] },
    { key: 'note:read', label: 'Notizen lesen', group: 'notes', description: 'Notizen lesen.', resources: ['org'] },
  ],
  groups: [{ key: 'tenant', label: 'Organisation' }, { key: 'members', label: 'Mitglieder und Rollen' }, { key: 'notes', label: 'Notizen', match: 'notiz' }],
  roles: [
    { key: 'org-admin', label: 'Organisations-Admin', description: 'Alles: Notizen, Mitglieder.', permissions: ['tenant:read', 'members:admin', 'note:read'], adminOnly: true },
    { key: 'viewer', label: 'Leser:in', description: 'Liest Notizen.', permissions: ['tenant:read', 'note:read'], adminOnly: false },
  ],
  scopes: [{ key: 'notes:read', text: 'Notizen lesen', permissions: ['tenant:read', 'note:read'] }],
  types: [{ key: 'org', label: 'Organisation', parent: null, roles: ['org-admin', 'viewer'], relations: ['org-admin', 'viewer'], read: 'tenant:read' }],
  classifications: [{ level: 0, label: 'intern' }, { level: 1, label: 'vertraulich' }, { level: 2, label: 'streng vertraulich' }],
};
const platformJson = `${JSON.stringify({ scopes: ['notes:read'] }, null, 2)}\n`;

const manifest: Manifest = {
  product: 'notes', displayName: 'Notes', publicBaseUrl: 'https://notes.example.ch', keycloakUrl: 'https://id.example.ch',
  realm: { entra: true, m2m: true, machineClients: { 'notes-import': { organizations: ['demo'], scopes: ['notes:read'] } } },
  organizations: [{ alias: 'demo', admins: [{ email: 'anna@demo.example' }] }],
};

const managed: Record<string, string> = {
  'infra/keycloak/main.tf': '# Verwaltet von identity-kit\nmodule "realm" {\n  source = "git::https://github.com/vollholz/identity-kit.git//modules/product-realm?ref=product-realm-v2.0.0"\n}\n',
  'infra/keycloak/bootstrap/main.tf': '# Verwaltet von identity-kit\nmodule "bootstrap" {\n  source = "git::https://github.com/vollholz/identity-kit.git//modules/product-realm-bootstrap?ref=product-realm-bootstrap-v0.1.1"\n}\n',
  '.github/workflows/keycloak.yml': '# Verwaltet von identity-kit\nname: Keycloak\n',
};

/** Kleinste konforme App im Dateisystem. */
function app(name: string, change: (dir: string) => void = () => undefined): string {
  const dir = join(root, name);
  const write = (p: string, s: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
  write('identity.app.json', JSON.stringify(manifest, null, 2));
  for (const [p, s] of Object.entries(managed)) write(p, s);
  write('.identity-kit.lock', formatLock({ kit: CURRENT['@vollholz/create-iam-app'], versions: { 'product-realm': '2.0.0' }, files: Object.fromEntries(Object.entries(managed).map(([p, s]) => [p, fileHash(s)])) }));
  write('package.json', JSON.stringify({ dependencies: { '@vollholz/iam': CURRENT['@vollholz/iam'] }, devDependencies: { '@vollholz/iam-testkit': CURRENT['@vollholz/iam-testkit'] } }));
  write('infra/keycloak/platform.json', platformJson);
  write('src/authz/model.ts', `export const model = { product: 'notes', features: { members: true }, toJSON: () => (${JSON.stringify(catalog)}), platformJson: () => ${JSON.stringify(platformJson)} };\n`);
  change(dir);
  return dir;
}

const failed = (f: Finding[]) => f.filter(x => x.status === 'fail').map(x => `${x.check}: ${x.details.join('; ')}`);

describe('Manifest', () => {
  test('gültig; Fehler mit Pfad; Maschinen-Clients nur mit m2m, keine reservierten IDs, Aliasse eindeutig', () => {
    assert.deepEqual(manifestErrors(manifest), []);
    const e = (m: unknown) => manifestErrors(m).join('\n');
    assert.match(e({ ...manifest, product: 'master' }), /\/product/);
    assert.match(e({ ...manifest, unbekannt: 1 }), /unbekannt|additional/i);
    assert.match(e({ ...manifest, realm: { machineClients: { 'notes-x': { organizations: ['a'] } } } }), /braucht realm\.m2m/);
    assert.match(e({ ...manifest, realm: { m2m: true, machineClients: { 'notes-api': { organizations: ['a'] } } } }), /reserviert/);
    assert.match(e({ ...manifest, organizations: [{ alias: 'a', admins: [{ email: 'x@a.ch' }] }, { alias: 'a', admins: [{ email: 'y@a.ch' }] }] }), /a doppelt/);
    assert.match(e({ ...manifest, realm: { standardTexts: false } }), /realm/);
    // Betrieb (iam 3.0): eigene Konten ohne Organisation, nie zugleich Admin einer Organisation; platformAdmin entfällt
    assert.deepEqual(e({ ...manifest, operators: [{ email: 'b@betrieb.ch' }], organizations: [{ alias: 'a', admins: [{ email: 'x@a.ch' }] }] }), '');
    assert.match(e({ ...manifest, operators: [{ email: 'X@a.ch' }], organizations: [{ alias: 'a', admins: [{ email: 'x@a.ch' }] }] }), /ist Betrieb/);
    assert.match(e({ ...manifest, organizations: [{ alias: 'a', admins: [{ email: 'x@a.ch', platformAdmin: true }] }] }), /admins/);
  });

  test('mitgeliefertes JSON Schema entspricht der Prüfung', () => {
    const { $schema: _draft, ...shipped } = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'schema', 'identity-app.schema.json'), 'utf8'));
    assert.deepEqual(shipped, JSON.parse(JSON.stringify(ManifestSchema)));
  });
});

describe('Versionen', () => {
  test('exakt und im Fenster; CURRENT = Versionen im Repository', () => {
    assert.equal(versionProblem('@vollholz/iam', '3.0.0'), null);
    assert.match(versionProblem('@vollholz/iam', '^3.0.0')!, /exakte Version/);
    assert.match(versionProblem('@vollholz/iam', '2.1.0')!, /älter als 3\.0\.0/);
    assert.match(versionProblem('@vollholz/iam', '99.0.0')!, /neuer als die Hauptversion.*iam-testkit aktualisieren/);
    assert.equal(versionProblem('@vollholz/iam', `${CURRENT['@vollholz/iam'].split('.')[0]}.99.0`), null, 'neuere Neben-Version derselben Hauptversion');
    assert.equal(versionProblem('@vollholz/platform', '0.1.0'), null, '@vollholz/platform gehört zum Kit');
    const pkg = (p: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', p, 'package.json'), 'utf8')).version;
    const mod = (m: string) => readFileSync(join(import.meta.dirname, '..', '..', '..', 'modules', m, 'VERSION'), 'utf8').trim();
    assert.deepEqual(CURRENT, {
      '@vollholz/iam': pkg('iam'), '@vollholz/iam-web': pkg('iam-web'), '@vollholz/iam-testkit': pkg('iam-testkit'), '@vollholz/create-iam-app': pkg('create-iam-app'),
      '@vollholz/platform': pkg('platform'),
      'product-realm': mod('product-realm'), 'product-realm-bootstrap': mod('product-realm-bootstrap'),
    });
  });
});

describe('Ebene Repository', () => {
  test('konforme App: keine Fehler; Einstellungen und Ausnahmen werden angezeigt', async () => {
    const { findings, manifest: m } = await repoChecks(app('ok'));
    assert.deepEqual(failed(findings), []);
    assert.equal(m?.product, 'notes');
    const s = findings.find(f => f.check === 'Einstellungen der App')!;
    assert.equal(s.zone, 'einstellbar');
    assert.ok(s.details.includes('Schalter: entra, m2m') && s.details.includes('Maschinen-Clients: notes-import'), s.details.join());
  });

  test('verwaltete Datei geändert oder fehlend, eigene .tf ohne Begründung, veraltete Ausnahme', async () => {
    const dir = app('geaendert', d => {
      writeFileSync(join(d, 'infra/keycloak/main.tf'), `${managed['infra/keycloak/main.tf']}\nresource "keycloak_role" "x" {}\n`);
      rmSync(join(d, '.github/workflows/keycloak.yml'));
      writeFileSync(join(d, 'infra/keycloak/extra.tf'), 'resource "keycloak_role" "y" {}\n');
      writeFileSync(join(d, 'identity.app.json'), JSON.stringify({ ...manifest, exceptions: { files: { 'infra/keycloak/alt.tf': 'Umstellung' } } }));
    });
    const f = failed((await repoChecks(dir)).findings).join('\n');
    assert.match(f, /infra\/keycloak\/main\.tf von Hand geändert/);
    assert.match(f, /\.github\/workflows\/keycloak\.yml fehlt/);
    assert.match(f, /infra\/keycloak\/extra\.tf: eigene Datei/);
    assert.match(f, /Ausnahme infra\/keycloak\/alt\.tf veraltet/);
    const ok = app('begruendet', d => {
      writeFileSync(join(d, 'infra/keycloak/moved.tf'), 'moved {}\n');
      writeFileSync(join(d, 'identity.app.json'), JSON.stringify({ ...manifest, exceptions: { files: { 'infra/keycloak/moved.tf': 'Umstellung auf das Modul (bis alle States verschoben sind)' } } }));
    });
    const r = await repoChecks(ok);
    assert.deepEqual(failed(r.findings), []);
    assert.ok(r.findings.find(x => x.check === 'Einstellungen der App')!.details.some(d => d.startsWith('Ausnahme Datei infra/keycloak/moved.tf')));
  });

  test('Versionen: nicht gepinnt, zu alt, Backend fehlt; Modul zu alt', async () => {
    const dir = app('versionen', d => {
      writeFileSync(join(d, 'package.json'), JSON.stringify({ dependencies: { '@vollholz/iam-web': '^1.2.0' }, devDependencies: { '@vollholz/iam-testkit': '0.9.0' } }));
      writeFileSync(join(d, 'infra/keycloak/main.tf'), managed['infra/keycloak/main.tf']!.replace('v2.0.0', 'v1.0.0'));
    });
    const f = failed((await repoChecks(dir)).findings).join('\n');
    assert.match(f, /iam-web: «\^1\.2\.0» ist keine exakte Version/);
    assert.match(f, /iam-testkit 0\.9\.0 ist älter als 1\.0\.0/);
    assert.match(f, /@vollholz\/iam fehlt/);
    assert.match(f, /product-realm 1\.0\.0 ist älter als 2\.0\.0/);
  });

  test('Modell: Regelverstoss, falsches Produkt, platform.json veraltet, nicht ladbar', async () => {
    const broken = { ...catalog, roles: catalog.roles.slice(1) };
    const dir = app('modell', d => {
      writeFileSync(join(d, 'src/authz/model.ts'), `export const model = { product: 'andere', toJSON: () => (${JSON.stringify(broken)}), platformJson: () => '{"scopes":["x:y"]}' };\n`);
    });
    const f = failed((await repoChecks(dir)).findings).join('\n');
    assert.match(f, /M3 Rolle «org-admin» fehlt/);
    assert.match(f, /model\.product «andere» ≠ product «notes»/);
    assert.match(f, /platform\.json ≠ model\.platformJson\(\)/);
    const bad = app('kaputt', d => writeFileSync(join(d, 'src/authz/model.ts'), 'import "gibt-es-nicht";\n'));
    assert.match(failed((await repoChecks(bad)).findings).join('\n'), /lässt sich nicht laden/);
    const skipped = (await repoChecks(bad, { skipModel: true })).findings;
    assert.deepEqual(failed(skipped), []);
  });

  test('ohne Manifest und Lock: Befunde statt Abbruch', async () => {
    const dir = app('leer', d => { rmSync(join(d, 'identity.app.json')); rmSync(join(d, '.identity-kit.lock')); });
    const f = failed((await repoChecks(dir)).findings).join('\n');
    assert.match(f, /identity\.app\.json fehlt/);
    assert.match(f, /\.identity-kit\.lock fehlt/);
  });
});

/** Admin-API als Tabelle: Pfad → Antwort. */
function reader(data: Record<string, unknown>): AdminReader {
  return { get: async <T>(path: string) => { if (!(path in data)) throw new Error(`GET ${path}: HTTP 404`); return data[path] as T; } };
}

function realmData(change: (d: Record<string, any>) => void = () => undefined) {
  const client = (clientId: string, extra: Record<string, unknown> = {}) => ({ id: `id-${clientId}`, clientId, clientAuthenticatorType: 'client-jwt', ...extra });
  const clients = [
    ...['account', 'account-console', 'admin-cli', 'broker', 'realm-management', 'security-admin-console'].map(c => client(c, { publicClient: c !== 'broker' && c !== 'realm-management', clientAuthenticatorType: 'client-secret', directAccessGrantsEnabled: c === 'admin-cli' })),
    ...['platform', 'api', 'admin', 'sync', 'iac'].map(s => client(`notes-${s}`)),
    client('notes-import', { attributes: { 'notes.m2m': 'true' } }),
  ];
  const d: Record<string, any> = {
    '/realms/notes': { ...FIXED_REALM_SETTINGS, passwordPolicy: 'length(12) and notUsername and notEmail' },
    '/realms/notes/events/config': { eventsEnabled: true, adminEventsEnabled: true },
    '/realms/notes/clients?max=1000': clients,
    '/realms/notes/roles?max=1000': ['platform-admin', 'offline_access', 'uma_authorization', 'default-roles-notes'].map(name => ({ name })),
    '/realms/notes/identity-provider/instances': [{ alias: 'entra-app-demo', providerId: 'microsoft' }],
  };
  for (const c of clients) if (c.clientId.startsWith('notes-')) d[`/realms/notes/clients/${c.id}/roles`] = [];
  change(d);
  return d;
}

describe('Ebene Realm', () => {
  test('wie im Modul: keine Fehler (eingebaute Clients ausgenommen)', async () => {
    assert.deepEqual(failed(await realmChecks(reader(realmData()), { product: 'notes', manifest })), []);
  });

  test('Änderungen von Hand: Einstellung, fremder Client, Geheimnis, Rolle, Client-Rolle, IdP, Ereignisse', async () => {
    const d = realmData(x => {
      x['/realms/notes'] = { ...x['/realms/notes'], accessTokenLifespan: 3600, registrationAllowed: true, passwordPolicy: 'length(8)' };
      x['/realms/notes/clients?max=1000'].push({ id: 'id-handarbeit', clientId: 'handarbeit', clientAuthenticatorType: 'client-secret', directAccessGrantsEnabled: true });
      x['/realms/notes/clients?max=1000'].find((c: { clientId: string }) => c.clientId === 'notes-platform').clientAuthenticatorType = 'client-secret';
      x['/realms/notes/roles?max=1000'].push({ name: 'editor' });
      x['/realms/notes/clients/id-notes-platform/roles'] = [{ name: 'viewer' }];
      x['/realms/notes/identity-provider/instances'].push({ alias: 'google' });
      x['/realms/notes/events/config'] = { eventsEnabled: false, adminEventsEnabled: true };
    });
    const f = failed(await realmChecks(reader(d), { product: 'notes', manifest })).join('\n');
    for (const m of [/accessTokenLifespan = 3600 statt 300/, /registrationAllowed = true/, /passwordPolicy «length\(8\)»/, /handarbeit: nicht aus dem Modul/,
      /handarbeit: Direct Access Grants/, /notes-platform: Anmeldung «client-secret»/, /Realm-Rolle editor/, /Client-Rolle notes-platform\/viewer/,
      /google: nicht nach dem Muster/, /eventsEnabled = false/]) assert.match(f, m);
  });

  test('Maschinen-Clients: mit Manifest genau, ohne Manifest über das Attribut des Moduls; entra aus → kein IdP', async () => {
    const d = realmData(x => { x['/realms/notes/clients?max=1000'].push({ id: 'id-m2', clientId: 'notes-zweit', clientAuthenticatorType: 'client-jwt', attributes: { 'notes.m2m': 'true' } }); x['/realms/notes/clients/id-m2/roles'] = []; });
    assert.match(failed(await realmChecks(reader(d), { product: 'notes', manifest })).join('\n'), /notes-zweit: nicht aus dem Modul/);
    assert.deepEqual(failed(await realmChecks(reader(d), { product: 'notes' })), []);
    const off = { ...manifest, realm: { ...manifest.realm, entra: false } };
    assert.match(failed(await realmChecks(reader(realmData()), { product: 'notes', manifest: off })).join('\n'), /obwohl realm\.entra aus ist/);
    // Manifest ohne realm: Standards (alles aus) statt der losen Prüfung ohne Manifest
    const { realm: _r, ...bare } = manifest;
    const f = failed(await realmChecks(reader(d), { product: 'notes', manifest: bare })).join('\n');
    assert.match(f, /notes-import: nicht aus dem Modul/);
    assert.match(f, /entra-app-demo: Identity Provider, obwohl realm\.entra aus ist/);
    // MCP im Manifest an: beide MCP-Clients Pflicht
    const mcp = { ...manifest, realm: { ...manifest.realm, mcp: true } };
    assert.match(failed(await realmChecks(reader(realmData()), { product: 'notes', manifest: mcp })).join('\n'), /notes-mcp fehlt[\s\S]*notes-mcp-cli fehlt|notes-mcp-cli fehlt/);
    const missing = { ...manifest, realm: { ...manifest.realm, machineClients: { ...manifest.realm!.machineClients, 'notes-neu': { organizations: ['demo'] } } } };
    assert.match(failed(await realmChecks(reader(realmData()), { product: 'notes', manifest: missing })).join('\n'), /notes-neu: im Manifest, fehlt im Realm/);
  });
});

describe('Kommandozeile', () => {
  const bin = join(import.meta.dirname, '..', 'src', 'bin', 'conformity-test.ts');
  const run = (args: string[], env: Record<string, string> = {}) => promisify(execFile)(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH, ...env } })
    .then(r => ({ code: 0, out: r.stdout, err: r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }));

  test('Repository: Code 0 bzw. 1, Text, JSON und Markdown', async () => {
    const ok = await run(['--dir', app('cli-ok')]);
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.match(ok.out, /Konformität notes mit dem Identity-Kit[\s\S]*Repository[\s\S]*OK +Verwaltete Dateien unverändert +\[Fest · identity-kit/);
    const dir = app('cli-bad', d => writeFileSync(join(d, 'infra/keycloak/main.tf'), 'geändert'));
    const md = join(root, 'summary.md');
    const bad = await run(['--dir', dir, '--json', '--markdown', md]);
    assert.equal(bad.code, 1);
    const json = JSON.parse(bad.out) as { product: string; findings: Finding[] };
    assert.equal(json.product, 'notes');
    assert.ok(json.findings.some(f => f.status === 'fail' && f.check === 'Verwaltete Dateien unverändert'));
    assert.match(readFileSync(md, 'utf8'), /^### Konformität notes[\s\S]*\| ❌ \| Repository \| Verwaltete Dateien unverändert \| Fest \|/m);
  });

  test('Aufruf falsch: Code 64', async () => {
    for (const [args, m] of [[['--no-repo'], /nichts zu prüfen/], [['--falsch'], /falsch/], [['--db', '--dir', app('cli-db')], /DATABASE_ADMIN_URL fehlt/]] as [string[], RegExp][]) {
      const r = await run(args);
      assert.equal(r.code, 64, r.err);
      assert.match(r.err, m);
    }
  });

  test('Realm über HTTP mit private_key_jwt, ohne Manifest (--product, Anmeldung im Realm master)', async () => {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const data = realmData();
    const tokens: URLSearchParams[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/realms/master/protocol/openid-connect/token') {
          tokens.push(new URLSearchParams(Buffer.concat(chunks).toString()));
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 't' }));
          return;
        }
        const path = (req.url ?? '').replace(/^\/admin/, '');
        if (req.headers.authorization !== 'Bearer t' || !(path in data)) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data[path]));
      });
    });
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const r = await run(['--realm', '--no-repo', '--product', 'notes', '--dir', join(root, 'gibt-es-nicht'), '--markdown', join(root, 'realm.md')],
        { KEYCLOAK_CONFORMITY_URL: url, KEYCLOAK_CONFORMITY_REALM: 'master', KEYCLOAK_CONFORMITY_CLIENT_ID: 'identity-conformity', KEYCLOAK_CONFORMITY_PRIVATE_KEY_B64: Buffer.from(key).toString('base64') });
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(r.out, /Realm[\s\S]*OK +Nur Clients aus dem Modul/);
      assert.deepEqual([tokens[0]!.get('client_id'), tokens[0]!.get('client_assertion_type')], ['identity-conformity', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer']);
    } finally { await new Promise<void>(ok => server.close(() => ok())); }
  });
});

test('Markdown: Pipe und Zeilenumbruch in Befunden maskiert', () => {
  const md = formatMarkdown([{ level: 'repo', check: 'a|b', zone: 'fest', source: 's', status: 'fail', details: ['x\ny'] }], 'T');
  assert.match(md, /a\\\|b[\s\S]*x y/);
});
