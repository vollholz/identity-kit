/**
 * Menü-Button nach ARIA-Muster «Menu Button» (Vertrag für `components.Menu`): Pfeiltasten, Pos1/Ende, Esc, Fokus zurück
 * zum Button. Einträge sind Buttons mit role="menuitem" (bzw. menuitemradio); `children` erhält `close`.
 * `fixed`: Menü schwebt über allem (z. B. in Tabellen mit Scrollbereich), rechtsbündig am Button, unterhalb oder –
 * wenn dort kein Platz ist – oberhalb.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { buttonClass } from './Button.tsx';
import { useIamUi } from './context.tsx';
import type { IamIconName } from './icons.ts';

export interface MenuButtonProps {
  /** Zugänglicher Name des Menüs. */
  label: string;
  /** Inhalt des Buttons; ohne sichtbaren Text mit `aria-label` über `buttonLabel`. */
  button: ReactNode;
  buttonLabel?: string;
  /** Kurzinfo beim Überfahren (title). */
  title?: string;
  /** Klassen des Buttons; Standard: kleiner Knopf. */
  className?: string;
  fixed?: boolean;
  children: (close: () => void) => ReactNode;
}

export function MenuButton({ label, button, buttonLabel, title, className, fixed, children }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open || !fixed || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    // Unten kein Platz (z. B. letzte Zeile auf dem Telefon): über dem Button öffnen, damit das Menü sichtbar bleibt
    const h = ref.current?.offsetHeight ?? 0, w = ref.current?.offsetWidth ?? 0;
    const top = r.bottom + 4 + h > window.innerHeight - 8 && r.top - 4 - h >= 8 ? r.top - 4 - h : r.bottom + 4;
    // Rechtsbündig; ragte das Menü links hinaus (Button weit links, schmaler Bildschirm), linksbündig im Fenster
    setPos(r.right - w < 8
      ? { position: 'fixed', top, left: Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)), right: 'auto' }
      : { position: 'fixed', top, right: Math.max(8, window.innerWidth - r.right), left: 'auto' });
  }, [open, fixed]);
  useEffect(() => {
    if (!open) return;
    // Ohne Scrollen fokussieren: sonst löst der Fokus selbst ein Scroll-Ereignis aus und schliesst das schwebende Menü
    ref.current?.querySelector<HTMLElement>('[role^=menuitem][aria-checked=true], [role^=menuitem]')?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    // Schwebendes Menü folgt dem Button nicht: beim Scrollen oder Grössenwechsel schliessen – erst ab dem nächsten Frame,
    // damit das Scrollen beim Öffnen (Klick, Fokus) es nicht sofort wieder schliesst
    const onMove = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    const raf = fixed ? requestAnimationFrame(() => { window.addEventListener('scroll', onMove, true); window.addEventListener('resize', onMove); }) : 0;
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onMove, true); window.removeEventListener('resize', onMove);
    };
  }, [open, fixed]);
  const close = () => { setOpen(false); btn.current?.focus(); };
  const onKey = (e: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^=menuitem]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  return (
    <div className="iam-menu-anchor">
      <button ref={btn} type="button" className={className ?? buttonClass('default', 'sm')} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={buttonLabel} title={title} onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        {button}
      </button>
      {open ? <div ref={ref} id={id} className={`iam-menu iam-menu-pop${fixed ? ' iam-fixed' : ''}`} style={pos} role="menu" aria-label={label} onKeyDown={onKey} tabIndex={-1}>{children(close)}</div> : null}
    </div>
  );
}

/**
 * Eintrag eines Menüs. Mit `why` gesperrt mit Grund: bleibt fokussierbar (aria-disabled), der Grund steht sichtbar
 * darunter und ist die Beschreibung des Eintrags; der zugängliche Name bleibt die Aktion.
 */
export function MenuItem({ icon, label, why, onPick, danger }: { icon: IamIconName; label: string; why?: string | null; onPick: () => void; danger?: boolean }) {
  const { Icon } = useIamUi();
  const id = useId();
  return (
    <button type="button" role="menuitem" className={`iam-menu-i${danger ? ' iam-danger' : ''}`} aria-label={label} aria-disabled={why ? true : undefined} aria-describedby={why ? id : undefined}
      onClick={() => { if (!why) onPick(); }}>
      <Icon name={icon} className="iam-ico" /><span className="iam-menu-tx">{label}{why ? <span id={id} className="iam-menu-why">{why}</span> : null}</span>
    </button>
  );
}
