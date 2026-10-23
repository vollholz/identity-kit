/**
 * Fähigkeiten je Ressource (Spezifikation 7.1, `can`): Antworten der App tragen `can` mit den ressourcengenauen Rechten
 * (Rolle und Zugriffsregeln). Fehlt das Feld oder die Ressource, gilt das Recht auf Ebene der Organisation aus /auth/me.
 * Herkunft: vollholz/assets `web/src/auth/resource-can.ts`.
 */
import { useCallback } from 'react';
import type { Permission } from './permissions.ts';
import { useIam } from './session.tsx';

export function useResourceCan() {
  const { can } = useIam();
  return useCallback(<R extends { can?: object }>(resource: R | null | undefined, capability: keyof NonNullable<R['can']> & string, perm: Permission): boolean => {
    const c = resource?.can as Record<string, boolean> | undefined;
    return c ? c[capability] === true : can(perm);
  }, [can]);
}
