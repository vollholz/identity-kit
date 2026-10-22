/**
 * Fehler als application/problem+json (RFC 9457) und ihre Schemas für die OpenAPI-Beschreibung (aus Assets
 * `http/app.ts`). Jede Route unter dem API-Präfix erhält die üblichen Fehlerantworten, ohne eigene Angaben zu
 * überschreiben.
 */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { HttpError, problemBody } from '../errors.ts';

/** Antwort nach RFC 9457 mit den Kopfzeilen des Fehlers. */
export function problem(reply: FastifyReply, err: HttpError, typeBase: string, instance?: string) {
  for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
  return reply.status(err.status).type('application/problem+json').send(problemBody(err, typeBase, instance));
}

const problemBase = {
  type: Type.String({ description: 'URI des Problemtyps' }),
  title: Type.String({ description: 'Kurzbeschreibung, gleich für alle Fälle dieses Problems' }),
  status: Type.Integer({ description: 'HTTP-Status' }),
  detail: Type.Optional(Type.String({ description: 'Erklärung dieses Falls' })),
  instance: Type.Optional(Type.String({ description: 'Pfad der Anfrage' })),
};
// additionalProperties: true – Fastify serialisiert über das Schema und würde sonst Zusatzfelder entfernen.
const open = { additionalProperties: true } as const;
const FieldError = Type.Object({ path: Type.String({ description: 'JSON Pointer in die Anfrage, z. B. /attributes/<id>' }), message: Type.String() }, open);
export const PROBLEM_SCHEMAS = {
  Problem: Type.Object(problemBase, { ...open, $id: 'Problem', title: 'Problem', description: 'Fehler nach RFC 9457 (application/problem+json).' }),
  ValidationProblem: Type.Object({ ...problemBase, errors: Type.Optional(Type.Array(FieldError, { description: 'Feldfehler; fehlt bei Fehlern ohne Feldbezug (z. B. Idempotency-Key)' })) },
    { ...open, $id: 'ValidationProblem', title: 'ValidationProblem', description: 'Ungültige Eingabe (422) mit Feldfehlern.' }),
  VersionConflict: Type.Object({ ...problemBase, currentVersion: Type.Optional(Type.Integer({ description: 'Aktuelle Version auf dem Server; fehlt, wenn If-Match nicht lesbar war' })) },
    { ...open, $id: 'VersionConflict', title: 'VersionConflict', description: 'Version passt nicht zu If-Match (412).' }),
  OrganizationChoice: Type.Object({ ...problemBase, organizations: Type.Optional(Type.Array(Type.String(), { description: 'Aliase der Organisationen im Token; mit Header X-Tenant eine wählen' })) },
    { ...open, $id: 'OrganizationChoice', title: 'OrganizationChoice', description: 'Ungültige Anfrage (400); bei mehreren Organisationen im Token mit `organizations`.' }),
  BatchProblem: Type.Object({
    ...problemBase,
    results: Type.Optional(Type.Array(Type.Object({
      index: Type.Integer(), op: Type.String(), status: Type.Integer(), rolledBack: Type.Optional(Type.Boolean({ description: 'Erfolgreich, aber zurückgerollt' })),
      error: Type.Optional(Type.Object({ title: Type.String(), detail: Type.Optional(Type.String()), errors: Type.Optional(Type.Array(FieldError)) }, open)),
    }, open), { description: 'Ergebnis jeder Operation; fehlt, wenn die Anfrage schon vor der Ausführung scheiterte' })),
    errors: Type.Optional(Type.Array(FieldError)),
  }, { ...open, $id: 'BatchProblem', title: 'BatchProblem', description: 'Batch abgebrochen: Status der ersten fehlgeschlagenen Operation, `results` je Operation.' }),
};
type ProblemName = keyof typeof PROBLEM_SCHEMAS;

const PROBLEM_TEXT: Record<number, string> = {
  400: 'Ungültige Anfrage, z. B. Organisation wählen (X-Tenant)', 401: 'Nicht angemeldet oder Token ungültig', 403: 'Keine Berechtigung (Rolle, Scope, ACL) oder CSRF-Token fehlt',
  404: 'Nicht gefunden oder nicht sichtbar', 409: 'Konflikt mit dem aktuellen Stand', 412: 'Version passt nicht (If-Match)', 422: 'Ungültige Eingabe',
  429: 'Zu viele Anfragen (Retry-After)', 500: 'Interner Fehler (Referenz im detail)',
};

/** Übliche Fehlerantworten einer Route (Status → Schema). */
export function problemResponses(method: string, url: string, schema: Record<string, any>): Record<number, ProblemName> {
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const ok = schema.response?.[200] ?? schema.response?.['200'];
  const batch = method === 'POST' && !!ok?.properties?.results;
  const r: Record<number, ProblemName> = { 400: 'OrganizationChoice', 401: 'Problem', 403: 'Problem' };
  if (/\/:\w/.test(url) || batch) r[404] = 'Problem';
  if (write) r[409] = 'Problem';
  if (schema.headers?.properties?.['if-match'] || batch) r[412] = 'VersionConflict';
  if (write || schema.body || schema.querystring || schema.params || schema.headers) r[422] = 'ValidationProblem';
  if (batch) for (const s of [403, 404, 409, 412, 422]) r[s] = 'BatchProblem';
  r[429] = 'Problem'; r[500] = 'Problem';
  return r;
}

/** Fehlerschemas als Komponenten; jede Route unter `prefix` erhält die üblichen Fehlerantworten. */
export function registerProblemSchemas(app: FastifyInstance, prefix: string) {
  for (const s of Object.values(PROBLEM_SCHEMAS)) app.addSchema(s);
  app.addHook('onRoute', route => {
    const schema = route.schema as Record<string, any> | undefined;
    if (!route.url.startsWith(`${prefix}/`) || !schema || schema.hide) return;
    const response: Record<string, unknown> = (schema.response ??= {});
    for (const method of [route.method].flat()) {
      for (const [status, name] of Object.entries(problemResponses(method, route.url, schema))) {
        if (response[status] !== undefined || response[`${status[0]}xx`] !== undefined) continue;
        response[status] = { description: PROBLEM_TEXT[Number(status)], content: { 'application/problem+json': { schema: { $ref: `${name}#` } } } };
      }
    }
  });
}

/** Fehlerbehandlung: immer problem+json, Validierungsfehler mit Pfaden, bekannte PostgreSQL-Fehler als 409/403. */
export function registerErrorHandler(app: FastifyInstance, typeBase: string) {
  app.setErrorHandler((err: Error & { validation?: { instancePath: string; message?: string }[]; statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) return problem(reply, err, typeBase, req.url);
    if (err.validation) return problem(reply, new HttpError(422, 'Ungültige Eingabe', 'Die Anfrage entspricht nicht dem Schema.', {}, { errors: err.validation.map(v => ({ path: v.instancePath || '/', message: v.message ?? 'ungültig' })) }), typeBase, req.url);
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') return problem(reply, new HttpError(409, 'Konflikt', 'Ein Eintrag mit diesem Wert existiert bereits.'), typeBase, req.url);
    if (pgCode === '23503') return problem(reply, new HttpError(409, 'Konflikt', 'Verweis auf einen nicht vorhandenen oder noch verwendeten Eintrag.'), typeBase, req.url);
    if (pgCode === '42501') return problem(reply, new HttpError(403, 'Keine Berechtigung', 'Zugriff durch Zeilenrichtlinie verweigert.'), typeBase, req.url);
    if (err.statusCode && err.statusCode < 500) return problem(reply, new HttpError(err.statusCode, err.message), typeBase, req.url);
    req.log.error({ err }, 'unbehandelter Fehler');
    return problem(reply, new HttpError(500, 'Interner Fehler', `Referenz ${req.id}`), typeBase, req.url);
  });
  app.setNotFoundHandler((req, reply) => problem(reply, new HttpError(404, 'Nicht gefunden'), typeBase, req.url));
}
