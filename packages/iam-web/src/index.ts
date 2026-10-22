/**
 * @vollholz/iam-web – Oberfläche des IAM-Baukastens (Spezifikation Kap. 11, docs/entwurf.md).
 * Stand 2b: Vertragstypen, Client, Fehler, Organisation je Tab, Texte, Formatierung, Grundkomponenten.
 */
export type * from './contract.ts';
export { ApiError, describeError, errorFrom, fieldErrorText, networkError, statusText, type ErrorText } from './problem.ts';
export {
  authFetch, currentTenant, iamFetch, iamMiddleware, ifMatch, loginUrl, onForbidden, onSessionExpired, origin, reportStatus,
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
