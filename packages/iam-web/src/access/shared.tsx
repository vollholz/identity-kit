/**
 * Gemeinsames der Zugriffs-Bausteine: Fehleranzeige mit eigenen Sätzen, Ablaufdatum (Datumsfeld ↔ ISO-Zeitpunkt am Ende
 * des gewählten Tages, Ortszeit) und das Feld «Gültig bis».
 */
import { useAuthz } from '../authz.ts';
import { t } from '../texts/index.ts';
import { useIamUi } from '../ui/context.tsx';
import { ErrorBox } from '../ui/states.tsx';
import { accessErrorText } from './errors.ts';

/** Fehler im Dialog: bekannter Grund als eigener Satz, sonst die Meldung des Servers. */
export function AccessError({ error, compact }: { error: unknown; compact?: boolean }) {
  const authz = useAuthz();
  const { Icon } = useIamUi();
  const text = accessErrorText(error, authz);
  if (!text) return <ErrorBox error={error} compact={compact} />;
  return <div className="iam-warnbox" role="alert"><Icon name="warn" className="iam-ico" /><span>{text}</span></div>;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO-Zeitpunkt → Wert eines Datumsfelds (Ortszeit), leer ohne Ablauf. */
export function dateValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Datumsfeld → Ende dieses Tages (Ortszeit) als ISO; leer → `null`. «Bis 31.12.» gilt den ganzen 31.12. */
export function expiresAtOf(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).toISOString();
}

/** Fehler des Felds «Gültig bis»: nicht in der Zukunft bzw. ungültig; sonst `null`. */
export function expiryError(value: string, now = Date.now()): string | null {
  if (!value) return null;
  const iso = expiresAtOf(value);
  if (!iso) return t('iam.access.expiry.invalid');
  return new Date(iso).getTime() <= now ? t('iam.access.expiry.past') : null;
}

/** Feld «Gültig bis» (Datum, optional); `locked`: Rolle ohne Ablauf (org-admin, A15), mit Grund. */
export function ExpiryField({ id, value, onChange, error, locked }: { id: string; value: string; onChange: (v: string) => void; error?: string | null; locked?: string | null }) {
  const { Icon } = useIamUi();
  const hint = locked ?? t('iam.access.expiry.hint');
  return (
    <>
      <label htmlFor={id}>{t('iam.access.expiry.label')}</label>
      <input id={id} type="date" className="iam-inp" value={locked ? '' : value} onChange={e => onChange(e.target.value)} disabled={!!locked}
        aria-invalid={error ? true : undefined} aria-describedby={`${id}-h${error ? ` ${id}-e` : ''}`} />
      <div id={`${id}-h`} className="iam-muted iam-small">{hint}</div>
      {error ? <div id={`${id}-e`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{error}</div> : null}
    </>
  );
}
