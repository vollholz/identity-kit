/** Router-Adapter ohne Router der App: History-API, Link ohne Neuladen, Suchtext unverarbeitet. */
import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { historyRouter } from '../src/index.ts';

afterEach(() => window.history.replaceState(null, '', '/'));

function Probe() {
  const search = historyRouter.useSearch(), path = historyRouter.usePathname();
  return <><p>{`pfad:${path} suche:${search}`}</p><historyRouter.Link to="/verwalten/zugriff?ansicht=pruefen&client=123">Rechte prüfen</historyRouter.Link></>;
}

describe('History-Router', () => {
  it('Link navigiert ohne Neuladen; Suchtext bleibt Text (keine Zahl)', async () => {
    render(<Probe />);
    expect(screen.getByText('pfad:/ suche:')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Rechte prüfen' });
    expect(link).toHaveAttribute('href', '/verwalten/zugriff?ansicht=pruefen&client=123');
    await userEvent.click(link);
    expect(screen.getByText('pfad:/verwalten/zugriff suche:?ansicht=pruefen&client=123')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('client')).toBe('123');
  });

  it('navigate mit replace und Zurück (popstate)', () => {
    render(<Probe />);
    act(() => historyRouter.navigate('/a?x=1'));
    act(() => historyRouter.navigate('/b?x=2', { replace: true }));
    expect(screen.getByText('pfad:/b suche:?x=2')).toBeInTheDocument();
    act(() => { window.history.replaceState(null, '', '/c'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(screen.getByText('pfad:/c suche:')).toBeInTheDocument();
  });
});
