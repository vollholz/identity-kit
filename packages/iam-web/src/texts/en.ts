/** Texte des Baukastens auf Englisch (gleiche Schlüssel und Platzhalter wie `de`, Test in test/texts.test.ts). */
import type { IamTextKey } from './de.ts';

export const en: Record<IamTextKey, string> = {
  'iam.error.0': 'No connection to the server',
  'iam.error.400': 'The request is invalid.',
  'iam.error.401': 'You are not signed in (anymore).',
  'iam.error.403': 'You lack the permission for this.',
  'iam.error.404': 'Not found – deleted, not visible to you or in another organization.',
  'iam.error.409': 'Conflict with the current state.',
  'iam.error.412': 'Changed by someone else in the meantime.',
  'iam.error.422': 'The input is invalid.',
  'iam.error.429': 'Too many requests – please wait a moment.',
  'iam.error.500': 'Internal server error.',
  'iam.error.502': 'The server is not reachable.',
  'iam.error.503': 'The service is temporarily unavailable.',
  'iam.error.status': 'Error {status}',
  'iam.error.network': 'Please check your network and try again.',
  'iam.error.unexpected': 'Unexpected error',
  'iam.time.now': 'just now',
};
