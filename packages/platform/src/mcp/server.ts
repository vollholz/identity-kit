/**
 * MCP-Dienst (app-boilerplate 5.10): Streamable HTTP unter `/mcp` (zustandslos, nur POST), Protected
 * Resource Metadata (RFC 9728), Token-Prüfung mit Zielgruppe `<product>-mcp`, Token Exchange (RFC 8693) zu
 * `<product>-api` mit DPoP-gebundenem Token – alles aus @vollholz/iam. Werkzeuge aus dem Modell, Aufrufe nur über
 * die REST-API. Kein Datenbank-Pool; Replay-Schutz im Speicher. Jeder Werkzeugaufruf wird protokolliert.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DpopSigner, McpAuth, OidcProvider, registerMcpAuth, TokenExchanger, TokenVerifier, type McpAuthorized, type McpOrg, type Model } from '@vollholz/iam';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { PlatformConfig } from '../config/env.ts';
import type { PlatformContext } from '../context.ts';
import { REDACT_PATHS } from '../core/redact.ts';
import type { ToolDef } from './tools.ts';

export interface McpOptions {
  platform: PlatformContext;
  model: Model<string>;
  /** Umsetzung der Werkzeuge aus `model.mcpTools` (aus den Modulen). */
  tools: Readonly<Record<string, ToolDef>>;
}

/** Jedes Werkzeug des Modells braucht eine Umsetzung (Fehler beim Start statt beim ersten Aufruf). */
export function checkTools(o: Pick<McpOptions, 'model' | 'tools'>): void {
  for (const name of Object.keys(o.model.mcpTools)) if (!o.tools[name]) throw new Error(`MCP-Werkzeug ${name}: im Modell, aber ohne Umsetzung in einem Modul`);
  for (const name of Object.keys(o.tools)) if (!o.model.mcpTools[name]) throw new Error(`MCP-Werkzeug ${name}: umgesetzt, aber nicht im Modell (mcpTools)`);
}

/** Werkzeug-Server für eine Anfrage: nur Werkzeuge, deren Recht in einer der Organisationen gilt. */
export function buildToolServer(m: McpOptions, a: McpAuthorized, log: FastifyBaseLogger): McpServer {
  const server = new McpServer({ name: m.platform.product, title: m.platform.title, version: '1' });
  let offered = 0;
  for (const [name, def] of Object.entries(m.model.mcpTools)) {
    const tool = m.tools[name];
    if (!tool) throw new Error(`MCP-Werkzeug ${name}: im Modell, aber ohne Umsetzung in einem Modul`);
    const orgs = a.orgs.filter(o => o.me.permissions.includes(def.permission));
    if (!orgs.length) continue;
    offered++;
    server.registerTool(name, { title: def.title, description: tool.description, inputSchema: tool.input, annotations: { readOnlyHint: def.readOnly, openWorldHint: false } }, async args => {
      const pick: McpOrg | undefined = args.organisation ? orgs.find(o => o.me.tenant.alias === args.organisation) : orgs.length === 1 ? orgs[0] : undefined;
      if (!pick) {
        return { isError: true, content: [{ type: 'text' as const, text: `Wähle eine Organisation mit «organisation»: ${orgs.map(o => o.me.tenant.alias).join(', ')}` }] };
      }
      log.info({ tool: name, org: pick.me.tenant.alias, sub: a.token.claims.sub, azp: a.token.claims.azp }, 'MCP-Werkzeug aufgerufen');
      try {
        const result = await tool.call(pick, args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: result as Record<string, unknown> };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
      }
    });
  }
  // Ohne Recht auf ein Werkzeug eine leere Liste statt «Method not found»
  if (!offered) {
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  }
  return server;
}

export async function buildMcpApp(m: McpOptions, cfg: PlatformConfig, o: { fetch?: typeof fetch; logger?: boolean } = {}): Promise<{ app: FastifyInstance; auth: McpAuth }> {
  checkTools(m);
  const { model } = m;
  const provider = new OidcProvider(cfg.oidc.issuer, o.fetch ?? fetch);
  const exchanger = new TokenExchanger(cfg, provider, { dpop: await DpopSigner.create(cfg.mcp.dpopKey), model, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const auth = new McpAuth({ cfg, model, verifier: new TokenVerifier(provider, cfg), exchanger, allowedOrigins: [], ...(o.fetch ? { fetch: o.fetch } : {}) });
  const app = Fastify({
    logger: o.logger === false ? false : { level: cfg.app.logLevel, redact: { paths: REDACT_PATHS, censor: '[entfernt]' } },
    trustProxy: cfg.app.http.trustProxy as never, bodyLimit: cfg.app.http.bodyLimit,
  });
  registerMcpAuth(app, auth);
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'"); return payload; });
  app.route({
    method: ['GET', 'POST', 'DELETE'], url: '/mcp',
    handler: async (req, reply) => {
      const a = await auth.authorize({ method: req.method, url: req.url, headers: req.headers, id: req.id });
      const server = buildToolServer(m, a, req.log);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.hijack();
      reply.raw.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  return { app, auth };
}
