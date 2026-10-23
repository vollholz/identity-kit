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
/** Beziehungen ohne bzw. mit allen Rechten der Ressource (8.1); keine Rollen. */
export const MEMBER_RELATION = 'member';
export const OWNER_RELATION = 'owner';
/** Subjekt «Alle Mitglieder» (7.4) und die Rolle des Schalters «Für alle Mitglieder» (11.4, A7). */
export const ALL_MEMBERS = 'org:members';
export const VIEWER_ROLE = 'viewer';
/** Wurzel jeder Kette (8.1). */
export const ORG_TYPE = 'org';

/** Reservierte Rechte, die die Bausteine verwenden (8.1). */
export const RESERVED = {
  tenantRead: 'tenant:read',
  tenantAdmin: 'tenant:admin',
  membersAdmin: 'members:admin',
  accessAdmin: 'access:admin',
  auditRead: 'audit:read',
} as const;
