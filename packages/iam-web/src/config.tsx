/**
 * Konfiguration der App für die Bausteine (Props von `IamProvider` ohne Sitzung): Produkt, Pfade, Schalter, Router,
 * Darstellung der Rollen und Rückmeldungen an die App.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { Me } from './contract.ts';
import { historyRouter, type IamRouter } from './router.tsx';

export interface IamPaths {
  home: string;
  loggedOut: string;
  members: string;
  roles: string;
  clients: string;
  entra: string;
  access: string;
  organizations: string;
}

/** Standardpfade wie in vollholz/assets; `loggedOut` ist im Realm als post_logout_redirect_uri eingetragen (5.1). */
export const DEFAULT_PATHS: IamPaths = {
  home: '/',
  loggedOut: '/abgemeldet',
  members: '/verwalten/mitglieder',
  roles: '/verwalten/rollen',
  clients: '/verwalten/maschinen-clients',
  entra: '/verwalten/anmeldung',
  access: '/verwalten/zugriff',
  organizations: '/verwalten/organisationen',
};

export interface IamFeatures {
  /** Zugriffsregeln; Standard: der Katalog enthält `acl:read`. */
  acl?: boolean;
  /** Anmeldung über Microsoft Entra ID (KANN, 9.4); Standard aus. */
  entra?: boolean;
  /** Seiten der Plattform-Administration; Standard an. */
  platform?: boolean;
}

/** Gruppe im Rollendialog und in der Rollenmatrix (nur Darstellung, V3). */
export interface RoleGroup { key: string; label: string; roles: string[] }

export interface IamConfig {
  product: string;
  brand?: ReactNode;
  paths: IamPaths;
  features: IamFeatures;
  router: IamRouter;
  roleGroups?: RoleGroup[];
  /** Symbol je Rolle auf der Seite «Rollen» (Name aus `IamIconName` oder der App); Standard: `shield` für org-admin, sonst `tag`. */
  roleIcons?: Record<string, string>;
  /** Vorgewählte Rollen beim Einladen; Standard: die Rolle mit den wenigsten Rechten ausser org-admin. */
  inviteRoles?: string[];
  /** `GROUP_ROLE_PREFIX` des Servers (Spezifikation 14) für den Hinweis auf die Gruppen der Rollen; Standard `/orgs`. */
  groupRolePrefix?: string;
  onTenant?: (me: Me) => void;
  onLogout?: () => void;
}

export const DEFAULT_CONFIG: IamConfig = { product: '', paths: DEFAULT_PATHS, features: {}, router: historyRouter };

const Ctx = createContext<IamConfig>(DEFAULT_CONFIG);
export const IamConfigProvider = Ctx.Provider;
export const useIamConfig = (): IamConfig => useContext(Ctx);
