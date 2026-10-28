import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { fileHash, manifestErrors, repoChecks, type Finding, type Lock } from '@vollholz/iam-testkit';
import { KIT_VERSION, keyPair, managedFiles, planSync } from '../src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'create-iam-app-'));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(import.meta.dirname, '..', 'src', 'bin', 'create-iam-app.ts');
const run = (args: string[]) => promisify(execFile)(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH, HOME: root } })
  .then(r => ({ code: 0, out: r.stdout, err: r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }));
const failed = (f: Finding[]) => f.filter(x => x.status === 'fail').map(x => `${x.check}: ${x.details.join('; ')}`);
const init = (dir: string, extra: string[] = []) => run(['init', '--dir', dir, '--product', 'notes', '--name', 'Notes', '--url', 'https://notes.example.ch', '--keycloak', 'https://id.example.ch',
  '--entra', '--admin', 'anna@demo.example', '--org', 'demo', '--operator', 'betrieb@demo.example', '--state-bucket', 'notes-state', '--state-region', 'nbg1', '--state-endpoint', 'https://nbg1.example.com', ...extra]);

/** Neue App; @vollholz/iam aus dem Workspace, damit das Modell lädt. */
function newApp(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'node_modules', '@vollholz'), { recursive: true });
  symlinkSync(join(import.meta.dirname, '..', '..', 'iam'), join(dir, 'node_modules', '@vollholz', 'iam'));
  return dir;
}

describe('init', () => {
  test('Manifest, verwaltete Dateien mit Kopf, Dateien der App, Lock-Datei – und konform', async () => {
    const dir = newApp('neu');
    const r = await init(dir);
    assert.equal(r.code, 0, r.out + r.err);
    const m = JSON.parse(readFileSync(join(dir, 'identity.app.json'), 'utf8'));
    assert.deepEqual(manifestErrors(m), []);
    assert.deepEqual([m.product, m.realm.entra, m.organizations[0].alias, m.organizations[0].admins[0]], ['notes', true, 'demo', { email: 'anna@demo.example' }]);
    assert.deepEqual(m.operators, [{ email: 'betrieb@demo.example' }], 'Betrieb ohne Organisation');
    const lock = JSON.parse(readFileSync(join(dir, '.identity-kit.lock'), 'utf8')) as Lock;
    assert.equal(lock.kit, KIT_VERSION);
    assert.deepEqual(Object.keys(lock.files).sort(), [...managedFiles().keys()].sort());
    for (const [p, h] of Object.entries(lock.files)) {
      const text = readFileSync(join(dir, p), 'utf8');
      assert.equal(fileHash(text), h, p);
      assert.match(text.slice(0, 300), /Verwaltet von identity-kit \(create-iam-app \d+\.\d+\.\d+\)/, p);
      assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, `${p}: Platzhalter ersetzt`);
    }
    assert.equal(statSync(join(dir, 'infra/keycloak/kc.sh')).mode & 0o111, 0o111, 'kc.sh ausführbar');
    for (const p of ['src/authz/model.ts', 'infra/keycloak/platform.json', 'db/migrations/.gitkeep', '.npmrc', '.nvmrc', 'package.json']) assert.ok(existsSync(join(dir, p)), p);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.match(pkg.dependencies['@vollholz/iam'], /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.scripts['identity:first-org'], 'iam-org-bootstrap --manifest identity.app.json');

    const { findings } = await repoChecks(dir);
    assert.deepEqual(failed(findings), [], 'frisches Gerüst ist konform');
    // platform.json der Vorlage = Modell der Vorlage
    const { model } = await import(join(dir, 'src/authz/model.ts')) as { model: { platformJson(): string } };
    assert.equal(readFileSync(join(dir, 'infra/keycloak/platform.json'), 'utf8'), model.platformJson());
  });

  test('bestehendes Manifest: keine Angaben nötig, Angaben abgelehnt; Dateien der App bleiben unverändert', async () => {
    const dir = newApp('bestehend');
    assert.equal((await init(dir)).code, 0);
    writeFileSync(join(dir, 'src/authz/model.ts'), '// eigenes Modell\n');
    const again = await run(['init', '--dir', dir]);
    assert.equal(again.code, 0, again.err);
    assert.equal(readFileSync(join(dir, 'src/authz/model.ts'), 'utf8'), '// eigenes Modell\n');
    const r = await run(['init', '--dir', dir, '--product', 'x']);
    assert.equal(r.code, 64);
    assert.match(r.err, /besteht schon/);
  });

  test('Aufruf falsch: Angaben fehlen, ungültig, unbekannter Befehl', async () => {
    for (const [args, code, m] of [
      [['init', '--dir', newApp('leer')], 64, /--product fehlt/],
      [['init', '--dir', newApp('ungueltig'), '--product', 'master', '--name', 'X', '--url', 'https://x.ch', '--keycloak', 'https://id.ch'], 1, /\/product/],
      [['loeschen'], 64, /unbekannter Befehl/],
      [['init', '--dir', newApp('admin'), '--product', 'notes', '--name', 'X', '--url', 'https://x.ch', '--keycloak', 'https://id.ch', '--admin', 'a@b.ch'], 64, /--admin braucht --org/],
    ] as [string[], number, RegExp][]) {
      const r = await run(args);
      assert.equal(r.code, code, r.out + r.err);
      assert.match(r.err, m);
    }
  });
});

describe('sync und check', () => {
  test('von Hand geändert: Konflikt ohne Änderung, --force stellt her; check meldet; entfallene Datei gelöscht', async () => {
    const dir = newApp('sync');
    assert.equal((await init(dir)).code, 0);
    assert.equal((await run(['check', '--dir', dir])).code, 0);
    const main = join(dir, 'infra/keycloak/main.tf');
    const original = readFileSync(main, 'utf8');
    writeFileSync(main, `${original}\n# eigene Zeile\n`);
    const c = await run(['check', '--dir', dir]);
    assert.equal(c.code, 1);
    assert.match(c.out, /KONFLIKT +infra\/keycloak\/main\.tf \(von Hand geändert\)/);
    const s = await run(['sync', '--dir', dir]);
    assert.equal(s.code, 1);
    assert.match(s.err, /Von Hand geänderte Dateien[\s\S]*main\.tf/);
    assert.match(readFileSync(main, 'utf8'), /eigene Zeile/, 'nichts geändert');
    assert.equal((await run(['sync', '--dir', dir, '--force'])).code, 0);
    assert.equal(readFileSync(main, 'utf8'), original);

    // Datei, die eine frühere Version verwaltete: unverändert → gelöscht, geändert → behalten
    const lockFile = join(dir, '.identity-kit.lock');
    const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as Lock;
    writeFileSync(join(dir, 'infra/keycloak/alt.tf'), '# alt\n');
    writeFileSync(join(dir, 'infra/keycloak/alt2.tf'), '# alt2 geändert\n');
    lock.files['infra/keycloak/alt.tf'] = fileHash('# alt\n');
    lock.files['infra/keycloak/alt2.tf'] = fileHash('# alt2\n');
    writeFileSync(lockFile, JSON.stringify(lock));
    const plan = planSync(dir);
    assert.deepEqual(plan.filter(p => p.action !== 'unchanged').map(p => [p.path, p.action]), [['infra/keycloak/alt.tf', 'remove'], ['infra/keycloak/alt2.tf', 'keep']]);
    assert.equal((await run(['sync', '--dir', dir])).code, 0);
    assert.ok(!existsSync(join(dir, 'infra/keycloak/alt.tf')) && existsSync(join(dir, 'infra/keycloak/alt2.tf')));
  });

  test('Datei besteht schon, nicht vom Kit: Konflikt statt Überschreiben', async () => {
    const dir = newApp('fremd');
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/keycloak.yml'), 'name: eigen\n');
    const r = await init(dir);
    assert.equal(r.code, 1);
    assert.match(r.err, /keycloak\.yml: besteht schon, nicht vom Kit/);
    assert.equal(readFileSync(join(dir, '.github/workflows/keycloak.yml'), 'utf8'), 'name: eigen\n');
  });
});

describe('keys', () => {
  test('öffentlich ins Repository (tofu nicht), privat 0600 in ein eigenes Verzeichnis; bestehende bleiben', async () => {
    const dir = newApp('keys');
    assert.equal((await init(dir)).code, 0);
    const secret = join(root, 'geheim');
    const r = await run(['keys', '--dir', dir, '--secret-dir', secret]);
    assert.equal(r.code, 0, r.err);
    for (const c of ['iac', 'platform', 'admin', 'sync']) {
      const jwks = JSON.parse(readFileSync(join(dir, `infra/keycloak/keys/notes-${c}.json`), 'utf8'));
      assert.equal(jwks.keys.length, 1);
      assert.ok(!('d' in jwks.keys[0]), 'nur öffentlich');
      assert.equal(statSync(join(secret, `notes-${c}.pem`)).mode & 0o777, 0o600);
    }
    assert.ok(!existsSync(join(dir, 'infra/keycloak/keys/notes-tofu.json')) && existsSync(join(secret, 'notes-tofu.json')));
    assert.equal(statSync(secret).mode & 0o777, 0o700);
    assert.ok(!existsSync(join(secret, 'notes-mcp.pem')), 'ohne MCP kein Schlüssel');
    const before = readFileSync(join(dir, 'infra/keycloak/keys/notes-iac.json'), 'utf8');
    const again = await run(['keys', '--dir', dir, '--secret-dir', secret]);
    assert.match(again.out, /vorhanden +notes-iac/);
    assert.equal(readFileSync(join(dir, 'infra/keycloak/keys/notes-iac.json'), 'utf8'), before);
  });

  test('kid = JWK-Thumbprint (RFC 7638)', async () => {
    const { createHash, createPublicKey } = await import('node:crypto');
    const k = keyPair();
    const { kty, crv, x, y } = createPublicKey(k.pem).export({ format: 'jwk' }) as Record<string, string>;
    assert.equal(k.jwks.keys[0].kid, createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest('base64url'));
  });
});

describe('Vorgaben des Betreibers', () => {
  const defaults = {
    smtp: { host: 'mail.betrieb.example', port: 587, starttls: true, from: 'noreply@betrieb.example', user: 'noreply@betrieb.example' },
    theme: 'betrieb',
    themeTexts: { de: { themeAccent: '#0D6B5B', themeClaim: '{displayName} – alles an einem Ort.', 'themeSub.login': 'Anmelden bei {displayName}', themeMailFooter: '{displayName} · {publicBaseUrl}' } },
  };
  const write = (name: string, data: unknown) => { const f = join(root, name); writeFileSync(f, JSON.stringify(data)); return f; };

  test('init übernimmt smtp (Anzeigename der App), theme und Texte des Themes je Sprache; konform ohne Warnung zu SMTP', async () => {
    const dir = newApp('betrieb');
    const r = await init(dir, ['--operator-defaults', write('vorgaben.json', defaults)]);
    assert.equal(r.code, 0, r.out + r.err);
    const m = JSON.parse(readFileSync(join(dir, 'identity.app.json'), 'utf8'));
    assert.deepEqual(manifestErrors(m), []);
    assert.deepEqual(m.realm.smtp, { ...defaults.smtp, fromDisplayName: 'Notes' });
    assert.deepEqual([m.realm.theme, m.realm.themeTexts], ['betrieb', 'infra/keycloak/theme-texts.json']);
    const texts = JSON.parse(readFileSync(join(dir, 'infra/keycloak/theme-texts.json'), 'utf8'));
    assert.deepEqual(Object.keys(texts), ['de', 'en'], 'je Sprache der App (en aus der Vorlage de)');
    assert.deepEqual(texts.de, { themeAccent: '#0D6B5B', themeClaim: 'Notes – alles an einem Ort.', 'themeSub.login': 'Anmelden bei Notes', themeMailFooter: 'Notes · https://notes.example.ch' });
    assert.match(r.out, /realm\.smtp\s+Mailversand \(gesetzt; Secret SMTP_PASSWORD/);
    const { findings } = await repoChecks(dir);
    assert.deepEqual(failed(findings), []);
    assert.equal(findings.find(f => f.check === 'E-Mail-Versand des Realms')!.status, 'ok');
  });

  test('ohne Vorgaben: realm.smtp null, Warnung im Konformitätstest (kein Fehler); sync gibt nur Hinweise und ändert nichts', async () => {
    const dir = newApp('ohne-betrieb');
    assert.equal((await init(dir)).code, 0);
    const before = readFileSync(join(dir, 'identity.app.json'), 'utf8');
    const { findings } = await repoChecks(dir);
    const smtp = findings.find(f => f.check === 'E-Mail-Versand des Realms')!;
    assert.deepEqual([smtp.status, failed(findings)], ['warn', []]);
    assert.match(smtp.details[0]!, /Einladung «Passwort festlegen»/);
    const s = await run(['sync', '--dir', dir, '--operator-defaults', write('vorgaben2.json', defaults)]);
    assert.equal(s.code, 0, s.out + s.err);
    assert.match(s.out, /Hinweise \(identity\.app\.json bleibt unverändert\)/);
    assert.match(s.out, /realm\.smtp fehlt/);
    assert.match(s.out, /Vorgabe des Betreibers für realm\.smtp: .*"fromDisplayName":"Notes"/);
    assert.match(s.out, /realm\.theme: null, Vorgabe des Betreibers "betrieb"/);
    assert.equal(readFileSync(join(dir, 'identity.app.json'), 'utf8'), before, 'Manifest unverändert');
    assert.ok(!existsSync(join(dir, 'infra/keycloak/theme-texts.json')));
    // init auf bestehendem Manifest: ebenfalls nur Hinweise
    const again = await run(['init', '--dir', dir, '--operator-defaults', join(root, 'vorgaben2.json')]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /realm\.smtp fehlt/);
    assert.equal(readFileSync(join(dir, 'identity.app.json'), 'utf8'), before);
  });

  test('ungültige Vorgaben: Abbruch mit Befund; URL nur https, mit GITHUB_TOKEN als Bearer', async () => {
    const bad = await run(['init', '--dir', newApp('falsch'), '--product', 'notes', '--name', 'Notes', '--url', 'https://notes.example.ch', '--keycloak', 'https://id.example.ch',
      '--operator-defaults', write('falsch.json', { smtp: { host: 'x', from: 'kein-mail', user: 'u' }, themeTexts: { de: { themeAccent: 'grün', themeClaim: '{unbekannt}' } } })]);
    assert.equal(bad.code, 1, 'Befund (Code 1)');
    assert.match(bad.err, /Vorgaben des Betreibers ungültig/);
    assert.ok(!existsSync(join(root, 'falsch', 'identity.app.json')), 'nichts angelegt');
    const { loadOperatorDefaults } = await import('../src/operator.ts');
    await assert.rejects(loadOperatorDefaults('http://example.ch/v.json'), /nur https/);
    let auth: string | null = null;
    const fake = (async (_u: string, init?: RequestInit) => { auth = new Headers(init?.headers).get('authorization'); return new Response(JSON.stringify(defaults)); }) as unknown as typeof fetch;
    const d = await loadOperatorDefaults('https://raw.githubusercontent.com/betrieb/identity/main/app-defaults.json', { env: { GITHUB_TOKEN: 't0k' }, fetch: fake });
    assert.deepEqual([d.theme, auth], ['betrieb', 'Bearer t0k']);
    await loadOperatorDefaults('https://config.example.ch/app-defaults.json', { env: { GITHUB_TOKEN: 't0k' }, fetch: fake });
    assert.equal(auth, null, 'Token nur an GitHub');
    const errs = (await import('@vollholz/iam-testkit')).operatorDefaultsErrors({ smtp: { host: 'x', from: 'a@b.ch', user: 'u' }, themeTexts: { de: { themeAccent: 'grün', themeClaim: '{unbekannt}' } } });
    assert.deepEqual(errs, ['/themeTexts/de/themeAccent: nur #RRGGBB', '/themeTexts/de/themeClaim: unbekannter Platzhalter {unbekannt} (erlaubt: {displayName}, {product}, {publicBaseUrl})']);
  });
});
