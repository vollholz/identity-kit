/**
 * Mitglieder: Liste von Personen und Clients (Art, Status, Rollen, Freigabestufe, «+n Orte», Filter nach Name, Art, Rolle
 * und Recht, Sortierung, einzeilige Aktionen mit Menü «Mehr», gesperrte Aktionen mit Grund), Einladen mit Rollen, Client
 * freigeben, Freigabestufe setzen, niemand gibt mehr, als er hat, Rückfragen mit Organisation und Folgen, abgeschaltete
 * Verwaltung, Enthaltensein aus den Rechten. Aus vollholz/assets `web/src/features/admin.test.tsx` (Mitglieder und Rollen) und
 * `features/admin/members.test.tsx`, produktneutral (Notiz-App).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { containers, type IamConfig, type Me, type Member, type RoleInfo } from '../src/index.ts';
import { MemberList, MembersScreen } from '../src/pages/index.ts';
import { CATALOG, json, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => vi.unstubAllGlobals());

const ROLES: RoleInfo[] = CATALOG.roles;
const N = CATALOG.permissions.length;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const m = (id: string, name: string, roles: string[], o: Partial<Member> = {}): Member => ({
  id: `00000000-0000-4000-8000-0000000000${id}`, kind: 'user', principalId: `p${id}`, username: name.split(' ')[0]!.toLowerCase(), name,
  email: `${name.split(' ')[0]!.toLowerCase()}@demo.example`, status: 'active', roles, clearance: 0, breakGlassUntil: null, places: 0,
  lastSeenAt: ago(1), createdAt: null, loginPath: null, clientId: null, scopes: null, description: null, ...o,
});
const ANNA = m('a1', 'Anna Admin', ['org-admin'], { lastSeenAt: ago(0) });
const NORA = m('b2', 'Nora Neu', ['viewer'], { username: 'nora@demo.example', status: 'invited', lastSeenAt: null, createdAt: ago(3) });
const CARLA = m('c3', 'Carla Check', ['editor', 'viewer'], { lastSeenAt: ago(2) });
const OSKAR = m('d4', 'Oskar Org', ['org-admin'], { lastSeenAt: ago(5) });
const ERIK = m('e5', 'Erik Extern', ['viewer'], { email: 'erik@partner.example', status: 'disabled', lastSeenAt: null });
const STATUS = { enabled: true, reason: null, organization: 'demo', platformAdmin: false, canManageMembers: true, roles: ROLES };
const SYNC: Member = { ...m('s9', 'notiz-import', ['editor']), id: 'notiz-import', kind: 'client', username: 'service-account-notiz-import', email: null, clientId: 'notiz-import', scopes: ['notes:read'], lastSeenAt: ago(0.1) };
const ADMIN_ME: Partial<Me> = { person: { subject: ANNA.id, name: 'Anna Admin', email: 'anna@demo.example' } };

function setup(ui: ReactElement, routes: Record<string, MockHandler> = {}, me: Partial<Me> = ADMIN_ME) {
  const api = mockIamApi({ 'GET /v1/admin/status': () => json(STATUS), ...routes });
  vi.stubGlobal('fetch', api.fetch);
  const r = render(<StaticIam me={me}>{ui}</StaticIam>);
  return { ...api, ...r };
}
const own = () => <MemberList />;
const platformList = () => <MemberList alias="muster" platform orgLabel="Muster GmbH" />;
const names = (table: HTMLElement) => within(table).getAllByRole('row').slice(1).map(r => r.querySelector('.iam-b')!.firstChild!.textContent);

describe('Seite Mitglieder', () => {
  it('ohne Recht: «Recht fehlt» statt Liste; abgeschaltet: klarer Hinweis mit dem Grund des Servers', async () => {
    const off = { 'GET /v1/admin/status': () => json({ ...STATUS, enabled: false, reason: 'Die Verwaltung ist nicht eingerichtet (KEYCLOAK_MGMT_CLIENT_ID).' }) };
    const { unmount, calls } = setup(<MembersScreen />, off, { roles: ['viewer'], permissions: ['tenant:read', 'note:read'] });
    expect(await screen.findByText('Recht fehlt')).toBeInTheDocument();
    expect(calls.some(c => c.url.includes('/v1/admin/'))).toBe(false);
    unmount();
    setup(<MembersScreen />, off);
    expect(await screen.findByText('Verwaltung nicht eingerichtet')).toBeInTheDocument();
    expect(screen.getByText(/KEYCLOAK_MGMT_CLIENT_ID/)).toBeInTheDocument();
    expect(screen.getByText(/Rollen und Freigaben bleiben in der App\./)).not.toHaveTextContent('/orgs/');
    expect(screen.queryByRole('button', { name: 'Person einladen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Client freigeben' })).toBeNull();
  });

  it('listet Personen und Clients mit Art, Status, Rollen, Freigabestufe, Orten und «Zuletzt aktiv»; Hauptaktion im Seitenkopf', async () => {
    setup(<MembersScreen />, { 'GET /v1/admin/members': () => json({ items: [ANNA, NORA, ERIK, { ...SYNC, clearance: 1 }] }) });
    const table = await screen.findByRole('table', { name: 'Mitglieder von Demo AG mit Rollen' });
    expect(screen.getByText(/Wer in «Demo AG» arbeitet/)).toBeInTheDocument();
    // Hauptaktion im Kopf der Seite (AdminHead), nicht im Abschnitt
    const head = screen.getByRole('heading', { level: 1, name: 'Mitglieder' }).closest('.iam-mh') as HTMLElement;
    expect(within(head).getByRole('button', { name: 'Person einladen' })).toHaveClass('iam-primary');
    expect(within(head).getByRole('button', { name: 'Client freigeben' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Person einladen' })).toHaveLength(1);
    expect(screen.getByText('3 Personen, davon 1 eingeladen, 1 Client')).toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader').map(c => c.textContent)).toEqual(['Name', 'Art', 'Status', 'Rollen', 'Freigabestufe', 'Orte', 'Zuletzt aktiv', 'Aktionen']);
    // Gestapelt unter 760 px; «Zuletzt aktiv» fällt dort weg
    expect(table).toHaveClass('iam-stack-tbl');
    expect(within(table).getByRole('columnheader', { name: 'Zuletzt aktiv' })).toHaveClass('iam-st-hide');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Anna Admin');
    expect(rows[0]).toHaveTextContent('(du)');
    // Rollen als Liste mit Labels, ohne technischen Schlüssel
    const tags = within(rows[0]!).getByRole('list', { name: 'Rollen von Anna Admin' });
    expect(within(tags).getByRole('listitem')).toHaveTextContent('Organisations-Admin');
    expect(rows[0]).not.toHaveTextContent('org-admin');
    expect(rows[1]).toHaveTextContent('eingeladen');
    expect(rows[1]).toHaveTextContent('vor 3 Tagen');
    expect(rows[1]).toHaveTextContent('noch nie');
    // deaktiviert im Verzeichnis heisst «deaktiviert» («gesperrt» nur für die Sperre einer Organisation)
    expect(within(rows[2]!).getByText('deaktiviert')).toHaveAttribute('title', 'Konto in Keycloak deaktiviert');
    expect(table).not.toHaveTextContent('gesperrt');
    expect(rows[0]).toHaveTextContent('Person');
    expect(rows[0]).toHaveTextContent('intern');
    // Client: Art, Client-ID, Scopes aus dem letzten Token (Texte aus dem Katalog), Freigabestufe
    expect(rows[3]).toHaveTextContent('Client');
    expect(rows[3]).toHaveTextContent('notiz-import');
    expect(rows[3]).toHaveTextContent('Scopes: Organisation und Notizen lesen');
    expect(rows[3]).toHaveTextContent('vertraulich');
    expect(within(rows[3]!).queryByText('(du)')).toBeNull();
    expect(screen.getByText(/Nur eine Person hat die Rolle «Organisations-Admin»/)).toBeInTheDocument();
    const box = screen.getByRole('searchbox', { name: 'Mitglieder filtern' });
    expect(box).toHaveAttribute('placeholder', 'Name oder E-Mail filtern');
    await userEvent.type(box, 'nora');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    await userEvent.clear(box);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Art:/ }), 'client');
    expect(names(table)).toEqual(['notiz-import']);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Art:/ }), 'user');
    expect(names(table)).toEqual(['Anna Admin', 'Nora Neu', 'Erik Extern']);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Art:/ }), '');
    await userEvent.type(box, 'niemand');
    expect(await screen.findByText('Keine Treffer')).toBeInTheDocument();
    expect(screen.getByText('Keine Person passt zu «niemand».')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(box).toHaveValue('');
    expect(await axeProblems()).toEqual([]);
  });
});

describe('Mitgliederliste: Filter, Sortierung, Rollenmatrix', () => {
  const ITEMS = [ANNA, m('e2', 'Erik', ['editor'], { lastSeenAt: ago(5) }), m('b3', 'Bea', ['viewer'], { lastSeenAt: null }), m('c4', 'Pia', ['auditor', 'viewer'], { lastSeenAt: ago(2) })];
  async function list() {
    setup(own(), { 'GET /v1/admin/members': () => json({ items: ITEMS }) });
    return screen.findByRole('table', { name: 'Mitglieder von Demo AG mit Rollen' });
  }

  it('filtert nach Rolle, zählt «x von y», setzt alle Filter zurück', async () => {
    const table = await list();
    expect(names(table)).toEqual(['Anna Admin', 'Erik', 'Bea', 'Pia']);
    expect(screen.queryByText(/ von 4$/)).toBeNull();
    const role = screen.getByRole('combobox', { name: /^Rolle:/ });
    expect(within(role).getAllByRole('option').map(o => o.textContent)).toEqual(['alle', ...ROLES.map(r => r.label)]);
    await userEvent.selectOptions(role, 'viewer');
    expect(names(table)).toEqual(['Bea', 'Pia']);
    expect(screen.getByText('2 von 4')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Mitglieder filtern' }), 'pia');
    expect(names(table)).toEqual(['Pia']);
    await userEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(role).toHaveValue('');
    expect(screen.getByRole('searchbox', { name: 'Mitglieder filtern' })).toHaveValue('');
    expect(names(table)).toEqual(['Anna Admin', 'Erik', 'Bea', 'Pia']);
  });

  it('«Wer hat Recht X?»: Rechte gruppiert aus dem Katalog, Treffer über die Rollen, Hinweis auf Freigaben an Orten', async () => {
    const table = await list();
    const perm = screen.getByRole('combobox', { name: /^Recht:/ });
    await screen.findByRole('option', { name: 'Notizen ändern' });
    expect(perm.querySelector('optgroup[label="Notizen"]')).not.toBeNull();
    expect(screen.queryByText(/Freigaben an einzelnen Orten/)).toBeNull();
    await userEvent.selectOptions(perm, 'note:write');
    expect(names(table)).toEqual(['Anna Admin', 'Erik']);
    expect(screen.getByText(/Freigaben an einzelnen Orten sind hier nicht berücksichtigt/)).toHaveTextContent('«Notizen ändern»');
    await userEvent.selectOptions(perm, 'members:admin');
    expect(names(table)).toEqual(['Anna Admin']);
    // Rolle und Recht kombiniert, ohne Treffer: leerer Zustand mit «Filter zurücksetzen»
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Rolle:/ }), 'viewer');
    expect(await screen.findByText('Keine Person passt zu den gewählten Filtern.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Filter zurücksetzen' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(perm).toHaveValue('');
  });

  it('sortiert nach Name und «Zuletzt aktiv» (aria-sort), Standard in der Reihenfolge der API', async () => {
    const table = await list();
    const person = within(table).getByRole('columnheader', { name: 'Name' });
    const seen = within(table).getByRole('columnheader', { name: 'Zuletzt aktiv' });
    expect(person).toHaveAttribute('aria-sort', 'none');
    await userEvent.click(within(person).getByRole('button'));
    expect(person).toHaveAttribute('aria-sort', 'ascending');
    expect(names(table)).toEqual(['Anna Admin', 'Bea', 'Erik', 'Pia']);
    await userEvent.click(within(person).getByRole('button'));
    expect(person).toHaveAttribute('aria-sort', 'descending');
    expect(names(table)).toEqual(['Pia', 'Erik', 'Bea', 'Anna Admin']);
    // «Zuletzt aktiv»: neueste zuerst, «noch nie» zuletzt; erneuter Klick kehrt um
    await userEvent.click(within(seen).getByRole('button'));
    expect(seen).toHaveAttribute('aria-sort', 'descending');
    expect(person).toHaveAttribute('aria-sort', 'none');
    expect(names(table)).toEqual(['Anna Admin', 'Pia', 'Erik', 'Bea']);
    await userEvent.click(within(seen).getByRole('button'));
    expect(names(table)).toEqual(['Bea', 'Erik', 'Pia', 'Anna Admin']);
  });

  it('Sortierauswahl für die gestapelte Ansicht (ohne Tabellenkopf) entspricht den Spaltenköpfen', async () => {
    const table = await list();
    const pick = screen.getByRole('combobox', { name: /^Sortierung:/ });
    await userEvent.selectOptions(pick, 'seen-desc');
    expect(names(table)).toEqual(['Anna Admin', 'Pia', 'Erik', 'Bea']);
    expect(within(table).getByRole('columnheader', { name: 'Zuletzt aktiv' })).toHaveAttribute('aria-sort', 'descending');
    await userEvent.selectOptions(pick, 'name-asc');
    expect(names(table)).toEqual(['Anna Admin', 'Bea', 'Erik', 'Pia']);
    await userEvent.selectOptions(pick, '');
    expect(names(table)).toEqual(['Anna Admin', 'Erik', 'Bea', 'Pia']);
  });

  it('Zeilenknopf: «Ansehen» bei Organisations-Admins, sonst «Rollen»; Rollenmatrix zugeklappt unter der Tabelle', async () => {
    const table = await list();
    expect(within(table).getByRole('button', { name: 'Rollen von Anna Admin ansehen' })).toHaveTextContent(/^Ansehen$/);
    expect(within(table).getByRole('button', { name: 'Rollen von Erik bearbeiten' })).toHaveTextContent(/^Rollen$/);
    const more = screen.getByText('Rollen und Rechte').closest('details')!;
    expect(more).not.toHaveAttribute('open');
    expect(table.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(within(more).getByText('Rollen und Rechte'));
    const matrix = await within(more).findByRole('table', { name: 'Rechte je Rolle' });
    expect(within(matrix).getAllByRole('columnheader').slice(1).map(c => c.textContent)).toEqual(['Organisations-Admin', 'Ordner-Admin', 'Bearbeiter:in', 'Leser:in', 'Prüfer:in']);
  });
});

describe('Aktionen je Person', () => {
  it('in jeder Zeile höchstens «Rollen» und «Mehr»; Menü mit Einladung erneut senden (Organisation in der Meldung)', async () => {
    const { calls } = setup(own(), {
      'GET /v1/admin/members': () => json({ items: [ANNA, NORA, CARLA] }),
      [`POST /v1/admin/members/${NORA.id}/invitation`]: () => json({ emailSent: true }),
    });
    const table = await screen.findByRole('table', { name: /^Mitglieder/ });
    const [anna, nora, carla] = within(table).getAllByRole('row').slice(1) as [HTMLElement, HTMLElement, HTMLElement];
    for (const row of [anna, nora, carla]) {
      const acts = row.querySelector('td.iam-acts .iam-row-acts') as HTMLElement;
      expect(within(acts).getAllByRole('button').length).toBeLessThanOrEqual(2);
      expect(within(row).queryByRole('button', { name: /erneut senden/ })).toBeNull();
      expect(within(row).getByRole('button', { name: /^Mehr zu / })).toHaveAttribute('aria-haspopup', 'menu');
    }
    const more = within(nora).getByRole('button', { name: 'Mehr zu Nora Neu' });
    expect(more).toHaveAttribute('title', 'Mehr');
    await userEvent.click(more);
    const menu = await screen.findByRole('menu', { name: 'Aktionen für Nora Neu' });
    expect(within(menu).getAllByRole('menuitem').map(i => i.getAttribute('aria-label'))).toEqual(['Freigabestufe setzen …', 'Einladung erneut senden', 'Einladung zurückziehen …']);
    expect(within(menu).getByRole('menuitem', { name: 'Freigabestufe setzen …' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(more).toHaveFocus();
    await userEvent.click(more);
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Einladung erneut senden' }));
    expect(await screen.findByText('Einladung zu «Demo AG» an nora@demo.example erneut gesendet')).toBeInTheDocument();
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/invitation'))).toBe(true);
    // aktive Person: Freigabestufe und «Person entfernen …», frei
    await userEvent.click(within(carla).getByRole('button', { name: 'Mehr zu Carla Check' }));
    const items = within(await screen.findByRole('menu')).getAllByRole('menuitem');
    expect(items.map(i => i.getAttribute('aria-label'))).toEqual(['Freigabestufe setzen …', 'Person entfernen …']);
    expect(items[1]).not.toHaveAttribute('aria-disabled');
  });

  it('erneut senden ohne E-Mail-Versand: Meldung «nicht per E-Mail gesendet» statt «gesendet»', async () => {
    setup(own(), {
      'GET /v1/admin/members': () => json({ items: [ANNA, NORA] }),
      [`POST /v1/admin/members/${NORA.id}/invitation`]: () => json({ emailSent: false }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Mehr zu Nora Neu' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Einladung erneut senden' }));
    expect(await screen.findByText(/^Keycloak konnte die Einladung an nora@demo\.example nicht per E-Mail senden/)).toBeInTheDocument();
    expect(screen.queryByText(/erneut gesendet/)).toBeNull();
  });

  it('letzte aktive Person mit org-admin: offene Einladungen und deaktivierte zählen nicht (wie der Server)', async () => {
    const items = [ANNA, CARLA, { ...NORA, roles: ['org-admin'] }, { ...ERIK, roles: ['org-admin'] }];
    setup(platformList(), { 'GET /v1/platform/organizations/muster/members': () => json({ items }) }, { person: { subject: 'sub-plattform', name: 'Pia Plattform', email: null } });
    await userEvent.click(await screen.findByRole('button', { name: 'Mehr zu Anna Admin' }));
    const last = within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Person entfernen …' });
    expect(last).toHaveAttribute('aria-disabled', 'true');
    expect(last).toHaveAccessibleDescription(/^Letzter Organisations-Admin/);
    expect(screen.getByText(/Nur eine Person hat die Rolle «Organisations-Admin»/)).toBeInTheDocument();
  });

  it('was die API ablehnt, steht gesperrt mit Grund im Menü (sich selbst, anderer Organisations-Admin) und öffnet keine Rückfrage', async () => {
    const { calls } = setup(own(), { 'GET /v1/admin/members': () => json({ items: [ANNA, OSKAR, CARLA, { ...NORA, roles: ['org-admin'] }] }) });
    const blocked = async (who: string, label: string, why: RegExp) => {
      await userEvent.click(await screen.findByRole('button', { name: `Mehr zu ${who}` }));
      const item = within(await screen.findByRole('menu', { name: `Aktionen für ${who}` })).getByRole('menuitem', { name: label });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveAccessibleDescription(why);
      await userEvent.click(item);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      await userEvent.keyboard('{Escape}');
    };
    await blocked('Oskar Org', 'Person entfernen …', /^Organisations-Admins entfernt nur die Plattform-Administration\.$/);
    await blocked('Anna Admin', 'Person entfernen …', /^Dich selbst kannst du nicht entfernen\.$/);
    await blocked('Nora Neu', 'Einladung zurückziehen …', /zieht nur die Plattform-Administration zurück/);
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it('Plattform-Administration: letzter Organisations-Admin gesperrt mit Grund, mit zweitem Admin frei', async () => {
    let items = [ANNA, CARLA];
    const platform = platformList;
    const { unmount } = setup(platform(), { 'GET /v1/platform/organizations/muster/members': () => json({ items }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Mehr zu Anna Admin' }));
    const last = within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Person entfernen …' });
    expect(last).toHaveAttribute('aria-disabled', 'true');
    expect(last).toHaveAccessibleDescription(/^Letzter Organisations-Admin – zuerst einer weiteren Person diese Rolle geben\.$/);
    unmount();
    items = [ANNA, OSKAR];
    setup(platform(), { 'GET /v1/platform/organizations/muster/members': () => json({ items }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Mehr zu Anna Admin' }));
    const free = within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Person entfernen …' });
    expect(free).not.toHaveAttribute('aria-disabled');
    await userEvent.click(free);
    expect(await screen.findByRole('alertdialog', { name: 'Anna Admin aus «Muster GmbH» entfernen?' })).toBeInTheDocument();
  });

  it('Einladung zurückziehen: Rückfrage mit Organisation und Folgen, Fokus auf «Abbrechen», ohne Papierkorb', async () => {
    let members = [ANNA, NORA];
    setup(own(), {
      'GET /v1/admin/members': () => json({ items: members }),
      [`DELETE /v1/admin/members/${NORA.id}`]: () => { members = [ANNA]; return json({ accountDeleted: false }); },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Mehr zu Nora Neu' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Einladung zurückziehen …' }));
    const c = await screen.findByRole('alertdialog', { name: 'Einladung an Nora Neu zu «Demo AG» zurückziehen?' });
    expect(c).toHaveTextContent(/nie angenommen/);
    expect(c).toHaveTextContent(/Link darin wird ungültig/);
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    expect(within(c).getByRole('button', { name: 'Einladung zurückziehen' }).querySelector('svg')).toBeNull();
    await userEvent.click(within(c).getByRole('button', { name: 'Einladung zurückziehen' }));
    expect(await screen.findByText('Einladung von Nora Neu zu «Demo AG» zurückgezogen')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('nora@demo.example')).toBeNull());
  });

  it('Person entfernen nennt Organisation, Verzögerung, Konto und andere Mitgliedschaften; Enter auf «Abbrechen» ändert nichts', async () => {
    const { calls } = setup(own(), { 'GET /v1/admin/members': () => json({ items: [ANNA, CARLA] }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Mehr zu Carla Check' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Person entfernen …' }));
    const c = await screen.findByRole('alertdialog', { name: 'Carla Check aus «Demo AG» entfernen?' });
    expect(c).toHaveTextContent('Carla Check verliert Rollen, Freigaben an allen Orten und den Zugang zu «Demo AG» – sofort; bestehende Anmeldungen enden spätestens nach 5 Minuten. Das Anmeldekonto und Mitgliedschaften in anderen Organisationen bleiben unverändert.');
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.some(x => x.method === 'DELETE')).toBe(false);
  });
});

describe('Einladen', () => {
  it('lädt eine Person zur Organisation ein; org-admin nur durch die Plattform, Hinweis dazu genau einmal; Prüfung beim Absenden', async () => {
    const { calls } = setup(own(), {
      'GET /v1/admin/members': () => json({ items: [ANNA] }),
      'POST /v1/admin/members': () => json({ result: 'invitation-sent', emailSent: false, member: { ...NORA, roles: ['viewer', 'editor'] } }, 202),
    });
    await screen.findByRole('table', { name: /^Mitglieder/ });
    await userEvent.click(screen.getByRole('button', { name: 'Person einladen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Person zu «Demo AG» einladen' });
    expect(dlg).toHaveTextContent('Keycloak sendet eine Einladung zu «Demo AG»');
    await waitFor(() => expect(within(dlg).getByRole('textbox', { name: 'E-Mail' })).toHaveFocus());
    expect(within(dlg).queryByText('Rollen vergleichen')).toBeNull();
    // org-admin: kein (gesperrtes) Kontrollkästchen, sondern gekennzeichnete Zeile
    expect(within(dlg).queryByRole('checkbox', { name: 'Organisations-Admin' })).toBeNull();
    expect(within(dlg).getByText('Organisations-Admin', { selector: '.iam-rp-l' }).closest('li')).toHaveTextContent(/vergibt nur die Plattform-Administration/);
    expect(dlg.textContent!.match(/Plattform-Administration/g)).toHaveLength(1);
    for (const c of within(dlg).getAllByRole('checkbox')) expect(c).toBeEnabled();
    // Vorgabe: die Rolle mit den wenigsten Rechten
    expect(within(dlg).getByRole('checkbox', { name: 'Leser:in' })).toBeChecked();
    expect(await within(dlg).findByText(`Darf 2 von ${N}`)).toBeInTheDocument();
    expect(dlg).not.toHaveTextContent('gegenüber bisher');
    // Formulardialog: Klick auf den Hintergrund schliesst nicht
    fireEvent.mouseDown(dlg.parentElement!);
    expect(screen.getByRole('dialog', { name: 'Person zu «Demo AG» einladen' })).toBeInTheDocument();
    // ungültige Adresse: Fehler am Feld, Fokus dort, kein Aufruf
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'E-Mail' }), 'nora');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Einladen' }));
    expect(within(dlg).getByRole('textbox', { name: 'E-Mail' })).toHaveAttribute('aria-invalid', 'true');
    expect(within(dlg).getByRole('textbox', { name: 'E-Mail' })).toHaveFocus();
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'E-Mail' }), '@demo.example');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Bearbeiter:in' }));
    expect(within(dlg).getByText(`Darf 4 von ${N}`)).toBeInTheDocument();
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Einladen' }));
    const done = await screen.findByRole('dialog', { name: 'Einladung erfasst' });
    expect(done).toHaveTextContent('Nora Neu ist zu «Demo AG» eingeladen mit den Rollen Leser:in, Bearbeiter:in');
    expect(within(done).getByRole('alert')).toHaveTextContent(/«Mehr» › «Einladung erneut senden»/);
    const post = calls.find(c => c.method === 'POST')!;
    expect(await post.clone().json()).toEqual({ email: 'nora@demo.example', roles: ['viewer', 'editor'] });
    expect(post.headers.get('X-CSRF-Token')).toBe('csrf-123');
  });

  it('Vorgabe der App (`inviteRoles`) statt der Rolle mit den wenigsten Rechten', async () => {
    const api = mockIamApi({ 'GET /v1/admin/status': () => json(STATUS), 'GET /v1/admin/members': () => json({ items: [ANNA] }) });
    vi.stubGlobal('fetch', api.fetch);
    render(<StaticIam me={ADMIN_ME} config={{ inviteRoles: ['editor', 'gibt-es-nicht'] }}>{own()}</StaticIam>);
    await userEvent.click(await screen.findByRole('button', { name: 'Person einladen' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByRole('checkbox', { name: 'Bearbeiter:in' })).toBeChecked();
    expect(within(dlg).queryByRole('checkbox', { name: 'Leser:in' })).toBeNull(); // in Bearbeiter:in enthalten
    expect(within(dlg).getByText('Leser:in', { selector: '.iam-rp-l' }).closest('li')).toHaveTextContent('in Bearbeiter:in enthalten');
  });

  it('mit Versand: Meldung mit Organisation und Adresse, Dialog zu, Liste neu geladen', async () => {
    let items = [ANNA];
    setup(own(), {
      'GET /v1/admin/members': () => json({ items }),
      'POST /v1/admin/members': () => { items = [ANNA, NORA]; return json({ result: 'invitation-sent', emailSent: true, member: NORA }, 202); },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Person einladen' }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'E-Mail' }), 'nora@demo.example{Enter}');
    expect(await screen.findByText('Einladung zu «Demo AG» an nora@demo.example versendet')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Nora Neu')).toBeInTheDocument();
  });
});

describe('Review #18: Vorgaben, Cache, letzte Admin-Person', () => {
  const invite = async (ui: ReactElement, extra: Partial<IamConfig> = {}) => {
    const api = mockIamApi({ 'GET /v1/admin/status': () => json(STATUS), 'GET /v1/admin/members': () => json({ items: [ANNA] }), 'GET /v1/platform/organizations/muster/members': () => json({ items: [ANNA] }) });
    vi.stubGlobal('fetch', api.fetch);
    render(<StaticIam me={ADMIN_ME} config={extra}>{ui}</StaticIam>);
    await userEvent.click(await screen.findByRole('button', { name: 'Person einladen' }));
    return screen.findByRole('dialog');
  };

  it('inviteRoles mit org-admin: ausserhalb der Plattformansicht nicht vorgewählt (sonst 403), in der Plattformansicht schon', async () => {
    const config = { inviteRoles: ['org-admin', 'editor'] };
    const dlg = await invite(own(), config);
    expect(within(dlg).getByRole('checkbox', { name: 'Bearbeiter:in' })).toBeChecked();
    expect(within(dlg).queryByText('Enthält alle anderen Rollen.')).toBeNull();
    cleanup();
    const p = await invite(platformList(), config);
    expect(within(p).getByRole('checkbox', { name: 'Organisations-Admin' })).toBeChecked();
  });

  it('nach dem Speichern: alle Mitgliederlisten neu geladen; eine aus dem Modell entfernte Rolle wird nicht mitgeschickt', async () => {
    const GONE = { ...CARLA, roles: ['editor', 'alt'] };
    const { calls } = setup(own(), {
      'GET /v1/admin/members': () => json({ items: [ANNA, GONE] }),
      [`PUT /v1/admin/members/${CARLA.id}/roles`]: () => json({ ...CARLA, roles: ['editor', 'viewer'] }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Rollen von Carla Check bearbeiten' }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Prüfer:in' }));
    const before = calls.filter(c => c.method === 'GET' && c.url.endsWith('/v1/admin/members')).length;
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await calls.find(c => c.method === 'PUT')!.clone().json()).toEqual({ roles: ['editor', 'auditor'] });
    await waitFor(() => expect(calls.filter(c => c.method === 'GET' && c.url.endsWith('/v1/admin/members')).length).toBeGreaterThan(before));
  });

  it('deaktiviertes Konto mit org-admin ohne weitere aktive Admin-Person: Entfernen gesperrt (Plattform)', async () => {
    const items = [{ ...ERIK, roles: ['org-admin'] }, CARLA];
    setup(platformList(), { 'GET /v1/platform/organizations/muster/members': () => json({ items }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Mehr zu Erik Extern' }));
    const item = within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Person entfernen …' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAccessibleDescription(/^Letzter Organisations-Admin/);
  });
});

describe('Clients, Freigabestufe, Orte, niemand gibt mehr, als er hat', () => {
  it('Client freigeben: Client-ID, Rollen (mindestens eine), Freigabestufe; PUT mit allen Feldern', async () => {
    let items: Member[] = [ANNA];
    const { calls } = setup(<MembersScreen />, {
      'GET /v1/admin/members': () => json({ items }),
      'PUT /v1/admin/clients/notiz-import': () => { items = [ANNA, SYNC]; return json({ clientId: 'notiz-import', principalId: 'ps9', description: 'Import', roles: ['viewer'], clearance: 1, places: 0, createdAt: ago(0), createdBy: 'Anna Admin', lastUsedAt: null, lastScopes: null }); },
    });
    await screen.findByRole('table', { name: /^Mitglieder/ });
    await userEvent.click(screen.getByRole('button', { name: 'Client freigeben' }));
    const dlg = await screen.findByRole('dialog', { name: 'Maschinen-Client für «Demo AG» freigeben' });
    await waitFor(() => expect(within(dlg).getByRole('textbox', { name: 'Client-ID' })).toHaveFocus());
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    expect(within(dlg).getByRole('textbox', { name: 'Client-ID' })).toHaveAttribute('aria-invalid', 'true');
    expect(within(dlg).getByRole('alert')).toHaveTextContent('Mindestens eine Rolle wählen');
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Client-ID' }), 'notiz-import');
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Beschreibung' }), 'Import');
    // Freigabestufe höchstens die eigene (ME: vertraulich)
    const level = within(dlg).getByRole('combobox', { name: 'Freigabestufe' });
    expect(within(level).getByRole('option', { name: /^streng vertraulich/ })).toBeDisabled();
    await userEvent.selectOptions(level, '1');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Leser:in' }));
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    expect(await screen.findByText('«notiz-import» für «Demo AG» freigegeben')).toBeInTheDocument();
    expect(await calls.find(c => c.method === 'PUT')!.clone().json()).toEqual({ roles: ['viewer'], description: 'Import', clearance: 1 });
  });

  it('Rollen eines Clients: Dialog mit Beschreibung aus der Liste; Freigabestufe ohne Beschreibung (bleibt); Freigabe entziehen über «Mehr»', async () => {
    const { calls } = setup(own(), {
      'GET /v1/admin/members': () => json({ items: [ANNA, { ...SYNC, description: 'Nächtlicher Import' }] }),
      'PUT /v1/admin/clients/notiz-import': () => json({}),
      'DELETE /v1/admin/clients/notiz-import': () => new Response(null, { status: 204 }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Rollen von notiz-import bearbeiten' }));
    const dlg = await screen.findByRole('dialog', { name: 'Rollen von notiz-import in «Demo AG»' });
    expect(within(dlg).getByRole('textbox', { name: 'Client-ID' })).toHaveAttribute('readonly');
    await waitFor(() => expect(within(dlg).getByRole('textbox', { name: 'Beschreibung' })).toHaveValue('Nächtlicher Import'));
    // Rechte-Übersicht mit den Scopes des letzten Tokens: erlaubt ist nur Rolle ∧ Scope
    expect(await within(dlg).findByText(/nur mit Scope/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Prüfer:in' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await calls.find(c => c.method === 'PUT')!.clone().json()).toEqual({ roles: ['editor', 'auditor'], description: 'Nächtlicher Import', clearance: 0 });
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zu notiz-import' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Freigabestufe setzen …' }));
    const lvl = await screen.findByRole('dialog', { name: 'Freigabestufe von notiz-import in «Demo AG»' });
    await userEvent.selectOptions(within(lvl).getByRole('combobox', { name: 'Freigabestufe' }), '1');
    await userEvent.click(within(lvl).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(calls.filter(c => c.method === 'PUT')).toHaveLength(2));
    expect(await calls.filter(c => c.method === 'PUT')[1]!.clone().json()).toEqual({ roles: ['editor'], clearance: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zu notiz-import' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Freigabe entziehen …' }));
    const c = await screen.findByRole('alertdialog', { name: 'Freigabe für «notiz-import» in «Demo AG» entziehen?' });
    await userEvent.click(within(c).getByRole('button', { name: 'Entziehen' }));
    expect(await screen.findByText('Freigabe für «notiz-import» in «Demo AG» entzogen')).toBeInTheDocument();
  });

  it('Freigabestufe: nie die eigene (gesperrt mit Grund), höchstens die eigene; PUT …/clearance', async () => {
    const { calls } = setup(own(), {
      'GET /v1/admin/members': () => json({ items: [ANNA, CARLA, { ...ERIK, clearance: 2 }] }),
      [`PUT /v1/admin/members/${CARLA.id}/clearance`]: () => json({ ...CARLA, clearance: 1 }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Mehr zu Anna Admin' }));
    const self = within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Freigabestufe setzen …' });
    expect(self).toHaveAttribute('aria-disabled', 'true');
    expect(self).toHaveAccessibleDescription('Deine eigene Freigabestufe setzt jemand anderes.');
    await userEvent.keyboard('{Escape}');
    // Bisherige Stufe über der eigenen: so gesperrt mit Grund, senken geht
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zu Erik Extern' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Freigabestufe setzen …' }));
    let dlg = await screen.findByRole('dialog', { name: 'Freigabestufe von Erik Extern in «Demo AG»' });
    expect(within(dlg).getByRole('alert')).toHaveTextContent('übersteigt deine eigene «vertraulich»');
    expect(within(dlg).getByRole('button', { name: 'Speichern' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Freigabestufe' }), '1');
    expect(within(dlg).queryByRole('alert')).toBeNull();
    expect(within(dlg).getByRole('button', { name: 'Speichern' })).not.toHaveAttribute('aria-disabled');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Abbrechen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zu Carla Check' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Freigabestufe setzen …' }));
    dlg = await screen.findByRole('dialog', { name: 'Freigabestufe von Carla Check in «Demo AG»' });
    const level = within(dlg).getByRole('combobox', { name: 'Freigabestufe' });
    expect(level).toHaveValue('0');
    expect(within(level).getByRole('option', { name: /^streng vertraulich – über deiner Freigabestufe$/ })).toBeDisabled();
    await userEvent.selectOptions(level, '1');
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Freigabestufe von Carla Check in «Demo AG»: «vertraulich»')).toBeInTheDocument();
    expect(await calls.find(c => c.method === 'PUT')!.clone().json()).toEqual({ clearance: 1 });
  });

  it('«+n Orte»: Klick zeigt die Orte mit Rolle und Ablauf (GET /v1/access?subject=user:<id>), Pfeil öffnet den Ort', async () => {
    const open = vi.fn();
    const api = mockIamApi({
      'GET /v1/admin/status': () => json(STATUS),
      'GET /v1/admin/members': () => json({ items: [ANNA, { ...CARLA, places: 2 }] }),
      'GET /v1/access': () => json({ items: [
        { id: 't1', subject: { ref: `user:${CARLA.principalId}`, kind: 'user', name: 'Carla Check' }, relation: 'editor', place: { type: 'folder', id: 'f1' }, via: 'direct', expiresAt: null, createdAt: null, createdBy: null, removable: true },
        { id: 't2', subject: { ref: `user:${CARLA.principalId}`, kind: 'user', name: 'Carla Check' }, relation: 'viewer', place: { type: 'note', id: 'n1' }, via: 'direct', expiresAt: '2030-06-30T21:59:59.000Z', createdAt: null, createdBy: null, removable: true },
      ] }),
    });
    vi.stubGlobal('fetch', api.fetch);
    const { staticResources } = await import('../src/testing/index.tsx');
    render(<StaticIam me={ADMIN_ME} config={{ resources: staticResources({ folder: { f1: 'Projekte' } }, { open }) }}>{own()}</StaticIam>);
    const table = await screen.findByRole('table', { name: /^Mitglieder/ });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('–');
    await userEvent.click(within(table).getByRole('button', { name: /^\+2 Orte ?, Orte von Carla Check anzeigen$/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Orte von Carla Check in «Demo AG»' });
    const rows = within(await within(dlg).findByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map(r => r.textContent)).toEqual([expect.stringMatching(/^Ordner «Projekte»Rolle:Bearbeiter:inBis:–/), expect.stringMatching(/^Notiz \(nicht sichtbar\)Rolle:Leser:inBis:30\.06\.2030/)]);
    expect(new URL(api.calls.find(c => new URL(c.url).pathname === '/v1/access')!.url).searchParams.get('subject')).toBe(`user:${CARLA.principalId}`);
    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Zu Ordner «Projekte»' }));
    expect(open).toHaveBeenCalledWith({ type: 'folder', id: 'f1' });
    expect(await axeProblems(dlg)).toEqual([]);
  });

  it('ohne features.access keine Spalte «Orte»; in der Plattformansicht auch nicht (nur Rollen an der Organisation)', async () => {
    const api = mockIamApi({ 'GET /v1/admin/status': () => json({ ...STATUS, platformAdmin: true }), 'GET /v1/admin/members': () => json({ items: [ANNA] }), 'GET /v1/platform/organizations/muster/members': () => json({ items: [{ ...CARLA, places: 3 }] }) });
    vi.stubGlobal('fetch', api.fetch);
    const { unmount } = render(<StaticIam me={ADMIN_ME} config={{ features: { access: false } }}>{own()}</StaticIam>);
    const table = await screen.findByRole('table', { name: /^Mitglieder/ });
    expect(within(table).queryByRole('columnheader', { name: 'Orte' })).toBeNull();
    unmount();
    render(<StaticIam me={ADMIN_ME}>{platformList()}</StaticIam>);
    const t2 = await screen.findByRole('table', { name: 'Mitglieder von Muster GmbH mit Rollen' });
    expect(within(t2).queryByRole('columnheader', { name: 'Orte' })).toBeNull();
    expect(t2).not.toHaveTextContent('+3 Orte');
  });

  it('niemand gibt mehr, als er hat: Rollen mit Rechten, die ich nicht habe, gesperrt mit Grund; 403 exceeds-own mit fehlenden Rechten', async () => {
    const me: Partial<Me> = { ...ADMIN_ME, roles: ['viewer'], permissions: ['tenant:read', 'note:read', 'members:admin'] };
    setup(own(), {
      'GET /v1/admin/members': () => json({ items: [ANNA, { ...CARLA, roles: ['editor'] }, { ...ERIK, roles: [] }] }),
      [`PUT /v1/admin/members/${ERIK.id}/roles`]: () => json({ title: 'Verboten', status: 403, reason: 'exceeds-own', missing: ['note:write'] }, 403),
    }, me);
    await userEvent.click(await screen.findByRole('button', { name: 'Rollen von Carla Check bearbeiten' }));
    let dlg = await screen.findByRole('dialog');
    const editor = within(dlg).getByRole('checkbox', { name: 'Bearbeiter:in' });
    expect(editor).toBeDisabled();
    expect(editor).toBeChecked();
    expect(editor).toHaveAccessibleDescription(/gesperrt – dir fehlen «Notizen ändern» und «Zugriff verwalten»/);
    expect(within(dlg).getByText('Leser:in', { selector: '.iam-rp-l' }).closest('li')).toHaveTextContent('in Bearbeiter:in enthalten');
    expect(within(dlg).getByRole('checkbox', { name: 'Prüfer:in' })).toBeDisabled();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Abbrechen' }));
    // Der Server lehnt trotzdem ab (z. B. veraltete Rechte): Grund mit Labels im Dialog
    await userEvent.click(screen.getByRole('button', { name: 'Rollen von Erik Extern bearbeiten' }));
    dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Leser:in' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Niemand gibt mehr, als er hat: Dir fehlen hier «Notizen ändern».');
  });
});

describe('Enthaltensein', () => {
  it('folgt aus den Rechten: Leser:in in Bearbeiter:in und Ordner-Admin; alles in Organisations-Admin', () => {
    const map = containers(ROLES);
    expect(map.get('viewer')).toEqual(['org-admin', 'folder-admin', 'editor']);
    expect(map.get('editor')).toEqual(['org-admin', 'folder-admin']);
    expect(map.get('auditor')).toEqual(['org-admin']);
    expect(map.get('org-admin')).toEqual([]);
    // Rollen ohne Rechte gelten nie als enthalten
    expect(containers([{ ...ROLES[2]!, permissions: [] }, ROLES[0]!]).get('editor')).toEqual([]);
  });
});
