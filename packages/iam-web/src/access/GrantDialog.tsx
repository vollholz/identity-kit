/**
 * «Freigeben» an einem Ort (Spezifikation 11.4): Wer (Person aus dem Personenverzeichnis, Gruppe aus Entra ID – nur
 * mit `features.entra` und Entra-Verbindung, Suche über `GET /v1/access/groups` –, «Alle Mitglieder»), Rolle nur aus
 * `grantable` (am Ort zulässig und von mir selbst gehalten, 7.5), Ablaufdatum optional (nicht bei org-admin, A15).
 * Clients nie (nur über Mitglieder). Prüfung beim Absenden mit Meldung am Feld; Fehler des Servers im Dialog.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useAuthz } from '../authz.ts';
import { useIamConfig } from '../config.tsx';
import type { AccessEntry, ResourceRef } from '../contract.ts';
import { iamKeys } from '../keys.ts';
import { PersonPick } from '../people.tsx';
import { ADMIN_ROLE, ALL_MEMBERS, ORG_TYPE } from '../permissions.ts';
import { ApiError } from '../problem.ts';
import { useIam } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { ErrorBox, Loading } from '../ui/states.tsx';
import { accessApi, useGrant } from './api.ts';
import { AccessError, expiresAtOf, expiryError, ExpiryField } from './shared.tsx';

export interface GrantDialogProps {
  resource: ResourceRef;
  label: string;
  /** Relationen, die ich hier vergeben darf (`AccessList.grantable`). */
  grantable: string[];
  onClose(): void;
  onGranted?(entry: AccessEntry): void;
}

type Who = 'user' | 'group' | 'members';

/** Gruppen aus Entra ID suchen (ab 2 Zeichen, verzögert); ohne Verbindung der Grund statt der Suche. */
function GroupSearch({ id, value, onChange, invalid, describedBy, onUnavailable }: {
  id: string; value: { id: string; name: string } | null; onChange: (g: { id: string; name: string } | null) => void;
  invalid?: boolean; describedBy?: string; onUnavailable: (why: string) => void;
}) {
  const { Icon } = useIamUi();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => { const h = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(h); }, [q]);
  const hits = useQuery({ queryKey: iamKeys.accessGroups(term), enabled: term.length >= 2, staleTime: 30_000, retry: false, queryFn: ({ signal }) => accessApi.groups({ q: term }, signal) });
  const off = hits.error instanceof ApiError && hits.error.status === 409 && hits.error.problem.reason === 'entra-not-connected';
  useEffect(() => { if (off) onUnavailable(t('iam.access.grant.group.off')); }, [off, onUnavailable]);
  if (value) {
    return (
      <div className="iam-grant-picked">
        <Icon name="users" className="iam-ico" /><span className="iam-b">{value.name}</span>
        <button type="button" className="iam-linkbtn" onClick={() => onChange(null)}>{t('iam.access.grant.group.other')}</button>
      </div>
    );
  }
  const items = hits.data ?? [];
  return (
    <div className="iam-grant-groups">
      <label className="iam-search"><Icon name="search" className="iam-ico" /><span className="iam-sr">{t('iam.access.grant.group.search')}</span>
        <input id={id} type="search" placeholder={t('iam.access.grant.group.hint')} value={q} onChange={e => setQ(e.target.value)} autoComplete="off"
          aria-invalid={invalid || undefined} aria-describedby={describedBy} /></label>
      <div aria-live="polite">
        {term.length < 2 ? <p className="iam-muted iam-small">{t('iam.access.grant.group.min')}</p>
          : hits.isPending ? <Loading inline />
          : hits.error ? (off ? null : <ErrorBox error={hits.error} compact />)
          : !items.length ? <p className="iam-muted iam-small">{t('iam.access.grant.group.none')}</p>
          : <ul className="iam-grant-hits" aria-label={t('iam.access.grant.group.hits')}>
              {items.map(g => <li key={g.id}><button type="button" className="iam-entra-hit" onClick={() => onChange(g)}><span className="iam-b">{g.name}</span></button></li>)}
            </ul>}
      </div>
    </div>
  );
}

export function GrantDialog({ resource, label, grantable, onClose, onGranted }: GrantDialogProps) {
  const { Dialog, Button, Icon, toast } = useIamUi();
  const { features } = useIamConfig();
  const { orgName } = useIam();
  const authz = useAuthz();
  useIamText();
  const fid = useId();
  const grant = useGrant();
  const [who, setWho] = useState<Who>('user');
  const [person, setPerson] = useState('');
  const [group, setGroup] = useState<{ id: string; name: string } | null>(null);
  const [groupOff, setGroupOff] = useState<string | null>(null);
  const [relation, setRelation] = useState(grantable.length === 1 ? grantable[0]! : '');
  const [until, setUntil] = useState('');
  const [errs, setErrs] = useState<{ who?: string; relation?: string; until?: string }>({});
  const groups = !!features.entra;
  const noExpiry = relation === ADMIN_ROLE ? t('iam.access.expiry.adminNo', { role: authz.roleLabel(ADMIN_ROLE) }) : null;
  const role = authz.catalog?.roles.find(r => r.key === relation);

  const submit = () => {
    const e: typeof errs = {};
    if (who === 'user' && !person) e.who = t('iam.access.grant.required');
    if (who === 'group' && !group) e.who = groupOff ?? t('iam.access.grant.required');
    if (!relation) e.relation = t('iam.access.grant.required');
    const ue = noExpiry ? null : expiryError(until);
    if (ue) e.until = ue;
    setErrs(e);
    const first = e.who ? `${fid}-who` : e.relation ? `${fid}-rel` : e.until ? `${fid}-until` : null;
    if (first) { document.getElementById(first)?.focus(); return; }
    const subject = who === 'members' ? ALL_MEMBERS : who === 'group' ? `group:${group!.id}` : `user:${person}`;
    grant.mutate({ subject, relation, type: resource.type, id: resource.type === ORG_TYPE ? null : resource.id, expiresAt: noExpiry ? null : expiresAtOf(until) }, {
      onSuccess: entry => { toast.show(t('iam.access.grant.done', { org: orgName })); onGranted?.(entry); onClose(); },
    });
  };

  const whoOptions: [Who, string][] = [['user', t('iam.access.grant.who.user')], ...(groups ? [['group', t('iam.access.grant.who.group')] as [Who, string]] : []), ['members', t('iam.access.grant.who.members')]];
  return (
    <Dialog title={t('iam.access.grant.title', { label })} onClose={onClose} onSubmit={submit} width={560}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" icon="check" busy={grant.isPending}>{t('iam.access.grant.confirm')}</Button></>}>
      <p className="iam-muted iam-small">{t('iam.access.grant.intro', { org: orgName })}</p>
      <div className="iam-form iam-compact">
        <fieldset className="iam-fs iam-grant-who">
          <legend>{t('iam.access.grant.who')}</legend>
          <div className="iam-seg iam-seg-radio">
            {whoOptions.map(([k, l]) => {
              const blocked = k === 'group' && groupOff;
              return (
                <label key={k} className={`iam-seg-r${who === k ? ' iam-on' : ''}`}>
                  <input type="radio" name={`${fid}-who`} value={k} checked={who === k} onChange={() => { setWho(k); setErrs({ ...errs, who: undefined }); }}
                    aria-describedby={blocked ? `${fid}-goff` : undefined} />{l}
                </label>
              );
            })}
          </div>
          {who === 'user' ? <PersonPick id={`${fid}-who`} value={person} onChange={setPerson} invalid={!!errs.who} describedBy={errs.who ? `${fid}-who-e` : undefined} /> : null}
          {who === 'group' ? (groupOff
            ? <p id={`${fid}-goff`} className="iam-note" role="note">{groupOff}</p>
            : <GroupSearch id={`${fid}-who`} value={group} onChange={setGroup} invalid={!!errs.who} describedBy={errs.who ? `${fid}-who-e` : undefined} onUnavailable={setGroupOff} />) : null}
          {who === 'members' ? <p className="iam-muted iam-small">{t('iam.access.grant.who.membersHint', { org: orgName })}</p> : null}
          {errs.who ? <div id={`${fid}-who-e`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{errs.who}</div> : null}
        </fieldset>
        <label htmlFor={`${fid}-rel`}>{t('iam.access.grant.role')}</label>
        <select id={`${fid}-rel`} className="iam-inp" value={relation} onChange={e => { setRelation(e.target.value); setErrs({ ...errs, relation: undefined }); }}
          aria-invalid={errs.relation ? true : undefined} aria-describedby={`${fid}-rel-h${errs.relation ? ` ${fid}-rel-e` : ''}`}>
          <option value="">{t('iam.access.grant.roleChoose')}</option>
          {grantable.map(r => <option key={r} value={r}>{authz.relationLabel(r)}</option>)}
        </select>
        <div id={`${fid}-rel-h`} className="iam-muted iam-small">{role?.description ?? t('iam.access.grant.roleHint')}</div>
        {errs.relation ? <div id={`${fid}-rel-e`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{errs.relation}</div> : null}
        <ExpiryField id={`${fid}-until`} value={until} onChange={v => { setUntil(v); setErrs({ ...errs, until: undefined }); }} error={errs.until} locked={noExpiry} />
      </div>
      {grant.error ? <AccessError error={grant.error} /> : null}
    </Dialog>
  );
}
