/**
 * Konfiguration der App für die Bausteine (Props von `IamProvider` ohne Sitzung): Produkt, Pfade, Schalter, Router,
 * Darstellung der Rollen und Rückmeldungen an die App.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { Me } from './contract.ts';
import type { IamPeople } from './people.tsx';
import { historyRouter, type IamRouter } from './router.tsx';

export interface IamPaths {
  home: string;
  loggedOut: string;
  members: string;
  roles: string;
  clients: string;
  /**
   * Seite «Anmeldung» (Entra ID). Die Rückkehrseiten liegen darunter: `<entra>/zustimmung` (Zustimmung bei Microsoft)
   * und `<entra>/test` (Testanmeldung). Beide müssen zu den Redirect-URIs der Entra-App und zu `ENTRA_*` des Servers
   * passen; wer den Pfad ändert, ändert ihn dort mit (Spezifikation 9.2).
   */
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

/** Eintrag einer Auswahl (Ressource im Dialog «Zugriffsregel hinzufügen»). */
export interface IamPickOption { value: string; label: string; sub?: string }

/**
 * Ressourcen der Zugriffsregeln (docs/entwurf.md 1.7): Typen und Labels kommen aus dem Katalog, Namen, Auswahl und Kette
 * der einzelnen Ressourcen kennt nur die App (Spezifikation 15.2). Ohne Zugriffsregeln entfällt der Adapter.
 */
export interface IamResources {
  /** Name und Bekanntheit je Ressource; als Hook, damit die App ihre Abfragen (Cache) nutzt. `known`: `false` = geladen und unbekannt, `undefined` = nicht prüfbar. */
  useResolver(): { name(type: string, id: string): string | undefined; known(type: string, id: string): boolean | undefined };
  /** Auswahl im Dialog «Zugriffsregel hinzufügen» (Suche, höchstens 50). */
  pick(type: string, query: string, signal: AbortSignal): Promise<IamPickOption[]>;
  /**
   * Kette über der Ressource (ohne sie selbst und ohne tenant, von oben), für Vorschau und AclHint. Als Hook, weil die
   * Kette oft erst geladen werden muss: `undefined` = lädt noch, `[]` = keine Stufe darüber.
   */
  useChain?(type: string, id: string | null): { type: string; id: string; label: string }[] | undefined;
  /** Typen ohne Freigabe (Blatt der Kette, Spezifikation 7.1); Standard: Typen mit `leaf` im Katalog. */
  noGrant?: string[];
}

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
  /** Erlaubte Hosts für die Zustimmung bei Microsoft (nur https); Standard `login.microsoftonline.com`. */
  entraConsentHosts?: string[];
  /** Ressourcen der Zugriffsregeln; ohne zeigt die Zugriffsseite IDs statt Namen und keine Auswahl. */
  resources?: IamResources;
  /** Personenverzeichnis; Standard `GET /v1/people`. */
  people?: IamPeople;
  onTenant?: (me: Me) => void;
  onLogout?: () => void;
}

export const DEFAULT_CONFIG: IamConfig = { product: '', paths: DEFAULT_PATHS, features: {}, router: historyRouter };

const Ctx = createContext<IamConfig>(DEFAULT_CONFIG);
export const IamConfigProvider = Ctx.Provider;
export const useIamConfig = (): IamConfig => useContext(Ctx);
