/**
 * Grösse des Haupteinstiegs (`@vollholz/iam-web`) im Start-Bundle einer App: `vite build` (Rolldown, Tree-Shaking,
 * minifiziert) eines Einstiegs, der alles aus `dist/index.js` wieder exportiert, mit `react`, `react-dom` und
 * `@tanstack/react-query` als extern; gemessen wird nur der Start-Chunk (dynamisch geladene Teile wie `./pages` liegen in
 * eigenen Chunks; gemeinsame, statisch importierte Chunks zählen mit), roh und gzip (Stufe 9). Dazu dieselbe Messung für eine kleine App (Provider, Sitzung, Navigation,
 * Routen, Kontomenü).
 *
 *   node scripts/size.ts [dist …]   (Standard: ./dist; mehrere zum Vergleich, z. B. gebaute Stände älterer Versionen)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, type Rollup } from 'vite';

const EXTERNAL = [/^react($|\/)/, /^react-dom($|\/)/, /^@tanstack\/react-query$/];

const APP = (dist: string) => `
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountMenu, Can, IamNav, IamProvider, iamRoutes, useIam } from '${dist}/index.js';
function Home() { const { can, orgName } = useIam(); return h('p', null, String(can('members:admin')), orgName); }
createRoot(document.body).render(h(IamProvider, null, h(AccountMenu), h(IamNav), h(Can, { perm: 'members:admin' }, h(Home)), iamRoutes.map(r => r.path).join()));
`;

export interface Size { raw: number; gzip: number }

/** Start-Chunk eines Einstiegs (Quelltext) bauen und messen. */
export async function measure(source: string): Promise<Size> {
  const dir = mkdtempSync(join(tmpdir(), 'iam-web-size-'));
  try {
    const entry = join(dir, 'entry.js');
    writeFileSync(entry, source);
    const out = await build({
      configFile: false, logLevel: 'silent', root: dir,
      build: {
        write: false, minify: true, target: 'es2022', modulePreload: false,
        lib: { entry, formats: ['es'], fileName: 'entry' },
        rollupOptions: { external: EXTERNAL },
      },
    });
    const all = (Array.isArray(out) ? out : [out as Rollup.RollupOutput]).flatMap(o => o.output)
      .filter((c): c is Rollup.OutputChunk => c.type === 'chunk');
    // Start-Bundle: Einstieg und alle statisch importierten Chunks (gemeinsame Teile), ohne dynamische Importe
    const byName = new Map(all.map(c => [c.fileName, c]));
    const start = new Set<Rollup.OutputChunk>();
    const add = (c: Rollup.OutputChunk | undefined) => { if (c && !start.has(c)) { start.add(c); c.imports.forEach(f => add(byName.get(f))); } };
    all.filter(c => c.isEntry).forEach(add);
    const code = [...start].map(c => c.code).join('\n');
    return { raw: Buffer.byteLength(code), gzip: gzipSync(code, { level: 9 }).length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const entrySource = (dist: string) => `export * from '${dist}/index.js';\n`;
export const appSource = APP;

const kb = (n: number) => (n / 1024).toFixed(2);

if (import.meta.main) {
  const dists = (process.argv.slice(2).length ? process.argv.slice(2) : [join(import.meta.dirname, '..', 'dist')]).map(d => resolve(d));
  console.log('| Stand | Einstieg roh | Einstieg gzip | App roh | App gzip |\n|---|---:|---:|---:|---:|');
  for (const d of dists) {
    const e = await measure(entrySource(d));
    const a = await measure(appSource(d));
    console.log(`| ${d} | ${kb(e.raw)} kB | ${kb(e.gzip)} kB | ${kb(a.raw)} kB | ${kb(a.gzip)} kB |`);
  }
}
