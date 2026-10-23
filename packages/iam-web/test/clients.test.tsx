/**
 * Maschinen-Clients: Freigeben (Prüfung der Client-ID) und Entziehen, Rollen und Scopes aus dem letzten Token,
 * Rechte-Übersicht (Rolle ∧ Scope), «Rechte prüfen». Aus vollholz/assets `web/src/features/admin/clients.test.tsx` und
 * dem Teil «Maschinen-Clients» in `features/admin.test.tsx`, produktneutral (Notiz-App).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientGrant, IamConfig, Me } from '../src/index.ts';
import { checkRightsHref, ClientList, ClientsScreen } from '../src/pages/index.ts';
import { json, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

const SEEN = new Date(Date.now() - 2 * 3600_000).toISOString();
const USED: ClientGrant = { clientId: 'notiz-import', description: 'Nächtlicher Import', createdAt: SEEN, createdBy: 'Anna Admin', lastUsedAt: SEEN, lastRoles: ['editor'], lastScopes: ['notes:read'] };
const NEVER: ClientGrant = { clientId: 'neu-client', description: '', createdAt: SEEN, createdBy: null, lastUsedAt: null, lastRoles: null, lastScopes: null };

function setup(ui: ReactElement, routes: Record<string, MockHandler> = {}, o: { me?: Partial<Me>; config?: Partial<IamConfig> } = {}) {
  window.history.replaceState(null, '', '/verwalten/maschinen-clients');
  const api = mockIamApi(routes);
  vi.stubGlobal('fetch', api.fetch);
  return { ...api, ...render(<StaticIam me={o.me} config={o.config}>{ui}</StaticIam>) };
}
const table = () => screen.findByRole('table', { name: 'Freigegebene Maschinen-Clients von Demo AG' });

describe('Maschinen-Clients', () => {
  it('listet Freigaben, gibt einen Maschinen-Client frei (Prüfung der ID) und entzieht über das Menü mit Rückfrage', async () => {
    let items: ClientGrant[] = [{ ...NEVER, clientId: 'demo-m2m', description: 'Notiz-Import', createdBy: 'Anna Admin' }];
    const { calls } = setup(<ClientsScreen />, {
      'GET /v1/admin/clients': () => json({ items }),
      'PUT /v1/admin/clients/notiz-2': () => { items = [...items, { ...NEVER, clientId: 'notiz-2' }]; return json(items[1], 201); },
      'DELETE /v1/admin/clients/demo-m2m': () => { items = items.slice(1); return new Response(null, { status: 204 }); },
    });
    expect(screen.getByText(/Maschinen-Clients aus Keycloak, die «Demo AG» über die API benutzen dürfen/)).not.toHaveTextContent('Service Account');
    const tbl = await table();
    expect(within(tbl).getAllByRole('columnheader').map(c => c.textContent)).toEqual(['Client-ID', 'Beschreibung', 'Rollen und Scopes', 'Freigegeben', 'Aktionen']);
    expect(within(tbl).getAllByRole('row')[1]).toHaveTextContent(/demo-m2m.*Notiz-Import.*noch nie benutzt/);
    // Hauptaktion im Seitenkopf
    const head = screen.getByRole('heading', { level: 1, name: 'Maschinen-Clients' }).closest('.iam-mh') as HTMLElement;
    await userEvent.click(within(head).getByRole('button', { name: 'Maschinen-Client freigeben' }));
    const dlg = await screen.findByRole('dialog', { name: 'Maschinen-Client für «Demo AG» freigeben' });
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Client-ID' }), 'mit leerzeichen');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    expect(within(dlg).getByRole('textbox', { name: 'Client-ID' })).toHaveAttribute('aria-invalid', 'true');
    expect(within(dlg).getByRole('textbox', { name: 'Client-ID' })).toHaveFocus();
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.clear(within(dlg).getByRole('textbox', { name: 'Client-ID' }));
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Client-ID' }), 'notiz-2');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    expect(await screen.findByText('«notiz-2» für «Demo AG» freigegeben')).toBeInTheDocument();
    expect(await (await calls.find(c => c.method === 'PUT'))!.clone().json()).toEqual({ description: '' });
    // Zeilenaktion als Menü «Mehr zu <Client-ID>»
    await userEvent.click(await screen.findByRole('button', { name: 'Mehr zu demo-m2m' }));
    await userEvent.click(within(await screen.findByRole('menu', { name: 'Aktionen für demo-m2m' })).getByRole('menuitem', { name: 'Freigabe entziehen …' }));
    const c = await screen.findByRole('alertdialog', { name: 'Freigabe für «demo-m2m» in «Demo AG» entziehen?' });
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    // Entziehen löscht nichts: kein Papierkorb
    expect(within(c).getByRole('button', { name: 'Entziehen' }).querySelector('svg')).toBeNull();
    await userEvent.click(within(c).getByRole('button', { name: 'Entziehen' }));
    expect(await screen.findByText('Freigabe für «demo-m2m» in «Demo AG» entzogen')).toBeInTheDocument();
  });

  it('ohne Recht: «Recht fehlt», kein Abruf', async () => {
    const { calls } = setup(<ClientsScreen />, {}, { me: { roles: ['viewer'], permissions: ['tenant:read', 'note:read'] } });
    expect(await screen.findByText('Recht fehlt')).toBeInTheDocument();
    expect(calls.some(c => c.url.includes('/v1/admin/clients'))).toBe(false);
  });

  it('zeigt Rollen (Labels) und Scopes (Texte) mit «zuletzt gesehen», sonst «noch nie benutzt»', async () => {
    setup(<ClientsScreen />, { 'GET /v1/admin/clients': () => json({ items: [USED, NEVER] }) });
    const [, used, never] = within(await table()).getAllByRole('row');
    const roles = await within(used!).findByRole('list', { name: 'Rollen von notiz-import' });
    expect(await within(roles).findByText('Bearbeiter:in')).toHaveAttribute('title', 'Rolle editor');
    expect(within(used!).getByText('Organisation und Notizen lesen')).toHaveAttribute('title', 'Scope notes:read');
    expect(used).toHaveTextContent('zuletzt gesehen vor 2 Stunden');
    expect(used).not.toHaveTextContent('notes:read');
    expect(never).toHaveTextContent('noch nie benutzt');
    expect(within(never!).queryByRole('button', { name: /^Darf/ })).toBeNull();
  });

  it('benutzt, bevor der Server Rollen und Scopes festhielt: Zeitpunkt bleibt, Rollen und Scopes folgen', async () => {
    setup(<ClientsScreen />, { 'GET /v1/admin/clients': () => json({ items: [{ ...NEVER, clientId: 'alt-client', lastUsedAt: SEEN }] }) });
    const [, old] = within(await table()).getAllByRole('row');
    expect(old).toHaveTextContent('zuletzt gesehen vor 2 Stunden');
    expect(old).toHaveTextContent('Rollen und Scopes erscheinen nach dem nächsten Zugriff.');
    expect(old).not.toHaveTextContent('noch nie benutzt');
  });

  it('«Darf n von m» klappt die Rechte-Übersicht aus Sicht Rolle ∧ Scope auf', async () => {
    setup(<ClientsScreen />, { 'GET /v1/admin/clients': () => json({ items: [USED, NEVER] }) });
    const btn = await screen.findByRole('button', { name: /^Darf \d+ von \d+ – Rechte anzeigen, notiz-import$/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const detail = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(detail).toHaveTextContent(/Darf 2 von 10 – Bearbeiter:in, nur mit Scope \(Freigabe im Token\)/);
    // Bearbeiter:in darf Notizen ändern, das Token hat den Scope dafür aber nicht
    expect(within(detail).getByText('Notizen ändern').closest('li')).toHaveTextContent('fehlt (Scope)');
    expect(within(detail).getByText('Notizen lesen').closest('li')).toHaveTextContent('erlaubt');
    expect(detail).toHaveTextContent('Rollen und Scopes wie im letzten Token (vor 2 Stunden).');
    expect(btn).toHaveAccessibleName(/Rechte ausblenden, notiz-import$/);
    expect(await axeProblems()).toEqual([]);
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(`${btn.getAttribute('aria-controls')}`)).toBeNull();
  });

  it('«Rechte prüfen» verlinkt auf Zugriff › Rechte prüfen mit diesem Client (Pfad aus `paths`)', async () => {
    setup(<ClientsScreen />, { 'GET /v1/admin/clients': () => json({ items: [USED, NEVER] }) });
    const link = await screen.findByRole('link', { name: 'Rechte prüfen: notiz-import' });
    expect(link).toHaveAttribute('href', '/verwalten/zugriff?ansicht=pruefen&client=notiz-import');
    expect(screen.getByRole('link', { name: 'Rechte prüfen: neu-client' })).toBeInTheDocument();
    expect(checkRightsHref('/zugriff', 'a b@c')).toBe('/zugriff?ansicht=pruefen&client=a%20b%40c');
    await userEvent.click(link);
    expect(window.location.pathname).toBe('/verwalten/zugriff');
    expect(window.location.search).toBe('?ansicht=pruefen&client=notiz-import');
  });

  it('kein «Rechte prüfen» ohne Zugriffsregeln (features.acl: false), ohne acl:read oder für eine fremde Organisation', async () => {
    const { unmount } = setup(<ClientsScreen />, { 'GET /v1/admin/clients': () => json({ items: [USED] }) }, { config: { features: { acl: false } } });
    await within(await table()).findByRole('list', { name: 'Rollen von notiz-import' });
    expect(screen.queryByRole('link', { name: /Rechte prüfen/ })).toBeNull();
    unmount();
    const r2 = setup(<ClientsScreen />, { 'GET /v1/admin/clients': () => json({ items: [USED] }) }, { me: { permissions: ['tenant:read', 'members:admin'] } });
    await within(await table()).findByRole('list', { name: 'Rollen von notiz-import' });
    expect(screen.queryByRole('link', { name: /Rechte prüfen/ })).toBeNull();
    r2.unmount();
    setup(<ClientList alias="muster" orgLabel="Muster GmbH" />, { 'GET /v1/platform/organizations/muster/clients': () => json({ items: [USED] }) });
    expect(await screen.findByRole('list', { name: 'Rollen von notiz-import' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Rechte prüfen/ })).toBeNull();
    // Plattformansicht: Abschnittskopf mit eigener Aktion
    expect(screen.getByRole('button', { name: 'Maschinen-Client freigeben' })).toBeInTheDocument();
  });
});
