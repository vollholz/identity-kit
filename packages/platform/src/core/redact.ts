/**
 * Redaction (app-boilerplate 6): Geheimnisse nie in Logs. Pfade für den Logger von Fastify (pino) und eine Funktion für
 * eigene Objekte.
 */

/** Pfade, die der Logger ersetzt. */
export const REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.dpop', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]', '*.password', '*.secret', '*.clientSecret', '*.token', '*.accessToken', '*.refreshToken', '*.privateKey',
];

const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|private_?key|dpop|api_?key|signature/i;

/** Tiefe Kopie mit ersetzten Werten bei geheimen Schlüsseln (auch in Arrays). */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? '[entfernt]' : redact(v, depth + 1);
  return out as T;
}
