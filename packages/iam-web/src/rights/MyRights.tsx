/**
 * Dialog «Meine Rollen und Rechte» (Spezifikation 11.2): Rollen an der Organisation als Karten (Label und
 * Kurzbeschreibung, ganze Beschreibung als title), Rollen an Orten mit Ort und Ablauf (`GET /v1/access?subject=me`,
 * Pfeil zum Ort), Freigabestufe (mit laufendem Break-Glass), die Rechte-Übersicht für mich (Status `role`/`place`/`scope`)
 * und eingeklappt «Rollen vergleichen» mit den eigenen Rollen hervorgehoben.
 * Herkunft: vollholz/assets `web/src/shell/MyRights.tsx`.
 */
import { useMyAccess } from '../access/api.ts';
import { untilText, useBreakGlass } from '../access/BreakGlass.tsx';
import { OpenPlace, usePlaceName } from '../access/places.tsx';
import { useAccessFeature, useAuthz } from '../authz.ts';
import { fmtDate } from '../format.ts';
import { ORG_TYPE } from '../permissions.ts';
import { useIam } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamUi } from '../ui/context.tsx';
import { ErrorBox, Loading } from '../ui/states.tsx';
import { RightsOverview, roleSummary } from './RightsOverview.tsx';
import { RoleCompare } from './RoleMatrix.tsx';

/** Rollen an Orten (direkte Freigaben ausser an der Organisation). */
function MyPlaces() {
  const q = useMyAccess();
  const authz = useAuthz();
  const placeName = usePlaceName();
  if (q.isPending) return <Loading inline />;
  if (q.error) return <ErrorBox error={q.error} compact />;
  const items = q.data.items.filter(e => e.place.type !== ORG_TYPE);
  if (!items.length) return <p className="iam-muted iam-small">{t('iam.myRights.noPlaces')}</p>;
  return (
    <ul className="iam-my-places" aria-label={t('iam.myRights.places')}>
      {items.map(e => {
        const place = placeName(e.place);
        return (
          <li key={e.id ?? `${e.place.type}:${e.place.id}:${e.relation}`}>
            <span className="iam-b">{authz.relationLabel(e.relation)}</span>
            <span>{place}</span>
            {e.expiresAt ? <span className="iam-muted iam-small">{t('iam.myRights.until', { date: fmtDate(e.expiresAt) })}</span> : null}
            {e.subject.kind !== 'user' ? <span className="iam-muted iam-small">{t('iam.myRights.via', { who: e.subject.name })}</span> : null}
            <OpenPlace place={e.place} label={place} />
          </li>
        );
      })}
    </ul>
  );
}

export function MyRightsDialog({ onClose }: { onClose: () => void }) {
  const { me, orgName } = useIam();
  const { Dialog, Button } = useIamUi();
  const authz = useAuthz();
  const places = useAccessFeature();
  const bg = useBreakGlass();
  const cat = authz.catalog;
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
        ) : <p>{me.somewhere.length ? t('iam.myRights.noRolePlaces') : t('iam.myRights.noRole')}</p>}
        {places ? <><h4>{t('iam.myRights.places')}</h4><MyPlaces /></> : null}
        <h4>{t('iam.myRights.clearance')}</h4>
        <p>{t('iam.myRights.clearanceIs', { level: authz.classificationLabel(me.clearance) })}
          {bg.until ? <> <span className="iam-muted">{t('iam.myRights.breakGlass', { time: untilText(bg.until) })}</span></> : null}</p>
        <h4>{t('iam.myRights.rights')}</h4>
        <RightsOverview roles={me.roles} permissions={me.permissions} somewhere={me.somewhere} note={<>{t('iam.rights.placesNote')} {t('iam.myRights.ask')}</>} />
        {cat ? <RoleCompare roles={cat.roles} highlight={me.roles} /> : null}
      </div>
    </Dialog>
  );
}
