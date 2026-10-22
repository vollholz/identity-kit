/**
 * Build des Pakets: `tsc` übersetzt `src` nach `dist` (Endungen `.ts`/`.tsx` → `.js`, Typen `.d.ts`), danach wird das
 * einzige Stylesheet `src/styles.css` nach `dist/styles.css` kopiert. Kein Quellmodul importiert CSS, deshalb braucht
 * `dist` keinen Bundler und keinen CSS-Loader (docs/entwurf.md › Einstiegspunkte).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
rmSync(join(root, 'dist'), { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });
copyFileSync(join(root, 'src', 'styles.css'), join(root, 'dist', 'styles.css'));
