/**
 * Testseite «Module»: Navigation «Zugang» mit «Module», Seite aus `iamRoutes` (mit Guard, per `load()`), nachgebildete
 * API mit Zustand und Version (ETag, If-Match, Voraussetzungen, Hindernisse). `?p=platform`: Abschnitt «Module» der
 * Plattform-Administration für «Muster GmbH» (freigeben, entziehen, «Trotzdem entziehen»).
 */
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/styles.css';
import { IamNav, IamProvider, makeIamRoutes, type AuthzCatalog, type TenantModule } from '../../../src/index.ts';
import { ModulesSection } from '../../../src/pages/index.ts';
import { CATALOG, json, ME, mockIamApi, type MockHandler } from '../../../src/testing/index.tsx';
import './page.css';

sessionStorage.removeItem('iam.tab.org');
const catalog: AuthzCatalog = {
  ...CATALOG,
  permissions: [...CATALOG.permissions, { key: 'zeit:write', label: 'Zeit erfassen', group: 'notes', resources: ['org'], adminOnly: false, description: 'Zeit erfassen.', modul: 'zeit' }],
  modules: [
    { key: 'kern', label: 'Kern', description: 'Mitglieder, Rollen und Einstellungen.', core: true, requires: [], parts: [] },
    { key: 'zeit', label: 'Zeiterfassung', description: 'Arbeitszeit erfassen und Korrekturen beantragen.', core: false, requires: [], parts: [{ key: 'zeit.korrektur', label: 'Korrekturanträge', description: 'Korrekturen beantragen.' }] },
    { key: 'abwesenheit', label: 'Abwesenheiten', description: 'Ferien und Absenzen.', core: false, requires: [], parts: [] },
    { key: 'lohn', label: 'Lohn', description: 'Lohnläufe mit Zeiten und Abwesenheiten.', core: false, requires: ['zeit', 'abwesenheit'], parts: [] },
    { key: 'projekte', label: 'Projekte mit einem sehr langen Namen für schmale Bildschirme', description: 'Projektzeiten.', core: false, requires: [], parts: [] },
  ],
  packages: [],
};
const mod = (key: string, label: string, o: Partial<TenantModule> = {}): TenantModule =>
  ({ key, label, description: catalog.modules!.find(m => m.key === key)?.description ?? 'Korrekturen beantragen.', core: false, requires: [], module: null, allowed: true, active: false, activeSince: null, ...o });
const initial = (): TenantModule[] => [
  mod('kern', 'Kern', { core: true, active: true }),
  mod('zeit', 'Zeiterfassung', { active: true, activeSince: '2026-10-01T08:00:00Z', blockers: [{ key: 'korr', text: '3 offene Korrekturanträge – zuerst entscheiden', anzahl: 3 }] }),
  mod('zeit.korrektur', 'Korrekturanträge', { module: 'zeit', active: true }),
  mod('abwesenheit', 'Abwesenheiten'),
  mod('lohn', 'Lohn', { requires: ['zeit', 'abwesenheit'] }),
  mod('projekte', catalog.modules![4]!.label, { allowed: false }),
];
let own = initial(), other = initial();
let v = 1;
const me = () => ({ ...ME, modules: own.filter(m => m.active).map(m => m.key) });
const routes: Record<string, MockHandler> = {
  'GET /auth/me': () => json(me()),
  'GET /v1/tenant/modules': () => json({ items: own }, 200, { etag: `W/"${v}"` }),
  'GET /v1/platform/organizations/muster/modules': () => json({ items: other }, 200, { etag: 'W/"1"' }),
};
for (const m of initial()) {
  routes[`PUT /v1/tenant/modules/${m.key}`] = async req => {
    if (req.headers.get('if-match') && req.headers.get('if-match') !== `W/"${v}"`) return json({ title: 'Version', status: 412 }, 412);
    const { active } = await req.json() as { active: boolean };
    const cur = own.find(x => x.key === m.key)!;
    if (!active && cur.blockers?.length) return json({ title: 'Konflikt', status: 409, reason: 'hindernisse', hindernisse: cur.blockers }, 409);
    v += 1;
    own = own.map(x => (x.key === m.key ? { ...x, active, blockers: active ? [] : undefined } : x.module === m.key && !active ? { ...x, active: false } : x));
    return json(own.find(x => x.key === m.key), 200, { etag: `W/"${v}"` });
  };
  routes[`PUT /v1/platform/organizations/muster/modules/${m.key}`] = async req => {
    const { allowed } = await req.json() as { allowed: boolean };
    const force = new URL(req.url).searchParams.get('force') === 'true';
    const cur = other.find(x => x.key === m.key)!;
    if (!allowed && cur.active && cur.blockers?.length && !force) return json({ title: 'Konflikt', status: 409, reason: 'hindernisse', hindernisse: cur.blockers }, 409);
    other = other.map(x => (x.key === m.key ? { ...x, allowed, active: allowed && x.active } : x));
    return json(other.find(x => x.key === m.key));
  };
}
window.fetch = mockIamApi(routes, { catalog }).fetch;

const all = makeIamRoutes({}, {});
const route = all.find(r => r.id === 'modules')!;
const platform = new URLSearchParams(location.search).get('p') === 'platform';
if (!platform) history.replaceState(null, '', route.path);
const Page = lazy(route.load);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IamProvider product="Zeit" features={{ platform: false }}>
      <div className="admin">
        <aside><IamNav /></aside>
        <main className="admin-main">
          {platform ? <div className="page"><ModulesSection alias="muster" orgLabel="Muster GmbH" /></div> : <Suspense fallback={<p>Lädt …</p>}><Page /></Suspense>}
        </main>
      </div>
    </IamProvider>
  </StrictMode>,
);
