/**
 * Seite «Rollen» (eigene Rollen der Organisation, Recht roles:admin): Liste, Zusammenstellen mit Rechten je Gruppe und
 * Orten (Rechte nur von org-admin fehlen, eigene fehlende Rechte gesperrt mit Grund), Prüfung beim Absenden, Ändern,
 * Löschen erst unvergeben, Fehler der API in der Rückfrage, Route und Navigation.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeIamRoutes, type AuthzCatalog, type CustomRole, type Me } from '../src/index.ts';
import { RolesPage } from '../src/pages/index.ts';
import { CATALOG, json, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const catalog: AuthzCatalog = {
  ...CATALOG,
  permissions: [...CATALOG.permissions, { key: 'roles:admin', label: 'Rollen zusammenstellen', group: 'members', resources: ['org'], adminOnly: true, description: 'Eigene Rollen zusammenstellen.', personOnly: true }],
};
const ROLE: CustomRole = { key: 'c-pruefer', label: 'Prüfer:in', description: 'Liest Notizen zur Prüfung.', permissions: ['note:read'], places: ['org', 'folder'], assignments: 2, createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-20T08:00:00Z' };
const ADMIN: Partial<Me> = { roles: ['org-admin'], permissions: catalog.permissions.map(p => p.key) };
const STEWARD: Partial<Me> = { roles: ['c-steward'], permissions: ['tenant:read', 'roles:admin', 'note:read'] };

function setup(routes: Record<string, MockHandler> = {}, me: Partial<Me> = ADMIN) {
  const api = mockIamApi({ 'GET /v1/admin/roles': () => json({ items: [] }), ...routes }, { catalog });
  vi.stubGlobal('fetch', api.fetch);
  render(<StaticIam me={me}><RolesPage /></StaticIam>);
  return api;
}
const body = async (r: Request) => JSON.parse(await r.text());

describe('Seite Rollen', () => {
  it('ohne eigene Rollen: Hinweis und Vorgaben der App; zusammenstellen mit Rechten je Gruppe und Orten (POST)', async () => {
    let items: CustomRole[] = [];
    const api = setup({
      'GET /v1/admin/roles': () => json({ items }),
      'POST /v1/admin/roles': async r => { const b = await body(r); items = [{ ...ROLE, ...b, key: 'c-qualitaet', assignments: 0 }]; return json(items[0], 201); },
    });
    expect(await screen.findByText('Noch keine eigenen Rollen')).toBeInTheDocument();
    expect(screen.getByText('Rollen der App (Vorgabe)')).toBeInTheDocument();
    expect(screen.getByText('Bearbeiter:in')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Rolle zusammenstellen' })[0]!);
    const dlg = await screen.findByRole('dialog', { name: 'Rolle zusammenstellen' });
    // Rechte nur von org-admin fehlen (members:admin, roles:admin, tenant:admin)
    expect(within(dlg).queryByLabelText(/Mitglieder und Rollen verwalten/)).toBeNull();
    expect(within(dlg).queryByLabelText(/Rollen zusammenstellen/)).toBeNull();
    await userEvent.type(within(dlg).getByLabelText('Name'), 'Qualität');
    await userEvent.click(within(dlg).getByLabelText(/Notizen lesen/));
    await userEvent.click(within(dlg).getByLabelText('Ordner'));
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = api.calls.find(c => c.method === 'POST')!;
    expect(await body(post)).toEqual({ label: 'Qualität', description: '', permissions: ['note:read'], places: ['org', 'folder'] });
    expect(await screen.findByText('c-qualitaet')).toBeInTheDocument();
    expect(api.calls.filter(c => new URL(c.url).pathname === '/v1/authz/catalog').length).toBeGreaterThan(1);
  });

  it('Prüfung beim Absenden: Name, Rechte und Orte; Fokus aufs erste fehlerhafte Feld, nichts gesendet', async () => {
    const api = setup();
    await userEvent.click((await screen.findAllByRole('button', { name: 'Rolle zusammenstellen' }))[0]!);
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByLabelText('Organisation'));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    expect(within(dlg).getByText('Name fehlt')).toBeInTheDocument();
    expect(within(dlg).getByText('Mindestens ein Recht wählen')).toBeInTheDocument();
    expect(within(dlg).getByText('Mindestens einen Ort wählen')).toBeInTheDocument();
    expect(within(dlg).getByLabelText('Name')).toHaveFocus();
    expect(api.calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('niemand gibt mehr, als er hat: Rechte, die ich nicht habe, gesperrt mit Grund', async () => {
    setup({}, STEWARD);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Rolle zusammenstellen' }))[0]!);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByLabelText(/Notizen lesen/)).toBeEnabled();
    const write = within(dlg).getByLabelText(/Notizen ändern/);
    expect(write).toBeDisabled();
    expect(write).toHaveAccessibleDescription('(Recht fehlt dir)');
  });

  it('vergebene Rolle: Löschen gesperrt mit Grund; ändern (PUT) wirkt sofort; unvergeben löschen mit Rückfrage; 409 in der Rückfrage', async () => {
    let items = [ROLE, { ...ROLE, key: 'c-alt', label: 'Alt', assignments: 0 }];
    const api = setup({
      'GET /v1/admin/roles': () => json({ items }),
      'PUT /v1/admin/roles/c-pruefer': async r => json({ ...ROLE, ...(await body(r)) }),
      'DELETE /v1/admin/roles/c-alt': () => json({ type: 'x', title: 'Konflikt', status: 409, detail: 'Die Rolle «Alt» ist noch einmal vergeben. Zuerst die Vergaben entfernen.', reason: 'in-use' }, 409),
    });
    const del = await screen.findByRole('button', { name: 'Rolle Prüfer:in löschen' });
    expect(del).toBeDisabled();
    expect(del).toHaveAccessibleDescription('Noch 2-mal vergeben – zuerst die Vergaben entfernen.');
    await userEvent.click(screen.getByRole('button', { name: 'Rolle Prüfer:in ändern' }));
    const dlg = await screen.findByRole('dialog', { name: 'Rolle «Prüfer:in» ändern' });
    expect(within(dlg).getByText(/Änderungen gelten sofort für alle 2 Vergaben/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByLabelText(/Notizen ändern/));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await body(api.calls.find(c => c.method === 'PUT')!)).permissions).toEqual(['note:read', 'note:write']);
    await userEvent.click(screen.getByRole('button', { name: 'Rolle Alt löschen' }));
    const c = await screen.findByRole('alertdialog', { name: 'Rolle «Alt» löschen?' });
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    await userEvent.click(within(c).getByRole('button', { name: 'Rolle löschen' }));
    expect(await within(c).findByRole('alert')).toHaveTextContent('Die Rolle «Alt» ist noch einmal vergeben.');
    items = [ROLE];
  });

  it('Route «Rollen» mit Recht roles:admin in der Navigation', () => {
    const r = makeIamRoutes().find(x => x.id === 'roles')!;
    expect([r.path, r.need, r.nav]).toEqual(['/verwalten/rollen', { perm: 'roles:admin' }, true]);
  });
});
