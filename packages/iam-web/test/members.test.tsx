/**
 * Mitglieder: Liste (Status, Rollen, Filter nach Name, Rolle und Recht, Sortierung, einzeilige Aktionen mit Menü «Mehr»,
 * gesperrte Aktionen mit Grund), Einladen mit Rollen, Rückfragen mit Organisation und Folgen, abgeschaltete Verwaltung,
 * Enthaltensein aus den Rechten. Aus vollholz/assets `web/src/features/admin.test.tsx` (Mitglieder und Rollen) und
 * `features/admin/members.test.tsx`, produktneutral (Notiz-App).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { containers, type Me, type Member, type RoleInfo } from '../src/index.ts';
import { MemberList, MembersScreen } from '../src/pages/index.ts';
import { CATALOG, json, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => vi.unstubAllGlobals());

const ROLES: RoleInfo[] = CATALOG.roles;
const N = CATALOG.permissions.length;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const m = (id: string, name: string, roles: string[], o: Partial<Member> = {}): Member => ({
  id: `00000000-0000-4000-8000-0000000000${id}`, principalId: `p${id}`, username: name.split(' ')[0]!.toLowerCase(), name,
  email: `${name.split(' ')[0]!.toLowerCase()}@demo.example`, status: 'active', roles, lastSeenAt: ago(1), createdAt: null, loginPath: null, ...o,
});
const ANNA = m('a1', 'Anna Admin', ['org-admin'], { lastSeenAt: ago(0) });
const NORA = m('b2', 'Nora Neu', ['viewer'], { principalId: null, username: 'nora@demo.example', status: 'invited', lastSeenAt: null, createdAt: ago(3) });
const CARLA = m('c3', 'Carla Check', ['editor', 'viewer'], { lastSeenAt: ago(2) });
const OSKAR = m('d4', 'Oskar Org', ['org-admin'], { lastSeenAt: ago(5) });
const ERIK = m('e5', 'Erik Extern', ['viewer'], { email: 'erik@partner.example', status: 'disabled', lastSeenAt: null });
const STATUS = { enabled: true, reason: null, organization: 'demo', platformAdmin: false, canManageMembers: true, rolesManageable: true, roles: ROLES };
const ADMIN_ME: Partial<Me> = { person: { subject: ANNA.id, name: 'Anna Admin', email: 'anna@demo.example' } };

function setup(ui: ReactElement, routes: Record<string, MockHandler> = {}, me: Partial<Me> = ADMIN_ME) {
  const api = mockIamApi(routes);
  vi.stubGlobal('fetch', api.fetch);
  const r = render(<StaticIam me={me}>{ui}</StaticIam>);
  return { ...api, ...r };
}
const own = (o: { rolesManageable?: boolean } = {}) => <MemberList alias={null} roles={ROLES} platform={false} rolesManageable={o.rolesManageable ?? true} self={ANNA.id} orgLabel="Demo AG" />;
const names = (table: HTMLElement) => within(table).getAllByRole('row').slice(1).map(r => r.querySelector('.iam-b')!.firstChild!.textContent);

describe('Seite Mitglieder', () => {
  it('ohne Recht: «Recht fehlt» statt Liste; abgeschaltet: klarer Hinweis, Technik nur unter «Technische Details»', async () => {
    const off = { 'GET /v1/admin/status': () => json({ ...STATUS, enabled: false, reason: 'Die Verwaltung ist nicht eingerichtet (KEYCLOAK_MGMT_CLIENT_ID).' }) };
    const { unmount, calls } = setup(<MembersScreen />, off, { roles: ['viewer'], permissions: ['tenant:read', 'note:read'] });
    expect(await screen.findByText('Recht fehlt')).toBeInTheDocument();
    expect(calls.some(c => c.url.includes('/v1/admin/'))).toBe(false);
    unmount();
    setup(<MembersScreen />, off);
    expect(await screen.findByText('Verwaltung nicht eingerichtet')).toBeInTheDocument();
    expect(screen.getByText(/KEYCLOAK_MGMT_CLIENT_ID/)).toBeInTheDocument();
    expect(screen.getByText(/verwaltet die Plattform-Administration Mitglieder und Rollen in Keycloak\./)).not.toHaveTextContent('/orgs/');
    expect(screen.getByText('/orgs/demo/<rolle>').closest('details')).not.toHaveAttribute('open');
    expect(screen.queryByRole('button', { name: 'Person einladen' })).toBeNull();
  });

  it('listet Mitglieder mit Status, Rollen und «Zuletzt aktiv»; Hauptaktion im Seitenkopf; Name der Organisation', async () => {
    setup(<MembersScreen />, { 'GET /v1/admin/status': () => json(STATUS), 'GET /v1/admin/members': () => json({ items: [ANNA, NORA, ERIK] }) });
    const table = await screen.findByRole('table', { name: 'Mitglieder von Demo AG mit Rollen' });
    expect(screen.getByText(/Wer in «Demo AG» arbeitet/)).toBeInTheDocument();
    // Hauptaktion im Kopf der Seite (AdminHead), nicht im Abschnitt
    const head = screen.getByRole('heading', { level: 1, name: 'Mitglieder' }).closest('.iam-mh') as HTMLElement;
    expect(within(head).getByRole('button', { name: 'Person einladen' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Person einladen' })).toHaveLength(1);
    expect(screen.getByText('3 Personen, davon 1 eingeladen')).toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader').map(c => c.textContent)).toEqual(['Person', 'Status', 'Rollen', 'Zuletzt aktiv', 'Aktionen']);
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
    expect(screen.getByText(/Nur eine Person hat die Rolle «Organisations-Admin»/)).toBeInTheDocument();
    const box = screen.getByRole('searchbox', { name: 'Mitglieder filtern' });
    expect(box).toHaveAttribute('placeholder', 'Name oder E-Mail filtern');
    await userEvent.type(box, 'nora');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    await userEvent.clear(box);
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

  it('«Wer hat Recht X?»: Rechte gruppiert aus dem Katalog, Treffer über die Rollen, Hinweis auf Zugriffsregeln', async () => {
    const table = await list();
    const perm = screen.getByRole('combobox', { name: /^Recht:/ });
    await screen.findByRole('option', { name: 'Notizen ändern' });
    expect(perm.querySelector('optgroup[label="Notizen"]')).not.toBeNull();
    expect(screen.queryByText(/Zugriffsregel/)).toBeNull();
    await userEvent.selectOptions(perm, 'note:write');
    expect(names(table)).toEqual(['Anna Admin', 'Erik']);
    expect(screen.getByText(/Einschränkungen per Zugriffsregel sind hier nicht berücksichtigt/)).toHaveTextContent('«Notizen ändern»');
    await userEvent.selectOptions(perm, 'members:admin');
    expect(names(table)).toEqual(['Anna Admin']);
    // Rolle und Recht kombiniert, ohne Treffer: leerer Zustand mit «Filter zurücksetzen»
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^Rolle:/ }), 'viewer');
    expect(await screen.findByText('Keine Person passt zu den gewählten Filtern.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Filter zurücksetzen' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(perm).toHaveValue('');
  });

  it('sortiert nach Person und «Zuletzt aktiv» (aria-sort), Standard in der Reihenfolge der API', async () => {
    const table = await list();
    const person = within(table).getByRole('columnheader', { name: 'Person' });
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
    expect(within(menu).getAllByRole('menuitem').map(i => i.getAttribute('aria-label'))).toEqual(['Einladung erneut senden', 'Einladung zurückziehen …']);
    expect(within(menu).getByRole('menuitem', { name: 'Einladung erneut senden' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(more).toHaveFocus();
    await userEvent.click(more);
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Einladung erneut senden' }));
    expect(await screen.findByText('Einladung zu «Demo AG» an nora@demo.example erneut gesendet')).toBeInTheDocument();
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/invitation'))).toBe(true);
    // aktive Person: nur «Person entfernen …», frei
    await userEvent.click(within(carla).getByRole('button', { name: 'Mehr zu Carla Check' }));
    const items = within(await screen.findByRole('menu')).getAllByRole('menuitem');
    expect(items.map(i => i.getAttribute('aria-label'))).toEqual(['Person entfernen …']);
    expect(items[0]).not.toHaveAttribute('aria-disabled');
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
    const platform = () => <MemberList alias="muster" roles={ROLES} platform rolesManageable self="sub-plattform" orgLabel="Muster GmbH" />;
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
    expect(c).toHaveTextContent('Carla Check verliert Rollen und Zugang zu «Demo AG» – sofort hier, auf allen Servern spätestens nach 5 Minuten. Das Anmeldekonto und Mitgliedschaften in anderen Organisationen bleiben unverändert.');
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
    expect(within(dlg).getByText(`Darf 3 von ${N}`)).toBeInTheDocument();
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Einladen' }));
    const done = await screen.findByRole('dialog', { name: 'Einladung erfasst' });
    expect(done).toHaveTextContent('Nora Neu ist zu «Demo AG» eingeladen mit den Rollen Leser:in, Bearbeiter:in');
    expect(within(done).getByRole('alert')).toHaveTextContent(/«Mehr» › «Einladung erneut senden»/);
    const post = calls.find(c => c.method === 'POST')!;
    expect(await post.clone().json()).toEqual({ email: 'nora@demo.example', roles: ['viewer', 'editor'] });
    expect(post.headers.get('X-CSRF-Token')).toBe('csrf-123');
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
