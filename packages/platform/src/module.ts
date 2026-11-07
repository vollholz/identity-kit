/**
 * Fachmodul einer App: Routen, öffentliche Routen mit Token, Jobs, feste Aufgaben, Abnehmer der Outbox, Rotation von Geheimnissen, Werkzeuge des
 * MCP-Dienstes und der Tag in der API-Doku – alles an einer Stelle, eingehängt über `defineApp({ modules })`. Ein
 * Modul kennt nur `Deps` und die Bausteine des Pakets, nie ein anderes Modul.
 *
 * Produktmodule (Konzept «Module je Organisation», Abschnitt 6): `modul` ordnet ein Code-Modul einem Produktmodul des
 * Modells zu (`defineModel({ modules })`); Routen (`config.modul`), öffentliche Routen, Jobs, Aufgaben, Abnehmer und
 * Werkzeuge können eine Teilfunktion `modul.teil` tragen. Ohne Angabe gilt das Modul des Code-Moduls (`defineModule`
 * trägt es ein). Ist das Modul in einer Organisation nicht aktiv, setzt die Plattform das durch (403, Worker, MCP).
 */
import type { Model } from '@vollholz/iam';
import type { FastifyInstance } from 'fastify';
import type { Deps } from './http/app.ts';
import type { PublicRoute } from './http/public-route.ts';
import type { ToolDef } from './mcp/tools.ts';
import type { Rewrapper } from './ops/rotation.ts';
import type { OutboxConsumer } from './worker/outbox.ts';
import type { JobDefinition, PeriodicTask } from './worker/queue.ts';

export interface ApiTag { name: string; description: string }

export interface PlatformModule {
  /** Eindeutig in der App, z. B. `schichtart`. */
  name: string;
  /**
   * Produktmodul (Schlüssel aus `modules` des Modells) oder Teilfunktion `modul.teil`. Pflicht, wenn das Modell `modules`
   * hat (sonst Fehler beim Start); ohne `modules` im Modell nicht erlaubt. Gilt für Routen, öffentliche Routen, Jobs,
   * Aufgaben, Abnehmer und Werkzeuge des Moduls, die kein eigenes `modul` nennen.
   */
  modul?: string;
  /** Tags der Routen in der API-Doku (Reihenfolge = Reihenfolge der Module). */
  tags?: readonly ApiTag[];
  /**
   * Routen einhängen. Je Route überschreibt `config: { modul: 'modul.teil' }` das Modul des Code-Moduls. Routen in
   * eigenen Plugins (`app.register`) erhalten das Modul ebenfalls, solange sie während `register` eingehängt werden.
   */
  register?(app: FastifyInstance, deps: Deps): void | Promise<void>;
  /** Öffentliche Routen mit Token ohne Sitzung (Organisation aus dem Alias, z. B. Kalender-Abo); siehe `PublicRoute`. */
  publicRoutes?: readonly PublicRoute[];
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

/**
 * Typprüfung beim Schreiben eines Moduls. Mit `modul` trägt es das Produktmodul in seine öffentlichen Routen, Jobs,
 * Aufgaben, Abnehmer und Werkzeuge ein, die keines nennen (Kopien; die übergebenen Objekte bleiben unverändert).
 */
export function defineModule<M extends PlatformModule>(m: M): M {
  const modul = m.modul;
  if (modul === undefined) return m;
  const tag = <T extends { modul?: string }>(x: T): T => (x.modul === undefined ? { ...x, modul } : x);
  return {
    ...m,
    ...(m.publicRoutes ? { publicRoutes: m.publicRoutes.map(tag) } : {}),
    ...(m.jobs ? { jobs: m.jobs.map(tag) } : {}),
    ...(m.tasks ? { tasks: m.tasks.map(tag) } : {}),
    ...(m.consumers ? { consumers: m.consumers.map(tag) } : {}),
    ...(m.mcpTools ? { mcpTools: Object.fromEntries(Object.entries(m.mcpTools).map(([k, t]) => [k, tag(t)])) } : {}),
  };
}

/** Modul der Teile eines Code-Moduls: eigenes `modul` oder das des Code-Moduls (auch ohne `defineModule`). */
export const modulOf = (m: Pick<PlatformModule, 'modul'>, part?: { modul?: string }): string | undefined => part?.modul ?? m.modul;

/**
 * Prüft die Module einer App: eindeutige Namen, Jobs, Aufgaben, Abnehmer und Werkzeuge. Mit `model`: jedes `modul`
 * (Code-Modul und seine Teile) ist ein Modul oder `modul.teil` des Modells; hat das Modell `modules`, nennt jedes
 * Code-Modul sein Modul. Liefert Warnungen: Module des Verzeichnisses (ausser dem Kern) ohne Code-Modul, Job,
 * Aufgabe, Abnehmer, Werkzeug oder Recht (Routen mit `config.modul` prüft `buildApp` beim Einhängen).
 */
export function checkModules(modules: readonly PlatformModule[], model?: Pick<Model, 'features' | 'modules' | 'coreModule' | 'permissions' | 'moduleOf'>): string[] {
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
  if (!model) return [];

  const has = !!model.features.modules;
  const known = new Set(model.modules.flatMap(m => [m.key, ...m.parts.map(p => p.key)]));
  const used = new Set<string>();
  const check = (where: string, modul: string | undefined) => {
    if (modul === undefined) return;
    if (!has) throw new Error(`${where}: modul «${modul}» ohne modules im Modell`);
    if (!known.has(modul)) throw new Error(`${where}: modul «${modul}» nicht im Modell (Modul oder modul.teil)`);
    used.add(modul.split('.')[0]!);
  };
  for (const m of modules) {
    if (has && m.modul === undefined) throw new Error(`Modul «${m.name}»: modul fehlt (das Modell hat modules; Kern: «${model.coreModule}»)`);
    check(`Modul «${m.name}»`, m.modul);
    for (const r of m.publicRoutes ?? []) check(`Öffentliche Route «${r.name}»`, r.modul);
    for (const j of m.jobs ?? []) check(`Job-Art «${j.kind}»`, j.modul);
    for (const t of m.tasks ?? []) check(`Aufgabe «${t.name}»`, t.modul);
    for (const c of m.consumers ?? []) check(`Abnehmer «${c.name}»`, c.modul);
    for (const [k, t] of Object.entries(m.mcpTools ?? {})) check(`MCP-Werkzeug «${k}»`, t.modul);
  }
  if (!has) return [];
  for (const p of model.permissions) used.add(model.moduleOf(p).split('.')[0]!);
  return model.modules.filter(m => !m.core && !used.has(m.key))
    .map(m => `Produktmodul «${m.key}»: kein Code-Modul, Job, Aufgabe, Abnehmer, Werkzeug oder Recht gehört dazu`);
}
