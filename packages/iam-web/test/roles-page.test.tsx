/**
 * Verwalten › Zugang › Rollen: vordefinierte Rollen mit Rechte-Übersicht, leere Liste eigener Rollen, Erstellen mit
 * Vorlage (Rechte nur für Organisations-Admin gesperrt), Prüfung beim Absenden, Bearbeiten und Löschen mit If-Match,
 * Symbole aus `roleIcons`. Dazu Routen und Navigation «Zugang». Aus vollholz/assets
 * `web/src/features/admin/roles-page.test.tsx`, produktneutral (Notiz-App).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IamNav, iamRoutes, makeIamRoutes, type IamConfig, type Me, type Role } from '../src/index.ts';
import { RolesScreen } from '../src/pages/index.ts';
import { CATALOG, json, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

const ADMIN_ONLY = new Set(CATALOG.permissions.filter(p => p.adminOnly).map(p => p.key));
const BUILTIN: Role[] = CATALOG.roles.map((r, i) => ({ ...r, custom: false, id: null, version: null, memberCount: i === 0 ? 1 : 0, createdAt: null, updatedAt: null }));
const PFLEGE: Role = {
  key: 'c-notizpflege', label: 'Notizpflege', description: 'Pflegt Notizen', permissions: ['tenant:read', 'note:read', 'note:write'], custom: true, adminOnly: false,
  id: '00000000-0000-4000-8000-000000000001', version: 3, memberCount: 2, createdAt: '2026-10-22T08:00:00Z', updatedAt: '2026-10-22T08:00:00Z',
};
const list = (custom: Role[] = []) => ({ items: [...BUILTIN, ...custom], maxCustom: 50, customPermissions: CATALOG.permissions.map(p => p.key).filter(k => !ADMIN_ONLY.has(k)) });

function setup(ui: ReactElement, routes: Record<string, MockHandler> = {}, o: { me?: Partial<Me>; config?: Partial<IamConfig>; path?: string } = {}) {
  window.history.replaceState(null, '', o.path ?? '/verwalten/rollen');
  const api = mockIamApi(routes);
  vi.stubGlobal('fetch', api.fetch);
  return { ...api, ...render(<StaticIam me={o.me} config={o.config}>{ui}</StaticIam>) };
}
const page = <><IamNav /><main><RolesScreen /></main></>;

describe('Rollen', () => {
  it('vordefinierte Rollen mit Rechten zum Aufklappen; ohne eigene Rollen ein Hinweis mit «Rolle erstellen»', async () => {
    setup(page, { 'GET /v1/roles': () => json(list()) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Rollen' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rollen' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Mitglieder' })).not.toHaveAttribute('aria-current');
    const builtin = await screen.findByRole('region', { name: 'Vordefinierte Rollen' });
    expect(within(builtin).getAllByRole('heading', { level: 3 }).map(h => h.firstChild!.textContent)).toEqual(CATALOG.roles.map(r => r.label));
    const admin = within(builtin).getByRole('heading', { name: /^Organisations-Admin/ }).closest('li')!;
    expect(admin).toHaveTextContent('nur Plattform-Administration vergibt sie');
    expect(admin).toHaveTextContent('Alle Rechte · 1 Person');
    const viewer = within(builtin).getByRole('heading', { name: 'Leser:in' }).closest('li')!;
    expect(viewer).toHaveTextContent('2 Rechte · 0 Personen');
    expect(viewer).not.toHaveTextContent('viewer');
    const toggle = within(viewer).getByRole('button', { name: 'Rechte von Leser:in' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(viewer).getByText(`Darf 2 von ${CATALOG.permissions.length}`)).toBeInTheDocument();
    const own = screen.getByRole('region', { name: 'Eigene Rollen' });
    expect(within(own).getByText('Noch keine eigenen Rollen')).toBeInTheDocument();
    expect(within(own).getByRole('button', { name: 'Rolle erstellen' })).toBeEnabled();
    expect(screen.getByText('Rollen vergleichen').closest('details')).not.toHaveAttribute('open');
    expect(await axeProblems()).toEqual([]);
  });

  it('erstellen mit Vorlage: Rechte übernommen, Rechte nur für Organisations-Admin gesperrt, POST in Katalogreihenfolge', async () => {
    const { calls } = setup(page, { 'GET /v1/roles': () => json(list()), 'POST /v1/roles': () => json(PFLEGE, 201) });
    const folder = (await screen.findByRole('heading', { name: 'Ordner-Admin' })).closest('li')!;
    await userEvent.click(within(folder).getByRole('button', { name: 'Mehr zu Ordner-Admin' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Als Vorlage für eigene Rolle …' }));
    const dlg = await screen.findByRole('dialog', { name: 'Rolle in «Demo AG» erstellen' });
    expect(within(dlg).getByRole('textbox', { name: 'Name' })).toHaveValue('Ordner-Admin (Kopie)');
    expect(within(dlg).getByRole('checkbox', { name: 'Ordner verwalten' })).toBeChecked();
    expect(within(dlg).getByRole('checkbox', { name: 'Mitglieder und Rollen verwalten' })).toBeDisabled();
    expect(within(dlg).getByText('Mitglieder und Rollen verwalten', { selector: '.iam-rp-l' }).closest('li')).toHaveTextContent('nur Organisations-Admin');
    expect(within(dlg).getByText(/^6 gewählt$/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Notizen löschen' }));
    await userEvent.clear(within(dlg).getByRole('textbox', { name: 'Name' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Rolle erstellen' }));
    expect(within(dlg).getByText('Namen angeben')).toBeInTheDocument();
    expect(within(dlg).getByRole('textbox', { name: 'Name' })).toHaveFocus();
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    // Reihenfolge des Anklickens zählt nicht: zuerst ein Recht weiter unten
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Protokoll lesen' }));
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Name' }), 'Notizpflege');
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Rolle erstellen' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
    const body = await calls.find(c => c.method === 'POST')!.json() as { label: string; permissions: string[] };
    expect(body.label).toBe('Notizpflege');
    expect(body.permissions).toEqual(['tenant:read', 'acl:read', 'audit:read', 'note:read', 'note:write', 'folder:admin']);
    expect(await screen.findByText('Rolle «Notizpflege» in «Demo AG» erstellt')).toBeInTheDocument();
  });

  it('ohne Recht: Hinweis «Mindestens ein Recht wählen», Fokus aufs erste Recht; Vorlage mit Rechten nur für org-admin', async () => {
    setup(page, { 'GET /v1/roles': () => json(list()) });
    const admin = (await screen.findByRole('heading', { name: /^Organisations-Admin/ })).closest('li')!;
    await userEvent.click(within(admin).getByRole('button', { name: 'Mehr zu Organisations-Admin' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Als Vorlage für eigene Rolle …' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/^Nicht übernommen, weil nur «Organisations-Admin» sie hat: /)).toHaveTextContent('Organisation verwalten, Mitglieder und Rollen verwalten, Zugriff verwalten');
    for (const c of within(dlg).getAllByRole('checkbox')) if ((c as HTMLInputElement).checked) await userEvent.click(c);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Rolle erstellen' }));
    expect(within(dlg).getByText('Mindestens ein Recht wählen')).toBeInTheDocument();
    expect(within(dlg).getByRole('checkbox', { name: 'Organisation lesen' })).toHaveFocus();
  });

  it('eigene Rolle: technischer Name, bearbeiten und löschen mit If-Match', async () => {
    const { calls } = setup(page, {
      'GET /v1/roles': () => json(list([PFLEGE])),
      'PATCH /v1/roles/c-notizpflege': () => json({ ...PFLEGE, version: 4 }), 'DELETE /v1/roles/c-notizpflege': () => new Response(null, { status: 204 }),
    });
    const own = await screen.findByRole('region', { name: 'Eigene Rollen' });
    const row = (await within(own).findByRole('heading', { name: 'Notizpflege' })).closest('li')!;
    expect(row).toHaveTextContent('3 Rechte · 2 Personen · c-notizpflege');
    expect(within(own).getByText('1 von 50')).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: 'Mehr zu Notizpflege' }));
    expect(screen.getAllByRole('menuitem').map(i => i.getAttribute('aria-label'))).toEqual(['Bearbeiten …', 'Kopieren …', 'Löschen …']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten …' }));
    const dlg = await screen.findByRole('dialog', { name: 'Rolle «Notizpflege» bearbeiten' });
    expect(within(dlg).getByText('2 Personen haben diese Rolle; geänderte Rechte gelten für sie sofort.')).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH')).toBe(true));
    expect(calls.find(c => c.method === 'PATCH')!.headers.get('if-match')).toBe('W/"3"');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Rolle «Notizpflege» gespeichert')).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: 'Mehr zu Notizpflege' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Löschen …' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Rolle «Notizpflege» löschen?' });
    expect(confirm).toHaveTextContent('2 Personen in «Demo AG» verlieren die Rolle sofort. Zugriffsregeln für die Rolle werden mitgelöscht.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Rolle löschen' }));
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE')).toBe(true));
    expect(calls.find(c => c.method === 'DELETE')!.headers.get('if-match')).toBe('W/"3"');
    expect(await screen.findByText('Rolle «Notizpflege» in «Demo AG» gelöscht')).toBeInTheDocument();
  });

  it('höchstens `maxCustom` eigene Rollen: «Rolle erstellen» gesperrt mit Grund', async () => {
    setup(page, { 'GET /v1/roles': () => json({ ...list([PFLEGE]), maxCustom: 1 }) });
    const create = await screen.findByRole('button', { name: 'Rolle erstellen' });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', 'Höchstens 1 eigene Rollen');
  });

  it('Symbol je Rolle aus `roleIcons`, sonst Schild für org-admin und Etikett für die übrigen', async () => {
    setup(page, { 'GET /v1/roles': () => json(list()) }, { config: { roleIcons: { editor: 'edit' } } });
    const icon = async (name: RegExp) => (await screen.findByRole('heading', { name })).closest('li')!.querySelector('.iam-type-ico svg')!.innerHTML;
    const { ICONS } = await import('../src/ui/icons.ts');
    const svg = (s: string) => { const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); e.innerHTML = s; return e.innerHTML; };
    expect(await icon(/^Bearbeiter:in$/)).toBe(svg(ICONS.edit));
    expect(await icon(/^Organisations-Admin/)).toBe(svg(ICONS.shield));
    expect(await icon(/^Leser:in$/)).toBe(svg(ICONS.tag));
  });

  it('ohne Recht: «Recht fehlt», keine Navigation «Zugang», kein Abruf der Verwaltung', async () => {
    const { calls } = setup(page, {}, { me: { roles: ['viewer'], permissions: ['tenant:read', 'note:read'] } });
    expect(await screen.findByText('Recht fehlt')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Zugang' })).toBeNull();
    expect(calls.some(c => c.method !== 'GET')).toBe(false);
  });
});

describe('Review #18: Version, Limit, Rechte', () => {
  it('412 beim Speichern: Liste mit aktueller Version neu laden, der nächste Versuch nimmt sie', async () => {
    let version = 3, patches = 0;
    const { calls } = setup(page, {
      'GET /v1/roles': () => json(list([{ ...PFLEGE, version }])),
      'PATCH /v1/roles/c-notizpflege': () => (++patches === 1
        ? (version = 4, json({ title: 'Inzwischen geändert', status: 412, currentVersion: 4 }, 412))
        : json({ ...PFLEGE, version: 5 })),
    });
    const row = (await screen.findByRole('heading', { name: 'Notizpflege' })).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Mehr zu Notizpflege' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten …' }));
    const dlg = await screen.findByRole('dialog', { name: 'Rolle «Notizpflege» bearbeiten' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Inzwischen geändert');
    await waitFor(() => expect(calls.filter(c => c.method === 'GET' && c.url.endsWith('/v1/roles')).length).toBeGreaterThan(1));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter(c => c.method === 'PATCH').map(c => c.headers.get('if-match'))).toEqual(['W/"3"', 'W/"4"']);
  });

  it('volles Limit: auch «Kopieren …» und «Als Vorlage …» gesperrt mit Grund', async () => {
    setup(page, { 'GET /v1/roles': () => json({ ...list([PFLEGE]), maxCustom: 1 }) });
    const row = (await screen.findByRole('heading', { name: 'Notizpflege' })).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Mehr zu Notizpflege' }));
    const copy = screen.getByRole('menuitem', { name: 'Kopieren …' });
    expect(copy).toHaveAttribute('aria-disabled', 'true');
    expect(copy).toHaveAccessibleDescription('Höchstens 1 eigene Rollen');
    await userEvent.click(copy);
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.keyboard('{Escape}');
    const viewer = screen.getByRole('heading', { name: 'Leser:in' }).closest('li')!;
    await userEvent.click(within(viewer).getByRole('button', { name: 'Mehr zu Leser:in' }));
    expect(screen.getByRole('menuitem', { name: 'Als Vorlage für eigene Rolle …' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('ohne tenant:read auf Ebene der Organisation: «Recht fehlt», kein Abruf von /v1/roles', async () => {
    const { calls } = setup(page, {}, { me: { roles: [], permissions: ['members:admin'] } });
    expect(await screen.findByText(/«Organisation lesen»/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recht fehlt' })).toBeInTheDocument();
    expect(calls.some(c => c.url.endsWith('/v1/roles'))).toBe(false);
  });

  it('Bearbeiten: Rechte, die eine eigene Rolle nicht (mehr) enthalten darf, als Hinweis', async () => {
    setup(page, { 'GET /v1/roles': () => json(list([{ ...PFLEGE, permissions: [...PFLEGE.permissions, 'acl:admin'] }])) });
    const row = (await screen.findByRole('heading', { name: 'Notizpflege' })).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Mehr zu Notizpflege' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Bearbeiten …' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/^Nicht übernommen, weil nur «Organisations-Admin» sie hat: Zugriff verwalten\.$/)).toBeInTheDocument();
  });
});

describe('Routen und Navigation', () => {
  it('iamRoutes: Pfade wie Assets, Bedarf, Titel in der Sprache der Texte; load() liefert die Seite mit Guard', async () => {
    expect(iamRoutes.map(r => [r.id, r.path, r.need, r.title, r.icon, r.nav])).toEqual([
      ['members', '/verwalten/mitglieder', { perm: 'members:admin' }, 'Mitglieder', 'users', true],
      ['roles', '/verwalten/rollen', { perm: 'members:admin' }, 'Rollen', 'tag', true],
      ['clients', '/verwalten/maschinen-clients', { perm: 'members:admin' }, 'Maschinen-Clients', 'key', true],
      ['access', '/verwalten/zugriff', { perm: 'acl:read' }, 'Zugriff', 'shield', true],
      ['organizations', '/verwalten/organisationen', { platformAdmin: true }, 'Organisationen', 'building', true],
      ['organization', '/verwalten/organisationen/:alias', { platformAdmin: true }, 'Organisation', 'building', false],
    ]);
    expect(makeIamRoutes({ roles: '/admin/roles' }).find(r => r.id === 'roles')!.path).toBe('/admin/roles');
    // ohne Plattform-Administration in der App (features.platform: false) keine Organisationen
    expect(makeIamRoutes({}, { platform: false }).map(r => r.id)).toEqual(['members', 'roles', 'clients', 'access']);
    // ohne Zugriffsregeln (features.acl: false) keine Seite «Zugriff»
    expect(makeIamRoutes({}, { platform: false, acl: false }).map(r => r.id)).toEqual(['members', 'roles', 'clients']);
    const { default: Page } = await iamRoutes[1]!.load();
    setup(<Page />, { 'GET /v1/roles': () => json(list()) });
    expect(await screen.findByRole('region', { name: 'Vordefinierte Rollen' })).toBeInTheDocument();
  });

  it('IamNav: Gruppe «Zugang» mit Links über den Router-Adapter, aktiv auch auf Unterseiten', async () => {
    setup(<IamNav />, {}, { path: '/verwalten/mitglieder/irgendwas' });
    const nav = screen.getByRole('navigation', { name: 'Zugang' });
    expect(within(nav).getAllByRole('link').map(a => [a.textContent, a.getAttribute('href')])).toEqual([['Mitglieder', '/verwalten/mitglieder'], ['Rollen', '/verwalten/rollen'], ['Maschinen-Clients', '/verwalten/maschinen-clients'], ['Zugriff', '/verwalten/zugriff']]);
    expect(within(nav).getByRole('link', { name: 'Mitglieder' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(within(nav).getByRole('link', { name: 'Rollen' }));
    expect(window.location.pathname).toBe('/verwalten/rollen');
    expect(within(nav).getByRole('link', { name: 'Rollen' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Mitglieder' })).not.toHaveAttribute('aria-current');
  });

  it('IamNav: «Organisationen» nur für die Plattform-Administration, aktiv auch auf der Detailseite; aus mit features.platform', async () => {
    const status = (platformAdmin: boolean) => () => json({ enabled: true, reason: null, organization: 'demo', platformAdmin, canManageMembers: true, rolesManageable: true, roles: [] });
    const { unmount } = setup(<IamNav />, { 'GET /v1/admin/status': status(true) }, { path: '/verwalten/organisationen/muster' });
    const link = await screen.findByRole('link', { name: 'Organisationen' });
    expect(link).toHaveAttribute('aria-current', 'page');
    unmount();
    const off = setup(<IamNav />, { 'GET /v1/admin/status': status(true) }, { config: { features: { platform: false } } });
    expect(screen.getByRole('link', { name: 'Maschinen-Clients' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Organisationen' })).toBeNull();
    expect(off.calls.some(c => c.url.endsWith('/v1/admin/status'))).toBe(false);
    off.unmount();
    setup(<IamNav />, { 'GET /v1/admin/status': status(false) });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Maschinen-Clients' })).toBeInTheDocument());
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByRole('link', { name: 'Organisationen' })).toBeNull();
  });
});
