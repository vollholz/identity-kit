/**
 * Fehler der API (application/problem+json, RFC 9457) in verständlicher Form. `ApiError` ist die einzige Fehlerklasse
 * für Aufrufe an den Vertrag; Apps übernehmen sie aus dem Paket, damit `instanceof ApiError` überall gilt.
 */
import type { ProblemDetails } from './contract.ts';
import { t, type IamTextKey } from './texts/index.ts';

export type { ProblemDetails };

/** Rückfalltext je Status, wenn der Server keinen Titel liefert. */
export function statusText(status: number): string {
  const key = `iam.error.${status}` as IamTextKey;
  const text = t(key);
  return text === key ? t('iam.error.status', { status }) : text;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails;
  readonly requestId: string | null;
  constructor(status: number, problem: ProblemDetails, requestId: string | null = null) {
    const title = problem.title ?? statusText(status);
    super(problem.detail ? `${title}: ${problem.detail}` : title);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.requestId = requestId;
  }
  get title(): string { return this.problem.title ?? statusText(this.status); }
  get detail(): string | undefined { return this.problem.detail; }
  get fieldErrors(): { path: string; message: string }[] { return Array.isArray(this.problem.errors) ? this.problem.errors : []; }
}

/** Netzwerkfehler (Server nicht erreichbar) als ApiError mit Status 0. */
export function networkError(e: unknown): ApiError {
  return new ApiError(0, { title: statusText(0), detail: t('iam.error.network') + (e instanceof Error && e.message ? ` (${e.message})` : '') });
}

/** Fehler aus einer Antwort lesen (problem+json, sonst nur der Status). */
export async function errorFrom(response: Response): Promise<ApiError> {
  let body: ProblemDetails = {};
  try {
    const parsed: unknown = await response.clone().json();
    // nur ein Objekt ist ein Problem; `null`, Zahl, Liste (z. B. von einem Proxy) zählen wie kein Körper
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as ProblemDetails;
  } catch { /* kein JSON */ }
  // Feldfehler nur, wenn jedes Element `path` und `message` als Text hat; sonst ohne Feldfehler
  if ('errors' in body) {
    const ok = Array.isArray(body.errors) && body.errors.every(e => e !== null && typeof e === 'object' && typeof e.path === 'string' && typeof e.message === 'string');
    if (!ok) { const { errors: _, ...rest } = body; body = rest; }
  }
  return new ApiError(response.status, body, response.headers.get('x-request-id'));
}

export interface ErrorText { title: string; detail?: string; fields: { path: string; message: string }[]; status?: number; requestId?: string | null }

/** Einheitliche Texte für die Anzeige eines beliebigen Fehlers. */
export function describeError(e: unknown): ErrorText {
  if (e instanceof ApiError) return { title: e.title, detail: e.detail, fields: e.fieldErrors, status: e.status, requestId: e.requestId };
  if (e instanceof Error) return { title: t('iam.error.unexpected'), detail: e.message, fields: [] };
  return { title: t('iam.error.unexpected'), detail: String(e), fields: [] };
}

/** Feldfehler eines 422 lesbar machen: IDs im Pfad durch Namen ersetzen. */
export function fieldErrorText(f: { path: string; message: string }, names: Record<string, string> = {}): string {
  const parts = f.path.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  const name = last && names[last] ? names[last] : parts.length ? parts.join(' › ') : '';
  return name ? `${name}: ${f.message}` : f.message;
}
