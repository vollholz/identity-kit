/**
 * Routen und Navigation der Verwalten-Seiten (docs/entwurf.md › Seiten): `iamRoutes` liefert je Seite Pfad, Bedarf,
 * Titel, Symbol und `load()` (lädt den Einstieg `./pages` erst bei Bedarf, die Seite samt Guard); daraus baut die App
 * ihre Routen. `useIamNav()` gibt die Einträge der Gruppe «Zugang» je nach Recht und `features` mit `active` für eine
 * eigene Leiste der App, `<IamNav>` zeichnet sie fertig. Die Routen liegen im Kern, damit die Navigation die Seiten
 * nicht mitlädt.
 */
import type { ComponentType } from 'react';
import { useAdminStatus } from './admin.ts';
import { DEFAULT_PATHS, useIamConfig, type IamPaths } from './config.tsx';
import type { Permission } from './permissions.ts';
import { useIam } from './session.tsx';
import { t } from './texts/index.ts';
import { useIamText } from './texts/react.tsx';
import { useIamUi } from './ui/context.tsx';
import type { IamIconName } from './ui/icons.ts';

export type IamRouteId = 'members' | 'roles';

export interface IamRoute {
  id: IamRouteId;
  /** Aus `paths` (Standard wie vollholz/assets). */
  path: string;
  /** Bedarf der Seite; der Guard in `load()` prüft ihn, die Navigation blendet die Seite ohne ihn aus. */
  need: { perm: Permission } | { platformAdmin: true } | null;
  /** In der Sprache der Texte (beim Lesen). */
  readonly title: string;
  icon: IamIconName;
  /** Erscheint in `IamNav`. */
  nav: boolean;
  /** Seite mit Guard, für `lazy()` bzw. den Router der App. */
  load: () => Promise<{ default: ComponentType }>;
}

const pages = () => import('./pages/index.ts');

/** Routen mit den Pfaden der App (`paths` wie bei `IamProvider`). */
export function makeIamRoutes(paths: Partial<IamPaths> = {}): IamRoute[] {
  const p = { ...DEFAULT_PATHS, ...paths };
  return [
    { id: 'members', path: p.members, need: { perm: 'members:admin' }, get title() { return t('iam.members.title'); }, icon: 'users', nav: true, load: () => pages().then(m => ({ default: m.MembersScreen })) },
    { id: 'roles', path: p.roles, need: { perm: 'members:admin' }, get title() { return t('iam.rolesPage.title'); }, icon: 'tag', nav: true, load: () => pages().then(m => ({ default: m.RolesScreen })) },
  ];
}

/** Routen mit den Standardpfaden. */
export const iamRoutes: IamRoute[] = makeIamRoutes();

export interface IamNavItem { id: IamRouteId; path: string; title: string; icon: IamIconName; active: boolean }

/** Einträge der Navigation «Zugang»: nur Seiten, deren Bedarf erfüllt ist (wie der Guard), mit `active` für den Pfad. */
export function useIamNav(): IamNavItem[] {
  const { paths, router, features } = useIamConfig();
  const { canSomewhere } = useIam();
  useIamText();
  const pathname = router.usePathname();
  const routes = makeIamRoutes(paths).filter(r => r.nav);
  const platform = useAdminStatus(features.platform !== false && routes.some(r => r.need && 'platformAdmin' in r.need)).data?.platformAdmin ?? false;
  return routes
    .filter(r => !r.need || ('perm' in r.need ? canSomewhere(r.need.perm) : platform))
    .map(r => ({ id: r.id, path: r.path, title: r.title, icon: r.icon, active: pathname === r.path || pathname.startsWith(`${r.path}/`) }));
}

/** Fertige Gruppe «Zugang» (Liste von Links); ohne erlaubte Seite nichts. */
export function IamNav({ className }: { className?: string }) {
  const items = useIamNav();
  const { router: { Link } } = useIamConfig();
  const { Icon } = useIamUi();
  if (!items.length) return null;
  return (
    <nav className={`iam-nav${className ? ` ${className}` : ''}`} aria-label={t('iam.nav.access')}>
      <div className="iam-nav-h" aria-hidden="true">{t('iam.nav.access')}</div>
      <ul>
        {items.map(i => (
          <li key={i.id}>
            <Link to={i.path} className={`iam-nav-i${i.active ? ' iam-on' : ''}`} aria-current={i.active ? 'page' : undefined}>
              <Icon name={i.icon} className="iam-ico" /><span>{i.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
