/**
 * Schlanker Client für die REST-API der App (aus Assets `mcp/api.ts`). Der MCP-Dienst greift ausschliesslich hierüber auf Daten zu –
 * RLS, Rollen ∩ Scopes ∩ ACL und Audit (Quelle «mcp», erkannt am Client im getauschten Token) gelten unverändert.
 *
 * Das API-Token ist an den Schlüssel des MCP-Dienstes gebunden: jeder Aufruf sendet `Authorization: DPoP …` und
 * einen frischen Proof. `htu` ist die öffentliche Adresse der API (PUBLIC_BASE_URL), gegen die die API prüft –
 * nicht MCP_API_URL, über die der Aufruf intern läuft. Verlangt die API eine Nonce, wird einmal wiederholt.
 */
import { randomUUID } from 'node:crypto';
import { wantsNonce, type DpopSigner } from './dpop.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Record<string, unknown>;
  constructor(status: number, problem: Record<string, unknown>) {
    super([problem.title, problem.detail].filter(Boolean).join(': ') || `Status ${status}`);
    this.status = status; this.problem = problem;
  }
}

export interface CallOptions { query?: Record<string, string | number | boolean | string[] | undefined>; body?: unknown; headers?: Record<string, string>; idempotencyKey?: string }

export class ApiClient {
  private readonly base: string;
  private readonly publicBase: string;
  private readonly token: string;
  private readonly dpop: DpopSigner;
  private readonly tenant: string | null;
  private readonly fetchImpl: typeof fetch;
  readonly requestId: string;

  /** @param o.publicBaseUrl öffentliche Adresse der API für `htu` (ohne Angabe: `baseUrl`). */
  constructor(o: { baseUrl: string; publicBaseUrl?: string; token: string; dpop: DpopSigner; tenant?: string | null; fetch?: typeof fetch; requestId?: string }) {
    this.base = o.baseUrl.replace(/\/$/, ''); this.publicBase = (o.publicBaseUrl ?? o.baseUrl).replace(/\/$/, ''); this.token = o.token; this.dpop = o.dpop; this.tenant = o.tenant ?? null; this.fetchImpl = o.fetch ?? fetch; this.requestId = o.requestId ?? randomUUID();
  }

  async call<T = any>(method: string, path: string, o: CallOptions = {}): Promise<{ status: number; body: T; headers: Headers }> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(x));
    }
    const headers: Record<string, string> = { authorization: `DPoP ${this.token}`, accept: 'application/json', 'x-request-id': this.requestId, ...o.headers };
    if (this.tenant) headers['x-tenant'] = this.tenant;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
    const htu = this.publicBase + path;
    const payload = o.body !== undefined ? JSON.stringify(o.body) : undefined;
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      headers.dpop = await this.dpop.proof(method, htu, this.token);
      res = await this.fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(30_000) });
      const fresh = this.dpop.remember(htu, res.headers);
      // RFC 9449 Abschnitt 9: Nonce verlangt → einmal mit der neuen Nonce wiederholen (die Anfrage wurde nicht ausgeführt)
      if (attempt === 0 && fresh && wantsNonce(res.status, res.headers)) { await res.body?.cancel(); continue; }
      break;
    }
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { title: text.slice(0, 500) }; }
    if (!res.ok) throw new ApiError(res.status, (body && typeof body === 'object' ? body : { title: String(body) }) as Record<string, unknown>);
    return { status: res.status, body: body as T, headers: res.headers };
  }

  get<T = any>(path: string, query?: CallOptions['query']) { return this.call<T>('GET', path, { query }).then(r => r.body); }
}
