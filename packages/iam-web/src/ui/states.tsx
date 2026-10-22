/** Lade-, Leer- und Fehlerzustände – überall gleich aussehend und verständlich. Herkunft: vollholz/assets `web/src/ui/states.tsx`. */
import type { ReactNode } from 'react';
import { describeError, fieldErrorText } from '../problem.ts';
import { t } from '../texts/index.ts';
import { useIamUi } from './context.tsx';
import type { IamIconName } from './icons.ts';

export function Loading({ label, inline }: { label?: string; inline?: boolean }) {
  const text = label ?? t('iam.state.loading');
  if (inline) return <span className="iam-loading-inline" role="status"><span className="iam-spin" aria-hidden="true" />{text}</span>;
  return <div className="iam-loading" role="status" aria-live="polite"><span className="iam-spin" aria-hidden="true" /><span>{text}</span></div>;
}

/** Platzhalterzeilen für Tabellen, damit das Layout beim Laden nicht springt. */
export function SkeletonRows({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="iam-skeleton" role="status" aria-label={t('iam.state.loading')}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="iam-sk-row">{Array.from({ length: cols }, (_, j) => <span key={j} className="iam-sk" />)}</div>)}
    </div>
  );
}

export function Empty({ icon = 'search', title, children, action }: { icon?: IamIconName; title: string; children?: ReactNode; action?: ReactNode }) {
  const { Icon } = useIamUi();
  return <div className="iam-emptystate"><Icon name={icon} className="iam-ico" /><h3>{title}</h3>{children ? <div>{children}</div> : null}{action}</div>;
}

/** Fehler einer Abfrage oder Aktion (problem+json) mit Titel, Erklärung, Feldfehlern und Referenz. */
export function ErrorBox({ error, onRetry, names, compact }: { error: unknown; onRetry?: () => void; names?: Record<string, string>; compact?: boolean }) {
  const { Icon, Button } = useIamUi();
  const d = describeError(error);
  return (
    <div className={`iam-errbox${compact ? ' iam-compact' : ''}`} role="alert">
      <Icon name="warn" className="iam-ico" />
      <div className="iam-grow">
        <b>{d.title}</b>
        {d.detail ? <div>{d.detail}</div> : null}
        {d.fields.length ? <ul className="iam-ferrs">{d.fields.map((f, i) => <li key={i}>{fieldErrorText(f, names)}</li>)}</ul> : null}
        {d.requestId && (d.status ?? 0) >= 500 ? <div className="iam-ref-id">{t('iam.state.reference', { id: d.requestId })}</div> : null}
      </div>
      {onRetry && d.status !== 404 ? <Button size="sm" onClick={onRetry}>{t('iam.state.retry')}</Button> : null}
    </div>
  );
}

/**
 * Nicht gefunden (404), überall gleich (Spezifikation 11.1): gelöscht, für die Person nicht sichtbar oder in einer
 * anderen Organisation; mit der Organisation, in der sie arbeitet (`org`), und «Zur Übersicht» (`action` ersetzt den
 * Weg, `home` das Ziel). Nie «Erneut versuchen» – ein neuer Versuch findet nichts. `detail`: Zusatz des Servers.
 */
export function NotFound({ org, detail, action, home = '/' }: { org?: string; detail?: string; action?: ReactNode; home?: string }) {
  const { Icon, Button } = useIamUi();
  return (
    <div className="iam-emptystate" role="alert">
      <Icon name="search" className="iam-ico" /><h3>{t('iam.state.notFound.title')}</h3>
      <div>{t('iam.state.notFound.text')}{org ? <> {t('iam.state.notFound.org', { org })}</> : null}</div>
      {detail ? <div className="iam-muted iam-small">{detail}</div> : null}
      {action ?? <Button href={home}>{t('iam.state.home')}</Button>}
    </div>
  );
}

/** Ganzer Bereich nicht ladbar (z. B. 403/404). 404 erscheint als `NotFound` (mit `org`, ohne «Erneut versuchen»). */
export function ErrorState({ error, onRetry, org, home }: { error: unknown; onRetry?: () => void; org?: string; home?: string }) {
  const { Icon, Button } = useIamUi();
  const d = describeError(error);
  if (d.status === 404) return <NotFound org={org} detail={d.detail} home={home} />;
  const icon: IamIconName = d.status === 403 ? 'shield' : 'warn';
  return (
    <div className="iam-emptystate" role="alert">
      <Icon name={icon} className="iam-ico" /><h3>{d.title}</h3>
      {d.detail ? <div>{d.detail}</div> : null}
      {d.requestId && (d.status ?? 0) >= 500 ? <div className="iam-muted iam-small">{t('iam.state.reference', { id: d.requestId })}</div> : null}
      {onRetry ? <Button onClick={onRetry}>{t('iam.state.retry')}</Button> : null}
    </div>
  );
}
