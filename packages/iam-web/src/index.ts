/**
 * @vollholz/iam-web – Oberfläche des IAM-Baukastens (Spezifikation Kap. 11, docs/entwurf.md).
 * Stand 2a: Vertragstypen, Client, Fehler, Organisation je Tab, Texte, Formatierung.
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
