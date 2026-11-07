/**
 * Produktmodule je Organisation im Haupteinstieg (Konzept «Module je Organisation», docs/module-je-organisation.md): nur,
 * was Navigation und Sitzung brauchen – ob das Modell Module hat (`useModulesFeature`) und das Neuladen nach einer
 * Schaltung (`modulesChanged`). Aufrufe, Abfragen, Regeln der Anzeige und die Texte `iam.modules.*` liegen in
 * `moduleTools.ts` und laden mit der Seite «Module» bzw. aus `@vollholz/iam-web/pages`.
 */
import type { QueryClient } from '@tanstack/react-query';
import { useAuthzCatalog } from './authz.ts';
import { useIamConfig } from './config.tsx';
import type { AuthzCatalog } from './contract.ts';
import { iamKeys } from './keys.ts';

export const hasModules = (catalog: AuthzCatalog | undefined): boolean => !!catalog?.modules?.some(m => !m.core);

/**
 * Seite «Module» und Abschnitt der Plattform-Administration zeigen: `features.modules`, sonst ob das Modell Module hat.
 * `undefined`, solange der Katalog lädt oder nicht geladen werden konnte (nie «keine Module» wegen eines Fehlers; den
 * Fehler zeigt die Seite mit `useAuthzCatalog().error`).
 */
export function useModulesFeature(enabled = true): boolean | undefined {
  const { features } = useIamConfig();
  const q = useAuthzCatalog(enabled && features.modules === undefined);
  if (features.modules !== undefined) return features.modules;
  return q.data ? hasModules(q.data) : undefined;
}

/**
 * Nach einer Schaltung neu laden: Liste, Sitzung (`modules`, Rechte) und Katalog – er enthält nur die Rechte aktiver
 * Module der Organisation.
 */
export function modulesChanged(qc: QueryClient, alias: string | null): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: iamKeys.modules(alias) }), qc.invalidateQueries({ queryKey: iamKeys.me }),
    qc.invalidateQueries({ queryKey: ['iam', 'catalog'] }),
  ]);
}
