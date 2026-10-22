/**
 * Dialog «Meine Rollen und Rechte» (Spezifikation 11.2): eigene Rollen als Karten (Label und Kurzbeschreibung, ganze
 * Beschreibung als title), darunter die Rechte-Übersicht für mich mit Hinweis auf Zugriffsregeln (Organisations-Admin
 * als ein Satz) und eingeklappt «Rollen vergleichen» mit den eigenen Rollen hervorgehoben. Rechte nur über Freigaben
 * einzelner Bereiche als Satz, ohne die Bereiche zu nennen (keine Liste einzelner Zugriffsregeln).
 * Herkunft: vollholz/assets `web/src/shell/MyRights.tsx`.
 */
import { useAuthz } from '../authz.ts';
import { useIam } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamUi } from '../ui/context.tsx';
import { RightsOverview, roleSummary } from './RightsOverview.tsx';
import { RoleCompare } from './RoleMatrix.tsx';

export function MyRightsDialog({ onClose }: { onClose: () => void }) {
  const { me, orgName } = useIam();
  const { Dialog, Button } = useIamUi();
  const authz = useAuthz();
  const cat = authz.catalog;
  const granted = me.grantedPermissions ?? [];
  return (
    <Dialog title={t('iam.myRights.title')} onClose={onClose} width={720}
      footer={<Button variant="primary" data-autofocus onClick={onClose}>{t('iam.common.close')}</Button>}>
      <div className="iam-my-rights">
        <p className="iam-muted iam-small">{t('iam.myRights.org')} <b>{orgName}</b></p>
        <h4>{t('iam.myRights.roles')}</h4>
        {me.roles.length ? (
          <ul className="iam-my-roles">{me.roles.map(r => {
            const info = cat?.roles.find(x => x.key === r);
            return (
              <li key={r} className="iam-card" title={info?.description}>
                <span className="iam-b">{authz.roleLabel(r)}</span>
                {info ? <span className="iam-muted iam-small">{roleSummary(info.description)}</span> : null}
              </li>
            );
          })}</ul>
        ) : <p>{granted.length ? t('iam.myRights.noRoleGranted') : t('iam.myRights.noRole')}</p>}
        <h4>{t('iam.myRights.rights')}</h4>
        <RightsOverview roles={me.roles} permissions={me.permissions} rulesNote={<>{t('iam.rights.rulesNote')} {t('iam.myRights.ask')}</>} />
        {granted.length ? <p className="iam-note">{t('iam.myRights.granted', { perms: granted.map(p => `«${authz.permLabel(p)}»`).join(', ') })}</p> : null}
        {cat ? <RoleCompare roles={cat.roles} highlight={me.roles} /> : null}
      </div>
    </Dialog>
  );
}
