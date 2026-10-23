/**
 * Verwalten-Seiten (Import `@vollholz/iam-web/pages`, per `lazy()` bzw. `iamRoutes[].load()`): die Seiten ohne Guard
 * für eigene Routen der App und dieselben mit Guard (`…Screen`), wie `iamRoutes` sie lädt.
 */
export { MemberList, MembersPage, RolePicker, type MemberListProps, type RolePickerProps } from './Members.tsx';
export { RolesPage } from './Roles.tsx';
export { ClientList, ClientsPage, checkRightsHref, type ClientListProps } from './Clients.tsx';
export { OrganizationPage, OrganizationsPage, organizationPath } from './Organizations.tsx';
export { EntraConsentReturn, EntraPage, EntraSection, EntraTestReturn } from './Entra.tsx';
export { ClientsScreen, EntraScreen, MembersScreen, OrganizationScreen, OrganizationsScreen, RolesScreen } from './screens.tsx';
