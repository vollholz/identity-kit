/**
 * Verwalten › Rollen (Recht `roles:admin`): eigene Rollen der Organisation aus den Rechten der App zusammenstellen. Die
 * Rollen der App stehen als Vorgabe darüber und lassen sich nicht ändern. Eine eigene Rolle hat Name, Beschreibung,
 * Rechte (gruppiert wie im Katalog; Rechte nur von «Organisations-Admin» fehlen, Rechte, die ich nicht habe, sind
 * gesperrt mit Grund) und Orte, an denen sie vergeben werden darf. Vergeben wird sie wie jede Rolle unter «Mitglieder»
 * bzw. in der Seitenleiste «Zugriff» eines Orts. Löschen erst, wenn sie nirgends mehr vergeben ist.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { roleApi, useCustomRoles } from '../admin.ts';
import { useAuthz } from '../authz.ts';
import type { CatalogRole, CustomRole, CustomRoleInput } from '../contract.ts';
import { fmtDate } from '../format.ts';
import { iamKeys } from '../keys.ts';
import { ADMIN_ROLE, ORG_TYPE, type Permission } from '../permissions.ts';
import { AdminHead } from '../rights/AdminHead.tsx';
import { useIam } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { Confirm } from '../ui/Overlay.tsx';
import { Empty, ErrorBox, ErrorState, SkeletonRows } from '../ui/states.tsx';

export interface RolesPageProps {
  /** Organisation der Plattform-Administration (Alias); sonst die eigene. */
  alias?: string;
  platform?: boolean;
}

export function RolesPage({ alias, platform = false }: RolesPageProps = {}) {
  const { Button, Table } = useIamUi();
  const authz = useAuthz();
  const iam = useIam();
  useIamText();
  const a = alias ?? null;
  const q = useCustomRoles(a);
  const [editing, setEditing] = useState<CustomRole | 'new' | null>(null);
  const [removing, setRemoving] = useState<CustomRole | null>(null);
  const qc = useQueryClient();
  const changed = () => Promise.all([
    qc.invalidateQueries({ queryKey: iamKeys.customRoles(a) }), qc.invalidateQueries({ queryKey: ['iam', 'catalog'] }),
    qc.invalidateQueries({ queryKey: iamKeys.adminStatus }), qc.invalidateQueries({ queryKey: iamKeys.me }),
  ]);
  const remove = useMutation({ mutationFn: (r: CustomRole) => roleApi(a).remove(r.key), onSuccess: async () => { await changed(); setRemoving(null); } });
  const org = alias ?? iam.orgName;
  const builtIn = (authz.catalog?.roles ?? []).filter(r => !r.custom);
  const places = (keys: string[]) => keys.map(k => (k === ORG_TYPE ? t('iam.roles.place.org') : authz.typeLabel(k))).join(', ');
  return (
    <>
      <AdminHead icon="key" title={t('iam.roles.page.title')} sub={t('iam.roles.page.sub', { org })}
        actions={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>{t('iam.roles.page.create')}</Button>} />
      <div className="iam-body"><div className="iam-int">
        <h2 className="iam-h3">{t('iam.roles.page.own')}</h2>
        {q.isPending ? <SkeletonRows rows={3} cols={5} /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data.length ? (
          <Empty icon="key" title={t('iam.roles.page.none')} action={<Button variant="primary" onClick={() => setEditing('new')}>{t('iam.roles.page.create')}</Button>}>{t('iam.roles.page.noneText')}</Empty>
        ) : (
          <div className="iam-tblwrap">
            <Table stack>
              <caption className="iam-sr">{t('iam.roles.page.own')}</caption>
              <thead><tr>
                <th scope="col">{t('iam.roles.col.role')}</th><th scope="col">{t('iam.roles.col.rights')}</th><th scope="col">{t('iam.roles.col.places')}</th>
                <th scope="col">{t('iam.roles.col.assigned')}</th><th scope="col" className="iam-acts"><span className="iam-sr">{t('iam.access.col.actions')}</span></th>
              </tr></thead>
              <tbody>
                {q.data.map(r => (
                  <tr key={r.key}>
                    <td><span className="iam-b">{r.label}</span>{r.description ? <div className="iam-muted iam-small">{r.description}</div> : null}<div className="iam-mono-s iam-muted">{r.key}</div></td>
                    <td><span className="iam-st-lbl">{t('iam.roles.col.rights')}:</span>{r.permissions.map(p => authz.permLabel(p)).join(', ')}</td>
                    <td><span className="iam-st-lbl">{t('iam.roles.col.places')}:</span>{places(r.places)}</td>
                    <td><span className="iam-st-lbl">{t('iam.roles.col.assigned')}:</span>{r.assignments}</td>
                    <td className="iam-acts">
                      <Button size="sm" icon="edit" aria-label={t('iam.roles.editOf', { name: r.label })} onClick={() => setEditing(r)}>{t('iam.roles.edit')}</Button>{' '}
                      <Button size="sm" variant="ghost" icon="trash" aria-label={t('iam.roles.removeOf', { name: r.label })} aria-describedby={r.assignments ? `iam-role-${r.key}-why` : undefined}
                        disabled={r.assignments > 0} onClick={() => setRemoving(r)}>{t('iam.roles.remove')}</Button>
                      {r.assignments ? <div id={`iam-role-${r.key}-why`} className="iam-hint">{t('iam.roles.inUse', { n: r.assignments })}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        <h2 className="iam-h3">{t('iam.roles.page.builtIn')}</h2>
        <p className="iam-muted iam-small">{t('iam.roles.page.builtInText')}</p>
        <ul className="iam-role-list">
          {builtIn.map(r => <li key={r.key}><span className="iam-b">{r.label}</span> <span className="iam-muted iam-small">– {r.description}</span></li>)}
        </ul>
      </div></div>
      <div className="iam-cli iam-api"><span className="iam-cli-label">API</span><code tabIndex={0}>{a ? `GET /v1/platform/organizations/${a}/roles` : 'GET /v1/admin/roles · POST /v1/admin/roles · PUT/DELETE /v1/admin/roles/{key}'}</code></div>
      {editing ? <RoleDialog alias={a} platform={platform} role={editing === 'new' ? null : editing} builtIn={builtIn} onClose={() => setEditing(null)} onSaved={async () => { await changed(); setEditing(null); }} /> : null}
      {removing ? (
        <Confirm title={t('iam.roles.removeTitle', { name: removing.label })} confirm={t('iam.roles.removeConfirm')} danger busy={remove.isPending} onClose={() => { remove.reset(); setRemoving(null); }} onConfirm={() => remove.mutate(removing)}>
          <p>{t('iam.roles.removeText', { name: removing.label, org })}</p>
          {remove.error ? <ErrorBox error={remove.error} compact /> : null}
        </Confirm>
      ) : null}
    </>
  );
}

interface RoleDialogProps { alias: string | null; platform: boolean; role: CustomRole | null; builtIn: CatalogRole[]; onClose: () => void; onSaved: () => void | Promise<void> }

/** Rolle anlegen oder ändern: Name, Beschreibung, Rechte je Gruppe, Orte. Prüfung beim Absenden, Fokus aufs erste Feld. */
function RoleDialog({ alias, platform, role, onClose, onSaved }: RoleDialogProps) {
  const { Dialog, Button, Icon } = useIamUi();
  const authz = useAuthz();
  const iam = useIam();
  const fid = useId();
  const [d, setD] = useState({ label: role?.label ?? '', description: role?.description ?? '', permissions: new Set<string>(role?.permissions ?? []), places: new Set<string>(role?.places ?? [ORG_TYPE]) });
  const [tried, setTried] = useState(false);
  const cat = authz.catalog;
  // Rechte nur von org-admin gibt es in eigenen Rollen nicht; niemand gibt mehr, als er hat (ausser Plattform)
  const usable = (cat?.permissions ?? []).filter(p => !p.adminOnly);
  const mine = (p: string) => platform || iam.can(p as Permission);
  const labelErr = tried && !d.label.trim() ? t('iam.roles.labelMissing') : null;
  const permErr = tried && !d.permissions.size ? t('iam.roles.rightsMissing') : null;
  const placeErr = tried && !d.places.size ? t('iam.roles.placesMissing') : null;
  const save = useMutation({
    mutationFn: () => {
      const body = { label: d.label.trim(), description: d.description.trim(), permissions: [...d.permissions] as Permission[], places: [...d.places] };
      return role ? roleApi(alias).update(role.key, body) : roleApi(alias).create(body satisfies CustomRoleInput);
    },
    onSuccess: () => onSaved(),
  });
  const toggle = (set: Set<string>, k: string, on: boolean) => { const n = new Set(set); if (on) n.add(k); else n.delete(k); return n; };
  const submit = () => {
    setTried(true);
    const first = !d.label.trim() ? `${fid}-l` : !d.permissions.size ? `${fid}-p` : !d.places.size ? `${fid}-o` : null;
    if (first) { document.getElementById(first)?.focus(); return; }
    save.mutate();
  };
  const groups = (cat?.groups ?? []).map(g => ({ ...g, perms: usable.filter(p => p.group === g.key) })).filter(g => g.perms.length);
  const err = (id: string, text: string | null) => (text ? <div id={id} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{text}</div> : null);
  return (
    <Dialog title={role ? t('iam.roles.editTitle', { name: role.label }) : t('iam.roles.page.create')} onClose={onClose} onSubmit={submit} width={680}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" busy={save.isPending}>{t('iam.common.save')}</Button></>}>
      <div className="iam-form iam-compact">
        <label htmlFor={`${fid}-l`}>{t('iam.roles.label')}</label>
        <input id={`${fid}-l`} className="iam-inp" value={d.label} maxLength={80} data-autofocus required autoComplete="off" aria-invalid={labelErr ? true : undefined} aria-describedby={labelErr ? `${fid}-l-e` : undefined}
          onChange={e => setD({ ...d, label: e.target.value })} />
        {err(`${fid}-l-e`, labelErr)}
        <label htmlFor={`${fid}-b`}>{t('iam.roles.description')}</label>
        <textarea id={`${fid}-b`} className="iam-inp" rows={2} maxLength={500} value={d.description} onChange={e => setD({ ...d, description: e.target.value })} />
      </div>
      <fieldset className="iam-fs" aria-describedby={permErr ? `${fid}-p-e` : `${fid}-p-h`}>
        <legend>{t('iam.roles.rights')}</legend>
        <div id={`${fid}-p-h`} className="iam-hint">{t('iam.roles.rightsHint', { admin: authz.roleLabel(ADMIN_ROLE) })}</div>
        {groups.map((g, gi) => (
          <div key={g.key} className="iam-perm-group">
            <div className="iam-b iam-small">{g.label}</div>
            {g.perms.map((p, pi) => {
              const id = gi === 0 && pi === 0 ? `${fid}-p` : `${fid}-p-${p.key}`;
              const blocked = !mine(p.key) && !d.permissions.has(p.key);
              return (
                <label key={p.key} className="iam-chk" htmlFor={id} title={blocked ? t('iam.roles.notMine') : undefined}>
                  <input id={id} type="checkbox" checked={d.permissions.has(p.key)} disabled={blocked} aria-describedby={blocked ? `${id}-why` : undefined}
                    onChange={e => setD({ ...d, permissions: toggle(d.permissions, p.key, e.target.checked) })} />
                  {' '}{p.label} <span className="iam-muted iam-small">– {p.description}</span>
                  {blocked ? <span id={`${id}-why`} className="iam-muted iam-small"> ({t('iam.roles.notMine')})</span> : null}
                </label>
              );
            })}
          </div>
        ))}
        {err(`${fid}-p-e`, permErr)}
      </fieldset>
      <fieldset className="iam-fs" aria-describedby={placeErr ? `${fid}-o-e` : `${fid}-o-h`}>
        <legend>{t('iam.roles.places')}</legend>
        <div id={`${fid}-o-h`} className="iam-hint">{t('iam.roles.placesHint')}</div>
        {(cat?.types ?? []).map((ty, i) => {
          const id = i === 0 ? `${fid}-o` : `${fid}-o-${ty.key}`;
          return (
            <label key={ty.key} className="iam-chk" htmlFor={id}>
              <input id={id} type="checkbox" checked={d.places.has(ty.key)} onChange={e => setD({ ...d, places: toggle(d.places, ty.key, e.target.checked) })} />
              {' '}{ty.key === ORG_TYPE ? t('iam.roles.place.org') : ty.label}
            </label>
          );
        })}
        {err(`${fid}-o-e`, placeErr)}
      </fieldset>
      {role ? <p className="iam-note">{t('iam.roles.changeNote', { n: role.assignments, date: fmtDate(role.updatedAt) })}</p> : null}
      {save.error ? <ErrorBox error={save.error} /> : null}
    </Dialog>
  );
}
