/**
 * Verwalten › Anmeldung (Microsoft Entra ID, Spezifikation 9.4, KANN): die Organisation mit ihrem Entra-Tenant verbinden
 * (Self-Service der Organisations-Administration). Dieselbe Ansicht nutzt die Plattform-Administration für eine
 * beliebige Organisation (`alias`). Nur mit `features.entra`. Herkunft: vollholz/assets `web/src/features/admin/EntraLogin.tsx`.
 *
 * Drei Schritte, damit sich niemand aussperrt:
 * 1. Verbinden: Verzeichnis-ID oder Domäne → Zustimmung bei Microsoft (Navigation, kein Popup) → Rückkehr auf
 *    `<paths.entra>/zustimmung` (EntraConsentReturn). Danach ist der Anbieter eingerichtet; die Anmeldung bleibt wie bisher.
 * 2. Testanmeldung: Eine Person der Domänen meldet sich über Microsoft an (`testLoginPath`, auch als Link für andere);
 *    die Rückkehr auf `<paths.entra>/test` (EntraTestReturn) meldet es der API.
 * 3. «Nur Entra» aktivieren: erst nach der Testanmeldung; die Vorschau listet, wer die Anmeldung verliert, und diese
 *    Liste wird ausdrücklich bestätigt. Danach melden sich Personen der Domänen nur noch über Microsoft an.
 * Trennen nur mit Bestätigung; der Hinweis hängt davon ab, ob «Nur Entra» aktiv ist.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { entraApi, entraTest, useEntra } from '../admin.ts';
import { authLink, isConsentUrl } from '../client.ts';
import { useIamConfig } from '../config.tsx';
import { CONSENT_HOSTS, ENTRA_STATE } from '../entra.ts';
import type { EntraConnection, EntraConsentReturn, EntraMember, EntraResult, EntraStatus } from '../contract.ts';
import { fmtDateTime, relTime } from '../format.ts';
import { iamKeys } from '../keys.ts';
import { ApiError } from '../problem.ts';
import { AdminHead } from '../rights/AdminHead.tsx';
import { useIam } from '../session.tsx';
import { t, tn } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { Confirm } from '../ui/Overlay.tsx';
import { Empty, ErrorBox, ErrorState, SkeletonRows } from '../ui/states.tsx';
import { EntraHandoverReturn } from './EntraHandover.tsx';
import { ConsentLinkDialog, ConsentLinkList } from './EntraLinks.tsx';
import { OwnAppDialog } from './EntraOwnApp.tsx';
import { organizationPath } from './Organizations.tsx';

/** Mitglieder aus einem 409 `confirm-not-linked` (die Liste hat sich geändert oder fehlt). */
const notLinkedOf = (e: unknown): EntraMember[] | null => {
  const p = e instanceof ApiError ? e.problem as { reason?: string; notLinked?: EntraMember[] } : null;
  return p?.reason === 'confirm-not-linked' ? p.notLinked ?? [] : null;
};
const atDomains = (c: EntraConnection) => c.domains.map(d => `@${d}`).join(', ');

/** Seite der eigenen Organisation (Recht `members:admin` prüft der Guard der Route). */
export function EntraPage() {
  const { orgName: org } = useIam();
  useIamText();
  return (
    <>
      <AdminHead icon="shield" title={t('iam.entra.title')} sub={t('iam.entra.sub', { org })} />
      <div className="iam-body"><div className="iam-int"><EntraSection alias={null} orgLabel={org} /></div></div>
      <div className="iam-cli iam-api"><span className="iam-cli-label">API</span><code tabIndex={0}>GET /v1/admin/entra · POST /v1/admin/entra/consent · POST /v1/admin/entra/enforce · DELETE /v1/admin/entra</code></div>
    </>
  );
}

/** Status, Verbinden, Testanmeldung, «Nur Entra», Domänen, Aktualisieren und Trennen (eigene Organisation oder per Plattform). */
export function EntraSection({ alias, orgLabel }: { alias: string | null; orgLabel: string }) {
  const q = useEntra(alias);
  const { paths, product } = useIamConfig();
  // Rückkehrpfade des Servers (ENTRA_UI_PATH) müssen zu `paths.entra` passen, sonst kommt die Rückkehr nie an
  useEffect(() => {
    const d = q.data;
    if (d?.consentPath && (d.consentPath !== `${paths.entra}/zustimmung` || (d.testPath && d.testPath !== `${paths.entra}/test`))) {
      console.warn(`@vollholz/iam-web: Rückkehrpfade des Servers (${d.consentPath}, ${d.testPath ?? '–'}) passen nicht zu paths.entra (${paths.entra}); ENTRA_UI_PATH oder paths.entra anpassen.`);
    }
  }, [q.data, paths.entra]);
  const { Button, toast } = useIamUi();
  useIamText();
  const fid = useId();
  const [connecting, setConnecting] = useState(false);
  // Eigene App-Registrierung verbinden bzw. ihr Secret wechseln
  const [owning, setOwning] = useState(false);
  // Link an die Entra-Administration: zustimmen darf oft nur die Kunden-IT, nicht die Organisations-Administration
  const [linking, setLinking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [enforcing, setEnforcing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [result, setResult] = useState<EntraResult | null>(null);
  const qc = useQueryClient();
  const api = entraApi(alias);
  const done = async (r: EntraResult | null, msg: string) => {
    if (r) qc.setQueryData<EntraStatus>(iamKeys.entra(alias), s => (s ? { ...s, connection: r.connection } : s));
    await qc.invalidateQueries({ queryKey: iamKeys.entra(alias) });
    toast.show(msg);
  };
  const refresh = useMutation({ mutationFn: () => api.refresh(), onSuccess: r => { setResult(null); void done(r, t('iam.entra.refreshed', { org: orgLabel })); }, onError: e => toast.error(e, t('iam.entra.refreshFailed')) });
  const disconnect = useMutation({ mutationFn: () => api.disconnect(), onSuccess: async () => { setDisconnecting(false); setResult(null); await done(null, t('iam.entra.disconnected', { org: orgLabel })); } });
  const c = q.data?.connection ?? null;
  const enforced = c?.stage === 'enforced';
  // Angebotene Wege; ältere Server (ohne `methods`) nur mit der App der Plattform
  const methods = q.data?.methods ?? { platformApp: true, ownApp: false };
  const guide = methods.ownApp ? q.data?.ownApp ?? null : null;
  const own = c?.method === 'own';
  const linkKinds = [...(methods.platformApp && !own ? ['consent' as const] : []), ...(guide ? ['credentials' as const] : [])];
  return (
    <section aria-labelledby={`${fid}-h`}>
      <div className="iam-sec-h iam-wrap"><h2 id={`${fid}-h`}>{t('iam.entra.title')}</h2>
        {c ? <span className={`iam-pill iam-sm ${c.status !== 'active' ? 'iam-st-warn' : enforced ? 'iam-st-ok' : 'iam-st-idle'}`}>{t(c.status !== 'active' ? 'iam.entra.state.error' : enforced ? 'iam.entra.state.enforced' : 'iam.entra.state.pending')}</span> : null}
        {q.data?.enabled ? <><span className="iam-spacer" />{c
          ? <><Button icon="reset" busy={refresh.isPending} onClick={() => refresh.mutate()}>{t('iam.entra.refresh')}</Button>
            {own
              ? (guide ? <Button icon="key" onClick={() => setOwning(true)}>{t('iam.ownApp.rotate')}</Button> : null)
              : methods.platformApp ? <Button icon="link" onClick={() => setConnecting(true)} title={t('iam.entra.reconsentHint')}>{t('iam.entra.reconsent')}</Button> : null}
            {linkKinds.length ? <Button icon="send" onClick={() => setLinking(true)}>{t('iam.entraLink.open')}</Button> : null}
            <Button variant="danger" icon="x" onClick={() => setDisconnecting(true)}>{t('iam.entra.disconnect')}</Button></>
          : <>{methods.platformApp ? <Button variant="primary" icon="link" onClick={() => setConnecting(true)}>{t('iam.entra.connect')}</Button> : null}
            {guide ? <Button variant={methods.platformApp ? undefined : 'primary'} icon="key" onClick={() => setOwning(true)}>{t('iam.ownApp.open')}</Button> : null}
            {linkKinds.length ? <Button icon="send" onClick={() => setLinking(true)}>{t('iam.entraLink.open')}</Button> : null}</>}</> : null}
      </div>
      {q.isPending ? <SkeletonRows rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data.enabled ? (
        <Empty icon="shield" title={t('iam.entra.off')}><p>{q.data.reason}</p></Empty>
      ) : !c ? (
        <Empty icon="shield" title={t('iam.entra.none.title')}><p>{t(methods.platformApp ? 'iam.entra.none.text' : 'iam.entra.none.textOwn', { org: orgLabel })}</p></Empty>
      ) : (
        <>
          <ConnectionView c={c} onEdit={() => setEditing(true)} />
          <Steps c={c} onEnforce={() => setEnforcing(true)} />
        </>
      )}
      {result ? <BindReport r={result} enforced={enforced} onClose={() => setResult(null)} /> : null}
      {q.data?.enabled ? <ConsentLinkList alias={alias} orgLabel={orgLabel} /> : null}
      {connecting ? <ConnectDialog alias={alias} orgLabel={orgLabel} tenant={c?.entraTenantId} onClose={() => setConnecting(false)} /> : null}
      {linking && linkKinds.length ? <ConsentLinkDialog alias={alias} orgLabel={orgLabel} tenant={c?.entraTenantId} kinds={linkKinds} onClose={() => setLinking(false)} /> : null}
      {owning && guide ? (
        <OwnAppDialog alias={alias} orgLabel={orgLabel} product={product} guide={guide} connection={c} onClose={() => setOwning(false)}
          onDone={async r => { setOwning(false); setResult(own ? null : r); await done(r, t(own ? 'iam.ownApp.rotated' : 'iam.ownApp.connected', { org: orgLabel })); }} />
      ) : null}
      {enforcing && c ? <EnforceDialog alias={alias} orgLabel={orgLabel} c={c} onClose={() => setEnforcing(false)} onDone={async r => { setEnforcing(false); setResult(r); await done(r, t('iam.entra.enforced', { org: orgLabel })); }} /> : null}
      {editing && c ? <DomainsDialog alias={alias} orgLabel={orgLabel} c={c} onClose={() => setEditing(false)} onDone={async r => { setEditing(false); setResult(r.members.length ? r : null); await done(r, t('iam.entra.domainsSaved', { org: orgLabel })); }} /> : null}
      {disconnecting && c ? (
        <Confirm title={t('iam.entra.disconnect.title', { org: orgLabel })} confirm={t('iam.entra.disconnect.confirm')} danger busy={disconnect.isPending} onClose={() => { disconnect.reset(); setDisconnecting(false); }} onConfirm={() => disconnect.mutate()}>
          {enforced ? (
            <>
              <p>{t('iam.entra.disconnect.enforced', { domains: atDomains(c) })}</p>
              <p className="iam-muted iam-small">{t('iam.entra.disconnect.back')}</p>
            </>
          ) : <p>{t('iam.entra.disconnect.pending')}</p>}
          {disconnect.error ? <ErrorBox error={disconnect.error} compact /> : null}
        </Confirm>
      ) : null}
    </section>
  );
}

function ConnectionView({ c, onEdit }: { c: EntraConnection; onEdit: () => void }) {
  const { Icon } = useIamUi();
  return (
    <dl className="iam-kv">
      <dt>{t('iam.entra.directory')}</dt><dd>{c.entraName || '—'} <span className="iam-mono-s iam-muted">{c.entraTenantId}</span></dd>
      <dt>{t('iam.orgs.col.domains')}</dt>
      <dd>
        <ul className="iam-role-tags" aria-label={t('iam.entra.boundDomains')}>{c.domains.map(d => <li key={d} className="iam-role-tag iam-mono-s">@{d}</li>)}</ul>
        <span className="iam-muted iam-small">{t(c.stage === 'enforced' ? 'iam.entra.domains.enforced' : 'iam.entra.domains.pending')}</span>
        {' '}<button type="button" className="iam-linkbtn" onClick={onEdit}>{c.availableDomains.length ? t('iam.entra.pickDomainsMore', { n: c.availableDomains.length }) : t('iam.entra.pickDomains')}</button>
      </dd>
      {c.method ? <><dt>{t('iam.entra.method')}</dt><dd>{t(c.method === 'own' ? 'iam.entra.method.own' : 'iam.entra.method.platform')}{c.clientId ? <> <span className="iam-mono-s iam-muted">{c.clientId}</span></> : null}</dd></> : null}
      {c.method === 'own' ? <SecretExpiry c={c} /> : null}
      <dt>{t('iam.entra.connected')}</dt><dd title={fmtDateTime(c.connectedAt)}>{relTime(c.connectedAt)} · {c.connectedBy}</dd>
      <dt>{t('iam.entra.refreshedAt')}</dt><dd title={fmtDateTime(c.refreshedAt)}>{relTime(c.refreshedAt)}</dd>
      {c.lastError ? <><dt>{t('iam.entra.error')}</dt><dd className="iam-ferr"><Icon name="warn" className="iam-ico" />{c.lastError}</dd></> : null}
    </dl>
  );
}

/** Ablauf des Secrets der eigenen App mit Warnung (bald fällig oder abgelaufen). */
function SecretExpiry({ c }: { c: EntraConnection }) {
  const { Icon } = useIamUi();
  const at = c.secretExpiresAt ?? null;
  const expired = !!at && Date.parse(at) <= Date.now();
  const warn = expired ? 'iam.entra.secretExpired' : c.secretExpiresSoon ? 'iam.entra.secretSoon' : null;
  return (
    <>
      <dt>{t('iam.entra.secretExpires')}</dt>
      <dd>
        {at ? <span>{fmtDateTime(at)} ({relTime(at)})</span> : <span className="iam-muted">{t('iam.entra.secretUnknown')}</span>}
        {warn ? <div className={expired ? 'iam-ferr' : 'iam-warnbox'} role="status"><Icon name="warn" className="iam-ico" /><span>{t(warn)}</span></div> : null}
      </dd>
    </>
  );
}

/** Schritte 1–3 mit Stand; Testanmeldung als Link (Navigation zu Keycloak/Microsoft), Aktivieren erst nach dem Test. */
function Steps({ c, onEnforce }: { c: EntraConnection; onEnforce: () => void }) {
  const { Button, Icon, toast } = useIamUi();
  // Nur ein Anmeldepfad unter «/auth/» dieser Herkunft; sonst weder Knopf noch Link
  const link = authLink(c.testLoginPath);
  const copy = () => { if (link) void navigator.clipboard?.writeText(link).then(() => toast.show(t('iam.entra.linkCopied')), () => undefined); };
  return (
    <ol className="iam-pad iam-entra-steps" aria-label={t('iam.entra.steps')}>
      <li><Icon name="check" className="iam-ico" /><strong>{t('iam.entra.step1')}</strong> – {t('iam.entra.step1.text')}</li>
      <li>
        {c.testedAt ? <><Icon name="check" className="iam-ico" /><strong>{t('iam.entra.step2.done')}</strong> – {c.testedBy}, <span title={fmtDateTime(c.testedAt)}>{relTime(c.testedAt)}</span>.</>
          : <><strong>{t('iam.entra.step2')}</strong> – {t('iam.entra.step2.text', { domains: atDomains(c) })}</>}
        {link ? <>{' '}<Button size="sm" icon="user" href={link}>{t(c.testedAt ? 'iam.entra.retest' : 'iam.entra.test')}</Button>
          {' '}<button type="button" className="iam-linkbtn" onClick={copy}>{t('iam.entra.copyTest')}</button></> : null}
      </li>
      <li>
        {c.stage === 'enforced'
          ? <><Icon name="check" className="iam-ico" /><strong>{t('iam.entra.state.enforced')}</strong> – {c.enforcedBy}, <span title={fmtDateTime(c.enforcedAt!)}>{relTime(c.enforcedAt!)}</span>. {t('iam.entra.step3.done')}</>
          : <><strong>{t('iam.entra.step3')}</strong> – {t('iam.entra.step3.text')}{' '}
            <Button size="sm" variant="primary" icon="shield" aria-disabled={c.testedAt ? undefined : true} title={c.testedAt ? undefined : t('iam.entra.testFirst')} onClick={() => { if (c.testedAt) onEnforce(); }}>{t('iam.entra.enforce')}</Button></>}
      </li>
    </ol>
  );
}

/** Passwort und Passkey bleiben trotz «Nur Entra» (z. B. Konto der Plattform-Administration), mit Grund. */
const Kept = ({ m }: { m: EntraMember }) => (m.passwordKept ? <span className="iam-muted iam-small"> · {t('iam.entra.passwordKept', { reason: m.passwordKept })}</span> : null);

/** Mitglieder, die die Anmeldung verlieren, als Liste. */
function LostList({ members }: { members: EntraMember[] }) {
  return <ul aria-label={t('iam.entra.lose')}>{members.map(m => <li key={m.email}>{m.name} <span className="iam-mono-s iam-muted">{m.email}</span> – {m.reason}<Kept m={m} /></li>)}</ul>;
}

/** Ergebnis für Mitglieder der Domänen: verknüpft oder nicht. */
function BindReport({ r, enforced, onClose }: { r: EntraResult; enforced: boolean; onClose?: () => void }) {
  const { Button, Icon } = useIamUi();
  const notLinked = r.members.filter(m => !m.linked);
  return (
    <div className="iam-pad" role="status">
      <p><Icon name="check" className="iam-ico" />{tn('iam.entra.linked', r.members.filter(m => m.linked).length)}{r.rejectedDomains.length ? ` ${t('iam.entra.rejected', { domains: r.rejectedDomains.join(', ') })}` : ''}</p>
      {notLinked.length ? (
        <>
          <p className="iam-ferr"><Icon name="warn" className="iam-ico" />{tn('iam.entra.notLinked', notLinked.length)} – {t(enforced ? 'iam.entra.notLinked.enforced' : 'iam.entra.notLinked.pending')}</p>
          <LostList members={notLinked} />
        </>
      ) : null}
      {onClose ? <Button size="sm" variant="ghost" onClick={onClose}>{t('iam.entra.hide')}</Button> : null}
    </div>
  );
}

function ConnectDialog({ alias, orgLabel, tenant: fixed, onClose }: { alias: string | null; orgLabel: string; tenant?: string; onClose: () => void }) {
  const { Dialog, Button, Icon } = useIamUi();
  const { entraConsentHosts = CONSENT_HOSTS } = useIamConfig();
  const fid = useId();
  const [tenant, setTenant] = useState(fixed ?? '');
  const start = useMutation({
    mutationFn: async () => {
      const r = await entraApi(alias).consent(tenant.trim());
      // Nur zu Microsoft weiterleiten (https, bekannter Host); eine andere Adresse ist ein Fehler, keine Navigation
      if (!isConsentUrl(r.url, entraConsentHosts)) throw new Error(t('iam.entra.connect.badUrl'));
      return r;
    },
    onSuccess: r => { window.location.assign(r.url); },
  });
  return (
    <Dialog title={t('iam.entra.connect.title', { org: orgLabel })} onClose={onClose} onSubmit={() => { if (tenant.trim()) start.mutate(); }} width={600}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" disabled={!tenant.trim()} busy={start.isPending}><Icon name="link" className="iam-ico" />{t('iam.entra.connect.go')}</Button></>}>
      <div className="iam-form iam-compact">
        <label htmlFor={`${fid}-t`}>{t('iam.entra.directory')}</label>
        <input id={`${fid}-t`} className="iam-inp iam-mono-s" value={tenant} onChange={e => setTenant(e.target.value)} readOnly={!!fixed} required autoComplete="off" data-autofocus placeholder="contoso.onmicrosoft.com" aria-describedby={`${fid}-t-h`} />
        <div id={`${fid}-t-h`} className="iam-hint">{t('iam.entra.connect.hint')}</div>
      </div>
      <p>{t('iam.entra.connect.intro')}</p>
      <ul>
        <li>{t('iam.entra.connect.domains', { org: orgLabel })}</li>
        <li>{t('iam.entra.connect.members')}</li>
        <li>{t('iam.entra.connect.nothing')}</li>
      </ul>
      {start.error ? <ErrorBox error={start.error} /> : null}
    </Dialog>
  );
}

/** «Nur Entra» aktivieren: Vorschau laden, Liste «verlieren die Anmeldung» zeigen und ausdrücklich bestätigen. */
function EnforceDialog({ alias, orgLabel, c, onClose, onDone }: { alias: string | null; orgLabel: string; c: EntraConnection; onClose: () => void; onDone: (r: EntraResult) => Promise<void> }) {
  const { Dialog, Button, Icon } = useIamUi();
  const fid = useId();
  const { me } = useIam();
  const pv = useQuery({ queryKey: [...iamKeys.entra(alias), 'preview'], staleTime: 0, gcTime: 0, queryFn: ({ signal }) => entraApi(alias).preview(signal) });
  const [changed, setChanged] = useState<EntraMember[] | null>(null);
  const [ack, setAck] = useState(false);
  const lost = changed ?? pv.data?.members.filter(m => !m.linked) ?? [];
  // Verknüpft, behalten aber Passwort und Passkey (nicht verknüpfte stehen mit Grund in der Liste oben)
  const kept = pv.data?.members.filter(m => m.linked && m.passwordKept) ?? [];
  const run = useMutation({
    mutationFn: () => entraApi(alias).enforce(lost.map(m => m.email)),
    onSuccess: onDone,
    onError: e => { const l = notLinkedOf(e); if (l) { setChanged(l); setAck(false); } },
  });
  const mine = alias === null && !!me.person.email && c.domains.includes(me.person.email.split('@')[1]!.toLowerCase());
  return (
    <Dialog title={t('iam.entra.enforce.title', { org: orgLabel })} role="alertdialog" onClose={onClose} onSubmit={() => { if (pv.data && (ack || !lost.length)) run.mutate(); }} width={600} initialFocus="[data-cancel]"
      footer={<><Button variant="ghost" data-cancel onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="danger-solid" disabled={!pv.data || (lost.length > 0 && !ack)} busy={run.isPending}>{t('iam.entra.enforce.confirm')}</Button></>}>
      <p>{t('iam.entra.enforce.text', { domains: atDomains(c) })}</p>
      {pv.isPending ? <SkeletonRows rows={3} /> : pv.error ? <ErrorBox error={pv.error} onRetry={() => void pv.refetch()} /> : lost.length ? (
        <>
          <p className="iam-ferr"><Icon name="warn" className="iam-ico" /><strong>{tn('iam.entra.loses', lost.length)}</strong> – {t('iam.entra.loses.why')}</p>
          <LostList members={lost} />
          <label htmlFor={`${fid}-ack`} className="iam-chk"><input id={`${fid}-ack`} type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> {t('iam.entra.ack')}</label>
        </>
      ) : <p><Icon name="check" className="iam-ico" />{tn('iam.entra.allLinked', pv.data.members.length)}</p>}
      {kept.length ? (
        <ul className="iam-muted iam-small" aria-label={t('iam.entra.keptList')}>
          {kept.map(m => <li key={m.email}>{m.name} <span className="iam-mono-s">{m.email}</span><Kept m={m} /></li>)}
        </ul>
      ) : null}
      {mine ? <p className="iam-muted iam-small"><Icon name="warn" className="iam-ico" />{t('iam.entra.youToo')}</p> : null}
      {changed ? <p className="iam-muted iam-small" role="status">{t('iam.entra.changed')}</p> : run.error ? <ErrorBox error={run.error} /> : null}
    </Dialog>
  );
}

function DomainsDialog({ alias, orgLabel, c, onClose, onDone }: { alias: string | null; orgLabel: string; c: EntraConnection; onClose: () => void; onDone: (r: EntraResult) => Promise<void> }) {
  const { Dialog, Button, Icon } = useIamUi();
  const fid = useId();
  const all = [...c.domains, ...c.availableDomains].sort();
  const [sel, setSel] = useState<Set<string>>(new Set(c.domains));
  const [lost, setLost] = useState<EntraMember[] | null>(null);
  const [ack, setAck] = useState(false);
  const save = useMutation({
    mutationFn: () => entraApi(alias).domains([...sel].sort(), lost ? lost.map(m => m.email) : undefined),
    onSuccess: onDone,
    onError: e => { const l = notLinkedOf(e); if (l) { setLost(l); setAck(false); } },
  });
  const toggle = (d: string) => { setLost(null); setSel(s => { const x = new Set(s); if (!x.delete(d)) x.add(d); return x; }); };
  return (
    <Dialog title={t('iam.entra.domains.title', { org: orgLabel })} onClose={onClose} onSubmit={() => { if (!lost?.length || ack) save.mutate(); }} width={560}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" disabled={!sel.size || (!!lost?.length && !ack)} busy={save.isPending}>{t('iam.common.save')}</Button></>}>
      <p className="iam-muted iam-small">{t(c.stage === 'enforced' ? 'iam.entra.domains.introEnforced' : 'iam.entra.domains.introPending')}</p>
      <fieldset className="iam-opt-list iam-entra-domains"><legend className="iam-sr">{t('iam.orgs.col.domains')}</legend>
        {all.map(d => <label key={d} className="iam-chk"><input type="checkbox" checked={sel.has(d)} onChange={() => toggle(d)} /> <span className="iam-mono-s">@{d}</span></label>)}
      </fieldset>
      {lost?.length ? (
        <>
          <p className="iam-ferr"><Icon name="warn" className="iam-ico" /><strong>{tn('iam.entra.loses', lost.length)}</strong>:</p>
          <LostList members={lost} />
          <label htmlFor={`${fid}-ack`} className="iam-chk"><input id={`${fid}-ack`} type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> {t('iam.entra.ack')}</label>
        </>
      ) : save.error && !lost ? <ErrorBox error={save.error} /> : null}
    </Dialog>
  );
}

/**
 * Rückkehr von der Zustimmung bei Microsoft (Parameter im Suchtext). `state` stammt vom Server: `o.<alias>.…` für die
 * eigene Organisation, `p.<alias>.…` für die Plattform-Administration; ein anderes Format gilt als keine Rückkehr
 * (kein API-Aufruf). Nach dem Senden verschwinden die Parameter aus der Adresse; nach einem Neuladen meldet die API 404.
 */
export function EntraConsentReturn() {
  const { router: { useSearch } } = useIamConfig();
  const search = useSearch();
  // `h.…`: Rückkehr eines Links an die Entra-Administration (ohne Sitzung); IamProvider zeigt sie sonst schon vorher
  const [handover] = useState(() => ENTRA_STATE.exec(new URLSearchParams(search).get('state') ?? '')?.[1] === 'h');
  return handover ? <EntraHandoverReturn /> : <SessionConsentReturn />;
}

function SessionConsentReturn() {
  const { router: { Link, useSearch, usePathname, navigate }, paths } = useIamConfig();
  const { me } = useIam();
  useIamText();
  const search = useSearch();
  const pathname = usePathname();
  // Parameter einmal lesen: Nach dem Senden verschwinden sie aus der Adresse (replace), das Ergebnis bleibt im Zustand
  const [body] = useState<EntraConsentReturn | null>(() => {
    const s = new URLSearchParams(search);
    const get = (k: string) => s.get(k) || undefined;
    const state = get('state'), code = get('code'), error = get('error');
    // Code-Flow: `code` weist die Zustimmung nach, bei Abbruch `error`; ohne beides keine Rückkehr von Microsoft
    return state && ENTRA_STATE.test(state) && (code || error) ? {
      state, ...(code ? { code } : {}), ...(error ? { error } : {}), ...(get('error_description') ? { errorDescription: get('error_description') } : {}),
    } : null;
  });
  const [, kind, alias] = body ? ENTRA_STATE.exec(body.state)! : [];
  const target = kind === 'p' ? alias! : null;
  const qc = useQueryClient();
  const complete = useMutation({ mutationFn: (b: EntraConsentReturn) => entraApi(target).complete(b), onSuccess: () => qc.invalidateQueries({ queryKey: iamKeys.entra(target) }) });
  const sent = useRef(false);
  const wrongOrg = kind === 'o' && alias !== me.tenant?.alias;
  useEffect(() => {
    if (!body || wrongOrg || sent.current) return;
    sent.current = true;
    complete.mutate(body);
    if (search) navigate(pathname, { replace: true });
  });
  // 404: `state` schon verwendet (z. B. nach einem Neuladen), abgelaufen oder fremd
  const used = complete.error instanceof ApiError && complete.error.status === 404;
  // 409 `consent-unproven`: keine globale Administration bzw. Administration für privilegierte Rollen, Gast, falscher Tenant
  const unproven = complete.error instanceof ApiError && complete.error.status === 409 && complete.error.problem.reason === 'consent-unproven';
  const back = target
    ? <Link className="iam-btn" to={organizationPath(paths.organizations, target)}>{t('iam.entra.backOrg')}</Link>
    : <Link className="iam-btn" to={paths.entra}>{t('iam.entra.next')}</Link>;
  return (
    <>
      <AdminHead icon="shield" title={t('iam.entra.connectTitle')} />
      <div className="iam-body"><div className="iam-int">
        {!body ? <Empty icon="warn" title={t('iam.entra.return.none')}>{t('iam.entra.return.noneText')} {back}</Empty>
          : wrongOrg ? <Empty icon="warn" title={t('iam.entra.return.other')}>{t('iam.entra.return.otherText', { alias: alias ?? '' })} {back}</Empty>
          : complete.isPending || complete.isIdle ? <SkeletonRows rows={3} />
          : used ? <Empty icon="check" title={t('iam.entra.return.used')}>{t('iam.entra.return.usedText')} {back}</Empty>
          : unproven ? <Empty icon="warn" title={t('iam.entra.return.unproven')}><p>{t('iam.entra.return.unprovenText')}</p>{back}</Empty>
          : complete.error ? <><ErrorBox error={complete.error} />{back}</>
          : (
            <>
              <p><CheckIcon />{t('iam.entra.return.done', { name: complete.data.connection.entraName, domains: atDomains(complete.data.connection) })}</p>
              <BindReport r={complete.data} enforced={complete.data.connection.stage === 'enforced'} />
              {complete.data.connection.stage === 'pending' ? <p role="note">{t('iam.entra.return.nextStep')}</p> : null}
              {back}
            </>
          )}
      </div></div>
    </>
  );
}

const CheckIcon = () => { const { Icon } = useIamUi(); return <Icon name="check" className="iam-ico" />; };

/** Rückkehr der Testanmeldung: Diese Sitzung ist über Microsoft angemeldet – der API melden. */
export function EntraTestReturn() {
  const { router: { Link, useSearch, usePathname, navigate }, paths } = useIamConfig();
  useIamText();
  const search = useSearch();
  const pathname = usePathname();
  const qc = useQueryClient();
  const test = useMutation({ mutationFn: entraTest, onSuccess: () => qc.invalidateQueries({ queryKey: iamKeys.entra(null) }) });
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    test.mutate();
    if (search) navigate(pathname, { replace: true });
  });
  return (
    <>
      <AdminHead icon="shield" title={t('iam.entra.testTitle')} />
      <div className="iam-body"><div className="iam-int">
        {test.isPending || test.isIdle ? <SkeletonRows rows={2} />
          : test.error ? <ErrorBox error={test.error} />
          : <p role="status"><CheckIcon />{t('iam.entra.testDone')}</p>}
        <Link className="iam-btn" to={paths.home}>{t('iam.entra.home')}</Link>
      </div></div>
    </>
  );
}
