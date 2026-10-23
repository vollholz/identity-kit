/**
 * Eigene App-Registrierung im Microsoft-Verzeichnis der Organisation (ab iam 0.3.0): Anleitung für die Kunden-IT
 * (App-Registrierung, Redirect-URI, Berechtigungen mit Administratorzustimmung, Secret) und die Felder Verzeichnis-ID,
 * Anwendungs-ID und Secret. Dieselben Bausteine dienen dem Dialog der Organisations-Administration («du») und der
 * öffentlichen Seite des Links «Credentials eintragen» («Sie», `formal`). Redirect-URI und Berechtigungen liefert der
 * Server (`ownApp` im Status bzw. `info` des Links).
 */
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { entraApi } from '../admin.ts';
import type { EntraConnection, EntraOwnAppGuide, EntraOwnAppInput, EntraResult } from '../contract.ts';
import { ApiError } from '../problem.ts';
import { t, type IamTextKey } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { ErrorBox } from '../ui/states.tsx';

/** Verzeichnis-ID und Anwendungs-ID: GUID wie in der Übersicht der App-Registrierung. */
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gründe des Servers mit eigenem Text (neutral formuliert, für «du» und «Sie»). */
const REASON: Record<string, IamTextKey> = {
  'invalid-client': 'iam.ownApp.err.invalidClient',
  'missing-permissions': 'iam.ownApp.err.missingPermissions',
  'consent-missing': 'iam.ownApp.err.consentMissing',
  'tenant-not-found': 'iam.ownApp.err.notFound',
  'tenant-taken': 'iam.ownApp.err.taken',
  'tenant-mismatch': 'iam.ownApp.err.mismatch',
};

/** Fehlertext zu einem Fehler des Servers beim Eintragen; `null`: kein bekannter Grund (dann die Meldung des Servers). */
export function ownAppErrorText(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const p = e.problem as { reason?: string; missing?: unknown };
  const key = p.reason && Object.hasOwn(REASON, p.reason) ? REASON[p.reason]! : null;
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
  const fid = useId();
  const k = (key: string) => (formal ? `iam.handover.app.${key}` : `iam.ownApp.${key}`) as IamTextKey;
  const copy = () => { void navigator.clipboard?.writeText(guide.redirectUri).then(() => toast.show(t('iam.ownApp.copied')), () => undefined); };
  if (secretOnly) return <p>{t(k('step.secret'))}</p>;
  return (
    <ol className="iam-entra-guide" aria-label={t(k('guide'))}>
      <li>{t(k('step.register'), { product })}</li>
      <li>
        {t(k('step.redirect'))}
        <div className="iam-entra-link">
          <input id={`${fid}-uri`} className="iam-inp iam-mono-s" readOnly value={guide.redirectUri} aria-label={t('iam.ownApp.redirectUri')} onFocus={e => e.target.select()} />
          <Button icon="copy" onClick={copy}>{t('iam.entraAdd.copy')}</Button>
        </div>
      </li>
      <li>
        {t(k('step.permissions'))}
        <ul className="iam-entra-perms" aria-label={t('iam.ownApp.permissions')}>
          {guide.permissions.map(p => (
            <li key={`${p.type}:${p.name}`}><code className="iam-mono-s">{p.name}</code> <span className="iam-pill iam-sm iam-st-idle">{t(p.type === 'Application' ? 'iam.ownApp.type.application' : 'iam.ownApp.type.delegated')}</span> <span className="iam-muted iam-small">{p.why}</span></li>
          ))}
        </ul>
        {t(k('step.adminConsent'))}
      </li>
      <li>{t(k('step.secret'))}</li>
      <li>{t(k('step.ids'))}</li>
    </ol>
  );
}

/** Felder Verzeichnis-ID, Anwendungs-ID und Secret; `fixed`: beim Secret-Wechsel vorgegeben (nur lesbar). */
export function OwnAppFields({ value, onChange, fixed, formal = false, organization = '' }: {
  value: EntraOwnAppInput; onChange: (v: EntraOwnAppInput) => void; fixed?: { entraTenantId: string; clientId: string };
  /** Öffentliche Seite («Sie»), mit dem Namen der Organisation im Hinweis zum Secret. */
  formal?: boolean; organization?: string;
}) {
  const fid = useId();
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const bad = (k: 'entraTenantId' | 'clientId') => touched[k] && !!value[k].trim() && !GUID.test(value[k].trim());
  const field = (k: 'entraTenantId' | 'clientId', label: IamTextKey, hint: IamTextKey) => (
    <>
      <label htmlFor={`${fid}-${k}`}>{t(label)}</label>
      <input id={`${fid}-${k}`} className="iam-inp iam-mono-s" value={value[k]} readOnly={!!fixed} required autoComplete="off" spellCheck={false}
        placeholder="00000000-0000-0000-0000-000000000000" aria-invalid={bad(k) || undefined} aria-describedby={`${fid}-${k}-h`}
        onChange={e => onChange({ ...value, [k]: e.target.value })} onBlur={() => setTouched(x => ({ ...x, [k]: true }))} {...(k === 'entraTenantId' && !fixed ? { 'data-autofocus': true } : {})} />
      <div id={`${fid}-${k}-h`} className={bad(k) ? 'iam-hint iam-ferr' : 'iam-hint'}>{t(bad(k) ? 'iam.ownApp.notGuid' : hint)}</div>
    </>
  );
  return (
    <div className="iam-form iam-compact">
      {field('entraTenantId', 'iam.ownApp.tenantId', 'iam.ownApp.tenantId.hint')}
      {field('clientId', 'iam.ownApp.clientId', 'iam.ownApp.clientId.hint')}
      <label htmlFor={`${fid}-secret`}>{t('iam.ownApp.secret')}</label>
      <input id={`${fid}-secret`} type="password" className="iam-inp iam-mono-s" value={value.clientSecret} required autoComplete="off" spellCheck={false}
        aria-describedby={`${fid}-secret-h`} onChange={e => onChange({ ...value, clientSecret: e.target.value })} {...(fixed ? { 'data-autofocus': true } : {})} />
      <div id={`${fid}-secret-h`} className="iam-hint">{formal ? t('iam.handover.app.secret.hint', { organization }) : t('iam.ownApp.secret.hint')}</div>
    </div>
  );
}

/** Eingaben vollständig: zwei GUIDs und ein Secret. */
export const ownAppComplete = (v: EntraOwnAppInput) => GUID.test(v.entraTenantId.trim()) && GUID.test(v.clientId.trim()) && v.clientSecret.trim().length > 0;
/** Eingaben ohne Leerzeichen am Rand (das Secret unverändert bis auf den Rand: Kopieren bringt oft einen Zeilenumbruch mit). */
export const ownAppBody = (v: EntraOwnAppInput): EntraOwnAppInput => ({ entraTenantId: v.entraTenantId.trim().toLowerCase(), clientId: v.clientId.trim().toLowerCase(), clientSecret: v.clientSecret.trim() });

/**
 * Dialog «Eigene App verbinden» bzw. «Secret wechseln» (`connection` mit `method: 'own'`): Anleitung, Felder, Fehler mit
 * eigenem Text. Das Secret bleibt nur im Speicher des Dialogs.
 */
export function OwnAppDialog({ alias, orgLabel, product, guide, connection, onClose, onDone }: {
  alias: string | null; orgLabel: string; product: string; guide: EntraOwnAppGuide; connection?: EntraConnection | null;
  onClose: () => void; onDone: (r: EntraResult) => void | Promise<void>;
}) {
  const { Dialog, Button } = useIamUi();
  useIamText();
  const fixed = connection?.method === 'own' && connection.clientId ? { entraTenantId: connection.entraTenantId, clientId: connection.clientId } : undefined;
  const [v, setV] = useState<EntraOwnAppInput>({ entraTenantId: fixed?.entraTenantId ?? '', clientId: fixed?.clientId ?? '', clientSecret: '' });
  const save = useMutation({ mutationFn: () => entraApi(alias).ownApp(ownAppBody(v)), onSuccess: async r => { setV(x => ({ ...x, clientSecret: '' })); await onDone(r); } });
  const ready = ownAppComplete(v);
  return (
    <Dialog title={t(fixed ? 'iam.ownApp.rotate.title' : 'iam.ownApp.title', { org: orgLabel })} onClose={onClose} onSubmit={() => { if (ready) save.mutate(); }} width={680}
      footer={<><Button variant="ghost" onClick={onClose}>{t('iam.common.cancel')}</Button><Button type="submit" variant="primary" icon="key" disabled={!ready} busy={save.isPending}>{t(fixed ? 'iam.ownApp.rotate.go' : 'iam.ownApp.go')}</Button></>}>
      <p>{t(fixed ? 'iam.ownApp.rotate.intro' : 'iam.ownApp.intro', { org: orgLabel })}</p>
      <OwnAppGuideSteps guide={guide} product={product} secretOnly={!!fixed} />
      <OwnAppFields value={v} onChange={setV} fixed={fixed} />
      {save.error ? <OwnAppError error={save.error} /> : null}
    </Dialog>
  );
}
