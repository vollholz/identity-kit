/**
 * Haken der App je Produktmodul (`defineApp({ moduleHooks })`, Konzept «Module je Organisation», Abschnitt 7).
 * `einrichten` und `hindernisse` gehen unverändert an `createIam`; `nachholen` kann lange dauern und läuft deshalb nicht
 * in der Transaktion des Aktivierens: Dort reiht die Plattform den Auftrag `platform.module-nachholen` ein (höchstens
 * einer offen je Modul und Organisation), den der Worker mit dem Haken der App ausführt (`seit` = letztes Deaktivieren).
 */
import type { Model, ModuleHooks } from '@vollholz/iam';
import type { PlatformContext } from '../context.ts';
import { activeModulesIn } from './modules.ts';
import { enqueue, type JobDefinition } from './queue.ts';

/** Art des Auftrags, der `nachholen` der App im Worker ausführt. */
export const NACHHOLEN_JOB = 'platform.module-nachholen';

/** Nutzlast des Auftrags `platform.module-nachholen`. */
export interface NachholenPayload extends Record<string, unknown> { modul: string; seit: string }

/** Haken für `createIam`: `nachholen` reiht den Auftrag ein; null ohne Haken. */
export function moduleHooksFor(ctx: PlatformContext, hooks: ModuleHooks | null): ModuleHooks | null {
  if (!hooks || !Object.keys(hooks).length) return null;
  return Object.fromEntries(Object.entries(hooks).map(([modul, h]) => [modul, h.nachholen ? {
    ...h,
    nachholen: async (tx, _tenantId, seit) => {
      const payload: NachholenPayload = { modul, seit: seit.toISOString() };
      return enqueue(ctx, tx, NACHHOLEN_JOB, payload, { dedupeKey: modul });
    },
  } : h]));
}

/**
 * Auftrag `platform.module-nachholen`: ruft `nachholen` der App in einer Transaktion im Mandanten (volle Sicht). Ist das
 * Modul inzwischen wieder inaktiv, endet er ohne Wirkung (das nächste Aktivieren reiht ihn neu ein).
 */
export function nachholenJob(ctx: PlatformContext, hooks: ModuleHooks, model: Pick<Model, 'features' | 'modules' | 'activeModules'>): JobDefinition<NachholenPayload> {
  return {
    kind: NACHHOLEN_JOB,
    async run(job, p) {
      const hook = hooks[p.modul]?.nachholen;
      if (!hook) { job.log.warn({ job: job.jobId, modul: p.modul }, 'Nachholen: kein Haken für das Modul'); return; }
      await job.tx(async tx => {
        if (!(await activeModulesIn(tx, ctx, model)).has(p.modul)) return;
        await hook(tx, job.tenantId, new Date(p.seit));
      });
    },
  };
}
