/**
 * Auslieferung der Webapp (app-boilerplate 5.8): `web/dist` unter `/`, SPA-Fallback für alle Pfade ausser `/v1/*` und
 * `/auth/*`, CSP ohne `unsafe-inline` (`connect-src 'self'`, Formulare nur an die App und Keycloak), `/assets/*`
 * unveränderlich, `index.html` ohne Cache, Pfadprüfung gegen Verlassen von `dist`. Ohne Build zeigt die API
 * ausserhalb der Produktion eine Hinweisseite.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PlatformModule } from '../module.ts';
import type { Deps } from './app.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
};

/** CSP der Oberfläche; `keycloak` = Herkunft des Anmeldedienstes (Formulare beim Abmelden). */
export function uiCsp(keycloak: string): string {
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", `form-action 'self' ${keycloak}`,
  ].join('; ');
}

/** Datei unterhalb von `root` oder null (kein `..`, keine absoluten Pfade, keine Steuerzeichen). */
export function safePath(root: string, urlPath: string): string | null {
  let p: string;
  try { p = decodeURIComponent(urlPath.split('?')[0]!); } catch { return null; }
  // Steuerzeichen, Backslash und jedes «..»-Segment ablehnen, statt sie still zu normalisieren
  if (/[\0-\x1f\\]/.test(p) || p.split('/').includes('..')) return null;
  const rel = normalize(p).replace(/^([/\\])+/, '');
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  const full = resolve(root, rel);
  return full === root || full.startsWith(root + sep) ? full : null;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const noBuild = (title: string) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>
<h1>Oberfläche nicht gebaut</h1><p>Baue sie mit <code>npm run web:build</code> oder starte <code>npm --prefix web run dev</code>.
Die API läuft: <a href="/v1/docs">/v1/docs</a>.</p></body></html>`;

export function registerUi(app: FastifyInstance, deps: Deps): void {
  const root = resolve(deps.cfg.app.http.webDistDir);
  const csp = uiCsp(new URL(deps.cfg.oidc.issuer).origin);

  const send = async (reply: FastifyReply, file: string, cache: string) => {
    const body = await readFile(file);
    return reply.header('content-security-policy', csp).header('cache-control', cache).header('x-content-type-options', 'nosniff')
      .type(TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream').send(body);
  };

  const index = async (reply: FastifyReply) => {
    const file = join(root, 'index.html');
    if (!(await stat(file).then(s => s.isFile(), () => false))) {
      if (deps.cfg.mode === 'production') return reply.code(503).header('content-security-policy', csp).type('text/plain; charset=utf-8').send('Oberfläche nicht verfügbar.');
      return reply.header('content-security-policy', csp).type('text/html; charset=utf-8').send(noBuild(deps.platform.title));
    }
    return send(reply, file, 'no-cache');
  };

  app.get('/*', { schema: { hide: true } }, async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (path.startsWith('/v1/') || path === '/v1' || path.startsWith('/auth/')) return reply.callNotFound();
    const file = safePath(root, path);
    if (file === null) return reply.code(400).type('text/plain; charset=utf-8').send('Ungültiger Pfad.');
    if (file !== root && (await stat(file).then(s => s.isFile(), () => false))) {
      return send(reply, file, path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    // Fehlende Dateien mit Endung (z. B. /assets/x.js) sind 404, alles andere ist eine Seite der SPA
    if (extname(path)) return reply.code(404).type('text/plain; charset=utf-8').send('Nicht gefunden.');
    return index(reply);
  });
}

/** Modul der Oberfläche (`WEB_DIST_DIR`, SPA-Fallback); `defineApp` hängt es zuletzt ein (`ui: false` schaltet es ab). */
export const uiModule: PlatformModule = { name: 'ui', register: registerUi };
