/** `iamFetch` als Hook für eigene Aufrufe der App an den Vertrag (gleiche Header, Fehler und Meldungen wie das Paket). */
import { iamFetch } from './client.ts';

export function useIamFetch(): typeof iamFetch {
  return iamFetch;
}
