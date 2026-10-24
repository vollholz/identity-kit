/**
 * Zurücksetzen einer App (`resetKeycloak`, `resetDatabase`, Kommandozeile `iam-reset`) gegen den `KeycloakFake` und eine
 * Wegwerf-Datenbank: In Keycloak verschwinden Organisationen, ihre Identitätsanbieter und alle Personen, Service Accounts
 * und übrige Anbieter bleiben; in der Datenbank sind alle Tabellen des Schemas leer (Folgenummern neu), ausser
 * Migrationsbuchhaltung und `--keep-table`, Struktur und RLS bleiben. Probelauf zählt nur; danach lässt sich die App mit
 * `orgBootstrap` frisch aufsetzen. Die Kommandozeile verlangt `--confirm <realm>` und einen Teil.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { KeycloakFake } from '@vollholz/iam-testkit';
import { orgBootstrap } from '../src/bootstrap.ts';
import type { IamConfig } from '../src/config.ts';
import { KeycloakAdmin } from '../src/keycloak.ts';
import { migration } from '../src/migrations.ts';
import { resetDatabase, resetKeycloak } from '../src/reset.ts';
import { productDb, skipDb } from './support/db.ts';
import { runBin, serveFake } from './support/keycloak-http.ts';
import { notesModel } from './support/models.ts';

const ISSUER = 'http://idp.test/realms/notes';
const skip = await skipDb();
const admin = (fake: KeycloakFake) => new KeycloakAdmin({ oidc: { issuer: ISSUER }, mgmt: { adminUrl: null, timeoutMs: 5000 } } as unknown as Pick<IamConfig, 'oidc' | 'mgmt'>,
  async () => `${ISSUER}/protocol/openid-connect/token`, fake.fetch, { clientId: 'notes-iac', privateKey: null, clientSecret: 'x' });
const writes = (fake: KeycloakFake) => fake.calls.filter(c => !c.startsWith('GET ')).length;

/** Realm mit zwei Organisationen (eine mit eigener Entra-App), Personen, Service Account und einem Anbieter des Moduls. */
function realm() {
  const fake = new KeycloakFake();
  const a = fake.org('solutions'), b = fake.org('muster');
  const anna = fake.user('anna'), ben = fake.user('ben'), solo = fake.user('solo');
  fake.member(a, anna); fake.member(b, ben);
  fake.user('service-account-notes-admin', { email: '' });
  fake.idps.set('entra-app-solutions', { alias: 'entra-app-solutions', providerId: 'oidc', config: {} });
  fake.orgIdps.set(a.id, new Map([['entra-app-solutions', { autoMembership: false, membershipType: 'UNMANAGED' }]]));
  fake.idps.set('google', { alias: 'google', providerId: 'google', config: {} });
  fake.links.set(anna.id, new Map([['entra-app-solutions', { userId: 'oid-anna', userName: 'anna@example.ch' }]]));
  return { fake, solo };
}

describe('Keycloak zurücksetzen', () => {
  test('Probelauf zählt nur', async () => {
    const { fake } = realm();
    const log: string[] = [];
    const r = await resetKeycloak(admin(fake), { dryRun: true, log: m => log.push(m) });
    assert.deepEqual(r, { organizations: ['muster', 'solutions'], identityProviders: ['entra-app-solutions'], people: 3 });
    assert.equal(writes(fake), 0);
    assert.match(log.join('\n'), /^\[Probelauf\] Keycloak: 2 Organisationen \(muster, solutions\), 1 Identitätsanbieter von Organisationen \(entra-app-solutions\), 3 Personen würden gelöscht$/);
    assert.ok(!log.join('\n').includes('@'), 'keine Adressen in der Ausgabe');
  });

  test('Organisationen mit ihren Anbietern und alle Personen weg; Service Account und Anbieter des Moduls bleiben; wiederholbar', async () => {
    const { fake } = realm();
    await resetKeycloak(admin(fake));
    assert.deepEqual([fake.orgs.size, [...fake.idps.keys()], [...fake.users.values()].map(u => u.username)], [0, ['google'], ['service-account-notes-admin']]);
    const n = writes(fake);
    assert.deepEqual(await resetKeycloak(admin(fake)), { organizations: [], identityProviders: [], people: 0 });
    assert.equal(writes(fake), n, 'zweiter Lauf ändert nichts');
  });

  test('Fehler unterwegs bricht ab (kein stilles Weiterlaufen)', async () => {
    const { fake } = realm();
    fake.fail = [{ re: /^DELETE \/users\//, status: 500 }];
    await assert.rejects(resetKeycloak(admin(fake)), /Konto löschen|500/);
  });
});

describe('Datenbank zurücksetzen', { skip }, () => {
  // Tabellen der App: eine an den Mandanten gebunden (mit Folgenummer), eine Stammtabelle zum Behalten
  const app = { name: 'app', migrations: [migration('001_app.sql', `
    CREATE TABLE notes.note (tenant_id uuid NOT NULL REFERENCES notes.tenant(id), id bigint GENERATED ALWAYS AS IDENTITY, body text, PRIMARY KEY (tenant_id, id));
    CREATE TABLE notes.lookup (code text PRIMARY KEY);
    CREATE TABLE notes.lookup_ref (tenant_id uuid REFERENCES notes.tenant(id), code text);
  `)] };
  const db = productDb({ model: notesModel, sources: [app] });
  let t: Awaited<ReturnType<typeof db.create>>;
  before(async () => { t = await db.create(); });
  after(async () => { await t?.drop(); });
  const count = async (table: string) => Number((await t.inspect.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const seed = async () => {
    const fake = new KeycloakFake();
    const r = await orgBootstrap(admin(fake), { alias: 'demo', email: 'anna@demo.example', database: { url: t.adminUrl, schema: 'notes' } });
    await t.inspect.query("INSERT INTO notes.note (tenant_id, body) VALUES ($1, 'a'), ($1, 'b')", [r.tenantId]);
    await t.inspect.query("INSERT INTO notes.lookup VALUES ('x') ON CONFLICT DO NOTHING");
    return fake;
  };

  test('Probelauf zählt je Tabelle (trotz FORCE RLS), ändert nichts', async () => {
    await seed();
    const log: string[] = [];
    const r = await resetDatabase({ url: t.adminUrl, schema: 'notes', keep: ['lookup'], dryRun: true, log: m => log.push(m) });
    const rows = Object.fromEntries(r.tables.map(x => [x.name, x.rows]));
    assert.deepEqual([rows.tenant, rows.principal, rows.authz_tuple, rows.audit_log, rows.note], [1, 1, 1, 1, 2]);
    assert.deepEqual(r.kept, ['lookup']);
    assert.ok(!('lookup' in rows));
    assert.match(log.join('\n'), /\[Probelauf\] Datenbank: \d+ Tabellen im Schema notes würden geleert/);
    assert.deepEqual([await count('notes.tenant'), await count('notes.note')], [1, 2]);
  });

  test('ausgenommene Tabelle, auf die CASCADE wirken würde, oder unbekannte: Abbruch, nichts geleert', async () => {
    await assert.rejects(resetDatabase({ url: t.adminUrl, schema: 'notes', keep: ['lookup_ref'] }), /notes\.lookup_ref → notes\.tenant/);
    await assert.rejects(resetDatabase({ url: t.adminUrl, schema: 'notes', keep: ['gibtsnicht'] }), /gibtsnicht nicht im Schema notes/);
    await assert.rejects(resetDatabase({ url: t.adminUrl, schema: 'fehlt' }), /keine Tabellen/);
    assert.ok(await count('notes.tenant') > 0);
  });

  test('leert alles ausser Migrationen und --keep-table; Struktur, RLS und Folgenummern; danach frisch aufsetzbar', async () => {
    const force = async () => (await t.inspect.query("SELECT relname, relforcerowsecurity FROM pg_class WHERE relnamespace = 'notes'::regnamespace AND relkind = 'r' ORDER BY 1")).rows;
    const forcedBefore = await force();
    await resetDatabase({ url: t.adminUrl, schema: 'notes', keep: ['lookup'] });
    for (const x of ['tenant', 'principal', 'authz_tuple', 'audit_log', 'note', 'lookup_ref']) assert.equal(await count(`notes.${x}`), 0, x);
    assert.equal(await count('notes.lookup'), 1, '--keep-table bleibt');
    assert.ok(await count('public.schema_migrations') > 0, 'Migrationsbuchhaltung bleibt');
    assert.deepEqual(await force(), forcedBefore, 'FORCE ROW LEVEL SECURITY unverändert');
    assert.ok(forcedBefore.some(x => x.relname === 'audit_log' && x.relforcerowsecurity));
    await seed();
    assert.deepEqual((await t.inspect.query('SELECT id FROM notes.note ORDER BY id')).rows.map(x => Number(x.id)), [1, 2], 'Folgenummern neu');
    assert.equal(await count('notes.authz_tuple'), 1, 'neu aufgesetzt');
  });

  describe('Kommandozeile', () => {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    let fake: KeycloakFake, srv: Awaited<ReturnType<typeof serveFake>>;
    before(async () => { fake = realm().fake; srv = await serveFake(fake); });
    after(async () => { await srv?.close(); });
    const run = (args: string[], env: Record<string, string> = {}) => runBin('reset.ts', args, { KEYCLOAK_TF_URL: srv.base, KEYCLOAK_TF_REALM: 'notes', KEYCLOAK_IAC_PRIVATE_KEY_B64: Buffer.from(key).toString('base64'), DATABASE_ADMIN_URL: t.adminUrl, ...env });

    test('Fehler im Aufruf: ohne Teil, ohne oder falsches --confirm, Realm master, --keep-table ohne --database – Code 64, nichts geändert', async () => {
      const n = fake.calls.length, rows = await count('notes.tenant');
      for (const [args, env, m] of [
        [['--confirm', 'notes'], {}, /--keycloak und\/oder --database/],
        [['--keycloak'], {}, /--confirm notes fehlt/],
        [['--keycloak', '--database', '--confirm', 'assets'], {}, /entspricht nicht dem Realm notes/],
        [['--keycloak', '--confirm', 'master'], { KEYCLOAK_TF_REALM: 'master' }, /master/],
        [['--keycloak', '--confirm', 'notes', '--keep-table', 'lookup'], {}, /--keep-table nur mit --database/],
        [['--database', '--confirm', 'notes'], { DATABASE_ADMIN_URL: '' }, /DATABASE_ADMIN_URL fehlt/],
        [['--keycloak', '--confirm', 'notes'], { KEYCLOAK_IAC_PRIVATE_KEY_B64: '' }, /KEYCLOAK_IAC_PRIVATE_KEY/],
      ] as [string[], Record<string, string>, RegExp][]) {
        const r = await run(args, env);
        assert.equal(r.code, 64, `${args.join(' ')}: ${r.err}`);
        assert.match(r.err, m);
      }
      assert.deepEqual([fake.calls.length, await count('notes.tenant')], [n, rows]);
    });

    test('--dry-run zeigt Organisationen, Personen, Anzahl je Tabelle; ändert nichts', async () => {
      const r = await run(['--keycloak', '--database', '--confirm', 'notes', '--keep-table', 'lookup', '--dry-run']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Probelauf\] Datenbank: \d+ Tabellen im Schema notes würden geleert[\s\S]*  note +2[\s\S]*bleiben lookup[\s\S]*2 Organisationen \(muster, solutions\)[\s\S]*3 Personen würden gelöscht[\s\S]*nichts geändert/);
      assert.doesNotMatch(r.out, /^audit /m);
      assert.deepEqual([writes(fake), await count('notes.note')], [0, 2]);
    });

    test('setzt Datenbank und Keycloak zurück, Audit-Zeile platform.reset ohne Geheimnisse', async () => {
      const r = await run(['--keycloak', '--database', '--confirm', 'notes', '--keep-table', 'lookup']);
      assert.equal(r.code, 0, r.err);
      const line = r.out.split('\n').find(l => l.startsWith('audit '))!;
      const audit = JSON.parse(line.slice(6));
      assert.deepEqual([audit.action, audit.realm, audit.schema, audit.kept, audit.via], ['platform.reset', 'notes', 'notes', ['lookup'], 'iam-reset']);
      assert.ok(audit.rows >= 6);
      assert.match(r.out, /Fertig\.$/m);
      assert.ok(!r.out.includes(t.adminUrl) && !r.out.includes('PRIVATE'), 'keine Geheimnisse');
      assert.deepEqual([await count('notes.tenant'), await count('notes.lookup'), fake.orgs.size, fake.users.size], [0, 1, 0, 1]);
    });

    test('Fehler unterwegs: Code 1', async () => {
      const r = await run(['--database', '--confirm', 'notes', '--schema', 'fehlt']);
      assert.equal(r.code, 1, r.err);
      assert.match(r.err, /Abgebrochen: .*keine Tabellen/);
    });
  });
});
