/**
 * Ersteinrichtung einer Organisation (`orgBootstrap`, Kommandozeile `iam-org-bootstrap`; Spezifikation Kap. 2 Schritt 7,
 * A20) gegen den `KeycloakFake` und eine Wegwerf-Datenbank: In Keycloak Organisation, erste Person und Realm-Rolle, keine
 * Rollengruppen (A21); in der Datenbank Mandant (an die Organisation gebunden), Principal, Tupel org-admin an org,
 * Freigabestufe 2, Audit `tenant.provisioned`. Idempotent, Probelauf ohne Änderung, Einladung per E-Mail an neue Personen
 * (ohne SMTP nur Meldung), temporäres Passwort nur in einer Datei, Eingaben geprüft. Die Kommandozeile läuft als eigener Prozess gegen den Fake über HTTP.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { KeycloakFake } from '@vollholz/iam-testkit';
import { InitFileSchema, initFileErrors, inviteErrors, operatorBootstrap, orgBootstrap, orgBootstrapErrors, orgBootstrapFile, type InitFile } from '../src/bootstrap.ts';
import type { IamConfig } from '../src/config.ts';
import { KeycloakAdmin } from '../src/keycloak.ts';
import { productDb, skipDb } from './support/db.ts';
import { runBin, serveFake } from './support/keycloak-http.ts';
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

  test('nur Keycloak (database: null): Organisation, Person und Mitgliedschaft, keine Realm-Rolle, keine Gruppen; zweiter Lauf ändert nichts', async () => {
    const fake = new KeycloakFake();
    const r = await orgBootstrap(admin(fake), { alias: 'Demo', name: 'Demo AG', email: 'Anna@Demo.example', firstName: 'Anna', lastName: 'Admin', operatorRole: 'platform-admin', database: null });
    const org = [...fake.orgs.values()][0]!;
    assert.deepEqual([org.alias, org.name, org.domains], ['demo', 'Demo AG', [{ name: 'demo.invalid', verified: false }]]);
    assert.equal(fake.groups.size, 0, 'keine Rollengruppen (A21)');
    const u = fake.byEmail('anna@demo.example')!;
    assert.deepEqual([u.username, u.password, u.requiredActions, fake.orgMembers.get(org.id)!.has(u.id)], ['anna@demo.example', false, ['UPDATE_PASSWORD'], true]);
    assert.equal(fake.realmRoleMappings.get(u.id)?.size ?? 0, 0, 'Admins einer Organisation erhalten nie die Plattform-Administration');
    assert.deepEqual([r.orgId, r.userId, r.passwordFile, r.tenantId], [org.id, u.id, null, null]);
    assert.ok(r.steps.some(x => /^Nur Keycloak/.test(x)));

    const writes = () => fake.calls.filter(c => !c.startsWith('GET ')).length;
    const before = writes();
    const again = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', operatorRole: 'platform-admin', database: null });
    assert.equal(writes(), before, 'idempotent');
    assert.deepEqual(again.steps.filter(x => !/^Nur Keycloak/.test(x)), ['Organisation demo vorhanden', 'Person anna@demo.example vorhanden', 'Fertig.']);
  });

  test('Betrieb: Konto mit Realm-Rolle, ohne Organisation; idempotent; nie zugleich Admin einer Organisation', async () => {
    const fake = new KeycloakFake();
    const r = await operatorBootstrap(admin(fake), { email: 'Bea@Betrieb.example', firstName: 'Bea', lastName: 'Betrieb', platformAdminRole: 'platform-admin' });
    const bea = fake.byEmail('bea@betrieb.example')!;
    assert.deepEqual([bea.password, bea.requiredActions, [...fake.realmRoleMappings.get(bea.id)!]], [false, ['UPDATE_PASSWORD'], ['platform-admin']]);
    assert.equal(fake.orgs.size, 0, 'keine Organisation');
    assert.deepEqual([r.userId, r.orgId, r.tenantId], [bea.id, null, null]);
    const writes = () => fake.calls.filter(c => !c.startsWith('GET ')).length;
    const n = writes();
    await operatorBootstrap(admin(fake), { email: 'bea@betrieb.example', platformAdminRole: 'platform-admin' });
    assert.equal(writes(), n, 'idempotent');
    // Betrieb wird nicht Admin einer Organisation …
    await assert.rejects(orgBootstrap(admin(fake), { alias: 'kunde', email: 'bea@betrieb.example', operatorRole: 'platform-admin', database: null }), /Betrieb und Organisation nie mit demselben Konto/);
    // … und ein Mitglied einer Organisation nicht Betrieb
    await orgBootstrap(admin(fake), { alias: 'kunde', email: 'karl@kunde.example', operatorRole: 'platform-admin', database: null });
    await assert.rejects(operatorBootstrap(admin(fake), { email: 'karl@kunde.example', platformAdminRole: 'platform-admin' }), /Mitglied von kunde/);
    assert.equal(fake.realmRoleMappings.get(fake.byEmail('karl@kunde.example')!.id)?.size ?? 0, 0);
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
    const r = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', initialPassword: { realm: 'notes', secretDir }, log: m => log.push(m), database: null });
    const pw = readFileSync(r.passwordFile!, 'utf8').trim();
    assert.equal(r.passwordFile, join(secretDir, 'initial-password-notes-anna@demo.example.txt'));
    assert.match(pw, /^.{20}$/);
    assert.deepEqual([statSync(r.passwordFile!).mode & 0o777, statSync(secretDir).mode & 0o777], [0o600, 0o700]);
    assert.ok(!log.join('\n').includes(pw), 'Passwort nie ausgegeben');
    assert.equal(fake.byEmail('anna@demo.example')!.password, true);
    const again = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', initialPassword: { realm: 'notes', secretDir }, database: null });
    assert.ok(again.steps.includes('anna@demo.example hat schon ein Passwort – nichts geändert'));
    assert.equal(readFileSync(r.passwordFile!, 'utf8').trim(), pw, 'Datei unverändert');
  });

  test('Passwortdatei sicher: Verzeichnis für andere offen, Datei oder Link schon da, Fehler beim Setzen → keine Datei; Realm im Namen bereinigt', async () => {
    const fake = new KeycloakFake();
    const run = (secretDir: string, email = 'ben@demo.example', realm = 'notes') => orgBootstrap(admin(fake), { alias: 'demo', email, initialPassword: { realm, secretDir }, database: null });
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
    const r = await orgBootstrap(admin(fake), { alias: 'demo', email: 'eva@demo.example', initialPassword: { realm: 'notes', secretDir: join(dir, 'eva') }, database: null });
    assert.ok(r.steps.includes('eva@demo.example meldet sich über einen Identitätsanbieter an – kein Passwort gesetzt'));
    assert.deepEqual([eva.password, r.passwordFile], [false, null]);
  });

  describe('Einladung «Passwort festlegen» per E-Mail', () => {
    const mails = (fake: KeycloakFake) => fake.mails.filter(m => m.kind === 'actions');

    test('neue Person: Einladung mit UPDATE_PASSWORD, 7 Tage; zweiter Lauf sendet nicht erneut, --resend schon', async () => {
      const fake = new KeycloakFake();
      fake.smtp = true;
      const r = await orgBootstrap(admin(fake), { alias: 'demo', email: 'Anna@Demo.example', database: null });
      const u = fake.byEmail('anna@demo.example')!;
      assert.deepEqual([r.invitation, r.email], ['sent', 'anna@demo.example']);
      assert.deepEqual(mails(fake).map(m => [m.userId, m.actions, new URLSearchParams(m.query).get('lifespan')]), [[u.id, ['UPDATE_PASSWORD'], String(7 * 24 * 3600)]]);
      assert.ok(r.steps.includes('anna@demo.example: Einladung «Passwort festlegen» gesendet (gültig 7 Tage)'), r.steps.join('\n'));
      const again = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', database: null });
      assert.deepEqual([again.invitation, mails(fake).length], [null, 1], 'idempotent');
      const resend = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', resend: true, invite: { lifespanSec: 3600, clientId: 'notes-web', redirectUri: 'https://notes.example/' }, database: null });
      assert.equal(resend.invitation, 'sent');
      const q = new URLSearchParams(mails(fake)[1]!.query);
      assert.deepEqual([q.get('lifespan'), q.get('client_id'), q.get('redirect_uri')], ['3600', 'notes-web', 'https://notes.example/']);
    });

    test('--resend nie an Konten mit Passwort oder Identitätsanbieter', async () => {
      const fake = new KeycloakFake();
      fake.smtp = true;
      fake.user('ben', { email: 'ben@demo.example', password: true });
      const eva = fake.user('eva', { email: 'eva@demo.example', password: false });
      fake.links.set(eva.id, new Map([['entra-001', { userId: 'oid-eva', userName: 'eva@demo.example' }]]));
      const ben = await orgBootstrap(admin(fake), { alias: 'demo', email: 'ben@demo.example', resend: true, database: null });
      const e = await orgBootstrap(admin(fake), { alias: 'demo', email: 'eva@demo.example', resend: true, database: null });
      assert.deepEqual([ben.invitation, e.invitation, mails(fake).length], [null, null, 0]);
      assert.ok(ben.steps.includes('ben@demo.example hat schon ein Passwort – keine Einladung'));
      assert.ok(e.steps.includes('eva@demo.example meldet sich über einen Identitätsanbieter an – keine Einladung'));
    });

    test('ohne SMTP: klare Meldung, Lauf geht weiter; sendEmail: false und initialPassword senden nicht; Probelauf meldet nur', async () => {
      const fake = new KeycloakFake();
      const r = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', database: null });
      assert.equal(r.invitation, 'failed');
      assert.ok(r.steps.some(x => /Einladung NICHT gesendet.*SMTP/.test(x)), r.steps.join('\n'));
      assert.equal(r.steps.at(-1), 'Fertig.');
      fake.smtp = true;
      const off = await orgBootstrap(admin(fake), { alias: 'demo', email: 'ben@demo.example', sendEmail: false, database: null });
      const pw = await orgBootstrap(admin(fake), { alias: 'demo', email: 'cleo@demo.example', initialPassword: { realm: 'notes', secretDir: join(dir, 'cleo') }, database: null });
      assert.deepEqual([off.invitation, pw.invitation, mails(fake).length], [null, null, 0]);
      const dry = await orgBootstrap(admin(fake), { alias: 'probe', email: 'dora@demo.example', dryRun: true });
      assert.ok(dry.steps.includes('dora@demo.example: Einladung «Passwort festlegen» würde gesendet'), dry.steps.join('\n'));
      const dryResend = await orgBootstrap(admin(fake), { alias: 'demo', email: 'ben@demo.example', dryRun: true, resend: true });
      assert.ok(dryResend.steps.includes('ben@demo.example: Einladung «Passwort festlegen» würde gesendet (gültig 7 Tage)'), dryResend.steps.join('\n'));
      // neue Organisation, bestehende Person: wie im echten Lauf nur mit resend und nur ohne Passwort
      const dryNewOrg = await orgBootstrap(admin(fake), { alias: 'neu', email: 'ben@demo.example', dryRun: true });
      assert.ok(!dryNewOrg.steps.some(x => /Einladung/.test(x)), dryNewOrg.steps.join('\n'));
      const dryNewOrgResend = await orgBootstrap(admin(fake), { alias: 'neu', email: 'cleo@demo.example', dryRun: true, resend: true });
      assert.ok(dryNewOrgResend.steps.includes('cleo@demo.example hat schon ein Passwort – keine Einladung'), dryNewOrgResend.steps.join('\n'));
      assert.equal(mails(fake).length, 0, 'Probelauf sendet nicht');
    });

    test('Eingaben: Gültigkeit, Weiterleitung nur mit Client', async () => {
      assert.deepEqual(inviteErrors({ lifespanSec: 60, clientId: 'c', redirectUri: 'https://x/' }), []);
      assert.match(inviteErrors({ lifespanSec: 0 }).join(), /Gültigkeit/);
      assert.match(inviteErrors({ redirectUri: 'https://x/' }).join(), /--client-id/);
      await assert.rejects(orgBootstrap(admin(new KeycloakFake()), { alias: 'demo', email: 'a@demo.example', invite: { lifespanSec: -1 } }), /Gültigkeit/);
    });

    test('ohne Angabe der Datenbank Abbruch vor jeder Änderung; nur Keycloak nur ausdrücklich (database: null)', async () => {
      const fake = new KeycloakFake();
      await assert.rejects(orgBootstrap(admin(fake), { alias: 'demo', email: 'a@demo.example' }), /Datenbank fehlt.*org-admin/);
      assert.equal(fake.byEmail('a@demo.example'), null, 'nichts angelegt');
      const r = await orgBootstrap(admin(fake), { alias: 'demo', email: 'a@demo.example', database: null });
      assert.ok(r.steps.some(s => s.startsWith('Nur Keycloak (ausdrücklich)')));
      await assert.rejects(orgBootstrapFile(admin(fake), { organizations: [{ alias: 'b', admins: [{ email: 'z@b.example' }] }] }, { platformAdminRole: 'platform-admin' }), /Datenbank fehlt/);
    });

    test('--file: Einladung je neuem Admin, Ergebnis nennt die Adressen', async () => {
      const fake = new KeycloakFake();
      fake.smtp = true;
      const r = await orgBootstrapFile(admin(fake), { organizations: [{ alias: 'a', admins: [{ email: 'x@a.example' }, { email: 'y@a.example' }] }] }, { platformAdminRole: 'platform-admin', database: null });
      assert.deepEqual(r.map(x => [x.email, x.invitation]), [['x@a.example', 'sent'], ['y@a.example', 'sent']]);
      const off = await orgBootstrapFile(admin(fake), { organizations: [{ alias: 'b', admins: [{ email: 'z@b.example' }] }] }, { platformAdminRole: 'platform-admin', database: null, sendEmail: false });
      assert.deepEqual([off[0]!.invitation, mails(fake).length], [null, 2]);
    });
  });

  describe('mehrere Organisationen aus einer Datei (--file)', () => {
    const init: InitFile = { operators: [{ email: 'Bea@Betrieb.example', first: 'Bea', last: 'Betrieb' }], organizations: [
      { alias: 'solutions', name: 'Solutions', admins: [{ email: 'Anna@Solutions.example', first: 'Anna', last: 'Admin' }, { email: 'ben@solutions.example' }] },
      { alias: 'muster', admins: [{ email: 'cleo@muster.example' }] },
    ] };

    test('Format: mitgeliefertes JSON Schema entspricht der Prüfung', () => {
      const shipped = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'schema', 'init.schema.json'), 'utf8'));
      const { $schema: _draft, ...rest } = shipped;
      assert.deepEqual(rest, JSON.parse(JSON.stringify(InitFileSchema)));
      assert.deepEqual(initFileErrors({ $schema: './init.schema.json', ...init }), []);
    });

    test('Format: Fehler mit Pfad (unbekanntes Feld, Alias, leere Admins, E-Mail, doppelt)', () => {
      const e = (x: unknown) => initFileErrors(x).join('\n');
      assert.match(e({}), /operators oder organizations/);
      assert.match(e({ organizations: [] }), /operators oder organizations/);
      assert.deepEqual(initFileErrors({ operators: [{ email: 'b@betrieb.ch' }] }), [], 'nur Betrieb');
      assert.match(e({ operators: [{ email: 'b@x.ch' }, { email: 'B@x.ch' }] }), /\/operators\/1\/email: b@x.ch doppelt/);
      assert.match(e({ operators: [{ email: 'b@x.ch' }], organizations: [{ alias: 'a', admins: [{ email: 'B@x.ch' }] }] }), /\/organizations\/0\/admins\/0\/email: b@x.ch ist Betrieb/);
      assert.match(e({ organizations: [{ alias: 'a', admins: [{ email: 'a@b.ch' }], extra: 1 }] }), /\/organizations\/0/);
      assert.match(e({ organizations: [{ alias: 'Böse', admins: [{ email: 'a@b.ch' }] }] }), /\/organizations\/0\/alias/);
      assert.match(e({ organizations: [{ alias: 'a', admins: [] }] }), /\/organizations\/0\/admins/);
      assert.match(e({ organizations: [{ alias: 'a', admins: [{ email: 'kaputt' }] }] }), /\/organizations\/0\/admins\/0\/email/);
      assert.match(e({ organizations: [{ alias: 'a', admins: [{ email: 'a@b.ch', platformAdmin: true }] }] }), /\/organizations\/0\/admins\/0/, 'platformAdmin entfällt: Betrieb steht unter operators');
      assert.match(e({ organizations: [{ alias: 'a', admins: [{ email: 'a@b.ch' }] }, { alias: 'a', admins: [{ email: 'x@b.ch' }] }] }), /\/organizations\/1\/alias: a doppelt/);
      assert.match(e({ organizations: [{ alias: 'a', admins: [{ email: 'a@b.ch' }, { email: 'A@b.ch' }] }] }), /\/organizations\/0\/admins\/1\/email: a@b.ch doppelt/);
    });

    test('ohne Datenbank: Betrieb ohne Organisation, alle Organisationen und Admins ohne Realm-Rolle; Probelauf schreibt nichts; idempotent', async () => {
      const fake = new KeycloakFake();
      await orgBootstrapFile(admin(fake), init, { platformAdminRole: 'platform-admin', dryRun: true });
      assert.equal(fake.calls.filter(c => !c.startsWith('GET ')).length, 0, 'Probelauf schreibt nichts');
      await orgBootstrapFile(admin(fake), init, { platformAdminRole: 'platform-admin', database: null });
      const org = (alias: string) => [...fake.orgs.values()].find(o => o.alias === alias)!;
      assert.deepEqual([...fake.orgs.values()].map(o => [o.alias, o.name]).sort(), [['muster', 'muster'], ['solutions', 'Solutions']]);
      const anna = fake.byEmail('anna@solutions.example')!, ben = fake.byEmail('ben@solutions.example')!, cleo = fake.byEmail('cleo@muster.example')!;
      assert.deepEqual([...fake.orgMembers.get(org('solutions').id)!].sort(), [anna.id, ben.id].sort());
      assert.deepEqual([...fake.orgMembers.get(org('muster').id)!], [cleo.id]);
      const bea = fake.byEmail('bea@betrieb.example')!;
      assert.deepEqual([fake.realmRoleMappings.get(bea.id)?.size, fake.realmRoleMappings.get(anna.id)?.size ?? 0, fake.realmRoleMappings.get(ben.id)?.size ?? 0], [1, 0, 0]);
      assert.ok(![...fake.orgMembers.values()].some(m => m.has(bea.id)), 'Betrieb in keiner Organisation');
      const writes = fake.calls.filter(c => !c.startsWith('GET ')).length;
      await orgBootstrapFile(admin(fake), init, { platformAdminRole: 'platform-admin', database: null });
      assert.equal(fake.calls.filter(c => !c.startsWith('GET ')).length, writes, 'idempotent');
      await assert.rejects(orgBootstrapFile(admin(fake), { organizations: [] }, { platformAdminRole: 'platform-admin', database: null }), /operators oder organizations/);
    });

    test('mit Datenbank: je Admin org-admin an org und Freigabestufe 2', { skip }, async () => {
      const db = productDb({ model: notesModel });
      const t = await db.create();
      try {
        const fake = new KeycloakFake();
        const r = await orgBootstrapFile(admin(fake), init, { platformAdminRole: 'platform-admin', database: { url: t.adminUrl, schema: 'notes' } });
        assert.equal(r.length, 4);
        assert.deepEqual([r[0]!.email, r[0]!.tenantId], ['bea@betrieb.example', null], 'Betrieb ohne Mandant');
        const rows = (await t.inspect.query(
          `SELECT x.alias, p.email, p.clearance, a.relation FROM notes.tenant x JOIN notes.principal p ON p.tenant_id = x.id
             JOIN notes.authz_tuple a ON a.tenant_id = x.id AND a.subject = 'user:' || p.id AND a.object_type = 'org' ORDER BY 1, 2`)).rows;
        assert.deepEqual(rows.map(x => [x.alias, x.email, x.clearance, x.relation]), [
          ['muster', 'cleo@muster.example', 2, 'org-admin'], ['solutions', 'anna@solutions.example', 2, 'org-admin'], ['solutions', 'ben@solutions.example', 2, 'org-admin'],
        ]);
        assert.equal(Number((await t.inspect.query("SELECT count(*) AS n FROM notes.audit_log WHERE action = 'tenant.provisioned'")).rows[0].n), 3, 'je Admin ein tenant.provisioned');
      } finally { await t.drop(); }
    });
  });

  describe('Kommandozeile', { skip }, () => {
    const fake = new KeycloakFake();
    const db = productDb({ model: notesModel });
    let t: Awaited<ReturnType<typeof db.create>>;
    let srv: Awaited<ReturnType<typeof serveFake>>;
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    before(async () => { t = await db.create(); srv = await serveFake(fake); });
    after(async () => { await srv?.close(); await t?.drop(); });
    const run = (args: string[], env: Record<string, string> = {}) => runBin('org-bootstrap.ts', args, { KEYCLOAK_TF_URL: srv.base, KEYCLOAK_TF_REALM: 'notes', KEYCLOAK_IAC_PRIVATE_KEY: key, DATABASE_ADMIN_URL: t.adminUrl, ...env });

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

    test('Einladung: Zusammenfassung nennt die Adressen; ohne SMTP Meldung und trotzdem Code 0; --resend, --invite-days, --client-id', async () => {
      const r = await run(['--alias', 'mail', '--email', 'nina@mail.example']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Einladung NICHT gesendet an: nina@mail\.example – SMTP/);
      fake.smtp = true;
      try {
        const ok = await run(['--alias', 'mail', '--email', 'otto@mail.example', '--invite-days', '3', '--client-id', 'notes-web', '--redirect-uri', 'https://notes.example/']);
        assert.equal(ok.code, 0, ok.err);
        assert.match(ok.out, /Einladung gesendet an: otto@mail\.example\n/);
        const q = new URLSearchParams(fake.mails.at(-1)!.query);
        assert.deepEqual([q.get('lifespan'), q.get('client_id'), q.get('redirect_uri')], [String(3 * 24 * 3600), 'notes-web', 'https://notes.example/']);
        const again = await run(['--alias', 'mail', '--email', 'nina@mail.example', '--resend']);
        assert.match(again.out, /Einladung gesendet an: nina@mail\.example/);
        const n = fake.mails.length;
        const off = await run(['--alias', 'mail', '--email', 'paul@mail.example', '--no-email']);
        assert.equal(off.code, 0, off.err);
        assert.ok(!/Einladung/.test(off.out) && fake.mails.length === n, off.out);
      } finally { fake.smtp = false; }
    });

    test('Fehler: ohne Alias, E-Mail ungültig, Realm master, ohne Datenbank – Code 64, nichts angelegt', async () => {
      const n = fake.calls.length;
      for (const [args, env, m] of [
        [['--email', 'a@b.ch'], {}, /--alias fehlt/],
        [['--alias', 'x', '--email', 'a@b.ch', '--falsch'], {}, /--falsch/],
        [['--alias', 'x', '--email', 'kaputt'], {}, /E-Mail/],
        [['--alias', 'x', '--email', 'a@b.ch'], { KEYCLOAK_TF_REALM: 'master' }, /master/],
        [['--alias', 'x', '--email', 'a@b.ch'], { DATABASE_ADMIN_URL: '' }, /DATABASE_ADMIN_URL fehlt/],
        [['--alias', 'x', '--email', 'a@b.ch', '--no-email', '--resend'], {}, /--resend nicht zusammen mit --no-email/],
        [['--alias', 'x', '--email', 'a@b.ch', '--initial-password', '--resend'], {}, /Alternative zur Einladung/],
        [['--alias', 'x', '--email', 'a@b.ch', '--invite-days', '0'], {}, /--invite-days/],
        [['--alias', 'x', '--email', 'a@b.ch', '--redirect-uri', 'https://x/'], {}, /--client-id/],
      ] as [string[], Record<string, string>, RegExp][]) {
        const r = await run(args, env);
        assert.equal(r.code, 64, r.err);
        assert.match(r.err, m);
      }
      assert.equal(fake.calls.length, n);
    });
    test('--file: alle Organisationen aus der Datei; nicht zusammen mit Einzel-Flags; ungültige Datei → Code 64', async () => {
      const file = join(mkdtempSync(join(tmpdir(), 'iam-init-')), 'init.json');
      writeFileSync(file, JSON.stringify({ operators: [{ email: 'otto@betrieb.example' }], organizations: [{ alias: 'datei', name: 'Datei AG', admins: [{ email: 'dora@datei.example' }, { email: 'emil@datei.example' }] }] }));
      const r = await run(['--file', file]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /— Betrieb: otto@betrieb\.example[\s\S]*— datei: dora@datei\.example[\s\S]*— datei: emil@datei\.example[\s\S]*Fertig\./);
      const rows = (await t.inspect.query("SELECT p.email FROM notes.principal p JOIN notes.tenant x ON x.id = p.tenant_id JOIN notes.authz_tuple a ON a.subject = 'user:' || p.id WHERE x.alias = 'datei' AND a.relation = 'org-admin' ORDER BY 1")).rows;
      assert.deepEqual(rows.map(x => x.email), ['dora@datei.example', 'emil@datei.example']);
      assert.ok(fake.realmRoleMappings.get(fake.byEmail('otto@betrieb.example')!.id)?.has('platform-admin'));
      for (const m of ['dora@datei.example', 'emil@datei.example']) assert.ok(!fake.realmRoleMappings.get(fake.byEmail(m)!.id)?.size, m);

      const n = fake.calls.length;
      const bad = join(dirname(file), 'bad.json');
      writeFileSync(bad, JSON.stringify({ organizations: [{ alias: 'x', admins: [] }] }));
      for (const [args, m] of [
        [['--file', file, '--alias', 'x'], /nicht zusammen mit --alias/],
        [['--file', file, '--operator'], /nicht zusammen mit --operator/],
        [['--operator', '--email', 'x@y.example', '--alias', 'x'], /--operator .* nicht zusammen mit --alias/],
        [['--platform-admin', '--alias', 'x', '--email', 'x@y.example'], /platform-admin/],
        [['--file', bad], /ungültig[\s\S]*\/organizations\/0\/admins/],
        [['--file', join(dirname(file), 'fehlt.json')], /fehlt\.json/],
      ] as [string[], RegExp][]) {
        const x = await run(args);
        assert.equal(x.code, 64, x.err);
        assert.match(x.err, m);
      }
      assert.equal(fake.calls.length, n, 'nichts angelegt');
    });

    test('--manifest: Organisationen aus identity.app.json (übrige Felder unbeachtet); --keycloak-only nur ausdrücklich', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'iam-manifest-'));
      const manifest = join(dir, 'identity.app.json');
      writeFileSync(manifest, JSON.stringify({ product: 'notes', realm: { entra: true }, organizations: [{ alias: 'manifest', admins: [{ email: 'mia@manifest.example' }] }] }));
      const r = await run(['--manifest', manifest]);
      assert.equal(r.code, 0, r.err);
      const rows = (await t.inspect.query("SELECT p.email FROM notes.principal p JOIN notes.tenant x ON x.id = p.tenant_id JOIN notes.authz_tuple a ON a.subject = 'user:' || p.id WHERE x.alias = 'manifest' AND a.relation = 'org-admin'")).rows;
      assert.deepEqual(rows.map(x => x.email), ['mia@manifest.example']);

      const only = await run(['--alias', 'nurkc', '--email', 'kim@nurkc.example', '--keycloak-only'], { DATABASE_ADMIN_URL: '' });
      assert.equal(only.code, 0, only.err);
      assert.match(only.out, /Nur Keycloak \(ausdrücklich\)/);
      assert.equal((await t.inspect.query("SELECT 1 FROM notes.tenant WHERE alias = 'nurkc'")).rowCount, 0);

      const n = fake.calls.length;
      const noOrgs = join(dir, 'ohne.json');
      writeFileSync(noOrgs, JSON.stringify({ product: 'notes' }));
      for (const [args, m] of [
        [['--manifest', noOrgs], /\/organizations: fehlt/],
        [['--manifest', manifest, '--file', manifest], /--file nicht zusammen mit --manifest/],
        [['--manifest', manifest, '--email', 'a@b.ch'], /--manifest nicht zusammen mit --email/],
        [['--alias', 'x', '--email', 'a@b.ch', '--keycloak-only'], /--keycloak-only nicht zusammen mit DATABASE_ADMIN_URL/],
      ] as [string[], RegExp][]) {
        const x = await run(args);
        assert.equal(x.code, 64, x.err);
        assert.match(x.err, m);
      }
      assert.equal(fake.calls.length, n, 'nichts angelegt');
    });
  });
});
