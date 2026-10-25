/**
 * Rechte-Übersicht (Spezifikation 11.2): ein Baustein für die Frage «Was darf ⟨wer⟩ – und warum?». Der Aufrufer wählt
 * den Blickwinkel nur über die Eingaben:
 *
 * - ich:                  `roles={me.roles} permissions={me.permissions} somewhere={me.somewhere}`
 * - Person:               `roles={member.roles}` (aus den Rollen an der Organisation, keine Rechte anderer an Orten)
 * - Rolle(n):             `roles={['editor', 'viewer']}`
 * - Maschinen-Client:     `roles={client.roles} scopes={client.lastScopes}` – erlaubt ist nur Rolle ∧ Scope
 * - Assistent:            `roles={me.roles} permissions={me.permissions} scopes={…}`
 *
 * Props: `roles`, `permissions` (Rechte an der Organisation; ohne Angabe: Rechte der Rollen), `somewhere` (Rechte an
 * mindestens einem Ort), `scopes` (`[]` = kein Scope), `admin` (Sonderfall Organisations-Admin, Standard aus `roles`),
 * `headingLevel`, `note` (Satz unter der Liste), `before` (Rollen bisher: Änderung «+ x, − y» und Markierung).
 *
 * Darstellung: «Darf n von m» mit Satz, Gruppen aus dem Katalog mit Zählung, je Recht Status `role` (erlaubt über Rolle
 * an der Organisation), `place` (nur an einzelnen Orten), `scope` (fehlt im Scope) oder `missing` und «Warum?». Ab 10
 * Rechten Umschalter «Alle / Erlaubt / Fehlt» und Suche. Organisations-Admin als ein Satz «Alle Rechte.», Liste erst auf
 * «Rechte anzeigen».
 */
import { createElement, useId, useState, type ReactNode } from 'react';
import { useAuthz, type Authz } from '../authz.ts';
import type { CatalogRole, PermissionInfo, ScopeInfo } from '../contract.ts';
import { ADMIN_ROLE } from '../permissions.ts';
import { listAnd, listOr, t, tn } from '../texts/index.ts';
import { formatNode } from '../texts/node.tsx';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import type { IamIconName } from '../ui/icons.ts';
import { Loading } from '../ui/states.tsx';

/** `role`: über eine Rolle an der Organisation; `place`: nur an einzelnen Orten; `scope`: fehlt im Scope; `missing`: fehlt. */
export type RightStatus = 'role' | 'place' | 'scope' | 'missing';

/** Erlaubt (an der Organisation oder an einzelnen Orten). */
export const isAllowed = (s: RightStatus): boolean => s === 'role' || s === 'place';

export interface RightRow {
  perm: PermissionInfo;
  status: RightStatus;
  /** Übergebene Rollen, die das Recht enthalten. */
  givenBy: CatalogRole[];
  /** Scopes, die das Recht freigeben (bei übergebenen Scopes zuerst die vorhandenen). */
  scopes: ScopeInfo[];
}

export interface RightsInput {
  roles?: readonly string[];
  permissions?: readonly string[];
  scopes?: readonly string[];
  /** Rechte an mindestens einem Ort (`somewhere` aus /auth/me); was nur hier steht, ist `place`. */
  somewhere?: readonly string[];
  admin?: boolean;
}

/** Kurzbeschreibung einer Rolle: der erste Teil der Beschreibung bis «;» oder «:» (ganze Beschreibung als title). */
export function roleSummary(description: string): string {
  return description.split(/[;:]/)[0]!.trim().replace(/\.$/, '');
}

/** Status je Recht in Katalogreihenfolge; ohne Katalog leer. Auch für Zählungen ausserhalb der Ansicht. */
export function rightsModel(authz: Authz, { roles = [], permissions, somewhere, scopes, admin }: RightsInput): RightRow[] {
  const cat = authz.catalog;
  if (!cat) return [];
  const isAdmin = admin ?? roles.includes(ADMIN_ROLE);
  const own = authz.groupRoles(cat.roles.filter(r => roles.includes(r.key))).flatMap(g => g.roles);
  const fromRoles = new Set(own.flatMap(r => r.permissions));
  const has = isAdmin ? new Set(cat.permissions.map(p => p.key)) : new Set<string>(permissions ?? fromRoles);
  const some = new Set(somewhere ?? []);
  const tok = scopes ? new Set(scopes) : null;
  return cat.permissions.map(perm => {
    const sc = cat.scopes.filter(s => s.permissions.includes(perm.key));
    const scopeOk = !tok || sc.some(s => tok.has(s.key));
    const status: RightStatus = !has.has(perm.key) && !some.has(perm.key) ? 'missing' : !scopeOk ? 'scope' : has.has(perm.key) ? 'role' : 'place';
    return { perm, status, givenBy: own.filter(r => r.permissions.includes(perm.key)), scopes: tok ? [...sc.filter(s => tok.has(s.key)), ...sc.filter(s => !tok.has(s.key))] : sc };
  });
}

const STATUS_ICON: Record<RightStatus, IamIconName> = { role: 'check', place: 'layers', scope: 'key', missing: 'x' };
const statusText = (s: RightStatus) => t(`iam.rights.status.${s}`);

type Filter = 'all' | 'allowed' | 'missing';
const FILTERS: Filter[] = ['all', 'allowed', 'missing'];
/** Ab so vielen Rechten Umschalter und Suche. */
const FILTER_FROM = 10;

const q = (s: string) => `«${s}»`;

function Why({ row, authz, scoped }: { row: RightRow; authz: Authz; scoped: boolean }) {
  const { perm, status, givenBy, scopes } = row;
  const roleLine = status === 'missing'
    ? (() => {
      const all = authz.rolesWith(perm.key);
      if (!all.length) return t('iam.rights.why.noRole');
      return all.length === 1 ? t('iam.rights.why.onlyRole', { role: all[0]!.label }) : t('iam.rights.why.roles', { roles: listAnd(all.map(r => q(r.label))) });
    })()
    : status === 'place' ? t('iam.rights.why.place')
      : givenBy.length ? tn('iam.rights.why.givenBy', givenBy.length, { roles: listAnd(givenBy.map(r => q(r.label))) }) : t('iam.rights.why.session');
  const scopeText = (s: ScopeInfo) => <span key={s.key} title={t('iam.rights.scopeTitle', { key: s.key })}>{q(s.text)}</span>;
  let scopeLine: ReactNode = null;
  if (scoped) {
    const ok = isAllowed(status) ? scopes.slice(0, 1) : [];
    if (!scopes.length) scopeLine = t('iam.rights.why.noScope');
    else if (ok.length) scopeLine = formatNode(t('iam.rights.why.scopeOk'), { scope: scopeText(ok[0]!) });
    else {
      // Aufzählung mit «oder» nach Sprache, die Scopes als Elemente mit title
      const marks = scopes.map((_, i) => `\u0000${i}\u0000`);
      const list = listOr(marks).split(/\u0000(\d+)\u0000/).map((p, i) => (i % 2 ? scopeText(scopes[Number(p)]!) : p));
      scopeLine = formatNode(t('iam.rights.why.scopeNeeded'), { scopes: <>{list}</> });
    }
  }
  return (
    <dl className="iam-rights-why-l">
      <div><dt>{t('iam.rights.why.right')}</dt><dd>{perm.description}</dd></div>
      <div><dt>{status === 'missing' ? t('iam.rights.why.missing') : t('iam.rights.why.gives')}</dt><dd>{roleLine}</dd></div>
      {scopeLine ? <div><dt>{t('iam.rights.why.scope')}</dt><dd>{scopeLine}</dd></div> : null}
      <div className="iam-rights-why-key"><dt>{t('iam.rights.why.key')}</dt><dd>{perm.key}</dd></div>
    </dl>
  );
}

type Change = 'add' | 'del';
/** Ab mehr als so vielen Änderungen ist die Liste der Änderungen eingeklappt. */
const CHANGES_OPEN_MAX = 10;
const nRights = (n: number) => tn('iam.rights.n', n);

/** Änderung gegenüber bisher: «+ x Rechte, − y Rechte» und die betroffenen Rechte als kompakte Liste (Katalogreihenfolge). */
function Changes({ rows, changes, groupLabel, id }: { rows: RightRow[]; changes: Map<string, Change>; groupLabel: (k: string) => string | undefined; id: string }) {
  const changed = rows.filter(r => changes.has(r.perm.key));
  const add = changed.filter(r => changes.get(r.perm.key) === 'add').length;
  const [open, setOpen] = useState(false);
  const shown = changed.length <= CHANGES_OPEN_MAX || open;
  return (
    <>
      <p className="iam-rights-delta" aria-live="polite">
        {changed.length
          ? <span><span className="iam-rights-add">+ {nRights(add)}</span>, <span className="iam-rights-del">− {nRights(changed.length - add)}</span> <span className="iam-muted">{t('iam.rights.delta.since')}</span></span>
          : <span className="iam-muted">{t('iam.rights.delta.none')}</span>}
        {changed.length > CHANGES_OPEN_MAX ? (
          <button type="button" className="iam-linkbtn" aria-expanded={open} aria-controls={`${id}-chg`} onClick={() => setOpen(v => !v)}>{open ? t('iam.rights.delta.hide') : t('iam.rights.delta.show')}</button>
        ) : null}
      </p>
      {changed.length ? (
        <ul id={`${id}-chg`} className="iam-rights-chg" aria-label={t('iam.rights.delta.label', { add: nRights(add), del: nRights(changed.length - add) })} hidden={!shown}>
          {shown ? changed.map(r => {
            const c = changes.get(r.perm.key)!;
            const g = groupLabel(r.perm.group);
            return (
              <li key={r.perm.key} className={`iam-is-${c}`}>
                <span className="iam-rights-chg-ico" aria-hidden="true">{c === 'add' ? '+' : '−'}</span>
                <span className="iam-sr">{c === 'add' ? t('iam.rights.delta.newSr') : t('iam.rights.delta.goneSr')}</span>
                <span className="iam-rights-chg-l">{r.perm.label}</span>
                {g ? <span className="iam-muted">{g}</span> : null}
              </li>
            );
          }) : null}
        </ul>
      ) : null}
    </>
  );
}

export interface RightsOverviewProps extends RightsInput {
  /** Satz unter der Liste: `true` = Standardsatz (Rechte an einzelnen Orten), ReactNode = eigener Satz. */
  note?: ReactNode;
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Rollen bisher (Rollendialog): Änderung gegenüber bisher. */
  before?: readonly string[];
}

export function RightsOverview({ roles = [], permissions, somewhere, scopes, note, admin, headingLevel = 5, before }: RightsOverviewProps) {
  const authz = useAuthz();
  const { Icon } = useIamUi();
  useIamText();
  const id = useId();
  const [filter, setFilter] = useState<Filter>('all');
  const [term, setTerm] = useState('');
  const [why, setWhy] = useState<ReadonlySet<string>>(new Set());
  const [showAdmin, setShowAdmin] = useState(false);
  const cat = authz.catalog;
  if (!cat) return <Loading inline />;

  const isAdmin = admin ?? roles.includes(ADMIN_ROLE);
  const rows = rightsModel(authz, { roles, permissions, somewhere, scopes, admin: isAdmin });
  const n = rows.filter(r => isAllowed(r.status)).length;
  const byScope = rows.filter(r => r.status === 'scope').length;
  const byPlace = rows.filter(r => r.status === 'place').length;
  const roleNames = authz.groupRoles(cat.roles.filter(r => roles.includes(r.key))).flatMap(g => g.roles.map(r => r.label));
  const who = roleNames.length ? listAnd(roleNames) : roles.length ? listAnd([...roles]) : t('iam.rights.noRole');
  const sentence = scopes
    ? `${t('iam.rights.scoped', { who })}${byScope ? ` ${tn('iam.rights.scopeMissing', byScope)}` : ''}`
    : t('iam.rights.who', { who });
  const placeNote = byPlace ? ` ${tn('iam.rights.placeOnly', byPlace)}` : '';
  const adminShort = isAdmin && !scopes;
  const toggle = (key: string) => setWhy(s => { const x = new Set(s); if (!x.delete(key)) x.add(key); return x; });
  const groupLabel = (k: string) => cat.groups.find(g => g.key === k)?.label;
  const changes = new Map<string, Change>();
  if (before) {
    const was = new Set(rightsModel(authz, { roles: before, scopes }).filter(r => isAllowed(r.status)).map(r => r.perm.key));
    for (const r of rows) {
      if (isAllowed(r.status) && !was.has(r.perm.key)) changes.set(r.perm.key, 'add');
      else if (!isAllowed(r.status) && was.has(r.perm.key)) changes.set(r.perm.key, 'del');
    }
  }

  const head = (
    <div className="iam-rights-head">
      <p className="iam-rights-n" aria-live={before ? 'polite' : undefined}><b>{t('iam.rights.count', { n, m: rows.length })}</b> <span className="iam-muted">– {sentence}{placeNote}</span></p>
      {adminShort ? (
        <p className="iam-rights-admin">
          <Icon name="shield" className="iam-ico" /><span>{t('iam.rights.admin')}</span>
          <button type="button" className="iam-linkbtn" aria-expanded={showAdmin} aria-controls={`${id}-list`} onClick={() => setShowAdmin(v => !v)}>{showAdmin ? t('iam.rights.hide') : t('iam.rights.show')}</button>
        </p>
      ) : null}
      {before ? <Changes rows={rows} changes={changes} groupLabel={groupLabel} id={id} /> : null}
    </div>
  );
  if (adminShort && !showAdmin) return <div className="iam-rights">{head}<div id={`${id}-list`} hidden /></div>;

  const term_ = term.trim().toLowerCase();
  const visible = rows.filter(r => (filter === 'all' || (filter === 'allowed') === isAllowed(r.status))
    && (!term_ || [r.perm.label, r.perm.description, r.perm.key].some(s => s.toLowerCase().includes(term_))));
  const groups = cat.groups.map(g => ({ ...g, all: rows.filter(r => r.perm.group === g.key), rows: visible.filter(r => r.perm.group === g.key) })).filter(g => g.rows.length);
  const count = (f: Filter) => (f === 'all' ? rows.length : rows.filter(r => (f === 'allowed') === isAllowed(r.status)).length);
  const tools = rows.length >= FILTER_FROM && !adminShort;
  const adminRole = cat.roles.find(r => r.key === ADMIN_ROLE)?.label ?? ADMIN_ROLE;

  return (
    <div className="iam-rights">
      {head}
      {tools ? (
        <div className="iam-rights-tools">
          <div className="iam-seg iam-xs" role="group" aria-label={t('iam.rights.filter.label')}>
            {FILTERS.map(k => (
              <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{t(`iam.rights.filter.${k}`)} <span className="iam-mono-s iam-muted">{count(k)}</span></button>
            ))}
          </div>
          <label className="iam-search iam-rights-search"><Icon name="search" className="iam-ico" /><span className="iam-sr">{t('iam.rights.search')}</span>
            <input type="search" placeholder={t('iam.rights.search.placeholder')} value={term} onChange={e => setTerm(e.target.value)} autoComplete="off" /></label>
        </div>
      ) : null}
      {adminShort ? <p className="iam-rights-why-all iam-muted iam-small">{t('iam.rights.adminFrom', { role: adminRole })}</p> : null}
      <div id={`${id}-list`} className="iam-rights-groups">
        {groups.length ? groups.map(g => {
          const gn = g.all.filter(r => isAllowed(r.status)).length;
          return (
            <section key={g.key} className="iam-rights-g" aria-labelledby={`${id}-${g.key}`}>
              {createElement(`h${headingLevel}`, { className: 'iam-rights-gh', id: `${id}-${g.key}` },
                <span>{g.label}</span>, <span className="iam-rights-gc"><span aria-hidden="true">{gn}/{g.all.length}</span><span className="iam-sr">{t('iam.rights.groupCount', { n: gn, m: g.all.length })}</span></span>)}
              <ul className="iam-rights-list">
                {g.rows.map(r => {
                  const wid = `${id}-${r.perm.key}`;
                  const wOpen = why.has(r.perm.key);
                  const c = changes.get(r.perm.key);
                  return (
                    <li key={r.perm.key} className={`iam-rights-r iam-is-${r.status}${c ? ` iam-is-${c}` : ''}`}>
                      <span className="iam-rights-ico"><Icon name={STATUS_ICON[r.status]} className="iam-ico" /></span>
                      <span className="iam-rights-l">{r.perm.label}{c ? <span className="iam-rights-tag"><span className="iam-sr">, </span>{t(`iam.rights.tag.${c}`)}</span> : null}</span>
                      <span className="iam-rights-st">{statusText(r.status)}</span>
                      {adminShort ? null : <>
                        <button type="button" className="iam-rights-wb" aria-label={t('iam.rights.whyFor', { label: r.perm.label })} aria-expanded={wOpen} aria-controls={wid} onClick={() => toggle(r.perm.key)}>{t('iam.rights.why')}</button>
                        <div id={wid} className="iam-rights-why" hidden={!wOpen}>{wOpen ? <Why row={r} authz={authz} scoped={!!scopes} /> : null}</div>
                      </>}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        }) : <p className="iam-muted iam-small iam-rights-empty">{t('iam.rights.empty')}</p>}
      </div>
      {note && !isAdmin ? <p className="iam-note">{note === true ? t('iam.rights.placesNote') : note}</p> : null}
    </div>
  );
}
