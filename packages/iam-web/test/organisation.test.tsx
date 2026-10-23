/**
 * Organisation je Tab (Spezifikation 11.1): zwei Tabs an einer Sitzung, je mit eigenem sessionStorage und eigenen
 * Modulinstanzen (wie zwei Browser-Tabs), gegen einen nachgebildeten BFF mit Vorgabe der Sitzung. Dazu: Hinweis, wenn
 * die Organisation des Tabs nicht mehr verfügbar ist, Cache bei anderem Mandanten, andere Person im selben Tab.
 * Aus vollholz/assets `web/src/auth/organisation.test.tsx`.
 */
import { QueryClient, useQuery } from '@tanstack/react-query';
import { act, render, waitFor, within } from '@testing-library/react';
import { memo } from 'react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../src/index.ts';
import { json, ME } from '../src/testing/index.tsx';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}

const ORGS: Record<string, { id: string; name: string }> = { demo: { id: 't-demo', name: 'Demo AG' }, muster: { id: 't-muster', name: 'Muster GmbH' } };

/** BFF wie Spezifikation 5.1: eine Sitzung, Vorgabe `def`, X-Tenant wählt je Anfrage, nur Organisationen im Token. */
function server() {
  const s = { def: 'demo' as string | null, orgs: ['demo', 'muster'], removed: new Set<string>(), person: ME.person, switchStatus: 200, calls: [] as { method: string; path: string; tenant: string | null }[] };
  const allowed = (x: string | null) => !!x && s.orgs.includes(x) && !s.removed.has(x);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(req.url).pathname;
    s.calls.push({ method: req.method, path, tenant: req.headers.get('x-tenant') });
    const tn = req.headers.get('x-tenant') ?? s.def;
    if (path === '/auth/me') {
      const ok = allowed(tn);
      const me: Me = {
        ...ME, person: s.person, tenant: ok ? { id: ORGS[tn!]!.id, alias: tn!, name: ORGS[tn!]!.name, entraConnected: false } : null, organizations: s.orgs,
        organizationNames: Object.fromEntries(s.orgs.map(o => [o, ORGS[o]!.name])), selectedOrganization: s.def,
        tenantError: ok ? null : s.removed.has(tn!) ? 'Du wurdest aus dieser Organisation entfernt. Bitte melde dich neu an.' : `Kein Zugriff auf «${tn}».`,
        permissions: ok ? ME.permissions : [],
      };
      return json(me);
    }
    if (path === '/auth/logout' && req.method === 'POST') return json({ redirect: '/' });
    if (path === '/auth/switch' && req.method === 'POST') {
      if (s.switchStatus === 401) return json({ title: 'Nicht angemeldet', status: 401 }, 401);
      const { org } = (await req.json()) as { org: string };
      if (!s.orgs.includes(org)) return json({ title: 'Organisation nicht erlaubt', status: 403 }, 403);
      s.def = org;
      return json({ redirect: '/' });
    }
    if (!allowed(tn)) return json({ title: 'Kein Mitglied mehr', status: 403 }, 403);
    if (path === '/v1/notes' && req.method === 'POST') return json({ id: 'n1', tenant: tn }, 201);
    // Daten je Person und Organisation (ID), damit die Tests sehen, wessen Daten die Oberfläche zeigt
    if (path === '/v1/notes') return json({ items: [{ id: `n-${tn}` }], owner: `${s.person.subject}@${ORGS[tn!]!.id}` });
    return json({ title: 'Nicht gefunden', status: 404 }, 404);
  }));
  return s;
}

/** Ein Tab: eigener sessionStorage und eigene Modulinstanzen (Organisation des Tabs im Client, Sitzung). */
async function openTab(storage: Storage) {
  vi.resetModules();
  vi.stubGlobal('sessionStorage', storage);
  const iam = await import('../src/index.ts');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Daten der App unter eigenem Schlüssel, in einer Komponente, die die Sitzung nicht liest (memo, keine Props): zeichnet
  // nach einem Wechsel nur neu, wenn die Sitzung sie neu einhängt
  const Notes = memo(function Notes() {
    const q = useQuery({ queryKey: ['notes'], staleTime: Infinity, queryFn: () => iam.iamFetch<{ owner: string }>('/v1/notes') });
    return <p>Daten von: {q.data?.owner ?? '…'}</p>;
  });
  function Probe() {
    const { me, switchOrg, logout, orgName } = iam.useIam();
    return (
      <div>
        <p>Organisation: {orgName}</p>
        <button type="button" onClick={() => void switchOrg(me.tenant?.alias === 'demo' ? 'muster' : 'demo')}>Wechseln</button>
        <button type="button" onClick={() => void iam.iamFetch('/v1/notes', { method: 'POST', body: {} }).catch(() => undefined)}>Schreiben</button>
        <button type="button" onClick={() => void iam.iamFetch('/v1/notes').catch(() => undefined)}>Lesen</button>
        <button type="button" onClick={() => void logout()}>Abmelden</button>
      </div>
    );
  }
  const view = render(<iam.IamProvider product="Notizen" queryClient={qc}><Probe /><Notes /></iam.IamProvider>);
  return { qc, view, in: within(view.container as HTMLElement) };
}

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => { assign = vi.fn(); vi.stubGlobal('location', { ...window.location, pathname: '/', search: '', assign, reload: vi.fn() }); });
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('Organisation je Tab (zwei Tabs, eine Sitzung)', () => {
  it('Wechsel in Tab B ändert Tab A nicht: A liest und schreibt weiter mit X-Tenant A, auch nach Neuladen', async () => {
    const srv = server();
    const storageA = new MemoryStorage(), storageB = new MemoryStorage();
    const a = await openTab(storageA);
    expect(await a.in.findByText('Organisation: Demo AG')).toBeInTheDocument();
    // ohne eigene Wahl übernimmt der Tab die Vorgabe der Sitzung und merkt sie sich
    expect(JSON.parse(storageA.getItem('iam.tab.org')!)).toMatchObject({ sub: 'sub-anna', alias: 'demo', name: 'Demo AG' });

    const b = await openTab(storageB);
    expect(await b.in.findByText('Organisation: Demo AG')).toBeInTheDocument();
    await userEvent.click(b.in.getByRole('button', { name: 'Wechseln' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(srv.def).toBe('muster');
    expect(JSON.parse(storageB.getItem('iam.tab.org')!)).toMatchObject({ alias: 'muster' });
    b.view.unmount();
    const b2 = await openTab(storageB); // Tab B lädt nach dem Wechsel neu
    expect(await b2.in.findByText('Organisation: Muster GmbH')).toBeInTheDocument();
    b2.view.unmount();

    // Tab A: zeigt weiter demo, Lesen und Schreiben gehen mit X-Tenant demo – nicht in die neue Vorgabe der Sitzung
    srv.calls.length = 0;
    await userEvent.click(a.in.getByRole('button', { name: 'Lesen' }));
    await userEvent.click(a.in.getByRole('button', { name: 'Schreiben' }));
    await act(async () => { await a.qc.refetchQueries({ queryKey: ['iam', 'me'] }); }); // z. B. Rückkehr in den Tab
    await waitFor(() => expect(srv.calls.map(c => `${c.method} ${c.path} ${c.tenant}`)).toEqual(['GET /v1/notes demo', 'POST /v1/notes demo', 'GET /auth/me demo']));
    expect(a.in.getByText('Organisation: Demo AG')).toBeInTheDocument();

    // Tab A neu laden: bleibt in demo
    a.view.unmount();
    srv.calls.length = 0;
    const a2 = await openTab(storageA);
    expect(await a2.in.findByText('Organisation: Demo AG')).toBeInTheDocument();
    expect(srv.calls[0]).toEqual({ method: 'GET', path: '/auth/me', tenant: 'demo' });
  });

  it('Organisation des Tabs nicht mehr verfügbar (403): Hinweis mit Auswahl und «Neu laden», nie still eine andere', async () => {
    const srv = server();
    const storage = new MemoryStorage();
    storage.setItem('iam.tab.org', JSON.stringify({ sub: 'sub-anna', alias: 'muster', name: 'Muster GmbH' }));
    const tab = await openTab(storage);
    expect(await tab.in.findByText('Organisation: Muster GmbH')).toBeInTheDocument();
    srv.removed.add('muster'); // aus muster entfernt; die Vorgabe der Sitzung ist demo
    srv.calls.length = 0;
    await userEvent.click(tab.in.getByRole('button', { name: 'Lesen' }));
    expect(await tab.in.findByRole('heading', { name: 'Organisation nicht verfügbar' })).toBeInTheDocument();
    expect(tab.in.getByText('In diesem Tab ist «Muster GmbH» nicht mehr verfügbar.')).toBeInTheDocument();
    expect(tab.in.getByText(/Du wurdest aus dieser Organisation entfernt/)).toBeInTheDocument();
    expect(tab.in.queryByText(/^Organisation: /)).toBeNull();
    expect(srv.calls.every(c => c.tenant === 'muster')).toBe(true);
    expect(within(tab.in.getByRole('group', { name: 'Organisation wählen' })).getByRole('button', { name: 'Zu «Demo AG» wechseln' })).toBeInTheDocument();
    await userEvent.click(tab.in.getByRole('button', { name: 'Neu laden' }));
    expect(window.location.reload).toHaveBeenCalled();
    await userEvent.click(tab.in.getByRole('button', { name: 'Zu «Demo AG» wechseln' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(JSON.parse(storage.getItem('iam.tab.org')!)).toMatchObject({ alias: 'demo' });
  });

  it('mehrere Organisationen ohne Wahl: Auswahlseite mit Namen; Wahl gilt für diesen Tab', async () => {
    const srv = server();
    srv.def = null;
    const storage = new MemoryStorage();
    const tab = await openTab(storage);
    expect(await tab.in.findByRole('heading', { name: 'Organisation wählen' })).toBeInTheDocument();
    await userEvent.click(tab.in.getByRole('button', { name: 'Muster GmbH' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(JSON.parse(storage.getItem('iam.tab.org')!)).toMatchObject({ alias: 'muster' });
  });

  it('anderer Mandant im Tab (gleicher Alias, neue ID): Cache der App geleert, Oberfläche zeigt nur noch neue Daten, /auth/me bleibt', async () => {
    server();
    const tab = await openTab(new MemoryStorage());
    expect(await tab.in.findByText('Daten von: sub-anna@t-demo')).toBeInTheDocument();
    tab.qc.setQueryData(['iam', 'roles'], ['auch Daten des Pakets']);
    ORGS.demo = { id: 't-demo-neu', name: 'Demo AG' };
    try {
      await act(async () => { await tab.qc.refetchQueries({ queryKey: ['iam', 'me'] }); });
      expect(tab.qc.getQueryData(['iam', 'roles'])).toBeUndefined();
      expect(tab.qc.getQueryData<Me>(['iam', 'me'])?.tenant?.id).toBe('t-demo-neu');
      // die Komponente der App hängt neu ein und lädt; die alten Daten stehen nicht mehr da
      expect(await tab.in.findByText('Daten von: sub-anna@t-demo-neu')).toBeInTheDocument();
      expect(tab.in.queryByText('Daten von: sub-anna@t-demo')).toBeNull();
    } finally { ORGS.demo = { id: 't-demo', name: 'Demo AG' }; }
  });

  it('andere Person im selben Tab und derselben Organisation (in einem anderen Tab neu angemeldet): Cache geleert, nur ihre Daten', async () => {
    const srv = server();
    const tab = await openTab(new MemoryStorage());
    expect(await tab.in.findByText('Daten von: sub-anna@t-demo')).toBeInTheDocument();
    srv.person = { subject: 'sub-ben', name: 'Ben Neu', email: 'ben@demo.example' };
    await act(async () => { await tab.qc.refetchQueries({ queryKey: ['iam', 'me'] }); });
    expect(await tab.in.findByText('Daten von: sub-ben@t-demo')).toBeInTheDocument();
    expect(tab.in.queryByText('Daten von: sub-anna@t-demo')).toBeNull();
    expect(tab.qc.getQueryData<{ owner: string }>(['notes'])?.owner).toBe('sub-ben@t-demo');
  });

  it('401 beim Wechsel: «Sitzung abgelaufen» wie bei jeder Anfrage, keine Meldung «Organisation nicht gewechselt»', async () => {
    const srv = server();
    const tab = await openTab(new MemoryStorage());
    expect(await tab.in.findByText('Organisation: Demo AG')).toBeInTheDocument();
    srv.switchStatus = 401;
    await userEvent.click(tab.in.getByRole('button', { name: 'Wechseln' }));
    expect(await within(document.body).findByRole('alertdialog', { name: 'Sitzung abgelaufen' })).toBeInTheDocument();
    expect(within(document.body).queryByText(/Organisation nicht gewechselt/)).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it('andere Person im selben Tab: frühere Wahl gilt nicht', async () => {
    const srv = server();
    const storage = new MemoryStorage();
    storage.setItem('iam.tab.org', JSON.stringify({ sub: 'sub-ben', alias: 'muster' }));
    const tab = await openTab(storage);
    expect(await tab.in.findByText('Organisation: Demo AG')).toBeInTheDocument();
    expect(srv.calls.filter(c => c.path === '/auth/me').map(c => c.tenant)).toEqual(['muster', null]);
    expect(JSON.parse(storage.getItem('iam.tab.org')!)).toMatchObject({ sub: 'sub-anna', alias: 'demo' });
  });

  it('Abmelden entfernt die Organisation des Tabs', async () => {
    server();
    const storage = new MemoryStorage();
    const tab = await openTab(storage);
    expect(await tab.in.findByText('Organisation: Demo AG')).toBeInTheDocument();
    expect(storage.getItem('iam.tab.org')).not.toBeNull();
    await userEvent.click(tab.in.getByRole('button', { name: 'Abmelden' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/abgemeldet'));
    expect(storage.getItem('iam.tab.org')).toBeNull();
  });
});
