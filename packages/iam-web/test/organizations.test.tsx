/**
 * Organisationen (Plattform-Administration): «Recht fehlt» ohne Plattform-Administration, Liste mit Status in Keycloak
 * und Plattform, Anlegen mit Prüfung beim Absenden, Detail mit bearbeiteter und eigener Organisation, Angaben ändern,
 * Sperren (eigene Organisation gesperrt mit Grund) und Entsperren. Aus vollholz/assets `web/src/features/admin.test.tsx`
 * (Organisationen), produktneutral (Notiz-App).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me, Member, Organization } from '../src/index.ts';
import { OrganizationPage, OrganizationScreen, OrganizationsScreen } from '../src/pages/index.ts';
import { CATALOG, json, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

const STATUS = { enabled: true, reason: null, organization: 'demo', platformAdmin: false, canManageMembers: true, rolesManageable: true, roles: CATALOG.roles };
const PLATFORM = { ...STATUS, platformAdmin: true };
const ORG: Organization = { id: 'kc-muster', alias: 'muster', name: 'Muster GmbH', description: null, enabled: true, domains: ['muster.example'], tenant: { id: 't-muster', status: 'active', createdAt: new Date().toISOString() } };
const DEMO_ORG: Organization = { ...ORG, id: 'kc-demo', alias: 'demo', name: 'Demo AG', domains: [] };
const CARLA: Member = { id: 'm-carla', principalId: 'p3', username: 'carla', name: 'Carla Check', email: 'carla@muster.example', status: 'active', roles: ['editor'], lastSeenAt: null, createdAt: null, loginPath: null };

function setup(ui: ReactElement, routes: Record<string, MockHandler>, o: { path?: string; me?: Partial<Me> } = {}) {
  window.history.replaceState(null, '', o.path ?? '/verwalten/organisationen');
  const api = mockIamApi(routes);
  vi.stubGlobal('fetch', api.fetch);
  return { ...api, ...render(<StaticIam me={o.me}>{ui}</StaticIam>) };
}
const detail = (org: Organization, extra: Record<string, MockHandler> = {}) => ({
  'GET /v1/admin/status': () => json(PLATFORM),
  [`GET /v1/platform/organizations/${org.alias}`]: () => json(org),
  [`GET /v1/platform/organizations/${org.alias}/members`]: () => json({ items: [CARLA] }),
  [`GET /v1/platform/organizations/${org.alias}/clients`]: () => json({ items: [] }),
  ...extra,
});

describe('Organisationen (Plattform-Administration)', () => {
  it('ohne Plattform-Administration dieselbe Seite «Recht fehlt» wie bei fehlenden Rechten, Technik nur im title', async () => {
    const { calls } = setup(<OrganizationsScreen />, { 'GET /v1/admin/status': () => json(STATUS) });
    expect(await screen.findByRole('heading', { name: 'Recht fehlt' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Organisationen' })).toBeInTheDocument();
    const p = screen.getByText(/^Dafür braucht es die Plattform-Administration\./);
    expect(p).toHaveAttribute('title', 'Realm-Rolle «platform-admin» in Keycloak');
    expect(screen.queryByText(/Realm-Rolle/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Organisation anlegen' })).toBeNull();
    expect(calls.some(c => new URL(c.url).pathname === '/v1/platform/organizations')).toBe(false);
  });

  it('Liste: Spalte «Plattform», Status «deaktiviert» (Keycloak) und «gesperrt» (Plattform), gestapelt mit Beschriftung; Zeile öffnet das Detail', async () => {
    setup(<OrganizationsScreen />, {
      'GET /v1/admin/status': () => json(PLATFORM),
      'GET /v1/platform/organizations': () => json({ items: [ORG, { ...DEMO_ORG, enabled: false, tenant: { ...ORG.tenant!, status: 'suspended' } }, { ...ORG, id: 'kc-neu', alias: 'neu', name: 'Neu AG', tenant: null }] }),
    });
    const table = await screen.findByRole('table', { name: 'Organisationen' });
    expect(within(table).getAllByRole('columnheader').map(c => c.textContent)).toEqual(['Organisation', 'Domänen', 'Keycloak', 'Plattform', 'Öffnen']);
    expect(document.body).not.toHaveTextContent(/Mandant/);
    expect(table).toHaveClass('iam-stack-tbl');
    const [, muster, demo, neu] = within(table).getAllByRole('row');
    expect(muster).toHaveTextContent('muster.example');
    expect(demo).toHaveTextContent('Keycloak:deaktiviert');
    expect(demo).toHaveTextContent('Plattform:gesperrt');
    expect(neu).toHaveTextContent('Plattform:noch nicht benutzt');
    expect(within(muster!).getByRole('link', { name: 'Muster GmbH' })).toHaveAttribute('href', '/verwalten/organisationen/muster');
    expect(await axeProblems()).toEqual([]);
    await userEvent.click(within(demo!).getByText('Keycloak:'));
    expect(window.location.pathname).toBe('/verwalten/organisationen/demo');
  });

  it('«Organisation anlegen» prüft beim Absenden (Fokus aufs Feld), schlägt den Alias vor und öffnet danach das Detail', async () => {
    const { calls } = setup(<OrganizationsScreen />, {
      'GET /v1/admin/status': () => json(PLATFORM),
      'GET /v1/platform/organizations': () => json({ items: [ORG] }),
      'POST /v1/platform/organizations': () => json({ ...ORG, id: 'kc-zuerich', alias: 'zuerich-ag', name: 'Zürich AG', domains: ['zuerich.example', 'zh.example'], tenant: null }, 201),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Organisation anlegen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Organisation anlegen' });
    const go = within(dlg).getByRole('button', { name: 'Anlegen' });
    expect(go).toBeEnabled();
    await userEvent.click(go);
    expect(within(dlg).getByRole('textbox', { name: 'Name' })).toHaveAttribute('aria-invalid', 'true');
    expect(within(dlg).getByRole('textbox', { name: 'Name' })).toHaveFocus();
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Name' }), 'Zürich AG');
    expect(within(dlg).getByRole('textbox', { name: 'Alias' })).toHaveValue('zurich-ag');
    await userEvent.clear(within(dlg).getByRole('textbox', { name: 'Alias' }));
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Alias' }), 'Zuerich AG');
    expect(within(dlg).getByRole('textbox', { name: 'Alias' })).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(within(dlg).getByRole('textbox', { name: 'Alias' }));
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Alias' }), 'zuerich-ag');
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Domänen' }), 'Zuerich.example; zh.example');
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(go);
    await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
    expect(await calls.find(c => c.method === 'POST')!.clone().json()).toEqual({ alias: 'zuerich-ag', name: 'Zürich AG', domains: ['zuerich.example', 'zh.example'] });
    expect(await screen.findByText('Organisation «Zürich AG» angelegt')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/verwalten/organisationen/zuerich-ag');
  });

  it('Detail sagt, welche Organisation bearbeitet wird und in welcher die Person angemeldet ist; Dialoge nennen die bearbeitete', async () => {
    setup(<OrganizationScreen />, detail(ORG), { path: '/verwalten/organisationen/muster' });
    expect((await screen.findByText(/Du bearbeitest/)).closest('[role=note]')).toHaveTextContent('Du bearbeitest «Muster GmbH» (angemeldet in «Demo AG»).');
    expect(screen.getByRole('navigation', { name: 'Pfad' })).toHaveTextContent('Organisationen');
    expect(screen.queryByText('deine Organisation')).toBeNull();
    expect(document.body).not.toHaveTextContent(/Mandant/);
    await userEvent.click(await screen.findByRole('button', { name: 'Person einladen' }));
    expect(await screen.findByRole('dialog', { name: 'Person zu «Muster GmbH» einladen' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zu Carla Check' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Person entfernen …' }));
    expect(await screen.findByRole('alertdialog', { name: 'Carla Check aus «Muster GmbH» entfernen?' })).toHaveTextContent('Zugang zu «Muster GmbH»');
    // Mitglieder und Maschinen-Clients dieser Organisation (Plattformansicht)
    expect(screen.getByRole('table', { name: 'Mitglieder von Muster GmbH mit Rollen' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Freigegebene Maschinen-Clients' })).toBeInTheDocument();
  });

  it('beide Namen aus Keycloak: die eigene Organisation mit Namen aus dem Token, nicht mit dem Alias', async () => {
    setup(<OrganizationScreen />, detail(ORG), { path: '/verwalten/organisationen/muster', me: { tenant: { id: 't1', alias: 'demo', name: '' }, organizationNames: { demo: 'Demo AG' } } });
    expect((await screen.findByText(/Du bearbeitest/)).closest('[role=note]')).toHaveTextContent('Du bearbeitest «Muster GmbH» (angemeldet in «Demo AG»).');
  });

  it('die eigene Organisation lässt sich nicht sperren – Knopf gesperrt mit Grund statt ausgeblendet', async () => {
    setup(<OrganizationScreen />, detail(DEMO_ORG), { path: '/verwalten/organisationen/demo' });
    const lock = await screen.findByRole('button', { name: 'Sperren' });
    expect(screen.queryByText(/Du bearbeitest/)).toBeNull();
    expect(screen.getByText('deine Organisation')).toBeInTheDocument();
    expect(lock).toHaveAttribute('aria-disabled', 'true');
    expect(lock).toHaveAccessibleDescription('Die Organisation, in der du angemeldet bist, kannst du nicht sperren.');
    await userEvent.click(lock);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('sperren mit Grund (Fokus auf «Abbrechen»), entsperren; noch nie benutzt: keine Maschinen-Clients', async () => {
    let org: Organization = ORG;
    const { calls } = setup(<OrganizationScreen />, detail(ORG, {
      'GET /v1/platform/organizations/muster': () => json(org),
      'POST /v1/platform/organizations/muster/suspend': () => { org = { ...org, enabled: false, tenant: { ...org.tenant!, status: 'suspended' } }; return json(org); },
      'POST /v1/platform/organizations/muster/resume': () => { org = ORG; return json(org); },
    }), { path: '/verwalten/organisationen/muster' });
    await userEvent.click(await screen.findByRole('button', { name: 'Sperren' }));
    const dlg = await screen.findByRole('alertdialog', { name: '«Muster GmbH» sperren?' });
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Grund (Protokoll)' }), 'Vertrag beendet');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Sperren' }));
    expect(await screen.findByText('«Muster GmbH» gesperrt')).toBeInTheDocument();
    expect(await calls.find(c => c.url.endsWith('/suspend'))!.clone().json()).toEqual({ reason: 'Vertrag beendet' });
    await userEvent.click(await screen.findByRole('button', { name: 'Entsperren' }));
    const back = await screen.findByRole('alertdialog', { name: '«Muster GmbH» entsperren?' });
    await userEvent.click(within(back).getByRole('button', { name: 'Entsperren' }));
    expect(await screen.findByText('«Muster GmbH» entsperrt')).toBeInTheDocument();
  });

  it('Angaben ändern: Speichern erst bei Änderung, Domänen getrennt, leere Beschreibung als null', async () => {
    const { calls } = setup(<OrganizationPage alias="muster" />, detail({ ...ORG, description: 'Alt' }, {
      'PATCH /v1/platform/organizations/muster': () => json({ ...ORG, name: 'Muster AG' }),
    }), { path: '/irgendwo' });
    const form = (await screen.findByRole('heading', { name: 'Angaben' })).closest('section')!;
    const save = within(form).getByRole('button', { name: 'Speichern' });
    expect(save).toBeDisabled();
    await userEvent.clear(within(form).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'Muster AG');
    await userEvent.clear(within(form).getByRole('textbox', { name: 'Domänen' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Domänen' }), 'muster.example, MUSTER.ch');
    await userEvent.clear(within(form).getByRole('textbox', { name: 'Beschreibung' }));
    await userEvent.click(save);
    expect(await screen.findByText('Organisation «Muster AG» gespeichert')).toBeInTheDocument();
    expect(await calls.find(c => c.method === 'PATCH')!.clone().json()).toEqual({ name: 'Muster AG', domains: ['muster.example', 'muster.ch'], description: null });
  });
});
