/**
 * Rechte sichtbar machen: Guards für Verwalten-Seiten, Seitenkopf, Kontomenü und «Meine Rollen und Rechte», Organisation
 * in Kopfzeile und Befehlspalette. Aus vollholz/assets `web/src/shell/rights.test.tsx`, produktneutral (Notiz-App).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountMenu, AdminHead, OrgName, Requires, RequiresPlatformAdmin, useOrgSwitchItems, type Me } from '../src/index.ts';
import { json, ME, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

function setup(ui: ReactElement, me: Partial<Me> = {}, routes: Record<string, MockHandler> = {}) {
  const api = mockIamApi(routes);
  vi.stubGlobal('fetch', api.fetch);
  render(<StaticIam me={me}>{ui}</StaticIam>);
  return api;
}

describe('Guards für Verwalten-Seiten', () => {
  function Page() { return <p>Seite Mitglieder</p>; }

  it('ohne Recht: Seite «Recht fehlt» mit Titel, Recht und Rollen; die Seite selbst wird nicht gezeichnet', async () => {
    const api = setup(<Requires perm="members:admin" title="Mitglieder" icon="users"><Page /></Requires>, { roles: ['viewer'], permissions: ['tenant:read', 'note:read'] });
    expect(screen.getByRole('heading', { level: 1, name: 'Mitglieder' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recht fehlt' })).toBeInTheDocument();
    expect(await screen.findByText(/«Mitglieder und Rollen verwalten»\. Es gehört nur zur Rolle «Organisations-Admin»\. Diese Rolle vergibt die Plattform-Administration\./)).toBeInTheDocument();
    expect(screen.queryByText('Seite Mitglieder')).toBeNull();
    expect(api.calls.map(c => new URL(c.url).pathname).filter(p => p !== '/v1/authz/catalog' && p !== '/v1/roles')).toEqual([]);
  });

  it('mit Recht: die Seite; Recht nur über eine Freigabe genügt standardmässig (somewhere), sonst nicht', () => {
    const me = { roles: ['viewer'], permissions: ['tenant:read'], grantedPermissions: ['folder:admin'] };
    setup(<>
      <Requires perm="folder:admin" title="Ordner" icon="tag"><p>Ordner irgendwo</p></Requires>
      <Requires perm="folder:admin" somewhere={false} title="Ordner der Organisation" icon="tag"><p>Ordner überall</p></Requires>
    </>, me);
    expect(screen.getByText('Ordner irgendwo')).toBeInTheDocument();
    expect(screen.queryByText('Ordner überall')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Ordner der Organisation' })).toBeInTheDocument();
  });

  it('Plattform-Administration nach /v1/admin/status (Realm-Rolle, kein Recht des Katalogs)', async () => {
    const status = (platformAdmin: boolean) => ({ 'GET /v1/admin/status': () => json({ enabled: true, reason: null, organization: 'demo', platformAdmin, canManageMembers: true, rolesManageable: true, roles: [] }) });
    setup(<RequiresPlatformAdmin title="Organisationen" icon="building"><p>Alle Organisationen</p></RequiresPlatformAdmin>, {}, status(false));
    expect(screen.getByText('Wird geladen …')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Organisationen' })).toBeInTheDocument();
    const text = await screen.findByText(/^Dafür braucht es die Plattform-Administration\./);
    expect(text).toHaveAttribute('title', 'Realm-Rolle «platform-admin» in Keycloak');
    expect(screen.queryByText('Alle Organisationen')).toBeNull();
  });

  it('Plattform-Administration vorhanden: die Seite', async () => {
    setup(<RequiresPlatformAdmin title="Organisationen" icon="building"><p>Alle Organisationen</p></RequiresPlatformAdmin>, {}, {
      'GET /v1/admin/status': () => json({ enabled: true, reason: null, organization: 'demo', platformAdmin: true, canManageMembers: true, rolesManageable: true, roles: [] }),
    });
    expect(await screen.findByText('Alle Organisationen')).toBeInTheDocument();
  });
});

describe('Seitenkopf', () => {
  it('Pfad Produkt › Verwalten › Zwischenstufen › Titel mit Links über den Router, Hauptaktion', async () => {
    const u = userEvent.setup();
    setup(<AdminHead icon="building" title="Demo AG" sub="Organisation" crumbs={[['Organisationen', '/verwalten/organisationen']]} actions={<button type="button">Sperren</button>} />);
    const nav = screen.getByRole('navigation', { name: 'Pfad' });
    expect(nav).toHaveTextContent('NotizenVerwaltenOrganisationenDemo AG');
    expect(within(nav).getByRole('link', { name: 'Notizen' })).toHaveAttribute('href', '/');
    await u.click(within(nav).getByRole('link', { name: 'Organisationen' }));
    expect(window.location.pathname).toBe('/verwalten/organisationen');
    expect(screen.getByRole('heading', { level: 1, name: 'Demo AG' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sperren' })).toBeInTheDocument();
  });
});

describe('Kontomenü', () => {
  it('Rollen-Labels aus dem Katalog; «Meine Rollen und Rechte» mit Rollenkarten, Rechte-Übersicht, Hinweis und «Rollen vergleichen»', async () => {
    const u = userEvent.setup();
    setup(<AccountMenu avatar={<span aria-hidden="true">AA</span>} />, { roles: ['folder-admin', 'auditor'], permissions: ['tenant:read', 'acl:read', 'note:read', 'note:write', 'note:delete', 'folder:admin', 'audit:read'] });
    const account = screen.getByRole('button', { name: 'Konto: Anna Admin, Organisation «Demo AG»' });
    expect(account).toHaveAttribute('title', 'Angemeldet als Anna Admin (Demo AG)');
    await u.click(account);
    const menu = screen.getByRole('menu', { name: 'Konto' });
    expect(await within(menu).findByText(/Ordner-Admin, Prüfer:in/)).toBeInTheDocument();
    expect(menu).not.toHaveTextContent(/folder-admin|auditor\b/);
    await u.click(within(menu).getByRole('menuitem', { name: 'Meine Rollen und Rechte' }));
    const dlg = await screen.findByRole('dialog', { name: 'Meine Rollen und Rechte' });
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Schliessen' })).toHaveFocus());
    const cards = within(dlg).getAllByRole('listitem').filter(li => li.classList.contains('iam-card'));
    expect(cards.map(c => c.textContent)).toEqual(['Ordner-AdminOrganisation lesen', 'Prüfer:inOrganisation lesen']);
    expect(cards[0]).toHaveAttribute('title', expect.stringMatching(/^Organisation lesen; Notizen/));
    expect(within(dlg).getByText('Darf 7 von 10')).toBeInTheDocument();
    expect(dlg.querySelector('.iam-rights-n')).toHaveTextContent('– Ordner-Admin und Prüfer:in.');
    const row = (name: string) => within(dlg).getByText(name, { selector: '.iam-rights-l' }).closest('li')!;
    expect(row('Ordner verwalten')).toHaveTextContent('erlaubt');
    expect(row('Zugriff verwalten')).toHaveTextContent('fehlt (Rolle)');
    expect(within(dlg).getByRole('heading', { level: 5, name: 'Notizen, 4 von 4 erlaubt' })).toBeInTheDocument();
    expect(dlg).toHaveTextContent('Zugriffsregeln können Rechte für einzelne Bereiche freigeben oder einzelne Bereiche zusätzlich einschränken. Fragen dazu beantwortet die Organisations-Administration.');
    const compare = within(dlg).getByText('Rollen vergleichen');
    expect(compare.closest('details')!.open).toBe(false);
    await u.click(compare);
    const table = within(dlg).getByRole('table', { name: /Rechte je Rolle \(deine Rollen hervorgehoben\)/ });
    expect(within(table).getAllByRole('columnheader').filter(c => c.classList.contains('iam-mine')).map(c => c.textContent)).toEqual(['Ordner-Admin (deine Rolle)', 'Prüfer:in (deine Rolle)']);
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(account).toHaveFocus();
  });

  it('Tastatur: Pfeile, Pos1/Ende, Esc gibt den Fokus zurück; Wechsel der Organisation und eigene Einträge', async () => {
    const u = userEvent.setup();
    const extra = vi.fn();
    const api = setup(<AccountMenu avatar="AA" extraItems={close => <button type="button" role="menuitem" className="iam-menu-i" onClick={() => { extra(); close(); }}>Farbschema</button>} />, {}, { 'POST /auth/switch': () => json({ redirect: '/' }) });
    const account = screen.getByRole('button', { name: /^AAKonto:/ });
    await u.click(account);
    const items = within(screen.getByRole('menu', { name: 'Konto' })).getAllByRole('menuitem');
    expect(items.map(i => i.textContent)).toEqual(['Meine Rollen und Rechte', 'Zu «Muster GmbH» wechseln', 'Farbschema', 'Abmelden']);
    expect(screen.getByRole('group', { name: 'Organisation wechseln' })).toContainElement(items[1]!);
    await waitFor(() => expect(items[0]).toHaveFocus());
    await u.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await u.keyboard('{End}');
    expect(items[3]).toHaveFocus();
    await u.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await u.keyboard('{ArrowUp}{ArrowUp}');
    expect(items[2]).toHaveFocus();
    await u.keyboard('{Enter}');
    expect(extra).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(account).toHaveFocus();
    await u.click(account);
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(account).toHaveFocus();
    expect(api.calls).toHaveLength(api.calls.filter(c => c.method === 'GET').length);
  });

  it('«Meine Rollen und Rechte»: Rechte nur aus Freigaben einzelner Bereiche mit eigenem Status statt «fehlt», gezählt, ohne Bereiche', async () => {
    const u = userEvent.setup();
    setup(<AccountMenu avatar="AA" />, { roles: ['viewer'], permissions: ['tenant:read', 'note:read'], grantedPermissions: ['folder:admin', 'note:write'] });
    await u.click(screen.getByRole('button', { name: /^AAKonto:/ }));
    await u.click(within(screen.getByRole('menu', { name: 'Konto' })).getByRole('menuitem', { name: 'Meine Rollen und Rechte' }));
    const dlg = await screen.findByRole('dialog', { name: 'Meine Rollen und Rechte' });
    const row = (name: string) => within(dlg).getByText(name, { selector: '.iam-rights-l' }).closest('li')!;
    await within(dlg).findByText(/^Darf/);
    // Kein widersprüchliches «fehlt» für dieselbe Fähigkeit: eigener Status, gezählt und im Filter «Erlaubt»
    expect(row('Ordner verwalten')).toHaveTextContent('in einzelnen Bereichen');
    expect(row('Ordner verwalten')).not.toHaveTextContent('fehlt');
    expect(row('Notizen ändern')).toHaveTextContent('in einzelnen Bereichen');
    expect(row('Notizen lesen')).toHaveTextContent('erlaubt');
    expect(within(dlg).getByText('Darf 4 von 10')).toBeInTheDocument();
    expect(dlg).toHaveTextContent('2 Rechte davon nur in einzelnen Bereichen.');
    await u.click(within(row('Ordner verwalten')).getByRole('button', { name: 'Warum? Ordner verwalten' }));
    expect(row('Ordner verwalten')).toHaveTextContent('Eine Freigabe für einzelne Bereiche (Zugriffsregel)');
    // Datensparsam: kein Bereich, nur der Hinweis, wer ihn kennt
    expect(dlg).toHaveTextContent('Rechte «in einzelnen Bereichen» gelten nur dort, wo eine Zugriffsregel sie freigibt');
    await u.click(within(dlg).getByRole('button', { name: /^Fehlt/ }));
    expect(within(dlg).queryByText('Ordner verwalten', { selector: '.iam-rights-l' })).toBeNull();
  });

  it('«Meine Rollen und Rechte» ohne Rolle, aber mit Freigaben: eigener Satz statt «siehst nichts»; ohne beides «siehst nichts»', async () => {
    const u = userEvent.setup();
    setup(<AccountMenu avatar="AA" />, { roles: [], permissions: ['tenant:read'], grantedPermissions: ['note:read'] });
    await u.click(screen.getByRole('button', { name: /^AAKonto:/ }));
    expect(within(screen.getByRole('menu', { name: 'Konto' })).getByText(/keine Rolle$/)).toBeInTheDocument();
    await u.click(screen.getByRole('menuitem', { name: 'Meine Rollen und Rechte' }));
    const dlg = await screen.findByRole('dialog', { name: 'Meine Rollen und Rechte' });
    expect(within(dlg).getByText('Du hast in dieser Organisation keine Rolle, aber Freigaben für einzelne Bereiche.')).toBeInTheDocument();
  });

  it('«Meine Rollen und Rechte» als Organisations-Admin: ein Satz statt Liste, kein Hinweis auf Zugriffsregeln', async () => {
    const u = userEvent.setup();
    setup(<AccountMenu avatar="AA" />);
    await u.click(screen.getByRole('button', { name: /^AAKonto:/ }));
    await u.click(screen.getByRole('menuitem', { name: 'Meine Rollen und Rechte' }));
    const dlg = await screen.findByRole('dialog', { name: 'Meine Rollen und Rechte' });
    expect(await within(dlg).findByText('Darf 10 von 10')).toBeInTheDocument();
    expect(within(dlg).getByText('Alle Rechte. Zugriffsregeln gelten nicht.')).toBeInTheDocument();
    expect(dlg.querySelectorAll('.iam-rights-r')).toHaveLength(0);
    expect(dlg).not.toHaveTextContent('Zugriffsregeln können');
    expect(dlg).not.toHaveTextContent('in einzelnen Bereichen');
  });
});

describe('Organisation in Kopfzeile und Befehlspalette', () => {
  it('OrgName zeigt den Namen (Alias als title); useOrgSwitchItems listet die übrigen mit Wechsel', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    function Palette() { return <ul>{useOrgSwitchItems().map(i => <li key={i.alias}><button type="button" onClick={() => void i.run()}>{i.label}</button></li>)}</ul>; }
    const me: Partial<Me> = { organizations: ['demo', 'muster', 'dritte'], organizationNames: { ...ME.organizationNames, dritte: 'Dritte AG' } };
    setup(<><OrgName /><Palette /></>, me);
    expect(screen.getByText('Demo AG')).toHaveAttribute('title', 'demo');
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Zu «Muster GmbH» wechseln', 'Zu «Dritte AG» wechseln']);
  });
});
