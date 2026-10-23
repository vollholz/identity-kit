/**
 * Router-Adapter (docs/entwurf.md › Router und Pfade): Das Paket hängt von keinem Router ab. Es navigiert mit
 * vollständigen Adressen und liest den unverarbeiteten Suchtext. Ohne Adapter gilt die History-API.
 */
import { useSyncExternalStore, type ComponentType, type MouseEvent, type ReactNode } from 'react';

export interface IamLinkProps { to: string; className?: string; children: ReactNode; 'aria-current'?: 'page'; title?: string }

export interface IamRouter {
  Link: ComponentType<IamLinkProps>;
  /** `to` ist Pfad mit Suchtext, z. B. `/verwalten/zugriff?ansicht=pruefen&client=x`. */
  navigate(to: string, opts?: { replace?: boolean }): void;
  /** Unverarbeiteter Suchtext der aktuellen Adresse (`location.search`, mit «?» oder leer). */
  useSearch(): string;
  usePathname(): string;
}

const NAV_EVENT = 'iam:navigate';

function subscribe(fn: () => void) {
  window.addEventListener('popstate', fn);
  window.addEventListener(NAV_EVENT, fn);
  return () => { window.removeEventListener('popstate', fn); window.removeEventListener(NAV_EVENT, fn); };
}

function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) window.history.replaceState(null, '', to); else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** Link der History-API: normaler Klick navigiert ohne Neuladen, Klick mit Taste (neuer Tab) wie ein Link. */
function HistoryLink({ to, children, ...rest }: IamLinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={onClick} {...rest}>{children}</a>;
}

/** Standard ohne Router der App: `pushState`/`popstate`. */
export const historyRouter: IamRouter = {
  Link: HistoryLink,
  navigate,
  useSearch: () => useSyncExternalStore(subscribe, () => window.location.search, () => ''),
  usePathname: () => useSyncExternalStore(subscribe, () => window.location.pathname, () => '/'),
};
