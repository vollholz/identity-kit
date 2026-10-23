/** Seiten mit Guard (Spezifikation 11.2: ohne Recht «Recht fehlt», die Seite selbst fragt dann nichts ab). */
import { Requires, RequiresPlatformAdmin } from '../rights/Requires.tsx';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { ClientsPage } from './Clients.tsx';
import { EntraPage } from './Entra.tsx';
import { MembersPage } from './Members.tsx';
import { OrganizationPage, OrganizationsPage } from './Organizations.tsx';
import { RolesPage } from './Roles.tsx';

export function MembersScreen() {
  useIamText();
  return <Requires perm="members:admin" title={t('iam.members.title')} icon="users"><MembersPage /></Requires>;
}

export function RolesScreen() {
  useIamText();
  return <Requires perm="members:admin" title={t('iam.rolesPage.title')} icon="tag"><RolesPage /></Requires>;
}

export function ClientsScreen() {
  useIamText();
  return <Requires perm="members:admin" title={t('iam.clients.title')} icon="key"><ClientsPage /></Requires>;
}

/** Organisationen prüfen die Plattform-Administration selbst (Status mit `platformAdmin`, ohne «Recht fehlt»). */
export function OrganizationsScreen() {
  useIamText();
  return <RequiresPlatformAdmin title={t('iam.orgs.title')} icon="building"><OrganizationsPage /></RequiresPlatformAdmin>;
}

export function OrganizationScreen() {
  useIamText();
  return <RequiresPlatformAdmin title={t('iam.orgs.one')} icon="building"><OrganizationPage /></RequiresPlatformAdmin>;
}

export function EntraScreen() {
  useIamText();
  return <Requires perm="members:admin" title={t('iam.entra.title')} icon="shield"><EntraPage /></Requires>;
}
