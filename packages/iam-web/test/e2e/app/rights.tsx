/** Testseite der Rechte-Bausteine: Seitenkopf, Kontomenü mit «Meine Rechte» (Rollen an Orten), Rechte-Übersicht (mit Scopes), Rollenmatrix, «Recht fehlt». */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/styles.css';
import { AccountMenu, AdminHead, IamProvider, MissingRight, OrgName, Requires, RightsOverview, RoleCompare, useAuthz } from '../../../src/index.ts';
import { json, ME, mockIamApi, staticResources } from '../../../src/testing/index.tsx';
import './page.css';

sessionStorage.removeItem('iam.tab.org');
const perms = ['tenant:read', 'note:read', 'note:write', 'access:admin', 'audit:read'];
const me = { ...ME, roles: ['editor', 'auditor'], permissions: perms, somewhere: [...perms, 'note:delete', 'folder:admin'], clearance: 1 as const };
// Rollen an Orten («Meine Rechte»): Ordner-Admin an einem Ordner
const places = { items: [{ id: 't1', subject: { ref: 'user:p-anna', kind: 'user', name: 'Anna Admin' }, relation: 'folder-admin', place: { type: 'folder', id: 'f1' }, via: 'direct', expiresAt: null, createdAt: null, createdBy: null, removable: false }] };
window.fetch = mockIamApi({ 'GET /v1/access': () => json(places) }, { me }).fetch;

function App() {
  const authz = useAuthz();
  return (
    <div className="page">
      <header className="row"><b>Notizen</b> · <OrgName /><span style={{ flex: 1 }} /><AccountMenu avatar={<span aria-hidden="true">AA</span>} /></header>
      <AdminHead icon="users" title="Rechte" sub="Bausteine der Rechte" crumbs={[['Zugang', '/verwalten']]} actions={<button type="button" className="iam-btn iam-primary">Hauptaktion</button>} />
      <MissingRight perm="members:admin" lead="Zum Einladen" />
      <section aria-labelledby="h-c">
        <h2 id="h-c">Maschinen-Client mit Scopes</h2>
        <RightsOverview roles={['editor']} scopes={['notes:read']} headingLevel={3} />
      </section>
      <section aria-labelledby="h-m">
        <h2 id="h-m">Rollen</h2>
        {authz.catalog ? <RoleCompare roles={authz.catalog.roles} highlight={['editor']} open /> : null}
      </section>
      <Requires perm="members:admin" title="Mitglieder" icon="users"><p>nie sichtbar</p></Requires>
    </div>
  );
}

const resources = staticResources({ folder: { f1: 'Projekte' } });
createRoot(document.getElementById('root')!).render(<StrictMode><IamProvider product="Notizen" resources={resources}><App /></IamProvider></StrictMode>);
