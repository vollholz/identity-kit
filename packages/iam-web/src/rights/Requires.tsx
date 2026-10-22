/**
 * Routen-Guards (Spezifikation 11.2): Seiten mit Rechtebedarf zeigen ohne Recht «Recht fehlt» statt eines 403. Die Seite
 * selbst wird dann nicht gezeichnet und fragt nichts ab. Herkunft: `requires()` in vollholz/assets `web/src/router.tsx`.
 */
import type { ReactNode } from 'react';
import { useAdminStatus } from '../admin.ts';
import { PLATFORM_ADMIN, type Permission } from '../permissions.ts';
import { useIam } from '../session.tsx';
import { Loading } from '../ui/states.tsx';
import { NoPermission } from './MissingRight.tsx';

export interface RequiresProps {
  perm: Permission;
  /** Titel und Symbol der Seite für «Recht fehlt». */
  title: string;
  icon: string;
  /**
   * Standard `true`: Recht irgendwo genügt (auch über eine Freigabe auf einer einzelnen Ressource; die Seite zeigt dann
   * nur diese). `false`: nur auf Ebene der Organisation.
   */
  somewhere?: boolean;
  children: ReactNode;
}

export function Requires({ perm, title, icon, somewhere = true, children }: RequiresProps) {
  const { can, canSomewhere } = useIam();
  return (somewhere ? canSomewhere(perm) : can(perm)) ? <>{children}</> : <NoPermission perm={perm} icon={icon} title={title} />;
}

/**
 * Guard für die Plattform-Administration: `platformAdmin` aus GET /v1/admin/status (Realm-Rolle, kein Recht des
 * Katalogs). Solange der Status lädt, ein Ladezustand; bei einem Fehler wie ohne Plattform-Administration.
 */
export function RequiresPlatformAdmin({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  const status = useAdminStatus();
  if (status.isPending) return <Loading />;
  return status.data?.platformAdmin ? <>{children}</> : <NoPermission perm={PLATFORM_ADMIN} icon={icon} title={title} />;
}
