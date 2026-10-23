/**
 * Verwalten › Zugriff (Spezifikation 7.1, 11.2): zwei Reiter nach ARIA-Muster Tabs, Reiter in der URL (`ansicht`).
 * «Zugriffsregeln»: Einträge (freigeben, beschränken auf, verbieten je Ressource) mit Filtern in der URL; ohne
 * Zugriffsregeln ein einzeiliger leerer Zustand. «Rechte prüfen»: Simulator (Check.tsx). Rechte = (Rolle ∨ Freigabe) ∧
 * Scope ∧ Zugriffsregel; Personen mit org-admin sind von Zugriffsregeln ausgenommen, Maschinen-Clients nicht. Ohne
 * `acl:admin` sagt der Kopf, welches Recht zum Hinzufügen fehlt; eine unbekannte Ressource im Filter (Link aus einer
 * anderen Organisation, gelöscht) erscheint als «Nicht gefunden» statt als rohe ID. Suchparameter wie in Assets
 * (`ansicht`, `resourceType`, `resourceId`, `permission`, `who`, `client`, `rolle`), damit Links weiter gelten.
 * Herkunft: vollholz/assets `web/src/features/acl/Access.tsx`, Namen der Ressourcen über den Adapter `resources`.
 */
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Fragment, useId, useRef, useState, type KeyboardEvent } from 'react';
import { aclResourceTypes, effectOf, effectText, EFFECT_PILL, filterEntries, groupByResource, ineffectiveReason, whoKey } from '../acl/rules.ts';
import { aclApi, principalLabel, PrincipalLabel, useAclEntries, usePermLabel, useResources, useWhoText } from '../acl/shared.tsx';
import { useAuthz, useRoles } from '../authz.ts';
import { useIamConfig } from '../config.tsx';
import type { AclEntry } from '../contract.ts';
import { fmtDateTime, relTime, shortId } from '../format.ts';
import { iamKeys } from '../keys.ts';
import { isPrincipalId } from '../people.tsx';
import { AdminHead } from '../rights/AdminHead.tsx';
import { MissingRight } from '../rights/MissingRight.tsx';
import { useIam } from '../session.tsx';
import { t, tn } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { MenuItem } from '../ui/MenuButton.tsx';
import { Confirm } from '../ui/Overlay.tsx';
import { ErrorBox, ErrorState, NotFound, SkeletonRows } from '../ui/states.tsx';
import { AddEntry } from './AddEntry.tsx';
import { Check } from './Check.tsx';

type Tab = 'regeln' | 'pruefen';
const TABS: Tab[] = ['regeln', 'pruefen'];

/** Suchparameter der Zugriffsseite als Text (Router-Adapter): lesen und ersetzen (`replace`, kein neuer Verlaufseintrag). */
export function useAccessSearch() {
  const { router: { useSearch, usePathname, navigate } } = useIamConfig();
  const raw = useSearch();
  const pathname = usePathname();
  const s = new URLSearchParams(raw);
  const get = (k: string) => s.get(k) || undefined;
  /** Setzt oder entfernt Parameter (`undefined`); `fresh` beginnt mit leerer Suche. */
  const go = (next: Record<string, string | undefined>, fresh = false) => {
    const n = fresh ? new URLSearchParams() : new URLSearchParams(raw);
    for (const [k, v] of Object.entries(next)) { if (v) n.set(k, v); else n.delete(k); }
    const q = n.toString();
    navigate(q ? `${pathname}?${q}` : pathname, { replace: true });
  };
  return { get, go };
}

/** Seite «Zugriff» (Recht `acl:read` prüft der Guard der Route). */
export function AccessPage() {
  const { can, orgName: org } = useIam();
  const { Button } = useIamUi();
  useIamText();
  const search = useAccessSearch();
  const admin = can('acl:admin');
  const tab: Tab = search.get('ansicht') === 'pruefen' ? 'pruefen' : 'regeln';
  const [adding, setAdding] = useState(false);
  const q = useAclEntries();
  const tabsId = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Reiterwechsel verwirft die Angaben des anderen Reiters (Filter bzw. «Wer?»)
  const pick = (k: Tab) => search.go(k === 'pruefen' ? { ansicht: 'pruefen' } : {}, true);
  // Pfeiltasten, Pos1 und Ende wechseln den Reiter (nur der aktive ist in der Tab-Reihenfolge)
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab);
    const n = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    const k = TABS[n]!;
    pick(k);
    tabRefs.current[k]?.focus();
  };

  return (
    <>
      <AdminHead icon="shield" title={t('iam.acl.title')} sub={t('iam.acl.sub', { org })}
        actions={admin && tab === 'regeln' ? <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>{t('iam.acl.add')}</Button> : null}>
        {admin || tab !== 'regeln' ? null : <MissingRight perm="acl:admin" lead={t('iam.acl.missingAdmin')} />}
        <div className="iam-tabs iam-scroll" role="tablist" aria-label={t('iam.acl.title')}>
          {TABS.map(k => (
            <button key={k} ref={el => { tabRefs.current[k] = el; }} type="button" role="tab" id={`${tabsId}-${k}`} aria-controls={`${tabsId}-p`} aria-selected={tab === k} tabIndex={tab === k ? 0 : -1}
              className={`iam-tab${tab === k ? ' iam-on' : ''}`} onClick={() => pick(k)} onKeyDown={onTabKey}>
              {t(k === 'regeln' ? 'iam.acl.tab.rules' : 'iam.acl.tab.check')}{k === 'regeln' && q.data ? <span className="iam-cnt">{q.data.length}</span> : null}
            </button>
          ))}
        </div>
      </AdminHead>
      <div className="iam-body" role="tabpanel" id={`${tabsId}-p`} aria-labelledby={`${tabsId}-${tab}`}><div className="iam-int">
        {tab === 'regeln' ? <Rules q={q} admin={admin} onAdd={() => setAdding(true)} /> : <Check />}
      </div></div>
      <div className="iam-cli iam-api"><span className="iam-cli-label">API</span><code tabIndex={0}>{tab === 'regeln' ? 'GET /v1/acl · POST /v1/acl · DELETE /v1/acl/{id}' : 'GET /v1/acl/effective · GET /v1/authz/catalog'}</code></div>
      {adding ? <AddEntry entries={q.data ?? []} onClose={() => setAdding(false)} /> : null}
    </>
  );
}

/** Reiter «Zugriffsregeln»: Filter, nach Ressource gruppierte Liste, Entfernen. */
function Rules({ q, admin, onAdd }: { q: UseQueryResult<AclEntry[]>; admin: boolean; onAdd: () => void }) {
  const authz = useAuthz();
  const { orgName: org } = useIam();
  const { Button, Icon, Menu, Table, toast } = useIamUi();
  const search = useAccessSearch();
  const f = { resourceType: search.get('resourceType'), resourceId: search.get('resourceId'), permission: search.get('permission'), who: search.get('who') };
  const qc = useQueryClient();
  const res = useResources();
  const who = useWhoText();
  const perm = usePermLabel();
  // Eigene Rollen der Organisation (aus dem Zwischenspeicher, den useAuthz füllt): erst damit sind unbekannte `c-…` wirkungslos
  const customRoles = useRoles(false);
  const [del, setDel] = useState<AclEntry | null>(null);
  // Fehler bleiben im Dialog, damit der Bezug zum Eintrag erhalten bleibt
  const remove = useMutation({
    mutationFn: (id: string) => aclApi.remove(id),
    // Wirkt sofort, auch auf die eigenen Rechte (/auth/me)
    onSuccess: async () => { setDel(null); await Promise.all([qc.invalidateQueries({ queryKey: iamKeys.acl }), qc.invalidateQueries({ queryKey: iamKeys.me })]); toast.show(t('iam.acl.removed', { org })); },
    // Schon entfernt oder nicht mehr erlaubt (404, 403): Liste neu laden, der Fehler bleibt im Dialog
    onError: () => void qc.invalidateQueries({ queryKey: iamKeys.acl }),
  });
  const closeDel = () => { remove.reset(); setDel(null); };

  const all = q.data ?? [];
  const shown = filterEntries(all, f);
  const groups = groupByResource(shown, authz.catalog);
  const filtered = !!(f.resourceType || f.resourceId || f.permission || f.who);
  // Auswahl für die Filter aus den vorhandenen Einträgen (Ressource eingeschränkt auf den gewählten Typ)
  const resOpts = groupByResource(all.filter(e => e.resourceId && (!f.resourceType || e.resourceType === f.resourceType)), authz.catalog);
  const permOpts = [...new Set(all.map(e => e.permission as string))];
  const whoOpts = [...new Map(all.map(e => [whoKey(e), e])).values()];
  const whoText = (e: AclEntry) => (e.principalType === 'role' ? t('iam.acl.whoRole', { role: authz.roleLabel(e.principalRef) })
    : `${principalLabel(e.principalType)} ${e.principalType !== 'user' ? e.principalRef : who(e).startsWith('«') ? who(e) : isPrincipalId(e.principalRef) ? shortId(e.principalRef) : e.principalRef}`);
  // Ressource im Filter, die es hier nicht gibt: verständlich benannt statt roher ID
  const unknownRes = !!f.resourceId && res.known(f.resourceType ?? '', f.resourceId) === false;
  const resName = (type: string, id: string | null) => (id && res.known(type, id) === false ? t('iam.acl.unknownRes', { id: shortId(id) }) : res.name(type, id));
  // Eindeutiger Name je Zeile für das Menü: Recht, Wirkung, Wer und Ressource
  const rowName = (e: AclEntry) => t('iam.acl.rowName', { perm: perm(e.permission), verb: effectText(effectOf(e), 'verb'), who: whoText(e),
    res: e.resourceType === 'tenant' ? t('iam.acl.wholeOrgDative') : resName(e.resourceType, e.resourceId) });
  const reset = () => search.go({ resourceType: undefined, resourceId: undefined, permission: undefined, who: undefined });

  // Ohne Zugriffsregeln eine Zeile statt Filter und Tabelle
  if (q.data && !all.length && !filtered) return (
    <p className="iam-acl-none"><Icon name="shield" className="iam-ico" /><span><b>{t('iam.acl.none')}</b> <span className="iam-muted">{t('iam.acl.noneText')}</span></span>
      {admin ? <Button size="sm" icon="plus" onClick={onAdd}>{t('iam.acl.add')}</Button> : null}</p>
  );

  return (
    <>
      <section aria-label={t('iam.acl.tab.rules')}>
        <form className="iam-acl-filters" role="search" aria-label={t('iam.acl.filter')} onSubmit={e => e.preventDefault()}>
          <label className="iam-sel"><span>{t('iam.acl.f.type')}</span><select className="iam-inp" value={f.resourceType ?? ''} onChange={e => search.go({ resourceType: e.target.value || undefined, resourceId: undefined })}>
            <option value="">{t('iam.acl.f.all')}</option>{aclResourceTypes(authz.catalog).map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
          {resOpts.length || f.resourceId ? (
            <label className="iam-sel"><span>{t('iam.acl.f.one')}</span><select className="iam-inp" value={f.resourceId ?? ''} onChange={e => { const g = resOpts.find(x => x.resourceId === e.target.value); search.go({ resourceId: e.target.value || undefined, ...(g ? { resourceType: g.resourceType } : {}) }); }}>
              <option value="">{f.resourceType ? t('iam.acl.f.allOf', { type: authz.resourceLabel(f.resourceType) }) : t('iam.acl.f.all')}</option>
              {f.resourceId && !resOpts.some(g => g.resourceId === f.resourceId) ? <option value={f.resourceId}>{resName(f.resourceType ?? '', f.resourceId)}</option> : null}
              {resOpts.map(g => <option key={g.key} value={g.resourceId ?? ''}>{f.resourceType ? '' : `${authz.resourceLabel(g.resourceType)}: `}{resName(g.resourceType, g.resourceId)}</option>)}</select></label>
          ) : null}
          <label className="iam-sel"><span>{t('iam.acl.f.perm')}</span><select className="iam-inp" value={f.permission ?? ''} onChange={e => search.go({ permission: e.target.value || undefined })}>
            <option value="">{t('iam.acl.f.all')}</option>
            {f.permission && !permOpts.includes(f.permission) ? <option value={f.permission}>{perm(f.permission)}</option> : null}
            {permOpts.map(p => <option key={p} value={p}>{perm(p)}</option>)}</select></label>
          <label className="iam-sel"><span>{t('iam.acl.f.who')}</span><select className="iam-inp" value={f.who ?? ''} onChange={e => search.go({ who: e.target.value || undefined })}>
            <option value="">{t('iam.acl.f.all')}</option>
            {f.who && !whoOpts.some(e => whoKey(e) === f.who) ? <option value={f.who}>{f.who}</option> : null}
            {whoOpts.map(e => <option key={whoKey(e)} value={whoKey(e)}>{whoText(e)}</option>)}</select></label>
          {filtered ? <Button size="sm" variant="ghost" onClick={reset}>{t('iam.acl.reset')}</Button> : null}
          <span className="iam-acl-count">{q.data ? (filtered ? t('iam.acl.countOf', { n: shown.length, all: all.length }) : tn('iam.acl.count', all.length)) : ''}</span>
        </form>
        {unknownRes ? <NotFound org={org} detail={t('iam.acl.unknownFilter', { type: authz.resourceLabel(f.resourceType ?? ''), id: shortId(f.resourceId) })}
          action={<Button onClick={reset}>{t('iam.acl.resetFilter')}</Button>} /> : null}
        {unknownRes ? null : q.isPending ? <SkeletonRows rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} org={org} /> : shown.length ? (
          <div className="iam-tblwrap">
            <Table stack aria-label={t('iam.acl.tab.rules')}>
              <thead><tr><th scope="col">{t('iam.acl.col.who')}</th><th scope="col">{t('iam.acl.col.perm')}</th><th scope="col">{t('iam.acl.col.effect')}</th><th scope="col" className="iam-st-hide">{t('iam.acl.col.created')}</th><th scope="col" className="iam-acts"><span className="iam-sr">{t('iam.members.col.actions')}</span></th></tr></thead>
              <tbody>
                {groups.map(g => (
                  <Fragment key={g.key}>
                    <tr className="iam-grp iam-static"><th scope="colgroup" colSpan={5}>{g.resourceType === 'tenant' ? t('iam.acl.wholeOrg') : <><span className="iam-muted iam-small">{authz.resourceLabel(g.resourceType)}</span> {resName(g.resourceType, g.resourceId)}</>}<span className="iam-cnt">{g.items.length}</span></th></tr>
                    {g.items.map(e => {
                      const why = authz.catalog ? ineffectiveReason(e, authz.catalog, res.leaves, { customRoles: !!customRoles.data }) : null;
                      const eff = effectOf(e);
                      return (
                        <tr key={e.id}>
                          <td><span className="iam-muted iam-small">{principalLabel(e.principalType)}</span><div><PrincipalLabel e={e} /></div></td>
                          <td>{perm(e.permission)}<div className="iam-mono-s iam-muted">{e.permission}</div></td>
                          <td>
                            <span className={`iam-pill iam-sm ${EFFECT_PILL[eff]}`} title={effectText(eff, 'hint')}>{effectText(eff, 'label')}</span>
                            {why ? <div><span className="iam-mk iam-warn">{t('iam.acl.ineffective')}</span> <span className="iam-muted iam-small">{why}</span></div> : null}
                          </td>
                          <td className="iam-muted iam-st-hide" title={fmtDateTime(e.createdAt)}>{relTime(e.createdAt)}</td>
                          <td className="iam-acts">{admin ? <div className="iam-row-acts">
                            <Menu label={t('iam.members.actions', { name: rowName(e) })} buttonLabel={t('iam.members.more', { name: rowName(e) })} title={t('iam.common.more')} className="iam-iconbtn iam-sm" fixed button={<Icon name="more" className="iam-ico" />}>
                              {close => <MenuItem icon="trash" danger label={t('iam.acl.remove')} onPick={() => { close(); setDel(e); }} />}
                            </Menu>
                          </div> : null}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </Table>
          </div>
        ) : <p className="iam-acl-none"><Icon name="search" className="iam-ico" /><span className="iam-muted">{t('iam.acl.noHits')}</span><Button size="sm" variant="ghost" onClick={reset}>{t('iam.acl.reset')}</Button></p>}
      </section>
      {del ? (
        // Die Zugriffsregel wird gelöscht (DELETE /v1/acl/{id}): Papierkorb an der Aktion
        <Confirm title={t('iam.acl.remove.title', { org })} confirm={t('iam.acl.remove.confirm')} danger trash busy={remove.isPending} onClose={closeDel} onConfirm={() => remove.mutate(del.id)}>
          <p>{t('iam.acl.remove.text', { perm: perm(del.permission), who: who(del), res: resName(del.resourceType, del.resourceId), org, verb: effectText(effectOf(del), 'verb') })}</p>
          {remove.error ? <ErrorBox error={remove.error} compact /> : null}
        </Confirm>
      ) : null}
    </>
  );
}
