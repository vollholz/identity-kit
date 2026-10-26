/**
 * Jobs der Notizen (Test-App): Nach jeder Änderung prüft der Worker, ob der Zeitraum die Nacht (23–6 Uhr) berührt,
 * und meldet das als Ereignis.
 */
import type { JobDefinition } from '../../../src/index.ts';
import { record } from '../platform.ts';
import * as store from './store.ts';

export const PRUEF_JOB = 'notiz.nachtarbeit-pruefen';

export const pruefJob: JobDefinition<{ id: string; version: number }> = {
  kind: PRUEF_JOB,
  maxAttempts: 5,
  async run(ctx, payload) {
    await ctx.tx(async tx => {
      const r = await store.get(tx, payload.id);
      // Inzwischen gelöscht oder geändert: Die neuere Version hat ihren eigenen Job
      if (!r || r.version !== payload.version || !store.nachtarbeit(r.beginn, r.ende)) return;
      await record(tx, ctx.actor, {
        action: 'notiz.nachtarbeit-erkannt', resourceType: 'notiz', resourceId: r.id,
        data: { version: r.version, beginn: r.beginn, ende: r.ende }, event: { id: r.id, version: r.version, beginn: r.beginn, ende: r.ende },
      });
    });
  },
};
