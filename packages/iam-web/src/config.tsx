/**
 * Konfiguration der App für die Bausteine (Props von `IamProvider` ohne Sitzung): Produkt, Pfade, Schalter, Router,
 * Darstellung der Rollen, Orte der App und Rückmeldungen an die App.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { Me, ResourceRef } from './contract.ts';
import type { IamPeople } from './people.tsx';
import { historyRouter, type IamRouter } from './router.tsx';

export interface IamPaths {
  home: string;
  loggedOut: string;
  members: string;
  /**
   * Seite «Anmeldung» (Entra ID). Die Rückkehrseiten liegen darunter: `<entra>/zustimmung` (Zustimmung bei Microsoft)
   * und `<entra>/test` (Testanmeldung). Beide müssen zu den Redirect-URIs der Entra-App und zu `ENTRA_*` des Servers
   * passen; wer den Pfad ändert, ändert ihn dort mit (Spezifikation 9.2).
   */
  entra: string;
  organizations: string;
}

/** Standardpfade; `loggedOut` ist im Realm als post_logout_redirect_uri eingetragen (5.1). */
export const DEFAULT_PATHS: IamPaths = {
  home: '/',
  loggedOut: '/abgemeldet',
  members: '/verwalten/mitglieder',
  entra: '/verwalten/anmeldung',
  organizations: '/verwalten/organisationen',
};

/**
 * Orte der App (Spezifikation 11.4): Namen und Sprung zu einem Ort kennt nur die App. Ohne Adapter zeigen die Bausteine
 * Typ und «nicht sichtbar» statt eines Namens und keine Pfeile.
 */
export interface IamResources {
  /** Name je Ort aus dem Cache der App; `undefined` = unbekannt oder für mich nicht sichtbar («nicht sichtbar»). */
  useResolver(): { name(ref: ResourceRef): string | undefined };
  /** Öffnet einen Ort (Pfeil «Über», Orte in «Meine Rechte» und «Mitglieder»); ohne: keine Pfeile. */
  open?(ref: ResourceRef): void;
}

export interface IamFeatures {
  /** Freigaben an Orten («+n Orte», Rollen an Orten in «Meine Rechte»); Standard: das Modell hat Typen ausser `org`. */
  access?: boolean;
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
  /** Vorgewählte Rollen beim Einladen; Standard: die Rolle mit den wenigsten Rechten ausser org-admin. */
  inviteRoles?: string[];
  /** Erlaubte Hosts für die Zustimmung bei Microsoft (nur https); Standard `login.microsoftonline.com`. */
  entraConsentHosts?: string[];
  /** Namen und Sprung zu Orten der App. */
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
