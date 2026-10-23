/**
 * Öffentliche Freigabe: Lässt sich die nachgeladene Seite nicht laden bzw. darstellen, zeigt `IamProvider` einen Hinweis
 * statt einer leeren Seite; das Token ist da schon aus der Adresse.
 */
import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IamProvider } from '../src/index.ts';
import { mockIamApi } from '../src/testing/index.tsx';

vi.mock('../src/pages/index.ts', () => ({
  EntraHandoverPage: () => { throw new Error('Chunk nicht geladen'); },
  EntraHandoverReturn: () => null,
}));

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

it('Seite scheitert: Hinweis «Link erneut öffnen», Fragment weg, kein /auth/me', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  window.history.replaceState(null, '', '/verwalten/anmeldung/freigabe#demo.h0ver_Tok3n-abcdefghijklmnopqrstuvwxyz01234');
  const api = mockIamApi({});
  vi.stubGlobal('fetch', api.fetch);
  render(<IamProvider product="Notizen" queryClient={new QueryClient()} features={{ entra: true }}><p>App</p></IamProvider>);
  expect(await screen.findByText('Die Seite liess sich nicht laden. Öffnen Sie den Link erneut aus der Nachricht.')).toBeInTheDocument();
  expect(window.location.hash).toBe('');
  expect(api.calls).toHaveLength(0);
});
