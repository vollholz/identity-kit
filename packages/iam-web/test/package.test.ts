// @vitest-environment node
/**
 * Das gebaute Paket (`dist`, nach `npm run build`) lässt sich ohne Bundler in Node laden, exportiert dasselbe wie die
 * Quellen und enthält das Stylesheet; `npm pack` liefert nur `dist`, README und CHANGELOG.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');

/** Dateien, die `file` statisch lädt (`import … from`, `export … from`, `import '…'`), rekursiv; ohne `import()`. */
function staticGraph(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const code = readFileSync(file, 'utf8');
  for (const m of code.matchAll(/^\s*(?:import|export)\s(?:[^'"()]*?\sfrom\s)?['"](\.{1,2}\/[^'"]+)['"]/gm)) staticGraph(join(dirname(file), m[1]!), seen);
  return seen;
}

describe('Paket', () => {
  it('dist lädt in Node und exportiert dasselbe wie src (Kern, Seiten, Testhilfen)', async () => {
    expect(existsSync(join(dist, 'index.js')), 'zuerst npm run build').toBe(true);
    const built = await import(pathToFileURL(join(dist, 'index.js')).href) as Record<string, unknown>;
    const src = await import('../src/index.ts') as Record<string, unknown>;
    expect(Object.keys(built).sort()).toEqual(Object.keys(src).sort());
    expect(readFileSync(join(dist, 'index.js'), 'utf8')).not.toMatch(/from ['"][^'"]+\.tsx?['"]/);
    const testing = await import(pathToFileURL(join(dist, 'testing', 'index.js')).href) as Record<string, unknown>;
    expect(Object.keys(testing).sort()).toEqual(['CATALOG', 'ME', 'StaticIam', 'accountInfo', 'json', 'mockIamApi', 'staticResources']);
    const pages = await import(pathToFileURL(join(dist, 'pages', 'index.js')).href) as Record<string, unknown>;
    expect(Object.keys(pages).sort()).toEqual(Object.keys(await import('../src/pages/index.ts')).sort());
    // iamRoutes lädt die Seiten aus dist nach (dynamischer Import mit Endung .js)
    expect(readFileSync(join(dist, 'routes.js'), 'utf8')).toMatch(/import\("\.\/pages\/index\.js"\)/);
  });

  it('Haupteinstieg lädt die Verwalten-Seiten nicht statisch (nur über ./pages bzw. iamRoutes[].load())', () => {
    expect(existsSync(join(dist, 'index.js')), 'zuerst npm run build').toBe(true);
    const files = [...staticGraph(join(dist, 'index.js'))].map(f => relative(dist, f).replaceAll('\\', '/')).sort();
    expect(files).toContain('routes.js');
    expect(files.filter(f => f.startsWith('pages/'))).toEqual([]);
  });

  it('exports zeigen auf vorhandene Dateien, styles.css ist eine Ebene «iam»', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, string | Record<string, string>> };
    for (const target of Object.values(pkg.exports).flatMap(v => (typeof v === 'string' ? [v] : Object.values(v)))) {
      expect(existsSync(join(root, target)), target).toBe(true);
    }
    expect(readFileSync(join(dist, 'styles.css'), 'utf8')).toMatch(/@layer iam/);
  });

  it('npm pack enthält nur dist, README, CHANGELOG, LICENSE, NOTICE und package.json', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
    const files = (JSON.parse(out) as { files: { path: string }[] }[])[0]!.files.map(f => f.path);
    expect(files.filter(f => !f.startsWith('dist/') && !['README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'package.json'].includes(f))).toEqual([]);
    expect(files).toEqual(expect.arrayContaining(['CHANGELOG.md', 'LICENSE', 'NOTICE']));
    expect(files).toContain('dist/index.d.ts');
    expect(files).toContain('dist/styles.css');
  });
});
