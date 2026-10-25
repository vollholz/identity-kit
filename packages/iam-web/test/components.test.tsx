/** Grundkomponenten, Austausch und axe. */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError, Button, Confirm, ErrorBox, ErrorState, ICON_NAMES, MenuButton, MenuItem, Modal, Picker, Sheet, Table, useIamUi,
  type ButtonProps, type IconProps, type ToastApi,
} from '../src/index.ts';
import { axeProblems, renderUi } from './render.tsx';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Fehleranzeige', () => {
  it('zeigt Titel, Erklärung und Feldfehler mit Namen', () => {
    const e = new ApiError(422, { title: 'Ungültige Eingabe', detail: 'Bitte prüfen.', errors: [{ path: '/permissions/p1', message: 'gibt es nicht' }] });
    renderUi(<ErrorBox error={e} names={{ p1: 'Recht' }} />);
    const box = screen.getByRole('alert');
    expect(box).toHaveTextContent('Ungültige Eingabe');
    expect(box).toHaveTextContent('Bitte prüfen.');
    expect(box).toHaveTextContent('Recht: gibt es nicht');
  });

  it('nennt bei Serverfehlern die Referenz und bietet «Erneut versuchen»', async () => {
    const retry = vi.fn();
    renderUi(<ErrorState error={new ApiError(500, { title: 'Interner Fehler' }, 'req-1')} onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Referenz req-1');
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(retry).toHaveBeenCalled();
  });
});

describe('Dialoge', () => {
  it('fokussiert das erste Feld, hält den Fokus und schliesst mit Esc', async () => {
    const close = vi.fn();
    renderUi(
      <>
        <button type="button">draussen</button>
        <Modal title="Test" onClose={close} footer={<button type="button">OK</button>}><input aria-label="Feld" /></Modal>
      </>,
    );
    const dlg = screen.getByRole('dialog', { name: 'Test' });
    await waitFor(() => expect(screen.getByLabelText('Feld')).toHaveFocus());
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText('Feld')).toHaveFocus();
    fireEvent.keyDown(dlg, { key: 'Escape' });
    expect(close).toHaveBeenCalled();
    expect(await axeProblems()).toEqual([]);
  });

  it('Fokus startet auf dem ersten sichtbaren Element – nicht im zugeklappten <details>; Esc schliesst', async () => {
    const close = vi.fn();
    renderUi(
      <>
        <button type="button">draussen</button>
        <Modal title="Rollen" onClose={close} footer={<button type="button">Schliessen</button>}>
          <input type="checkbox" aria-label="gesperrt" disabled />
          <div hidden><button type="button">versteckt</button></div>
          <details><summary>Welche Rechte hat welche Rolle?</summary><div role="region" aria-label="Matrix" tabIndex={0}>Matrix</div></details>
        </Modal>
      </>,
    );
    const dlg = screen.getByRole('dialog', { name: 'Rollen' });
    const summary = screen.getByText('Welche Rechte hat welche Rolle?');
    await waitFor(() => expect(summary).toHaveFocus());
    expect(screen.getByRole('region', { name: 'Matrix', hidden: true })).not.toHaveFocus();
    screen.getByRole('button', { name: 'Schliessen' }).focus();
    await userEvent.tab();
    expect(summary).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Schliessen' })).toHaveFocus();
    expect(dlg.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ohne sichtbares Bedienelement erhält der Dialog selbst den Fokus, Esc wirkt', async () => {
    const close = vi.fn();
    renderUi(<Modal title="Nur Text" onClose={close}><p>Nichts zu tun.</p><details><summary hidden>zu</summary><button type="button">innen</button></details></Modal>);
    const dlg = screen.getByRole('dialog', { name: 'Nur Text' });
    await waitFor(() => expect(dlg).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalled();
  });

  it('geht der Fokus verloren, wirken Esc und Tab weiter; Bestätigung bleibt während der Aktion fokussierbar', async () => {
    const close = vi.fn(), ok = vi.fn();
    const { unmount } = renderUi(<Modal title="Speichern" onClose={close} onSubmit={() => {}}><input aria-label="Feld" /></Modal>);
    await waitFor(() => expect(screen.getByLabelText('Feld')).toHaveFocus());
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(screen.getByLabelText('Feld')).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    unmount();
    renderUi(<Confirm title="Löschen?" confirm="Löschen" danger busy onConfirm={ok} onClose={() => {}}><p>x</p></Confirm>);
    const b = screen.getByRole('button', { name: 'Löschen' });
    expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(b).toBeEnabled();
    await userEvent.click(b);
    expect(ok).not.toHaveBeenCalled();
  });

  it('danger-Rückfrage startet auf «Abbrechen» – Enter bricht ab; Papierkorb nur beim Löschen', async () => {
    const ok = vi.fn(), close = vi.fn();
    const { unmount } = renderUi(<Confirm title="Löschen?" confirm="Löschen" danger onConfirm={ok} onClose={close}><p>Weg ist weg.</p></Confirm>);
    expect(screen.getByRole('alertdialog', { name: 'Löschen?' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    expect(ok).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Löschen' }).querySelector('svg')).not.toBeNull();
    unmount();
    for (const label of ['Entziehen', 'Trotzdem speichern', 'Person entfernen']) {
      const r = renderUi(<Confirm title="Sicher?" confirm={label} danger onConfirm={() => {}} onClose={() => {}}><p>x</p></Confirm>);
      expect(screen.getByRole('button', { name: label }).querySelector('svg')).toBeNull();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
      r.unmount();
    }
    renderUi(<Confirm title="Eintrag entfernen?" confirm="Entfernen" danger trash onConfirm={() => {}} onClose={() => {}}><p>x</p></Confirm>);
    expect(screen.getByRole('button', { name: 'Entfernen' }).querySelector('svg')).not.toBeNull();
  });

  it('ohne danger startet die Bestätigung auf der Hauptaktion; Ausnahmen nur ausdrücklich', async () => {
    const ok = vi.fn();
    const { unmount } = renderUi(<Confirm title="Einreichen?" confirm="Einreichen" onConfirm={ok} onClose={() => {}}><p>x</p></Confirm>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Einreichen' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    expect(ok).toHaveBeenCalled();
    unmount();
    renderUi(<Confirm title="Weiter?" confirm="Weiter" danger focus="confirm" onConfirm={() => {}} onClose={() => {}}><p>x</p></Confirm>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Weiter' })).toHaveFocus());
  });

  it('Hintergrund-Klick schliesst Formulardialoge nicht (Esc und «Abbrechen» schon), andere Dialoge schon', async () => {
    const close = vi.fn();
    const { unmount } = renderUi(<Modal title="Formular" onClose={close} onSubmit={() => {}}><input aria-label="Feld" /></Modal>);
    const form = screen.getByRole('dialog', { name: 'Formular' });
    fireEvent.mouseDown(form.parentElement!);
    expect(close).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByLabelText('Feld'));
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(form, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    unmount();
    const close3 = vi.fn();
    const f = renderUi(<Modal title="Bearbeiten" onClose={close3}><input aria-label="Name" /></Modal>);
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Bearbeiten' }).parentElement!);
    expect(close3).not.toHaveBeenCalled();
    f.unmount();
    const close2 = vi.fn();
    renderUi(<Modal title="Info" onClose={close2}><p>Nur lesen</p></Modal>);
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Info' }).parentElement!);
    expect(close2).toHaveBeenCalledTimes(1);
  });

  it('Formulardialog sendet mit Enter ab; Blatt schliesst mit Knopf und Esc', async () => {
    const submit = vi.fn(), close = vi.fn();
    const { unmount } = renderUi(<Modal title="Neu" onClose={() => {}} onSubmit={submit} footer={<button type="submit">Anlegen</button>}><input aria-label="Name" /></Modal>);
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
    await userEvent.keyboard('Anna{Enter}');
    expect(submit).toHaveBeenCalledTimes(1);
    unmount();
    renderUi(<Sheet title="Details" onClose={close}><p>Inhalt</p></Sheet>);
    const sheet = screen.getByRole('dialog', { name: 'Details' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Schliessen' }));
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(2);
    expect(await axeProblems()).toEqual([]);
  });
});

describe('Nicht gefunden (404)', () => {
  it('einheitlich: gelöscht, nicht sichtbar oder andere Organisation, mit Organisation und «Zur Übersicht», ohne «Erneut versuchen»', async () => {
    const retry = vi.fn();
    const e = new ApiError(404, { title: 'Rolle nicht gefunden', detail: 'Die Rolle gibt es nicht.' });
    const { unmount } = renderUi(<ErrorState error={e} onRetry={retry} org="Demo AG" home="/start" />);
    const box = screen.getByRole('alert');
    expect(within(box).getByRole('heading', { name: 'Nicht gefunden' })).toBeInTheDocument();
    expect(box).toHaveTextContent('Gelöscht, für dich nicht sichtbar oder in einer anderen Organisation. Du arbeitest in «Demo AG».');
    expect(within(box).getByRole('link', { name: 'Zur Übersicht' })).toHaveAttribute('href', '/start');
    expect(within(box).queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
    unmount();
    renderUi(<ErrorBox error={e} onRetry={retry} />);
    expect(screen.queryByRole('button', { name: 'Erneut versuchen' })).toBeNull();
  });
});

describe('Menü', () => {
  it('per Tastatur: Pfeil öffnet, Pfeile, Pos1/Ende wandern, Esc schliesst und gibt den Fokus zurück; gesperrte Einträge mit Grund', async () => {
    const pick = vi.fn(), del = vi.fn();
    renderUi(
      <MenuButton label="Aktionen" buttonLabel="Mehr zu Olivia" button="⋯">
        {close => <>
          <MenuItem icon="send" label="Einladung erneut senden" onPick={() => { pick(); close(); }} />
          <MenuItem icon="trash" label="Person entfernen …" danger why="Die letzte Person mit «Organisations-Admin» bleibt." onPick={del} />
        </>}
      </MenuButton>,
    );
    const btn = screen.getByRole('button', { name: 'Mehr zu Olivia' });
    expect(btn).toHaveAttribute('aria-haspopup', 'menu');
    btn.focus();
    await userEvent.keyboard('{ArrowDown}');
    const menu = await screen.findByRole('menu', { name: 'Aktionen' });
    const [send, remove] = within(menu).getAllByRole('menuitem');
    await waitFor(() => expect(send).toHaveFocus());
    await userEvent.keyboard('{End}');
    expect(remove).toHaveFocus();
    expect(remove).toHaveAttribute('aria-disabled', 'true');
    expect(remove).toHaveAccessibleName('Person entfernen …');
    expect(remove).toHaveAccessibleDescription('Die letzte Person mit «Organisations-Admin» bleibt.');
    await userEvent.keyboard('{Enter}');
    expect(del).not.toHaveBeenCalled();
    await userEvent.keyboard('{Home}');
    expect(send).toHaveFocus();
    expect(await axeProblems()).toEqual([]);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(btn).toHaveFocus();
    await userEvent.click(btn);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Einladung erneut senden' }));
    expect(pick).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('schwebend: unten kein Platz – öffnet über dem Button; links kein Platz – linksbündig im Fenster', async () => {
    const h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!, w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.getAttribute('role') === 'menu' ? 80 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.getAttribute('role') === 'menu' ? 240 : 0; } });
    try {
      renderUi(<MenuButton label="Aktionen" buttonLabel="Mehr zu Olivia" fixed button="⋯">{() => <button type="button" role="menuitem">Person entfernen …</button>}</MenuButton>);
      const btn = screen.getByRole('button', { name: 'Mehr zu Olivia' });
      btn.getBoundingClientRect = () => ({ top: 800, bottom: 830, left: 150, right: 180, width: 30, height: 30, x: 150, y: 800, toJSON: () => ({}) });
      vi.stubGlobal('innerHeight', 844); vi.stubGlobal('innerWidth', 390);
      await userEvent.click(btn);
      const menu = await screen.findByRole('menu', { name: 'Aktionen' });
      expect(menu.style.top).toBe('716px');
      expect(menu.style.left).toBe('142px');
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', h);
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', w);
    }
  });
});

describe('Auswahl (Picker)', () => {
  const items = [{ value: 'a', label: 'Bearbeiter:in' }, { value: 'b', label: 'Leser:in' }, { value: 'c', label: 'Bereichs-Admin' }];
  const anchor = () => { const a = document.createElement('button'); a.textContent = 'Rolle wählen'; document.body.appendChild(a); return a; };

  it('filtert, wählt mit Pfeiltasten und Enter', async () => {
    const pick = vi.fn(), close = vi.fn();
    renderUi(<Picker anchor={anchor()} title="Rolle" items={items} onPick={pick} onClose={close} />);
    const box = screen.getByRole('combobox');
    await waitFor(() => expect(box).toHaveFocus());
    await userEvent.type(box, 'er');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await userEvent.clear(box);
    await userEvent.type(box, ':in');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(pick).toHaveBeenCalledWith(['b']);
    expect(close).toHaveBeenCalled();
  });

  it('Mehrfachauswahl übernimmt erst mit «Übernehmen»', async () => {
    const pick = vi.fn();
    renderUi(<Picker anchor={anchor()} items={items} multi selected={['a']} onPick={pick} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('option', { name: /Leser:in/ }));
    expect(pick).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: /Leser:in/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(pick).toHaveBeenCalledWith(['a', 'b']);
    expect(await axeProblems()).toEqual([]);
  });

  it('lädt Einträge vom Server nach, mit Leer- und Fehlerzustand', async () => {
    let fail = false;
    const load = vi.fn(async (q: string) => { if (fail) throw new Error('weg'); return q === 'nix' ? [] : [{ value: 'p1', label: `Treffer für ${q || 'alle'}` }]; });
    renderUi(<Picker anchor={anchor()} load={load} onPick={() => {}} onClose={() => {}} />);
    expect(await screen.findByRole('option', { name: 'Treffer für alle' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('combobox'), 'nix');
    expect(await screen.findByText('Keine Treffer')).toBeInTheDocument();
    fail = true;
    await userEvent.type(screen.getByRole('combobox'), '!');
    expect(await screen.findByText('Laden fehlgeschlagen.')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByRole('option', { name: 'Treffer für nix!' })).toBeInTheDocument();
  });

  it('nachgeladene Treffer gelten nur für ihren Suchbegriff: alte sind weder anklickbar noch per Enter wählbar', async () => {
    const pending = new Map<string, (r: { value: string; label: string }[]) => void>();
    const load = vi.fn((q: string) => new Promise<{ value: string; label: string }[]>(res => { pending.set(q, res); }));
    const pick = vi.fn();
    renderUi(<Picker anchor={anchor()} load={load} onPick={pick} onClose={() => {}} />);
    await waitFor(() => expect(pending.has('')).toBe(true));
    act(() => pending.get('')!([{ value: 'alt', label: 'Anna Alt' }]));
    expect(await screen.findByRole('option', { name: 'Anna Alt' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('combobox'), 'b');
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByText('Wird geladen …')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(pick).not.toHaveBeenCalled();
    await waitFor(() => expect(pending.has('b')).toBe(true));
    await userEvent.keyboard('{Enter}');
    expect(pick).not.toHaveBeenCalled();
    act(() => pending.get('b')!([{ value: 'neu', label: 'Berta Neu' }]));
    expect(await screen.findByRole('option', { name: 'Berta Neu' })).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(pick).toHaveBeenCalledWith(['neu']);
  });
});

describe('Knopf und Tabelle', () => {
  it('Knopf: Varianten, Symbol, busy sperrt ohne den Fokus zu verlieren, mit href ein Link', async () => {
    const click = vi.fn();
    const { rerender } = renderUi(<Button variant="primary" size="sm" icon="plus" onClick={click}>Person einladen</Button>);
    const b = screen.getByRole('button', { name: 'Person einladen' });
    expect(b).toHaveClass('iam-btn', 'iam-primary', 'iam-sm');
    expect(b).toHaveAttribute('type', 'button');
    expect(b.querySelector('svg')).not.toBeNull();
    await userEvent.click(b);
    expect(click).toHaveBeenCalledTimes(1);
    rerender(<Button busy onClick={click}>Speichern</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Speichern' })).toHaveAttribute('aria-disabled', 'true');
    rerender(<Button href="/auth/login" variant="danger-solid">Erneut anmelden</Button>);
    expect(screen.getByRole('link', { name: 'Erneut anmelden' })).toHaveClass('iam-btn', 'iam-danger', 'iam-solid');
    expect(screen.getByRole('link', { name: 'Erneut anmelden' })).not.toHaveAttribute('aria-disabled');
    // gesperrter Link: aria-disabled, Klick navigiert nicht
    const linkClick = vi.fn();
    rerender(<Button href="/auth/login" busy onClick={linkClick}>Weiter</Button>);
    const link = screen.getByRole('link', { name: 'Weiter' });
    expect(link).toHaveAttribute('aria-disabled', 'true');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(linkClick).not.toHaveBeenCalled();
    // ohne href: auch Mittelklick und «In neuem Tab öffnen» navigieren nicht; bleibt fokussierbar
    expect(link).not.toHaveAttribute('href');
    expect(link).toHaveAttribute('tabindex', '0');
    link.focus();
    expect(link).toHaveFocus();
    rerender(<Button href="/auth/login" onClick={linkClick}>Weiter</Button>);
    expect(screen.getByRole('link', { name: 'Weiter' })).toHaveAttribute('href', '/auth/login');
  });

  it('Tabelle: Rahmenklassen und Stapeln unter 760 px', () => {
    renderUi(<Table stack aria-label="Mitglieder"><tbody><tr><td>Anna</td></tr></tbody></Table>);
    expect(screen.getByRole('table', { name: 'Mitglieder' })).toHaveClass('iam-tbl', 'iam-stack-tbl');
  });
});

describe('Austausch der Grundkomponenten', () => {
  it('Rückfrage nutzt Dialog und Knopf der App; Symbole und Meldungen der App', async () => {
    const AppButton = ({ variant, children, icon, busy, size, ...rest }: ButtonProps) =>
      <button type="button" data-app-button={variant ?? 'default'} data-icon={icon} aria-disabled={busy || undefined} data-size={size} {...(rest as object)}>{children}</button>;
    const AppIcon = ({ name }: IconProps) => <i data-app-icon={name} />;
    const toast: ToastApi = { show: vi.fn(), error: vi.fn() };
    function Show() { const ui = useIamUi(); return <button type="button" onClick={() => ui.toast.show('Gespeichert')}>Melden</button>; }
    renderUi(<><Confirm title="Löschen?" confirm="Rolle löschen" danger onConfirm={() => {}} onClose={() => {}}><p>x</p></Confirm><Show /></>,
      { Button: AppButton, Icon: AppIcon, toast });
    const del = screen.getByRole('button', { name: 'Rolle löschen' });
    expect(del).toHaveAttribute('data-app-button', 'danger-solid');
    expect(del).toHaveAttribute('data-icon', 'trash');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Melden', hidden: true }));
    expect(toast.show).toHaveBeenCalledWith('Gespeichert');
    expect(document.querySelector('.iam-toasts')).toBeNull();
  });

  it('ohne eigene Meldungen zeigt das Paket sie unten mit Schliessen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    function Show() { const ui = useIamUi(); return <><button type="button" onClick={() => ui.toast.show('Gespeichert')}>Melden</button><button type="button" onClick={() => ui.toast.error(new ApiError(409, {}), 'Nicht gespeichert')}>Fehler</button></>; }
    renderUi(<Show />);
    fireEvent.click(screen.getByRole('button', { name: 'Melden' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fehler' }));
    expect(screen.getByText('Gespeichert')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Nicht gespeichert: Konflikt mit dem aktuellen Stand.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Meldung schliessen' })[0]!);
    expect(screen.queryByText('Gespeichert')).toBeNull();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('kennt jeden Symbolnamen, den die Bausteine nutzen', () => {
    expect(ICON_NAMES).toEqual(expect.arrayContaining(['check', 'x', 'warn', 'search', 'trash', 'shield', 'more', 'building', 'user', 'users', 'key', 'tag']));
  });
});
