/**
 * Modale Ebenen (Dialog, seitliches Blatt, Rückfrage) mit Fokusfalle, Esc zum Schliessen und Rückgabe des Fokus,
 * gerendert per Portal in document.body.
 */
import { useEffect, useId, useRef, type FormEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../texts/index.ts';
import { useIamUi } from './context.tsx';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"],[contenteditable="plaintext-only"],details>summary';

/**
 * Sichtbar und damit fokussierbar: kein Vorfahre mit `hidden` oder `display:none`, nicht im Inhalt eines geschlossenen
 * `<details>` (dessen `summary` schon). Eigene Prüfung zusätzlich zu `checkVisibility`, das nicht jede Umgebung kennt.
 */
export function isVisible(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) return false;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n.hidden || getComputedStyle(n).display === 'none') return false;
    const d: HTMLElement | null = n.parentElement;
    if (d instanceof HTMLDetailsElement && !d.open && !(n.tagName === 'SUMMARY' && d.querySelector(':scope > summary') === n)) return false;
  }
  return true;
}

const firstVisible = (root: HTMLElement, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)].find(isVisible) ?? null;

/** Offene Ebenen, zuoberst zuletzt: nur die oberste reagiert, wenn der Fokus verloren ging. */
const layers: HTMLElement[] = [];

/**
 * Hält den Fokus innerhalb von `ref`, gibt ihn beim Schliessen zurück. Fokus beim Öffnen: `initial`, sonst
 * `[data-autofocus]`, sonst das erste sichtbare fokussierbare Element, sonst die Ebene selbst (`tabIndex={-1}`) – nie ein
 * Element, das nicht zu sehen ist (z. B. in einem zugeklappten `<details>`), sonst bliebe der Fokus draussen und Esc
 * wirkungslos.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void, initial?: string) {
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const prev = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (!root) return;
    const first = (initial && firstVisible(root, initial)) || firstVisible(root, '[data-autofocus]') || firstVisible(root, FOCUSABLE) || root;
    const timer = setTimeout(() => first.focus({ preventScroll: true }), 0);
    layers.push(root);
    // Fokus verloren (z. B. der fokussierte Knopf wird während des Speicherns gesperrt): Esc und Tab wirken trotzdem
    const onLost = (e: KeyboardEvent) => {
      if (layers[layers.length - 1] !== root || (e.target !== document.body && e.target !== document.documentElement)) return;
      if (e.key === 'Escape' && escRef.current) { e.preventDefault(); escRef.current(); }
      else if (e.key === 'Tab') { e.preventDefault(); (firstVisible(root, FOCUSABLE) ?? root).focus(); }
    };
    document.addEventListener('keydown', onLost);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escRef.current) { e.stopPropagation(); e.preventDefault(); escRef.current(); return; }
      if (e.key !== 'Tab') return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el === document.activeElement || isVisible(el));
      if (!items.length) { e.preventDefault(); return; }
      const a = items[0]!, z = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === a || document.activeElement === root)) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && (document.activeElement === z || document.activeElement === root)) { e.preventDefault(); a.focus(); }
    };
    root.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      root.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onLost);
      layers.splice(layers.indexOf(root), 1);
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [active, ref, initial]);
}

/** Vertrag für `components.Dialog`. */
export interface ModalProps {
  title: ReactNode;
  crumbs?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Breite in px (420, 440, 480, 600, 720; sonst 560). */
  width?: number;
  role?: 'dialog' | 'alertdialog';
  initialFocus?: string;
  /** Formular statt div (Enter sendet ab). */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  /** Über allen anderen Ebenen (z. B. Sitzung abgelaufen). */
  top?: boolean;
  /**
   * Klick auf den Hintergrund schliesst (wie «Abbrechen»). Standard: nur ohne Formular (`onSubmit`) und ohne
   * Eingabefelder – Formulardialoge schliessen per Esc oder «Abbrechen», damit ein Fehlklick keine Eingaben verwirft.
   */
  dismissable?: boolean;
}

/** Eingabefelder, die einen Dialog zum Formular machen (Kästchen und Optionen allein nicht). */
const FIELDS = 'input:not([type=checkbox]):not([type=radio]):not([type=hidden]),textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"]';

export function Modal({ title, crumbs, onClose, children, footer, width, role = 'dialog', initialFocus, onSubmit, top, dismissable }: ModalProps) {
  const ref = useRef<HTMLDivElement & HTMLFormElement>(null);
  const id = useId();
  useFocusTrap(ref, true, onClose, initialFocus);
  const cls = `iam-modal${width ? ` iam-w-${width}` : ''}`;
  const body = (
    <>
      <div className="iam-modal-h">{crumbs ? <div className="iam-crumbs iam-modal-crumbs">{crumbs}</div> : null}<h3 id={id}>{title}</h3></div>
      <div className="iam-modal-b">{children}</div>
      {footer ? <div className="iam-modal-f">{footer}</div> : null}
    </>
  );
  return createPortal(
    <div className={`iam-overlay${top ? ' iam-top' : ''}`} onMouseDown={e => {
      if (e.target !== e.currentTarget) return;
      if (dismissable ?? (!onSubmit && !ref.current?.querySelector(FIELDS))) onClose();
      // bleibt offen: Fokus nicht an den Hintergrund verlieren (sonst wirkte Esc nicht mehr)
      else e.preventDefault();
    }}>
      {onSubmit
        ? <form ref={ref} tabIndex={-1} className={cls} role={role} aria-modal="true" aria-labelledby={id} noValidate onSubmit={e => { e.preventDefault(); onSubmit(e); }}>{body}</form>
        : <div ref={ref} tabIndex={-1} className={cls} role={role} aria-modal="true" aria-labelledby={id}>{body}</div>}
    </div>,
    document.body,
  );
}

export interface SheetProps { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; narrow?: boolean; wide?: boolean; label?: string }

/** Seitliches Blatt. */
export function Sheet({ title, sub, onClose, children, footer, narrow, wide, label }: SheetProps) {
  const { Icon } = useIamUi();
  const ref = useRef<HTMLElement>(null);
  const id = useId();
  useFocusTrap(ref, true, onClose);
  return createPortal(
    <div className="iam-sheet-wrap" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={ref} tabIndex={-1} className={`iam-sheet${narrow ? ' iam-narrow' : ''}${wide ? ' iam-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={label ? undefined : id} aria-label={label}>
        <div className="iam-sh-h">
          <div className="iam-t-row"><h3 id={id} className="iam-grow">{title}</h3><button type="button" className="iam-iconbtn" onClick={onClose} aria-label={t('iam.common.close')} title={t('iam.common.closeEsc')}><Icon name="x" className="iam-ico" /></button></div>
          {sub}
        </div>
        <div className="iam-sh-b">{children}</div>
        {footer ? <div className="iam-sh-f">{footer}</div> : null}
      </aside>
    </div>,
    document.body,
  );
}

export interface ConfirmProps {
  title: string;
  children: ReactNode;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  /**
   * Fokus beim Öffnen. Standard: bei `danger` immer «Abbrechen» – Enter löst nichts Folgenschweres aus –, sonst die
   * Hauptaktion. Abweichungen nur ausdrücklich und begründet.
   */
  focus?: 'cancel' | 'confirm';
  /** Papierkorb an der Hauptaktion: nur bei echtem Löschen. Standard: `danger` und die Aktion heisst «… löschen». */
  trash?: boolean;
}

/** Rückfrage (alertdialog) mit klarer Hauptaktion; Fokus und Papierkorb siehe `ConfirmProps`. */
export function Confirm({ title, children, confirm, danger, onConfirm, onClose, busy, focus, trash }: ConfirmProps) {
  const { Dialog, Button } = useIamUi();
  const start = focus ?? (danger ? 'cancel' : 'confirm');
  const bin = trash ?? (!!danger && /löschen|delete/i.test(confirm));
  // Hauptaktion während der Aktion gesperrt, aber fokussierbar (aria-disabled): der Fokus bleibt im Dialog
  return (
    <Dialog title={title} onClose={onClose} role="alertdialog" width={440} initialFocus={start === 'cancel' ? '[data-cancel]' : '[data-confirm]'}
      footer={<><Button variant="ghost" data-cancel onClick={onClose}>{t('iam.common.cancel')}</Button>
        <Button variant={danger ? 'danger-solid' : 'primary'} data-confirm busy={busy} icon={bin ? 'trash' : undefined} onClick={onConfirm}>{confirm}</Button></>}>
      {children}
    </Dialog>
  );
}
