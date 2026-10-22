/**
 * Fachliche HTTP-Fehler, ausgegeben als application/problem+json (RFC 9457; aus Assets `http/errors.ts`).
 * Texte de, Du-Form. Eine App mit eigener Fehlerbehandlung erkennt `HttpError` aus diesem Paket (Assets exportiert in
 * Phase 2 diese Klasse, damit es nur eine gibt).
 */
export class HttpError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly headers: Record<string, string>;
  readonly extra: Record<string, unknown>;
  constructor(status: number, title: string, detail?: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    super(detail ? `${title}: ${detail}` : title);
    this.status = status; this.title = title; this.detail = detail; this.headers = headers; this.extra = extra;
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} nicht gefunden`);
export const forbidden = (detail?: string) => new HttpError(403, 'Keine Berechtigung', detail);
export const conflict = (detail: string, extra: Record<string, unknown> = {}) => new HttpError(409, 'Konflikt', detail, {}, extra);
export const invalid = (detail: string, errors?: { path: string; message: string }[]) => new HttpError(422, 'Ungültige Eingabe', detail, {}, errors ? { errors } : {});

/**
 * Körper der Antwort nach RFC 9457: `type` = `typeBase` + Status (Assets: `https://assets.example.ch/probleme/`),
 * `instance` = Pfad der Anfrage, dazu die Zusatzfelder des Fehlers.
 */
export function problemBody(err: HttpError, typeBase: string, instance?: string): Record<string, unknown> {
  return { type: `${typeBase}${err.status}`, title: err.title, status: err.status, ...(err.detail ? { detail: err.detail } : {}), ...(instance ? { instance } : {}), ...err.extra };
}
