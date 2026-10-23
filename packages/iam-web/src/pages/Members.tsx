/**
 * Verwalten › Zugang › Mitglieder (Spezifikation 9.2): Personen der eigenen Organisation einladen, Rollen zuweisen und
 * entziehen, entfernen. Die Rollen selbst stehen unter Zugang › Rollen (Roles.tsx). Dieselbe Liste nutzt die
 * Plattform-Administration für eine beliebige Organisation (`alias`). Herkunft: vollholz/assets
 * `web/src/features/admin/Members.tsx`; das Hinzufügen aus Microsoft Entra ID folgt mit der Seite «Anmeldung».
 *
 * - Je Zeile höchstens «Rollen» (bei Organisations-Admins «Ansehen») und das Menü «Mehr», damit alle Zeilen gleich hoch
 *   bleiben. Was die API ablehnen würde, steht gesperrt mit Grund im Menü, statt zu fehlen oder erst beim Bestätigen zu
 *   scheitern. Dialoge, Rückfragen und Meldungen nennen die Organisation.
 * - Rollendialog: Ansehen ohne Formular (Rollen als Karten, Rechte-Übersicht) bei Organisations-Admins aus Sicht der
 *   Organisation oder wenn die Rollen nicht änderbar sind; Bearbeiten und Einladen mit kompakter Rollenauswahl,
 *   Enthaltensein aus den Rechten (roles.ts) als Markierung, darunter die Rechte-Übersicht mit der Änderung gegenüber bisher.
 * - Liste filterbar nach Name/E-Mail, Rolle und Recht («Wer hat Recht X?», nur aus den Rollen), sortierbar nach Person und
 *   «Zuletzt aktiv»; darunter aufklappbar die Rollenmatrix. Filter und Sortierung nur im Zustand der Komponente.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { memberApi, useAdminStatus, useMembers } from '../admin.ts';
import { useAuthz } from '../authz.ts';
import type { InviteInput, InviteResult, Member, RoleInfo } from '../contract.ts';
import { useIamConfig } from '../config.tsx';
import { fmtDateTime, relTime } from '../format.ts';
import { iamKeys } from '../keys.ts';
import { ADMIN_ROLE as ADMIN, isCustomRole, type Permission } from '../permissions.ts';
import { AdminHead } from '../rights/AdminHead.tsx';
import { RightsOverview, roleSummary } from '../rights/RightsOverview.tsx';
import { RoleCompare, RoleMatrix } from '../rights/RoleMatrix.tsx';
import { containers, includedIn } from '../roles.ts';
import { useIam } from '../session.tsx';
import { listAnd, t, tn } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { MenuItem } from '../ui/MenuButton.tsx';
import { Confirm } from '../ui/Overlay.tsx';
import { Empty, ErrorBox, ErrorState, Loading, SkeletonRows } from '../ui/states.tsx';

/** Status im Verzeichnis: `disabled` heisst dort «deaktiviert» («gesperrt» ist die Sperre einer Organisation). */
const STATUS = {
  active: ['iam.members.status.active', 'iam-st-ok', 'iam.members.status.activeWhy'],
  invited: ['iam.members.status.invited', 'iam-st-warn', 'iam.members.status.invitedWhy'],
  disabled: ['iam.members.status.disabled', 'iam-st-bad', 'iam.members.status.disabledWhy'],
} as const;

/** Link zum Weitergeben (Anmeldung über Microsoft für Personen aus Entra ID, die sich noch nie angemeldet haben). */
const absolute = (path: string) => `${window.location.origin}${path}`;

/** Alle Mitgliederlisten (eigene Organisation und Plattformansicht), für die Invalidierung nach Änderungen. */
const MEMBER_LISTS = ['iam', 'admin', 'members'] as const;

/**
 * Würde Entfernen oder der Entzug von org-admin die letzte aktive Person mit org-admin treffen (409 des Servers)? Aktiv
 * zählt wie auf dem Server; ein deaktiviertes Konto mit org-admin ohne weitere aktive Admin-Person bleibt ebenfalls.
 */
const lastAdmin = (m: Member, activeAdmins: number) =>
  m.roles.includes(ADMIN) && (m.status === 'active' ? activeAdmins <= 1 : m.status === 'disabled' && activeAdmins === 0);

type SortKey = 'name' | 'seen';
/** «Zuletzt aktiv»: noch nie aktiv gilt als ältester Wert. */
const seen = (m: Member) => (m.lastSeenAt ? Date.parse(m.lastSeenAt) : 0);
const roleNames = (keys: readonly string[], roles: readonly RoleInfo[]) => keys.map(k => roles.find(r => r.key === k)?.label ?? k);

/** Seite «Mitglieder» der eigenen Organisation (Recht `members:admin` prüft der Guard der Route). */
export function MembersPage() {
  const { me, orgName: org } = useIam();
  const { groupRolePrefix = '/orgs' } = useIamConfig();
  const { Button } = useIamUi();
  useIamText();
  const status = useAdminStatus();
  const [inviting, setInviting] = useState(false);
  return (
    <>
      <AdminHead icon="users" title={t('iam.members.title')} sub={t('iam.members.sub', { org })}
        actions={status.data?.enabled ? <Button variant="primary" icon="plus" onClick={() => setInviting(true)}>{t('iam.members.invite')}</Button> : null} />
      <div className="iam-body"><div className="iam-int">
        {status.isPending ? <SkeletonRows rows={4} /> : status.error ? <ErrorState error={status.error} onRetry={() => void status.refetch()} /> : !status.data.enabled ? (
          <Empty icon="cog" title={t('iam.members.off.title')}>
            <p>{status.data.reason}</p>
            <p className="iam-muted iam-small">{t('iam.members.off.text')}</p>
            <details className="iam-more"><summary>{t('iam.members.off.details')}</summary><p className="iam-muted iam-small">{t('iam.members.off.groups')} <code>{groupRolePrefix.replace(/\/+$/, '')}/{me.tenant?.alias}/&lt;{t('iam.members.off.role')}&gt;</code>.</p></details>
          </Empty>
        ) : <MemberList alias={null} roles={status.data.roles} platform={false} rolesManageable={status.data.rolesManageable} self={me.person.subject} orgLabel={org} inviting={inviting} onInviting={setInviting} />}
      </div></div>
      <div className="iam-cli iam-api"><span className="iam-cli-label">API</span><code>GET /v1/admin/members · POST /v1/admin/members · PUT /v1/admin/members/&#123;id&#125;/roles</code></div>
    </>
  );
}

export interface MemberListProps {
  /** Organisation der Plattform-Administration; `null` = die eigene. */
  alias: string | null;
  roles: RoleInfo[];
  /** Ansicht der Plattform-Administration: darf org-admin vergeben und entziehen. */
  platform: boolean;
  rolesManageable: boolean;
  /** Subject der angemeldeten Person (Markierung «du», nicht sich selbst entfernen). */
  self?: string;
  /** Name der Organisation, deren Mitglieder die Liste zeigt (eigene oder in der Plattformansicht die bearbeitete). */
  orgLabel: string;
  /**
   * Einladen von aussen gesteuert (Hauptaktion im Seitenkopf). Ohne steht «Person einladen» im Kopf des Abschnitts
   * (Plattformansicht: Seitenkopf gehört zur Organisation).
   */
  inviting?: boolean;
  onInviting?: (v: boolean) => void;
}

/** Tabelle der Mitglieder mit Einladen, Rollen und Entfernen (eigene Organisation oder per Plattform). */
export function MemberList({ alias, roles, platform, rolesManageable, self, orgLabel, inviting: invitingOuter, onInviting }: MemberListProps) {
  const q = useMembers(alias);
  const { Button, Icon, Menu, Table, toast } = useIamUi();
  const { locale } = useIamText();
  const [filter, setFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [permFilter, setPermFilter] = useState('');
  // Ohne Wahl: Reihenfolge der API
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean } | null>(null);
  const authz = useAuthz();
  const [invitingOwn, setInvitingOwn] = useState(false);
  const inviting = onInviting ? !!invitingOuter : invitingOwn;
  const setInviting = onInviting ?? setInvitingOwn;
  const [editing, setEditing] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const qc = useQueryClient();
  const fid = useId();
  const label = useMemo(() => Object.fromEntries(roles.map(r => [r.key, r.label])), [roles]);
  const adminLabel = label[ADMIN] ?? ADMIN;
  const api = memberApi(alias);
  // Rechte wirken sofort (8.3), auch für die eigene Person: Mitgliederlisten (eigene und Plattformansicht) und /auth/me neu laden
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: MEMBER_LISTS }), qc.invalidateQueries({ queryKey: iamKeys.me })]);
  const copyLink = (m: Member) => { void navigator.clipboard?.writeText(absolute(m.loginPath!)).then(() => toast.show(t('iam.members.linkCopied', { name: m.name })), () => undefined); };

  const resend = useMutation({
    mutationFn: (m: Member) => api.resend(m.id),
    // ohne Versand (kein E-Mail-Versand im Realm) nicht «gesendet» melden
    onSuccess: (r, m) => (r.emailSent
      ? toast.show(t('iam.members.resent', { org: orgLabel, who: m.email ?? m.name }))
      : toast.show(t('iam.members.resentNoMail', { who: m.email ?? m.name }), { tone: 'error' })),
    onError: e => toast.error(e, t('iam.members.resendFailed')),
  });
  const remove = useMutation({
    mutationFn: (m: Member) => api.remove(m.id),
    onSuccess: async (r, m) => {
      setRemoving(null);
      await refresh();
      toast.show(m.status === 'invited'
        ? t(r.accountDeleted ? 'iam.members.withdrawnDeleted' : 'iam.members.withdrawn', { name: m.name, org: orgLabel })
        : t('iam.members.removed', { name: m.name, org: orgLabel }));
    },
  });

  const needle = filter.trim().toLowerCase();
  const all = q.data ?? [];
  // Rollen mit dem gewählten Recht (Rechte je Rolle aus /v1/admin/status); Zugriffsregeln zählen hier nicht
  const permRoles = useMemo(() => new Set(roles.filter(r => r.permissions.includes(permFilter)).map(r => r.key)), [roles, permFilter]);
  const filtered = all.filter(m => (!needle || m.name.toLowerCase().includes(needle) || (m.email ?? '').toLowerCase().includes(needle))
    && (!roleFilter || m.roles.includes(roleFilter))
    && (!permFilter || m.roles.some(r => permRoles.has(r))));
  const rows = sort ? [...filtered].sort((a, b) => (sort.asc ? 1 : -1) * (sort.key === 'name' ? a.name.localeCompare(b.name, locale) : seen(a) - seen(b))) : filtered;
  const filtering = !!(needle || roleFilter || permFilter);
  const resetFilters = () => { setFilter(''); setRoleFilter(''); setPermFilter(''); };
  const permGroups = (authz.catalog?.groups ?? []).map(g => ({ ...g, perms: authz.catalog!.permissions.filter(p => p.group === g.key) })).filter(g => g.perms.length);
  /** Spaltenkopf zum Sortieren: erster Klick auf «Person» aufsteigend, auf «Zuletzt aktiv» neueste zuerst, dann umkehren. */
  const sortTh = (key: SortKey, text: string, className?: string) => {
    const on = sort?.key === key;
    return (
      <th scope="col" className={[className, on ? 'iam-sorted' : ''].filter(Boolean).join(' ') || undefined} aria-sort={on ? (sort.asc ? 'ascending' : 'descending') : 'none'}>
        <button type="button" onClick={() => setSort(on ? { key, asc: !sort.asc } : { key, asc: key === 'name' })}>{text}{on ? <Icon name={sort.asc ? 'up' : 'down'} className="iam-ico" /> : null}</button>
      </th>
    );
  };
  // wie der Server (letzte Person mit org-admin): nur aktive Konten, keine offenen Einladungen und keine deaktivierten
  const admins = all.filter(m => m.roles.includes(ADMIN) && m.status === 'active').length;
  const invited = all.filter(m => m.status === 'invited').length;
  /** Warum die API Entfernen bzw. Zurückziehen ablehnen würde (403/409), sonst null. */
  const removeBlock = (m: Member): string | null => {
    if (!platform && m.id === self) return t('iam.members.block.self');
    if (!platform && m.roles.includes(ADMIN)) return m.status === 'invited' ? t('iam.members.block.adminInvite', { role: adminLabel }) : t('iam.members.block.admin', { role: adminLabel });
    if (lastAdmin(m, admins)) return t('iam.members.block.last', { role: adminLabel });
    return null;
  };
  const addLabel = t('iam.members.invite');

  return (
    <section aria-labelledby={`${fid}-h`}>
      <div className="iam-sec-h iam-wrap"><h2 id={`${fid}-h`}>{t('iam.members.title')}</h2><span>{q.data ? `${tn('iam.members.people', all.length)}${invited ? t('iam.members.ofInvited', { n: invited }) : ''}` : ''}</span>
        {onInviting ? null : <><span className="iam-spacer" /><Button variant="primary" icon="plus" onClick={() => setInviting(true)}>{addLabel}</Button></>}</div>
      <div className="iam-toolbar iam-inline iam-member-filters">
        <label className="iam-search iam-member-filter"><Icon name="search" className="iam-ico" /><span className="iam-sr">{t('iam.members.filter')}</span>
          <input type="search" placeholder={t('iam.members.filterHint')} value={filter} onChange={e => setFilter(e.target.value)} autoComplete="off" /></label>
        <label className="iam-sel"><span>{t('iam.members.byRole')}</span><select className="iam-inp" value={roleFilter} onChange={e => setRoleFilter(e.target.value)}>
          <option value="">{t('iam.members.any')}</option>
          {roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
        <label className="iam-sel"><span>{t('iam.members.byRight')}</span><select className="iam-inp" value={permFilter} onChange={e => setPermFilter(e.target.value)}>
          <option value="">{t('iam.members.any')}</option>
          {permGroups.map(g => <optgroup key={g.key} label={g.label}>{g.perms.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</optgroup>)}</select></label>
        {/* Gestapelte Ansicht (schmal) ohne Tabellenkopf: Sortierung als Auswahl, sonst über die Spaltenköpfe */}
        <label className="iam-sel iam-member-sort"><span>{t('iam.members.sort')}</span><select className="iam-inp" value={sort ? `${sort.key}-${sort.asc ? 'asc' : 'desc'}` : ''} onChange={e => { const [key, dir] = e.target.value.split('-'); setSort(key ? { key: key as SortKey, asc: dir === 'asc' } : null); }}>
          <option value="">{t('iam.members.sort.api')}</option>
          <option value="name-asc">{t('iam.members.sort.nameAsc')}</option>
          <option value="name-desc">{t('iam.members.sort.nameDesc')}</option>
          <option value="seen-desc">{t('iam.members.sort.seenDesc')}</option>
          <option value="seen-asc">{t('iam.members.sort.seenAsc')}</option></select></label>
        {filtering && q.data ? <><span className="iam-muted iam-small iam-member-count" aria-live="polite">{t('iam.members.shown', { n: rows.length, m: all.length })}</span>
          {/* Ohne Treffer steht «Filter zurücksetzen» im leeren Zustand */}
          {rows.length ? <Button size="sm" variant="ghost" onClick={resetFilters}>{t('iam.members.reset')}</Button> : null}</> : null}
      </div>
      {permFilter ? <p className="iam-muted iam-small iam-member-acl">{t('iam.members.byRightNote', { perm: authz.permLabel(permFilter as Permission) })}</p> : null}
      {!rolesManageable ? <div className="iam-warnbox iam-mb-s" role="note"><Icon name="warn" className="iam-ico" /><span>{t('iam.members.rolesFixed')}</span></div> : null}
      {q.isPending ? <SkeletonRows rows={4} cols={5} /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data.length ? (
        <Empty icon="users" title={t('iam.members.none.title')} action={<Button variant="primary" onClick={() => setInviting(true)}>{addLabel}</Button>}>{t(platform ? 'iam.members.none.platform' : 'iam.members.none.text', { org: orgLabel })}</Empty>
      ) : !rows.length ? (
        <Empty title={t('iam.members.noHits.title')} action={<Button onClick={resetFilters}>{t('iam.members.reset')}</Button>}>{needle && !roleFilter && !permFilter ? t('iam.members.noHits.text', { q: filter }) : t('iam.members.noHits.filters')}</Empty>
      ) : (
        <div className="iam-tblwrap">
          <Table stack className="iam-member-tbl">
            <caption className="iam-sr">{t('iam.members.caption', { org: orgLabel })}</caption>
            <thead><tr>{sortTh('name', t('iam.members.col.person'))}<th scope="col">{t('iam.members.col.status')}</th><th scope="col">{t('iam.members.col.roles')}</th>{sortTh('seen', t('iam.members.col.seen'), 'iam-st-hide')}<th scope="col" className="iam-acts"><span className="iam-sr">{t('iam.members.col.actions')}</span></th></tr></thead>
            <tbody>
              {rows.map(m => {
                const [st, cls, why] = STATUS[m.status];
                const inv = m.status === 'invited';
                const fixed = !rolesManageable || (platform ? m.roles.some(k => !label[k]) : m.roles.includes(ADMIN));
                return (
                  <tr key={m.id}>
                    <td><div className="iam-b">{m.name}{m.id === self ? <span className="iam-muted iam-small"> {t('iam.members.you')}</span> : null}</div><div className="iam-mono-s iam-muted">{m.email ?? m.username}</div></td>
                    <td><span className={`iam-pill iam-sm ${cls}`} title={inv && m.loginPath ? t('iam.members.status.entraInvited') : t(why)}>{t(st)}</span>
                      {inv && m.createdAt ? <div className="iam-muted iam-small" title={fmtDateTime(m.createdAt)}>{relTime(m.createdAt)}</div> : null}</td>
                    <td>{m.roles.length ? <ul className="iam-role-tags" aria-label={t('iam.members.rolesOf', { name: m.name })}>{m.roles.map(r => <li key={r} className={`iam-role-tag${r === ADMIN ? ' iam-admin' : ''}`}>{label[r] ?? r}</li>)}</ul> : <span className="iam-muted iam-small">{t('iam.members.noRole')}</span>}</td>
                    <td className="iam-muted iam-small iam-st-hide" title={m.lastSeenAt ? fmtDateTime(m.lastSeenAt) : undefined}>{m.lastSeenAt ? relTime(m.lastSeenAt) : t('iam.members.never')}</td>
                    <td className="iam-acts">
                      <div className="iam-row-acts">
                        <Button size="sm" className="iam-roles-btn" icon={fixed ? 'eye' : 'edit'} onClick={() => setEditing(m)} aria-label={t(fixed ? 'iam.members.viewRoles' : 'iam.members.editRoles', { name: m.name })}>{t(fixed ? 'iam.members.view' : 'iam.members.roles')}</Button>
                        <Menu label={t('iam.members.actions', { name: m.name })} buttonLabel={t('iam.members.more', { name: m.name })} title={t('iam.common.more')} className="iam-iconbtn iam-sm" fixed button={<Icon name="more" className="iam-ico" />}>
                          {close => <>
                            {inv ? <>
                              <MenuItem icon="send" label={t('iam.members.resend')} why={resend.isPending ? t('iam.members.resending') : null} onPick={() => { close(); resend.mutate(m); }} />
                              {m.loginPath ? <MenuItem icon="copy" label={t('iam.members.copyLink')} onPick={() => { close(); copyLink(m); }} /> : null}
                              <div className="iam-menu-sep" role="separator" />
                            </> : null}
                            <MenuItem icon="x" danger label={t(inv ? 'iam.members.withdraw' : 'iam.members.remove')} why={removeBlock(m)} onPick={() => { close(); setRemoving(m); }} />
                          </>}
                        </Menu>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
      {admins === 1 && q.data ? <p className="iam-note">{t('iam.members.lastAdmin', { role: adminLabel })}</p> : null}
      <details className="iam-more iam-member-roles">
        <summary>{t('iam.members.matrix')}</summary>
        <RoleMatrix roles={roles} caption={t('iam.matrix.caption')} />
      </details>
      {inviting ? <InviteDialog alias={alias} orgLabel={orgLabel} roles={roles} platform={platform} rolesManageable={rolesManageable} onClose={() => setInviting(false)} onDone={async () => { await refresh(); }} /> : null}
      {editing ? <RolesDialog alias={alias} orgLabel={orgLabel} member={editing} roles={roles} platform={platform} rolesManageable={rolesManageable} self={self} activeAdmins={admins} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); }} /> : null}
      {removing ? <RemoveConfirm member={removing} orgLabel={orgLabel} busy={remove.isPending} error={remove.error} onClose={() => { remove.reset(); setRemoving(null); }} onConfirm={() => remove.mutate(removing)} /> : null}
    </section>
  );
}

/** Entfernen bzw. Einladung zurückziehen: Folgen klar benannt, Fokus startet auf «Abbrechen». */
function RemoveConfirm({ member: m, orgLabel, busy, error, onClose, onConfirm }: { member: Member; orgLabel: string; busy: boolean; error: Error | null; onClose: () => void; onConfirm: () => void }) {
  const v = { name: m.name, org: orgLabel };
  const kind = m.status !== 'invited' ? 'remove' : m.loginPath ? 'withdrawEntra' : 'withdraw';
  const [title, confirm, text, note] = {
    remove: ['iam.members.remove.title', 'iam.members.remove.confirm', 'iam.members.remove.text', 'iam.members.remove.note'],
    withdraw: ['iam.members.withdraw.title', 'iam.members.withdraw.confirm', 'iam.members.withdraw.text', 'iam.members.withdraw.note'],
    withdrawEntra: ['iam.members.withdraw.title', 'iam.members.withdraw.confirm', 'iam.members.withdrawEntra.text', 'iam.members.withdrawEntra.note'],
  }[kind] as [Parameters<typeof t>[0], Parameters<typeof t>[0], Parameters<typeof t>[0], Parameters<typeof t>[0]];
  return (
    <Confirm title={t(title, v)} confirm={t(confirm)} danger busy={busy} onClose={onClose} onConfirm={onConfirm}>
      <p>{t(text, v)}</p>
      <p className="iam-muted iam-small">{t(note)}</p>
      {error ? <ErrorBox error={error} compact /> : null}
    </Confirm>
  );
}

export interface RolePickerProps { roles: RoleInfo[]; value: ReadonlySet<string>; onChange: (v: Set<string>) => void; platform: boolean; idBase: string }

/**
 * Rollenauswahl: eine Zeile je Rolle, gruppiert – Kontrollkästchen, Label und die ganze Beschreibung (bricht um, ohne
 * Aufklappen; nur als title wäre sie per Tastatur und Touch nicht lesbar). Ist eine Rolle in einer gewählten enthalten
 * (ihre Rechte sind eine echte Teilmenge, roles.ts), steht statt eines Kontrollkästchens ein Haken mit der Markierung
 * «in … enthalten». Ist Organisations-Admin gewählt, steht statt der übrigen Rollen eine Zeile «Enthält alle anderen
 * Rollen»; sie erscheinen wieder, wenn Organisations-Admin abgewählt wird, bzw. – wo Organisations-Admin gesperrt ist –
 * über «Rollen anzeigen». org-admin vergibt nur die Plattform-Administration: ohne Kontrollkästchen, gekennzeichnet.
 * Gespeichert wird die eigene Auswahl (auch eine enthaltene Rolle, die schon gespeichert war).
 */
export function RolePicker({ roles, value, onChange, platform, idBase }: RolePickerProps) {
  const { Icon } = useIamUi();
  const authz = useAuthz();
  useIamText();
  const map = useMemo(() => containers(roles), [roles]);
  const [showAll, setShowAll] = useState(false);
  const name = (k: string) => roles.find(r => r.key === k)?.label ?? k;
  const adminRole = roles.find(r => r.key === ADMIN);
  const adminLocked = !!adminRole?.adminOnly && !platform;
  const folded = !!adminRole && value.has(ADMIN) && !(adminLocked && showAll);
  const groups = authz.groupRoles(roles);
  const shown = folded ? groups.filter(g => g.roles.some(r => r.key === ADMIN)).map(g => ({ ...g, roles: g.roles.filter(r => r.key === ADMIN) })) : groups;
  return (
    <fieldset className="iam-fs iam-role-pick">
      <legend>{t('iam.rolePick.roles')}</legend>
      {shown.map(g => (
        <fieldset key={g.key} className="iam-role-group">
          <legend className="iam-role-group-h">{g.label}</legend>
          <ul className="iam-rp-list">
            {g.roles.map(r => {
              const locked = r.adminOnly && !platform;
              const within = includedIn(r.key, value, map);
              const implied = !locked && within.length > 0;
              const id = `${idBase}-${r.key}`;
              const mark = locked ? t('iam.rolePick.platformOnly') : implied ? t('iam.rolePick.within', { roles: listAnd(within.map(name)) }) : null;
              return (
                <li key={r.key} className={`iam-rp-r${implied ? ' iam-is-implied' : ''}${locked ? ' iam-is-locked' : ''}${value.has(r.key) && !implied ? ' iam-is-on' : ''}`}>
                  {locked || implied ? <span className="iam-rp-ctl" aria-hidden="true"><Icon name={locked ? 'shield' : 'check'} className="iam-ico" /></span>
                    : <input id={id} type="checkbox" className="iam-rp-ctl" checked={value.has(r.key)} aria-describedby={`${id}-s`}
                      onChange={e => { const n = new Set(value); if (e.target.checked) n.add(r.key); else n.delete(r.key); onChange(n); }} />}
                  <span className="iam-rp-t">
                    {locked || implied ? <span className="iam-rp-l" id={id}>{r.label}</span> : <label htmlFor={id} className="iam-rp-l">{r.label}</label>}
                    <span id={`${id}-s`} className="iam-rp-s">{r.description}</span>
                  </span>
                  {mark ? <span className={`iam-rp-mark${locked ? ' iam-locked' : ''}`}><span className="iam-sr">, </span>{mark}</span> : null}
                </li>
              );
            })}
          </ul>
        </fieldset>
      ))}
      {adminRole && value.has(ADMIN) ? (
        <p className="iam-rp-all">
          <Icon name="check" className="iam-ico" /><span>{t('iam.rolePick.all')}</span>
          {adminLocked ? <button type="button" className="iam-linkbtn" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>{t(showAll ? 'iam.rolePick.hide' : 'iam.rolePick.show')}</button> : null}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Rechte im Rollendialog: dieselbe Rechte-Übersicht wie überall, aus den gewählten Rollen; beim Bearbeiten mit der Änderung. */
function DialogRights({ roles, before }: { roles: ReadonlySet<string>; before?: readonly string[] }) {
  return (
    <div className="iam-role-rights">
      <h4>{t('iam.members.rights')}</h4>
      <RightsOverview roles={[...roles]} before={before} rulesNote />
    </div>
  );
}

/**
 * Rollen ansehen: kein Formular – Rollen als Karten (Label und Kurzbeschreibung, ganze Beschreibung als title), darunter
 * die Rechte-Übersicht aus den Rollen (keine effektiven Rechte) und eingeklappt «Rollen vergleichen».
 */
function RoleView({ member, roles }: { member: Member; roles: RoleInfo[] }) {
  const authz = useAuthz();
  const own = authz.groupRoles(roles.filter(r => member.roles.includes(r.key))).flatMap(g => g.roles);
  const unknown = member.roles.filter(k => !roles.some(r => r.key === k));
  return (
    <div className="iam-role-view">
      <h4>{t('iam.rolePick.roles')}</h4>
      {own.length || unknown.length ? (
        <ul className="iam-role-cards" aria-label={t('iam.members.rolesOf', { name: member.name })}>
          {own.map(r => <li key={r.key} className={`iam-card${r.key === ADMIN ? ' iam-admin' : ''}`} title={r.description}><span className="iam-b">{r.label}</span><span className="iam-muted iam-small">{roleSummary(r.description)}</span></li>)}
          {unknown.map(k => <li key={k} className="iam-card"><span className="iam-b">{k}</span></li>)}
        </ul>
      ) : <p className="iam-muted iam-small">{t('iam.members.noRoleView', { name: member.name })}</p>}
      <h4>{t('iam.members.rights')}</h4>
      <RightsOverview roles={member.roles} rulesNote />
      <RoleCompare roles={roles} highlight={member.roles} highlightAs="selected" />
    </div>
  );
}

interface InviteProps { alias: string | null; orgLabel: string; roles: RoleInfo[]; platform: boolean; rolesManageable: boolean; onClose: () => void; onDone: () => Promise<void> }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Vorgabe beim Einladen: `inviteRoles` der App (nur Rollen, die es gibt; Rollen nur für die Plattform-Administration
 * ausserhalb der Plattformansicht nie, sonst wäre jedes Einladen ein 403), sonst die vordefinierte Rolle mit den
 * wenigsten Rechten ausser org-admin (Notiz-App und Assets: Leser:in). Eigene Rollen der Organisation (`c-…`) nie:
 * eine schmale eigene Rolle würde sonst Vorgabe für jede Einladung; bei Gleichstand gilt die Reihenfolge des Katalogs.
 */
function defaultRoles(roles: RoleInfo[], configured: string[] | undefined, platform: boolean): string[] {
  const allowed = (r: RoleInfo) => platform || !r.adminOnly;
  if (configured) return configured.filter(k => roles.some(r => r.key === k && allowed(r)));
  const least = roles.filter(r => r.key !== ADMIN && !r.adminOnly && !isCustomRole(r.key)).sort((a, b) => a.permissions.length - b.permissions.length)[0];
  return least ? [least.key] : [];
}

function InviteDialog({ alias, orgLabel, roles, platform, rolesManageable, onClose, onDone }: InviteProps) {
  const { Dialog, Button, Icon, toast } = useIamUi();
  const fid = useId();
  const [d, setD] = useState({ email: '', firstName: '', lastName: '' });
  const { inviteRoles } = useIamConfig();
  const [sel, setSel] = useState<Set<string>>(() => new Set(rolesManageable ? defaultRoles(roles, inviteRoles, platform) : []));
  const [result, setResult] = useState<InviteResult | null>(null);
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (body: InviteInput) => memberApi(alias).invite(body),
    onSuccess: async r => {
      await onDone();
      if (r.emailSent) { toast.show(t('iam.invite.sent', { org: orgLabel, email: r.member.email ?? d.email })); onClose(); }
      else setResult(r);
    },
  });
  const submit = () => {
    const email = d.email.trim();
    if (!EMAIL.test(email)) { setEmailErr(t('iam.invite.emailInvalid')); document.getElementById(`${fid}-email`)?.focus(); return; }
    setEmailErr(null);
    send.mutate({ email, ...(d.firstName.trim() ? { firstName: d.firstName.trim() } : {}), ...(d.lastName.trim() ? { lastName: d.lastName.trim() } : {}), roles: [...sel] });
  };
  if (result) {
    const names = roleNames(result.member.roles, roles);
    return (
      <Dialog title={t('iam.invite.doneTitle')} onClose={onClose} width={520} footer={<Button variant="primary" data-autofocus onClick={onClose}>{t('iam.common.close')}</Button>}>
        <p>{t(names.length ? (names.length === 1 ? 'iam.invite.doneRole' : 'iam.invite.doneRoles') : 'iam.invite.done', { name: result.member.name, org: orgLabel, roles: names.join(', ') })}</p>
        <div className="iam-warnbox" role="alert"><Icon name="warn" className="iam-ico" /><span>{t('iam.invite.noMail')}</span></div>
      </Dialog>
    );
  }
  return (
    <Dialog title={t('iam.invite.title', { org: orgLabel })} onClose={onClose} onSubmit={submit} width={600}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" busy={send.isPending}>{send.isPending ? <Loading inline label={t('iam.invite.sending')} /> : <><Icon name="send" className="iam-ico" />{t('iam.invite.send')}</>}</Button></>}>
      <p className="iam-muted iam-small">{t('iam.invite.intro', { org: orgLabel })}</p>
      <div className="iam-form iam-compact">
        <label htmlFor={`${fid}-email`}>{t('iam.invite.email')}</label>
        <input id={`${fid}-email`} type="email" className="iam-inp" value={d.email} onChange={e => setD({ ...d, email: e.target.value })} required autoComplete="off" data-autofocus aria-invalid={emailErr ? true : undefined} aria-describedby={emailErr ? `${fid}-email-e` : undefined} />
        {emailErr ? <div id={`${fid}-email-e`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{emailErr}</div> : null}
        <label htmlFor={`${fid}-fn`}>{t('iam.invite.firstName')}</label>
        <input id={`${fid}-fn`} className="iam-inp" value={d.firstName} onChange={e => setD({ ...d, firstName: e.target.value })} autoComplete="off" />
        <label htmlFor={`${fid}-ln`}>{t('iam.invite.lastName')}</label>
        <input id={`${fid}-ln`} className="iam-inp" value={d.lastName} onChange={e => setD({ ...d, lastName: e.target.value })} autoComplete="off" />
      </div>
      {rolesManageable ? <>
        <RolePicker roles={roles} value={sel} onChange={setSel} platform={platform} idBase={`${fid}-r`} />
        {sel.size ? null : <p className="iam-note">{t('iam.invite.noRole')}</p>}
        <DialogRights roles={sel} />
      </> : null}
      {send.error ? <ErrorBox error={send.error} /> : null}
    </Dialog>
  );
}

/**
 * Rollen einer Person. Die Rollen von Organisations-Admins ändert nur die Plattform-Administration (die API lehnt jede
 * Änderung an org-admin ab, alle übrigen Rollen sind darin enthalten), in Instanzen mit Rollen aus Keycloak niemand:
 * dann nur ansehen, mit «Schliessen». Sonst Auswahl mit Rechte-Übersicht und «+ n Rechte, − m Rechte».
 */
function RolesDialog({ alias, orgLabel, member, roles, platform, rolesManageable, self, activeAdmins, onClose, onSaved }: { alias: string | null; orgLabel: string; member: Member; roles: RoleInfo[]; platform: boolean; rolesManageable: boolean; self?: string; activeAdmins: number; onClose: () => void; onSaved: () => Promise<void> }) {
  const { Dialog, Button, Icon, toast } = useIamUi();
  const authz = useAuthz();
  const fid = useId();
  // Plattformansicht: Rollen, die sie nicht kennt, sind eigene Rollen dieser Organisation – nur ansehen, sonst gingen sie
  // beim Speichern verloren. In der eigenen Organisation ist eine unbekannte Rolle gelöscht und fällt beim Speichern weg.
  const foreign = platform ? member.roles.filter(k => !roles.some(r => r.key === k)) : [];
  const viewOnly = !rolesManageable || (!platform && member.roles.includes(ADMIN)) || foreign.length > 0;
  const [sel, setSel] = useState<Set<string>>(() => new Set(member.roles));
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    // nur Rollen, die es (noch) gibt: eine inzwischen gelöschte eigene Rolle würde sonst 422 auslösen
    mutationFn: () => memberApi(alias).setRoles(member.id, [...sel].filter(k => roles.some(r => r.key === k))),
    onSuccess: async () => { toast.show(t('iam.roles.saved', { name: member.name, org: orgLabel })); await onSaved(); },
    onError: () => setConfirming(false),
  });
  const name = (k: string) => roles.find(r => r.key === k)?.label ?? k;
  const v = { name: member.name, org: orgLabel, role: name(ADMIN) };
  const title = t('iam.roles.dialog', { name: member.name, org: orgLabel });
  const intro = <p className="iam-muted iam-small">{member.email}{member.id === self ? t('iam.roles.ownAccount') : ''}{t('iam.roles.when')}</p>;
  if (viewOnly) {
    return (
      <Dialog title={title} onClose={onClose} width={680} footer={<Button variant="primary" data-autofocus onClick={onClose}>{t('iam.common.close')}</Button>}>
        {intro}
        <p className="iam-note" role="note">{!rolesManageable ? t('iam.members.rolesFixed') : foreign.length ? t('iam.roles.unknownRoles', { roles: foreign.join(', ') }) : t('iam.roles.adminOnlyPlatform', { role: name(ADMIN) })}</p>
        <RoleView member={member} roles={roles} />
      </Dialog>
    );
  }
  const added = [...sel].filter(r => !member.roles.includes(r)), removed = member.roles.filter(r => !sel.has(r));
  // Letzte aktive Person mit org-admin: Entzug lehnt der Server ab (409) – gesperrt mit Grund, wie beim Entfernen
  const lastBlock = removed.includes(ADMIN) && lastAdmin(member, activeAdmins) ? t('iam.members.block.last', { role: name(ADMIN) }) : null;
  // Sich selbst «Mitglieder und Rollen verwalten» entziehen: danach ist diese Seite für die Person zu
  const can = (keys: Iterable<string>) => [...keys].some(k => k === ADMIN || roles.find(r => r.key === k)?.permissions.includes('members:admin'));
  const losesOwn = member.id === self && can(member.roles) && !can(sel);
  const critical = removed.includes(ADMIN) || added.includes(ADMIN) || (!sel.size && member.roles.length > 0) || losesOwn;
  const submit = () => { if (lastBlock) return; if (!added.length && !removed.length) return onClose(); if (critical) setConfirming(true); else save.mutate(); };
  return (
    <>
      <Dialog title={title} onClose={onClose} onSubmit={submit} width={600}
        footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" busy={save.isPending} aria-disabled={lastBlock ? true : undefined} aria-describedby={lastBlock ? `${fid}-last` : undefined}>{t('iam.common.save')}</Button></>}>
        {intro}
        <RolePicker roles={roles} value={sel} onChange={setSel} platform={platform} idBase={`${fid}-r`} />
        {lastBlock ? <p id={`${fid}-last`} className="iam-ferr" role="alert"><Icon name="warn" className="iam-ico" />{lastBlock}</p> : null}
        <DialogRights roles={sel} before={member.roles} />
        {save.error && !confirming ? <ErrorBox error={save.error} /> : null}
      </Dialog>
      {confirming ? (
        <Confirm title={t('iam.roles.critical')} confirm={t('iam.roles.saveAnyway')} danger={removed.length > 0} busy={save.isPending} onClose={() => setConfirming(false)} onConfirm={() => save.mutate()}>
          {removed.includes(ADMIN) ? <p>{t('iam.roles.loseAdmin', v)}</p> : null}
          {added.includes(ADMIN) ? <p>{t('iam.roles.gainAdmin', v)}</p> : null}
          {!sel.size ? <p>{t('iam.roles.noneLeft', v)}</p> : null}
          {losesOwn ? <p>{t('iam.roles.loseOwnAdmin', { perm: authz.permLabel('members:admin'), org: orgLabel })}</p> : null}
        </Confirm>
      ) : null}
    </>
  );
}
