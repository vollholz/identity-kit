/**
 * Metriken der App (app-boilerplate 5.5, 6): Dauer je Route, Jobs, Outbox. Ohne gestartete Telemetrie wirken die
 * Instrumente nicht (No-op-Meter der API).
 */
import type { Counter, Histogram } from '@opentelemetry/api';
import { meter, prometheusText } from './telemetry.ts';

interface Instruments { http: Histogram; jobs: Histogram; outbox: Counter }
let instruments: Instruments | null = null;

// Erst beim ersten Gebrauch anlegen: Das Meter des gestarteten SDK steht dann sicher bereit
function get(): Instruments {
  if (instruments) return instruments;
  const m = meter();
  instruments = {
    http: m.createHistogram('http.server.request.duration', { unit: 's', description: 'Dauer der HTTP-Anfragen je Route' }),
    jobs: m.createHistogram('platform.job.duration', { unit: 's', description: 'Dauer der Jobs je Art und Ergebnis' }),
    outbox: m.createCounter('platform.outbox.dispatched', { description: 'Verteilte Ereignisse der Outbox' }),
  };
  return instruments;
}

export const metrics = {
  /** Eine beantwortete Anfrage; `route` ist das Muster (`/v1/dinge/:id`), nie die konkrete Adresse. */
  httpRequest(route: string, method: string, status: number, ms: number): void {
    get().http.record(ms / 1000, { 'http.route': route, 'http.request.method': method, 'http.response.status_code': status });
  },
  jobDone(kind: string, status: 'done' | 'retry' | 'failed', ms: number): void {
    get().jobs.record(ms / 1000, { 'job.kind': kind, 'job.status': status });
  },
  outboxDispatched(n: number): void {
    if (n > 0) get().outbox.add(n);
  },
};

/** Inhalt für `/metrics` (Prometheus-Textformat); ohne eingeschaltete Metriken leer. */
export async function metricsText(): Promise<{ contentType: string; body: string }> {
  return { contentType: 'text/plain; version=0.0.4; charset=utf-8', body: (await prometheusText()) ?? '' };
}
