/** Testhilfen: fetch-Ersatz mit Antworten je «METHOD /pfad» (aus vollholz/assets `web/src/test/utils.tsx`). */
import { vi } from 'vitest';

type Handler = (req: Request) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers } });

/** fetch ersetzen: Schlüssel «METHOD /pfad» (ohne Query) → Antwort. Gibt die Aufrufe zurück. */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: Request[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    calls.push(req.clone());
    const h = routes[`${req.method} ${new URL(req.url).pathname}`];
    return h ? h(req) : json({ title: 'Nicht gefunden', status: 404 }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}
