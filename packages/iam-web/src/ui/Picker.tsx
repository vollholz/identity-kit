/**
 * Auswahl-Popover: Suchfeld, Liste mit Pfeiltasten (Combobox/Listbox), Einfach- oder Mehrfachauswahl. Einträge fest
 * (`items`) oder vom Server nachgeladen (`load`). Herkunft: vollholz/assets `web/src/ui/Picker.tsx`.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../texts/index.ts';
import { useIamUi } from './context.tsx';
import type { IamIconName } from './icons.ts';
import { useFocusTrap } from './Overlay.tsx';

export interface PickItem { value: string; label: string; sub?: string; icon?: IamIconName; prefix?: ReactNode }

export interface PickerProps {
  anchor: HTMLElement;
  title?: string;
  items?: PickItem[];
  load?: (q: string) => Promise<PickItem[]>;
  multi?: boolean;
  selected?: string[];
  allowClear?: boolean;
  placeholder?: string;
  onPick: (values: string[]) => void;
  onClose: () => void;
}

export function Picker({ anchor, title, items, load, multi, selected = [], allowClear, placeholder, onPick, onClose }: PickerProps) {
  const { Icon, Button } = useIamUi();
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [sel, setSel] = useState<string[]>(selected);
  const [remote, setRemote] = useState<PickItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const hint = placeholder ?? t('iam.picker.search');
  useFocusTrap(ref, true, onClose, 'input');

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 32);
    const left = Math.max(16, Math.min(r.left, window.innerWidth - w - 16));
    const below = r.bottom + 6, h = 380;
    setPos({ left, top: below + h > window.innerHeight && r.top > h ? r.top - h - 6 : below });
  }, [anchor]);

  useEffect(() => {
    if (!load) return;
    let alive = true;
    setLoading(true);
    const timer = setTimeout(() => {
      load(q).then(r => { if (alive) { setRemote(r); setFailed(false); setLoading(false); } }, () => { if (alive) { setRemote([]); setFailed(true); setLoading(false); } });
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [q, load, attempt]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor, onClose]);

  const ql = q.trim().toLowerCase();
  const list = load ? (remote ?? []) : (items ?? []).filter(i => !ql || i.label.toLowerCase().includes(ql) || i.sub?.toLowerCase().includes(ql));
  const cur = Math.min(idx, Math.max(0, list.length - 1));

  const choose = (v: string) => {
    if (!multi) { onPick([v]); onClose(); return; }
    setSel(s => (s.includes(v) ? s.filter(x => x !== v) : [...s, v]));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(Math.min(cur + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(Math.max(cur - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = list[cur]; if (it) choose(it.value); else if (multi) { onPick(sel); onClose(); } }
  };
  useEffect(() => { ref.current?.querySelector(`[data-i="${cur}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [cur]);

  return createPortal(
    <div ref={ref} className="iam-pop" role="dialog" aria-label={title ?? t('iam.picker.title')} style={{ top: pos.top, left: pos.left }}>
      {title ? <div className="iam-ph">{title}</div> : null}
      <div className="iam-ps"><Icon name="search" className="iam-ico" />
        <input value={q} onChange={e => { setQ(e.target.value); setIdx(0); }} onKeyDown={onKey} placeholder={hint} aria-label={hint} autoComplete="off"
          role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={list[cur] ? `${listId}-${cur}` : undefined} />
      </div>
      <div className="iam-pl">
        <div role="status" aria-live="polite">
          {loading && !list.length ? <div className="iam-pi iam-muted">{t('iam.picker.loading')}</div> : null}
          {!loading && !failed && !list.length ? <div className="iam-pi iam-muted">{t('iam.picker.none')}</div> : null}
        </div>
        {!loading && failed ? <div className="iam-pi iam-muted" role="alert">{t('iam.picker.failed')} <Button size="sm" variant="ghost" onClick={() => setAttempt(a => a + 1)}>{t('iam.state.retry')}</Button></div> : null}
        <div role="listbox" id={listId} aria-label={title ?? t('iam.picker.list')} aria-multiselectable={multi || undefined}>
          {list.map((it, i) => {
            const on = sel.includes(it.value);
            return (
              <div key={it.value} id={`${listId}-${i}`} data-i={i} role="option" aria-selected={on} tabIndex={-1}
                className={`iam-pi${i === cur ? ' iam-on' : ''}${on ? ' iam-chk' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => choose(it.value)} onKeyDown={() => {}}>
                {multi ? <span className="iam-box"><Icon name="check" className="iam-ico" /></span> : null}
                {it.prefix}{it.icon ? <Icon name={it.icon} className="iam-ico" /> : null}
                <span className="iam-lb">{it.label}</span>{it.sub ? <span className="iam-sb">{it.sub}</span> : null}
                {!multi && on ? <Icon name="check" className="iam-ico" /> : null}
              </div>
            );
          })}
        </div>
      </div>
      {multi || allowClear ? (
        <div className="iam-pf">
          {allowClear ? <Button size="sm" variant="ghost" onClick={() => { onPick([]); onClose(); }}>{t('iam.picker.clear')}</Button> : null}
          <span className="iam-spacer" />
          {multi ? <Button size="sm" variant="primary" onClick={() => { onPick(sel); onClose(); }}>{t('iam.picker.apply')}</Button> : null}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/** Hilfe: Picker an einem Button öffnen. */
export function usePicker() {
  const [state, setState] = useState<Omit<PickerProps, 'onClose'> | null>(null);
  const node = state ? <Picker {...state} onClose={() => setState(null)} /> : null;
  return { open: (p: Omit<PickerProps, 'onClose'>) => setState(p), close: () => setState(null), node };
}
