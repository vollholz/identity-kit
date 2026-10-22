/**
 * Organisation sichtbar und wechselbar (Spezifikation 11.1): `OrgName` für die Kopfzeile (auf allen Breiten),
 * `useOrgSwitchItems` für die Befehlspalette der App («Zu «Name» wechseln», ohne neue Anmeldung, nur dieser Tab).
 */
import { orgName as nameOf, useIam } from '../session.tsx';
import { t } from '../texts/index.ts';

/** Name der Organisation dieses Tabs; Alias als title. */
export function OrgName({ className }: { className?: string }) {
  const { me, orgName } = useIam();
  return <span className={className ?? 'iam-org'} title={me.tenant?.alias}>{orgName}</span>;
}

export interface OrgSwitchItem { alias: string; name: string; label: string; run: () => Promise<void> }

/** Einträge zum Wechsel in die übrigen Organisationen der Person. */
export function useOrgSwitchItems(): OrgSwitchItem[] {
  const { me, switchOrg } = useIam();
  return me.organizations.filter(o => o !== me.tenant?.alias).map(o => {
    const name = nameOf(me, o);
    return { alias: o, name, label: t('iam.org.switchTo', { org: name }), run: () => switchOrg(o) };
  });
}
