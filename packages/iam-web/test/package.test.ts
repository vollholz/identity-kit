// @vitest-environment node
/**
 * Das gebaute Paket (`dist`, nach `npm run build`) lässt sich ohne Bundler in Node laden, exportiert dasselbe wie die
 * Quellen und enthält das Stylesheet; `npm pack` liefert nur `dist` und README.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');

describe('Paket', () => {
  it('dist lädt in Node und exportiert dasselbe wie src', async () => {
    expect(existsSync(join(dist, 'index.js')), 'zuerst npm run build').toBe(true);
    const built = await import(pathToFileURL(join(dist, 'index.js')).href) as Record<string, unknown>;
    const src = await import('../src/index.ts') as Record<string, unknown>;
    expect(Object.keys(built).sort()).toEqual(Object.keys(src).sort());
    expect(readFileSync(join(dist, 'index.js'), 'utf8')).not.toMatch(/from ['"][^'"]+\.tsx?['"]/);
  });

  it('exports zeigen auf vorhandene Dateien, styles.css ist eine Ebene «iam»', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, string | Record<string, string>> };
    for (const target of Object.values(pkg.exports).flatMap(v => (typeof v === 'string' ? [v] : Object.values(v)))) {
      expect(existsSync(join(root, target)), target).toBe(true);
    }
    expect(readFileSync(join(dist, 'styles.css'), 'utf8')).toMatch(/@layer iam/);
  });

  it('npm pack enthält nur dist, README und package.json', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
    const files = (JSON.parse(out) as { files: { path: string }[] }[])[0]!.files.map(f => f.path);
    expect(files.filter(f => !f.startsWith('dist/') && f !== 'README.md' && f !== 'package.json')).toEqual([]);
    expect(files).toContain('dist/index.d.ts');
    expect(files).toContain('dist/styles.css');
  });
});
