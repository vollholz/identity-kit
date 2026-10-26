/**
 * OpenTelemetry (app-boilerplate 6, Beobachtbarkeit): Traces (http, pg, undici) und Metriken, ausgeleitet über OTLP/HTTP
 * an `OTEL_EXPORTER_OTLP_ENDPOINT` und/oder im Prometheus-Format unter `/metrics` des Betriebs-Endpunkts
 * (`METRICS_ENABLED`). Gestartet von `preload.ts` vor allen anderen Modulen, damit die Instrumentierungen greifen.
 *
 * Ohne Endpunkt und ohne Metriken bleibt alles aus: `tracer()` und die Instrumente in `metrics.ts` wirken dann nicht.
 */
import { metrics as otelMetrics, trace, type Meter, type Tracer } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader, type IMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export const TRACER_NAME = '@vollholz/platform';

export interface TelemetryOptions {
  /** OTLP/HTTP-Empfänger (z. B. `http://otel-collector:4318`); null = keine Ausleitung. */
  otlpEndpoint: string | null;
  /** Metriken im Prometheus-Format für `/metrics`. */
  prometheus: boolean;
  serviceName: string;
  /** Prozess (`api`, `worker`, `mcp`, …) als `service.instance.id`-Suffix und Attribut `process.command`. */
  process: string;
  version?: string;
}

interface State { sdk: NodeSDK; prometheus: PrometheusExporter | null; stopped: Promise<void> | null }
let state: State | null = null;

/** Ist die Telemetrie gestartet? */
export const telemetryEnabled = () => state !== null;

/** Startet das SDK einmal je Prozess (idempotent). Liefert false, wenn nichts einzuschalten ist. */
export function startTelemetry(o: TelemetryOptions): boolean {
  if (state) return true;
  if (!o.otlpEndpoint && !o.prometheus) return false;
  const base = o.otlpEndpoint?.replace(/\/+$/, '') ?? null;
  const readers: IMetricReader[] = [];
  const prometheus = o.prometheus ? new PrometheusExporter({ preventServerStart: true }) : null;
  if (prometheus) readers.push(prometheus);
  if (base) readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }), exportIntervalMillis: 30_000 }));
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: o.serviceName,
      [ATTR_SERVICE_VERSION]: o.version ?? process.env.npm_package_version ?? '0.0.0',
      'service.instance.id': `${o.process}-${process.pid}`,
      'process.command': o.process,
    }),
    ...(base ? { traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }) } : {}),
    metricReaders: readers,
    // Keine Body-Inhalte, keine Kopfzeilen mit Tokens: nur die Standardattribute der Instrumentierungen
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: req => req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics' }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  state = { sdk, prometheus, stopped: null };
  return true;
}

/** Leert und beendet die Telemetrie (idempotent, Fehler nur gemeldet). */
export async function shutdownTelemetry(): Promise<void> {
  if (!state) return;
  state.stopped ??= state.sdk.shutdown().catch(err => { process.stderr.write(`${JSON.stringify({ level: 'warn', msg: 'Telemetrie nicht sauber beendet', err: String(err) })}\n`); });
  await state.stopped;
}

/** Tracer der App (ohne gestartetes SDK ein No-op-Tracer). */
export function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Meter der App (ohne gestartetes SDK ein No-op-Meter). */
export function meter(): Meter {
  return otelMetrics.getMeter(TRACER_NAME);
}

/** Metriken im Prometheus-Textformat; null, wenn Prometheus nicht eingeschaltet ist. */
export async function prometheusText(): Promise<string | null> {
  const p = state?.prometheus;
  if (!p) return null;
  const { resourceMetrics } = await p.collect();
  return new PrometheusSerializer().serialize(resourceMetrics);
}
