/**
 * Release Notes der Pakete (packages/<paket>/CHANGELOG.md, «Keep a Changelog»). Regel: keine neue Version ohne
 * Eintrag. Jede Version eines Pakets hat in dessen CHANGELOG.md einen Abschnitt `## [<version>] – <datum>`.
 *
 *   node scripts/changelog.ts check [--base <git-ref>]   CI: aktuelle Version jedes Pakets hat einen Abschnitt; mit
 *                                                        --base zusätzlich keine kleinere Version als im Basis-Stand
 *   node scripts/changelog.ts notes <paket-ordner> <version>   Text des Abschnitts (GitHub Release, release.yml)
 *
 * Exit 0 ok, 1 Befund, 64 Aufruf falsch.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');

/** Überschrift eines Versionsabschnitts: `## [1.2.3] – 2026-10-28` (Datum optional, Bindestrich oder Gedankenstrich). */
const HEADING = /^## \[([^\]]+)\](?:\s+[–-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export interface Section { version: string; date: string | null; body: string }

/** Abschnitte je Version (ohne «Unveröffentlicht»), in der Reihenfolge der Datei. */
export function sections(text: string): Section[] {
  const out: Section[] = [];
  let cur: { version: string; date: string | null; lines: string[] } | null = null;
  const close = () => { if (cur && SEMVER.test(cur.version)) out.push({ version: cur.version, date: cur.date, body: cur.lines.join('\n').trim() }); };
  for (const line of text.split(/\r?\n/)) {
    const m = HEADING.exec(line);
    if (m) { close(); cur = { version: m[1]!, date: m[2] ?? null, lines: [] }; continue; }
    // Linkverweise am Ende der Datei gehören zu keinem Abschnitt
    if (/^## /.test(line) || /^\[[^\]]+\]:\s/.test(line)) { close(); cur = null; continue; }
    cur?.lines.push(line);
  }
  close();
  return out;
}

/** Vergleich nach SemVer (Vorabversionen vor der Version selbst, sonst lexikalisch). */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) throw new Error(`keine semantische Version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return Math.sign(d); }
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return x[4] < y[4] ? -1 : 1;
}

interface Pkg { dir: string; name: string; version: string }

function packages(): Pkg[] {
  const base = join(root, 'packages');
  return readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(base, d.name, 'package.json')))
    .map(d => ({ dir: join(base, d.name), json: JSON.parse(readFileSync(join(base, d.name, 'package.json'), 'utf8')) as { name: string; version: string; private?: boolean } }))
    .filter(p => !p.json.private).map(p => ({ dir: p.dir, name: p.json.name, version: p.json.version }));
}

/** Version des Pakets im Basis-Stand; null, wenn es das Paket dort nicht gab. */
function baseVersion(ref: string, p: Pkg): string | null {
  try {
    const raw = execFileSync('git', ['show', `${ref}:${relative(root, join(p.dir, 'package.json'))}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (JSON.parse(raw) as { version: string }).version;
  } catch { return null; }
}

/** Befunde zu einem Paket (leer: in Ordnung). */
export function problems(p: Pkg, changelog: string | null, before: string | null): string[] {
  const file = `${relative(root, p.dir)}/CHANGELOG.md`;
  if (changelog === null) return [`${file} fehlt (${p.name}@${p.version})`];
  const out: string[] = [];
  const all = sections(changelog);
  const own = all.filter(s => s.version === p.version);
  if (!own.length) out.push(`${file}: Abschnitt «## [${p.version}] – <datum>» fehlt (${p.name}@${p.version})`);
  else if (own.length > 1) out.push(`${file}: Abschnitt ${p.version} kommt mehrfach vor`);
  else if (!own[0]!.body) out.push(`${file}: Abschnitt ${p.version} ist leer`);
  else if (!own[0]!.date) out.push(`${file}: Abschnitt ${p.version} ohne Datum («## [${p.version}] – JJJJ-MM-TT»)`);
  if (all[0] && all[0].version !== p.version && own.length) out.push(`${file}: Abschnitt ${p.version} steht nicht zuoberst (zuoberst: ${all[0].version})`);
  if (before && compareVersions(p.version, before) < 0) out.push(`${p.name}: Version ${p.version} ist kleiner als im Basis-Stand (${before})`);
  return out;
}

function check(base: string | null): number {
  const found: string[] = [];
  for (const p of packages()) {
    const path = join(p.dir, 'CHANGELOG.md');
    const before = base ? baseVersion(base, p) : null;
    const pr = problems(p, existsSync(path) ? readFileSync(path, 'utf8') : null, before);
    found.push(...pr);
    const bumped = base && before !== p.version ? ` (erhöht von ${before ?? 'neu'})` : '';
    if (!pr.length) console.log(`ok: ${p.name}@${p.version}${bumped}`);
  }
  for (const f of found) console.error(`::error::${f}`);
  if (found.length) console.error('Regel: keine neue Version ohne CHANGELOG-Eintrag (README.md, docs/ausrollen.md).');
  return found.length ? 1 : 0;
}

function notes(dir: string, version: string): number {
  const path = join(dir, 'CHANGELOG.md');
  const s = existsSync(path) ? sections(readFileSync(path, 'utf8')).find(x => x.version === version) : undefined;
  if (!s?.body) { console.error(`${path}: kein Abschnitt für ${version}`); return 1; }
  process.stdout.write(`${s.body}\n`);
  return 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const usage = 'Aufruf: changelog.ts check [--base <ref>] | notes <paket-ordner> <version>';
  let code = 64;
  if (cmd === 'check') {
    const i = rest.indexOf('--base');
    code = i >= 0 && !rest[i + 1] ? 64 : check(i >= 0 ? rest[i + 1]! : null);
  } else if (cmd === 'notes' && rest.length === 2) code = notes(rest[0]!, rest[1]!);
  if (code === 64) console.error(usage);
  process.exit(code);
}
