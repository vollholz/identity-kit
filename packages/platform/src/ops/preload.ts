/**
 * Wird vor allen Modulen geladen (`node --import @vollholz/platform/preload …`), damit die Instrumentierungen von
 * http, pg und undici greifen. Liest die Umgebung direkt: Die Konfiguration ist zu diesem Zeitpunkt noch nicht
 * geprüft (das macht der Einstiegspunkt mit Exit 78). Schaltet nichts ein, wenn weder `OTEL_EXPORTER_OTLP_ENDPOINT`
 * noch `METRICS_ENABLED=true` gesetzt ist; ungültige Werte überlässt es der Prüfung der Konfiguration.
 */
import { basename } from 'node:path';
import { startTelemetry } from './telemetry.ts';

const env = process.env;
const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || null;
let validEndpoint: string | null = null;
try { if (endpoint) validEndpoint = new URL(endpoint).toString(); } catch { validEndpoint = null; }
const prometheus = /^(true|1)$/i.test(env.METRICS_ENABLED ?? '');

// Prozess aus dem Einstieg: src/main/api.ts → api, scripts/db-migrate.ts → db-migrate
const entry = process.argv[1] ? basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, '') : 'node';

try {
  startTelemetry({ otlpEndpoint: validEndpoint, prometheus, serviceName: env.OTEL_SERVICE_NAME?.trim() || env.npm_package_name || 'app', process: entry });
} catch (err) {
  // Telemetrie darf den Start nie verhindern
  process.stderr.write(`${JSON.stringify({ level: 'warn', msg: 'Telemetrie nicht gestartet', err: String(err) })}\n`);
}
