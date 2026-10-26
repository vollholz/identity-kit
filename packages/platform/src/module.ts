/**
 * Fachmodul einer App: Routen, Jobs, feste Aufgaben, Abnehmer der Outbox, Rotation von Geheimnissen, Werkzeuge des
 * MCP-Dienstes und der Tag in der API-Doku – alles an einer Stelle, eingehängt über `defineApp({ modules })`. Ein
 * Modul kennt nur `Deps` und die Bausteine des Pakets, nie ein anderes Modul.
 */
import type { FastifyInstance } from 'fastify';
import type { Deps } from './http/app.ts';
import type { ToolDef } from './mcp/tools.ts';
import type { Rewrapper } from './ops/rotation.ts';
import type { OutboxConsumer } from './worker/outbox.ts';
import type { JobDefinition, PeriodicTask } from './worker/queue.ts';

export interface ApiTag { name: string; description: string }

export interface PlatformModule {
  /** Eindeutig in der App, z. B. `schichtart`. */
  name: string;
  /** Tags der Routen in der API-Doku (Reihenfolge = Reihenfolge der Module). */
  tags?: readonly ApiTag[];
  /** Routen einhängen. */
  register?(app: FastifyInstance, deps: Deps): void | Promise<void>;
  /** Arten von Jobs (`<modul>.<aufgabe>`). */
  jobs?: readonly JobDefinition<any>[];
  /** Feste Aufgaben über alle Mandanten. */
  tasks?: readonly PeriodicTask[];
  /** Abnehmer der Outbox (z. B. Webhooks). */
  consumers?: readonly OutboxConsumer[];
  /** Neu verpacken eigener Geheimnisse bei der Rotation der Hauptschlüssel. */
  rewrappers?: readonly Rewrapper[];
  /** Umsetzung der Werkzeuge aus `model.mcpTools` (Name → Beschreibung, Eingaben, Aufruf über die REST-API). */
  mcpTools?: Readonly<Record<string, ToolDef>>;
}

/** Typprüfung beim Schreiben eines Moduls; liefert es unverändert. */
export const defineModule = <M extends PlatformModule>(m: M): M => m;

/** Prüft die Module einer App: eindeutige Namen, Jobs, Aufgaben, Abnehmer und Werkzeuge. */
export function checkModules(modules: readonly PlatformModule[]): void {
  const dup = (what: string, names: string[]) => {
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) throw new Error(`Module: ${what} «${n}» doppelt`);
      seen.add(n);
    }
  };
  dup('Modul', modules.map(m => m.name));
  dup('Job-Art', modules.flatMap(m => (m.jobs ?? []).map(j => j.kind)));
  dup('Aufgabe', modules.flatMap(m => (m.tasks ?? []).map(t => t.name)));
  dup('Abnehmer', modules.flatMap(m => (m.consumers ?? []).map(c => c.name)));
  dup('Rotation', modules.flatMap(m => (m.rewrappers ?? []).map(r => r.name)));
  dup('MCP-Werkzeug', modules.flatMap(m => Object.keys(m.mcpTools ?? {})));
  dup('Tag', modules.flatMap(m => (m.tags ?? []).map(t => t.name)));
}
