/**
 * Modul Berichte der Test-App (Produktmodul `berichte`, braucht `notizen`): eine Route, ein Job, eine feste Aufgabe,
 * ein Abnehmer der Outbox und ein MCP-Werkzeug – alle ohne eigenes `modul`, also mit dem des Code-Moduls. Die Zustände
 * unten beobachten die Tests (module.test.ts).
 */
import { Type } from '@sinclair/typebox';
import { defineModule, organisationArg, systemActor, type JobDefinition, type ModuleBlocker, type ModuleHooks, type OutboxConsumer, type OutboxEvent, type PeriodicTask, type ToolDef, type TaskTenant } from '../../../src/index.ts';
import { record } from '../platform.ts';

export const BERICHT_JOB = 'bericht.erstellen';

/** Beobachtung der Tests: Organisationen der letzten festen Aufgabe, Ereignisse beim Abnehmer, Hindernisse. */
export const seen = { tenants: [] as TaskTenant[], events: [] as OutboxEvent[], blockers: [] as ModuleBlocker[], failSetup: false };

const job: JobDefinition<{ n: number }> = {
  kind: BERICHT_JOB,
  async run(ctx, p) {
    await ctx.tx(tx => record(tx, ctx.actor, { action: 'bericht.erstellt', resourceType: 'tenant', resourceId: ctx.tenantId, data: { n: p.n } }));
  },
};

const task: PeriodicTask = {
  name: 'bericht.taeglich',
  // Ohne Zeitgeber (die Tests rufen runTask)
  intervalMs: () => 0,
  async run(ctx) { seen.tenants = await ctx.tenants(); },
};

const consumer: OutboxConsumer = { name: 'bericht.zaehler', accept: async (_tx, events) => { seen.events.push(...events); } };

export const berichtModule = defineModule({
  name: 'bericht',
  modul: 'berichte',
  tags: [{ name: 'Berichte', description: 'Auswertungen der Notizen.' }],
  register(app) {
    app.get('/v1/berichte', {
      schema: { tags: ['Berichte'], summary: 'Bericht der Organisation', response: { 200: Type.Object({ notizen: Type.Integer() }) } },
    }, async req => {
      await req.need('bericht:read');
      return { notizen: await req.tx(async tx => Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM probe.notiz')).rows[0]!.n)) };
    });
  },
  jobs: [job],
  tasks: [task],
  consumers: [consumer],
  mcpTools: {
    get_bericht: {
      description: 'Bericht der Organisation lesen (Zahl der Notizen).',
      input: { organisation: organisationArg },
      call: async org => (await org.api.call('GET', '/v1/berichte')).body,
    } satisfies ToolDef as ToolDef,
  },
});

/** Haken der App für das Produktmodul `berichte` (Audit als Beobachtung). */
export const berichtHooks: ModuleHooks = {
  berichte: {
    einrichten: (tx, tenantId) => (seen.failSetup ? Promise.reject(new Error('einrichten gescheitert')) : record(tx, systemActor('system', 'module'), { action: 'bericht.eingerichtet', resourceType: 'tenant', resourceId: tenantId })),
    hindernisse: async () => seen.blockers,
    nachholen: (tx, tenantId, seit) => record(tx, systemActor('system', 'module'), { action: 'bericht.nachgeholt', resourceType: 'tenant', resourceId: tenantId, data: { seit: seit.toISOString() } }),
  },
};
