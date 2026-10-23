/**
 * Verwalten › Maschinen-Clients (Spezifikation 9.3): welche Maschinen-Clients aus Keycloak (dort: Service Accounts)
 * diese Organisation benutzen dürfen. Ein Token eines Maschinen-Clients gilt nur in Organisationen, die seine Client-ID
 * hier freigegeben haben – auch wenn Keycloak eine Organisation ins Token schreibt. Dieselbe Liste nutzt die
 * Plattform-Administration für eine beliebige Organisation (`alias`). Herkunft: vollholz/assets
 * `web/src/features/admin/Clients.tsx`.
 *
 * Je Client Rollen und Scopes, wie sein Token sie zuletzt trug (`lastRoles`, `lastScopes`), aufklappbar als
 * Rechte-Übersicht (Rolle ∧ Scope), und «Rechte prüfen» (Seite «Zugriff», Ansicht «Rechte prüfen»).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment, useId, useState } from 'react';
import { clientApi, useClientGrants } from '../admin.ts';
import { useAuthz } from '../authz.ts';
import { useIamConfig } from '../config.tsx';
import type { ClientGrant } from '../contract.ts';
import { fmtDateTime, relTime } from '../format.ts';
import { iamKeys } from '../keys.ts';
import { AdminHead } from '../rights/AdminHead.tsx';
import { RightsOverview, rightsModel } from '../rights/RightsOverview.tsx';
import { useIam } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { MenuItem } from '../ui/MenuButton.tsx';
import { Confirm } from '../ui/Overlay.tsx';
import { Empty, ErrorBox, ErrorState, SkeletonRows } from '../ui/states.tsx';

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;

/** «Rechte prüfen» auf der Seite «Zugriff» mit diesem Client (Suchparameter wie in Assets). */
export const checkRightsHref = (access: string, clientId: string) => `${access}?ansicht=pruefen&client=${encodeURIComponent(clientId)}`;

/** Seite «Maschinen-Clients» (Recht `members:admin` prüft der Guard der Route). */
export function ClientsPage() {
  const { orgName: org } = useIam();
  const { Button } = useIamUi();
  useIamText();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <AdminHead icon="key" title={t('iam.clients.title')} sub={t('iam.clients.sub', { org })}
        actions={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>{t('iam.clients.grant')}</Button>} />
      <div className="iam-body"><div className="iam-int"><ClientList alias={null} orgLabel={org} adding={adding} onAdding={setAdding} /></div></div>
      <div className="iam-cli iam-api"><span className="iam-cli-label">API</span><code>GET /v1/admin/clients · PUT /v1/admin/clients/&#123;clientId&#125; · DELETE /v1/admin/clients/&#123;clientId&#125;</code></div>
    </>
  );
}

export interface ClientListProps {
  /** Organisation der Plattform-Administration; `null` = die eigene. */
  alias: string | null;
  orgLabel: string;
  /** Freigeben von aussen gesteuert (Hauptaktion im Seitenkopf); ohne steht die Aktion im Kopf des Abschnitts. */
  adding?: boolean;
  onAdding?: (v: boolean) => void;
}

/** Tabelle der freigegebenen Maschinen-Clients mit Freigeben und Entziehen. */
export function ClientList({ alias, orgLabel, adding: addingOuter, onAdding }: ClientListProps) {
  const q = useClientGrants(alias);
  const qc = useQueryClient();
  const { Button, Icon, Menu, Table, toast } = useIamUi();
  const { features, paths, router: { Link } } = useIamConfig();
  const { canSomewhere } = useIam();
  const authz = useAuthz();
  useIamText();
  const fid = useId();
  const [addingOwn, setAddingOwn] = useState(false);
  const adding = onAdding ? !!addingOuter : addingOwn;
  const setAdding = onAdding ?? setAddingOwn;
  const [revoking, setRevoking] = useState<ClientGrant | null>(null);
  const [openRights, setOpenRights] = useState<ReadonlySet<string>>(new Set());
  const toggleRights = (id: string) => setOpenRights(s => { const x = new Set(s); if (!x.delete(id)) x.add(id); return x; });
  const refresh = () => qc.invalidateQueries({ queryKey: iamKeys.clients(alias) });
  // «Rechte prüfen» nur für die eigene Organisation und nur mit Zugriffsregeln (Seite «Zugriff», Recht acl:read)
  const acl = features.acl ?? !!authz.catalog?.permissions.some(p => p.key === 'acl:read');
  const check = alias === null && acl && canSomewhere('acl:read');
  const revoke = useMutation({
    mutationFn: (c: ClientGrant) => clientApi(alias).revoke(c.clientId),
    onSuccess: async (_r, c) => { setRevoking(null); await refresh(); toast.show(t('iam.clients.revoked', { id: c.clientId, org: orgLabel })); },
  });
  return (
    <section aria-labelledby={`${fid}-h`}>
      <div className="iam-sec-h iam-wrap"><h2 id={`${fid}-h`}>{t('iam.clients.list')}</h2><span>{q.data ? `${q.data.length}` : ''}</span>
        {onAdding ? null : <><span className="iam-spacer" /><Button variant="primary" icon="plus" onClick={() => setAdding(true)}>{t('iam.clients.grant')}</Button></>}</div>
      {q.isPending ? <SkeletonRows rows={3} cols={4} /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data.length ? (
        <Empty icon="key" title={t('iam.clients.none.title')}>{t('iam.clients.none.text', { org: orgLabel })}</Empty>
      ) : (
        <div className="iam-tblwrap">
          <Table stack>
            <caption className="iam-sr">{t('iam.clients.caption', { org: orgLabel })}</caption>
            <thead><tr><th scope="col">{t('iam.clients.col.id')}</th><th scope="col">{t('iam.clients.col.description')}</th><th scope="col">{t('iam.clients.col.rights')}</th><th scope="col" className="iam-st-hide">{t('iam.clients.col.granted')}</th><th scope="col" className="iam-acts"><span className="iam-sr">{t('iam.members.col.actions')}</span></th></tr></thead>
            <tbody>
              {q.data.map(c => {
                const open = openRights.has(c.clientId);
                const rid = `${fid}-r-${c.clientId}`;
                return (
                  <Fragment key={c.clientId}>
                    <tr>
                      <td className="iam-mono-s iam-b">{c.clientId}</td>
                      <td>{c.description || <span className="iam-muted iam-small">—</span>}</td>
                      <td><ClientRights c={c} open={open} controls={rid} onToggle={() => toggleRights(c.clientId)} /></td>
                      <td className="iam-muted iam-small iam-st-hide" title={fmtDateTime(c.createdAt)}>{relTime(c.createdAt)}{c.createdBy ? ` · ${c.createdBy}` : ''}</td>
                      <td className="iam-acts"><div className="iam-row-acts">
                        {check ? <Link to={checkRightsHref(paths.access, c.clientId)} className="iam-btn iam-sm"><Icon name="shield" className="iam-ico" />{t('iam.clients.check')}<span className="iam-sr">: {c.clientId}</span></Link> : null}
                        <Menu label={t('iam.members.actions', { name: c.clientId })} buttonLabel={t('iam.members.more', { name: c.clientId })} title={t('iam.common.more')} className="iam-iconbtn iam-sm" fixed button={<Icon name="more" className="iam-ico" />}>
                          {close => <MenuItem icon="x" label={t('iam.clients.revoke')} danger onPick={() => { close(); setRevoking(c); }} />}
                        </Menu>
                      </div></td>
                    </tr>
                    {open && c.lastRoles && c.lastScopes ? (
                      <tr id={rid} className="iam-static">
                        <td colSpan={5}>
                          <div className="iam-pad"><RightsOverview roles={c.lastRoles} scopes={c.lastScopes} headingLevel={3}
                            rulesNote={<>{t('iam.clients.lastToken', { when: relTime(c.lastUsedAt) })} {t('iam.rights.rulesNote')}</>} /></div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
      {adding ? <GrantDialog alias={alias} orgLabel={orgLabel} onClose={() => setAdding(false)} onDone={async id => { setAdding(false); await refresh(); toast.show(t('iam.clients.granted', { id, org: orgLabel })); }} /> : null}
      {revoking ? (
        <Confirm title={t('iam.clients.revoke.title', { id: revoking.clientId, org: orgLabel })} confirm={t('iam.clients.revoke.confirm')} danger busy={revoke.isPending} onClose={() => { revoke.reset(); setRevoking(null); }} onConfirm={() => revoke.mutate(revoking)}>
          <p>{t('iam.clients.revoke.text', { org: orgLabel })}</p>
          {revoke.error ? <ErrorBox error={revoke.error} compact /> : null}
        </Confirm>
      ) : null}
    </section>
  );
}

/** Rollen (Labels) und Scopes (Texte) aus dem letzten Token, Zeitpunkt und «Darf n von m» zum Aufklappen. */
function ClientRights({ c, open, controls, onToggle }: { c: ClientGrant; open: boolean; controls: string; onToggle: () => void }) {
  const authz = useAuthz();
  const { Icon } = useIamUi();
  if (!c.lastUsedAt) return <span className="iam-muted iam-small">{t('iam.clients.neverUsed')}</span>;
  const seen = <span className="iam-muted iam-small" title={fmtDateTime(c.lastUsedAt)}>{t('iam.clients.lastSeen', { when: relTime(c.lastUsedAt) })}</span>;
  // Zuletzt benutzt, bevor der Server Rollen und Scopes festhielt: Zeitpunkt bekannt, Rollen und Scopes nach dem nächsten Zugriff
  if (!c.lastRoles || !c.lastScopes) return <div className="iam-opt-list">{seen}<span className="iam-muted iam-small">{t('iam.clients.rightsLater')}</span></div>;
  const rows = rightsModel(authz, { roles: c.lastRoles, scopes: c.lastScopes });
  const n = rows.filter(r => r.status === 'allowed').length;
  return (
    <div className="iam-opt-list">
      {c.lastRoles.length
        ? <ul className="iam-role-tags" aria-label={t('iam.members.rolesOf', { name: c.clientId })}>{c.lastRoles.map(r => <li key={r} className="iam-role-tag" title={t('iam.clients.roleTitle', { key: r })}>{authz.roleLabel(r)}</li>)}</ul>
        : <span className="iam-muted iam-small">{t('iam.clients.noRole')}</span>}
      {/* Je Scope eine Zeile: die Texte enthalten selbst Kommas, aneinandergereiht wären die Grenzen nicht erkennbar */}
      {c.lastScopes.length
        ? <ul className="iam-client-scopes iam-small" aria-label={t('iam.clients.scopesOf', { id: c.clientId })}>{c.lastScopes.map(s => <li key={s} title={t('iam.rights.scopeTitle', { key: s })}><Icon name="key" className="iam-ico" />{authz.scopeText(s) || s}</li>)}</ul>
        : <span className="iam-muted iam-small">{t('iam.clients.noScope')}</span>}
      {seen}
      {rows.length ? (
        <button type="button" className="iam-linkbtn" aria-expanded={open} aria-controls={open ? controls : undefined} onClick={onToggle} style={{ alignSelf: 'flex-start' }}>
          {t(open ? 'iam.clients.rightsHide' : 'iam.clients.rightsShow', { n, m: rows.length })}<span className="iam-sr">, {c.clientId}</span>
        </button>
      ) : null}
    </div>
  );
}

function GrantDialog({ alias, orgLabel, onClose, onDone }: { alias: string | null; orgLabel: string; onClose: () => void; onDone: (clientId: string) => Promise<void> }) {
  const { Dialog, Button, Icon } = useIamUi();
  const fid = useId();
  const [d, setD] = useState({ clientId: '', description: '' });
  const [err, setErr] = useState<string | null>(null);
  const grant = useMutation({ mutationFn: () => clientApi(alias).grant(d.clientId.trim(), d.description.trim()), onSuccess: () => onDone(d.clientId.trim()) });
  const submit = () => {
    if (!CLIENT_ID.test(d.clientId.trim())) { setErr(t('iam.clients.idInvalid')); document.getElementById(`${fid}-id`)?.focus(); return; }
    setErr(null);
    grant.mutate();
  };
  return (
    <Dialog title={t('iam.clients.grant.title', { org: orgLabel })} onClose={onClose} onSubmit={submit} width={560}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" icon="check" busy={grant.isPending}>{t('iam.clients.grant.confirm')}</Button></>}>
      <p className="iam-muted iam-small">{t('iam.clients.grant.intro', { org: orgLabel })}</p>
      <div className="iam-form iam-compact">
        <label htmlFor={`${fid}-id`}>{t('iam.clients.col.id')}</label>
        <input id={`${fid}-id`} className="iam-inp iam-mono-s" value={d.clientId} onChange={e => setD({ ...d, clientId: e.target.value })} required autoComplete="off" data-autofocus aria-invalid={err ? true : undefined} aria-describedby={err ? `${fid}-e` : undefined} />
        {err ? <div id={`${fid}-e`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{err}</div> : null}
        <label htmlFor={`${fid}-d`}>{t('iam.clients.col.description')}</label>
        <input id={`${fid}-d`} className="iam-inp" value={d.description} maxLength={500} onChange={e => setD({ ...d, description: e.target.value })} autoComplete="off" />
      </div>
      {grant.error ? <ErrorBox error={grant.error} /> : null}
    </Dialog>
  );
}
