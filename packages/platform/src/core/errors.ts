/**
 * Fachliche Fehler als application/problem+json (RFC 9457). `HttpError` kommt aus @vollholz/iam, damit die
 * Fehlerbehandlung des Plugins ihn erkennt; hier ergänzt um die Fälle der App. Texte in Du-Form.
 */
import { conflict, forbidden, HttpError, invalid, notFound } from '@vollholz/iam';

export { conflict, forbidden, HttpError, invalid, notFound };

/** 412: Die Version im `If-Match` passt nicht zum aktuellen Stand. */
export const preconditionFailed = (current: number) =>
  new HttpError(412, 'Version passt nicht', 'Der Eintrag wurde inzwischen geändert. Lade ihn neu und versuche es nochmals.', { ETag: `"${current}"` }, { currentVersion: current });

/** 428: Schreibender Aufruf ohne `If-Match`. */
export const preconditionRequired = () =>
  new HttpError(428, 'If-Match fehlt', 'Gib die Version aus dem ETag im Header If-Match mit, damit keine Änderung verloren geht.');
