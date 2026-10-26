/**
 * Betriebs-Endpunkt jedes Prozesses (app-boilerplate 3.1) auf `OPS_PORT`, getrennt vom Dienst-Port:
 *
 * - `GET /healthz` – Prozess lebt (200).
 * - `GET /readyz`  – bereit für Verkehr: 503 beim Beenden (`ready()` false) oder wenn eine Prüfung scheitert.
 * - `GET /metrics` – Prometheus-Textformat, nur mit `METRICS_ENABLED=true` (sonst 404).
 *
 * Eigener node:http-Server, damit Betrieb auch ohne Fastify (Worker) geht.
 */
import { createServer, type ServerResponse } from 'node:http';
import { metricsText } from './metrics.ts';

export interface OpsLog { info(o: object, m: string): void; warn(o: object, m: string): void }

export interface OpsServerOptions {
  port: number;
  host?: string;
  ready: () => boolean;
  checks?: () => Promise<Record<string, boolean>>;
  metrics: boolean;
  log: OpsLog;
}

const CHECK_TIMEOUT_MS = 3000;

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function runChecks(checks: OpsServerOptions['checks']): Promise<Record<string, boolean>> {
  if (!checks) return {};
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(r => { timer = setTimeout(() => r(null), CHECK_TIMEOUT_MS); });
  try {
    const r = await Promise.race([checks(), timeout]);
    return r ?? { timeout: false };
  } catch {
    return { error: false };
  } finally { clearTimeout(timer); }
}

export function startOpsServer(o: OpsServerOptions): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { status: 'method-not-allowed' });
    if (path === '/healthz') return send(res, 200, { status: 'ok' });
    if (path === '/readyz') {
      if (!o.ready()) return send(res, 503, { status: 'shutting-down' });
      void runChecks(o.checks).then(checks => {
        const ok = Object.values(checks).every(Boolean);
        if (!ok) o.log.warn({ checks }, 'readyz: Prüfung gescheitert');
        send(res, ok ? 200 : 503, { status: ok ? 'ready' : 'not-ready', checks });
      });
      return;
    }
    if (path === '/metrics' && o.metrics) {
      void metricsText().then(m => send(res, 200, m.body, m.contentType), () => send(res, 500, { status: 'error' }));
      return;
    }
    send(res, 404, { status: 'not-found' });
  });
  // Lange offene Verbindungen (Proben mit keep-alive) sollen das Beenden nicht aufhalten
  server.keepAliveTimeout = 5000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host ?? '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : o.port;
      o.log.info({ port }, 'Betriebs-Endpunkt bereit');
      resolve({
        port,
        close: () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }),
      });
    });
  });
}
