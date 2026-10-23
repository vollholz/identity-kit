/**
 * «Warum?» (Spezifikation 9.5 `GET /v1/access/explain`, 11.2): alle Wege, die ein Recht an einem Ort ergeben (Rolle am
 * Ort oder darüber, Zuständigkeit, Besitz), und was trotzdem verhindert (Vertraulichkeit über der Freigabestufe, fehlender
 * Scope). Ohne `subject` für mich selbst; ohne `permission` das Leserecht des Typs («Warum sehe ich das?»). Scheitert es an
 * der Vertraulichkeit und darf ich Break-Glass starten, steht das Formular dafür hier (A19).
 */
import { useAuthz } from '../authz.ts';
import type { Explain, ResourceRef } from '../contract.ts';
import { ALL_MEMBERS } from '../permissions.ts';
import { missingPlaceText } from '../rights/MissingRight.tsx';
import { useIam } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { ErrorState, Loading } from '../ui/states.tsx';
import { useExplain } from './api.ts';
import { BreakGlassStart, useBreakGlass } from './BreakGlass.tsx';
import { OpenPlace, usePlaceName } from './places.tsx';

export interface WhyDialogProps { resource: ResourceRef; label: string; permission?: string; subject?: string; onClose(): void }

type Reason = Explain['reasons'][number];

export function WhyDialog({ resource, label, permission, subject, onClose }: WhyDialogProps) {
  const { Dialog, Button } = useIamUi();
  useIamText();
  const q = useExplain(resource, { permission, subject });
  const title = !subject && !permission ? t('iam.access.why.titleSelf', { label }) : t('iam.access.why.title', { label });
  return (
    <Dialog title={title} onClose={onClose} width={560} footer={<Button variant="primary" data-autofocus onClick={onClose}>{t('iam.common.close')}</Button>}>
      {q.isPending ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <WhyBody x={q.data} resource={resource} label={label} self={!subject} />}
    </Dialog>
  );
}

function WhyBody({ x, resource, label, self }: { x: Explain; resource: ResourceRef; label: string; self: boolean }) {
  const authz = useAuthz();
  const placeName = usePlaceName();
  const bg = useBreakGlass();
  const { me } = useIam();
  const perm = authz.permLabel(x.permission);
  const v = { perm, label, name: x.subject.name };
  const lead = x.allowed ? t(self ? 'iam.access.why.allowedSelf' : 'iam.access.why.allowed', v) : t(self ? 'iam.access.why.deniedSelf' : 'iam.access.why.denied', v);
  const via = (r: Reason): string => {
    const role = authz.relationLabel(r.relation);
    if (r.via === 'owner') return t('iam.access.why.owner', { label });
    if (r.via === 'scope') return t('iam.access.why.scope', { label, unit: r.unit ? placeName(r.unit.ref) : '', relation: r.unit?.relation ?? r.relation });
    if (r.via === 'direct') return t('iam.access.why.direct', { role, label });
    return t('iam.access.why.inherited', { role, place: placeName(r.place) });
  };
  const matched = (r: Reason) => (r.matched === ALL_MEMBERS ? t('iam.access.why.viaMembers') : r.matched.startsWith('group:') ? t('iam.access.why.viaGroup') : '');
  const target = (r: Reason): ResourceRef | null => (r.via === 'scope' ? r.unit?.ref ?? null : r.via === 'inherited' ? r.place : null);
  const blocked = x.blocked;
  return (
    <div className="iam-why">
      <p className={`iam-why-lead iam-is-${x.allowed ? 'ok' : 'no'}`}>{lead}</p>
      {x.reasons.length ? (
        <ul className="iam-why-list" aria-label={t('iam.access.why.ways')}>
          {x.reasons.map((r, i) => {
            const to = target(r);
            return (
              <li key={`${r.tupleId ?? r.via}-${i}`}>
                <span>{via(r)}{matched(r) ? <span className="iam-muted"> {matched(r)}</span> : null}</span>
                {to ? <OpenPlace place={to} label={placeName(to)} /> : null}
              </li>
            );
          })}
        </ul>
      ) : !blocked ? <p className="iam-muted iam-small">{t('iam.access.why.none')} {missingPlaceText(authz, x.permission, resource.type, label)}</p> : null}
      {blocked?.reason === 'clearance' ? (
        <p className="iam-warnbox" role="note">{t(self ? 'iam.access.why.clearanceSelf' : 'iam.access.why.clearance', {
          level: authz.classificationLabel(blocked.classification), own: authz.classificationLabel(blocked.clearance), name: x.subject.name,
        })}</p>
      ) : null}
      {blocked?.reason === 'scope' ? <p className="iam-warnbox" role="note">{blocked.scope ? t('iam.access.why.scopeMissing', { scope: blocked.scope }) : t('iam.access.why.scopeNone')}</p> : null}
      {blocked?.reason === 'clearance' && self ? (bg.allowed && !bg.until
        ? <BreakGlassStart />
        : bg.until ? <p className="iam-note">{t('iam.breakGlass.running', { level: authz.classificationLabel(me.clearance) })}</p>
          : <p className="iam-note">{t('iam.breakGlass.notAllowed', { role: authz.roleLabel('org-admin') })}</p>) : null}
    </div>
  );
}
