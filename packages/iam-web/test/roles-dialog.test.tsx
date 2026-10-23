/**
 * Rollendialog: Ansehen ohne Formular (Rollen als Karten, Rechte-Übersicht, «Rollen vergleichen» eingeklappt), kompakte
 * Rollenauswahl (eine Zeile je Rolle, Beschreibung ungekürzt, «in … enthalten» als Markierung, Organisations-Admin als
 * eine Zeile, Gruppen aus `roleGroups`), Rechte-Übersicht mit «+ n Rechte, − m Rechte», Bestätigung kritischer
 * Änderungen. Aus vollholz/assets `web/src/features/admin/roles-dialog.test.tsx` und den Fällen zum Rollendialog in
 * `features/admin.test.tsx`, produktneutral (Notiz-App).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { roleSummary, type IamConfig, type Member, type RoleInfo } from '../src/index.ts';
import { MemberList, RolePicker } from '../src/pages/index.ts';
import { CATALOG, json, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => vi.unstubAllGlobals());

const ROLES: RoleInfo[] = CATALOG.roles;
const role = (k: string) => ROLES.find(r => r.key === k)!;
const label = (p: string) => CATALOG.permissions.find(x => x.key === p)!.label;
const union = (...keys: string[]) => new Set(keys.flatMap(k => role(k).permissions));
const N = CATALOG.permissions.length;
const m = (id: string, name: string, roles: string[]): Member => ({
  id: `00000000-0000-4000-8000-0000000000${id}`, kind: 'user', principalId: `p${id}`, username: name.toLowerCase(), name, email: `${name.toLowerCase()}@demo.example`,
  status: 'active', roles, clearance: 0, breakGlassUntil: null, places: 0, lastSeenAt: null, createdAt: null, loginPath: null, clientId: null, scopes: null,
});
const STATUS = { enabled: true, reason: null, organization: 'demo', platformAdmin: true, canManageMembers: true, roles: ROLES };
const ANNA = m('a1', 'Anna', ['org-admin']);
const OSKAR = m('d4', 'Oskar', ['org-admin']);
const CARLA = m('c3', 'Carla', ['editor', 'viewer']);
const ME = { person: { subject: ANNA.id, name: 'Anna', email: 'anna@demo.example' } };

function renderIam(ui: ReactElement, routes: Record<string, MockHandler> = {}, config?: Partial<IamConfig>) {
  const api = mockIamApi({ 'GET /v1/admin/status': () => json(STATUS), ...routes });
  vi.stubGlobal('fetch', api.fetch);
  return { ...api, ...render(<StaticIam me={ME} config={config}>{ui}</StaticIam>) };
}
function setup(o: { platform?: boolean; routes?: Record<string, MockHandler> } = {}) {
  const base = o.platform ? '/v1/platform/organizations/demo/members' : '/v1/admin/members';
  return renderIam(o.platform ? <MemberList alias="demo" platform orgLabel="Demo AG" /> : <MemberList />,
    { [`GET ${base}`]: () => json({ items: [ANNA, OSKAR, CARLA] }), ...o.routes }).calls;
}
const open = async (name: string, verb: 'ansehen' | 'bearbeiten') => {
  await userEvent.click(await screen.findByRole('button', { name: `Rollen von ${name} ${verb}` }));
  return screen.findByRole('dialog', { name: `Rollen von ${name} in «Demo AG»` });
};

describe('Rollen ansehen ohne Formular', () => {
  it('Organisations-Admin: Rolle als Karte, «Alle Rechte» in einem Satz, «Rollen vergleichen» eingeklappt, nur «Schliessen»', async () => {
    const calls = setup();
    const dlg = await open('Oskar', 'ansehen');
    expect(within(dlg).getByRole('note')).toHaveTextContent('Die Rollen von Organisations-Admins ändert nur die Plattform-Administration.');
    expect(dlg.querySelector('input, select, textarea')).toBeNull();
    const card = within(within(dlg).getByRole('list', { name: 'Rollen von Oskar' })).getByRole('listitem');
    expect(card).toHaveClass('iam-card');
    expect(card).toHaveTextContent(`Organisations-Admin${roleSummary(role('org-admin').description)}`);
    expect(card).toHaveAttribute('title', role('org-admin').description);
    expect(await within(dlg).findByText(`Darf ${N} von ${N}`)).toBeInTheDocument();
    expect(within(dlg).getByText('Alle Rechte.')).toBeInTheDocument();
    const cmp = within(dlg).getByText('Rollen vergleichen').closest('details')!;
    expect(cmp).not.toHaveAttribute('open');
    expect(within(dlg).queryByRole('button', { name: 'Speichern' })).toBeNull();
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Schliessen' })).toHaveFocus());
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });
});

describe('Kompakte Rollenauswahl', () => {
  it('eine Zeile je Rolle mit ungekürzter Beschreibung; org-admin gekennzeichnet; enthaltene Rolle als Markierung; kein «Rollen vergleichen»', async () => {
    setup();
    const dlg = await open('Carla', 'bearbeiten');
    const row = (text: string) => within(dlg).getByText(text, { selector: '.iam-rp-l' }).closest('li')!;
    expect(within(dlg).getByRole('checkbox', { name: 'Bearbeiter:in' })).toHaveAccessibleDescription(role('editor').description);
    expect(within(dlg).queryByRole('checkbox', { name: 'Organisations-Admin' })).toBeNull();
    expect(row('Organisations-Admin')).toHaveTextContent('vergibt nur die Plattform-Administration');
    expect(dlg.textContent!.match(/Plattform-Administration/g)).toHaveLength(1);
    expect(within(dlg).getAllByRole('checkbox').filter(c => (c as HTMLInputElement).disabled)).toEqual([]);
    // ohne technische Schlüssel
    for (const key of ['org-admin', 'folder-admin', 'editor', 'viewer', 'auditor']) expect(dlg).not.toHaveTextContent(new RegExp(`\\b${key}\\b`));
    // Gruppen ohne Angabe der App: «Gesamte Organisation» und «Rollen»
    expect(within(dlg).getAllByRole('group').filter(g => g.tagName === 'FIELDSET').map(g => g.querySelector('legend')?.textContent)).toEqual(['Rollen', 'Gesamte Organisation', 'Rollen']);
    // Leser:in ist in Bearbeiter:in (gewählt) enthalten: Markierung, kein Kontrollkästchen
    expect(within(row('Leser:in')).getByText('in Bearbeiter:in enthalten')).toHaveClass('iam-rp-mark');
    expect(within(row('Leser:in')).queryByRole('checkbox')).toBeNull();
    expect(within(dlg).queryByText('Rollen vergleichen')).toBeNull();
    // Bearbeiter:in abwählen: Leser:in bleibt (eigene Auswahl), wieder als Kontrollkästchen
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Bearbeiter:in' }));
    expect(within(dlg).getByRole('checkbox', { name: 'Leser:in' })).toBeChecked();
    expect(row('Leser:in')).not.toHaveTextContent(/enthalten/);
    // Ordner-Admin enthält Bearbeiter:in und Leser:in
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Ordner-Admin' }));
    expect(row('Leser:in')).toHaveTextContent('in Ordner-Admin enthalten');
    expect(row('Bearbeiter:in')).toHaveTextContent('in Ordner-Admin enthalten');
    expect(await axeProblems(dlg)).toEqual([]);
  });

  it('Gruppen aus `roleGroups` der App (V3); übrige Rollen unter «Weitere»', async () => {
    const roleGroups = [{ key: 'work', label: 'Arbeit', roles: ['editor', 'viewer'] }, { key: 'control', label: 'Kontrolle', roles: ['auditor'] }];
    renderIam(<RolePicker roles={ROLES} value={new Set(['viewer'])} onChange={() => {}} platform idBase="g" />, {}, { roleGroups });
    expect(screen.getAllByRole('group').map(g => g.querySelector('legend')!.textContent)).toEqual(['Rollen', 'Arbeit', 'Kontrolle', 'Weitere']);
    expect([...screen.getByRole('group', { name: 'Arbeit' }).querySelectorAll('.iam-rp-l')].map(l => l.textContent)).toEqual(['Bearbeiter:in', 'Leser:in']);
    expect([...screen.getByRole('group', { name: 'Weitere' }).querySelectorAll('.iam-rp-l')].map(l => l.textContent)).toEqual(['Organisations-Admin', 'Ordner-Admin']);
  });

  it('Organisations-Admin gewählt: «Enthält alle anderen Rollen» statt der übrigen; gesperrt über «Rollen anzeigen»', async () => {
    const { unmount } = renderIam(<RolePicker roles={ROLES} value={new Set(['org-admin', 'editor'])} onChange={() => {}} platform idBase="p" />);
    expect(screen.getByRole('checkbox', { name: 'Organisations-Admin' })).toBeChecked();
    expect(screen.getByText('Enthält alle anderen Rollen.')).toBeInTheDocument();
    expect(screen.queryByText(/enthalten/)).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Bearbeiter:in' })).toBeNull();
    expect(screen.getAllByRole('group').map(g => g.querySelector('legend')!.textContent)).toEqual(['Rollen', 'Gesamte Organisation']);
    expect(screen.queryByRole('button', { name: 'Rollen anzeigen' })).toBeNull();
    unmount();
    renderIam(<RolePicker roles={ROLES} value={new Set(['org-admin'])} onChange={() => {}} platform={false} idBase="q" />);
    expect(screen.getByText('Enthält alle anderen Rollen.')).toBeInTheDocument();
    const show = screen.getByRole('button', { name: 'Rollen anzeigen' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(show);
    expect(screen.getByRole('button', { name: 'Rollen ausblenden' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Bearbeiter:in', { selector: '.iam-rp-l' }).closest('li')).toHaveTextContent('in Organisations-Admin enthalten');
  });
});

describe('Rechte mit Änderung gegenüber bisher', () => {
  it('«+ n Rechte, − m Rechte», Änderungen als Liste und in der Übersicht markiert; Speichern schickt die eigene Auswahl', async () => {
    const calls = setup({ routes: { [`PUT /v1/admin/members/${CARLA.id}/roles`]: () => json({ ...CARLA, roles: ['viewer', 'auditor'] }) } });
    const dlg = await open('Carla', 'bearbeiten');
    const before = union('editor', 'viewer');
    expect(await within(dlg).findByText('Rechte unverändert gegenüber bisher')).toBeInTheDocument();
    expect(within(dlg).getByText(`Darf ${before.size} von ${N}`)).toBeInTheDocument();
    expect(dlg.querySelector('.iam-rights-n')).toHaveTextContent('– Bearbeiter:in und Leser:in.');

    // Bearbeiter:in weg: nur noch Leser:in
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Bearbeiter:in' }));
    expect(within(dlg).getByText(`Darf ${union('viewer').size} von ${N}`)).toBeInTheDocument();
    expect(dlg.querySelector('.iam-rights-delta')).toHaveTextContent('+ 0 Rechte, − 2 Rechte gegenüber bisher');

    // Prüfer:in dazu
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Prüfer:in' }));
    const after = union('viewer', 'auditor');
    const keys = CATALOG.permissions.map(p => p.key);
    const add = keys.filter(p => after.has(p) && !before.has(p)), del = keys.filter(p => !after.has(p) && before.has(p));
    expect(add).toEqual(['audit:read']);
    expect(del).toEqual(['access:admin', 'note:write']);
    expect(dlg.querySelector('.iam-rights-delta')).toHaveTextContent('+ 1 Recht, − 2 Rechte gegenüber bisher');
    const list = within(dlg).getByRole('list', { name: /^Änderungen:/ });
    const items = (cls: string) => [...list.querySelectorAll(`li.${cls} .iam-rights-chg-l`)].map(e => e.textContent);
    expect(items('iam-is-add')).toEqual(add.map(label));
    expect(items('iam-is-del')).toEqual(del.map(label));
    const row = (name: string) => within(dlg).getByText(name, { selector: '.iam-rights-l' }).closest('li')!;
    expect(row(label('audit:read'))).toHaveClass('iam-is-add');
    expect(row(label('note:write'))).toHaveClass('iam-is-del');

    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await calls.find(c => c.method === 'PUT')!.clone().json()).toEqual({ roles: ['viewer', 'auditor'] });
    expect(await screen.findByText('Rollen von Carla in «Demo AG» gespeichert')).toBeInTheDocument();
  });

  it('ohne Änderung schliesst «Speichern» nur', async () => {
    const calls = setup();
    const dlg = await open('Carla', 'bearbeiten');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('kritische Änderung mit Bestätigung (Plattform), Fokus auf «Abbrechen», Fehler im Dialog', async () => {
    const calls = setup({
      platform: true,
      routes: { [`PUT /v1/platform/organizations/demo/members/${ANNA.id}/roles`]: () => json({ title: 'Konflikt', status: 409, detail: 'Die Organisation braucht mindestens eine Person mit der Rolle org-admin.' }, 409) },
    });
    const dlg = await open('Anna', 'bearbeiten');
    const admin = within(dlg).getByRole('checkbox', { name: 'Organisations-Admin' });
    expect(admin).toBeEnabled();
    expect(dlg).not.toHaveTextContent(/Plattform-Administration/);
    // Organisations-Admin gewählt: eine Zeile statt der übrigen Rollen
    expect(within(dlg).getByText('Enthält alle anderen Rollen.')).toBeInTheDocument();
    expect(within(dlg).queryByText('Leser:in', { selector: '.iam-rp-l' })).toBeNull();
    expect(within(dlg).queryByRole('button', { name: 'Rollen anzeigen' })).toBeNull();
    await userEvent.click(admin);
    expect(within(dlg).queryByText('Enthält alle anderen Rollen.')).toBeNull();
    expect(within(dlg).getByRole('checkbox', { name: 'Bearbeiter:in' })).not.toBeChecked();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Wichtige Änderung bestätigen' });
    expect(confirm).toHaveTextContent(/verliert die Rolle «Organisations-Admin» in «Demo AG»/);
    expect(confirm).toHaveTextContent('Ohne Rolle sieht Anna in «Demo AG» nichts mehr.');
    await waitFor(() => expect(within(confirm).getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    // nichts wird gelöscht: kein Papierkorb
    const go = within(confirm).getByRole('button', { name: 'Trotzdem speichern' });
    expect(go.querySelector('svg')).toBeNull();
    await userEvent.click(go);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(/mindestens eine Person/);
    expect(await calls.find(c => c.method === 'PUT')!.clone().json()).toEqual({ roles: [] });
  });
});

describe('Letzte Admin-Person und eigene Rechte (Plattform)', () => {
  const platform = (items: Member[], self?: string, routes: Record<string, MockHandler> = {}) => renderIam(
    <StaticIam me={{ person: { subject: self ?? 'sub-plattform', name: 'Pia', email: null } }}><MemberList alias="demo" platform orgLabel="Demo AG" /></StaticIam>,
    { 'GET /v1/platform/organizations/demo/members': () => json({ items }), ...routes }).calls;

  it('Entzug von org-admin bei der letzten aktiven Admin-Person: gesperrt mit Grund, kein Aufruf', async () => {
    const calls = platform([ANNA, CARLA]);
    const dlg = await open('Anna', 'bearbeiten');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Organisations-Admin' }));
    const alert = within(dlg).getByRole('alert');
    expect(alert).toHaveTextContent('Letzter Organisations-Admin – zuerst einer weiteren Person diese Rolle geben.');
    const save = within(dlg).getByRole('button', { name: 'Speichern' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(save);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('sich selbst «Mitglieder und Rollen verwalten» entziehen: Warnung in der Rückfrage', async () => {
    platform([ANNA, OSKAR], ANNA.id, { [`PUT /v1/platform/organizations/demo/members/${ANNA.id}/roles`]: () => json({ ...ANNA, roles: ['editor'] }) });
    const dlg = await open('Anna', 'bearbeiten');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Organisations-Admin' }));
    await userEvent.click(within(dlg).getByRole('checkbox', { name: 'Bearbeiter:in' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Wichtige Änderung bestätigen' });
    expect(confirm).toHaveTextContent('Du entziehst dir selbst «Mitglieder und Rollen verwalten» in «Demo AG».');
  });
});
