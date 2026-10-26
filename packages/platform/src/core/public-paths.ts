/**
 * Pfade der öffentlichen Routen mit Token in der URL (http/public-route.ts), für Stellen, die die rohe URL sehen,
 * bevor Fastify die Route kennt – z. B. die Telemetrie (ops/telemetry.ts): Ihre Spuren dieser Anfragen entfallen, damit
 * das Token nie an den Empfänger geht. Ohne Abhängigkeiten, weil `preload` es vor allen anderen Modulen lädt.
 */
const patterns: RegExp[] = [];

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Pfad einer Route nach Fastify (`/kalender/:datei`, `*`) als öffentlich vormerken. */
export function addPublicPath(url: string): void {
  const source = url.split(/(:[A-Za-z0-9_]+|\*)/).map(p => (p === '*' ? '.*' : p.startsWith(':') ? '[^/]*' : escape(p))).join('');
  patterns.push(new RegExp(`^${source}/?$`));
}

/** Ist die rohe URL (mit oder ohne Abfrage, auch kodiert) der Pfad einer öffentlichen Route? */
export function isPublicPath(rawUrl: string | undefined): boolean {
  if (!rawUrl || !patterns.length) return false;
  const path = rawUrl.split('?')[0]!;
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* bleibt roh */ }
  return patterns.some(p => p.test(path) || p.test(decoded));
}
