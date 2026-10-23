/**
 * Testhilfen für Apps mit @vollholz/iam-web (Import `@vollholz/iam-web/testing`), unabhängig vom Test-Runner:
 * - `StaticIam`: Provider mit fester Sitzung ohne Server (Konfiguration, Texte, Grundkomponenten, QueryClient)
 * - `mockIamApi`: fetch-Ersatz mit Antworten je «METHOD /pfad» und Standardantworten für /auth/me und den Katalog
 * - `CATALOG`, `ME`: Beispielmodell und Person (Notiz-App)
 * - `staticResources`: Adapter `resources` aus festen Namen (Orte ohne Daten der App)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_PATHS, IamConfigProvider, type IamConfig, type IamResources } from '../config.tsx';
import type { AuthzCatalog, Me, ResourceRef } from '../contract.ts';
import { historyRouter } from '../router.tsx';
import { StaticSession } from '../session.tsx';
import { configureTexts, type IamLocale, type IamTexts } from '../texts/index.ts';
import { IamTextProvider } from '../texts/react.tsx';
import { IamUiProvider, type IamComponents } from '../ui/context.tsx';
import { CATALOG, ME } from './catalog.ts';

export { CATALOG, ME };

export interface StaticIamProps {
  /** Abweichungen von `ME`; ohne `somewhere` gilt `permissions` (bzw. `ME.somewhere`). */
  me?: Partial<Me>;
  config?: Partial<IamConfig>;
  components?: Partial<IamComponents>;
  queryClient?: QueryClient;
  /** Sprache und Überschreibungen der Texte wie bei `IamProvider`. */
  locale?: IamLocale;
  texts?: Record<string, IamTexts>;
  children: ReactNode;
}

/** Bausteine mit fester Sitzung (ohne /auth/me); Abfragen ohne Wiederholung, damit Fehler sofort sichtbar sind. */
export function StaticIam({ me, config, components, queryClient, locale = 'de', texts, children }: StaticIamProps) {
  const [qc] = useState(() => queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }));
  const value = useMemo<IamConfig>(() => ({ product: 'Notizen', paths: DEFAULT_PATHS, features: {}, router: historyRouter, ...config }), [config]);
  // Ohne eigenes `somewhere` gelten die übergebenen Rechte an der Organisation auch als «irgendwo» (Obermenge, 9.5)
  const fixed = useMemo<Me>(() => ({ ...ME, ...me, somewhere: me?.somewhere ?? me?.permissions ?? ME.somewhere }), [me]);
  const textState = useMemo(() => { configureTexts({ locale, texts: texts ?? {} }); return { locale, version: Date.now() }; }, [locale, texts]);
  return (
    <QueryClientProvider client={qc}>
      <IamTextProvider value={textState}>
        <IamConfigProvider value={value}>
          <IamUiProvider components={components}><StaticSession me={fixed}>{children}</StaticSession></IamUiProvider>
        </IamConfigProvider>
      </IamTextProvider>
    </QueryClientProvider>
  );
}

export type MockHandler = (req: Request) => Response | Promise<Response>;

/** JSON-Antwort; ab 400 als application/problem+json. */
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers } });

export interface MockIamApi {
  /** fetch-Ersatz; die App setzt ihn ein (z. B. `vi.stubGlobal('fetch', api.fetch)`). */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Alle Anfragen in der Reihenfolge des Eingangs. */
  calls: Request[];
}

/**
 * Nachbildung des Vertrags: Antworten je «METHOD /pfad» (ohne Suchtext); `GET /auth/me` und `GET /v1/authz/catalog`
 * antworten ohne Angabe mit `ME` und `CATALOG`. Unbekannte Pfade: 404.
 */
export function mockIamApi(routes: Record<string, MockHandler> = {}, o: { me?: Me; catalog?: AuthzCatalog } = {}): MockIamApi {
  const catalog = o.catalog ?? CATALOG;
  const all: Record<string, MockHandler> = {
    'GET /auth/me': () => json(o.me ?? ME),
    'GET /v1/authz/catalog': () => json(catalog),
    ...routes,
  };
  const calls: Request[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      calls.push(req.clone());
      const h = all[`${req.method} ${new URL(req.url).pathname}`];
      return h ? h(req) : json({ title: 'Nicht gefunden', status: 404 }, 404);
    },
  };
}

/**
 * Adapter `resources` aus festen Daten: `names[type][id] = Name`; unbekannte Orte gelten als nicht sichtbar. `open`
 * erhält den Ort beim Klick auf einen Pfeil (ohne: keine Pfeile).
 */
export function staticResources(names: Record<string, Record<string, string>>, o: { open?: (ref: ResourceRef) => void } = {}): IamResources {
  return {
    useResolver: () => ({ name: ref => (ref.id && names[ref.type] && Object.hasOwn(names[ref.type]!, ref.id) ? names[ref.type]![ref.id] : undefined) }),
    ...(o.open ? { open: o.open } : {}),
  };
}
