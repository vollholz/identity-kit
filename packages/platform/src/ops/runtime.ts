/**
 * Geordnetes Beenden (app-boilerplate 3.1): Auf SIGTERM bzw. SIGINT meldet `/readyz` sofort 503, nach `SHUTDOWN_DELAY`
 * (der Load Balancer nimmt die Instanz heraus) laufen die registrierten Schritte in umgekehrter Reihenfolge (Server
 * schliessen, Worker holt nichts mehr ab, Pools schliessen), dann wird die Telemetrie geleert und der Prozess endet mit
 * 0. Dauert alles länger als `SHUTDOWN_TIMEOUT`, endet er mit 1. Ein zweites Signal wird ignoriert.
 */
import { shutdownTelemetry } from './telemetry.ts';

export interface RuntimeLog { info(o: object, m: string): void; warn(o: object, m: string): void; error(o: object, m: string): void }

export interface RuntimeOptions {
  service: string;
  shutdownDelayMs: number;
  shutdownTimeoutMs: number;
  log: RuntimeLog;
  /** Ende des Prozesses (Tests injizieren eine Attrappe). */
  exit?: (code: number) => void;
  /** Signale abonnieren (Standard true; Tests ohne). */
  signals?: boolean;
}

export interface Runtime {
  readonly ready: boolean;
  markReady(): void;
  onShutdown(fn: () => Promise<void> | void): void;
  shutdown(signal?: string): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function createRuntime(o: RuntimeOptions): Runtime {
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const steps: (() => Promise<void> | void)[] = [];
  let ready = false;
  let stopping: Promise<void> | null = null;

  async function run(signal: string): Promise<void> {
    ready = false;
    o.log.info({ service: o.service, signal, delayMs: o.shutdownDelayMs }, 'Beenden: nicht mehr bereit');
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      o.log.error({ service: o.service, timeoutMs: o.shutdownTimeoutMs }, 'Beenden: Zeit überschritten');
      exit(1);
    }, o.shutdownTimeoutMs);
    timer.unref?.();
    try {
      await sleep(o.shutdownDelayMs);
      for (const step of [...steps].reverse()) {
        try { await step(); } catch (err) { o.log.warn({ err: String(err) }, 'Beenden: Schritt gescheitert'); }
      }
      await shutdownTelemetry();
      finished = true;
      clearTimeout(timer);
      o.log.info({ service: o.service }, 'Beendet');
      exit(0);
    } catch (err) {
      finished = true;
      clearTimeout(timer);
      o.log.error({ err: String(err) }, 'Beenden gescheitert');
      exit(1);
    }
  }

  const rt: Runtime = {
    get ready() { return ready; },
    markReady() { if (!stopping) ready = true; },
    onShutdown(fn) { steps.push(fn); },
    shutdown(signal = 'manual') {
      // Zweites Signal: dasselbe laufende Beenden
      stopping ??= run(signal);
      return stopping;
    },
  };
  if (o.signals !== false) for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { void rt.shutdown(sig); });
  return rt;
}
