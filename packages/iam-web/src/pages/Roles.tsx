/**
 * Verwalten › Zugang › Rollen (Spezifikation 8.3): vordefinierte Rollen (nur ansehen) und eigene Rollen der Organisation
 * (erstellen, bearbeiten, kopieren, löschen). Vergeben werden beide unter Zugang › Mitglieder. Herkunft: vollholz/assets
 * `web/src/features/admin/Roles.tsx`.
 *
 * Je Rolle eine Zeile mit Symbol, Name, Kurzbeschreibung, Anzahl Rechte und Personen; «Rechte» klappt die
 * Rechte-Übersicht der Rolle auf. Menü «Mehr»: vordefinierte als Vorlage für eine eigene Rolle, eigene bearbeiten,
 * kopieren, löschen. Darunter «Rollen vergleichen» mit allen Rollen. Eigene Rollen enthalten keine Rechte, die nur
 * org-admin hat (`customPermissions` aus GET /v1/roles); im Dialog stehen sie gesperrt mit Grund. Rechte, Gruppen und
 * Labels kommen aus dem Katalog (useAuthz), nie aus eigenen Listen.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { roleApi } from '../admin.ts';
import { useAuthz, useRoles } from '../authz.ts';
import { useIamConfig } from '../config.tsx';
import type { Role, RoleList } from '../contract.ts';
import { iamKeys } from '../keys.ts';
import { ApiError } from '../problem.ts';
import { ADMIN_ROLE } from '../permissions.ts';
import { AdminHead } from '../rights/AdminHead.tsx';
import { RightsOverview, roleSummary } from '../rights/RightsOverview.tsx';
import { RoleCompare } from '../rights/RoleMatrix.tsx';
import { useIam } from '../session.tsx';
import { t, tn } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import type { IamIconName } from '../ui/icons.ts';
import { MenuItem } from '../ui/MenuButton.tsx';
import { Confirm } from '../ui/Overlay.tsx';
import { Empty, ErrorBox, ErrorState, SkeletonRows } from '../ui/states.tsx';

/** Dialog: neue Rolle (optional mit Vorlage) oder bestehende eigene Rolle bearbeiten. */
type Editing = { role: Role | null; from: Role | null };

/** Seite «Rollen» (Recht `members:admin` prüft der Guard der Route). */
export function RolesPage() {
  const { orgName: org } = useIam();
  const { Button, toast } = useIamUi();
  useIamText();
  const q = useRoles();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const items = q.data?.items ?? [];
  const builtin = items.filter(r => !r.custom), custom = items.filter(r => r.custom);
  const full = !!q.data && custom.length >= q.data.maxCustom;
  // Rechte der Rollen wirken sofort (8.3): Rollen, Status, Mitgliederlisten und /auth/me (eigene Rechte) neu laden
  const refresh = () => Promise.all([iamKeys.roles, iamKeys.adminStatus, ['iam', 'admin', 'members'], iamKeys.me].map(queryKey => qc.invalidateQueries({ queryKey })));
  // 412: inzwischen geändert – Liste mit der aktuellen Version neu laden, der nächste Versuch nimmt sie
  const onStale = (e: unknown) => { if (e instanceof ApiError && e.status === 412) void qc.invalidateQueries({ queryKey: iamKeys.roles }); };
  const remove = useMutation({
    mutationFn: (r: Role) => roleApi.remove(items.find(x => x.key === r.key) ?? r),
    onError: onStale,
    onSuccess: async (_r, role) => { setDeleting(null); await refresh(); toast.show(t('iam.rolesPage.deleted', { role: role.label, org })); },
  });
  const create = (from: Role | null = null) => setEditing({ role: null, from });
  /** Grund, warum keine weitere eigene Rolle entstehen kann (Erstellen, Kopieren, Vorlage). */
  const fullWhy = full ? t('iam.rolesPage.full', { n: q.data!.maxCustom }) : null;
  const createButton = (variant: 'primary' | 'default' = 'primary') => (
    <Button variant={variant} icon="plus" onClick={() => create()} disabled={full} title={full ? t('iam.rolesPage.full', { n: q.data!.maxCustom }) : undefined}>{t('iam.rolesPage.create')}</Button>
  );
  const fid = useId();
  return (
    <>
      <AdminHead icon="tag" title={t('iam.rolesPage.title')} sub={t('iam.rolesPage.sub', { org })} actions={q.data ? createButton() : null} />
      <div className="iam-body"><div className="iam-int">
        {q.isPending ? <SkeletonRows rows={6} cols={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <>
            <section aria-labelledby={`${fid}-b`} className="iam-roles-sec">
              <div className="iam-sec-h"><h2 id={`${fid}-b`}>{t('iam.rolesPage.builtin')}</h2><span>{builtin.length}</span></div>
              <p className="iam-muted iam-small iam-roles-intro">{t('iam.rolesPage.builtinIntro')}</p>
              <ul className="iam-role-list">
                {builtin.map(r => <RoleRow key={r.key} role={r} full={fullWhy} onTemplate={() => create(r)} />)}
              </ul>
            </section>
            <section aria-labelledby={`${fid}-c`} className="iam-roles-sec">
              <div className="iam-sec-h iam-wrap"><h2 id={`${fid}-c`}>{t('iam.rolesPage.custom')}</h2><span>{custom.length ? t('iam.rolesPage.customCount', { n: custom.length, m: q.data.maxCustom }) : ''}</span></div>
              <p className="iam-muted iam-small iam-roles-intro">{t('iam.rolesPage.customIntro', { org })}</p>
              {custom.length ? (
                <ul className="iam-role-list">
                  {custom.map(r => <RoleRow key={r.key} role={r} full={fullWhy} onEdit={() => setEditing({ role: r, from: null })} onTemplate={() => create(r)} onDelete={() => setDeleting(r)} />)}
                </ul>
              ) : (
                <div className="iam-role-empty">
                  <Empty icon="tag" title={t('iam.rolesPage.noCustom')} action={createButton('default')}>{t('iam.rolesPage.noCustomText')}</Empty>
                </div>
              )}
            </section>
            <RoleCompare roles={items} caption={t('iam.matrix.caption')} />
          </>
        )}
      </div></div>
      <div className="iam-cli iam-api"><span className="iam-cli-label">API</span><code tabIndex={0}>GET /v1/roles · POST /v1/roles · PATCH /v1/roles/&#123;key&#125; · DELETE /v1/roles/&#123;key&#125;</code></div>
      {editing && q.data ? (
        <RoleDialog list={q.data} editing={editing} orgLabel={org} onStale={onStale} onClose={() => setEditing(null)}
          onDone={async (r, created) => { setEditing(null); await refresh(); toast.show(created ? t('iam.rolesPage.created', { role: r.label, org }) : t('iam.rolesPage.saved', { role: r.label })); }} />
      ) : null}
      {deleting ? (
        <Confirm title={t('iam.rolesPage.delete.title', { role: deleting.label })} confirm={t('iam.rolesPage.delete.confirm')} danger busy={remove.isPending} onClose={() => { remove.reset(); setDeleting(null); }} onConfirm={() => remove.mutate(deleting)}>
          <p>{deleting.memberCount === null ? t('iam.rolesPage.delete.unknown') : deleting.memberCount ? tn('iam.rolesPage.delete.people', deleting.memberCount, { org }) : t('iam.rolesPage.delete.nobody')}</p>
          <p className="iam-muted iam-small">{t('iam.rolesPage.delete.final')}</p>
          {remove.error ? <ErrorBox error={remove.error} compact /> : null}
        </Confirm>
      ) : null}
    </>
  );
}

/** Zeile einer Rolle: Symbol, Name, Kurzbeschreibung, Zahlen, «Rechte» zum Aufklappen und Menü «Mehr». */
function RoleRow({ role: r, full, onEdit, onTemplate, onDelete }: { role: Role; full: string | null; onEdit?: () => void; onTemplate: () => void; onDelete?: () => void }) {
  const { Button, Icon, Menu } = useIamUi();
  const { roleIcons } = useIamConfig();
  const [open, setOpen] = useState(false);
  const id = useId();
  const admin = r.key === ADMIN_ROLE;
  const summary = r.custom ? r.description : roleSummary(r.description);
  const icon = (roleIcons?.[r.key] ?? (admin ? 'shield' : 'tag')) as IamIconName;
  return (
    <li className="iam-role-row">
      <div className="iam-role-main">
        <div className={`iam-type-ico ${admin ? 'iam-accent' : 'iam-neutral'}`} aria-hidden="true"><Icon name={icon} className="iam-ico" /></div>
        <div className="iam-role-text">
          <h3 className="iam-role-name">{r.label}{admin ? <span className="iam-rp-mark iam-locked">{t('iam.rolesPage.adminMark')}</span> : null}</h3>
          <p className="iam-role-desc">{summary || <span className="iam-muted">{t('iam.rolesPage.noDescription')}</span>}</p>
          <p className="iam-role-meta iam-muted iam-small">
            {admin ? t('iam.rolesPage.allRights') : tn('iam.rolesPage.rights', r.permissions.length)}
            {r.memberCount !== null ? <> · {tn('iam.members.people', r.memberCount)}</> : null}
            {r.custom ? <> · <span className="iam-mono-s" title={t('iam.rolesPage.keyHint')}>{r.key}</span></> : null}
          </p>
        </div>
        <div className="iam-row-acts">
          <Button size="sm" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={t('iam.rolesPage.rightsOf', { role: r.label })} onClick={() => setOpen(o => !o)}>
            <Icon name="chev" className={`iam-ico${open ? ' iam-rot90' : ''}`} />{t('iam.members.rights')}
          </Button>
          <Menu label={t('iam.members.actions', { name: r.label })} buttonLabel={t('iam.members.more', { name: r.label })} title={t('iam.common.more')} className="iam-iconbtn iam-sm" fixed button={<Icon name="more" className="iam-ico" />}>
            {close => (
              <>
                {onEdit ? <MenuItem icon="edit" label={t('iam.rolesPage.edit')} onPick={() => { close(); onEdit(); }} /> : null}
                <MenuItem icon="copy" label={t(r.custom ? 'iam.rolesPage.copy' : 'iam.rolesPage.template')} why={full} onPick={() => { close(); onTemplate(); }} />
                {onDelete ? <MenuItem icon="trash" label={t('iam.rolesPage.deleteItem')} danger onPick={() => { close(); onDelete(); }} /> : null}
              </>
            )}
          </Menu>
        </div>
      </div>
      {open ? (
        <div id={id} className="iam-role-rights-open">
          {!r.custom && r.description !== summary ? <p className="iam-small">{r.description}</p> : null}
          <RightsOverview roles={[r.key]} headingLevel={4} />
        </div>
      ) : null}
    </li>
  );
}

/** Erstellen (leer oder mit Vorlage) und Bearbeiten einer eigenen Rolle. */
function RoleDialog({ list, editing, orgLabel, onStale, onClose, onDone }: { list: RoleList; editing: Editing; orgLabel: string; onStale: (e: unknown) => void; onClose: () => void; onDone: (r: Role, created: boolean) => Promise<void> }) {
  const { Dialog, Button, Icon } = useIamUi();
  const fid = useId();
  const authz = useAuthz();
  const allowed = useMemo(() => new Set<string>(list.customPermissions), [list.customPermissions]);
  const { role, from } = editing;
  const start = role ?? from;
  const [label, setLabel] = useState(role ? role.label : from ? t('iam.rolesPage.copyName', { role: from.label }) : '');
  const [description, setDescription] = useState(role?.description ?? (from?.custom ? from.description : ''));
  const [perms, setPerms] = useState<ReadonlySet<string>>(() => new Set((start?.permissions ?? ['tenant:read']).filter(p => allowed.has(p))));
  const [err, setErr] = useState<{ label?: string; perms?: string }>({});
  // Rechte, die eine eigene Rolle nicht (mehr) enthalten darf: aus der Vorlage oder beim Bearbeiten aus der Rolle selbst
  const dropped = (start?.permissions ?? []).filter(p => !allowed.has(p));
  const save = useMutation({
    mutationFn: () => {
      // Reihenfolge des Katalogs, unabhängig von der Reihenfolge des Anklickens
      const permissions = (authz.catalog?.permissions ?? []).map(p => p.key).filter(k => perms.has(k));
      const body = { label: label.trim(), description: description.trim(), permissions };
      // aktuelle Version aus der Liste (nach einem 412 neu geladen), sonst die beim Öffnen
      return role ? roleApi.update(list.items.find(r => r.key === role.key) ?? role, body) : roleApi.create(body);
    },
    onSuccess: r => onDone(r, !role),
    onError: onStale,
  });
  const toggle = (k: string) => setPerms(s => { const x = new Set(s); if (!x.delete(k)) x.add(k); return x; });
  const takeOver = (key: string) => {
    const base = list.items.find(r => r.key === key);
    if (base) setPerms(new Set(base.permissions.filter(p => allowed.has(p))));
  };
  const submit = () => {
    const e: typeof err = {};
    if (!label.trim()) e.label = t('iam.rolesPage.needName');
    if (!perms.size) e.perms = t('iam.rolesPage.needRight');
    setErr(e);
    if (e.label) { document.getElementById(`${fid}-l`)?.focus(); return; }
    if (e.perms) { document.getElementById(`${fid}-p`)?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus(); return; }
    save.mutate();
  };
  const groups = (authz.catalog?.groups ?? []).map(g => ({ ...g, perms: authz.catalog!.permissions.filter(p => p.group === g.key) })).filter(g => g.perms.length);
  const adminLabel = authz.roleLabel(ADMIN_ROLE);
  return (
    <Dialog title={role ? t('iam.rolesPage.editTitle', { role: role.label }) : t('iam.rolesPage.createTitle', { org: orgLabel })} onClose={onClose} onSubmit={submit} width={720}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" icon="check" busy={save.isPending}>{role ? t('iam.common.save') : t('iam.rolesPage.create')}</Button></>}>
      {role && role.memberCount ? <p className="iam-note iam-small">{tn('iam.rolesPage.inUse', role.memberCount)}</p> : null}
      <div className="iam-form iam-compact">
        <label htmlFor={`${fid}-l`}>{t('iam.rolesPage.name')}</label>
        <input id={`${fid}-l`} className="iam-inp" value={label} maxLength={60} onChange={e => setLabel(e.target.value)} required autoComplete="off" data-autofocus
          aria-invalid={err.label ? true : undefined} aria-describedby={err.label ? `${fid}-le` : undefined} />
        {err.label ? <div id={`${fid}-le`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{err.label}</div> : null}
        <label htmlFor={`${fid}-d`}>{t('iam.rolesPage.description')}</label>
        <textarea id={`${fid}-d`} className="iam-inp" rows={2} value={description} maxLength={500} onChange={e => setDescription(e.target.value)} placeholder={t('iam.rolesPage.descriptionHint')} />
        <label htmlFor={`${fid}-t`}>{t('iam.rolesPage.takeOver')}</label>
        <select id={`${fid}-t`} className="iam-inp" value="" onChange={e => takeOver(e.target.value)} aria-describedby={`${fid}-th`}>
          <option value="">{t('iam.rolesPage.pickRole')}</option>
          {list.items.filter(r => r.key !== role?.key).map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <div id={`${fid}-th`} className="iam-hint iam-muted iam-small">{t('iam.rolesPage.takeOverHint')}</div>
      </div>
      {dropped.length ? (
        <p className="iam-note iam-small"><Icon name="warn" className="iam-ico" />{t('iam.rolesPage.dropped', { role: adminLabel, perms: dropped.map(p => authz.permLabel(p)).join(', ') })}</p>
      ) : null}
      <fieldset id={`${fid}-p`} className="iam-perm-pick" aria-describedby={err.perms ? `${fid}-pe` : undefined}>
        <legend>{t('iam.members.rights')} <span className="iam-muted iam-small">{t('iam.rolesPage.picked', { n: perms.size })}</span></legend>
        {err.perms ? <div id={`${fid}-pe`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{err.perms}</div> : null}
        {groups.map(g => (
          <div key={g.key} className="iam-role-group" role="group" aria-labelledby={`${fid}-g-${g.key}`}>
            <div id={`${fid}-g-${g.key}`} className="iam-role-group-h">{g.label}</div>
            <ul className="iam-rp-list">
              {g.perms.map(p => {
                const ok = allowed.has(p.key), on = perms.has(p.key);
                const cid = `${fid}-c-${p.key}`;
                return (
                  <li key={p.key} className={`iam-rp-r${on ? ' iam-is-on' : ''}${ok ? '' : ' iam-is-locked'}`}>
                    <input id={cid} type="checkbox" className="iam-rp-ctl" checked={on} disabled={!ok} onChange={() => toggle(p.key)} aria-describedby={`${cid}-s`} />
                    <div className="iam-rp-t">
                      <label htmlFor={cid} className="iam-rp-l">{p.label}</label>
                      <span id={`${cid}-s`} className="iam-rp-s">{p.description}</span>
                    </div>
                    {ok ? <span /> : <span className="iam-rp-mark iam-locked" title={t('iam.rolesPage.adminOnlyHint', { role: adminLabel })}>{t('iam.rolesPage.onlyRole', { role: adminLabel })}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </fieldset>
      {save.error ? <ErrorBox error={save.error} /> : null}
    </Dialog>
  );
}
