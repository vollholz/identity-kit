/**
 * Fehler beim Freigeben, Ändern und Entfernen (Spezifikation 9.5, 9.1 Nr. 5–7) in eigenen Worten: niemand gibt mehr,
 * als er hat (`exceeds-own` mit den fehlenden Rechten), `org-admin` nur über die Plattform-Administration, Duplikat,
 * letzte Person mit org-admin, nicht für sich selbst. Sonst die Meldung des Servers.
 */
import type { Authz } from '../authz.ts';
import { ADMIN_ROLE } from '../permissions.ts';
import { ApiError } from '../problem.ts';
import { listAnd, t } from '../texts/index.ts';

/** Eigener Satz zu einem bekannten Grund, sonst `null` (dann zeigt `ErrorBox` die Meldung des Servers). */
export function accessErrorText(e: unknown, authz: Authz): string | null {
  if (!(e instanceof ApiError)) return null;
  const reason = typeof e.problem.reason === 'string' ? e.problem.reason : null;
  if (e.status === 403 && reason === 'exceeds-own') {
    const missing = Array.isArray(e.problem.missing) ? (e.problem.missing as unknown[]).filter((p): p is string => typeof p === 'string') : [];
    return missing.length ? t('iam.access.err.exceedsOwn', { perms: listAnd(missing.map(p => `«${authz.permLabel(p)}»`)) }) : t('iam.access.err.exceedsOwnAny');
  }
  if (e.status === 403 && reason === 'platform-admin-only') return t('iam.access.err.platformOnly', { role: authz.roleLabel(ADMIN_ROLE) });
  if (e.status === 403 && reason === 'self') return t('iam.access.err.self');
  if (e.status === 409 && reason === 'duplicate') return t('iam.access.err.duplicate');
  if (e.status === 409 && reason === 'last-admin') return t('iam.access.err.lastAdmin', { role: authz.roleLabel(ADMIN_ROLE) });
  return null;
}
