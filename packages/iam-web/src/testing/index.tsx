/**
 * Testhilfen für Apps mit @vollholz/iam-web (Import `@vollholz/iam-web/testing`), unabhängig vom Test-Runner:
 * - `StaticIam`: Provider mit fester Sitzung ohne Server (Konfiguration, Texte, Grundkomponenten, QueryClient)
 * - `mockIamApi`: fetch-Ersatz mit Antworten je «METHOD /pfad» und Standardantworten für /auth/me, Katalog und Rollen
 * - `CATALOG`, `ME`: Beispielkatalog und Person (Notiz-App)
 * - `staticResources`: Adapter `resources` aus festen Namen und Eltern (Zugriffsregeln ohne Daten der App)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_PATHS, IamConfigProvider, type IamConfig, type IamResources } from '../config.tsx';
import type { AuthzCatalog, Me, RoleList } from '../contract.ts';
import { historyRouter } from '../router.tsx';
import { StaticSession } from '../session.tsx';
import { configureTexts, type IamLocale, type IamTexts } from '../texts/index.ts';
import { IamTextProvider } from '../texts/react.tsx';
import { IamUiProvider, type IamComponents } from '../ui/context.tsx';
import { CATALOG, ME } from './catalog.ts';

export { CATALOG, ME };

export interface StaticIamProps {
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
  const fixed = useMemo<Me>(() => ({ ...ME, ...me }), [me]);
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
 * Nachbildung des Vertrags: Antworten je «METHOD /pfad» (ohne Suchtext); `GET /auth/me`, `GET /v1/authz/catalog` und
 * `GET /v1/roles` antworten ohne Angabe mit `ME`, `CATALOG` und den Rollen des Katalogs. Unbekannte Pfade: 404.
 */
export function mockIamApi(routes: Record<string, MockHandler> = {}, o: { me?: Me; catalog?: AuthzCatalog } = {}): MockIamApi {
  const catalog = o.catalog ?? CATALOG;
  const roles: RoleList = {
    items: catalog.roles.map(r => ({ ...r, custom: false, id: null, memberCount: null, version: null, createdAt: null, updatedAt: null })),
    customPermissions: catalog.permissions.filter(p => !p.adminOnly).map(p => p.key), maxCustom: 50,
  };
  const all: Record<string, MockHandler> = {
    'GET /auth/me': () => json(o.me ?? ME),
    'GET /v1/authz/catalog': () => json(catalog),
    'GET /v1/roles': () => json(roles),
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
 * Adapter `resources` aus festen Daten: `names[type][id] = Name`, `parents['type:id'] = { type, id }` (Stufe darüber,
 * ohne tenant). Unbekannte IDs eines Typs mit Namen gelten als unbekannt (`known: false`), andere Typen als nicht prüfbar.
 */
export function staticResources(names: Record<string, Record<string, string>>, o: { parents?: Record<string, { type: string; id: string }>; noGrant?: string[] } = {}): IamResources {
  const chain = (type: string, id: string) => {
    const out: { type: string; id: string; label: string }[] = [];
    const seen = new Set([`${type}:${id}`]);
    const parent = (k: string) => (o.parents && Object.hasOwn(o.parents, k) ? o.parents[k] : undefined);
    // Zyklus in `parents` (Testdaten): abbrechen statt endlos laufen
    for (let p = parent(`${type}:${id}`); p && !seen.has(`${p.type}:${p.id}`); p = parent(`${p.type}:${p.id}`)) {
      seen.add(`${p.type}:${p.id}`);
      out.unshift({ ...p, label: names[p.type]?.[p.id] ?? p.id });
    }
    return out;
  };
  return {
    useResolver: () => ({
      name: (type, id) => (names[type] && Object.hasOwn(names[type], id) ? names[type][id] : undefined),
      known: (type, id) => (names[type] ? Object.hasOwn(names[type], id) : undefined),
    }),
    pick: async (type, query) => Object.entries(names[type] ?? {})
      .filter(([, label]) => label.toLowerCase().includes(query.trim().toLowerCase()))
      .map(([value, label]) => ({ value, label, sub: chain(type, value).map(s => s.label).join(' › ') || undefined })),
    useChain: (type, id) => (id ? chain(type, id) : []),
    ...(o.noGrant ? { noGrant: o.noGrant } : {}),
  };
}
