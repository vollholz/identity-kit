/**
 * Verwalten › Zugang › Mitglieder (Spezifikation 9.6, 11.3): Personen **und** freigegebene Maschinen-Clients der
 * Organisation in einer Liste (Spalte Art), Rollen an der Organisation, Freigabestufe, «+n Orte» (Klick zeigt die Orte
 * mit Rolle, `GET /v1/access?subject=`), zuletzt aktiv, bei Clients die Scopes aus dem letzten Token. Einladen, Client
 * freigeben, Rollen setzen (Dialog mit Rechte-Übersicht und Rollenmatrix), Freigabestufe setzen, über «⋯» entfernen bzw.
 * die Freigabe entziehen, Einladung erneut senden oder zurückziehen. Dieselbe Liste nutzt die Plattform-Administration
 * für eine beliebige Organisation (`alias`). Mit Entra ID verbunden (nur mit `features.entra`): «Person hinzufügen» sucht
 * im Verzeichnis der Organisation.
 *
 * - Je Zeile höchstens «Rollen» (bei Organisations-Admins «Ansehen») und das Menü «Mehr zu <Name>», damit alle Zeilen
 *   gleich hoch bleiben. Was die API ablehnen würde, steht gesperrt mit Grund, statt zu fehlen oder erst beim
 *   Bestätigen zu scheitern: niemand gibt mehr, als er hat (Rollen mit Rechten, die ich nicht habe; Freigabestufe über
 *   meiner), nie die eigene Freigabestufe, org-admin nur über die Plattform-Administration, letzte Person mit org-admin.
 * - Dialoge, Rückfragen und Meldungen nennen die Organisation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { useSubjectAccess } from '../access/api.ts';
import { untilText } from '../access/BreakGlass.tsx';
import { OpenPlace, usePlaceName } from '../access/places.tsx';
import { AccessError } from '../access/shared.tsx';
import { useAccount } from '../account.ts';
import { clientApi, memberApi, useAdminStatus, useEntra, useMembers } from '../admin.ts';
import { useAccessFeature, useAuthz, useAuthzCatalog } from '../authz.ts';
import { authLink } from '../client.ts';
import { useIamConfig } from '../config.tsx';
import type { EntraAddInput, EntraAddResult, EntraCandidate, InviteInput, InviteResult, Level, Member, RoleInfo } from '../contract.ts';
import { fmtDate, fmtDateTime, relTime } from '../format.ts';
import { iamKeys } from '../keys.ts';
import { ADMIN_ROLE as ADMIN, ORG_TYPE, type Permission } from '../permissions.ts';
import { AdminHead } from '../rights/AdminHead.tsx';
import { RightsOverview, roleSummary } from '../rights/RightsOverview.tsx';
import { RoleCompare, RoleMatrix } from '../rights/RoleMatrix.tsx';
import { containers, includedIn } from '../roles.ts';
import { useIam, useIamMaybe } from '../session.tsx';
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

/** Alle Mitgliederlisten (eigene Organisation und Plattformansicht), für die Invalidierung nach Änderungen. */
const MEMBER_LISTS = ['iam', 'admin', 'members'] as const;
const LEVELS = [0, 1, 2] as const;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;

/**
 * Würde Entfernen oder der Entzug von org-admin die letzte aktive Person mit org-admin treffen (409 des Servers)? Aktiv
 * zählt wie auf dem Server; ein deaktiviertes Konto mit org-admin ohne weitere aktive Admin-Person bleibt ebenfalls.
 */
const lastAdmin = (m: Member, activeAdmins: number) =>
  m.kind === 'user' && m.roles.includes(ADMIN) && (m.status === 'active' ? activeAdmins <= 1 : m.status === 'disabled' && activeAdmins === 0);

type SortKey = 'name' | 'seen';
type KindFilter = '' | 'user' | 'client';
/** «Zuletzt aktiv»: noch nie aktiv gilt als ältester Wert. */
const seen = (m: Member) => (m.lastSeenAt ? Date.parse(m.lastSeenAt) : 0);
const roleNames = (keys: readonly string[], roles: readonly RoleInfo[]) => keys.map(k => roles.find(r => r.key === k)?.label ?? k);
/** Subjekt einer Freigabe (7.4). */
const subjectOf = (m: Member) => `${m.kind}:${m.principalId}`;

/**
 * Rechte der Rolle, die die handelnde Person an der Organisation nicht hat («niemand gibt mehr, als er hat», 7.5);
 * `own` fehlt in der Plattformansicht (dort gilt die Regel nicht, A9).
 */
const exceeding = (r: RoleInfo, own: ReadonlySet<string> | null) => (own ? r.permissions.filter(p => !own.has(p)) : []);

/** Seite «Mitglieder» der eigenen Organisation (Recht `members:admin` prüft der Guard der Route). */
export function MembersPage() {
  const { orgName: org } = useIam();
  const { features } = useIamConfig();
  const { Button } = useIamUi();
  useIamText();
  const status = useAdminStatus();
  const [inviting, setInviting] = useState(false);
  const [granting, setGranting] = useState(false);
  // Mit Entra ID verbunden: hinzufügen aus dem Verzeichnis (nur mit features.entra; Fehler beim Lesen: wie nicht verbunden)
  const connected = !!useEntra(null, !!features.entra && !!status.data?.enabled).data?.connection;
  return (
    <>
      <AdminHead icon="users" title={t('iam.members.title')} sub={t('iam.members.sub', { org })}
        actions={status.data?.enabled ? <>
          <Button icon="key" onClick={() => setGranting(true)}>{t('iam.members.client.grant')}</Button>
          <Button variant="primary" icon="plus" onClick={() => setInviting(true)}>{t(connected ? 'iam.members.add' : 'iam.members.invite')}</Button>
        </> : null} />
      <div className="iam-body"><div className="iam-int">
        {status.isPending ? <SkeletonRows rows={4} /> : status.error ? <ErrorState error={status.error} onRetry={() => void status.refetch()} /> : !status.data.enabled ? (
          <Empty icon="cog" title={t('iam.members.off.title')}>
            <p>{status.data.reason}</p>
            <p className="iam-muted iam-small">{t('iam.members.off.text')}</p>
          </Empty>
        ) : <MemberList inviting={inviting} onInviting={setInviting} granting={granting} onGranting={setGranting} />}
      </div></div>
      <div className="iam-cli iam-api"><span className="iam-cli-label">API</span><code tabIndex={0}>GET /v1/admin/members · POST /v1/admin/members{connected ? ' · GET /v1/admin/members/entra-search · POST /v1/admin/members/entra' : ''} · PUT /v1/admin/members/&#123;id&#125;/roles · PUT /v1/admin/members/&#123;id&#125;/clearance · PUT /v1/admin/clients/&#123;clientId&#125;</code></div>
    </>
  );
}

export interface MemberListProps {
  /** Organisation der Plattform-Administration; ohne = die eigene. */
  alias?: string;
  /** Ansicht der Plattform-Administration: vergibt org-admin, ohne Obergrenze der eigenen Rechte und Freigabestufe. */
  platform?: boolean;
  /** Name der Organisation, deren Mitglieder die Liste zeigt; Standard die eigene. */
  orgLabel?: string;
  /**
   * Einladen und Client freigeben von aussen gesteuert (Hauptaktion im Seitenkopf). Ohne stehen die Aktionen im Kopf des
   * Abschnitts (Plattformansicht: Seitenkopf gehört zur Organisation).
   */
  inviting?: boolean;
  onInviting?: (v: boolean) => void;
  granting?: boolean;
  onGranting?: (v: boolean) => void;
}

interface ListCtx {
  alias: string | null;
  orgLabel: string;
  roles: RoleInfo[];
  platform: boolean;
  /** Rechte der handelnden Person an der Organisation; `null` in der Plattformansicht (keine Obergrenze). */
  own: ReadonlySet<string> | null;
  /** Eigene Freigabestufe (Obergrenze); in der Plattformansicht 2. */
  ownClearance: Level;
  self: string;
}

/** Tabelle der Mitglieder (Personen und Clients) mit Einladen, Freigeben, Rollen, Freigabestufe und Entfernen. */
export function MemberList({ alias: aliasProp, platform = false, orgLabel: orgProp, inviting: invitingOuter, onInviting, granting: grantingOuter, onGranting }: MemberListProps) {
  const alias = aliasProp ?? null;
  // Plattform-Administration auch ohne Organisation: dann ohne Sitzung eines Mandanten, die Person aus dem Konto
  const session = useIamMaybe();
  const account = useAccount(!session).data;
  // Rollen an der Organisation aus dem Katalog des Modells (gleich in jeder Organisation, auch ohne Organisation lesbar)
  const catalog = useAuthzCatalog();
  const roles = useMemo(() => {
    const atOrg = catalog.data?.types.find(x => x.key === ORG_TYPE)?.roles ?? [];
    return (catalog.data?.roles ?? []).filter(r => atOrg.includes(r.key));
  }, [catalog.data]);
  const me = session?.me ?? null;
  const ctx: ListCtx = {
    alias, orgLabel: orgProp ?? session?.orgName ?? '', roles, platform, self: me?.person.subject ?? account?.account.subject ?? '',
    own: platform || !me ? null : new Set(me.permissions), ownClearance: platform || !me ? 2 : me.clearance,
  };
  const q = useMembers(alias);
  const { Button, Icon, Menu, Table, toast } = useIamUi();
  const { locale } = useIamText();
  // Orte eines Mitglieds gibt es nur in der eigenen Organisation (GET /v1/access?subject=); die Plattformansicht zeigt Rollen an org
  const places = useAccessFeature() && !platform;
  const [filter, setFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('');
  const [roleFilter, setRoleFilter] = useState('');
  const [permFilter, setPermFilter] = useState('');
  // Ohne Wahl: Reihenfolge der API
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean } | null>(null);
  const authz = useAuthz();
  const [invitingOwn, setInvitingOwn] = useState(false);
  const inviting = onInviting ? !!invitingOuter : invitingOwn;
  const setInviting = onInviting ?? setInvitingOwn;
  const [grantingOwn, setGrantingOwn] = useState(false);
  const granting = onGranting ? !!grantingOuter : grantingOwn;
  const setGranting = onGranting ?? setGrantingOwn;
  const [editing, setEditing] = useState<Member | null>(null);
  const [leveling, setLeveling] = useState<Member | null>(null);
  const [placesOf, setPlacesOf] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const qc = useQueryClient();
  const fid = useId();
  const { orgLabel } = ctx;
  const label = useMemo(() => Object.fromEntries(roles.map(r => [r.key, r.label])), [roles]);
  const adminLabel = label[ADMIN] ?? ADMIN;
  const api = memberApi(alias);
  // Rechte wirken sofort (7.9), auch für die eigene Person: Mitgliederlisten, Clients, Zugriff und /auth/me neu laden
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: MEMBER_LISTS }), qc.invalidateQueries({ queryKey: iamKeys.clients(alias) }),
    qc.invalidateQueries({ queryKey: iamKeys.access }), qc.invalidateQueries({ queryKey: iamKeys.me }),
  ]);
  const copyLink = (link: string, m: Member) => { void navigator.clipboard?.writeText(link).then(() => toast.show(t('iam.members.linkCopied', { name: m.name })), () => undefined); };

  const resend = useMutation({
    mutationFn: (m: Member) => api.resend(m.id),
    // ohne Versand (kein E-Mail-Versand im Realm) nicht «gesendet» melden
    onSuccess: (r, m) => (r.emailSent
      ? toast.show(t('iam.members.resent', { org: orgLabel, who: m.email ?? m.name }))
      : toast.show(t('iam.members.resentNoMail', { who: m.email ?? m.name }), { tone: 'error' })),
    onError: e => toast.error(e, t('iam.members.resendFailed')),
  });
  const remove = useMutation({
    mutationFn: async (m: Member) => (m.kind === 'client' ? (await clientApi(alias).revoke(m.id), { accountDeleted: false }) : api.remove(m.id)),
    onSuccess: async (r, m) => {
      setRemoving(null);
      await refresh();
      toast.show(m.kind === 'client' ? t('iam.members.client.revoked', { id: m.id, org: orgLabel })
        : m.status === 'invited' ? t(r.accountDeleted ? 'iam.members.withdrawnDeleted' : 'iam.members.withdrawn', { name: m.name, org: orgLabel })
          : t('iam.members.removed', { name: m.name, org: orgLabel }));
    },
  });

  const needle = filter.trim().toLowerCase();
  const all = q.data ?? [];
  // Rollen mit dem gewählten Recht (Rechte je Rolle aus /v1/admin/status); Freigaben an Orten zählen hier nicht
  const permRoles = useMemo(() => new Set(roles.filter(r => r.permissions.includes(permFilter)).map(r => r.key)), [roles, permFilter]);
  const filtered = all.filter(m => (!needle || m.name.toLowerCase().includes(needle) || (m.email ?? '').toLowerCase().includes(needle) || (m.clientId ?? '').toLowerCase().includes(needle))
    && (!kindFilter || m.kind === kindFilter)
    && (!roleFilter || m.roles.includes(roleFilter))
    && (!permFilter || m.roles.some(r => permRoles.has(r))));
  const rows = sort ? [...filtered].sort((a, b) => (sort.asc ? 1 : -1) * (sort.key === 'name' ? a.name.localeCompare(b.name, locale) : seen(a) - seen(b))) : filtered;
  const filtering = !!(needle || kindFilter || roleFilter || permFilter);
  const resetFilters = () => { setFilter(''); setKindFilter(''); setRoleFilter(''); setPermFilter(''); };
  const permGroups = (authz.catalog?.groups ?? []).map(g => ({ ...g, perms: authz.catalog!.permissions.filter(p => p.group === g.key) })).filter(g => g.perms.length);
  /** Spaltenkopf zum Sortieren: erster Klick auf «Name» aufsteigend, auf «Zuletzt aktiv» neueste zuerst, dann umkehren. */
  const sortTh = (key: SortKey, text: string, className?: string) => {
    const on = sort?.key === key;
    return (
      <th scope="col" className={[className, on ? 'iam-sorted' : ''].filter(Boolean).join(' ') || undefined} aria-sort={on ? (sort.asc ? 'ascending' : 'descending') : 'none'}>
        <button type="button" onClick={() => setSort(on ? { key, asc: !sort.asc } : { key, asc: key === 'name' })}>{text}{on ? <Icon name={sort.asc ? 'up' : 'down'} className="iam-ico" /> : null}</button>
      </th>
    );
  };
  // wie der Server (letzte Person mit org-admin): nur aktive Konten, keine offenen Einladungen und keine deaktivierten
  const admins = all.filter(m => m.kind === 'user' && m.roles.includes(ADMIN) && m.status === 'active').length;
  const people = all.filter(m => m.kind === 'user');
  const invited = people.filter(m => m.status === 'invited').length;
  const clients = all.length - people.length;
  /** Warum die API Entfernen, Zurückziehen bzw. Entziehen ablehnen würde (403/409), sonst null. */
  const removeBlock = (m: Member): string | null => {
    if (m.kind === 'client') {
      const over = m.roles.flatMap(k => exceeding(roles.find(r => r.key === k) ?? { key: k, label: k, description: '', permissions: [], adminOnly: false }, ctx.own));
      return over.length ? t('iam.members.block.exceeds', { perms: listAnd([...new Set(over)].map(p => `«${authz.permLabel(p)}»`)) }) : null;
    }
    if (!platform && m.id === ctx.self) return t('iam.members.block.self');
    if (!platform && m.roles.includes(ADMIN)) return m.status === 'invited' ? t('iam.members.block.adminInvite', { role: adminLabel }) : t('iam.members.block.admin', { role: adminLabel });
    if (lastAdmin(m, admins)) return t('iam.members.block.last', { role: adminLabel });
    return null;
  };
  /** Warum die Freigabestufe nicht änderbar ist: nie die eigene (403 `self`). */
  const levelBlock = (m: Member): string | null => (m.kind === 'user' && m.id === ctx.self ? t('iam.members.clearance.self') : null);
  // Mit Entra ID verbunden: hinzufügen aus dem Verzeichnis (nur mit features.entra; Fehler beim Lesen: wie nicht verbunden)
  const { features } = useIamConfig();
  const connected = !!useEntra(alias, !!features.entra).data?.connection;
  const addLabel = t(connected ? 'iam.members.add' : 'iam.members.invite');
  const count = q.data ? [tn('iam.members.people', people.length), invited ? t('iam.members.ofInvited', { n: invited }) : '', clients ? `, ${tn('iam.members.clients', clients)}` : ''].join('') : '';

  return (
    <section aria-labelledby={`${fid}-h`}>
      <div className="iam-sec-h iam-wrap"><h2 id={`${fid}-h`}>{t('iam.members.title')}</h2><span>{count}</span>
        {onInviting ? null : <><span className="iam-spacer" /><Button icon="key" onClick={() => setGranting(true)}>{t('iam.members.client.grant')}</Button><Button variant="primary" icon="plus" onClick={() => setInviting(true)}>{addLabel}</Button></>}</div>
      <div className="iam-toolbar iam-inline iam-member-filters">
        <label className="iam-search iam-member-filter"><Icon name="search" className="iam-ico" /><span className="iam-sr">{t('iam.members.filter')}</span>
          <input type="search" placeholder={t('iam.members.filterHint')} value={filter} onChange={e => setFilter(e.target.value)} autoComplete="off" /></label>
        <label className="iam-sel"><span>{t('iam.members.byKind')}</span><select className="iam-inp" value={kindFilter} onChange={e => setKindFilter(e.target.value as KindFilter)}>
          <option value="">{t('iam.members.any')}</option>
          <option value="user">{t('iam.members.kind.users')}</option>
          <option value="client">{t('iam.members.kind.clients')}</option></select></label>
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
      {q.isPending || catalog.isPending ? <SkeletonRows rows={4} cols={6} /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data.length ? (
        <Empty icon="users" title={t('iam.members.none.title')} action={<Button variant="primary" onClick={() => setInviting(true)}>{addLabel}</Button>}>{t(connected ? (platform ? 'iam.members.noneAdd.platform' : 'iam.members.noneAdd.text') : platform ? 'iam.members.none.platform' : 'iam.members.none.text', { org: orgLabel })}</Empty>
      ) : !rows.length ? (
        <Empty title={t('iam.members.noHits.title')} action={<Button onClick={resetFilters}>{t('iam.members.reset')}</Button>}>{needle && !roleFilter && !permFilter && !kindFilter ? t('iam.members.noHits.text', { q: filter }) : t('iam.members.noHits.filters')}</Empty>
      ) : (
        <div className="iam-tblwrap">
          <Table stack className="iam-member-tbl">
            <caption className="iam-sr">{t('iam.members.caption', { org: orgLabel })}</caption>
            <thead><tr>
              {sortTh('name', t('iam.members.col.name'))}<th scope="col">{t('iam.members.col.kind')}</th><th scope="col">{t('iam.members.col.status')}</th>
              <th scope="col">{t('iam.members.col.roles')}</th><th scope="col">{t('iam.members.col.clearance')}</th>
              {places ? <th scope="col">{t('iam.members.col.places')}</th> : null}
              {sortTh('seen', t('iam.members.col.seen'), 'iam-st-hide')}<th scope="col" className="iam-acts"><span className="iam-sr">{t('iam.members.col.actions')}</span></th>
            </tr></thead>
            <tbody>
              {rows.map(m => {
                const [st, cls, why] = STATUS[m.status];
                const inv = m.status === 'invited';
                const client = m.kind === 'client';
                const link = authLink(m.loginPath);
                const fixed = !platform && m.roles.includes(ADMIN);
                const bgUntil = m.breakGlassUntil && Date.parse(m.breakGlassUntil) > Date.now() ? new Date(m.breakGlassUntil) : null;
                return (
                  <tr key={`${m.kind}:${m.id}`}>
                    <td><div className="iam-b">{m.name}{!client && m.id === ctx.self ? <span className="iam-muted iam-small"> {t('iam.members.you')}</span> : null}</div>
                      <div className="iam-mono-s iam-muted">{client ? m.clientId ?? m.id : m.email ?? m.username}</div>
                      {client ? <div className="iam-muted iam-small" title={m.scopes?.join(' ')}>{m.scopes ? (m.scopes.length ? t('iam.members.client.scopes', { scopes: m.scopes.map(s => authz.scopeText(s) || s).join(', ') }) : t('iam.members.client.noScope')) : t('iam.members.client.neverUsed')}</div> : null}</td>
                    <td><span className="iam-st-lbl">{t('iam.members.col.kind')}:</span>{t(client ? 'iam.members.kind.client' : 'iam.members.kind.user')}</td>
                    <td><span className={`iam-pill iam-sm ${cls}`} title={inv && m.loginPath ? t('iam.members.status.entraInvited') : t(why)}>{t(st)}</span>
                      {inv && m.createdAt ? <div className="iam-muted iam-small" title={fmtDateTime(m.createdAt)}>{relTime(m.createdAt)}</div> : null}</td>
                    <td>{m.roles.length ? <ul className="iam-role-tags" aria-label={t('iam.members.rolesOf', { name: m.name })}>{m.roles.map(r => <li key={r} className={`iam-role-tag${r === ADMIN ? ' iam-admin' : ''}`}>{label[r] ?? r}</li>)}</ul> : <span className="iam-muted iam-small">{t('iam.members.noRole')}</span>}</td>
                    <td><span className="iam-st-lbl">{t('iam.members.col.clearance')}:</span>{authz.classificationLabel(m.clearance)}
                      {bgUntil ? <div className="iam-small iam-bg-note">{t('iam.members.breakGlass', { time: untilText(bgUntil) })}</div> : null}</td>
                    {places ? <td><span className="iam-st-lbl">{t('iam.members.col.places')}:</span>{m.places > 0
                      ? (<button type="button" className="iam-linkbtn iam-places-btn" onClick={() => setPlacesOf(m)}>{tn('iam.members.places', m.places)}<span className="iam-sr">{t('iam.members.placesOf', { name: m.name })}</span></button>)
                      : '–'}</td> : null}
                    <td className="iam-muted iam-small iam-st-hide" title={m.lastSeenAt ? fmtDateTime(m.lastSeenAt) : undefined}>{m.lastSeenAt ? relTime(m.lastSeenAt) : t('iam.members.never')}</td>
                    <td className="iam-acts">
                      <div className="iam-row-acts">
                        <Button size="sm" className="iam-roles-btn" icon={fixed ? 'eye' : 'edit'} onClick={() => setEditing(m)} aria-label={t(fixed ? 'iam.members.viewRoles' : 'iam.members.editRoles', { name: m.name })}>{t(fixed ? 'iam.members.view' : 'iam.members.roles')}</Button>
                        <Menu label={t('iam.members.actions', { name: m.name })} buttonLabel={t('iam.members.more', { name: m.name })} title={t('iam.common.more')} className="iam-iconbtn iam-sm" fixed button={<Icon name="more" className="iam-ico" />}>
                          {close => <>
                            <MenuItem icon="lock" label={t('iam.members.clearance.set')} why={levelBlock(m)} onPick={() => { close(); setLeveling(m); }} />
                            {inv ? <>
                              <MenuItem icon="send" label={t('iam.members.resend')} why={resend.isPending ? t('iam.members.resending') : null} onPick={() => { close(); resend.mutate(m); }} />
                              {link ? <MenuItem icon="copy" label={t('iam.members.copyLink')} onPick={() => { close(); copyLink(link, m); }} /> : null}
                            </> : null}
                            <div className="iam-menu-sep" role="separator" />
                            <MenuItem icon="x" danger label={t(client ? 'iam.members.client.revoke' : inv ? 'iam.members.withdraw' : 'iam.members.remove')} why={removeBlock(m)} onPick={() => { close(); setRemoving(m); }} />
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
      {inviting ? <AddDialog connected={connected} ctx={ctx} onClose={() => setInviting(false)} onDone={async () => { await refresh(); }} /> : null}
      {granting ? <ClientDialog ctx={ctx} onClose={() => setGranting(false)} onDone={async id => { setGranting(false); await refresh(); toast.show(t('iam.members.client.granted', { id, org: orgLabel })); }} /> : null}
      {editing ? (editing.kind === 'client'
        ? <ClientDialog ctx={ctx} member={editing} onClose={() => setEditing(null)} onDone={async id => { setEditing(null); await refresh(); toast.show(t('iam.roles.saved', { name: id, org: orgLabel })); }} />
        : <RolesDialog ctx={ctx} member={editing} activeAdmins={admins} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); }} />) : null}
      {leveling ? <ClearanceDialog ctx={ctx} member={leveling} onClose={() => setLeveling(null)} onSaved={async () => { setLeveling(null); await refresh(); }} /> : null}
      {placesOf ? <PlacesDialog member={placesOf} orgLabel={orgLabel} onClose={() => setPlacesOf(null)} /> : null}
      {removing ? <RemoveConfirm member={removing} orgLabel={orgLabel} busy={remove.isPending} error={remove.error} onClose={() => { remove.reset(); setRemoving(null); }} onConfirm={() => remove.mutate(removing)} /> : null}
    </section>
  );
}

/** Entfernen, Einladung zurückziehen bzw. Freigabe eines Clients entziehen: Folgen klar benannt, Fokus startet auf «Abbrechen». */
function RemoveConfirm({ member: m, orgLabel, busy, error, onClose, onConfirm }: { member: Member; orgLabel: string; busy: boolean; error: Error | null; onClose: () => void; onConfirm: () => void }) {
  const v = { name: m.name, org: orgLabel, id: m.id };
  const kind = m.kind === 'client' ? 'client' : m.status !== 'invited' ? 'remove' : m.loginPath ? 'withdrawEntra' : 'withdraw';
  const [title, confirm, text, note] = {
    client: ['iam.members.client.revoke.title', 'iam.members.client.revoke.confirm', 'iam.members.client.revoke.text', 'iam.members.client.revoke.note'],
    remove: ['iam.members.remove.title', 'iam.members.remove.confirm', 'iam.members.remove.text', 'iam.members.remove.note'],
    withdraw: ['iam.members.withdraw.title', 'iam.members.withdraw.confirm', 'iam.members.withdraw.text', 'iam.members.withdraw.note'],
    withdrawEntra: ['iam.members.withdraw.title', 'iam.members.withdraw.confirm', 'iam.members.withdrawEntra.text', 'iam.members.withdrawEntra.note'],
  }[kind] as [Parameters<typeof t>[0], Parameters<typeof t>[0], Parameters<typeof t>[0], Parameters<typeof t>[0]];
  return (
    <Confirm title={t(title, v)} confirm={t(confirm)} danger busy={busy} onClose={onClose} onConfirm={onConfirm}>
      <p>{t(text, v)}</p>
      <p className="iam-muted iam-small">{t(note)}</p>
      {error ? <AccessError error={error} compact /> : null}
    </Confirm>
  );
}

/** Orte eines Mitglieds mit Rolle und Ablauf («+3 Orte», `GET /v1/access?subject=`). */
function PlacesDialog({ member, orgLabel, onClose }: { member: Member; orgLabel: string; onClose: () => void }) {
  const { Dialog, Button, Table } = useIamUi();
  const authz = useAuthz();
  const placeName = usePlaceName();
  const q = useSubjectAccess(subjectOf(member));
  const items = (q.data ?? []).filter(e => e.place.type !== 'org');
  return (
    <Dialog title={t('iam.members.placesTitle', { name: member.name, org: orgLabel })} onClose={onClose} width={600}
      footer={<Button variant="primary" data-autofocus onClick={onClose}>{t('iam.common.close')}</Button>}>
      {q.isPending ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !items.length ? <p className="iam-muted">{t('iam.members.placesNone')}</p> : (
        <div className="iam-tblwrap">
          <Table stack>
            <caption className="iam-sr">{t('iam.members.placesTitle', { name: member.name, org: orgLabel })}</caption>
            <thead><tr><th scope="col">{t('iam.members.places.col.place')}</th><th scope="col">{t('iam.access.col.role')}</th><th scope="col">{t('iam.access.col.until')}</th><th scope="col" className="iam-acts"><span className="iam-sr">{t('iam.access.col.actions')}</span></th></tr></thead>
            <tbody>
              {items.map(e => {
                const place = placeName(e.place);
                return (
                  <tr key={e.id ?? `${e.place.type}:${e.place.id}:${e.relation}`}>
                    <td>{place}</td>
                    <td><span className="iam-st-lbl">{t('iam.access.col.role')}:</span>{authz.relationLabel(e.relation)}</td>
                    <td><span className="iam-st-lbl">{t('iam.access.col.until')}:</span>{e.expiresAt ? fmtDate(e.expiresAt) : '–'}</td>
                    <td className="iam-acts"><OpenPlace place={e.place} label={place} /></td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
      <p className="iam-note">{t('iam.members.placesNote')}</p>
    </Dialog>
  );
}

export interface RolePickerProps {
  roles: RoleInfo[];
  value: ReadonlySet<string>;
  onChange: (v: Set<string>) => void;
  platform: boolean;
  idBase: string;
  /**
   * Rechte der handelnden Person an der Organisation: Rollen mit weiteren Rechten sind gesperrt (vergeben und entziehen,
   * «niemand gibt mehr, als er hat»). Ohne Angabe keine Obergrenze (Plattformansicht).
   */
  own?: ReadonlySet<string> | null;
  /** Bisherige Rollen (Rollendialog): eine gesperrte, schon vergebene Rolle bleibt gewählt. */
  before?: readonly string[];
}

/**
 * Rollenauswahl: eine Zeile je Rolle, gruppiert – Kontrollkästchen, Label und die ganze Beschreibung (bricht um, ohne
 * Aufklappen). Ist eine Rolle in einer gewählten enthalten (ihre Rechte sind eine echte Teilmenge, roles.ts), steht statt
 * eines Kontrollkästchens ein Haken mit der Markierung «in … enthalten». Ist Organisations-Admin gewählt, steht statt der
 * übrigen Rollen eine Zeile «Enthält alle anderen Rollen». org-admin vergibt nur die Plattform-Administration: ohne
 * Kontrollkästchen, gekennzeichnet. Rollen mit Rechten, die ich nicht habe, sind gesperrt mit Grund.
 */
export function RolePicker({ roles, value, onChange, platform, idBase, own = null, before = [] }: RolePickerProps) {
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
              const over = locked ? [] : exceeding(r, own);
              const within = includedIn(r.key, value, map);
              const implied = !locked && !over.length && within.length > 0;
              const id = `${idBase}-${r.key}`;
              const mark = locked ? t('iam.rolePick.platformOnly') : over.length ? t('iam.rolePick.exceeds', { perms: listAnd(over.map(p => `«${authz.permLabel(p)}»`)) })
                : implied ? t('iam.rolePick.within', { roles: listAnd(within.map(name)) }) : null;
              const on = value.has(r.key) || (over.length > 0 && before.includes(r.key));
              return (
                <li key={r.key} className={`iam-rp-r${implied ? ' iam-is-implied' : ''}${locked || over.length ? ' iam-is-locked' : ''}${on && !implied ? ' iam-is-on' : ''}`}>
                  {locked || implied ? <span className="iam-rp-ctl" aria-hidden="true"><Icon name={locked ? 'shield' : 'check'} className="iam-ico" /></span>
                    : <input id={id} type="checkbox" className="iam-rp-ctl" checked={on} disabled={over.length > 0} aria-describedby={`${id}-s${mark ? ` ${id}-m` : ''}`}
                      onChange={e => { const n = new Set(value); if (e.target.checked) n.add(r.key); else n.delete(r.key); onChange(n); }} />}
                  <span className="iam-rp-t">
                    {locked || implied ? <span className="iam-rp-l" id={id}>{r.label}</span> : <label htmlFor={id} className="iam-rp-l">{r.label}</label>}
                    <span id={`${id}-s`} className="iam-rp-s">{r.description}</span>
                  </span>
                  {mark ? <span id={`${id}-m`} className={`iam-rp-mark${locked || over.length ? ' iam-locked' : ''}`}><span className="iam-sr">, </span>{mark}</span> : null}
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
function DialogRights({ roles, before, scopes }: { roles: ReadonlySet<string>; before?: readonly string[]; scopes?: readonly string[] }) {
  return (
    <div className="iam-role-rights">
      <h4>{t('iam.members.rights')}</h4>
      <RightsOverview roles={[...roles]} before={before} scopes={scopes} note />
    </div>
  );
}

/**
 * Rollen ansehen: kein Formular – Rollen als Karten (Label und Kurzbeschreibung, ganze Beschreibung als title), darunter
 * die Rechte-Übersicht aus den Rollen (keine Rechte an Orten) und eingeklappt «Rollen vergleichen».
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
      <RightsOverview roles={member.roles} note />
      <RoleCompare roles={roles} highlight={member.roles} highlightAs="selected" />
    </div>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Vorgabe beim Einladen: `inviteRoles` der App (nur Rollen, die es gibt und die ich vergeben darf), sonst die Rolle mit
 * den wenigsten Rechten ausser org-admin (z. B. Leser:in); bei Gleichstand gilt die Reihenfolge des Katalogs.
 */
function defaultRoles(ctx: ListCtx, configured: string[] | undefined): string[] {
  const allowed = (r: RoleInfo) => (ctx.platform || !r.adminOnly) && !exceeding(r, ctx.own).length;
  if (configured) return configured.filter(k => ctx.roles.some(r => r.key === k && allowed(r)));
  const least = ctx.roles.filter(r => r.key !== ADMIN && allowed(r)).sort((a, b) => a.permissions.length - b.permissions.length)[0];
  return least ? [least.key] : [];
}

interface DialogProps { ctx: ListCtx; onClose: () => void; onDone: () => Promise<void> }

/** «Person hinzufügen»: mit Entra-Verbindung zuerst die Suche im Verzeichnis, daneben «Per E-Mail einladen»; sonst einladen. */
function AddDialog({ connected, ...p }: DialogProps & { connected: boolean }) {
  const [email, setEmail] = useState(!connected);
  return email ? <InviteDialog {...p} /> : <EntraAddDialog {...p} onEmail={() => setEmail(true)} />;
}

/**
 * Person aus Microsoft Entra ID hinzufügen: suchen (ab 2 Zeichen, verzögert), eine wählbare Person auswählen – nicht
 * wählbare stehen ausgegraut mit Grund –, Rollen wie beim Einladen, E-Mail oder nur Link. Danach ist die Person sofort
 * Mitglied und «eingeladen», bis sie sich über Microsoft anmeldet.
 */
function EntraAddDialog({ ctx, onClose, onDone, onEmail }: DialogProps & { onEmail: () => void }) {
  const { alias, orgLabel, roles, platform } = ctx;
  const { Dialog, Button, Icon, toast } = useIamUi();
  const { inviteRoles } = useIamConfig();
  const fid = useId();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => { const h = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(h); }, [q]);
  const hits = useQuery({ queryKey: [...iamKeys.members(alias), 'entra-search', term], enabled: term.length >= 2, staleTime: 30_000, queryFn: ({ signal }) => memberApi(alias).entraSearch(term, signal) });
  const [picked, setPicked] = useState<EntraCandidate | null>(null);
  const [sel, setSel] = useState<Set<string>>(() => new Set(defaultRoles(ctx, inviteRoles)));
  const [sendEmail, setSendEmail] = useState(true);
  const [result, setResult] = useState<EntraAddResult | null>(null);
  const add = useMutation({
    mutationFn: (body: EntraAddInput) => memberApi(alias).addFromEntra(body),
    onSuccess: async r => {
      await onDone();
      if (r.emailSent) { toast.show(t('iam.entraAdd.added', { name: r.member.name, org: orgLabel })); onClose(); }
      else setResult(r);
    },
  });
  const submit = () => {
    if (!picked) { document.getElementById(`${fid}-q`)?.focus(); return; }
    add.mutate({ id: picked.id, roles: [...sel], sendEmail });
  };
  const detail = (c: { jobTitle: string | null; department: string | null }) => [c.jobTitle, c.department].filter(Boolean).join(' · ');
  if (result) {
    /** Link zum Weitergeben (Anmeldung über Microsoft für Personen, die sich noch nie angemeldet haben). */
    const link = authLink(result.member.loginPath);
    const names = roleNames(result.member.roles, roles);
    return (
      <Dialog title={t('iam.entraAdd.doneTitle', { name: result.member.name })} onClose={onClose} width={560} footer={<Button variant="primary" data-autofocus onClick={onClose}>{t('iam.common.close')}</Button>}>
        <p>{t(names.length ? (names.length === 1 ? 'iam.entraAdd.doneRole' : 'iam.entraAdd.doneRoles') : 'iam.entraAdd.done', { name: result.member.name, org: orgLabel, roles: names.join(', ') })}</p>
        {sendEmail ? <div className="iam-warnbox" role="alert"><Icon name="warn" className="iam-ico" /><span>{t('iam.entraAdd.noMail')}</span></div> : null}
        {link ? <>
          <label htmlFor={`${fid}-link`}>{t('iam.entraAdd.link')}</label>
          <div className="iam-entra-link">
            <input id={`${fid}-link`} className="iam-inp iam-mono-s" readOnly value={link} onFocus={e => e.target.select()} />
            <Button icon="copy" onClick={() => { void navigator.clipboard?.writeText(link).then(() => toast.show(t('iam.entraAdd.copied')), () => undefined); }}>{t('iam.entraAdd.copy')}</Button>
          </div>
          <p className="iam-muted iam-small">{t('iam.entraAdd.linkHint')}</p>
        </> : null}
      </Dialog>
    );
  }
  const items = hits.data?.items ?? [];
  return (
    <Dialog title={t('iam.entraAdd.title', { org: orgLabel })} onClose={onClose} onSubmit={submit} width={600}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" disabled={!picked} busy={add.isPending}>{add.isPending ? <Loading inline label={t('iam.entraAdd.adding')} /> : <><Icon name="plus" className="iam-ico" />{t('iam.entraAdd.confirm')}</>}</Button></>}>
      <p className="iam-muted iam-small">{t('iam.entraAdd.intro')}</p>
      {!picked ? <>
        <label className="iam-search iam-entra-search"><Icon name="search" className="iam-ico" /><span className="iam-sr">{t('iam.entraAdd.search')}</span>
          <input id={`${fid}-q`} type="search" placeholder={t('iam.entraAdd.searchHint')} value={q} onChange={e => setQ(e.target.value)} autoComplete="off" data-autofocus /></label>
        <div aria-live="polite" className="iam-entra-hits-wrap">
          {term.length < 2 ? <p className="iam-muted iam-small">{t('iam.entraAdd.min')}</p>
            : hits.isPending ? <Loading inline label={t('iam.entraAdd.searching')} />
            : hits.error ? <ErrorBox error={hits.error} compact />
            : !items.length ? <p className="iam-muted iam-small">{t('iam.entraAdd.none')}</p>
            : <ul className="iam-entra-hits" aria-label={t('iam.entraAdd.hits')}>
                {items.map(c => (
                  <li key={c.id}>
                    <button type="button" className="iam-entra-hit" aria-disabled={c.selectable ? undefined : true} onClick={() => { if (c.selectable) setPicked(c); }} aria-describedby={c.reason ? `${fid}-${c.id}-r` : undefined}>
                      <span className="iam-b">{c.name}</span><span className="iam-mono-s iam-muted">{c.email}</span>
                      {detail(c) ? <span className="iam-muted iam-small">{detail(c)}</span> : null}
                      {c.reason ? <span id={`${fid}-${c.id}-r`} className="iam-small iam-entra-why">{c.reason}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>}
          {hits.data?.more ? <p className="iam-note">{t('iam.entraAdd.more')}</p> : null}
        </div>
        <p className="iam-muted iam-small">{t('iam.entraAdd.external')} <button type="button" className="iam-linkbtn" onClick={onEmail}>{t('iam.entraAdd.byEmail')}</button></p>
      </> : <>
        <div className="iam-entra-picked">
          <span className="iam-b">{picked.name}</span><span className="iam-mono-s iam-muted">{picked.email}</span>
          {detail(picked) ? <span className="iam-muted iam-small">{detail(picked)}</span> : null}
          <button type="button" className="iam-linkbtn" onClick={() => { setPicked(null); add.reset(); }}>{t('iam.entraAdd.other')}</button>
        </div>
        <RolePicker roles={roles} value={sel} onChange={setSel} platform={platform} own={ctx.own} idBase={`${fid}-r`} />
        {sel.size ? null : <p className="iam-note">{t('iam.invite.noRole')}</p>}
        <DialogRights roles={sel} />
        <label className="iam-chk iam-entra-mail" htmlFor={`${fid}-mail`}><input id={`${fid}-mail`} type="checkbox" checked={sendEmail} onChange={e => setSendEmail(e.target.checked)} /> {t('iam.entraAdd.sendMail')}</label>
        <p className="iam-muted iam-small">{t(sendEmail ? 'iam.entraAdd.mailHint' : 'iam.entraAdd.noMailHint')}</p>
      </>}
      {add.error ? <AccessError error={add.error} /> : null}
    </Dialog>
  );
}

function InviteDialog({ ctx, onClose, onDone }: DialogProps) {
  const { alias, orgLabel, roles, platform } = ctx;
  const { Dialog, Button, Icon, toast } = useIamUi();
  const fid = useId();
  const [d, setD] = useState({ email: '', firstName: '', lastName: '' });
  const { inviteRoles } = useIamConfig();
  const [sel, setSel] = useState<Set<string>>(() => new Set(defaultRoles(ctx, inviteRoles)));
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
      <RolePicker roles={roles} value={sel} onChange={setSel} platform={platform} own={ctx.own} idBase={`${fid}-r`} />
      {sel.size ? null : <p className="iam-note">{t('iam.invite.noRole')}</p>}
      <DialogRights roles={sel} />
      {send.error ? <AccessError error={send.error} /> : null}
    </Dialog>
  );
}

/**
 * Rollen einer Person. Die Rollen von Organisations-Admins ändert nur die Plattform-Administration (die API lehnt jede
 * Änderung an org-admin ab, alle übrigen Rollen sind darin enthalten): dann nur ansehen, mit «Schliessen». Sonst Auswahl
 * mit Rechte-Übersicht und «+ n Rechte, − m Rechte».
 */
function RolesDialog({ ctx, member, activeAdmins, onClose, onSaved }: { ctx: ListCtx; member: Member; activeAdmins: number; onClose: () => void; onSaved: () => Promise<void> }) {
  const { alias, orgLabel, roles, platform, self } = ctx;
  const { Dialog, Button, Icon, toast } = useIamUi();
  const authz = useAuthz();
  const fid = useId();
  const viewOnly = !platform && member.roles.includes(ADMIN);
  const [sel, setSel] = useState<Set<string>>(() => new Set(member.roles));
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    // nur Rollen, die es (noch) gibt: eine aus dem Modell entfernte Rolle würde sonst 422 auslösen
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
        <p className="iam-note" role="note">{t('iam.roles.adminOnlyPlatform', { role: name(ADMIN) })}</p>
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
        <RolePicker roles={roles} value={sel} onChange={setSel} platform={platform} own={ctx.own} before={member.roles} idBase={`${fid}-r`} />
        {lastBlock ? <p id={`${fid}-last`} className="iam-ferr" role="alert"><Icon name="warn" className="iam-ico" />{lastBlock}</p> : null}
        <DialogRights roles={sel} before={member.roles} />
        {save.error && !confirming ? <AccessError error={save.error} /> : null}
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

/** Auswahl der Freigabestufe: Stufen über der eigenen sind gesperrt (ausser in der Plattformansicht). */
function LevelSelect({ id, value, onChange, ownClearance, describedBy }: { id: string; value: Level; onChange: (l: Level) => void; ownClearance: Level; describedBy?: string }) {
  const authz = useAuthz();
  return (
    <select id={id} className="iam-inp" value={value} onChange={e => onChange(Number(e.target.value) as Level)} aria-describedby={describedBy}>
      {LEVELS.map(l => <option key={l} value={l} disabled={l > ownClearance && l !== value}>{authz.classificationLabel(l)}{l > ownClearance ? ` – ${t('iam.access.classification.overOwn')}` : ''}</option>)}
    </select>
  );
}

/** Freigabestufe einer Person oder eines Clients setzen (9.6): nie für sich selbst, nie über die eigene ohne Break-Glass; senken geht. */
function ClearanceDialog({ ctx, member, onClose, onSaved }: { ctx: ListCtx; member: Member; onClose: () => void; onSaved: () => Promise<void> }) {
  const { Dialog, Button, toast } = useIamUi();
  const authz = useAuthz();
  const fid = useId();
  const [level, setLevel] = useState<Level>(member.clearance);
  const save = useMutation({
    mutationFn: async () => {
      if (member.kind === 'user') return void (await memberApi(ctx.alias).setClearance(member.id, level));
      // Beschreibung fehlt im Aufruf: sie bleibt
      await clientApi(ctx.alias).put(member.id, { roles: member.roles, clearance: level });
    },
    onSuccess: async () => { toast.show(t('iam.members.clearance.saved', { name: member.name, org: ctx.orgLabel, level: authz.classificationLabel(level) })); await onSaved(); },
  });
  // Nie über die eigene Freigabestufe (9.1 Nr. 7); eine höhere bisherige darf ich senken
  const above = level > ctx.ownClearance ? t('iam.members.clearance.above', { level: authz.classificationLabel(level), own: authz.classificationLabel(ctx.ownClearance) }) : null;
  return (
    <Dialog title={t('iam.members.clearance.title', { name: member.name, org: ctx.orgLabel })} onClose={onClose} onSubmit={() => { if (!above) save.mutate(); }} width={480}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" busy={save.isPending} aria-disabled={above ? true : undefined} aria-describedby={above ? `${fid}-a` : undefined}>{t('iam.common.save')}</Button></>}>
      <p className="iam-muted iam-small">{t('iam.members.clearance.intro')}</p>
      <div className="iam-form iam-compact">
        <label htmlFor={`${fid}-l`}>{t('iam.members.col.clearance')}</label>
        <LevelSelect id={`${fid}-l`} value={level} onChange={setLevel} ownClearance={ctx.ownClearance} describedBy={`${fid}-h`} />
        <div id={`${fid}-h`} className="iam-muted iam-small">{ctx.platform ? t('iam.members.clearance.platform') : t('iam.members.clearance.own', { own: authz.classificationLabel(ctx.ownClearance) })}</div>
      </div>
      {above ? <p id={`${fid}-a`} className="iam-ferr" role="alert">{above}</p> : null}
      {save.error ? <AccessError error={save.error} /> : null}
    </Dialog>
  );
}

/**
 * Maschinen-Client freigeben bzw. seine Rollen ändern (`PUT /v1/admin/clients/{clientId}`, 9.6): Client-ID wie im
 * Realm-Modul, Beschreibung, Rollen an der Organisation (mindestens eine), Freigabestufe. Ohne Freigabe weist die API
 * seine Tokens ab (403), auch wenn Keycloak die Organisation ins Token schreibt.
 */
function ClientDialog({ ctx, member, onClose, onDone }: { ctx: ListCtx; member?: Member; onClose: () => void; onDone: (clientId: string) => Promise<void> }) {
  const { alias, orgLabel, roles, platform } = ctx;
  const { Dialog, Button, Icon } = useIamUi();
  const fid = useId();
  const [d, setD] = useState({ clientId: member?.id ?? '', description: member?.description ?? '' });
  const description = d.description;
  const [sel, setSel] = useState<Set<string>>(() => new Set(member?.roles ?? []));
  const [level, setLevel] = useState<Level>(member?.clearance ?? 0);
  const [errs, setErrs] = useState<{ id?: string; roles?: string }>({});
  const put = useMutation({
    mutationFn: () => clientApi(alias).put(d.clientId.trim(), { roles: [...sel], description: description.trim(), clearance: level }),
    onSuccess: () => onDone(d.clientId.trim()),
  });
  const submit = () => {
    const e: typeof errs = {};
    if (!CLIENT_ID.test(d.clientId.trim())) e.id = t('iam.members.client.idInvalid');
    if (!sel.size) e.roles = t('iam.members.client.roleMissing');
    setErrs(e);
    if (e.id) { document.getElementById(`${fid}-id`)?.focus(); return; }
    if (e.roles) return;
    put.mutate();
  };
  return (
    <Dialog title={member ? t('iam.roles.dialog', { name: member.name, org: orgLabel }) : t('iam.members.client.title', { org: orgLabel })} onClose={onClose} onSubmit={submit} width={600}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" icon="check" busy={put.isPending}>{member ? t('iam.common.save') : t('iam.members.client.confirm')}</Button></>}>
      <p className="iam-muted iam-small">{t('iam.members.client.intro', { org: orgLabel })}</p>
      <div className="iam-form iam-compact">
        <label htmlFor={`${fid}-id`}>{t('iam.members.client.id')}</label>
        <input id={`${fid}-id`} className="iam-inp iam-mono-s" value={d.clientId} readOnly={!!member} onChange={e => setD({ ...d, clientId: e.target.value })} required autoComplete="off" data-autofocus={member ? undefined : true}
          aria-invalid={errs.id ? true : undefined} aria-describedby={errs.id ? `${fid}-e` : undefined} />
        {errs.id ? <div id={`${fid}-e`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{errs.id}</div> : null}
        <label htmlFor={`${fid}-d`}>{t('iam.members.client.description')}</label>
        <input id={`${fid}-d`} className="iam-inp" value={description} maxLength={500} onChange={e => setD({ ...d, description: e.target.value })} autoComplete="off" />
        <label htmlFor={`${fid}-l`}>{t('iam.members.col.clearance')}</label>
        <LevelSelect id={`${fid}-l`} value={level} onChange={setLevel} ownClearance={ctx.ownClearance} />
      </div>
      <RolePicker roles={roles} value={sel} onChange={s => { setSel(s); setErrs({ ...errs, roles: undefined }); }} platform={platform} own={ctx.own} before={member?.roles} idBase={`${fid}-r`} />
      {errs.roles ? <p className="iam-ferr" role="alert"><Icon name="warn" className="iam-ico" />{errs.roles}</p> : null}
      <DialogRights roles={sel} before={member?.roles} scopes={member?.scopes ?? undefined} />
      {put.error ? <AccessError error={put.error} /> : null}
    </Dialog>
  );
}
