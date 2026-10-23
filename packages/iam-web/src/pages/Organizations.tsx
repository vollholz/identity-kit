/**
 * Verwalten › Organisationen (nur Plattform-Administration, Spezifikation 9.5): Organisationen in Keycloak anlegen,
 * umbenennen, Domänen pflegen, sperren und entsperren sowie Mitglieder (inklusive org-admin) und Maschinen-Clients jeder
 * Organisation verwalten. Die Detailansicht sagt, welche Organisation bearbeitet wird und in welcher die Person
 * angemeldet ist; Kopfzeile und Kontomenü zeigen die eigene. Herkunft: vollholz/assets
 * `web/src/features/admin/Organizations.tsx`; der Abschnitt «Anmeldung (Microsoft Entra ID)» folgt mit der Seite «Anmeldung».
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { orgApi, useAdminStatus, useOrganization, useOrganizations } from '../admin.ts';
import { useIamConfig } from '../config.tsx';
import type { AdminStatus, Organization } from '../contract.ts';
import { fmtDate } from '../format.ts';
import { iamKeys } from '../keys.ts';
import { isCustomRole, PLATFORM_ADMIN } from '../permissions.ts';
import { AdminHead } from '../rights/AdminHead.tsx';
import { NoPermission } from '../rights/MissingRight.tsx';
import { orgName, useIam } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { Empty, ErrorBox, ErrorState, SkeletonRows } from '../ui/states.tsx';
import { ClientList } from './Clients.tsx';
import { MemberList } from './Members.tsx';

const ALIAS = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const splitDomains = (s: string) => s.split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
/** Alias als Vorschlag aus dem Namen: Kleinbuchstaben, Umlaute ohne Zeichen, sonst «-». */
const suggestAlias = (name: string) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
/** Pfad der Detailseite einer Organisation. */
export const organizationPath = (organizations: string, alias: string) => `${organizations}/${encodeURIComponent(alias)}`;

/** Status in der Plattform: «gesperrt» ist die Sperre der Plattform (Keycloak `enabled=false` heisst «deaktiviert»). */
function TenantPill({ o }: { o: Organization }) {
  if (!o.tenant) return <span className="iam-pill iam-sm iam-st-off" title={t('iam.orgs.unusedWhy')}>{t('iam.orgs.unused')}</span>;
  return o.tenant.status === 'suspended' ? <span className="iam-pill iam-sm iam-st-bad">{t('iam.orgs.suspended')}</span> : <span className="iam-pill iam-sm iam-st-ok">{t('iam.members.status.active')}</span>;
}

/**
 * Zugang nur für die Plattform-Administration; sonst dieselbe Seite «Recht fehlt» wie bei fehlenden Rechten
 * (`NoPermission`). `page`: ganze Seite statt Inhalt unter dem eigenen Kopf.
 */
function useGate(title: string): { status: AdminStatus | undefined; gate: ReactNode | null; page: ReactNode | null } {
  const status = useAdminStatus();
  if (status.isPending) return { status: undefined, gate: <SkeletonRows rows={4} />, page: null };
  if (status.error) return { status: undefined, gate: <ErrorState error={status.error} onRetry={() => void status.refetch()} />, page: null };
  if (!status.data.platformAdmin) return { status: status.data, gate: true, page: <NoPermission perm={PLATFORM_ADMIN} icon="building" title={title} /> };
  if (!status.data.enabled) return { status: status.data, gate: <Empty icon="cog" title={t('iam.members.off.title')}>{status.data.reason}</Empty>, page: null };
  return { status: status.data, gate: null, page: null };
}

/** Liste der Organisationen (Plattform-Administration; ohne sie «Recht fehlt»). */
export function OrganizationsPage() {
  const { Button, Icon, Table } = useIamUi();
  const { paths, router } = useIamConfig();
  const { Link } = router;
  useIamText();
  const { gate, page } = useGate(t('iam.orgs.title'));
  const [creating, setCreating] = useState(false);
  const q = useOrganizations(!gate);
  const open = (o: Organization) => router.navigate(organizationPath(paths.organizations, o.alias));
  if (page) return page;
  return (
    <>
      <AdminHead icon="building" title={t('iam.orgs.title')} sub={t('iam.orgs.sub')}
        actions={!gate ? <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>{t('iam.orgs.create')}</Button> : null} />
      <div className="iam-body"><div className="iam-int">
        {gate ?? (q.isPending ? <SkeletonRows rows={4} cols={5} /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data.length ? (
          <Empty icon="building" title={t('iam.orgs.none')} action={<Button variant="primary" onClick={() => setCreating(true)}>{t('iam.orgs.create')}</Button>} />
        ) : (
          <div className="iam-tblwrap">
            <Table stack className="iam-org-tbl">
              <caption className="iam-sr">{t('iam.orgs.title')}</caption>
              <thead><tr><th scope="col">{t('iam.orgs.col.org')}</th><th scope="col">{t('iam.orgs.col.domains')}</th><th scope="col">Keycloak</th><th scope="col">{t('iam.orgs.col.platform')}</th><th scope="col" className="iam-st-hide"><span className="iam-sr">{t('iam.orgs.col.open')}</span></th></tr></thead>
              <tbody>
                {q.data.map(o => (
                  // Ganze Zeile klickbar (Maus); per Tastatur und Screenreader der Link im Namen
                  <tr key={o.id} className="iam-click" onClick={e => { if (!(e.target as HTMLElement).closest('a,button')) open(o); }}>
                    <td><Link to={organizationPath(paths.organizations, o.alias)} className="iam-rowlink iam-b">{o.name}</Link><div className="iam-mono-s iam-muted">{o.alias}</div></td>
                    <td>{o.domains.length ? <div className="iam-tag-list">{o.domains.map(d => <span key={d} className="iam-mono-tag">{d}</span>)}</div> : <span className="iam-muted iam-small">—</span>}</td>
                    <td><span className="iam-st-lbl">Keycloak:</span>{o.enabled ? <span className="iam-pill iam-sm iam-st-ok">{t('iam.members.status.active')}</span> : <span className="iam-pill iam-sm iam-st-bad">{t('iam.members.status.disabled')}</span>}</td>
                    <td><span className="iam-st-lbl">{t('iam.orgs.col.platform')}:</span><TenantPill o={o} /></td>
                    <td className="iam-chev iam-st-hide"><Icon name="chev" className="iam-ico" /></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ))}
      </div></div>
      <div className="iam-cli iam-api"><span className="iam-cli-label">API</span><code>GET /v1/platform/organizations · POST /v1/platform/organizations</code></div>
      {creating ? <CreateOrg onClose={() => setCreating(false)} onCreated={o => { setCreating(false); open(o); }} /> : null}
    </>
  );
}

function CreateOrg({ onClose, onCreated }: { onClose: () => void; onCreated: (o: Organization) => void }) {
  const { Dialog, Button, Icon, toast } = useIamUi();
  const fid = useId();
  const qc = useQueryClient();
  const [d, setD] = useState({ name: '', alias: '', domains: '', description: '' });
  const [aliasTouched, setAliasTouched] = useState(false);
  // Prüfung beim Absenden: Meldung am Feld, Fokus auf das erste fehlerhafte Feld
  const [tried, setTried] = useState(false);
  const nameErr = tried && !d.name.trim() ? t('iam.orgs.nameMissing') : null;
  const aliasErr = d.alias && !ALIAS.test(d.alias) ? t('iam.orgs.aliasInvalid') : tried && !d.alias ? t('iam.orgs.aliasMissing') : null;
  const save = useMutation({
    mutationFn: () => orgApi.create({ alias: d.alias, name: d.name.trim(), domains: splitDomains(d.domains), ...(d.description.trim() ? { description: d.description.trim() } : {}) }),
    onSuccess: async o => { await qc.invalidateQueries({ queryKey: iamKeys.orgs }); toast.show(t('iam.orgs.created', { org: o.name })); onCreated(o); },
  });
  const submit = () => {
    setTried(true);
    const first = !d.name.trim() ? `${fid}-n` : !d.alias || !ALIAS.test(d.alias) ? `${fid}-a` : null;
    if (first) { document.getElementById(first)?.focus(); return; }
    save.mutate();
  };
  return (
    <Dialog title={t('iam.orgs.create')} onClose={onClose} onSubmit={submit} width={600}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" busy={save.isPending}>{t('iam.orgs.createConfirm')}</Button></>}>
      <div className="iam-form iam-compact">
        <label htmlFor={`${fid}-n`}>{t('iam.rolesPage.name')}</label>
        <input id={`${fid}-n`} className="iam-inp" value={d.name} data-autofocus required autoComplete="off" aria-invalid={nameErr ? true : undefined} aria-describedby={nameErr ? `${fid}-n-e` : undefined}
          onChange={e => setD({ ...d, name: e.target.value, alias: aliasTouched ? d.alias : suggestAlias(e.target.value) })} />
        {nameErr ? <div id={`${fid}-n-e`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{nameErr}</div> : null}
        <label htmlFor={`${fid}-a`}>{t('iam.orgs.alias')}</label>
        <input id={`${fid}-a`} className="iam-inp iam-mono" value={d.alias} required autoComplete="off" aria-invalid={aliasErr ? true : undefined} aria-describedby={`${fid}-a-h`} onChange={e => { setAliasTouched(true); setD({ ...d, alias: e.target.value }); }} />
        <div id={`${fid}-a-h`} className={aliasErr ? 'iam-ferr iam-hint' : 'iam-hint'}>{aliasErr ? <><Icon name="warn" className="iam-ico" />{aliasErr}</> : t('iam.orgs.aliasHint')}</div>
        <label htmlFor={`${fid}-d`}>{t('iam.orgs.col.domains')}</label>
        <input id={`${fid}-d`} className="iam-inp iam-mono" value={d.domains} placeholder="firma.ch, firma.com" autoComplete="off" aria-describedby={`${fid}-d-h`} onChange={e => setD({ ...d, domains: e.target.value })} />
        <div id={`${fid}-d-h`} className="iam-hint">{t('iam.orgs.domainsHint')}</div>
        <label htmlFor={`${fid}-b`}>{t('iam.rolesPage.description')}</label>
        <textarea id={`${fid}-b`} className="iam-inp" rows={2} value={d.description} onChange={e => setD({ ...d, description: e.target.value })} />
      </div>
      <p className="iam-note">{t('iam.orgs.next')}</p>
      {save.error ? <ErrorBox error={save.error} /> : null}
    </Dialog>
  );
}

/** Alias aus dem Pfad `<paths.organizations>/<alias>` (ohne Router der App). */
function useAliasFromPath(): string {
  const { paths, router } = useIamConfig();
  const path = router.usePathname();
  const rest = path.startsWith(`${paths.organizations}/`) ? path.slice(paths.organizations.length + 1).split('/')[0]! : '';
  try { return decodeURIComponent(rest); } catch { return rest; }
}

/** Detail einer Organisation; `alias` aus der Route der App oder aus dem Pfad. */
export function OrganizationPage({ alias: given }: { alias?: string }) {
  const fromPath = useAliasFromPath();
  const alias = given ?? fromPath;
  const { Button, Icon } = useIamUi();
  const { paths } = useIamConfig();
  useIamText();
  const { status, gate, page } = useGate(t('iam.orgs.one'));
  const { me } = useIam();
  const q = useOrganization(alias, !gate && !!alias);
  const [statusDlg, setStatusDlg] = useState(false);
  const whyId = useId();
  const o = q.data;
  const crumbs: [string, string][] = [[t('iam.orgs.title'), paths.organizations]];
  if (page) return page;
  // Sperren der Organisation, in der die Person angemeldet ist, lehnt die API ab: gesperrt mit Grund statt ausgeblendet
  const ownOrg = !!o && o.alias === me.tenant?.alias;
  // Beide Namen aus Keycloak: die bearbeitete aus der Plattform-API, die eigene aus dem Token (organizationNames)
  const own = me.tenant ? orgName(me, me.tenant.alias) : '';
  const lockWhy = t('iam.orgs.ownLock');
  return (
    <>
      <AdminHead icon="building" title={o?.name ?? alias} crumbs={crumbs}
        sub={o ? <span className="iam-org-meta">{ownOrg ? <span className="iam-pill iam-sm iam-nodot iam-st-idle">{t('iam.orgs.yours')}</span> : null}<span className="iam-mono-s">{o.alias}</span>
          <span>Keycloak: {t(o.enabled ? 'iam.members.status.active' : 'iam.members.status.disabled')}</span>
          <span>{t('iam.orgs.col.platform')}: {o.tenant ? t('iam.orgs.since', { status: t(o.tenant.status === 'suspended' ? 'iam.orgs.suspended' : 'iam.members.status.active'), date: fmtDate(o.tenant.createdAt) }) : t('iam.orgs.unused')}</span></span> : undefined}
        actions={o && !gate ? (o.tenant?.status === 'suspended' || !o.enabled
          ? <Button icon="reset" onClick={() => setStatusDlg(true)}>{t('iam.orgs.resume')}</Button>
          : <><Button variant="danger" icon="shield" aria-disabled={ownOrg ? true : undefined} aria-describedby={ownOrg ? whyId : undefined} title={ownOrg ? lockWhy : undefined} onClick={() => { if (!ownOrg) setStatusDlg(true); }}>{t('iam.orgs.suspend')}</Button>
            {ownOrg ? <span id={whyId} className="iam-sr">{lockWhy}</span> : null}</>) : null}>
        {o && !ownOrg ? <p className="iam-org-context" role="note"><Icon name="building" className="iam-ico" /><span>{t('iam.orgs.context', { org: o.name, own })}</span></p> : null}
      </AdminHead>
      <div className="iam-body"><div className="iam-int">
        {gate ?? (q.isPending ? <SkeletonRows rows={4} /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} home={paths.organizations} /> : (
          <>
            <OrgForm org={q.data} />
            {/* Rollen: nur die vordefinierten. Eigene Rollen gelten je Organisation, der Status liefert die der eigenen
                Organisation, für eine andere gibt es keinen Endpunkt (Personen mit solchen Rollen nur ansehen). */}
            <MemberList alias={q.data.alias} roles={status!.roles.filter(r => !isCustomRole(r.key))} platform rolesManageable={status!.rolesManageable} self={me.person.subject} orgLabel={q.data.name} />
            {q.data.tenant ? <ClientList alias={q.data.alias} orgLabel={q.data.name} /> : null}
          </>
        ))}
      </div></div>
      {statusDlg && o ? <StatusDialog org={o} onClose={() => setStatusDlg(false)} /> : null}
    </>
  );
}

function OrgForm({ org }: { org: Organization }) {
  const { Button, Icon, toast } = useIamUi();
  const fid = useId();
  const qc = useQueryClient();
  const [d, setD] = useState({ name: org.name, domains: org.domains.join(', '), description: org.description ?? '' });
  const dirty = d.name.trim() !== org.name || splitDomains(d.domains).join() !== org.domains.join() || d.description.trim() !== (org.description ?? '');
  const save = useMutation({
    mutationFn: () => orgApi.update(org.alias, { name: d.name.trim(), domains: splitDomains(d.domains), description: d.description.trim() || null }),
    onSuccess: async o => { qc.setQueryData(iamKeys.org(org.alias), o); await qc.invalidateQueries({ queryKey: iamKeys.orgs, exact: true }); toast.show(t('iam.orgs.saved', { org: o.name })); },
  });
  const [nameErr, setNameErr] = useState<string | null>(null);
  const submit = () => {
    if (!d.name.trim()) { setNameErr(t('iam.orgs.nameMissingShort')); document.getElementById(`${fid}-n`)?.focus(); return; }
    setNameErr(null);
    if (dirty) save.mutate();
  };
  return (
    <section aria-labelledby={`${fid}-h`}>
      <div className="iam-sec-h"><h2 id={`${fid}-h`}>{t('iam.orgs.details')}</h2></div>
      <form className="iam-form" onSubmit={e => { e.preventDefault(); submit(); }} noValidate>
        <label htmlFor={`${fid}-n`}>{t('iam.rolesPage.name')}</label>
        <input id={`${fid}-n`} className="iam-inp" value={d.name} onChange={e => setD({ ...d, name: e.target.value })} required autoComplete="off" aria-invalid={nameErr ? true : undefined} aria-describedby={nameErr ? `${fid}-n-e` : undefined} />
        {nameErr ? <div id={`${fid}-n-e`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{nameErr}</div> : null}
        <label htmlFor={`${fid}-d`}>{t('iam.orgs.col.domains')}</label>
        <input id={`${fid}-d`} className="iam-inp iam-mono" value={d.domains} onChange={e => setD({ ...d, domains: e.target.value })} autoComplete="off" aria-describedby={`${fid}-d-h`} />
        <div id={`${fid}-d-h`} className="iam-hint">{t('iam.orgs.domainsOne')}</div>
        <label htmlFor={`${fid}-b`}>{t('iam.rolesPage.description')}</label>
        <textarea id={`${fid}-b`} className="iam-inp" rows={2} value={d.description} onChange={e => setD({ ...d, description: e.target.value })} />
        <span />
        <div><Button type="submit" variant="primary" disabled={!dirty} busy={save.isPending}>{t('iam.common.save')}</Button></div>
      </form>
      {save.error ? <ErrorBox error={save.error} /> : null}
    </section>
  );
}

function StatusDialog({ org, onClose }: { org: Organization; onClose: () => void }) {
  const { Dialog, Button, toast } = useIamUi();
  const fid = useId();
  const qc = useQueryClient();
  const suspend = org.enabled && org.tenant?.status !== 'suspended';
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () => orgApi.setStatus(org.alias, suspend, reason.trim() || undefined),
    onSuccess: async o => { qc.setQueryData(iamKeys.org(org.alias), o); await qc.invalidateQueries({ queryKey: iamKeys.orgs, exact: true }); toast.show(t(suspend ? 'iam.orgs.suspended.done' : 'iam.orgs.resumed', { org: org.name })); onClose(); },
  });
  return (
    // Sperren ist folgenschwer: Fokus startet wie bei jeder Rückfrage mit danger auf «Abbrechen»
    <Dialog title={t(suspend ? 'iam.orgs.suspend.title' : 'iam.orgs.resume.title', { org: org.name })} role="alertdialog" width={480} onClose={onClose} onSubmit={() => run.mutate()} initialFocus={suspend ? '[data-cancel]' : '[data-confirm]'}
      footer={<><Button variant="ghost" data-cancel onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" data-confirm variant={suspend ? 'danger-solid' : 'primary'} busy={run.isPending}>{t(suspend ? 'iam.orgs.suspend' : 'iam.orgs.resume')}</Button></>}>
      {suspend ? (
        <>
          <p>{t('iam.orgs.suspend.text', { org: org.name })}</p>
          <div className="iam-field"><label htmlFor={`${fid}-r`}>{t('iam.orgs.reason')}</label><input id={`${fid}-r`} className="iam-inp" value={reason} maxLength={500} onChange={e => setReason(e.target.value)} autoComplete="off" /></div>
        </>
      ) : <p>{t('iam.orgs.resume.text', { org: org.name })}</p>}
      {run.error ? <ErrorBox error={run.error} /> : null}
    </Dialog>
  );
}
