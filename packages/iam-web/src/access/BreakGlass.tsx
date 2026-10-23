/**
 * Break-Glass (Spezifikation 7.8, 9.7, 11.2): befristet die eigene Freigabestufe auf 2 heben – nur Personen mit der Rolle
 * org-admin an der Organisation, mit Begründung und Dauer (1–240 Minuten); gibt keine Rechte. Gestartet wird im
 * `WhyDialog`, wenn die Vertraulichkeit verhindert (A19). `BreakGlassBanner` steht auf jeder Seite, solange es läuft.
 */
import { useEffect, useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthz } from '../authz.ts';
import { fmtDateTime } from '../format.ts';
import { iamKeys } from '../keys.ts';
import { ADMIN_ROLE } from '../permissions.ts';
import { useIam } from '../session.tsx';
import { intlLocale, t } from '../texts/index.ts';
import { useIamText } from '../texts/react.tsx';
import { useIamUi } from '../ui/context.tsx';
import { ErrorBox } from '../ui/states.tsx';
import { useBreakGlassMutations } from './api.ts';

export interface BreakGlass {
  /** Ich darf Break-Glass starten (Rolle org-admin an der Organisation). */
  allowed: boolean;
  /** Ende eines laufenden Break-Glass, sonst `null`. */
  until: Date | null;
  start(reason: string, minutes: number): Promise<void>;
  end(): Promise<void>;
}

/** Läuft das Break-Glass noch? (`breakGlassUntil` in der Zukunft) */
const activeUntil = (v: string | null | undefined, now = Date.now()): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) || d.getTime() <= now ? null : d;
};

export function useBreakGlass(): BreakGlass {
  const { me } = useIam();
  const m = useBreakGlassMutations();
  return {
    allowed: me.roles.includes(ADMIN_ROLE),
    until: activeUntil(me.breakGlassUntil),
    start: async (reason, minutes) => { await m.start.mutateAsync({ reason, minutes }); },
    end: async () => { await m.end.mutateAsync(); },
  };
}

/** Uhrzeit, am selben Tag ohne Datum. */
export function untilText(d: Date): string {
  const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' }) : fmtDateTime(d);
}

/** Banner bei aktivem Break-Glass mit «Beenden»; verschwindet von selbst mit dem Ablauf. */
export function BreakGlassBanner() {
  const { me, orgName } = useIam();
  const { Button, Icon, toast } = useIamUi();
  const authz = useAuthz();
  const qc = useQueryClient();
  const { end } = useBreakGlassMutations();
  useIamText();
  const until = activeUntil(me.breakGlassUntil);
  // Mit dem Ablauf neu prüfen: /auth/me liefert dann kein Break-Glass mehr
  useEffect(() => {
    if (!until) return;
    const ms = Math.min(until.getTime() - Date.now() + 500, 2 ** 31 - 1);
    const h = setTimeout(() => void qc.invalidateQueries({ queryKey: iamKeys.me }), Math.max(ms, 0));
    return () => clearTimeout(h);
  }, [until?.getTime(), qc]);
  if (!until) return null;
  return (
    <div className="iam-bg-banner" role="region" aria-label={t('iam.breakGlass.region')}>
      <Icon name="warn" className="iam-ico" />
      <p><b>{t('iam.breakGlass.active', { time: untilText(until) })}</b> <span>{t('iam.breakGlass.activeText', { level: authz.classificationLabel(2), org: orgName })}</span></p>
      <Button size="sm" busy={end.isPending} onClick={() => end.mutate(undefined, {
        onSuccess: () => toast.show(t('iam.breakGlass.ended')),
        onError: e => toast.error(e, t('iam.breakGlass.endFailed')),
      })}>{t('iam.breakGlass.end')}</Button>
    </div>
  );
}

const DURATIONS = [15, 30, 60, 120, 240] as const;

/** Formular «Notfallzugang starten» (im `WhyDialog`): Begründung Pflicht (1–500 Zeichen), Dauer 15 Minuten bis 4 Stunden. */
export function BreakGlassStart({ onStarted }: { onStarted?: () => void }) {
  const { Button, Icon, toast } = useIamUi();
  const authz = useAuthz();
  const { orgName } = useIam();
  const { start } = useBreakGlassMutations();
  const fid = useId();
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState<number>(60);
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const r = reason.trim();
    if (!r) { setErr(t('iam.breakGlass.reasonMissing')); document.getElementById(`${fid}-r`)?.focus(); return; }
    setErr(null);
    start.mutate({ reason: r, minutes }, {
      onSuccess: res => { toast.show(t('iam.breakGlass.started', { time: untilText(new Date(res.until)) })); onStarted?.(); },
    });
  };
  const duration = (n: number) => (n < 60 ? t('iam.breakGlass.minutes', { n }) : n === 60 ? t('iam.breakGlass.hour') : t('iam.breakGlass.hours', { n: n / 60 }));
  return (
    <section className="iam-bg-start" aria-labelledby={`${fid}-h`}>
      <h4 id={`${fid}-h`}>{t('iam.breakGlass.title')}</h4>
      <p className="iam-muted iam-small">{t('iam.breakGlass.intro', { level: authz.classificationLabel(2), org: orgName })}</p>
      <div className="iam-form iam-compact">
        <label htmlFor={`${fid}-r`}>{t('iam.breakGlass.reason')}</label>
        <textarea id={`${fid}-r`} className="iam-inp" rows={2} maxLength={500} value={reason} onChange={e => setReason(e.target.value)}
          aria-invalid={err ? true : undefined} aria-describedby={err ? `${fid}-e` : undefined} />
        {err ? <div id={`${fid}-e`} className="iam-ferr iam-hint"><Icon name="warn" className="iam-ico" />{err}</div> : null}
        <label htmlFor={`${fid}-m`}>{t('iam.breakGlass.duration')}</label>
        <select id={`${fid}-m`} className="iam-inp" value={minutes} onChange={e => setMinutes(Number(e.target.value))}>
          {DURATIONS.map(n => <option key={n} value={n}>{duration(n)}</option>)}
        </select>
      </div>
      {start.error ? <ErrorBox error={start.error} compact /> : null}
      <Button variant="danger" icon="warn" busy={start.isPending} onClick={submit}>{t('iam.breakGlass.start')}</Button>
    </section>
  );
}
