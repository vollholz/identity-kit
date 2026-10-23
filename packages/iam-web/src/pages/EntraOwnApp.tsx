/**
 * Eigene App-Registrierung im Microsoft-Verzeichnis der Organisation (ab iam 0.3.0): Anleitung für die Kunden-IT
 * (App-Registrierung, Redirect-URI, Berechtigungen mit Administratorzustimmung, Secret) und die Felder Verzeichnis,
 * Anwendungs-ID, Secret und (optional) Ablauf des Secrets. Dieselben Bausteine dienen dem Dialog der
 * Organisations-Administration («du») und der öffentlichen Seite des Links «Credentials eintragen» («Sie», `formal`;
 * dort gibt der Link das Verzeichnis vor). Redirect-URI und Berechtigungen liefert der Server (`ownApp`).
 */
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { entraApi } from '../admin.ts';
import type { EntraConnection, EntraOwnAppGuide, EntraResult } from '../contract.ts';
import { ApiError } from '../problem.ts';
import { t, type IamTextKey } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { ErrorBox } from '../ui/states.tsx';

/** Anwendungs-ID: GUID wie in der Übersicht der App-Registrierung. */
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Verzeichnis: Verzeichnis-ID (GUID) oder eine Domäne. */
const TENANT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/i;

/** Gründe des Servers mit eigenem Text (neutral formuliert, für «du» und «Sie»). */
const REASON: Record<string, IamTextKey> = {
  'invalid-secret': 'iam.ownApp.err.invalidSecret',
  'secret-expired': 'iam.ownApp.err.secretExpired',
  'wrong-tenant': 'iam.ownApp.err.wrongDirectory',
  'invalid-client': 'iam.ownApp.err.invalidClient',
  'missing-permissions': 'iam.ownApp.err.missingPermissions',
  'tenant-not-found': 'iam.ownApp.err.notFound',
  'domains-taken': 'iam.ownApp.err.taken',
  'tenant-mismatch': 'iam.ownApp.err.mismatch',
  'encryption-missing': 'iam.ownApp.err.encryption',
};

/** Fehlertext zu einem Fehler des Servers beim Eintragen; `null`: kein bekannter Grund (dann die Meldung des Servers). */
export function ownAppErrorText(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const p = e.problem as { reason?: string; missing?: unknown; errors?: { path?: string }[] };
  // 422 der Validierung am Feld `tenant`: Verzeichnis nicht gefunden
  const reason = p.reason ?? (e.status === 422 && p.errors?.some(x => x.path === '/tenant') ? 'tenant-not-found' : undefined);
  const key = reason && Object.hasOwn(REASON, reason) ? REASON[reason]! : null;
  if (!key) return null;
  const missing = Array.isArray(p.missing) ? p.missing.filter((x): x is string => typeof x === 'string').join(', ') : '';
  return t(key, { missing: missing || '–' });
}

/** Fehler beim Eintragen: bekannter Grund mit eigenem Text, sonst die Meldung des Servers. */
export function OwnAppError({ error }: { error: unknown }) {
  const { Icon } = useIamUi();
  const text = ownAppErrorText(error);
  return text ? <p className="iam-warnbox" role="alert"><Icon name="warn" className="iam-ico" /><span>{text}</span></p> : <ErrorBox error={error} />;
}

/** Schritt-für-Schritt-Anleitung; `secretOnly`: nur der Schritt «Secret erstellen» (Secret wechseln). */
export function OwnAppGuideSteps({ guide, product, formal = false, secretOnly = false }: { guide: EntraOwnAppGuide; product: string; formal?: boolean; secretOnly?: boolean }) {
  const { Button, toast } = useIamUi();
  useIamText();
  const k = (key: string) => (formal ? `iam.handover.app.${key}` : `iam.ownApp.${key}`) as IamTextKey;
  const copy = () => { void navigator.clipboard?.writeText(guide.redirectUri).then(() => toast.show(t('iam.ownApp.copied')), () => undefined); };
  if (secretOnly) return <p>{t(k('step.secret'))}</p>;
  return (
    <ol className="iam-entra-guide" aria-label={t(k('guide'))}>
      <li>{t(k('step.register'), { product })}</li>
      <li>
        {t(k('step.redirect'))}
        <div className="iam-entra-link">
          <input className="iam-inp iam-mono-s" readOnly value={guide.redirectUri} aria-label={t('iam.ownApp.redirectUri')} onFocus={e => e.target.select()} />
          <Button icon="copy" onClick={copy}>{t('iam.entraAdd.copy')}</Button>
        </div>
      </li>
      <li>
        {t(k('step.permissions'))}
        <ul className="iam-entra-perms" aria-label={t('iam.ownApp.permissions')}>
          {guide.permissions.map(p => (
            <li key={`${p.type}:${p.name}`}>
              <code className="iam-mono-s">{p.name}</code>{' '}
              <span className="iam-pill iam-sm iam-st-idle">{t(p.type === 'Application' ? 'iam.ownApp.type.application' : 'iam.ownApp.type.delegated')}</span>
              {p.optional ? <> <span className="iam-pill iam-sm iam-st-off">{t('iam.ownApp.optional')}</span></> : null}{' '}
              <span className="iam-muted iam-small">{p.why}</span>
            </li>
          ))}
        </ul>
        {t(k('step.adminConsent'))}
      </li>
      <li>{t(k('step.secret'))}</li>
      <li>{t(k('step.ids'))}</li>
    </ol>
  );
}

/** Eingaben der Felder; `secretExpiresAt` als Datum (JJJJ-MM-TT) oder leer. */
export interface OwnAppDraft { tenant: string; clientId: string; clientSecret: string; secretExpiresAt: string }

/**
 * Felder Verzeichnis (ohne `tenant`: gibt der Link vor), Anwendungs-ID, Secret und Ablauf des Secrets (optional);
 * `tenantFixed`: beim Secret-Wechsel bleibt das Verzeichnis gleich (nur lesbar).
 */
export function OwnAppFields({ value, onChange, tenant = true, tenantFixed = false, formal = false, organization = '' }: {
  value: OwnAppDraft; onChange: (v: OwnAppDraft) => void; tenant?: boolean; tenantFixed?: boolean;
  /** Öffentliche Seite («Sie»), mit dem Namen der Organisation im Hinweis zum Secret. */
  formal?: boolean; organization?: string;
}) {
  const fid = useId();
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // Fokus beim Öffnen: erstes Feld, das noch auszufüllen ist
  const [first] = useState(() => (tenant && !tenantFixed ? 'tenant' : value.clientId ? 'secret' : 'clientId'));
  const focus = (k: string) => (first === k ? { 'data-autofocus': true } : {});
  const bad = { tenant: touched.tenant && !!value.tenant.trim() && !TENANT.test(value.tenant.trim()), clientId: touched.clientId && !!value.clientId.trim() && !GUID.test(value.clientId.trim()) };
  const blur = (k: string) => () => setTouched(x => ({ ...x, [k]: true }));
  return (
    <div className="iam-form iam-compact">
      {tenant ? (
        <>
          <label htmlFor={`${fid}-tenant`}>{t('iam.entra.directory')}</label>
          <input id={`${fid}-tenant`} className="iam-inp iam-mono-s" value={value.tenant} readOnly={tenantFixed} required autoComplete="off" spellCheck={false}
            placeholder="contoso.onmicrosoft.com" aria-invalid={bad.tenant || undefined} aria-describedby={`${fid}-tenant-h`}
            onChange={e => onChange({ ...value, tenant: e.target.value })} onBlur={blur('tenant')} {...focus('tenant')} />
          <div id={`${fid}-tenant-h`} className={bad.tenant ? 'iam-hint iam-ferr' : 'iam-hint'}>{t(bad.tenant ? 'iam.ownApp.notDirectory' : 'iam.entra.connect.hint')}</div>
        </>
      ) : null}
      <label htmlFor={`${fid}-client`}>{t('iam.ownApp.clientId')}</label>
      <input id={`${fid}-client`} className="iam-inp iam-mono-s" value={value.clientId} required autoComplete="off" spellCheck={false}
        placeholder="00000000-0000-0000-0000-000000000000" aria-invalid={bad.clientId || undefined} aria-describedby={`${fid}-client-h`}
        onChange={e => onChange({ ...value, clientId: e.target.value })} onBlur={blur('clientId')} {...focus('clientId')} />
      <div id={`${fid}-client-h`} className={bad.clientId ? 'iam-hint iam-ferr' : 'iam-hint'}>{t(bad.clientId ? 'iam.ownApp.notGuid' : 'iam.ownApp.clientId.hint')}</div>
      <label htmlFor={`${fid}-secret`}>{t('iam.ownApp.secret')}</label>
      <input id={`${fid}-secret`} type="password" className="iam-inp iam-mono-s" value={value.clientSecret} required autoComplete="off" spellCheck={false}
        aria-describedby={`${fid}-secret-h`} onChange={e => onChange({ ...value, clientSecret: e.target.value })} {...focus('secret')} />
      <div id={`${fid}-secret-h`} className="iam-hint">{formal ? t('iam.handover.app.secret.hint', { organization }) : t('iam.ownApp.secret.hint')}</div>
      <label htmlFor={`${fid}-exp`}>{t('iam.ownApp.expires')}</label>
      <input id={`${fid}-exp`} type="date" className="iam-inp" value={value.secretExpiresAt} aria-describedby={`${fid}-exp-h`}
        onChange={e => onChange({ ...value, secretExpiresAt: e.target.value })} />
      <div id={`${fid}-exp-h`} className="iam-hint">{t(formal ? 'iam.handover.app.expires.hint' : 'iam.ownApp.expires.hint')}</div>
    </div>
  );
}

/** Eingaben vollständig (`tenant` nur, wenn das Feld da ist). */
export const ownAppComplete = (v: OwnAppDraft, withTenant = true) =>
  (!withTenant || TENANT.test(v.tenant.trim())) && GUID.test(v.clientId.trim()) && v.clientSecret.trim().length > 0;
/** Körper ohne Leerzeichen am Rand (Kopieren bringt oft einen Zeilenumbruch mit); Ablauf als Zeitpunkt (Ende des Tages, UTC). */
export function ownAppBody(v: OwnAppDraft): { clientId: string; clientSecret: string; secretExpiresAt?: string } {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v.secretExpiresAt) ? `${v.secretExpiresAt}T23:59:59.000Z` : null;
  return { clientId: v.clientId.trim().toLowerCase(), clientSecret: v.clientSecret.trim(), ...(d ? { secretExpiresAt: d } : {}) };
}

/**
 * Dialog «Eigene App verbinden» bzw. «Secret wechseln» (`connection` mit `method: 'own'`: Verzeichnis fest, Anwendungs-ID
 * vorgegeben, darf wechseln): Anleitung, Felder, Fehler mit eigenem Text. Das Secret bleibt nur im Speicher des Dialogs.
 */
export function OwnAppDialog({ alias, orgLabel, product, guide, connection, onClose, onDone }: {
  alias: string | null; orgLabel: string; product: string; guide: EntraOwnAppGuide; connection?: EntraConnection | null;
  onClose: () => void; onDone: (r: EntraResult) => void | Promise<void>;
}) {
  const { Dialog, Button } = useIamUi();
  useIamText();
  const rotate = connection?.method === 'own';
  // Bestehende Verbindung (auch über die App der Plattform): das Verzeichnis bleibt gleich
  const [v, setV] = useState<OwnAppDraft>({ tenant: connection?.entraTenantId ?? '', clientId: rotate ? connection.clientId ?? '' : '', clientSecret: '', secretExpiresAt: '' });
  const save = useMutation({
    mutationFn: () => entraApi(alias).ownApp({ tenant: v.tenant.trim(), ...ownAppBody(v) }),
    onSuccess: async r => { setV(x => ({ ...x, clientSecret: '' })); await onDone(r); },
  });
  const ready = ownAppComplete(v);
  return (
    <Dialog title={t(rotate ? 'iam.ownApp.rotate.title' : 'iam.ownApp.title', { org: orgLabel })} onClose={onClose} onSubmit={() => { if (ready) save.mutate(); }} width={680}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" icon="key" disabled={!ready} busy={save.isPending}>{t(rotate ? 'iam.ownApp.rotate.go' : 'iam.ownApp.go')}</Button></>}>
      <p>{t(rotate ? 'iam.ownApp.rotate.intro' : 'iam.ownApp.intro', { org: orgLabel })}</p>
      <OwnAppGuideSteps guide={guide} product={product} secretOnly={rotate} />
      <OwnAppFields value={v} onChange={setV} tenantFixed={!!connection} />
      {save.error ? <OwnAppError error={save.error} /> : null}
    </Dialog>
  );
}
