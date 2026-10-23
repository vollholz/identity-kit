/**
 * Fähigkeiten der App nach Änderungen an Rechten aktuell halten: Antworten der App tragen je Ressource `can` (Rolle,
 * Freigaben, Verbote). Ändern sich Rollen oder Zugriffsregeln, sind diese Felder im Cache veraltet, auch wenn der Server
 * richtig entscheidet – ohne neue Anfrage sieht der Browser die Änderung nicht. Darum lädt das Paket die Daten der App
 * (`rightsData` der Konfiguration, Standard: alle Abfragen ausser denen des Pakets) neu:
 *
 * - Änderung in diesem Browser (Zugriffsregel anlegen oder löschen, eigene Rolle ändern oder löschen): sofort danach.
 * - Änderung anderswo (anderer Browser, andere Person): sobald /auth/me einen anderen Zugriffsstand (`accessTag`), andere
 *   Rollen oder Rechte meldet als vorher, also beim Zurückkehren in den Tab (wenn /auth/me älter als eine Minute ist) und
 *   nach jedem 403. `accessTag` ändert sich mit jeder Zugriffsregel, auch mit Freigaben und Verboten auf einzelnen
 *   Ressourcen; Server ohne `accessTag` (vor `@vollholz/iam` 0.4.0) bemerken nur geänderte Rollen und Rechte.
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useIamConfig, type IamConfig } from './config.tsx';
import type { Me } from './contract.ts';
import { iamKeys } from './keys.ts';

/** Standard: jede Abfrage der App, keine des Pakets (Schlüssel beginnt nicht mit 'iam'). */
export const defaultRightsData = (queryKey: readonly unknown[]): boolean => queryKey[0] !== iamKeys.all[0];

const appData = (config: Pick<IamConfig, 'rightsData'>) => {
  const match = config.rightsData ?? defaultRightsData;
  return { predicate: (q: { queryKey: readonly unknown[] }) => match(q.queryKey) };
};

/** Zugriffsstand, Rollen und Rechte einer Antwort von /auth/me; ändert sich der Wert, sind die Fähigkeiten im Cache veraltet. */
export const rightsOf = (me: Me | undefined): string => (me
  ? JSON.stringify([me.accessTag ?? null, [...me.roles].sort(), [...me.permissions].sort(), [...(me.grantedPermissions ?? [])].sort()])
  : '');

/** Daten der App neu laden (aktive sofort, übrige beim nächsten Gebrauch). */
export function invalidateRightsData(qc: QueryClient, config: Pick<IamConfig, 'rightsData'>, cancelRefetch = true): Promise<void> {
  return qc.invalidateQueries(appData(config), { cancelRefetch });
}

/**
 * Nach einer eigenen Änderung an Rechten: erst /auth/me (eigene Rechte), dann die Daten der App. Laufende Abfragen, die
 * /auth/me nach einer Änderung schon neu angestossen hat, laufen weiter (kein zweiter Abruf).
 */
export function useRefreshRights(): () => Promise<void> {
  const qc = useQueryClient();
  const config = useIamConfig();
  return useCallback(async () => {
    await qc.invalidateQueries({ queryKey: iamKeys.me });
    await invalidateRightsData(qc, config, false);
  }, [qc, config]);
}
