/**
 * Ersteinrichtung einer Organisation (`orgBootstrap`, Kommandozeile `iam-org-bootstrap`; Spezifikation Kap. 2 Schritt 7,
 * A20) gegen den `KeycloakFake` und eine Wegwerf-Datenbank: In Keycloak Organisation, erste Person und Realm-Rolle, keine
 * Rollengruppen (A21); in der Datenbank Mandant (an die Organisation gebunden), Principal, Tupel org-admin an org,
 * Freigabestufe 2, Audit `tenant.provisioned`. Idempotent, Probelauf ohne Änderung, temporäres Passwort nur in einer
 * Datei, Eingaben geprüft. Die Kommandozeile läuft als eigener Prozess gegen den Fake über HTTP.
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
import { productDb, skipDb } from './support/db.ts';
import { notesModel } from './support/models.ts';

const ISSUER = 'http://idp.test/realms/notes';
const skip = await skipDb();
const admin = (fake: KeycloakFake) => new KeycloakAdmin({ oidc: { issuer: ISSUER }, mgmt: { adminUrl: null, timeoutMs: 5000 } } as unknown as Pick<IamConfig, 'oidc' | 'mgmt'>,
  async () => `${ISSUER}/protocol/openid-connect/token`, fake.fetch, { clientId: 'notes-iac', privateKey: null, clientSecret: 'x' });

describe('Ersteinrichtung einer Organisation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iam-bootstrap-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('Eingaben: Alias und E-Mail', () => {
    assert.deepEqual(orgBootstrapErrors({ alias: 'demo', email: 'a@demo.example' }), []);
    const e = orgBootstrapErrors({ alias: 'Böse Firma', email: 'kaputt' }).join('\n');
    for (const m of [/Alias/, /E-Mail/]) assert.match(e, m);
  });

  test('ohne Datenbank: Organisation, Person, Mitgliedschaft und Realm-Rolle, keine Gruppen; zweiter Lauf ändert nichts', async () => {
    const fake = new KeycloakFake();
    const r = await orgBootstrap(admin(fake), { alias: 'Demo', name: 'Demo AG', email: 'Anna@Demo.example', firstName: 'Anna', lastName: 'Admin', platformAdminRole: 'platform-admin' });
    const org = [...fake.orgs.values()][0]!;
    assert.deepEqual([org.alias, org.name, org.domains], ['demo', 'Demo AG', [{ name: 'demo.invalid', verified: false }]]);
    assert.equal(fake.groups.size, 0, 'keine Rollengruppen (A21)');
    const u = fake.byEmail('anna@demo.example')!;
    assert.deepEqual([u.username, u.password, u.requiredActions, fake.orgMembers.get(org.id)!.has(u.id)], ['anna@demo.example', false, ['UPDATE_PASSWORD'], true]);
    assert.deepEqual([...fake.realmRoleMappings.get(u.id)!], ['platform-admin']);
    assert.deepEqual([r.orgId, r.userId, r.passwordFile, r.tenantId], [org.id, u.id, null, null]);
    assert.ok(r.steps.some(x => /Ohne Datenbank/.test(x)));

    const writes = () => fake.calls.filter(c => !c.startsWith('GET ')).length;
    const before = writes();
    const again = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', platformAdminRole: 'platform-admin' });
    assert.equal(writes(), before, 'idempotent');
    assert.deepEqual(again.steps.filter(x => !/Ohne Datenbank/.test(x)), ['Organisation demo vorhanden', 'Person anna@demo.example vorhanden', 'Fertig.']);
  });

  describe('mit Datenbank der App (A20)', { skip }, () => {
    const db = productDb({ model: notesModel });
    let t: Awaited<ReturnType<typeof db.create>>;
    before(async () => { t = await db.create(); });
    after(async () => { await t?.drop(); });
    const row = async (alias: string) => (await t.inspect.query(
      `SELECT x.kc_org_id, p.subject, p.clearance, array(SELECT relation || '@' || object_type FROM notes.authz_tuple a WHERE a.subject = 'user:' || p.id ORDER BY 1) AS tuples
         FROM notes.tenant x JOIN notes.principal p ON p.tenant_id = x.id WHERE x.alias = $1`, [alias])).rows;

    test('Mandant an die Organisation gebunden, Principal, org-admin an org, Stufe 2, Audit; idempotent', async () => {
      const fake = new KeycloakFake();
      const database = { url: t.adminUrl, schema: 'notes' };
      const r = await orgBootstrap(admin(fake), { alias: 'demo', name: 'Demo AG', email: 'anna@demo.example', database });
      const u = fake.byEmail('anna@demo.example')!;
      assert.deepEqual(await row('demo'), [{ kc_org_id: r.orgId, subject: u.id, clearance: 2, tuples: ['org-admin@org'] }]);
      assert.ok(r.tenantId && r.principalId);
      const audit = async () => (await t.inspect.query("SELECT data FROM notes.audit_log WHERE action = 'tenant.provisioned' AND tenant_id = $1", [r.tenantId])).rows;
      assert.deepEqual((await audit()).map(a => [a.data.alias, a.data.kcOrgId, a.data.admin]), [['demo', r.orgId, `user:${r.principalId}`]]);
      const again = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', database });
      assert.deepEqual([again.tenantId, again.principalId], [r.tenantId, r.principalId]);
      assert.equal((await audit()).length, 1, 'kein zweites tenant.provisioned');
      assert.ok(!again.steps.some(x => /Rolle org-admin|Freigabestufe 2|anlegen/.test(x)), again.steps.join('\n'));
    });

    test('bestehende Person aus anderer Organisation, Probelauf ohne Änderung in Keycloak und Datenbank', async () => {
      const fake = new KeycloakFake();
      const other = fake.org('muster'), ben = fake.user('ben', { email: 'ben@muster.example' });
      fake.member(other, ben);
      const database = { url: t.adminUrl, schema: 'notes' };
      const dry = await orgBootstrap(admin(fake), { alias: 'probe', email: 'ben@muster.example', database, dryRun: true, initialPassword: { realm: 'notes', secretDir: dir } });
      assert.equal(fake.calls.filter(c => !c.startsWith('GET ')).length, 0, 'Probelauf schreibt nichts');
      assert.ok(dry.steps.includes('Organisation «probe» (probe) anlegen'), dry.steps.join('\n'));
      assert.deepEqual(await row('probe'), [], 'Probelauf schreibt nichts in die Datenbank');
      await orgBootstrap(admin(fake), { alias: 'probe', email: 'ben@muster.example', database });
      const probe = [...fake.orgs.values()].find(o => o.alias === 'probe')!;
      assert.ok(fake.orgMembers.get(probe.id)!.has(ben.id) && fake.orgMembers.get(other.id)!.has(ben.id));
      assert.equal(fake.users.size, 1, 'Konto wiederverwendet');
      assert.deepEqual((await row('probe')).map(x => x.tuples), [['org-admin@org']]);
    });

    test('Mandant an eine andere Organisation gebunden: Abbruch, nichts geschrieben', async () => {
      await t.inspect.query("INSERT INTO notes.tenant (alias, kc_org_id, name) VALUES ('fremd', 'andere-org-id', 'Fremd')");
      const fake = new KeycloakFake();
      await assert.rejects(orgBootstrap(admin(fake), { alias: 'fremd', email: 'x@fremd.example', database: { url: t.adminUrl, schema: 'notes' } }), /anderen Organisation/);
      assert.deepEqual(await row('fremd'), []);
    });
  });

  test('temporäres Passwort nur ohne Passwort, nur in der Datei (0600, Verzeichnis 0700)', async () => {
    const fake = new KeycloakFake();
    const secretDir = join(dir, 'geheim');
    const log: string[] = [];
    const r = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', initialPassword: { realm: 'notes', secretDir }, log: m => log.push(m) });
    const pw = readFileSync(r.passwordFile!, 'utf8').trim();
    assert.equal(r.passwordFile, join(secretDir, 'initial-password-notes-anna@demo.example.txt'));
    assert.match(pw, /^.{20}$/);
    assert.deepEqual([statSync(r.passwordFile!).mode & 0o777, statSync(secretDir).mode & 0o777], [0o600, 0o700]);
    assert.ok(!log.join('\n').includes(pw), 'Passwort nie ausgegeben');
    assert.equal(fake.byEmail('anna@demo.example')!.password, true);
    const again = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', initialPassword: { realm: 'notes', secretDir } });
    assert.ok(again.steps.includes('anna@demo.example hat schon ein Passwort – nichts geändert'));
    assert.equal(readFileSync(r.passwordFile!, 'utf8').trim(), pw, 'Datei unverändert');
  });

  test('Passwortdatei sicher: Verzeichnis für andere offen, Datei oder Link schon da, Fehler beim Setzen → keine Datei; Realm im Namen bereinigt', async () => {
    const fake = new KeycloakFake();
    const run = (secretDir: string, email = 'ben@demo.example', realm = 'notes') => orgBootstrap(admin(fake), { alias: 'demo', email, initialPassword: { realm, secretDir } });
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

  test('kein Passwort für Konten mit Identitätsanbieter (MFA dort)', async () => {
    const fake = new KeycloakFake();
    const eva = fake.user('eva', { email: 'eva@demo.example', password: false });
    fake.links.set(eva.id, new Map([['entra-001', { userId: 'oid-eva', userName: 'eva@demo.example' }]]));
    const r = await orgBootstrap(admin(fake), { alias: 'demo', email: 'eva@demo.example', initialPassword: { realm: 'notes', secretDir: join(dir, 'eva') } });
    assert.ok(r.steps.includes('eva@demo.example meldet sich über einen Identitätsanbieter an – kein Passwort gesetzt'));
    assert.deepEqual([eva.password, r.passwordFile], [false, null]);
  });

  describe('Kommandozeile', { skip }, () => {
    const fake = new KeycloakFake();
    const db = productDb({ model: notesModel });
    let t: Awaited<ReturnType<typeof db.create>>;
    let server: Server, base = '';
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    before(async () => {
      t = await db.create();
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
    after(async () => { await new Promise<void>(ok => server.close(() => ok())); await t?.drop(); });
    const run = (args: string[], env: Record<string, string> = {}) => promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'src', 'bin', 'org-bootstrap.ts'), ...args], {
      env: { PATH: process.env.PATH, KEYCLOAK_TF_URL: base, KEYCLOAK_TF_REALM: 'notes', KEYCLOAK_IAC_PRIVATE_KEY: key, DATABASE_ADMIN_URL: t.adminUrl, ...env },
    }).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }));

    test('legt an mit dem Service Account der Einrichtung (private_key_jwt, <realm>-iac)', async () => {
      const r = await run(['--alias', 'demo', '--email', 'anna@demo.example']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Organisation «demo» \(demo\) anlegen[\s\S]*Rolle org-admin an der Organisation[\s\S]*Fertig\./);
      const sub = fake.byEmail('anna@demo.example')!.id;
      const rows = (await t.inspect.query("SELECT a.relation, p.clearance FROM notes.authz_tuple a JOIN notes.principal p ON a.subject = 'user:' || p.id WHERE p.subject = $1", [sub])).rows;
      assert.deepEqual(rows, [{ relation: 'org-admin', clearance: 2 }]);
      const tr = fake.tokenRequests.at(-1)!;
      assert.deepEqual([tr.get('client_id'), tr.get('client_assertion_type')], ['notes-iac', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer']);
    });

    test('Fehler: ohne Alias, E-Mail ungültig, Realm master, ohne Datenbank – Code 64, nichts angelegt', async () => {
      const n = fake.calls.length;
      for (const [args, env, m] of [
        [['--email', 'a@b.ch'], {}, /--alias fehlt/],
        [['--alias', 'x', '--email', 'kaputt'], {}, /E-Mail/],
        [['--alias', 'x', '--email', 'a@b.ch'], { KEYCLOAK_TF_REALM: 'master' }, /master/],
        [['--alias', 'x', '--email', 'a@b.ch'], { DATABASE_ADMIN_URL: '' }, /DATABASE_ADMIN_URL fehlt/],
      ] as [string[], Record<string, string>, RegExp][]) {
        const r = await run(args, env);
        assert.equal(r.code, 64, r.err);
        assert.match(r.err, m);
      }
      assert.equal(fake.calls.length, n);
    });
  });
});
