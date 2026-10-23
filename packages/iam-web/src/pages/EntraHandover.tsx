/**
 * Link an die Entra-Administration, öffentliche Seiten ohne Sitzung (die Person der Kunden-IT hat kein Konto in der App):
 * - `EntraHandoverPage` unter `<paths.entra>/freigabe#<token>`: liest das Token nur aus dem Fragment (nie aus Suchtext
 *   oder Pfad), entfernt das Fragment sofort aus der Adresse (replace) und schickt das Token nur im Body an die API. Zeigt
 *   Organisation, App, anfragende Person und Verzeichnis und führt erst auf Klick zur Zustimmung bei Microsoft.
 * - `EntraHandoverReturn` unter `<paths.entra>/zustimmung` mit `state` `h.…`: meldet die Rückkehr der öffentlichen API.
 * `IamProvider` zeigt beide vor der Prüfung von /auth/me (kein Umweg über die Anmeldung). Anrede «Sie»: die Seiten
 * richten sich an eine Person ausserhalb der App.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { handoverApi } from '../admin.ts';
import { isConsentUrl } from '../client.ts';
import { useIamConfig } from '../config.tsx';
import type { EntraConsentReturn } from '../contract.ts';
import { CONSENT_HOSTS, ENTRA_STATE } from '../entra.ts';
import { fmtDateTime } from '../format.ts';
import { ApiError } from '../problem.ts';
import { Gate } from '../session.tsx';
import { t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { ErrorBox, Loading } from '../ui/states.tsx';

/** Token im Fragment: `<alias>.<43 Zeichen base64url>`, sonst gilt der Link als unvollständig. */
const TOKEN = /^[a-z0-9][a-z0-9_-]{0,62}\.[A-Za-z0-9_-]{43}$/;

const reasonOf = (e: unknown) => (e instanceof ApiError ? (e.problem as { reason?: string }).reason : undefined);

/** Seite für die Entra-Administration: Angaben zur Anfrage, dann «Bei Microsoft zustimmen». */
export function EntraHandoverPage() {
  const { router: { usePathname, navigate }, entraConsentHosts = CONSENT_HOSTS, product } = useIamConfig();
  const { Button, Icon } = useIamUi();
  useIamText();
  const pathname = usePathname();
  // Token einmal aus dem Fragment lesen; danach nur noch im Speicher dieser Seite
  const [token] = useState(() => {
    const raw = typeof window === 'undefined' ? '' : window.location.hash.slice(1);
    return TOKEN.test(raw) ? raw : null;
  });
  const cleaned = useRef(false);
  useEffect(() => {
    if (cleaned.current) return;
    cleaned.current = true;
    // Fragment aus der Adresse entfernen (Verlauf, Lesezeichen, geteilte Bildschirme), ohne neuen Verlaufseintrag
    if (window.location.hash) navigate(`${pathname}${window.location.search}`, { replace: true });
  });
  const info = useQuery({ queryKey: ['iam', 'handover', 'info'], enabled: !!token, retry: false, staleTime: Infinity, gcTime: 0, queryFn: () => handoverApi.info(token!) });
  const start = useMutation({
    mutationFn: async () => {
      const r = await handoverApi.start(token!);
      // Nur zu Microsoft weiterleiten (https, bekannter Host)
      if (!isConsentUrl(r.url, entraConsentHosts)) throw new Error(t('iam.entra.connect.badUrl'));
      return r;
    },
    onSuccess: r => { window.location.assign(r.url); },
  });
  useEffect(() => { document.title = t('iam.handover.docTitle', { product: info.data?.product ?? product }); }, [info.data, product]);

  if (!token) return <Gate title={t('iam.handover.incomplete')} text={t('iam.handover.incompleteText')} />;
  if (info.isPending) return <Gate title={t('iam.handover.title')} text={t('iam.handover.loading')}><Loading inline /></Gate>;
  if (info.error) {
    return info.error instanceof ApiError && info.error.status === 404
      ? <Gate title={t('iam.handover.invalid')} text={t('iam.handover.invalidText')} />
      : <Gate title={t('iam.handover.title')} text={t('iam.handover.failed')}><ErrorBox error={info.error} onRetry={() => void info.refetch()} /></Gate>;
  }
  const d = info.data;
  return (
    <Gate title={t('iam.handover.title')} text={t('iam.handover.intro', { person: d.requestedBy, organization: d.organization, product: d.product })}>
      <dl className="iam-kv iam-handover-kv">
        <dt>{t('iam.handover.organization')}</dt><dd>{d.organization}</dd>
        <dt>{t('iam.handover.app')}</dt><dd>{d.product}</dd>
        <dt>{t('iam.handover.requestedBy')}</dt><dd>{d.requestedBy}</dd>
        <dt>{t('iam.handover.directory')}</dt><dd className="iam-mono-s">{d.tenant}</dd>
        <dt>{t('iam.handover.directoryId')}</dt><dd className="iam-mono-s">{d.entraTenantId}</dd>
        <dt>{t('iam.handover.validUntil')}</dt><dd>{fmtDateTime(d.expiresAt)}</dd>
      </dl>
      <p>{t('iam.handover.grants', { product: d.product, directory: d.tenant, organization: d.organization })}</p>
      {d.notice ? <p>{d.notice}</p> : null}
      <p className="iam-warnbox" role="note"><Icon name="warn" className="iam-ico" /><span>{t('iam.handover.onlyIf', { person: d.requestedBy })}</span></p>
      {start.error ? <ErrorBox error={start.error} compact /> : null}
      <Button variant="primary" icon="link" busy={start.isPending || start.isSuccess} onClick={() => start.mutate()}>{t('iam.handover.consent')}</Button>
      <p className="iam-muted iam-small">{t('iam.handover.once')}</p>
    </Gate>
  );
}

/** Rückkehr von Microsoft für einen Link an die Entra-Administration (`state` `h.…`), ohne Sitzung. */
export function EntraHandoverReturn() {
  const { router: { useSearch, usePathname, navigate }, product } = useIamConfig();
  useIamText();
  const search = useSearch();
  const pathname = usePathname();
  // Parameter einmal lesen; nach dem Senden verschwinden sie aus der Adresse
  const [body] = useState<EntraConsentReturn | null>(() => {
    const s = new URLSearchParams(search);
    const get = (k: string) => s.get(k) || undefined;
    const state = get('state'), code = get('code'), error = get('error');
    return state && ENTRA_STATE.exec(state)?.[1] === 'h' && (code || error) ? {
      state, ...(code ? { code } : {}), ...(error ? { error } : {}), ...(get('error_description') ? { errorDescription: get('error_description') } : {}),
    } : null;
  });
  const complete = useMutation({ mutationFn: (b: EntraConsentReturn) => handoverApi.complete(b) });
  const sent = useRef(false);
  useEffect(() => {
    if (!body || sent.current) return;
    sent.current = true;
    complete.mutate(body);
    if (search) navigate(pathname, { replace: true });
  });
  useEffect(() => { if (product) document.title = t('iam.handover.docTitle', { product }); }, [product]);

  if (!body) return <Gate title={t('iam.entra.return.none')} text={t('iam.handover.noReturn')} />;
  if (complete.isIdle || complete.isPending) return <Gate title={t('iam.handover.title')} text={t('iam.handover.completing')}><Loading inline /></Gate>;
  if (complete.error) {
    const e = complete.error, reason = reasonOf(e);
    if (reason === 'consent-unproven') return <Gate title={t('iam.entra.return.unproven')} text={t('iam.handover.unprovenText')} />;
    if (reason === 'consent-error') return <Gate title={t('iam.handover.declined')} text={t('iam.handover.declinedText')}><ErrorBox error={e} compact /></Gate>;
    if (e instanceof ApiError && e.status === 404) return <Gate title={t('iam.handover.used')} text={t('iam.handover.usedText')} />;
    return <Gate title={t('iam.handover.title')} text={t('iam.handover.failed')}><ErrorBox error={e} /></Gate>;
  }
  return <Gate title={t('iam.handover.done')} text={t('iam.handover.doneText', { organization: complete.data.organization })} />;
}
