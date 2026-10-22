/**
 * Lokale Registry für die Pakete des Baukastens (@vollholz/*), für Umgebungen ohne Zugang zu GitHub Packages
 * (Sessions, Prüfung einer App gegen einen unveröffentlichten Stand). Baut und packt alle Pakete dieses Repositorys und
 * liefert sie unter http://127.0.0.1:<port>/ aus; alle anderen Pakete kommen weiter von npmjs.
 *
 *   node scripts/local-registry.ts [--port 4873] [--no-build]
 *
 * In der App (die Umgebungsvariable hat Vorrang vor der .npmrc des Projekts):
 *
 *   env 'npm_config_@vollholz:registry=http://127.0.0.1:4873/' npm ci
 *
 * Achtung: Die Pakete sind nicht byte-gleich mit den veröffentlichten. Ein Lockfile mit `integrity` für @vollholz/*
 * schlägt dann fehl; ein mit dieser Registry erzeugtes Lockfile nie committen, ohne `resolved` und `integrity` der
 * @vollholz-Einträge zu entfernen (siehe docs/ausrollen.md).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] ?? 4873) || 4873;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!args.includes('--no-build')) execFileSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' });
const out = mkdtempSync(join(tmpdir(), 'identity-kit-registry-'));

interface Entry { name: string; version: string; manifest: Record<string, unknown>; file: string; data: Buffer }
const entries = new Map<string, Entry>();
for (const dir of readdirSync(join(root, 'packages'))) {
  const pkgDir = join(root, 'packages', dir);
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')); } catch { continue; }
  if (manifest.private) continue;
  const file = execFileSync(npm, ['pack', '--pack-destination', out, '--silent'], { cwd: pkgDir, encoding: 'utf8' }).trim().split('\n').pop()!;
  const data = readFileSync(join(out, file));
  entries.set(String(manifest.name), { name: String(manifest.name), version: String(manifest.version), manifest, file, data });
}

const base = `http://127.0.0.1:${port}`;
const packument = (e: Entry) => ({
  name: e.name, 'dist-tags': { latest: e.version },
  versions: { [e.version]: { ...e.manifest, dist: {
    tarball: `${base}/-/${encodeURIComponent(e.file)}`,
    integrity: `sha512-${createHash('sha512').update(e.data).digest('base64')}`,
    shasum: createHash('sha1').update(e.data).digest('hex'),
  } } },
});

createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  if (path.startsWith('/-/')) {
    const e = [...entries.values()].find(x => x.file === path.slice(3));
    if (e) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(e.data); }
  } else {
    const e = entries.get(path.slice(1));
    if (e) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(packument(e))); }
  }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}');
}).listen(port, '127.0.0.1', () => {
  console.log(`Registry für @vollholz/* auf ${base}/ – ${[...entries.values()].map(e => `${e.name}@${e.version}`).join(', ')}`);
  console.log(`In der App: env 'npm_config_@vollholz:registry=${base}/' npm ci`);
});
