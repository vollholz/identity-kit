/**
 * Einstieg der App (docs/entwurf.md › Provider): Konfiguration, Texte, Grundkomponenten, gemeinsamer QueryClient und
 * Sitzung. Der QueryClient ist der der App (Prop oder QueryClientProvider), damit der Wechsel der Organisation auch die
 * Daten der App leert; ohne einen legt das Paket einen eigenen an.
 */
import { QueryClient, QueryClientContext, QueryClientProvider } from '@tanstack/react-query';
import { useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_PATHS, IamConfigProvider, type IamConfig, type IamFeatures, type IamPaths, type RoleGroup } from './config.tsx';
import type { Me } from './contract.ts';
import { historyRouter, type IamRouter } from './router.tsx';
import { SessionProvider } from './session.tsx';
import { adoptLegacyTabOrg } from './tabOrg.ts';
import { configureTexts, type IamLocale, type IamTexts } from './texts/index.ts';
import { IamTextProvider } from './texts/react.tsx';
import { IamUiProvider, type IamComponents } from './ui/context.tsx';

export interface IamProviderProps {
  /** Anzeigename des Produkts (Auswahl- und Abmeldeseite, Seitentitel). */
  product: string;
  /** Marke auf Auswahl- und Abmeldeseite; ohne Angabe der Name des Produkts. */
  brand?: ReactNode;
  /** Sprache der Texte und des Katalogs; Standard `de`. */
  locale?: IamLocale;
  /** Überschreibungen und weitere Sprachen, z. B. `{ de: { 'iam.org.reload': '…' }, fr: {…} }`. */
  texts?: Record<string, IamTexts>;
  queryClient?: QueryClient;
  router?: IamRouter;
  paths?: Partial<IamPaths>;
  features?: IamFeatures;
  /** Früherer Schlüssel der Organisation je Tab im sessionStorage; einmal übernommen und gelöscht. */
  legacyTabKey?: string;
  components?: Partial<IamComponents>;
  /** Gruppen im Rollendialog und in der Rollenmatrix (V3); jede Rolle muss im Katalog stehen (`roleGroupProblems`). */
  roleGroups?: RoleGroup[];
  /** Symbol je vordefinierter Rolle auf der Seite «Rollen», z. B. `{ editor: 'edit' }`. */
  roleIcons?: Record<string, string>;
  /** Vorgewählte Rollen beim Einladen; Standard: die Rolle mit den wenigsten Rechten ausser org-admin. */
  inviteRoles?: string[];
  /** `GROUP_ROLE_PREFIX` des Servers, falls nicht `/orgs` (Hinweis auf die Gruppen der Rollen unter «Mitglieder»). */
  groupRolePrefix?: string;
  /** Weitere Hosts für die Zustimmung bei Microsoft (z. B. nationale Clouds); Standard `login.microsoftonline.com`. */
  entraConsentHosts?: string[];
  /** Nach jedem /auth/me mit Person und Organisation (z. B. Bereich persönlicher Einstellungen). */
  onTenant?: (me: Me) => void;
  /** Beim Abmelden, vor der Weiterleitung (z. B. persönliche Einstellungen im Browser löschen). */
  onLogout?: () => void;
  children: ReactNode;
}

export function IamProvider(props: IamProviderProps) {
  const { product, brand, locale = 'de', texts, queryClient, router, paths, features, legacyTabKey, components, roleGroups, roleIcons, inviteRoles, groupRolePrefix, entraConsentHosts, onTenant, onLogout, children } = props;
  const outer = useContext(QueryClientContext);
  const [own] = useState(() => (queryClient || outer ? null : new QueryClient()));
  const client = queryClient ?? outer ?? own!;
  // Einmal je Tab vor dem ersten /auth/me
  useState(() => { adoptLegacyTabOrg(legacyTabKey); return null; });
  // Texte vor dem Zeichnen der Kinder setzen (modulweit, auch für Code ohne React)
  const textState = useMemo(() => { configureTexts({ locale, texts: texts ?? {} }); return { locale, version: Date.now() }; }, [locale, texts]);
  const config = useMemo<IamConfig>(() => ({
    product, brand, paths: { ...DEFAULT_PATHS, ...paths }, features: features ?? {}, router: router ?? historyRouter, roleGroups, roleIcons, inviteRoles, groupRolePrefix, entraConsentHosts, onTenant, onLogout,
  }), [product, brand, paths, features, router, roleGroups, roleIcons, inviteRoles, groupRolePrefix, entraConsentHosts, onTenant, onLogout]);
  return (
    <QueryClientProvider client={client}>
      <IamTextProvider value={textState}>
        <IamConfigProvider value={config}>
          <IamUiProvider components={components}>
            <SessionProvider>{children}</SessionProvider>
          </IamUiProvider>
        </IamConfigProvider>
      </IamTextProvider>
    </QueryClientProvider>
  );
}
