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

/** Token im Fragment des Links: `<alias>.<43 Zeichen base64url>`. */
export const HANDOVER_TOKEN = /^[a-z0-9][a-z0-9_-]{0,62}\.[A-Za-z0-9_-]{43}$/;
/** Pfad der Freigabe, auch wenn `paths.entra` nicht passt oder mit «/» am Ende. */
const FREIGABE = /\/freigabe\/?$/;
/** Etwas im Fragment, das ein Token sein könnte (43 Zeichen base64url am Stück). */
const TOKEN_LIKE = /[A-Za-z0-9_-]{43}/;

/** Fragment, das in eine Weiterleitung (z. B. `returnTo`) darf: nie auf …/freigabe, nie etwas, das ein Token sein könnte. */
export function safeHash(location: { pathname: string; hash: string }): string {
  return location.hash && !FREIGABE.test(location.pathname) && !TOKEN_LIKE.test(location.hash) ? location.hash : '';
}

let taken: { token: string | null } | null = null;

/**
 * Token des Links aus dem Fragment lesen und das Fragment sofort aus der Adresse entfernen (vor dem Nachladen der Seite,
 * vor Telemetrie und Weiterleitungen). Ein zweiter Aufruf im selben Durchlauf (StrictMode) liefert dasselbe Token.
 */
export function takeHandoverToken(): string | null {
  if (typeof window === 'undefined') return null;
  const { pathname, search, hash } = window.location;
  if (!hash) return taken?.token ?? null;
  const raw = hash.slice(1);
  taken = { token: HANDOVER_TOKEN.test(raw) ? raw : null };
  window.history.replaceState(window.history.state, '', `${pathname}${search}`);
  queueMicrotask(() => { taken = null; });
  return taken.token;
}

/** Pfad der Freigabe (…/freigabe, auch mit «/» am Ende): dort das Fragment entfernen, auch ohne erkannte öffentliche Seite. */
export function isHandoverPath(pathname: string): boolean { return FREIGABE.test(pathname); }
