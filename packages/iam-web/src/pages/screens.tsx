/** Seiten mit Guard (Spezifikation 11.2: ohne Recht «Recht fehlt», die Seite selbst fragt dann nichts ab). */
import { Requires } from '../rights/Requires.tsx';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { MembersPage } from './Members.tsx';
import { RolesPage } from './Roles.tsx';

export function MembersScreen() {
  useIamText();
  return <Requires perm="members:admin" title={t('iam.members.title')} icon="users"><MembersPage /></Requires>;
}

export function RolesScreen() {
  useIamText();
  return <Requires perm="members:admin" title={t('iam.rolesPage.title')} icon="tag"><RolesPage /></Requires>;
}
