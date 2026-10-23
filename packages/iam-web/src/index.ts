/**
 * @vollholz/iam-web – Oberfläche des IAM-Baukastens (Spezifikation Kap. 11, docs/entwurf.md).
 * Stand 3: Vertragstypen, Client, Organisation je Tab, Texte, Grundkomponenten, Provider und Sitzung, Rechte-Bausteine.
 */
export type * from './contract.ts';
export { ApiError, describeError, errorFrom, fieldErrorText, networkError, statusText, type ErrorText } from './problem.ts';
export {
  authFetch, currentTenant, iamFetch, iamMiddleware, ifMatch, isLocalPath, loginUrl, onForbidden, onSessionExpired, origin, reportStatus,
  setCsrfToken, setTenant, tenantHeaders, withQuery, withTenant, type IamRequest, type QueryValue,
} from './client.ts';
export { adoptLegacyTabOrg, readTabOrg, TAB_ORG_KEY, tabOrgFor, writeTabOrg, type TabOrg } from './tabOrg.ts';
export { configureTexts, currentLocale, format, intlLocale, t, tn, type IamLocale, type IamPluralKey, type IamTextKey, type IamTexts, type TextVars } from './texts/index.ts';
export { fmtDate, fmtDateTime, fmtNum, initials, plural, relTime, shortId } from './format.ts';
export { ADMIN_ROLE, CUSTOM_ROLE_PREFIX, isCustomRole, PLATFORM_ADMIN, RESERVED, type Permission, type Register } from './permissions.ts';
export { IamUiProvider, useIamUi, type IamComponents } from './ui/context.tsx';
export { Button, buttonClass, type ButtonProps, type ButtonVariant } from './ui/Button.tsx';
export { Icon, type IconProps } from './ui/Icon.tsx';
export { ICON_NAMES, type IamIconName } from './ui/icons.ts';
export { Confirm, isVisible, Modal, Sheet, useFocusTrap, type ConfirmProps, type ModalProps, type SheetProps } from './ui/Overlay.tsx';
export { MenuButton, MenuItem, type MenuButtonProps } from './ui/MenuButton.tsx';
export { Table, type TableProps } from './ui/Table.tsx';
export { Empty, ErrorBox, ErrorState, Loading, NotFound, SkeletonRows } from './ui/states.tsx';
export { Picker, usePicker, type PickerProps, type PickItem } from './ui/Picker.tsx';
export type { ToastApi, ToastOptions } from './ui/Toasts.tsx';
export { IamProvider, type IamProviderProps } from './provider.tsx';
export { Can, Gate, LoggedOut, orgName, tenantName, useIam, type IamSession } from './session.tsx';
export { defaultRoleGroups, groupRoles, makeAuthz, roleGroupProblems, useAuthz, useAuthzCatalog, useRoles, withCustomRoles, type Authz } from './authz.ts';
export { useResourceCan } from './resourceCan.ts';
export { DEFAULT_PATHS, useIamConfig, type IamConfig, type IamFeatures, type IamPaths, type RoleGroup } from './config.tsx';
export { historyRouter, type IamLinkProps, type IamRouter } from './router.tsx';
export { iamKeys } from './keys.ts';
export { useIamText } from './texts/react.tsx';
export { useIamFetch } from './fetch.ts';
export { clientApi, entraApi, entraTest, memberApi, orgApi, roleApi, useAdminStatus, useClientGrants, useEntra, useMembers, useOrganization, useOrganizations } from './admin.ts';
export { MissingRight, missingRightText, NoPermission, type Need } from './rights/MissingRight.tsx';
export { AdminHead, type AdminHeadProps } from './rights/AdminHead.tsx';
export { Requires, RequiresPlatformAdmin, type RequiresProps } from './rights/Requires.tsx';
export { RightsOverview, rightsModel, roleSummary, type RightRow, type RightsInput, type RightsOverviewProps, type RightStatus } from './rights/RightsOverview.tsx';
export { RoleCompare, RoleMatrix, type RoleMatrixProps } from './rights/RoleMatrix.tsx';
export { MyRightsDialog } from './rights/MyRights.tsx';
export { AccountMenu, type AccountMenuProps } from './rights/AccountMenu.tsx';
export { OrgName, useOrgSwitchItems, type OrgSwitchItem } from './rights/OrgSwitch.tsx';
export { listAnd, listOr } from './texts/index.ts';
export { formatNode } from './texts/node.tsx';
export { containers, includedIn } from './roles.ts';
export { IamNav, iamRoutes, makeIamRoutes, tanstackParam, useIamNav, type IamNavItem, type IamRoute, type IamRouteId } from './routes.tsx';
