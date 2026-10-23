/**
 * Zugriff (Spezifikation 11.4): «Zugriff»-Seitenleiste (Wer, Rolle, Über mit Sprung zum Ursprung, Bis; geerbte nur am
 * Ursprung änderbar; «Für alle Mitglieder»; Vertraulichkeit), «Freigeben» (Person, Gruppe aus Entra ID, Alle Mitglieder;
 * nur `grantable`; Ablaufdatum), «Warum?» mit Break-Glass, Vertraulichkeit als Badge, Banner bei Break-Glass.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccessSheet, BreakGlassBanner, ClassificationBadge, GrantDialog, useBreakGlass, WhyDialog, type AccessEntry, type AccessList, type Explain, type IamConfig, type Me,
} from '../src/index.ts';
import { json, mockIamApi, StaticIam, staticResources, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const F1 = 'f1', N1 = 'n1';
const NOTE = { type: 'note', id: N1 };
const entry = (id: string | null, o: Partial<AccessEntry> = {}): AccessEntry => ({
  id, subject: { ref: 'user:p-anna', kind: 'user', name: 'Anna Muster' }, relation: 'editor', place: NOTE, via: 'direct',
  expiresAt: null, createdAt: null, createdBy: null, removable: true, ...o,
});
const LIST: AccessList = {
  resource: NOTE, classification: 1, grantable: ['editor', 'viewer'],
  items: [
    entry('t1', { expiresAt: '2026-12-31T22:59:59.000Z' }),
    entry('t2', { subject: { ref: 'user:p-peter', kind: 'user', name: 'Peter Meier' }, relation: 'viewer', removable: false }),
    entry('t3', { subject: { ref: 'user:p-paul', kind: 'user', name: 'Paul Leser' }, relation: 'viewer', place: { type: 'folder', id: F1 }, via: 'inherited', removable: false }),
    entry('t4', { subject: { ref: 'org:members', kind: 'members', name: 'Alle Mitglieder' }, relation: 'viewer', place: { type: 'org', id: null }, via: 'inherited', removable: false }),
    entry('t5', { subject: { ref: 'client:p-sync', kind: 'client', name: 'sync-1', scopes: ['notes:read'] }, relation: 'editor', place: { type: 'org', id: null }, via: 'inherited', removable: false }),
    entry(null, { subject: { ref: 'group:0f0e', kind: 'group', name: 'Abteilung X' }, relation: 'member', place: { type: 'folder', id: 'u1' }, via: 'scope', unit: { ref: { type: 'folder', id: 'u1' }, relation: 'gehört zu', grants: 'read' }, removable: false }),
  ],
};

function setup(ui: ReactElement, routes: Record<string, MockHandler> = {}, o: { me?: Partial<Me>; config?: Partial<IamConfig> } = {}) {
  const api = mockIamApi(routes);
  vi.stubGlobal('fetch', api.fetch);
  const r = render(<StaticIam me={o.me} config={o.config}>{ui}</StaticIam>);
  return { ...api, ...r };
}
const open = vi.fn();
const resources = staticResources({ folder: { [F1]: 'Projekte', u1: 'Abt X' }, note: { [N1]: 'Protokoll' } }, { open });
const sheet = (props: Partial<Parameters<typeof AccessSheet>[0]> = {}) => <AccessSheet resource={NOTE} label="Protokoll" open onClose={() => {}} {...props} />;

describe('AccessSheet', () => {
  it('Wer, Rolle, Über (Ort mit Name, Zuständigkeit), Bis; Pfeil zum Ursprung; Hauptaktion «Freigeben» im Kopf', async () => {
    open.mockClear();
    const { calls } = setup(sheet(), { 'GET /v1/access': () => json(LIST) }, { config: { resources } });
    const dlg = await screen.findByRole('dialog', { name: 'Zugriff auf «Protokoll»' });
    const table = await within(dlg).findByRole('table', { name: 'Wer hat Zugriff auf «Protokoll»' });
    const q = new URL(calls.find(c => new URL(c.url).pathname === '/v1/access')!.url).searchParams;
    expect([q.get('type'), q.get('id')]).toEqual(['note', N1]);
    expect(within(table).getAllByRole('columnheader').map(c => c.textContent)).toEqual(['Wer', 'Rolle', 'Über', 'Bis', 'Aktionen']);
    const rows = within(table).getAllByRole('row').slice(1);
    const cells = (i: number) => within(rows[i]!).getAllByRole('cell').slice(0, 4).map(c => c.textContent!.replace(/^(Rolle|Über|Bis):/, ''));
    expect(cells(0)).toEqual(['Anna Muster', 'Bearbeiter:in', 'direkt', '31.12.2026']);
    expect(cells(2)).toEqual(['Paul Leser', 'Leser:in', 'Ordner «Projekte»', '–']);
    expect(cells(3)).toEqual(['Alle Mitglieder', 'Leser:in', 'Organisation', '–']);
    expect(cells(4)).toEqual(['sync-1 (Client)Scope notes:read', 'Bearbeiter:in', 'Organisation', '–']);
    expect(cells(5)).toEqual(['Abteilung X (Gruppe)', 'Mitglied', 'Zuständigkeit: gehört zu Ordner «Abt X»', '–']);
    // geerbt: kein Menü, Hinweis für Screenreader, Pfeil zum Ursprung
    expect(within(rows[2]!).queryByRole('button', { name: /^Mehr zu/ })).toBeNull();
    expect(rows[2]).toHaveTextContent('Geerbt von Ordner «Projekte» – ändern nur dort.');
    await userEvent.click(within(rows[2]!).getByRole('button', { name: 'Zu Ordner «Projekte»' }));
    expect(open).toHaveBeenCalledWith({ type: 'folder', id: F1 });
    await userEvent.click(within(rows[5]!).getByRole('button', { name: 'Zu Ordner «Abt X»' }));
    expect(open).toHaveBeenLastCalledWith({ type: 'folder', id: 'u1' });
    expect(within(dlg).getByRole('button', { name: 'Freigeben' })).not.toHaveAttribute('aria-disabled');
    expect(dlg).toHaveTextContent('Freigaben wirken sofort.');
    expect(dlg).not.toHaveTextContent(/ACL|Zugriffsregel|Principal|Mandant/);
    expect(await axeProblems(dlg)).toEqual([]);
  });

  it('ohne resources: Typ «(nicht sichtbar)» statt Name, keine Pfeile', async () => {
    setup(sheet(), { 'GET /v1/access': () => json(LIST) });
    const table = await screen.findByRole('table');
    expect(table).toHaveTextContent('Ordner (nicht sichtbar)');
    expect(within(table).queryByRole('button', { name: /^Zu / })).toBeNull();
  });

  it('direkte Einträge: Ablauf ändern (PATCH) und entfernen (DELETE); ohne `removable` gesperrt mit Grund', async () => {
    let list = LIST;
    const { calls } = setup(sheet(), {
      'GET /v1/access': () => json(list),
      'PATCH /v1/access/t1': () => json(entry('t1', { expiresAt: '2030-06-30T21:59:59.000Z' })),
      'DELETE /v1/access/t1': () => { list = { ...LIST, items: LIST.items.slice(1) }; return new Response(null, { status: 204 }); },
    }, { config: { resources } });
    const dlg = await screen.findByRole('dialog', { name: 'Zugriff auf «Protokoll»' });
    await within(dlg).findByRole('table');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Mehr zu Peter Meier' }));
    const locked = within(await screen.findByRole('menu')).getAllByRole('menuitem');
    expect(locked.map(i => i.getAttribute('aria-disabled'))).toEqual(['true', 'true']);
    expect(locked[1]).toHaveAccessibleDescription(/Dafür brauchst du hier «Zugriff verwalten» und alle Rechte der Rolle\./);
    await userEvent.keyboard('{Escape}');
    // Ablauf ändern: Datum in der Vergangenheit am Feld abgelehnt
    await userEvent.click(within(dlg).getByRole('button', { name: 'Mehr zu Anna Muster' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Ablauf ändern …' }));
    const exp = await screen.findByRole('dialog', { name: 'Ablauf der Freigabe für Anna Muster' });
    const field = within(exp).getByLabelText('Gültig bis (optional)');
    expect(field).toHaveValue('2026-12-31');
    await userEvent.clear(field);
    await userEvent.type(field, '2020-01-01');
    await userEvent.click(within(exp).getByRole('button', { name: 'Speichern' }));
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(exp).toHaveTextContent('Das Datum muss in der Zukunft liegen.');
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
    await userEvent.clear(field);
    await userEvent.type(field, '2030-06-30');
    await userEvent.click(within(exp).getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Ablauf der Freigabe in «Demo AG» geändert')).toBeInTheDocument();
    const body = await calls.find(c => c.method === 'PATCH')!.clone().json() as { expiresAt: string };
    expect(new Date(body.expiresAt).getDate()).toBe(30);
    expect(new Date(body.expiresAt).getHours()).toBe(23);
    // Entfernen mit Rückfrage
    await userEvent.click(within(dlg).getByRole('button', { name: 'Mehr zu Anna Muster' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Freigabe entfernen …' }));
    const c = await screen.findByRole('alertdialog', { name: 'Freigabe in «Demo AG» entfernen?' });
    expect(c).toHaveTextContent('Anna Muster verliert die Rolle «Bearbeiter:in» an «Protokoll».');
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    await userEvent.click(within(c).getByRole('button', { name: 'Entfernen' }));
    expect(await screen.findByText('Freigabe in «Demo AG» entfernt')).toBeInTheDocument();
    await waitFor(() => expect(within(dlg).queryByText('Anna Muster')).toBeNull());
  });

  it('ohne `grantable`: «Freigeben» gesperrt mit Grund; 404: Hinweis wie überall', async () => {
    const { unmount } = setup(sheet(), { 'GET /v1/access': () => json({ ...LIST, grantable: [] }) });
    const btn = await screen.findByRole('button', { name: 'Freigeben' });
    await waitFor(() => expect(btn).toHaveAttribute('aria-disabled', 'true'));
    expect(btn).toHaveAccessibleDescription(/Freigeben ist gesperrt: Dafür brauchst du an diesem Ort das Recht «Zugriff verwalten»/);
    await userEvent.click(btn);
    expect(screen.queryByRole('dialog', { name: /freigeben$/ })).toBeNull();
    unmount();
    setup(sheet(), { 'GET /v1/access': () => json({ title: 'Nicht gefunden', status: 404 }, 404) });
    expect(await screen.findByText(/gelöscht, für dich nicht sichtbar oder in einer anderen Organisation/i)).toBeInTheDocument();
  });

  it('«Für alle Mitglieder» bei Typen mit Besitz und Rolle viewer: Schalter legt `org:members viewer` an bzw. entfernt sie', async () => {
    let list: AccessList = { ...LIST, items: [LIST.items[0]!] };
    const { calls } = setup(sheet(), {
      'GET /v1/access': () => json(list),
      'POST /v1/access': () => {
        const e = entry('t9', { subject: { ref: 'org:members', kind: 'members', name: 'Alle Mitglieder' }, relation: 'viewer' });
        list = { ...list, items: [...list.items, e] };
        return json(e, 201);
      },
      'DELETE /v1/access/t9': () => { list = { ...list, items: list.items.filter(e => e.id !== 't9') }; return new Response(null, { status: 204 }); },
    });
    const sw = await screen.findByRole('switch', { name: 'Für alle Mitglieder' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAccessibleDescription('Alle Personen in «Demo AG» erhalten an «Protokoll» die Rolle «Leser:in».');
    await userEvent.click(sw);
    expect(await screen.findByText('Für alle Mitglieder in «Demo AG» freigegeben')).toBeInTheDocument();
    expect(await calls.find(c => c.method === 'POST')!.clone().json()).toEqual({ subject: 'org:members', relation: 'viewer', type: 'note', id: N1 });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    // als Schalter, nicht noch einmal in der Tabelle
    expect(within(screen.getByRole('table')).queryByText('Alle Mitglieder')).toBeNull();
    await userEvent.click(sw);
    expect(await screen.findByText('Freigabe für alle Mitglieder in «Demo AG» entfernt')).toBeInTheDocument();
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
  });

  it('kein Schalter ohne Besitz am Typ; gesperrt mit Grund, wenn viewer nicht vergebbar', async () => {
    const { unmount } = setup(<AccessSheet resource={{ type: 'folder', id: F1 }} label="Projekte" open onClose={() => {}} />, { 'GET /v1/access': () => json({ ...LIST, resource: { type: 'folder', id: F1 }, classification: null }) });
    await screen.findByRole('table');
    expect(screen.queryByRole('switch')).toBeNull();
    unmount();
    setup(sheet(), { 'GET /v1/access': () => json({ ...LIST, grantable: ['editor'] }) });
    const sw = await screen.findByRole('switch', { name: 'Für alle Mitglieder' });
    expect(sw).toHaveAttribute('aria-disabled', 'true');
    expect(sw).toHaveAccessibleDescription('Gesperrt: Die Rolle «Leser:in» darfst du hier nicht vergeben.');
  });

  it('Vertraulichkeit: nur bei classified, Stufen über der eigenen gesperrt, speichern über die App; darüber gesperrt mit Grund', async () => {
    const onChange = vi.fn(async () => {});
    const { unmount } = setup(sheet({ classification: { level: 1, onChange } }), { 'GET /v1/access': () => json(LIST) }, { me: { clearance: 1 } });
    const sel = await screen.findByRole('combobox', { name: 'Vertraulichkeit' });
    expect(sel).toHaveValue('1');
    expect(within(sel).getByRole('option', { name: /^streng vertraulich – über deiner Freigabestufe$/ })).toBeDisabled();
    await userEvent.selectOptions(sel, '0');
    expect(onChange).toHaveBeenCalledWith(0);
    expect(await screen.findByText('Vertraulichkeit «intern» gespeichert')).toBeInTheDocument();
    unmount();
    setup(sheet({ classification: { level: 2, onChange } }), { 'GET /v1/access': () => json(LIST) }, { me: { clearance: 1 } });
    const locked = await screen.findByRole('combobox', { name: 'Vertraulichkeit' });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAccessibleDescription(/übersteigt deine Freigabestufe «vertraulich»/);
  });

  it('Feld fehlt ohne classified (classification null) und ohne Prop; disabledReason der App', async () => {
    const { unmount } = setup(sheet({ classification: { level: 0 } }), { 'GET /v1/access': () => json({ ...LIST, classification: null }) });
    await screen.findByRole('table');
    expect(screen.queryByRole('combobox', { name: 'Vertraulichkeit' })).toBeNull();
    unmount();
    setup(sheet({ classification: { level: 0, onChange: async () => {}, disabledReason: 'Dafür fehlt dir «Notizen ändern».' } }), { 'GET /v1/access': () => json(LIST) });
    expect(await screen.findByRole('combobox', { name: 'Vertraulichkeit' })).toHaveAccessibleDescription('Dafür fehlt dir «Notizen ändern».');
  });

  it('geschlossen nichts; «Warum sehe ich das?» öffnet den WhyDialog', async () => {
    const { rerender } = setup(sheet({ open: false }), { 'GET /v1/access': () => json(LIST), 'GET /v1/access/explain': () => json(EXPLAIN_OK) });
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<StaticIam>{sheet()}</StaticIam>);
    await userEvent.click(await screen.findByRole('button', { name: 'Warum sehe ich das?' }));
    expect(await screen.findByRole('dialog', { name: 'Warum sehe ich «Protokoll»?' })).toBeInTheDocument();
  });
});

describe('GrantDialog', () => {
  const people = { 'GET /v1/people': () => json({ items: [{ id: '00000000-0000-4000-8000-0000000000c3', kind: 'user', name: 'Carla Check', email: 'carla@demo.example', clientId: null, lastSeenAt: null }], nextCursor: null }) };

  it('Person aus dem Personenverzeichnis, Rolle nur aus grantable, Ablaufdatum; Prüfung beim Absenden am Feld', async () => {
    const onGranted = vi.fn();
    const { calls } = setup(<GrantDialog resource={NOTE} label="Protokoll" grantable={['editor', 'viewer']} onClose={() => {}} onGranted={onGranted} />, {
      ...people, 'POST /v1/access': () => json(entry('t9'), 201),
    });
    const dlg = await screen.findByRole('dialog', { name: 'Zugriff auf «Protokoll» freigeben' });
    expect(dlg).toHaveTextContent('Die Freigabe gilt in «Demo AG».');
    // ohne features.entra keine Gruppen; Clients nie
    expect(within(dlg).getAllByRole('radio').map(r => r.closest('label')!.textContent)).toEqual(['Person', 'Alle Mitglieder']);
    const role = within(dlg).getByRole('combobox', { name: 'Rolle' });
    await waitFor(() => expect(within(role).getAllByRole('option').map(o => o.textContent)).toEqual(['Rolle wählen', 'Bearbeiter:in', 'Leser:in']));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    expect(within(dlg).getAllByText('Bitte wählen.')).toHaveLength(2);
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Person suchen …' }));
    await userEvent.click(await screen.findByRole('option', { name: /Carla Check/ }));
    await userEvent.selectOptions(role, 'viewer');
    expect(within(dlg).getByText('Organisation lesen; Notizen lesen.')).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText('Gültig bis (optional)'), '2030-12-31');
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    expect(await screen.findByText('Freigabe in «Demo AG» angelegt')).toBeInTheDocument();
    const body = await calls.find(c => c.method === 'POST')!.clone().json() as Record<string, unknown>;
    expect({ ...body, expiresAt: typeof body.expiresAt }).toEqual({ subject: 'user:00000000-0000-4000-8000-0000000000c3', relation: 'viewer', type: 'note', id: N1, expiresAt: 'string' });
    expect(onGranted).toHaveBeenCalledWith(expect.objectContaining({ id: 't9' }));
  });

  it('«Alle Mitglieder»: Subjekt org:members; org-admin ohne Ablaufdatum; 403 exceeds-own mit den fehlenden Rechten', async () => {
    const { calls } = setup(<GrantDialog resource={{ type: 'org', id: null }} label="Demo AG" grantable={['org-admin', 'viewer']} onClose={() => {}} />, {
      'POST /v1/access': () => json({ title: 'Verboten', status: 403, reason: 'exceeds-own', missing: ['note:write', 'access:admin'] }, 403),
    });
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('radio', { name: 'Alle Mitglieder' }));
    expect(dlg).toHaveTextContent('Alle Personen in «Demo AG», keine Maschinen-Clients.');
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Rolle' }), 'org-admin');
    expect(within(dlg).getByLabelText('Gültig bis (optional)')).toBeDisabled();
    expect(dlg).toHaveTextContent('Die Rolle «Organisations-Admin» hat kein Ablaufdatum.');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Niemand gibt mehr, als er hat: Dir fehlen hier «Notizen ändern» und «Zugriff verwalten».');
    expect(await calls.find(c => c.method === 'POST')!.clone().json()).toEqual({ subject: 'org:members', relation: 'org-admin', type: 'org', id: null, expiresAt: null });
  });

  it('Gruppe aus Entra ID (features.entra): Suche ab 2 Zeichen über /v1/access/groups; ohne Verbindung der Grund', async () => {
    const { calls, unmount } = setup(<GrantDialog resource={NOTE} label="Protokoll" grantable={['viewer']} onClose={() => {}} />, {
      'GET /v1/access/groups': () => json({ items: [{ id: '0f0e-1', name: 'Abteilung X' }] }),
      'POST /v1/access': () => json(entry('t9'), 201),
    }, { config: { features: { entra: true } } });
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('radio', { name: 'Gruppe aus Entra ID' }));
    expect(dlg).toHaveTextContent('Mindestens 2 Zeichen eingeben.');
    await userEvent.type(within(dlg).getByRole('searchbox', { name: 'Gruppe aus Entra ID suchen' }), 'Ab');
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Abteilung X' }));
    expect(new URL(calls.find(c => new URL(c.url).pathname === '/v1/access/groups')!.url).searchParams.get('q')).toBe('Ab');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
    expect(await calls.find(c => c.method === 'POST')!.clone().json()).toMatchObject({ subject: 'group:0f0e-1', relation: 'viewer' });
    unmount();
    setup(<GrantDialog resource={NOTE} label="Protokoll" grantable={['viewer']} onClose={() => {}} />, {
      'GET /v1/access/groups': () => json({ title: 'Konflikt', status: 409, reason: 'entra-not-connected' }, 409),
    }, { config: { features: { entra: true } } });
    const d2 = await screen.findByRole('dialog');
    await userEvent.click(within(d2).getByRole('radio', { name: 'Gruppe aus Entra ID' }));
    await userEvent.type(within(d2).getByRole('searchbox'), 'Ab');
    expect(await within(d2).findByRole('note')).toHaveTextContent('Deine Organisation ist nicht mit Microsoft Entra ID verbunden');
  });
});

const EXPLAIN_OK: Explain = {
  allowed: true, permission: 'note:read', subject: { ref: 'user:p-anna', name: 'Anna Admin' },
  reasons: [
    { via: 'inherited', relation: 'viewer', place: { type: 'folder', id: F1 }, tupleId: 't3', matched: 'org:members' },
    { via: 'direct', relation: 'editor', place: NOTE, tupleId: 't1', matched: 'group:0f0e' },
    { via: 'owner', relation: 'owner', place: NOTE, tupleId: 't7', matched: 'user:p-anna' },
    { via: 'scope', relation: 'member', place: { type: 'folder', id: 'u1' }, tupleId: null, matched: 'user:p-anna', unit: { ref: { type: 'folder', id: 'u1' }, relation: 'gehört zu', grants: 'read' } },
  ],
  blocked: null,
};

describe('WhyDialog', () => {
  it('alle Wege zum Recht mit Ort und passendem Subjekt; Pfeil zum Ursprung', async () => {
    open.mockClear();
    const { calls } = setup(<WhyDialog resource={NOTE} label="Protokoll" onClose={() => {}} />, { 'GET /v1/access/explain': () => json(EXPLAIN_OK) }, { config: { resources } });
    const dlg = await screen.findByRole('dialog', { name: 'Warum sehe ich «Protokoll»?' });
    expect(await within(dlg).findByText('Du hast «Notizen lesen» an «Protokoll»:')).toBeInTheDocument();
    const ways = within(within(dlg).getByRole('list', { name: 'Wege zum Recht' })).getAllByRole('listitem').map(li => li.textContent);
    expect(ways).toEqual([
      'über die Rolle «Leser:in» an Ordner «Projekte» – als Mitglied der Organisation («Alle Mitglieder»)',
      'über die Rolle «Bearbeiter:in» direkt an «Protokoll» – über eine Gruppe aus Entra ID',
      'als Besitzer:in von «Protokoll»',
      'über die Zuständigkeit: «Protokoll» gehört zu Ordner «Abt X» (gehört zu)',
    ]);
    const q = new URL(calls.find(c => new URL(c.url).pathname === '/v1/access/explain')!.url).searchParams;
    expect([q.get('type'), q.get('id'), q.get('permission'), q.get('subject')]).toEqual(['note', N1, null, null]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Zu Ordner «Projekte»' }));
    expect(open).toHaveBeenCalledWith({ type: 'folder', id: F1 });
    expect(await axeProblems(dlg)).toEqual([]);
  });

  it('für andere (subject, permission) und ohne Weg: Satz mit Name, Hinweis auf Rollen am Ort', async () => {
    const { calls } = setup(<WhyDialog resource={NOTE} label="Protokoll" permission="note:write" subject="user:p-peter" onClose={() => {}} />, {
      'GET /v1/access/explain': () => json({ allowed: false, permission: 'note:write', subject: { ref: 'user:p-peter', name: 'Peter Meier' }, reasons: [], blocked: null }),
    });
    const dlg = await screen.findByRole('dialog', { name: 'Warum? – «Protokoll»' });
    expect(await within(dlg).findByText('Peter Meier hat «Notizen ändern» an «Protokoll» nicht.')).toBeInTheDocument();
    expect(dlg).toHaveTextContent('Keine Rolle, Freigabe, Zuständigkeit oder Besitz ergibt dieses Recht. Oder jemand gibt dir an «Protokoll» die Rolle «Bearbeiter:in» frei.');
    const q = new URL(calls.find(c => new URL(c.url).pathname === '/v1/access/explain')!.url).searchParams;
    expect([q.get('permission'), q.get('subject')]).toEqual(['note:write', 'user:p-peter']);
  });

  it('Vertraulichkeit verhindert: Stufe und Freigabestufe; als org-admin Break-Glass mit Begründung und Dauer starten', async () => {
    const { calls } = setup(<WhyDialog resource={NOTE} label="Protokoll" onClose={() => {}} />, {
      'GET /v1/access/explain': () => json({ ...EXPLAIN_OK, allowed: false, reasons: EXPLAIN_OK.reasons.slice(0, 1), blocked: { reason: 'clearance', classification: 2, clearance: 1 } }),
      'POST /v1/break-glass': () => json({ until: new Date(Date.now() + 3_600_000).toISOString(), clearance: 2 }),
    }, { me: { clearance: 1 } });
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByText('Die Vertraulichkeit «streng vertraulich» übersteigt deine Freigabestufe «vertraulich».')).toBeInTheDocument();
    const bg = within(dlg).getByRole('region', { name: 'Notfallzugang (Break-Glass)' });
    await userEvent.click(within(bg).getByRole('button', { name: 'Notfallzugang starten' }));
    expect(within(bg).getByRole('textbox', { name: 'Begründung' })).toHaveAttribute('aria-invalid', 'true');
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    await userEvent.type(within(bg).getByRole('textbox', { name: 'Begründung' }), 'Störung im Netz');
    await userEvent.selectOptions(within(bg).getByRole('combobox', { name: 'Dauer' }), '30');
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(bg).getByRole('button', { name: 'Notfallzugang starten' }));
    expect(await screen.findByText(/^Notfallzugang aktiv bis /)).toBeInTheDocument();
    expect(await calls.find(c => c.method === 'POST')!.clone().json()).toEqual({ reason: 'Störung im Netz', minutes: 30 });
  });

  it('ohne org-admin kein Formular, sondern ein Hinweis; Scope fehlt: eigener Satz', async () => {
    const { unmount } = setup(<WhyDialog resource={NOTE} label="Protokoll" onClose={() => {}} />, {
      'GET /v1/access/explain': () => json({ ...EXPLAIN_OK, allowed: false, blocked: { reason: 'clearance', classification: 2, clearance: 0 } }),
    }, { me: { roles: ['viewer'], clearance: 0 } });
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByText(/Den Notfallzugang starten nur Personen mit der Rolle «Organisations-Admin»/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: 'Notfallzugang starten' })).toBeNull();
    unmount();
    setup(<WhyDialog resource={NOTE} label="Protokoll" onClose={() => {}} />, {
      'GET /v1/access/explain': () => json({ ...EXPLAIN_OK, allowed: false, blocked: { reason: 'scope', scope: 'notes:read' } }),
    });
    expect(await screen.findByText('Der Scope notes:read fehlt im Token.')).toBeInTheDocument();
  });
});

describe('ClassificationBadge und Break-Glass', () => {
  it('Badge ab Stufe 1 mit Label aus dem Katalog; Stufe 0 zeigt nichts', async () => {
    vi.stubGlobal('fetch', mockIamApi().fetch);
    const { container } = render(<StaticIam><ClassificationBadge level={0} /><ClassificationBadge level={1} /><ClassificationBadge level={2} /></StaticIam>);
    expect(await screen.findByText('streng vertraulich')).toBeInTheDocument();
    const badges = container.querySelectorAll('.iam-cls');
    expect([...badges].map(b => b.textContent)).toEqual(['Vertraulichkeit: vertraulich', 'Vertraulichkeit: streng vertraulich']);
    expect(badges[0]).toHaveAttribute('title', 'Vertraulichkeit: vertraulich');
    expect(badges[1]).toHaveClass('iam-cls-2');
  });

  it('Banner bei aktivem Break-Glass mit «Beenden» (DELETE /v1/break-glass); ohne oder abgelaufen kein Banner', async () => {
    const until = new Date(Date.now() + 90 * 60_000).toISOString();
    const { calls, unmount } = setup(<BreakGlassBanner />, { 'DELETE /v1/break-glass': () => new Response(null, { status: 204 }) }, { me: { breakGlassUntil: until, clearance: 2 } });
    const banner = screen.getByRole('region', { name: 'Notfallzugang' });
    expect(banner).toHaveTextContent(/^Notfallzugang aktiv bis (\d\d\.\d\d\.\d{4}, )?\d\d:\d\d\./);
    expect(banner).toHaveTextContent('Du siehst in «Demo AG» Vertrauliches bis «streng vertraulich»');
    await userEvent.click(within(banner).getByRole('button', { name: 'Beenden' }));
    expect(await screen.findByText('Notfallzugang beendet')).toBeInTheDocument();
    expect(calls.some(c => c.method === 'DELETE' && new URL(c.url).pathname === '/v1/break-glass')).toBe(true);
    expect(await axeProblems()).toEqual([]);
    unmount();
    setup(<BreakGlassBanner />, {}, { me: { breakGlassUntil: new Date(Date.now() - 1000).toISOString() } });
    expect(screen.queryByRole('region', { name: 'Notfallzugang' })).toBeNull();
  });

  it('useBreakGlass: allowed nur mit org-admin an der Organisation, until, start und end', async () => {
    let result: ReturnType<typeof useBreakGlass> | null = null;
    function Probe() { result = useBreakGlass(); return null; }
    const { calls, unmount } = setup(<Probe />, {
      'POST /v1/break-glass': () => json({ until: new Date(Date.now() + 60_000).toISOString(), clearance: 2 }),
      'DELETE /v1/break-glass': () => new Response(null, { status: 204 }),
    });
    expect(result!.allowed).toBe(true);
    expect(result!.until).toBeNull();
    await act(() => result!.start('Prüfung', 15));
    await act(() => result!.end());
    expect(calls.filter(c => new URL(c.url).pathname === '/v1/break-glass').map(c => c.method)).toEqual(['POST', 'DELETE']);
    unmount();
    const until = new Date(Date.now() + 60_000).toISOString();
    setup(<Probe />, {}, { me: { roles: ['viewer'], breakGlassUntil: until } });
    expect(result!.allowed).toBe(false);
    expect(result!.until?.toISOString()).toBe(until);
  });
});

describe('Daten (access/api.ts)', () => {
  it('GET /v1/access?subject=me für eigene Orte; Mutationen invalidieren Liste und /auth/me', async () => {
    let n = 0;
    const { calls } = setup(sheet(), {
      'GET /v1/access': () => { n += 1; return json(LIST); },
      'POST /v1/access': () => json(entry('t9'), 201),
    });
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Freigeben' }));
    const dlg = await screen.findByRole('dialog', { name: 'Zugriff auf «Protokoll» freigeben' });
    await userEvent.click(within(dlg).getByRole('radio', { name: 'Alle Mitglieder' }));
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Rolle' }), 'editor');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(n).toBeGreaterThan(1));
    const post = calls.find(c => c.method === 'POST')!;
    expect(post.headers.get('X-CSRF-Token')).toBe('csrf-123');
    expect(post.headers.get('X-Tenant')).toBe('demo');
  });
});
