/** Kurze Rückmeldungen unten in der Mitte (role=status), optional mit Aktion. Herkunft: vollholz/assets `web/src/ui/Toasts.tsx`. */
import { useCallback, useMemo, useRef, useState } from 'react';
import { describeError } from '../problem.ts';
import { t } from '../texts/index.ts';

export interface ToastOptions { action?: { label: string; run: () => void }; tone?: 'info' | 'error'; ms?: number }
/** Schnittstelle für `components.toast` (gleich wie in Assets). */
export interface ToastApi {
  show(text: string, opts?: ToastOptions): void;
  error(e: unknown, prefix?: string): void;
}

interface Toast { id: number; text: string; tone: 'info' | 'error'; action?: ToastOptions['action'] }

export function useToastHost() {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const remove = useCallback((id: number) => setItems(l => l.filter(x => x.id !== id)), []);
  const show = useCallback<ToastApi['show']>((text, opts = {}) => {
    const id = ++seq.current;
    setItems(l => [...l.slice(-3), { id, text, tone: opts.tone ?? 'info', action: opts.action }]);
    setTimeout(() => remove(id), opts.ms ?? (opts.action ? 8000 : opts.tone === 'error' ? 9000 : 4500));
  }, [remove]);
  const api = useMemo<ToastApi>(() => ({
    show,
    error(e, prefix) { const d = describeError(e); show(`${prefix ? `${prefix}: ` : ''}${d.title}${d.detail ? ` – ${d.detail}` : ''}`, { tone: 'error' }); },
  }), [show]);
  return { items, remove, api };
}

export function ToastHost({ host }: { host: ReturnType<typeof useToastHost> }) {
  return (
    <div className="iam-toasts" role="status" aria-live="polite">
      {host.items.map(x => (
        <div key={x.id} className={`iam-toast${x.tone === 'error' ? ' iam-err' : ''}`} role={x.tone === 'error' ? 'alert' : undefined}>
          <span>{x.text}</span>
          {x.action ? <button type="button" onClick={() => { x.action!.run(); host.remove(x.id); }}>{x.action.label}</button> : null}
          <button type="button" className="iam-toast-x" aria-label={t('iam.toast.close')} onClick={() => host.remove(x.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
