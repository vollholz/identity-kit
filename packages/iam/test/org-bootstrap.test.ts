/**
 * Ersteinrichtung einer Organisation (`orgBootstrap`, Kommandozeile `iam-org-bootstrap`; aus Assets
 * scripts/org-bootstrap.ts) gegen den `KeycloakFake`: Organisation, Rollengruppen aller Rollen des Katalogs (auch mit
 * mehrstufigem Präfix), erste Person mit Rollen und Realm-Rolle, temporäres Passwort nur in einer Datei, idempotent,
 * Probelauf ohne Änderung, Eingaben geprüft. Die Kommandozeile läuft als eigener Prozess gegen den Fake über HTTP.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { KeycloakFake } from '@vollholz/iam-testkit';
import { orgBootstrap, orgBootstrapErrors } from '../src/bootstrap.ts';
import type { IamConfig } from '../src/config.ts';
import { KeycloakAdmin } from '../src/keycloak.ts';
import { notesCatalog } from './support/catalogs.ts';

const ISSUER = 'http://idp.test/realms/notes';
const ROLES = Object.keys(JSON.parse(notesCatalog.platformJson()).roles as Record<string, string>);
const admin = (fake: KeycloakFake) => new KeycloakAdmin({ oidc: { issuer: ISSUER }, mgmt: { adminUrl: null, timeoutMs: 5000 } } as unknown as Pick<IamConfig, 'oidc' | 'mgmt'>,
  async () => `${ISSUER}/protocol/openid-connect/token`, fake.fetch, { clientId: 'notes-iac', privateKey: null, clientSecret: 'x' });
const paths = (fake: KeycloakFake) => [...fake.groups.values()].map(g => g.path).sort();

describe('Ersteinrichtung einer Organisation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iam-bootstrap-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('Eingaben: Alias, E-Mail, Rollen aus dem Katalog; org-admin auch ohne Eintrag in platform.json', () => {
    assert.deepEqual(orgBootstrapErrors({ alias: 'demo', email: 'a@demo.example', roles: ['org-admin', 'viewer'], catalogRoles: ROLES }), []);
    assert.deepEqual(orgBootstrapErrors({ alias: 'demo', email: 'a@demo.example', roles: ['org-admin', 'viewer'], catalogRoles: ['viewer'] }), []);
    const e = orgBootstrapErrors({ alias: 'Böse Firma', email: 'kaputt', roles: ['chef'], catalogRoles: ['viewer'] }).join('\n');
    for (const m of [/Alias/, /E-Mail/, /Unbekannte Rolle chef \(erlaubt: org-admin, viewer\)/]) assert.match(e, m);
  });

  test('platform.json ohne org-admin (ab 0.4.0): Gruppe org-admin entsteht trotzdem', async () => {
    const fake = new KeycloakFake();
    assert.ok(!ROLES.includes('org-admin'));
    await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', catalogRoles: ROLES, platformAdminRole: 'platform-admin' });
    assert.ok(paths(fake).includes('/orgs/demo/org-admin'));
  });

  test('legt Organisation, Gruppen aller Rollen, Person mit Rollen und Realm-Rolle an; zweiter Lauf ändert nichts', async () => {
    const fake = new KeycloakFake();
    const r = await orgBootstrap(admin(fake), { alias: 'Demo', name: 'Demo AG', email: 'Anna@Demo.example', firstName: 'Anna', lastName: 'Admin', roles: ['org-admin', 'editor'], catalogRoles: ROLES, platformAdminRole: 'platform-admin' });
    const org = [...fake.orgs.values()][0]!;
    assert.deepEqual([org.alias, org.name, org.domains], ['demo', 'Demo AG', [{ name: 'demo.invalid', verified: false }]]);
    assert.deepEqual(paths(fake), ['/orgs', '/orgs/demo', '/orgs/demo/editor', '/orgs/demo/org-admin', '/orgs/demo/viewer']);
    const u = fake.byEmail('anna@demo.example')!;
    assert.deepEqual([u.username, u.password, u.requiredActions, fake.orgMembers.get(org.id)!.has(u.id)], ['anna@demo.example', false, ['UPDATE_PASSWORD'], true]);
    assert.deepEqual(fake.rolesOf(org, u), ['editor', 'org-admin']);
    assert.deepEqual([...fake.realmRoleMappings.get(u.id)!], ['platform-admin']);
    assert.deepEqual([r.orgId, r.userId, r.passwordFile], [org.id, u.id, null]);

    const writes = () => fake.calls.filter(c => !c.startsWith('GET ')).length;
    const before = writes();
    const again = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', roles: ['org-admin', 'editor'], catalogRoles: ROLES, platformAdminRole: 'platform-admin' });
    assert.equal(writes(), before, 'idempotent');
    assert.deepEqual(again.steps, ['Organisation demo vorhanden', 'Person anna@demo.example vorhanden', 'Fertig.']);
  });

  test('mehrstufiges Präfix, bestehende Person aus anderer Organisation, Probelauf ohne Änderung', async () => {
    const fake = new KeycloakFake({ groupPrefix: '/kunden/orgs' });
    const other = fake.org('muster'), ben = fake.user('ben', { email: 'ben@muster.example' });
    fake.member(other, ben, ['viewer']);
    const dry = await orgBootstrap(admin(fake), { alias: 'demo', email: 'ben@muster.example', roles: ['viewer'], catalogRoles: ROLES, groupRolePrefix: '/kunden/orgs/', dryRun: true, initialPassword: { realm: 'notes', secretDir: dir } });
    assert.equal(fake.calls.filter(c => !c.startsWith('GET ')).length, 0, 'Probelauf schreibt nichts');
    assert.ok(dry.steps.includes('Organisation «demo» (demo) anlegen') && dry.steps.includes('Gruppe /kunden/orgs/demo anlegen'), dry.steps.join('\n'));
    assert.equal(fake.orgs.size, 1);
    await orgBootstrap(admin(fake), { alias: 'demo', email: 'ben@muster.example', roles: ['viewer'], catalogRoles: ROLES, groupRolePrefix: '/kunden/orgs/' });
    const demo = [...fake.orgs.values()].find(o => o.alias === 'demo')!;
    assert.ok(paths(fake).includes('/kunden/orgs/demo/org-admin') && paths(fake).includes('/kunden') && !paths(fake).some(p => p.includes('kunden/orgs/kunden')));
    assert.deepEqual([fake.rolesOf(demo, ben), fake.rolesOf(other, ben), fake.users.size], [['viewer'], ['viewer'], 1], 'Konto wiederverwendet');
  });

  test('temporäres Passwort nur ohne Passwort, nur in der Datei (0600, Verzeichnis 0700)', async () => {
    const fake = new KeycloakFake();
    const secretDir = join(dir, 'geheim');
    const log: string[] = [];
    const r = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', catalogRoles: ROLES, initialPassword: { realm: 'notes', secretDir }, log: m => log.push(m) });
    const pw = readFileSync(r.passwordFile!, 'utf8').trim();
    assert.equal(r.passwordFile, join(secretDir, 'initial-password-notes-anna@demo.example.txt'));
    assert.match(pw, /^.{20}$/);
    assert.deepEqual([statSync(r.passwordFile!).mode & 0o777, statSync(secretDir).mode & 0o777], [0o600, 0o700]);
    assert.ok(!log.join('\n').includes(pw), 'Passwort nie ausgegeben');
    assert.equal(fake.byEmail('anna@demo.example')!.password, true);
    const again = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', catalogRoles: ROLES, initialPassword: { realm: 'notes', secretDir } });
    assert.ok(again.steps.includes('anna@demo.example hat schon ein Passwort – nichts geändert'));
    assert.equal(readFileSync(r.passwordFile!, 'utf8').trim(), pw, 'Datei unverändert');
  });

  test('Passwortdatei sicher: Verzeichnis für andere offen, Datei oder Link schon da, Fehler beim Setzen → keine Datei; Realm im Namen bereinigt', async () => {
    const fake = new KeycloakFake();
    const run = (secretDir: string, email = 'ben@demo.example', realm = 'notes') => orgBootstrap(admin(fake), { alias: 'demo', email, catalogRoles: ROLES, initialPassword: { realm, secretDir } });
    const open = join(dir, 'offen');
    mkdirSync(open, { mode: 0o755 }); chmodSync(open, 0o755);
    await assert.rejects(run(open), /für andere zugänglich/);
    const safe = join(dir, 'sicher');
    // Link auf eine fremde Datei unter dem erwarteten Namen: nie folgen, nie überschreiben
    const target = join(dir, 'ziel.txt');
    writeFileSync(target, 'unberührt');
    mkdirSync(safe, { mode: 0o700 });
    symlinkSync(target, join(safe, 'initial-password-notes-ben@demo.example.txt'));
    await assert.rejects(run(safe), /besteht schon/);
    assert.equal(readFileSync(target, 'utf8'), 'unberührt');
    assert.equal(fake.byEmail('ben@demo.example')!.password, false, 'ohne Datei kein Passwort');
    // Keycloak lehnt ab: Datei wieder weg
    fake.fail = [{ re: /reset-password/, status: 500 }];
    await assert.rejects(run(safe, 'cleo@demo.example'));
    fake.fail = [];
    assert.ok(!existsSync(join(safe, 'initial-password-notes-cleo@demo.example.txt')));
    const r = await run(safe, 'dora@demo.example', '../Fremd');
    assert.equal(dirname(r.passwordFile!), safe, 'Realm ohne Pfadteile');
  });

  test('kein Passwort für Konten mit Identitätsanbieter (MFA dort); ungültiges Präfix', async () => {
    const fake = new KeycloakFake();
    const eva = fake.user('eva', { email: 'eva@demo.example', password: false });
    fake.links.set(eva.id, new Map([['entra-001', { userId: 'oid-eva', userName: 'eva@demo.example' }]]));
    const r = await orgBootstrap(admin(fake), { alias: 'demo', email: 'eva@demo.example', catalogRoles: ROLES, initialPassword: { realm: 'notes', secretDir: join(dir, 'eva') } });
    assert.ok(r.steps.includes('eva@demo.example meldet sich über einen Identitätsanbieter an – kein Passwort gesetzt'));
    assert.deepEqual([eva.password, r.passwordFile], [false, null]);
    for (const p of ['', '/', '/a//b', '/mit leer']) await assert.rejects(orgBootstrap(admin(fake), { alias: 'demo', email: 'eva@demo.example', catalogRoles: ROLES, groupRolePrefix: p }), /GROUP_ROLE_PREFIX/, p);
  });

  describe('Kommandozeile', () => {
    const fake = new KeycloakFake();
    let server: Server, base = '';
    const catalog = join(dir, 'platform.json');
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    before(async () => {
      writeFileSync(catalog, notesCatalog.platformJson());
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => void (async () => {
          const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
          const r = await fake.fetch(`http://idp.test${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body });
          const headers: Record<string, string> = {};
          r.headers.forEach((v, k) => { headers[k] = v; });
          res.writeHead(r.status, headers);
          res.end(Buffer.from(await r.arrayBuffer()));
        })());
      });
      await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => new Promise<void>(ok => server.close(() => ok())));
    const run = (args: string[], env: Record<string, string> = {}) => promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'src', 'bin', 'org-bootstrap.ts'), ...args], {
      env: { PATH: process.env.PATH, KEYCLOAK_TF_URL: base, KEYCLOAK_TF_REALM: 'notes', KEYCLOAK_IAC_PRIVATE_KEY: key, ...env },
    }).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }));

    test('legt an mit dem Service Account der Einrichtung (private_key_jwt, <realm>-iac)', async () => {
      const r = await run(['--catalog', catalog, '--alias', 'demo', '--email', 'anna@demo.example', '--roles', 'org-admin,viewer']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Organisation «demo» \(demo\) anlegen[\s\S]*Fertig\./);
      assert.deepEqual(fake.rolesOf([...fake.orgs.values()][0]!, fake.byEmail('anna@demo.example')!), ['org-admin', 'viewer']);
      const t = fake.tokenRequests.at(-1)!;
      assert.deepEqual([t.get('client_id'), t.get('client_assertion_type')], ['notes-iac', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer']);
    });

    test('Fehler: ohne Katalog, unbekannte Rolle, Realm master – Code 64, nichts angelegt', async () => {
      const n = fake.calls.length;
      for (const [args, env, m] of [
        [['--alias', 'x', '--email', 'a@b.ch'], {}, /--catalog fehlt/],
        [['--catalog', catalog, '--alias', 'x', '--email', 'a@b.ch', '--roles', 'chef'], {}, /Unbekannte Rolle chef/],
        [['--catalog', catalog, '--alias', 'x', '--email', 'a@b.ch'], { KEYCLOAK_TF_REALM: 'master' }, /master/],
      ] as [string[], Record<string, string>, RegExp][]) {
        const r = await run(args, env);
        assert.equal(r.code, 64, r.err);
        assert.match(r.err, m);
      }
      assert.equal(fake.calls.length, n);
    });
  });
});
