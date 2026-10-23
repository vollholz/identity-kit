/**
 * Link an die Entra-Administration (Abschnitt «Anmeldung»): Die Organisations-Administration erzeugt einen Link mit
 * Gültigkeit und gibt ihn der Person weiter, die im Microsoft-Verzeichnis zustimmen darf (oft die Kunden-IT). Der Link
 * gilt einmal; das Token steht im Fragment und ist nur direkt nach dem Erzeugen sichtbar. Darunter die Liste der Links mit
 * Status, Ablauf, Fehler und Widerrufen. `alias` = Organisation der Plattform-Administration, sonst die eigene.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { entraApi, useConsentLinks } from '../admin.ts';
import type { ConsentLink, ConsentLinkCreated, ConsentLinkStatus } from '../contract.ts';
import { fmtDateTime, relTime } from '../format.ts';
import { iamKeys } from '../keys.ts';
import { ApiError } from '../problem.ts';
import { t, type IamTextKey } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { Confirm } from '../ui/Overlay.tsx';
import { ErrorBox, SkeletonRows } from '../ui/states.tsx';

/** Gültigkeit in Minuten (Server: 5–1440, Standard 15). */
const VALIDITY = [15, 60, 240, 1440] as const;
const STATUS_PILL: Record<ConsentLinkStatus, string> = { open: 'iam-st-warn', 'in-progress': 'iam-st-warn', connected: 'iam-st-ok', failed: 'iam-st-bad', expired: 'iam-st-off', revoked: 'iam-st-off' };
const STATUS_TEXT: Record<ConsentLinkStatus, IamTextKey> = {
  open: 'iam.entraLink.status.open', 'in-progress': 'iam.entraLink.status.inProgress', connected: 'iam.entraLink.status.connected',
  failed: 'iam.entraLink.status.failed', expired: 'iam.entraLink.status.expired', revoked: 'iam.entraLink.status.revoked',
};
const known = (s: string): s is ConsentLinkStatus => Object.hasOwn(STATUS_TEXT, s);
/** Unbekannter Status (neuer Server): neutral mit dem Wert. */
const statusText = (s: string) => (known(s) ? t(STATUS_TEXT[s]) : t('iam.entraLink.status.unknown', { status: s }));
/** Noch einlösbar und zählt zum Limit von 5: lässt sich widerrufen. */
const REVOCABLE = new Set<string>(['open', 'in-progress', 'failed']);
/** Gründe mit eigenem Text statt der Meldung des Servers (Zustimmung gescheitert; automatisch widerrufen). */
const REASON_TEXT: Record<string, IamTextKey> = {
  'consent-unproven': 'iam.entraLink.reason.unproven', 'consent-error': 'iam.entraLink.reason.declined',
  'creator-lost-access': 'iam.entraLink.creatorLost', disconnected: 'iam.entraLink.disconnected',
};
const reasonOf = (e: unknown) => (e instanceof ApiError ? (e.problem as { reason?: string }).reason : undefined);

/** Dialog: Verzeichnis und Gültigkeit, danach der Link zum Kopieren (nur jetzt sichtbar). */
export function ConsentLinkDialog({ alias, orgLabel, tenant: fixed, onClose }: { alias: string | null; orgLabel: string; tenant?: string; onClose: () => void }) {
  const { Dialog, Button, Icon, toast } = useIamUi();
  useIamText();
  const fid = useId();
  const qc = useQueryClient();
  const [tenant, setTenant] = useState(fixed ?? '');
  const [minutes, setMinutes] = useState<number>(15);
  const [created, setCreated] = useState<ConsentLinkCreated | null>(null);
  const create = useMutation({
    mutationFn: () => entraApi(alias).links.create({ tenant: tenant.trim(), validMinutes: minutes }),
    onSuccess: async r => { setCreated(r); await qc.invalidateQueries({ queryKey: iamKeys.consentLinks(alias) }); },
  });
  const copy = (url: string) => { void navigator.clipboard?.writeText(url).then(() => toast.show(t('iam.entraLink.copied')), () => undefined); };
  if (created) {
    return (
      <Dialog title={t('iam.entraLink.doneTitle', { org: orgLabel })} onClose={onClose} width={600} footer={<Button variant="primary" data-autofocus onClick={onClose}>{t('iam.common.close')}</Button>}>
        <p>{t('iam.entraLink.doneText', { until: fmtDateTime(created.expiresAt) })}</p>
        <label htmlFor={`${fid}-url`}>{t('iam.entraLink.link')}</label>
        <div className="iam-entra-link">
          <input id={`${fid}-url`} className="iam-inp iam-mono-s" readOnly value={created.url} onFocus={e => e.target.select()} />
          <Button icon="copy" onClick={() => copy(created.url)}>{t('iam.entraAdd.copy')}</Button>
        </div>
        <p className="iam-warnbox" role="note"><Icon name="warn" className="iam-ico" /><span>{t('iam.entraLink.secret')}</span></p>
      </Dialog>
    );
  }
  return (
    <Dialog title={t('iam.entraLink.title', { org: orgLabel })} onClose={onClose} onSubmit={() => { if (tenant.trim()) create.mutate(); }} width={600}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" icon="send" disabled={!tenant.trim()} busy={create.isPending}>{t('iam.entraLink.create')}</Button></>}>
      <p>{t('iam.entraLink.intro')}</p>
      <div className="iam-form iam-compact">
        <label htmlFor={`${fid}-t`}>{t('iam.entra.directory')}</label>
        <input id={`${fid}-t`} className="iam-inp iam-mono-s" value={tenant} onChange={e => setTenant(e.target.value)} readOnly={!!fixed} required autoComplete="off" data-autofocus
          placeholder="contoso.onmicrosoft.com" aria-describedby={`${fid}-t-h`} />
        <div id={`${fid}-t-h`} className="iam-hint">{t('iam.entra.connect.hint')}</div>
        <label htmlFor={`${fid}-v`}>{t('iam.entraLink.validity')}</label>
        <select id={`${fid}-v`} className="iam-inp" value={minutes} onChange={e => setMinutes(Number(e.target.value))}>
          {VALIDITY.map(m => <option key={m} value={m}>{t(`iam.entraLink.valid.${m}` as IamTextKey)}</option>)}
        </select>
      </div>
      {reasonOf(create.error) === 'too-many-links'
        ? <p className="iam-warnbox" role="alert"><Icon name="warn" className="iam-ico" /><span>{t('iam.entraLink.tooMany')}</span></p>
        : create.error ? <ErrorBox error={create.error} /> : null}
    </Dialog>
  );
}

/** Liste der Links an die Entra-Administration; ohne Links nichts. */
export function ConsentLinkList({ alias, orgLabel }: { alias: string | null; orgLabel: string }) {
  const q = useConsentLinks(alias);
  const qc = useQueryClient();
  const { Button, Table, toast } = useIamUi();
  useIamText();
  const fid = useId();
  const [revoking, setRevoking] = useState<ConsentLink | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: iamKeys.consentLinks(alias) });
  const revoke = useMutation({
    mutationFn: (l: ConsentLink) => entraApi(alias).links.revoke(l.id),
    onSuccess: async () => { setRevoking(null); await refresh(); toast.show(t('iam.entraLink.revoked')); },
    // Schon eingelöst (409) oder weg (404): Liste neu laden, der Fehler bleibt im Dialog
    onError: () => void refresh(),
  });
  if (q.isPending) return <SkeletonRows rows={2} />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} compact />;
  if (!q.data.length) return null;
  return (
    <section aria-labelledby={`${fid}-h`} className="iam-entra-links">
      <div className="iam-sec-h"><h3 id={`${fid}-h`}>{t('iam.entraLink.list')}</h3></div>
      <div className="iam-tblwrap">
        <Table stack>
          <caption className="iam-sr">{t('iam.entraLink.caption', { org: orgLabel })}</caption>
          <thead><tr><th scope="col">{t('iam.entra.directory')}</th><th scope="col">{t('iam.entraLink.col.status')}</th><th scope="col">{t('iam.entraLink.col.created')}</th><th scope="col">{t('iam.entraLink.col.expires')}</th><th scope="col" className="iam-acts"><span className="iam-sr">{t('iam.members.col.actions')}</span></th></tr></thead>
          <tbody>
            {q.data.map(l => (
              <tr key={l.id}>
                <td className="iam-mono-s">{l.entraTenantId}</td>
                <td>
                  <span className={`iam-pill iam-sm ${known(l.status) ? STATUS_PILL[l.status] : 'iam-st-off'}`}>{statusText(l.status)}</span>
                  {l.status === 'connected' && l.approverName ? <div className="iam-muted iam-small">{t('iam.entraLink.approvedBy', { name: l.approverName, when: l.usedAt ? relTime(l.usedAt) : '' })}</div> : null}
                  <LinkError link={l} />
                </td>
                <td className="iam-small" title={fmtDateTime(l.createdAt)}>{l.createdByName}<div className="iam-muted">{relTime(l.createdAt)}</div></td>
                <td className="iam-small">{fmtDateTime(l.expiresAt)}</td>
                <td className="iam-acts">{REVOCABLE.has(l.status)
                  ? <Button size="sm" variant="ghost" icon="x" onClick={() => setRevoking(l)}>{t('iam.entraLink.revoke')}<span className="iam-sr">: {l.entraTenantId}</span></Button> : null}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      {revoking ? (
        <Confirm title={t('iam.entraLink.revoke.title')} confirm={t('iam.entraLink.revoke.confirm')} danger busy={revoke.isPending} onClose={() => { revoke.reset(); setRevoking(null); }} onConfirm={() => revoke.mutate(revoking)}>
          <p>{t('iam.entraLink.revoke.text', { directory: revoking.entraTenantId, until: fmtDateTime(revoking.expiresAt) })}</p>
          {revoke.error ? <ErrorBox error={revoke.error} compact /> : null}
        </Confirm>
      ) : null}
    </section>
  );
}

/** Fehler bzw. Grund eines Links: bekannte Gründe mit eigenem Text, sonst die Meldung des Servers (leer: nichts). */
function LinkError({ link: l }: { link: ConsentLink }) {
  if (!l.error) return null;
  const key = Object.hasOwn(REASON_TEXT, l.error.reason) ? REASON_TEXT[l.error.reason] : undefined;
  if (l.status === 'revoked') return key ? <div className="iam-muted iam-small">{t(key)}</div> : null;
  const text = key ? t(key) : l.error.detail.trim();
  return text ? <div className="iam-ferr iam-small">{text}</div> : null;
}
