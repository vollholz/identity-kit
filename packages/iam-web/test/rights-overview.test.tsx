/**
 * Rechte-Übersicht: Status je Recht, «Warum?», Umschalter und Suche, Organisations-Admin, Änderung gegenüber bisher.
 * Beispiel: Notiz-App.
 */
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowed, makeAuthz, RightsOverview, rightsModel, RoleCompare, roleSummary, type AuthzCatalog } from '../src/index.ts';
import { CATALOG, mockIamApi, StaticIam } from '../src/testing/index.tsx';

beforeEach(() => vi.stubGlobal('fetch', mockIamApi().fetch));
afterEach(() => vi.unstubAllGlobals());

const renderIam = (ui: ReactElement) => render(<StaticIam>{ui}</StaticIam>);
const total = CATALOG.permissions.length;
const union = (keys: string[]) => new Set(CATALOG.roles.filter(r => keys.includes(r.key)).flatMap(r => r.permissions));
const row = (name: string) => screen.getByText(name, { selector: '.iam-rights-l' }).closest('li')!;

describe('rightsModel', () => {
  const authz = makeAuthz(CATALOG);

  it('Rechte aus Rollen; mit Scopes zählt nur Rolle ∧ Scope', () => {
    const plain = rightsModel(authz, { roles: ['editor'] });
    expect(plain.filter(r => r.status === 'role').map(r => r.perm.key).sort()).toEqual([...union(['editor'])].sort());
    const scoped = rightsModel(authz, { roles: ['editor'], scopes: ['notes:read'] });
    const st = (k: string) => scoped.find(r => r.perm.key === k)!.status;
    expect(st('note:read')).toBe('role');
    expect(st('note:write')).toBe('scope');
    expect(st('members:admin')).toBe('missing');
    expect(rightsModel(authz, { roles: ['editor'], scopes: [] }).some(r => isAllowed(r.status))).toBe(false);
    expect(rightsModel(makeAuthz(undefined), { roles: ['editor'] })).toEqual([]);
  });

  it('Rechte direkt übergeben haben Vorrang; Organisations-Admin hat alle', () => {
    expect(rightsModel(authz, { roles: ['viewer'], permissions: ['note:read'] }).filter(r => isAllowed(r.status)).map(r => r.perm.key)).toEqual(['note:read']);
    expect(rightsModel(authz, { roles: ['org-admin'], permissions: ['note:read'] }).every(r => r.status === 'role')).toBe(true);
  });

  it('somewhere: was nur an einzelnen Orten gilt, ist «place»; mit Scope ohne Deckung «scope»', () => {
    const rows = rightsModel(authz, { roles: ['viewer'], permissions: ['tenant:read', 'note:read'], somewhere: ['tenant:read', 'note:read', 'note:write', 'access:admin'] });
    const st = (k: string) => rows.find(r => r.perm.key === k)!.status;
    expect([st('note:read'), st('note:write'), st('access:admin'), st('note:delete')]).toEqual(['role', 'place', 'place', 'missing']);
    const scoped = rightsModel(authz, { roles: ['viewer'], permissions: ['note:read'], somewhere: ['note:read', 'note:write'], scopes: ['notes:read'] });
    expect(scoped.find(r => r.perm.key === 'note:write')!.status).toBe('scope');
  });

  it('Kurzbeschreibung einer Rolle', () => {
    expect(roleSummary(CATALOG.roles.find(r => r.key === 'folder-admin')!.description)).toBe('Organisation lesen');
    expect(roleSummary(CATALOG.roles.find(r => r.key === 'org-admin')!.description)).toBe('Alle Rechte');
    expect(roleSummary('Liest alles.')).toBe('Liest alles');
  });
});

describe('RightsOverview', () => {
  it('Kopfzeile «Darf n von m» mit Rollen, Gruppen mit Zählung (statisch), Status mit Symbol und Text, keine Schlüssel', async () => {
    const { container } = renderIam(<RightsOverview roles={['editor', 'auditor']} note />);
    const n = union(['editor', 'auditor']).size;
    expect(await screen.findByText(`Darf ${n} von ${total}`)).toBeInTheDocument();
    expect(container.querySelector('.iam-rights-n')).toHaveTextContent(/– Bearbeiter:in und Prüfer:in\.$/);
    expect(screen.getByRole('heading', { level: 5, name: 'Notizen, 2 von 4 erlaubt' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 5, name: 'Zugriff, 1 von 1 erlaubt' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Mitglieder und Rollen, 0 von 1 erlaubt' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Notizen, / })).toBeNull();
    expect(row('Notizen ändern')).toHaveTextContent('erlaubt');
    expect(row('Notizen ändern')).toHaveClass('iam-is-role');
    expect(row('Notizen ändern').querySelector('svg')).not.toBeNull();
    expect(row('Mitglieder und Rollen verwalten')).toHaveTextContent('fehlt');
    expect(row('Mitglieder und Rollen verwalten')).toHaveClass('iam-is-missing');
    expect(container.querySelector('[title]')).toBeNull();
    expect(container).toHaveTextContent('Rollen an einzelnen Orten (Freigaben) können weitere Rechte geben, nur dort.');
    expect(container).not.toHaveTextContent(/note:|members:|editor|auditor/);
  });

  it('mit Scopes «fehlt (Scope)» und Satz zur Freigabe im Token', async () => {
    const { container } = renderIam(<RightsOverview roles={['editor']} scopes={['notes:read']} />);
    expect(await screen.findByText(`Darf 2 von ${total}`)).toBeInTheDocument();
    expect(container.querySelector('.iam-rights-n')).toHaveTextContent('Bearbeiter:in, nur mit Scope (Freigabe im Token). 2 Rechte fehlen nur wegen des Scopes.');
    expect(row('Notizen ändern')).toHaveTextContent('fehlt (Scope)');
    expect(row('Notizen lesen')).toHaveTextContent('erlaubt');
  });

  it('«Warum?» per Tastatur – gebende Rolle, Rollen mit dem Recht, nötiger Scope', async () => {
    const u = userEvent.setup();
    renderIam(<RightsOverview roles={['editor']} scopes={['notes:read']} />);
    await screen.findByText(/^Darf/);
    const w = within(row('Notizen ändern')).getByRole('button', { name: 'Warum? Notizen ändern' });
    expect(w).toHaveAttribute('aria-expanded', 'false');
    w.focus();
    await u.keyboard('{Enter}');
    expect(w).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(w.getAttribute('aria-controls')!)!;
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent('GibtRolle «Bearbeiter:in».');
    expect(panel).toHaveTextContent('Nötig ist der Scope «Notizen ändern und löschen».');
    expect(within(panel).getByText('«Notizen ändern und löschen»')).toHaveAttribute('title', 'Scope notes:write');
    expect(panel).toHaveTextContent('Schlüsselnote:write');
    await u.keyboard(' ');
    expect(w).toHaveAttribute('aria-expanded', 'false');
    await u.click(within(row('Notizen lesen')).getByRole('button', { name: /^Warum\?/ }));
    expect(row('Notizen lesen')).toHaveTextContent('Scope «Organisation und Notizen lesen».');
    await u.click(within(row('Notizen löschen')).getByRole('button', { name: /^Warum\?/ }));
    expect(row('Notizen löschen')).toHaveTextContent('Gehört zu den Rollen «Ordner-Admin» und «Organisations-Admin».');
    await u.click(within(row('Mitglieder und Rollen verwalten')).getByRole('button', { name: /^Warum\?/ }));
    expect(row('Mitglieder und Rollen verwalten')).toHaveTextContent('Gehört nur zur Rolle «Organisations-Admin».');
    expect(row('Mitglieder und Rollen verwalten')).toHaveTextContent('Kein Scope gibt dieses Recht frei');
  });

  it('Umschalter «Alle / Erlaubt / Fehlt» und Suche (ab 10 Rechten); leere Gruppen ausgeblendet', async () => {
    const u = userEvent.setup();
    const ten: AuthzCatalog = { ...CATALOG, permissions: [...CATALOG.permissions, { key: 'note:export', label: 'Notizen exportieren', group: 'notes', resources: ['org'], adminOnly: false, description: 'Export' }] };
    vi.stubGlobal('fetch', mockIamApi({}, { catalog: ten }).fetch);
    const total = ten.permissions.length;
    renderIam(<RightsOverview roles={['viewer']} />);
    await screen.findByText(/^Darf/);
    const seg = screen.getByRole('group', { name: 'Rechte zeigen' });
    const btn = (name: RegExp) => within(seg).getByRole('button', { name });
    expect(btn(/^Alle/)).toHaveAttribute('aria-pressed', 'true');
    expect(btn(/^Alle/)).toHaveTextContent(String(total));
    await u.click(btn(/^Erlaubt/));
    expect(btn(/^Erlaubt/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Notizen ändern', { selector: '.iam-rights-l' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Mitglieder und Rollen/ })).toBeNull();
    expect(screen.getAllByRole('listitem').every(li => li.classList.contains('iam-is-role'))).toBe(true);
    await u.click(btn(/^Fehlt/));
    expect(screen.queryByText('Notizen lesen', { selector: '.iam-rights-l' })).toBeNull();
    expect(screen.getByText('Notizen ändern', { selector: '.iam-rights-l' })).toBeInTheDocument();
    await u.click(btn(/^Alle/));
    await u.type(screen.getByRole('searchbox', { name: 'Rechte durchsuchen' }), 'notizen l');
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('.iam-rights-l')!.textContent)).toEqual(['Notizen lesen', 'Notizen löschen']);
    expect(screen.getAllByRole('heading').map(h => h.textContent)).toEqual(['Notizen1/5, 1 von 5 erlaubt']);
    await u.clear(screen.getByRole('searchbox'));
    await u.type(screen.getByRole('searchbox'), 'gibtsnicht');
    expect(screen.getByText('Keine Rechte gefunden.')).toBeInTheDocument();
  });

  it('Organisations-Admin als ein Satz, Liste erst auf «Rechte anzeigen»; mit Scopes normal', async () => {
    const u = userEvent.setup();
    const { container, unmount } = renderIam(<RightsOverview roles={['org-admin']} permissions={['note:read']} note />);
    expect(await screen.findByText(`Darf ${total} von ${total}`)).toBeInTheDocument();
    expect(screen.getByText('Alle Rechte.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Rechte zeigen' })).toBeNull();
    expect(container).not.toHaveTextContent('Rollen an einzelnen Orten');
    const show = screen.getByRole('button', { name: 'Rechte anzeigen' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await u.click(show);
    expect(screen.getByRole('button', { name: 'Rechte ausblenden' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('listitem')).toHaveLength(total);
    expect(screen.queryByRole('button', { name: /^Warum\?/ })).toBeNull();
    expect(screen.getByText('Alle Rechte kommen aus der Rolle «Organisations-Admin».')).toBeInTheDocument();
    unmount();
    renderIam(<RightsOverview roles={['org-admin']} scopes={['notes:read']} />);
    expect(await screen.findByText(/^Darf 2 von/)).toBeInTheDocument();
    expect(screen.queryByText('Alle Rechte.')).toBeNull();
  });

  it('Änderung gegenüber bisher (before): «+ x, − y», kompakte Liste, Rechte markiert; ohne Änderung ein Satz', async () => {
    const authz = makeAuthz(CATALOG);
    const allowed = (roles: string[]) => new Set(rightsModel(authz, { roles }).filter(r => isAllowed(r.status)).map(r => r.perm.key));
    const was = allowed(['auditor', 'viewer']), now = allowed(['viewer', 'editor']);
    const keys = CATALOG.permissions.map(p => p.key);
    const add = keys.filter(k => now.has(k) && !was.has(k)), del = keys.filter(k => !now.has(k) && was.has(k));
    expect(add.length && del.length).toBeTruthy();
    const { container, unmount } = renderIam(<RightsOverview roles={['viewer', 'editor']} before={['auditor', 'viewer']} />);
    expect(await screen.findByText(`Darf ${now.size} von ${total}`)).toBeInTheDocument();
    const nr = (n: number) => `${n} ${n === 1 ? 'Recht' : 'Rechte'}`;
    expect(container.querySelector('.iam-rights-delta')).toHaveTextContent(`+ ${nr(add.length)}, − ${nr(del.length)} gegenüber bisher`);
    expect(container.querySelector('.iam-rights-delta')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('button', { name: 'Änderungen anzeigen' })).toBeNull();
    const list = screen.getByRole('list', { name: /^Änderungen:/ });
    expect(list).toBeVisible();
    const label = (k: string) => CATALOG.permissions.find(p => p.key === k)!.label;
    expect(within(list).getAllByRole('listitem').map(li => li.querySelector('.iam-rights-chg-l')!.textContent)).toEqual(keys.filter(k => add.includes(k) || del.includes(k)).map(label));
    expect(row(label(add[0]!))).toHaveClass('iam-is-add');
    expect(row(label(add[0]!))).toHaveTextContent('neu');
    expect(row(label(del[0]!))).toHaveClass('iam-is-del');
    expect(row(label(del[0]!))).toHaveTextContent('fällt weg');
    unmount();
    renderIam(<RightsOverview roles={['viewer']} before={['viewer']} />);
    expect(await screen.findByText('Rechte unverändert gegenüber bisher')).toBeInTheDocument();
    expect(document.querySelector('.iam-rights-r.iam-is-add, .iam-rights-r.iam-is-del')).toBeNull();
  });

  it('mehr als 10 Änderungen: Liste eingeklappt hinter «Änderungen anzeigen»', async () => {
    const u = userEvent.setup();
    const extra = Array.from({ length: 12 }, (_, i) => ({ key: `note:x${i}`, label: `Zusatz ${i}`, group: 'notes', resources: ['org'], adminOnly: false, description: `Zusatz ${i}` }));
    const big: AuthzCatalog = { ...CATALOG, permissions: [...CATALOG.permissions, ...extra], roles: CATALOG.roles.map(r => (r.key === 'org-admin' ? { ...r, permissions: [...r.permissions, ...extra.map(p => p.key)] } : r)) };
    vi.stubGlobal('fetch', mockIamApi({}, { catalog: big }).fetch);
    renderIam(<RightsOverview roles={['org-admin']} before={['viewer']} />);
    expect(await screen.findByText(/gegenüber bisher/)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Änderungen anzeigen' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: /^Änderungen:/ })).toBeNull();
    await u.click(btn);
    expect(screen.getByRole('list', { name: /^Änderungen:/ })).toBeVisible();
  });

  it('«Rollen vergleichen» eingeklappt mit der Matrix', async () => {
    const u = userEvent.setup();
    const { container } = renderIam(<RoleCompare roles={CATALOG.roles} highlight={['viewer']} />);
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    await u.click(screen.getByText('Rollen vergleichen'));
    expect(details.open).toBe(true);
    expect(await screen.findByRole('table', { name: 'Rechte je Rolle (deine Rollen hervorgehoben)' })).toBeVisible();
  });
});
