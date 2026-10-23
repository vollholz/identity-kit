/** Testseite der Rechte-Bausteine: Seitenkopf, Kontomenü, Rechte-Übersicht (mit Scopes), Rollenmatrix, «Recht fehlt». */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/styles.css';
import { AccountMenu, AdminHead, IamProvider, MissingRight, OrgName, Requires, RightsOverview, RoleCompare, useAuthz } from '../../../src/index.ts';
import { ME, mockIamApi } from '../../../src/testing/index.tsx';
import './page.css';

sessionStorage.removeItem('iam.tab.org');
const me = { ...ME, roles: ['folder-admin', 'auditor'], permissions: ['tenant:read', 'acl:read', 'note:read', 'note:write', 'note:delete', 'folder:admin', 'audit:read'], grantedPermissions: ['acl:admin'] };
window.fetch = mockIamApi({}, { me }).fetch;

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

createRoot(document.getElementById('root')!).render(<StrictMode><IamProvider product="Notizen"><App /></IamProvider></StrictMode>);
