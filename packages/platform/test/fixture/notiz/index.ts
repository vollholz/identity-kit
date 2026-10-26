/** Modul Notizen der Test-App: Routen, Job und MCP-Werkzeuge. */
import { z } from 'zod';
import { defineModule, organisationArg } from '../../../src/index.ts';
import { aboRoute } from './abo.ts';
import { pruefJob } from './jobs.ts';
import { registerRoutes } from './routes.ts';

export const notizModule = defineModule({
  name: 'notiz',
  tags: [{ name: 'Notizen', description: 'Notizen der Organisation mit Zeitraum und Klassifizierung.' }],
  register: registerRoutes,
  publicRoutes: [aboRoute],
  jobs: [pruefJob],
  mcpTools: {
    list_notizen: {
      description: 'Notizen der Organisation auflisten, sortiert nach Name, mit Suche und Seiten.',
      input: {
        q: z.string().max(200).optional().describe('Suche im Namen'),
        cursor: z.string().max(512).optional().describe('nextCursor der vorherigen Seite'),
        limit: z.number().int().min(1).max(200).optional(),
        organisation: organisationArg,
      },
      call: async (org, a) => (await org.api.call('GET', '/v1/notizen', { query: { q: a.q, cursor: a.cursor, limit: a.limit } })).body,
    },
    get_notiz: {
      description: 'Eine Notiz mit allen Feldern lesen.',
      input: { id: z.string().uuid().describe('ID der Notiz'), organisation: organisationArg },
      call: async (org, a) => (await org.api.call('GET', `/v1/notizen/${encodeURIComponent(a.id)}`)).body,
    },
  },
});
