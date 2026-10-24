/**
 * «Zugriff» als Seitenleiste an jeder Ressource, überall gleich aufgebaut (Spezifikation 11.4, Konzept 5.2):
 *
 *   Zugriff auf «Server srv-042»                          [Freigeben]
 *     Vertraulichkeit: vertraulich ▾      (nur bei classified, speichern über die App)
 *     Für alle Mitglieder [Schalter]      (nur bei Typen mit owner und Rolle viewer am Typ, A7)
 *     Wer · Rolle · Über · Bis            (direkt zuerst, dann geerbt von unten nach oben, dann Zuständigkeit)
 *     Warum sehe ich das?
 *
 * «Über» nennt den Ort (`via`, `place`, `unit`), der Pfeil öffnet ihn (`resources.open`). Direkte Einträge mit
 * `removable` lassen sich ändern (Ablauf, `PATCH`) und entfernen; geerbte nur am Ursprung. Was ich nicht darf, steht
 * gesperrt mit Grund statt zu fehlen.
 */
import { useId, useState } from 'react';
import { useAuthz } from '../authz.ts';
import type { AccessEntry, AccessList, Level, ResourceRef } from '../contract.ts';
import { fmtDate } from '../format.ts';
import { ADMIN_ROLE, ALL_MEMBERS, ORG_TYPE, VIEWER_ROLE } from '../permissions.ts';
import { ApiError } from '../problem.ts';
import { useIam } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { MenuItem } from '../ui/MenuButton.tsx';
import { Confirm, Sheet } from '../ui/Overlay.tsx';
import { ErrorBox, ErrorState, SkeletonRows } from '../ui/states.tsx';
import { useAccessList, useGrant, usePatchAccess, useRevoke } from './api.ts';
import { GrantDialog } from './GrantDialog.tsx';
import { OpenPlace, usePlaceName } from './places.tsx';
import { AccessError, dateValue, expiresAtOf, expiryError, ExpiryField } from './shared.tsx';
import { WhyDialog } from './WhyDialog.tsx';

export interface AccessSheetProps {
  resource: ResourceRef;
  /** Name der Ressource; Titel «Zugriff auf «label»». */
  label: string;
  open: boolean;
  onClose(): void;
  /** Feld Vertraulichkeit, nur bei `classified`; speichern über den Endpunkt der App. */
  classification?: { level: Level; onChange?(level: Level): Promise<void>; disabledReason?: string };
}

export function AccessSheet(props: AccessSheetProps) {
  return props.open ? <AccessSheetBody {...props} /> : null;
}

function AccessSheetBody({ resource, label, onClose, classification }: AccessSheetProps) {
  const { Button } = useIamUi();
  const authz = useAuthz();
  useIamText();
  const fid = useId();
  const q = useAccessList(resource);
  const [granting, setGranting] = useState(false);
  const [why, setWhy] = useState(false);
  const grantable = q.data?.grantable ?? [];
  const noGrant = q.data && !grantable.length ? t('iam.access.noGrant', { perm: authz.permLabel('access:admin') }) : null;
  return (
    <>
      <Sheet title={t('iam.access.title', { label })} onClose={onClose}
        sub={(
          <div className="iam-access-head">
            <Button variant="primary" icon="plus" aria-disabled={!q.data || noGrant ? true : undefined} aria-describedby={noGrant ? `${fid}-ng` : undefined}
              onClick={() => { if (q.data && !noGrant) setGranting(true); }}>{t('iam.access.grant')}</Button>
            {noGrant ? <span id={`${fid}-ng`} className="iam-muted iam-small">{noGrant}</span> : null}
          </div>
        )}
        footer={<button type="button" className="iam-linkbtn iam-access-why" onClick={() => setWhy(true)}>{t('iam.access.why')}</button>}>
        {q.isPending ? <SkeletonRows rows={4} cols={4} />
          : q.error ? <ErrorState error={q.error} onRetry={q.error instanceof ApiError && q.error.status === 404 ? undefined : () => void q.refetch()} />
          : <AccessContent list={q.data} resource={resource} label={label} classification={classification} />}
        <p className="iam-note">{t('iam.access.timing')}</p>
      </Sheet>
      {granting && q.data ? <GrantDialog resource={resource} label={label} grantable={grantable} onClose={() => setGranting(false)} /> : null}
      {why ? <WhyDialog resource={resource} label={label} onClose={() => setWhy(false)} /> : null}
    </>
  );
}

function AccessContent({ list, resource, label, classification }: { list: AccessList; resource: ResourceRef; label: string; classification?: AccessSheetProps['classification'] }) {
  const { Icon, Menu, Table } = useIamUi();
  const authz = useAuthz();
  const placeName = usePlaceName();
  const [revoking, setRevoking] = useState<AccessEntry | null>(null);
  const [expiring, setExpiring] = useState<AccessEntry | null>(null);
  const type = authz.type(resource.type);
  // «Für alle Mitglieder»: nur bei Typen mit Besitz und `membersRole` (A7; Kit < 1.2: viewer, falls zulässig)
  const membersRole = type?.owner ? type.membersRole ?? (type.roles.includes(VIEWER_ROLE) ? VIEWER_ROLE : undefined) : undefined;
  const membersSwitch = !!membersRole;
  const isMembersViewer = (e: AccessEntry) => e.via === 'direct' && e.subject.ref === ALL_MEMBERS && e.relation === membersRole;
  const rows = membersSwitch ? list.items.filter(e => !isMembersViewer(e)) : list.items;
  const notRemovable = t('iam.access.notRemovable', { perm: authz.permLabel('access:admin') });
  const who = (e: AccessEntry) => (e.subject.kind === 'group' ? t('iam.access.kind.group', { name: e.subject.name })
    : e.subject.kind === 'client' ? t('iam.access.kind.client', { name: e.subject.name }) : e.subject.name);
  const over = (e: AccessEntry) => (e.via === 'direct' ? t('iam.access.via.direct')
    : e.via === 'scope' ? t('iam.access.via.scope', { unit: e.unit ? placeName(e.unit.ref) : '' })
      : e.via === 'data' ? t('iam.access.via.data', { relation: e.data?.relation ?? e.relation })
        : placeName(e.place));
  const origin = (e: AccessEntry): ResourceRef | null => (e.via === 'scope' ? e.unit?.ref ?? null : e.via === 'inherited' ? e.place : null);
  return (
    <>
      {classification && list.classification !== null ? <ClassificationField level={classification.level} onChange={classification.onChange} disabledReason={classification.disabledReason} /> : null}
      {membersSwitch ? <MembersSwitch list={list} resource={resource} label={label} entry={list.items.find(isMembersViewer) ?? null} role={membersRole!} /> : null}
      {rows.length ? (
        <div className="iam-tblwrap">
          <Table stack className="iam-access-tbl">
            <caption className="iam-sr">{t('iam.access.caption', { label })}</caption>
            <thead><tr>
              <th scope="col">{t('iam.access.col.who')}</th><th scope="col">{t('iam.access.col.role')}</th><th scope="col">{t('iam.access.col.via')}</th>
              <th scope="col">{t('iam.access.col.until')}</th><th scope="col" className="iam-acts"><span className="iam-sr">{t('iam.access.col.actions')}</span></th>
            </tr></thead>
            <tbody>
              {rows.map((e, i) => {
                const to = origin(e);
                const name = who(e);
                const adminAtOrg = e.relation === ADMIN_ROLE && e.place.type === ORG_TYPE;
                return (
                  <tr key={e.id ?? `${e.via}-${i}`}>
                    <td><div className="iam-b">{name}</div>
                      {e.subject.kind === 'client' && e.subject.scopes?.length ? <div className="iam-muted iam-small">{t('iam.access.scopes', { scopes: e.subject.scopes.join(', ') })}</div> : null}</td>
                    <td><span className="iam-st-lbl">{t('iam.access.col.role')}:</span>{authz.relationLabel(e.relation)}</td>
                    <td><span className="iam-st-lbl">{t('iam.access.col.via')}:</span>{over(e)}</td>
                    <td><span className="iam-st-lbl">{t('iam.access.col.until')}:</span>{e.expiresAt ? fmtDate(e.expiresAt) : '–'}</td>
                    <td className="iam-acts"><div className="iam-row-acts">
                      {e.via === 'direct' && e.id ? (
                        <Menu label={t('iam.access.menu', { name })} buttonLabel={t('iam.access.more', { name })} title={t('iam.common.more')} className="iam-iconbtn iam-sm" fixed button={<Icon name="more" className="iam-ico" />}>
                          {close => <>
                            <MenuItem icon="clock" label={t('iam.access.expiry')} why={!e.removable ? notRemovable : adminAtOrg ? t('iam.access.expiry.adminNo', { role: authz.roleLabel(ADMIN_ROLE) }) : null} onPick={() => { close(); setExpiring(e); }} />
                            <MenuItem icon="x" danger label={t('iam.access.revoke')} why={e.removable ? null : notRemovable} onPick={() => { close(); setRevoking(e); }} />
                          </>}
                        </Menu>
                      ) : <>
                        <span className="iam-sr">{e.via === 'data' ? t('iam.access.dataOrigin') : t('iam.access.inherited', { place: to ? placeName(to) : over(e) })}</span>
                        {to ? <OpenPlace place={to} label={placeName(to)} /> : null}
                      </>}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      ) : <p className="iam-muted iam-small">{t('iam.access.empty')}</p>}
      {revoking ? <RevokeConfirm entry={revoking} label={label} onClose={() => setRevoking(null)} /> : null}
      {expiring ? <ExpiryDialog entry={expiring} onClose={() => setExpiring(null)} /> : null}
    </>
  );
}

/** Schalter «Für alle Mitglieder» = Freigabe `org:members` mit `membersRole` des Typs an diesem Ort. */
function MembersSwitch({ list, resource, label, entry, role }: { list: AccessList; resource: ResourceRef; label: string; entry: AccessEntry | null; role: string }) {
  const { toast } = useIamUi();
  const { orgName } = useIam();
  const authz = useAuthz();
  const fid = useId();
  const grant = useGrant();
  const revoke = useRevoke();
  const on = !!entry;
  const locked = on ? (entry.removable ? null : t('iam.access.notRemovable', { perm: authz.permLabel('access:admin') }))
    : list.grantable.includes(role) ? null : t('iam.access.allMembers.locked', { role: authz.roleLabel(role) });
  const busy = grant.isPending || revoke.isPending;
  const toggle = () => {
    if (locked || busy) return;
    if (on) revoke.mutate(entry.id!, { onSuccess: () => toast.show(t('iam.access.allMembers.off', { org: orgName })) });
    else grant.mutate({ subject: ALL_MEMBERS, relation: role, type: resource.type, id: resource.id }, { onSuccess: () => toast.show(t('iam.access.allMembers.on', { org: orgName })) });
  };
  const error = grant.error ?? revoke.error;
  return (
    <div className="iam-access-all">
      <button type="button" role="switch" className="iam-switch" aria-checked={on} aria-disabled={locked || busy ? true : undefined}
        aria-labelledby={`${fid}-l`} aria-describedby={`${fid}-d`} onClick={toggle}><span aria-hidden="true" /></button>
      <div>
        <div id={`${fid}-l`} className="iam-b">{t('iam.access.allMembers')}</div>
        <div id={`${fid}-d`} className="iam-muted iam-small">{locked ?? t('iam.access.allMembers.hint', { org: orgName, label, role: authz.roleLabel(role) })}</div>
        {error ? <AccessError error={error} compact /> : null}
      </div>
    </div>
  );
}

/** Vertraulichkeit der Ressource: nur bis zur eigenen Freigabestufe, und nur, wenn die bisherige Stufe nicht darüber liegt (7.8). */
function ClassificationField({ level, onChange, disabledReason }: { level: Level; onChange?: (l: Level) => Promise<void>; disabledReason?: string }) {
  const { me } = useIam();
  const { Icon, toast } = useIamUi();
  const authz = useAuthz();
  const fid = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const own = me.clearance;
  const above = level > own ? t('iam.access.classification.above', { level: authz.classificationLabel(level), own: authz.classificationLabel(own) }) : null;
  const reason = disabledReason ?? above ?? (onChange ? null : t('iam.access.classification.readOnly'));
  const change = async (next: Level) => {
    if (!onChange || next === level) return;
    setBusy(true); setError(null);
    try { await onChange(next); toast.show(t('iam.access.classification.saved', { level: authz.classificationLabel(next) })); }
    catch (e) { setError(e); }
    finally { setBusy(false); }
  };
  return (
    <div className="iam-access-cls">
      <label htmlFor={`${fid}-c`}><Icon name="lock" className="iam-ico" />{t('iam.access.classification')}</label>
      <select id={`${fid}-c`} className="iam-inp" value={level} disabled={!!reason || busy} aria-describedby={reason ? `${fid}-r` : undefined}
        onChange={e => void change(Number(e.target.value) as Level)}>
        {([0, 1, 2] as const).map(l => <option key={l} value={l} disabled={l > own}>{authz.classificationLabel(l)}{l > own ? ` – ${t('iam.access.classification.overOwn')}` : ''}</option>)}
      </select>
      {reason ? <span id={`${fid}-r`} className="iam-muted iam-small">{reason}</span> : null}
      {error ? <ErrorBox error={error} compact /> : null}
    </div>
  );
}

function RevokeConfirm({ entry, label, onClose }: { entry: AccessEntry; label: string; onClose: () => void }) {
  const { toast } = useIamUi();
  const { orgName } = useIam();
  const authz = useAuthz();
  const revoke = useRevoke();
  return (
    <Confirm title={t('iam.access.revoke.title', { org: orgName })} confirm={t('iam.access.revoke.confirm')} danger busy={revoke.isPending} onClose={onClose}
      onConfirm={() => revoke.mutate(entry.id!, { onSuccess: () => { toast.show(t('iam.access.revoke.done', { org: orgName })); onClose(); } })}>
      <p>{t('iam.access.revoke.text', { who: entry.subject.name, role: authz.relationLabel(entry.relation), label })}</p>
      <p className="iam-muted iam-small">{t('iam.access.revoke.note')}</p>
      {revoke.error ? <AccessError error={revoke.error} compact /> : null}
    </Confirm>
  );
}

function ExpiryDialog({ entry, onClose }: { entry: AccessEntry; onClose: () => void }) {
  const { Dialog, Button, toast } = useIamUi();
  const { orgName } = useIam();
  const authz = useAuthz();
  const fid = useId();
  const patch = usePatchAccess();
  const [value, setValue] = useState(dateValue(entry.expiresAt));
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const e = expiryError(value);
    setErr(e);
    if (e) { document.getElementById(`${fid}-u`)?.focus(); return; }
    patch.mutate({ id: entry.id!, expiresAt: expiresAtOf(value) }, { onSuccess: () => { toast.show(t('iam.access.expiry.done', { org: orgName })); onClose(); } });
  };
  return (
    <Dialog title={t('iam.access.expiry.title', { who: entry.subject.name })} onClose={onClose} onSubmit={submit} width={440}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" busy={patch.isPending}>{t('iam.common.save')}</Button></>}>
      <p className="iam-muted iam-small">{t('iam.access.expiry.intro', { role: authz.relationLabel(entry.relation), org: orgName })}</p>
      <div className="iam-form iam-compact"><ExpiryField id={`${fid}-u`} value={value} onChange={v => { setValue(v); setErr(null); }} error={err} /></div>
      {patch.error ? <AccessError error={patch.error} /> : null}
    </Dialog>
  );
}
