/**
 * Testseite der Sitzung: IamProvider gegen die Nachbildung des Vertrags (mockIamApi). `?view=` wählt den Zustand:
 * `choose` (mehrere Organisationen ohne Wahl), `unavailable` (Organisation des Tabs nicht mehr verfügbar), `loggedout`
 * (öffentliche Abmeldeseite), `expired` (401 einer Anfrage), sonst angemeldet.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/styles.css';
import { iamFetch, IamProvider, useIam } from '../../../src/index.ts';
import { json, ME, mockIamApi } from '../../../src/testing/index.tsx';
import './page.css';

const view = new URLSearchParams(location.search).get('view') ?? '';
if (view === 'unavailable') sessionStorage.setItem('iam.tab.org', JSON.stringify({ sub: ME.person.subject, alias: 'muster', name: 'Muster GmbH' }));
else sessionStorage.removeItem('iam.tab.org');

const me = view === 'choose' ? { ...ME, tenant: null, selectedOrganization: null, tenantError: null }
  : view === 'unavailable' ? { ...ME, tenant: null, tenantError: 'Du wurdest aus dieser Organisation entfernt. Bitte melde dich neu an.' }
  : ME;
const api = mockIamApi({ 'GET /v1/notes': () => json({ title: 'Nicht angemeldet', status: 401 }, 401) }, { me });
window.fetch = api.fetch;

function App() {
  const { me: m, orgName } = useIam();
  return (
    <main className="page">
      <h1>Angemeldet</h1>
      <p>{m.person.name} in {orgName}</p>
      <label className="field">Notiz<input name="notiz" /></label>
      <button type="button" className="iam-btn" onClick={() => void iamFetch('/v1/notes').catch(() => undefined)}>Notizen laden</button>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IamProvider product="Notizen" paths={view === 'loggedout' ? { loggedOut: location.pathname } : undefined}><App /></IamProvider>
  </StrictMode>,
);
