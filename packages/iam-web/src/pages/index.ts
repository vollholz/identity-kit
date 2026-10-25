/**
 * Verwalten-Seiten (Import `@vollholz/iam-web/pages`, per `lazy()` bzw. `iamRoutes[].load()`): die Seiten ohne Guard
 * für eigene Routen der App und dieselben mit Guard (`…Screen`), wie `iamRoutes` sie lädt.
 */
export { MemberList, MembersPage, RolePicker, type MemberListProps, type RolePickerProps } from './Members.tsx';
export { OrganizationPage, OrganizationsPage, organizationPath } from './Organizations.tsx';
export { EntraConsentReturn, EntraPage, EntraSection, EntraTestReturn } from './Entra.tsx';
export { EntraHandoverPage, EntraHandoverReturn } from './EntraHandover.tsx';
export { ConsentLinkDialog, ConsentLinkList } from './EntraLinks.tsx';
export { OwnAppDialog, OwnAppFields, OwnAppGuideSteps, ownAppErrorText, type OwnAppDraft } from './EntraOwnApp.tsx';
export { EntraScreen, MembersScreen, OrganizationScreen, OrganizationsScreen } from './screens.tsx';
export { AccountHome, PlatformShell, SignupPage, type AccountHomeProps } from './Account.tsx';
