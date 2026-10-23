/**
 * Öffentliche Seiten der Anmeldung über Microsoft Entra ID (ohne Sitzung): die Freigabe über einen Link an die
 * Entra-Administration (`<paths.entra>/freigabe#<token>`) und ihre Rückkehr von Microsoft (`<paths.entra>/zustimmung`
 * mit `state` `h.…`). `IamProvider` erkennt sie vor der Prüfung von /auth/me und zeigt sie ohne Anmeldung.
 */

/**
 * `state` vom Server: `o.<alias>.<zufall>` (eigene Organisation), `p.<alias>.<zufall>` (Plattform-Administration),
 * `h.<alias>.<zufall>` (Link an die Entra-Administration, ohne Sitzung).
 */
export const ENTRA_STATE = /^(o|p|h)\.([a-z0-9][a-z0-9_-]{0,62})\.[A-Za-z0-9_-]+$/;

/** Hosts für die Zustimmung bei Microsoft, wenn die App keine nennt (`entraConsentHosts`). */
export const CONSENT_HOSTS = ['login.microsoftonline.com'];

export type PublicEntraPage = 'handover' | 'handoverReturn';

/** Öffentliche Seite unter `entraPath` (nur mit `features.entra`), sonst `null`. */
export function publicEntraPage(entraPath: string, location: { pathname: string; search: string }): PublicEntraPage | null {
  if (location.pathname === `${entraPath}/freigabe`) return 'handover';
  if (location.pathname === `${entraPath}/zustimmung`) {
    const state = new URLSearchParams(location.search).get('state') ?? '';
    return ENTRA_STATE.exec(state)?.[1] === 'h' ? 'handoverReturn' : null;
  }
  return null;
}
