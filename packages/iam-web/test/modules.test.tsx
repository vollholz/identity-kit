/**
 * Seite «Module» und Abschnitt der Plattform-Administration: Liste mit Status, Teilfunktionen eingerückt, Voraussetzungen
 * als Text, nicht freigegebene gesperrt mit Grund; Aktivieren mit Hinweis auf Voraussetzungen (Reihenfolge, If-Match),
 * Deaktivieren mit Wirkung, Hindernisse (vorher bekannt und 409 `hindernisse`), 412, nur lesen ohne tenant:admin,
 * Tastatur, axe; Pflichtmodule wie alle anderen (Status «Aktiv», Schalter eingeschaltet und gesperrt), Raster der Zeilen
 * (Status und Schalter in derselben Spalte, auch bei Teilfunktionen); `hasModule`, Route und Navigation; Freigeben und
 * Entziehen mit `force`.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IamNav, makeIamRoutes, useIam, type AuthzCatalog, type Me, type TenantModule } from '../src/index.ts';
import { activationPlan, dependentsOf, moduleIsOn, moduleLockReason } from '../src/pages/index.ts';
import { ModulesPage, ModulesSection } from '../src/pages/index.ts';
import { CATALOG, json, mockIamApi, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const catalog: AuthzCatalog = {
  ...CATALOG,
  permissions: [...CATALOG.permissions, { key: 'zeit:write', label: 'Zeit erfassen', group: 'notes', resources: ['org'], adminOnly: false, description: 'Zeit erfassen.', modul: 'zeit' }],
  modules: [
    { key: 'kern', label: 'Kern', description: 'Mitglieder, Rollen und Einstellungen.', core: true, requires: [], parts: [] },
    { key: 'zeit', label: 'Zeiterfassung', description: 'Arbeitszeit erfassen.', core: false, requires: [], parts: [{ key: 'zeit.korrektur', label: 'Korrekturanträge', description: 'Korrekturen beantragen.' }] },
    { key: 'abwesenheit', label: 'Abwesenheiten', description: 'Ferien und Absenzen.', core: false, requires: [], parts: [] },
    { key: 'lohn', label: 'Lohn', description: 'Lohnläufe.', core: false, requires: ['zeit', 'abwesenheit'], parts: [] },
    { key: 'projekte', label: 'Projekte', description: 'Projektzeiten.', core: false, requires: [], parts: [] },
  ],
  packages: [],
};

const mod = (key: string, label: string, o: Partial<TenantModule> = {}): TenantModule =>
  ({ key, label, description: `${label} – Beschreibung.`, core: false, requires: [], module: null, allowed: true, active: false, activeSince: null, ...o });
const initial = (): TenantModule[] => [
  mod('kern', 'Kern', { core: true, active: true }),
  mod('zeit', 'Zeiterfassung', { active: true, activeSince: '2026-10-01T08:00:00Z', blockers: [] }),
  mod('zeit.korrektur', 'Korrekturanträge', { module: 'zeit', active: true }),
  mod('abwesenheit', 'Abwesenheiten'),
  mod('lohn', 'Lohn', { requires: ['zeit', 'abwesenheit'] }),
  mod('projekte', 'Projekte', { allowed: false }),
];

/** Nachgebildeter Server mit Zustand und Version (ETag `W/"<n>"`). */
function server(items = initial(), o: { put?: (key: string, active: boolean) => Response | null } = {}) {
  let v = 7;
  const state = { items, puts: [] as { key: string; active: boolean; ifMatch: string | null }[] };
  const routes: Record<string, MockHandler> = {
    'GET /v1/tenant/modules': () => json({ items: state.items }, 200, { etag: `W/"${v}"` }),
  };
  for (const m of items) {
    routes[`PUT /v1/tenant/modules/${m.key}`] = async req => {
      const { active } = await req.json() as { active: boolean };
      state.puts.push({ key: m.key, active, ifMatch: req.headers.get('if-match') });
      const r = o.put?.(m.key, active);
      if (r) return r;
      if (req.headers.get('if-match') && req.headers.get('if-match') !== `W/"${v}"`) return json({ title: 'Version', status: 412 }, 412);
      v += 1;
      state.items = state.items.map(x => (x.key === m.key ? { ...x, active } : x.module === m.key && !active ? { ...x, active: false } : x));
      return json(state.items.find(x => x.key === m.key), 200, { etag: `W/"${v}"` });
    };
  }
  return { state, routes };
}

function setup(o: { me?: Partial<Me>; srv?: ReturnType<typeof server>; routes?: Record<string, MockHandler> } = {}) {
  const srv = o.srv ?? server();
  const api = mockIamApi({ ...srv.routes, ...o.routes }, { catalog });
  vi.stubGlobal('fetch', api.fetch);
  render(<StaticIam me={o.me}><ModulesPage /></StaticIam>);
  return { api, srv };
}
const catalogCalls = (api: { calls: Request[] }) => api.calls.filter(c => new URL(c.url).pathname === '/v1/authz/catalog').length;
const row = (name: string) => screen.getByRole('switch', { name: `${name} aktiv` }).closest('.iam-mod-row') as HTMLElement;

describe('Regeln', () => {
  it('Voraussetzungen rekursiv, inaktive zuerst; «eines von» mit Wahl; nicht freigegebene blockieren; gebraucht von', () => {
    const items = [
      mod('a', 'A', { active: true }), mod('b', 'B'), mod('c', 'C', { requires: ['b'] }), mod('d', 'D', { requires: ['c', ['x', 'y']] }),
      mod('x', 'X'), mod('y', 'Y'), mod('z', 'Z', { allowed: false }), mod('e', 'E', { requires: ['z'] }), mod('f', 'F', { active: true, requires: ['a'] }),
    ];
    expect(activationPlan(items, 'd')).toEqual({ also: ['b', 'c', 'x'], choices: [{ alts: ['x', 'y'], chosen: 'x' }], blocked: [] });
    expect(activationPlan(items, 'd', { 'x|y': 'y' }).also).toEqual(['b', 'c', 'y']);
    expect(activationPlan(items, 'e').blocked).toEqual(['z']);
    expect(dependentsOf(items, 'a')).toEqual(['f']);
  });
});

describe('Hilfen für eigene Modulseiten', () => {
  it('moduleLockReason: Pflicht, Freigabe, Recht, Teilfunktion, Voraussetzung; moduleIsOn', () => {
    const items = [...initial().map(m => (m.key === 'zeit' ? { ...m, active: false } : m)), mod('x', 'X', { requires: ['projekte'] })];
    const why = (k: string, admin = true) => moduleLockReason(items, items.find(m => m.key === k)!, admin, 'Organisation verwalten');
    expect(why('kern')).toBe('Pflichtmodul – immer aktiv');
    expect(why('projekte')).toBe('Für deine Organisation nicht freigegeben – wende dich an den Betrieb.');
    expect(why('abwesenheit', false)).toBe('Nur mit «Organisation verwalten»');
    expect(why('zeit.korrektur')).toBe('Zuerst «Zeiterfassung» aktivieren.');
    expect(why('x')).toMatch(/^Braucht «Projekte»/);
    expect(why('abwesenheit')).toBeNull();
    expect(moduleIsOn(items.find(m => m.key === 'kern')!)).toBe(true);
    expect(moduleIsOn({ ...items.find(m => m.key === 'kern')!, active: false })).toBe(true);
    expect(moduleIsOn(items.find(m => m.key === 'abwesenheit')!)).toBe(false);
  });
});

describe('Seite Module', () => {
  it('Liste: Status, Teilfunktionen eingerückt, Voraussetzungen als Text, nicht freigegeben gesperrt mit Grund; axe', async () => {
    setup();
    expect(await screen.findByRole('switch', { name: 'Zeiterfassung aktiv' })).toHaveAttribute('aria-checked', 'true');
    const list = screen.getByRole('list', { name: 'Module' });
    expect(within(list).getByText('Kern')).toBeInTheDocument();
    expect(within(row('Lohn')).getByText('Aus')).toBeInTheDocument();
    expect(within(row('Lohn')).getByText('Braucht «Zeiterfassung» und «Abwesenheiten»')).toBeInTheDocument();
    // Teilfunktion unter ihrem Modul
    const parts = screen.getByRole('list', { name: 'Teilfunktionen von Zeiterfassung' });
    expect(within(parts).getByRole('switch', { name: 'Korrekturanträge aktiv' })).toBeInTheDocument();
    const projekte = screen.getByRole('switch', { name: 'Projekte aktiv' });
    expect(projekte).toHaveAttribute('aria-disabled', 'true');
    expect(projekte).toHaveAccessibleDescription('Für deine Organisation nicht freigegeben – wende dich an den Betrieb.');
    expect(within(row('Projekte')).getByText('Nicht freigegeben')).toBeInTheDocument();
    expect(await axeProblems()).toEqual([]);
  });

  it('Pflichtmodul wie alle anderen: Status «Aktiv», Schalter eingeschaltet, gesperrt mit Grund, fokussierbar; Klick bewirkt nichts', async () => {
    const { api } = setup();
    const kern = await screen.findByRole('switch', { name: 'Kern aktiv' });
    expect(kern).toHaveAttribute('aria-checked', 'true');
    expect(kern).toHaveAttribute('aria-disabled', 'true');
    expect(kern).not.toBeDisabled();
    expect(kern).toHaveAccessibleDescription('Pflichtmodul – immer aktiv');
    expect(within(row('Kern')).getByText('Aktiv')).toBeInTheDocument();
    expect(within(row('Kern')).queryByText('Immer aktiv')).toBeNull();
    kern.focus();
    expect(kern).toHaveFocus();
    await userEvent.click(kern);
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(kern).toHaveAttribute('aria-checked', 'true');
    expect(api.calls.filter(c => c.method === 'PUT')).toHaveLength(0);
  });

  it('Raster: jede Zeile (Modul und Teilfunktion) Name · Status · Schalter in denselben Spalten; nur der Text eingerückt', async () => {
    setup();
    await screen.findByRole('switch', { name: 'Zeiterfassung aktiv' });
    const rows = [...document.querySelectorAll<HTMLElement>('.iam-mod-row')];
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      // gleiche Kinder in gleicher Reihenfolge: Name, Status, Schalter (+ Text) – Schalter in jeder Zeile, auch Pflichtmodul
      expect([...r.children].slice(0, 3).map(c => c.className)).toEqual(['iam-mod-name', 'iam-mod-status', 'iam-switch iam-mod-switch']);
      expect(within(r.querySelector('.iam-mod-status')!).getByText(/Aktiv|Aus|Nicht freigegeben/)).toBeInTheDocument();
    }
    const part = row('Korrekturanträge');
    expect(part).toHaveClass('iam-mod-row', 'iam-mod-part');
    // Teilfunktion: dasselbe Raster in der Karte ihres Moduls (Lage der Spalten im Browser: test/e2e/modules.spec.ts)
    expect(part.closest('.iam-mod')).toBe(row('Zeiterfassung').closest('.iam-mod'));
  });

  it('Sperrgründe einheitlich: nicht freigegeben, fehlendes Recht, Voraussetzung nicht freigegeben, Modul der Teilfunktion aus', async () => {
    const srv = server(initial().map(m => (m.key === 'zeit' ? { ...m, active: false } : m.key === 'lohn' ? { ...m, requires: ['projekte'] } : m)));
    setup({ srv });
    const sw = (n: string) => screen.getByRole('switch', { name: `${n} aktiv` });
    await screen.findByRole('switch', { name: 'Lohn aktiv' });
    for (const [n, why] of [['Kern', 'Pflichtmodul – immer aktiv'], ['Projekte', /nicht freigegeben/], ['Lohn', /Braucht «Projekte»/], ['Korrekturanträge', /Zuerst .*«Zeiterfassung»|«Zeiterfassung»/]] as const) {
      expect(sw(n), n).toHaveAttribute('aria-disabled', 'true');
      expect(sw(n), n).toHaveAccessibleDescription(why);
      expect(row(n).querySelector('.iam-mod-info .iam-mod-why')).not.toBeNull();
    }
    cleanup();
    setup({ me: { permissions: ['tenant:read'] } });
    expect(await screen.findByRole('switch', { name: 'Zeiterfassung aktiv' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('switch', { name: 'Kern aktiv' })).toHaveAccessibleDescription('Pflichtmodul – immer aktiv');
  });

  it('Aktivieren mit Voraussetzung: Hinweis «Aktiviert auch …», dann zuerst die Voraussetzung, je mit If-Match', async () => {
    const { srv } = setup();
    await userEvent.click(await screen.findByRole('switch', { name: 'Lohn aktiv' }));
    const dlg = await screen.findByRole('alertdialog', { name: '«Lohn» aktivieren' });
    expect(within(dlg).getByText('Aktiviert auch «Abwesenheiten» (Voraussetzung).')).toBeInTheDocument();
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Alle 2 aktivieren' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(srv.state.puts).toEqual([{ key: 'abwesenheit', active: true, ifMatch: 'W/"7"' }, { key: 'lohn', active: true, ifMatch: 'W/"8"' }]);
    expect(await screen.findByText('«Lohn» ist aktiv, mit «Abwesenheiten».')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Lohn aktiv' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('Aktivieren ohne Voraussetzungen: ohne Rückfrage; Teilfunktion gesperrt, solange ihr Modul aus ist', async () => {
    const items = initial().map(m => (m.key === 'zeit' || m.key === 'zeit.korrektur' ? { ...m, active: false, blockers: undefined } : m));
    const { srv } = setup({ srv: server(items) });
    const part = await screen.findByRole('switch', { name: 'Korrekturanträge aktiv' });
    expect(part).toHaveAttribute('aria-disabled', 'true');
    expect(part).toHaveAccessibleDescription('Zuerst «Zeiterfassung» aktivieren.');
    await userEvent.click(part);
    expect(srv.state.puts).toEqual([]);
    await userEvent.click(screen.getByRole('switch', { name: 'Abwesenheiten aktiv' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(srv.state.puts).toEqual([{ key: 'abwesenheit', active: true, ifMatch: 'W/"7"' }]));
  });

  it('Deaktivieren: Rückfrage mit Wirkung (Teilfunktionen, Rechte, Daten bleiben), Fokus auf «Abbrechen»; dann PUT', async () => {
    const { srv, api } = setup();
    await userEvent.click(await screen.findByRole('switch', { name: 'Zeiterfassung aktiv' }));
    const dlg = await screen.findByRole('alertdialog', { name: '«Zeiterfassung» deaktivieren' });
    expect(dlg).toHaveTextContent('«Zeiterfassung» verschwindet für alle in «Demo AG»:');
    expect(dlg).toHaveTextContent('Teilfunktionen «Korrekturanträge» sind nicht mehr verfügbar.');
    expect(dlg).toHaveTextContent('Die Rechte Zeit erfassen wirken nicht mehr');
    expect(dlg).toHaveTextContent('Die Daten bleiben erhalten');
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Deaktivieren' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(srv.state.puts).toEqual([{ key: 'zeit', active: false, ifMatch: 'W/"7"' }]);
    expect(await screen.findByText('«Zeiterfassung» ist deaktiviert. Die Daten bleiben erhalten.')).toBeInTheDocument();
    // Katalog neu: er enthält nur die Rechte aktiver Module
    await waitFor(() => expect(catalogCalls(api)).toBeGreaterThan(1));
  });

  it('Katalog nicht ladbar: Fehler mit «Erneut versuchen» statt «Keine Module»', async () => {
    let fail = true;
    setup({ routes: { 'GET /v1/authz/catalog': () => (fail ? json({ title: 'Interner Fehler', status: 500 }, 500) : json(catalog)) } });
    expect(await screen.findByRole('heading', { name: 'Interner Fehler' })).toBeInTheDocument();
    expect(screen.queryByText('Keine Module')).toBeNull();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByRole('switch', { name: 'Zeiterfassung aktiv' })).toBeInTheDocument();
  });

  it('Hindernisse: bekannte zeigt die Rückfrage ohne «Deaktivieren»; 409 hindernisse des Servers ebenso', async () => {
    const items = initial().map(m => (m.key === 'zeit' ? { ...m, blockers: [{ key: 'korr', text: '3 offene Korrekturanträge – zuerst entscheiden', anzahl: 3 }] } : m.key === 'abwesenheit' ? { ...m, active: true, blockers: [] } : m));
    setup({ srv: server(items, { put: key => (key === 'abwesenheit' ? json({ title: 'Konflikt', status: 409, reason: 'hindernisse', hindernisse: [{ key: 'ferien', text: '2 offene Ferienanträge – zuerst entscheiden' }] }, 409) : null) }) });
    await userEvent.click(await screen.findByRole('switch', { name: 'Zeiterfassung aktiv' }));
    let dlg = await screen.findByRole('alertdialog', { name: '«Zeiterfassung» deaktivieren' });
    expect(within(dlg).getByText('Zuerst erledigen:')).toBeInTheDocument();
    expect(within(dlg).getByText('3 offene Korrekturanträge – zuerst entscheiden')).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: 'Deaktivieren' })).toBeNull();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Schliessen' }));

    await userEvent.click(screen.getByRole('switch', { name: 'Abwesenheiten aktiv' }));
    dlg = await screen.findByRole('alertdialog', { name: '«Abwesenheiten» deaktivieren' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Deaktivieren' }));
    expect(await within(dlg).findByText('2 offene Ferienanträge – zuerst entscheiden')).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: 'Deaktivieren' })).toBeNull();
  });

  it('noch gebraucht von einem aktiven Modul: kein Deaktivieren', async () => {
    const items = initial().map(m => (m.key === 'lohn' || m.key === 'abwesenheit' ? { ...m, active: true } : m));
    setup({ srv: server(items) });
    await userEvent.click(await screen.findByRole('switch', { name: 'Zeiterfassung aktiv' }));
    const dlg = await screen.findByRole('alertdialog');
    expect(dlg).toHaveTextContent('Noch gebraucht von «Lohn» – zuerst dort deaktivieren.');
    expect(within(dlg).queryByRole('button', { name: 'Deaktivieren' })).toBeNull();
  });

  it('412: Hinweis, dass jemand anderes etwas geändert hat, mit «Neu laden»', async () => {
    setup({ srv: server(initial(), { put: () => json({ title: 'Version', status: 412 }, 412) }) });
    await userEvent.click(await screen.findByRole('switch', { name: 'Abwesenheiten aktiv' }));
    expect(await screen.findByText('Inzwischen hat jemand anderes etwas geändert. Lade neu und prüfe noch einmal.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Neu laden' })).toBeInTheDocument();
  });

  it('nur «Organisation lesen»: Hinweis, Schalter gesperrt mit Grund', async () => {
    const { srv } = setup({ me: { roles: ['viewer'], permissions: ['tenant:read', 'note:read'] } });
    const sw = await screen.findByRole('switch', { name: 'Lohn aktiv' });
    expect(screen.getByRole('note')).toHaveTextContent('Ein- und ausschalten darf, wer «Organisation verwalten» hat.');
    expect(sw).toHaveAttribute('aria-disabled', 'true');
    expect(sw).toHaveAccessibleDescription('Nur mit «Organisation verwalten»');
    await userEvent.click(sw);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(srv.state.puts).toEqual([]);
  });

  it('Tastatur: Leertaste schaltet, Esc schliesst die Rückfrage, Fokus zurück auf den Schalter; Enter bestätigt', async () => {
    const { srv } = setup();
    const sw = await screen.findByRole('switch', { name: 'Zeiterfassung aktiv' });
    sw.focus();
    await userEvent.keyboard(' ');
    const dlg = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(sw).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    const again = await screen.findByRole('alertdialog');
    await userEvent.tab();
    expect(within(again).getByRole('button', { name: 'Deaktivieren' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(srv.state.puts.map(p => p.key)).toEqual(['zeit']));
  });

  it('Schublade: Name öffnet Einzelheiten (Voraussetzungen, gebraucht von, Teilfunktionen, Rechte)', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Zeiterfassung' }));
    const sheet = await screen.findByRole('dialog', { name: 'Zeiterfassung' });
    expect(sheet).toHaveTextContent('Gebraucht von«Lohn»');
    expect(sheet).toHaveTextContent('Korrekturanträge (Aktiv)');
    expect(sheet).toHaveTextContent('RechteZeit erfassen');
    expect(within(sheet).getByRole('button', { name: 'Deaktivieren' })).toBeInTheDocument();
    expect(await axeProblems(sheet)).toEqual([]);
  });

  it('Schublade eines Pflichtmoduls wie die der anderen: Status «Aktiv», «Deaktivieren» gesperrt mit Grund', async () => {
    const { api } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Kern' }));
    const sheet = await screen.findByRole('dialog', { name: 'Kern' });
    expect(within(sheet).getByText('Aktiv')).toBeInTheDocument();
    const off = within(sheet).getByRole('button', { name: 'Deaktivieren' });
    expect(off).toHaveAttribute('aria-disabled', 'true');
    expect(off).toHaveAccessibleDescription('Pflichtmodul – immer aktiv');
    await userEvent.click(off);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.calls.filter(c => c.method === 'PUT')).toHaveLength(0);
    expect(await axeProblems(sheet)).toEqual([]);
  });

  it('Modell ohne Module: Hinweis statt Liste, nichts abgefragt', async () => {
    const api = mockIamApi({}, { catalog: CATALOG });
    vi.stubGlobal('fetch', api.fetch);
    render(<StaticIam><ModulesPage /></StaticIam>);
    expect(await screen.findByText('Keine Module')).toBeInTheDocument();
    expect(api.calls.some(c => new URL(c.url).pathname === '/v1/tenant/modules')).toBe(false);
  });
});

describe('Sitzung, Route und Navigation', () => {
  function Probe() {
    const { modules, hasModule } = useIam();
    return <output data-testid="probe">{`${modules.join(',')}|${hasModule('zeit')}|${hasModule('lohn')}|${hasModule('zeit.korrektur')}`}</output>;
  }

  it('useIam().modules und hasModule; ältere Server ohne modules: alles aktiv', () => {
    vi.stubGlobal('fetch', mockIamApi().fetch);
    const { unmount } = render(<StaticIam me={{ modules: ['kern', 'zeit', 'zeit.korrektur'] }}><Probe /></StaticIam>);
    expect(screen.getByTestId('probe')).toHaveTextContent('kern,zeit,zeit.korrektur|true|false|true');
    unmount();
    render(<StaticIam><Probe /></StaticIam>);
    expect(screen.getByTestId('probe')).toHaveTextContent('|true|true|true');
  });

  it('Route «modules» unter /einstellungen/module mit tenant:read; mit features.modules false ohne', () => {
    const r = makeIamRoutes().find(x => x.id === 'modules')!;
    expect([r.path, r.need, r.nav, r.title, r.icon]).toEqual(['/einstellungen/module', { perm: 'tenant:read' }, true, 'Module', 'layers']);
    expect(makeIamRoutes({ modules: '/x/module' }).find(x => x.id === 'modules')!.path).toBe('/x/module');
    expect(makeIamRoutes({}, { modules: false }).some(x => x.id === 'modules')).toBe(false);
  });

  it('Navigation: «Module» nur mit Modulen im Modell', async () => {
    vi.stubGlobal('fetch', mockIamApi({}, { catalog }).fetch);
    const { unmount } = render(<StaticIam config={{ features: { platform: false } }}><IamNav /></StaticIam>);
    expect(await screen.findByRole('link', { name: 'Module' })).toHaveAttribute('href', '/einstellungen/module');
    unmount();
    vi.stubGlobal('fetch', mockIamApi({}, { catalog: CATALOG }).fetch);
    render(<StaticIam config={{ features: { platform: false } }}><IamNav /></StaticIam>);
    expect(await screen.findByRole('link', { name: 'Mitglieder' })).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole('link', { name: 'Module' })).toBeNull();
  });
});

describe('Plattform-Administration: Module einer Organisation', () => {
  let lastApi: { calls: Request[] } | null = null;
  function platform(items: TenantModule[], put?: (key: string, allowed: boolean, force: boolean) => Response | null) {
    let state = items;
    const puts: { key: string; allowed: boolean; force: boolean }[] = [];
    const routes: Record<string, MockHandler> = { 'GET /v1/platform/organizations/muster/modules': () => json({ items: state }, 200, { etag: 'W/"3"' }) };
    for (const m of items) {
      routes[`PUT /v1/platform/organizations/muster/modules/${m.key}`] = async req => {
        const { allowed } = await req.json() as { allowed: boolean };
        const force = new URL(req.url).searchParams.get('force') === 'true';
        puts.push({ key: m.key, allowed, force });
        const r = put?.(m.key, allowed, force);
        if (r) return r;
        state = state.map(x => (x.key === m.key ? { ...x, allowed, active: allowed && x.active } : x));
        return json(state.find(x => x.key === m.key));
      };
    }
    const api = mockIamApi(routes, { catalog });
    vi.stubGlobal('fetch', api.fetch);
    render(<StaticIam><ModulesSection alias="muster" orgLabel="Muster GmbH" /></StaticIam>);
    lastApi = api;
    return puts;
  }

  it('freigeben direkt; entziehen mit Wirkung, bei Hindernissen «Trotzdem entziehen» (force); axe', async () => {
    const items = initial().map(m => (m.key === 'zeit' ? { ...m, blockers: [{ key: 'korr', text: '3 offene Korrekturanträge – zuerst entscheiden' }] } : m));
    const puts = platform(items);
    const table = await screen.findByRole('table', { name: 'Module von Muster GmbH' });
    expect(within(table).getAllByRole('row')).toHaveLength(items.length + 1);
    // Pflichtmodul wie die anderen: Status «Aktiv», «Entziehen» gesperrt mit Grund
    const kern = within(table).getByRole('row', { name: /Kern/ });
    expect(within(kern).getByText('Aktiv')).toBeInTheDocument();
    const lockedRevoke = within(kern).getByRole('button', { name: 'Kern entziehen' });
    expect(lockedRevoke).toHaveAttribute('aria-disabled', 'true');
    expect(lockedRevoke).toHaveAccessibleDescription('Pflichtmodul – immer aktiv');
    await userEvent.click(lockedRevoke);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await axeProblems()).toEqual([]);
    await userEvent.click(within(table).getByRole('button', { name: 'Projekte freigeben' }));
    await waitFor(() => expect(puts).toEqual([{ key: 'projekte', allowed: true, force: false }]));
    // auch Katalog (und Sitzung) neu: es kann die Organisation dieses Tabs sein
    await waitFor(() => expect(catalogCalls(lastApi!)).toBeGreaterThan(1));
    expect(await screen.findByText('«Projekte» ist für «Muster GmbH» freigegeben.')).toBeInTheDocument();

    await userEvent.click(within(table).getByRole('button', { name: 'Zeiterfassung entziehen' }));
    const dlg = await screen.findByRole('alertdialog', { name: '«Zeiterfassung» für «Muster GmbH» entziehen' });
    expect(dlg).toHaveTextContent('verschwindet für alle in «Muster GmbH»');
    expect(within(dlg).getByText('3 offene Korrekturanträge – zuerst entscheiden')).toBeInTheDocument();
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Trotzdem entziehen' }));
    await waitFor(() => expect(puts.at(-1)).toEqual({ key: 'zeit', allowed: false, force: true }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('409 hindernisse beim Entziehen ohne bekannte Hindernisse: dann «Trotzdem entziehen»', async () => {
    const puts = platform(initial(), (key, _a, force) => (key === 'abwesenheit' && !force ? json({ title: 'Konflikt', status: 409, reason: 'hindernisse', hindernisse: [{ key: 'f', text: '2 offene Ferienanträge' }] }, 409) : null));
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('button', { name: 'Abwesenheiten entziehen' }));
    const dlg = await screen.findByRole('alertdialog');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Entziehen' }));
    expect(await within(dlg).findByText('2 offene Ferienanträge')).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Trotzdem entziehen' }));
    await waitFor(() => expect(puts.map(p => p.force)).toEqual([false, true]));
  });

  it('ohne Module im Modell: kein Abschnitt', async () => {
    const api = mockIamApi({}, { catalog: CATALOG });
    vi.stubGlobal('fetch', api.fetch);
    const { container } = render(<StaticIam><ModulesSection alias="muster" orgLabel="Muster GmbH" /></StaticIam>);
    await waitFor(() => expect(api.calls.some(c => new URL(c.url).pathname === '/v1/authz/catalog')).toBe(true));
    await new Promise(r => setTimeout(r, 20));
    expect(container.querySelector('section')).toBeNull();
  });
});
