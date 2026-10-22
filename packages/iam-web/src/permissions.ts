/**
 * Schlüssel der Rechte: Die App registriert ihren Typ (aus ihrem Katalog) einmal, danach prüfen `can`, `Requires` und
 * `MissingRight` die Schlüssel. Ohne Registrierung ist `Permission` = `string`.
 *
 *   declare module '@vollholz/iam-web' { interface Register { permission: Permission } }
 *
 * Reservierte Namen (Spezifikation 8.1) nutzt das Paket direkt als Konstanten.
 */
// Leer: die App erweitert sie (declaration merging)
export interface Register {}

export type Permission = Register extends { permission: infer P extends string } ? P : string;

/** Rolle mit allen Rechten (8.1). */
export const ADMIN_ROLE = 'org-admin';
/** Realm-Rolle der Plattform-Administration – kein Recht des Katalogs (3.5). */
export const PLATFORM_ADMIN = 'platform-admin';
/** Präfix der Schlüssel eigener Rollen (8.3). */
export const CUSTOM_ROLE_PREFIX = 'c-';
export const isCustomRole = (key: string): boolean => key.startsWith(CUSTOM_ROLE_PREFIX);

/** Reservierte Rechte, die die Bausteine verwenden (8.1). */
export const RESERVED = {
  tenantRead: 'tenant:read',
  tenantAdmin: 'tenant:admin',
  membersAdmin: 'members:admin',
  aclRead: 'acl:read',
  aclAdmin: 'acl:admin',
  auditRead: 'audit:read',
} as const;
