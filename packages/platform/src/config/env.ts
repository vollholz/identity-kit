/**
 * Konfiguration nur über Umgebungsvariablen (app-boilerplate L8, 5.1).
 *
 * `platformVars(product, extra)` ist die einzige Quelle: Variablen des IAM (`IAM_VARS`), der Plattform und der App, je
 * mit Typ, Gruppe, Beschreibung, Standard, Pflicht und Dienst. Daraus entstehen die geprüfte Konfiguration beim Start
 * (alle Fehler zugleich, `ConfigError`, Einstiegspunkte enden mit Exit 78) sowie `.env.example` und die Doku der
 * Konfiguration (`envDocs`).
 */
import { ConfigError, IAM_VARS, iamConfig, iamConfigErrors, parseDuration, readVars, type IamConfig, type RawVars, type Service, type VarSpec } from '@vollholz/iam';

export { ConfigError, type RawVars, type Service, type VarSpec };

/** Exit-Code bei ungültiger Konfiguration (EX_CONFIG aus sysexits.h). */
export const EXIT_CONFIG = 78;

/** Variablen der Plattform (ohne IAM, ohne App). */
export const PLATFORM_VARS = (product: string): VarSpec[] => [
  { name: 'LOG_LEVEL', kind: 'enum', group: 'Allgemein', values: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], default: 'info', description: 'Detailgrad der Logs (JSON auf stdout).' },

  { name: 'HTTP_HOST', kind: 'string', group: 'HTTP', default: '0.0.0.0', services: ['api'], description: 'Adresse, an der die API lauscht.' },
  { name: 'HTTP_PORT', kind: 'int', group: 'HTTP', default: '8080', services: ['api'], description: 'Port der REST-API, des BFF und der Oberfläche.' },
  { name: 'TRUST_PROXY', kind: 'string', group: 'HTTP', default: 'false', description: '`trustProxy` von Fastify: `false`, `true`, Anzahl der Proxys (z. B. `1`) oder Liste von Adressen/Netzen. Hinter Caddy bzw. Ingress `1`.' },
  { name: 'BODY_LIMIT', kind: 'int', group: 'HTTP', default: '1048576', description: 'Grösste Anfrage in Bytes.' },
  { name: 'API_RATE_LIMIT', kind: 'int', group: 'HTTP', default: '600', description: 'Anfragen je Minute und Principal im Mandanten (ohne Anmeldung je IP). Die Oberfläche (`/`, `/assets/*`) ist nie begrenzt.' },
  { name: 'IDEMPOTENCY_TTL', kind: 'duration', group: 'HTTP', default: '24h', description: 'Aufbewahrung gespeicherter Antworten zu `Idempotency-Key`.' },
  { name: 'WEB_DIST_DIR', kind: 'string', group: 'HTTP', default: 'web/dist', services: ['api'], description: 'Verzeichnis mit dem Build der Webapp. Fehlt es, zeigt die API ausserhalb der Produktion eine Hinweisseite.' },

  { name: 'WORKER_CONCURRENCY', kind: 'int', group: 'Worker', default: '4', services: ['worker'], description: 'Gleichzeitige Jobs je Worker-Prozess.' },
  { name: 'WORKER_TENANT_LIMIT', kind: 'int', group: 'Worker', default: '2', services: ['worker'], description: 'Höchstens so viele gleichzeitige Jobs je Mandant über alle Worker.' },
  { name: 'WORKER_POLL_INTERVAL', kind: 'duration', group: 'Worker', default: '1s', services: ['worker'], description: 'Abstand der Abfragen, wenn die Warteschlange leer ist.' },
  { name: 'JOB_RETENTION', kind: 'duration', group: 'Worker', default: '30d', services: ['worker'], description: 'Aufbewahrung erledigter und endgültig gescheiterter Jobs.' },

  { name: 'OUTBOX_RETENTION', kind: 'duration', group: 'Ereignisse und Webhooks', default: '7d', services: ['worker'], description: 'Aufbewahrung verteilter Ereignisse der Outbox; Module mit eigenen Zustellungen (z. B. Webhooks) räumen abgeschlossene nach derselben Frist auf.' },
  { name: 'WEBHOOK_TIMEOUT', kind: 'duration', group: 'Ereignisse und Webhooks', default: '10s', services: ['worker'], description: 'Zeitlimit je Zustellung eines Webhooks.' },
  { name: 'WEBHOOK_MAX_ATTEMPTS', kind: 'int', group: 'Ereignisse und Webhooks', default: '8', services: ['worker'], description: 'Zustellversuche je Ereignis und Abonnement (exponentielles Backoff).' },
  { name: 'WEBHOOK_ALLOW_PRIVATE', kind: 'bool', group: 'Ereignisse und Webhooks', default: 'false', description: 'Nur Entwicklung und Tests: Webhooks an private Adressen (localhost, RFC 1918) zulassen. In Produktion nicht erlaubt.' },

  { name: 'MCP_PORT', kind: 'int', group: 'MCP', default: '8081', services: ['mcp'], description: 'Port des MCP-Dienstes (Streamable HTTP unter `/mcp`).' },

  { name: 'OPS_PORT', kind: 'int', group: 'Betrieb', default: '9090', description: 'Betriebs-Endpunkt jedes Prozesses: `/healthz`, `/readyz`, `/metrics`.' },
  { name: 'SHUTDOWN_DELAY', kind: 'duration', group: 'Betrieb', default: '5s', description: 'Wartezeit nach SIGTERM mit `/readyz` = 503, bevor der Server schliesst (Load Balancer nimmt die Instanz heraus).' },
  { name: 'SHUTDOWN_TIMEOUT', kind: 'duration', group: 'Betrieb', default: '25s', description: 'Höchstdauer des geordneten Beendens; danach Exit 1.' },
  { name: 'METRICS_ENABLED', kind: 'bool', group: 'Betrieb', default: 'false', description: 'Metriken im Prometheus-Format unter `/metrics` des Betriebs-Endpunkts.' },
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', kind: 'url', group: 'Betrieb', description: 'OTLP/HTTP-Empfänger für Traces und Metriken. Ohne Angabe keine Ausleitung.', example: 'http://otel-collector:4318' },
  { name: 'OTEL_SERVICE_NAME', kind: 'string', group: 'Betrieb', default: product, description: 'Dienstname in der Telemetrie; der Prozess wird als `service.instance.id`-Suffix ergänzt.' },
];

/** Alle Variablen: IAM, Plattform und App; doppelte Namen sind ein Fehler. */
export function platformVars(product: string, extra: readonly VarSpec[] = []): VarSpec[] {
  const all = [...IAM_VARS(product), ...PLATFORM_VARS(product), ...extra];
  const seen = new Set<string>();
  for (const v of all) {
    if (seen.has(v.name)) throw new Error(`Variable ${v.name} ist doppelt beschrieben`);
    seen.add(v.name);
  }
  return all;
}

export interface AppConfig {
  logLevel: string;
  http: { host: string; port: number; trustProxy: boolean | number | string[]; bodyLimit: number; rateLimit: number; idempotencyTtlMs: number; webDistDir: string };
  worker: { concurrency: number; tenantLimit: number; pollMs: number; jobRetentionMs: number };
  events: { outboxRetentionMs: number; webhookTimeoutMs: number; webhookMaxAttempts: number; allowPrivate: boolean };
  mcp: { port: number };
  ops: { port: number; shutdownDelayMs: number; shutdownTimeoutMs: number; metrics: boolean; otlpEndpoint: string | null; serviceName: string };
}

/** Geprüfte Konfiguration; `raw` enthält alle Werte nach Standard (auch die Variablen der App). */
export type PlatformConfig = IamConfig & { app: AppConfig; raw: Readonly<RawVars> };

/** Prüfungen der App über mehrere Variablen (zusätzlich zu IAM und Plattform). */
export type ConfigCheck = (raw: RawVars, mode: IamConfig['mode'], service: Service | null) => string[];

function trustProxy(v: string): AppConfig['http']['trustProxy'] {
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map(x => x.trim()).filter(Boolean);
}

/** Prüfungen der App über mehrere Variablen. */
function appConfigErrors(raw: RawVars, mode: IamConfig['mode'], service: Service | null): string[] {
  const errors: string[] = [];
  const needs = (...s: Service[]) => service === null || s.includes(service);
  if (mode === 'production') {
    if (needs('api', 'worker') && raw.DATABASE_SSL !== 'verify-full') errors.push('DATABASE_SSL muss in Produktion verify-full sein');
    if (/^(true|1)$/i.test(raw.WEBHOOK_ALLOW_PRIVATE ?? '')) errors.push('WEBHOOK_ALLOW_PRIVATE=true ist in Produktion nicht erlaubt');
    if (needs('api', 'worker') && !raw.ENCRYPTION_KEYS) errors.push('ENCRYPTION_KEYS fehlt – in Produktion Pflicht');
  }
  for (const k of ['HTTP_PORT', 'MCP_PORT', 'OPS_PORT']) {
    const n = Number(raw[k]);
    if (raw[k] && /^\d+$/.test(raw[k]!) && (n < 1 || n > 65535)) errors.push(`${k}: 1 bis 65535`);
  }
  if (raw.HTTP_PORT && raw.HTTP_PORT === raw.OPS_PORT && needs('api')) errors.push('OPS_PORT muss sich von HTTP_PORT unterscheiden');
  if (raw.MCP_PORT && raw.MCP_PORT === raw.OPS_PORT && needs('mcp')) errors.push('OPS_PORT muss sich von MCP_PORT unterscheiden');
  for (const k of ['WORKER_CONCURRENCY', 'WORKER_TENANT_LIMIT', 'WEBHOOK_MAX_ATTEMPTS']) if (raw[k] === '0') errors.push(`${k}: mindestens 1`);
  return errors;
}

function appConfig(raw: RawVars): AppConfig {
  const s = (k: string) => raw[k] ?? '';
  const n = (k: string) => Number(raw[k]);
  const d = (k: string) => parseDuration(raw[k] ?? '0');
  const b = (k: string) => /^(true|1)$/i.test(raw[k] ?? '');
  return {
    logLevel: s('LOG_LEVEL'),
    http: { host: s('HTTP_HOST'), port: n('HTTP_PORT'), trustProxy: trustProxy(s('TRUST_PROXY')), bodyLimit: n('BODY_LIMIT'), rateLimit: n('API_RATE_LIMIT'), idempotencyTtlMs: d('IDEMPOTENCY_TTL'), webDistDir: s('WEB_DIST_DIR') },
    worker: { concurrency: n('WORKER_CONCURRENCY'), tenantLimit: n('WORKER_TENANT_LIMIT'), pollMs: d('WORKER_POLL_INTERVAL'), jobRetentionMs: d('JOB_RETENTION') },
    events: { outboxRetentionMs: d('OUTBOX_RETENTION'), webhookTimeoutMs: d('WEBHOOK_TIMEOUT'), webhookMaxAttempts: n('WEBHOOK_MAX_ATTEMPTS'), allowPrivate: b('WEBHOOK_ALLOW_PRIVATE') },
    mcp: { port: n('MCP_PORT') },
    ops: { port: n('OPS_PORT'), shutdownDelayMs: d('SHUTDOWN_DELAY'), shutdownTimeoutMs: d('SHUTDOWN_TIMEOUT'), metrics: b('METRICS_ENABLED'), otlpEndpoint: raw.OTEL_EXPORTER_OTLP_ENDPOINT || null, serviceName: s('OTEL_SERVICE_NAME') },
  };
}

/**
 * Liest und prüft die Konfiguration für einen Dienst (`null`: Skripte und Tests, alle Prüfungen). Sammelt alle Fehler
 * und wirft `ConfigError`.
 */
export function loadPlatformConfig(env: NodeJS.ProcessEnv, service: Service | null, vars: readonly VarSpec[], check?: ConfigCheck): PlatformConfig {
  const { raw, mode, errors } = readVars(env, [...vars], service);
  errors.push(...iamConfigErrors(raw, mode, service), ...appConfigErrors(raw, mode, service), ...(check?.(raw, mode, service) ?? []));
  if (errors.length) throw new ConfigError('Konfiguration ungültig:\n  - ' + errors.join('\n  - '));
  return { ...iamConfig(raw, mode), app: appConfig(raw), raw: Object.freeze({ ...raw }) };
}

/**
 * Für Einstiegspunkte: Konfiguration laden oder mit allen Fehlern auf stderr und Exit 78 enden.
 */
export function configOrExit(env: NodeJS.ProcessEnv, service: Service | null, vars: readonly VarSpec[], check?: ConfigCheck): PlatformConfig {
  try {
    return loadPlatformConfig(env, service, vars, check);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: e.message, service })}\n`);
    process.exit(EXIT_CONFIG);
  }
}
