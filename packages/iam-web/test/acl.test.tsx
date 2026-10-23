/**
 * Zugriff: Regeln (wirkungslose Einträge, Vorschau, Filter, Gruppierung) als reine Funktionen und die Seite mit Guard,
 * Reitern, leerem Zustand, Filtern in der URL, Gruppierung, Dialog (passende Rechte, Feldfehler, Vorschau), «Rechte
 * prüfen» (Suchparameter `ansicht`/`rolle`/`client`) und Hinweis an einer Ressource. Aus vollholz/assets
 * `web/src/features/acl/acl.test.tsx`: die Regeln mit dem Katalog von Assets, die Seite mit der Notiz-App
 * (Ordner → Notiz) und dem Adapter `staticResources`.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AclHint, effectOf, filterEntries, groupByResource, ineffectiveReason, permissionsFor, previewEntry, type AclLike, type AuthzCatalog, type IamConfig, type Me } from '../src/index.ts';
import { AccessScreen, groupPathError } from '../src/pages/index.ts';
import { CATALOG, json, mockIamApi, staticResources, StaticIam, type MockHandler } from '../src/testing/index.tsx';
import { axeProblems } from './render.tsx';

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

// ------------------------------------------------------------------------------------------------ Regeln (Katalog Assets)

const OBJECT = ['tenant', 'schema', 'type', 'object'];
const perm = (key: string, label: string, group: string, resources: string[], adminOnly = false) => ({ key, label, group, description: '', resources, adminOnly });
const role = (key: string, label: string, permissions: string[]) => ({ key, label, description: '', permissions, adminOnly: key === 'org-admin' });
// Auszug aus assets src/platform/authz/permissions.ts; Objekte sind das Blatt der Kette
const ASSETS: AuthzCatalog = {
  permissions: [
    perm('object:read', 'Objekte lesen', 'objects', OBJECT), perm('object:write', 'Objekte ändern', 'objects', OBJECT),
    perm('schema:write', 'Schemas ändern', 'schemas', ['tenant', 'schema', 'type']),
    perm('connection:sync', 'Abgleich starten', 'integrations', ['tenant', 'connection']),
    perm('webhook:admin', 'Webhooks verwalten', 'webhooks', ['tenant']),
    perm('acl:read', 'Zugriff lesen', 'access', ['tenant']), perm('acl:admin', 'Zugriff verwalten', 'access', ['tenant'], true),
  ],
  groups: [{ key: 'schemas', label: 'Schemas' }, { key: 'objects', label: 'Objekte' }, { key: 'integrations', label: 'Verbindungen und Zuordnungen' }, { key: 'webhooks', label: 'Webhooks' }, { key: 'access', label: 'Zugriff' }],
  roles: [
    role('org-admin', 'Organisations-Admin', ['object:read', 'object:write', 'schema:write', 'connection:sync', 'webhook:admin', 'acl:read', 'acl:admin']),
    role('schema-admin', 'Schema-Admin', ['object:read', 'schema:write']),
    role('integration-admin', 'Integrations-Admin', ['object:read', 'connection:sync', 'webhook:admin']),
    role('editor', 'Bearbeiter:in', ['object:read', 'object:write']),
    role('reviewer', 'Prüfer:in', ['object:read', 'object:write']),
    role('viewer', 'Leser:in', ['object:read']),
    role('auditor', 'Auditor:in', ['object:read', 'acl:read']),
  ],
  scopes: [{ key: 'assets:read', text: 'Katalog lesen', permissions: ['object:read'] }],
  resourceTypes: [{ key: 'tenant', label: 'Organisation' }, { key: 'schema', label: 'Schema' }, { key: 'type', label: 'Objekttyp' }, { key: 'object', label: 'Objekt', leaf: true }, { key: 'connection', label: 'Verbindung' }, { key: 'credential', label: 'Credential' }],
};

const S1 = '00000000-0000-4000-8000-000000000051';
const T1 = '00000000-0000-4000-8000-000000000071';
const entry = (over: Partial<AclLike> & { id?: string }) => ({
  id: over.id ?? Math.random().toString(36).slice(2), resourceType: 'schema', resourceId: S1, principalType: 'role', principalRef: 'editor', permission: 'object:write', effect: 'restrict',
  createdAt: new Date().toISOString(), createdBy: null, ...over,
});
const who = (e: Pick<AclLike, 'principalType' | 'principalRef'>) => (e.principalType === 'role' ? `Personen mit Rolle «${ASSETS.roles.find(r => r.key === e.principalRef)?.label}»` : `Mitglieder der Gruppe «${e.principalRef}»`);
const schemaChain = [{ type: 'tenant', id: null }, { type: 'schema', id: S1 }];
const LEAVES = ['object', 'connection', 'credential'];

describe('Regeln der Zugriffsregeln', () => {
  it('erkennt wirkungslose Einträge wie die 422-Prüfung', () => {
    expect(ineffectiveReason(entry({}), ASSETS)).toBeNull();
    expect(ineffectiveReason(entry({ permission: 'acl:admin', resourceType: 'tenant', resourceId: null }), ASSETS)).toMatch(/nur die Rolle «Organisations-Admin»/);
    expect(ineffectiveReason(entry({ permission: 'webhook:admin' }), ASSETS)).toBe('Das Recht «Webhooks verwalten» wirkt nicht auf «Schema»; passend: Organisation.');
    expect(ineffectiveReason(entry({ principalRef: 'org-admin' }), ASSETS)).toMatch(/ausgenommen/);
    expect(ineffectiveReason(entry({ principalRef: 'gibtsnicht' }), ASSETS)).toMatch(/gibt es nicht/);
  });

  it('bietet je Ressourcentyp nur passende Rechte ohne Rechte nur von org-admin', () => {
    expect(permissionsFor(ASSETS, 'schema').map(p => p.key)).toEqual(['object:read', 'object:write', 'schema:write']);
    expect(permissionsFor(ASSETS, 'connection').map(p => p.key)).toEqual(['connection:sync']);
    expect(permissionsFor(ASSETS, 'tenant').map(p => p.key)).not.toContain('acl:admin');
  });

  it('Vorschau «beschränken auf»: nur die Rolle behält das Recht, andere verlieren es, org-admin ist ausgenommen', () => {
    const p = previewEntry({ draft: entry({}), entries: [], chain: schemaChain, catalog: ASSETS, resourceName: 'Server', who });
    expect(p.sentence).toBe('Auf Schema «Server» behalten nur Personen mit Rolle «Bearbeiter:in» das Recht «Objekte ändern» (auch auf allem darunter).');
    expect(p.roles).toEqual([
      { key: 'editor', label: 'Bearbeiter:in', outcome: 'keeps' },
      { key: 'reviewer', label: 'Prüfer:in', outcome: 'loses' },
      { key: 'org-admin', label: 'Organisations-Admin', outcome: 'exempt' },
    ]);
    expect(p.others).toBe(0);
    expect(p.individual).toBe(false);
    expect(p.unchanged).toBe(false);
  });

  it('Vorschau bezieht bestehende Einträge derselben Ressource und übergeordneter Stufen ein', () => {
    const existing = [entry({ principalRef: 'reviewer' }), entry({ resourceType: 'tenant', resourceId: null, effect: 'deny', principalRef: 'editor', permission: 'object:read' })];
    const p = previewEntry({ draft: entry({ principalType: 'group', principalRef: '/orgs/demo/team' }), entries: existing, chain: schemaChain, catalog: ASSETS, resourceName: 'Server', who });
    expect(p.sentence).toBe('Auf Schema «Server» behalten nur Personen mit Rolle «Prüfer:in» und Mitglieder der Gruppe «/orgs/demo/team» das Recht «Objekte ändern» (auch auf allem darunter).');
    expect(p.others).toBe(1);
    expect(p.individual).toBe(true);
    // editor hatte es wegen des bestehenden «beschränken auf» für reviewer schon vorher nicht
    expect(p.roles.find(r => r.key === 'editor')?.outcome).toBe('without');
    expect(p.roles.find(r => r.key === 'reviewer')?.outcome).toBe('keeps');

    const viewer = previewEntry({ draft: entry({ permission: 'object:read', principalRef: 'viewer' }), entries: existing, chain: schemaChain, catalog: ASSETS, resourceName: 'Server', who });
    // Verbot auf der Organisation wirkt weiter
    expect(viewer.roles.find(r => r.key === 'editor')?.outcome).toBe('without');
    expect(viewer.roles.find(r => r.key === 'auditor')?.outcome).toBe('loses');
  });

  it('Vorschau «verbieten» und auf der ganzen Organisation; ohne Stufe darunter kein Zusatz', () => {
    const p = previewEntry({ draft: entry({ effect: 'deny', resourceType: 'tenant', resourceId: null }), entries: [], chain: [{ type: 'tenant', id: null }], catalog: ASSETS, resourceName: 'ganze Organisation', who });
    expect(p.sentence).toBe('In der ganzen Organisation verlieren Personen mit Rolle «Bearbeiter:in» das Recht «Objekte ändern» (auch auf allem darunter).');
    expect(p.roles.map(r => [r.key, r.outcome])).toEqual([['editor', 'loses'], ['reviewer', 'keeps'], ['org-admin', 'exempt']]);
    const one = previewEntry({ draft: entry({ effect: 'deny', principalType: 'client', principalRef: 'ci', resourceType: 'connection', permission: 'connection:sync' }), entries: [], chain: [{ type: 'tenant', id: null }, { type: 'connection', id: S1 }], catalog: ASSETS, resourceName: 'Jira', who: () => 'Client «ci»', leaves: LEAVES });
    expect(one.sentence).toBe('Auf Verbindung «Jira» verliert Client «ci» das Recht «Abgleich starten».');
  });

  it('Wirkungen: «allow» ist der alte Name von «restrict»', () => {
    expect(effectOf({ effect: 'allow' })).toBe('restrict');
    expect(effectOf({ effect: 'restrict' })).toBe('restrict');
    expect(effectOf({ effect: 'grant' })).toBe('grant');
    expect(effectOf({ effect: 'deny' })).toBe('deny');
  });

  it('Freigaben: nicht auf dem Blatt (aus dem Katalog oder vom Adapter) und nie für Rechte nur von org-admin', () => {
    expect(ineffectiveReason(entry({ effect: 'grant' }), ASSETS)).toBeNull();
    expect(ineffectiveReason(entry({ effect: 'grant', resourceType: 'object', resourceId: T1 }), ASSETS)).toBe('Freigaben gelten für Bereiche, nicht für einzelne Ressourcen vom Typ «Objekt».');
    // Angabe der App geht vor (`resources.noGrant`)
    expect(ineffectiveReason(entry({ effect: 'grant', resourceType: 'object', resourceId: T1 }), ASSETS, [])).toBeNull();
    // Beschränken und Verbieten auf einem Objekt wirken weiter
    expect(ineffectiveReason(entry({ effect: 'restrict', resourceType: 'object', resourceId: T1 }), ASSETS)).toBeNull();
    expect(ineffectiveReason(entry({ effect: 'deny', resourceType: 'object', resourceId: T1 }), ASSETS)).toBeNull();
    const adminGrant = { effect: 'grant', permission: 'acl:admin', resourceType: 'tenant', resourceId: null };
    expect(ineffectiveReason(entry(adminGrant), ASSETS)).toBe('Das Recht «Zugriff verwalten» hat nur die Rolle «Organisations-Admin» und lässt sich nicht freigeben.');
    expect(ineffectiveReason(entry({ ...adminGrant, principalType: 'client', principalRef: 'ci' }), ASSETS)).toMatch(/lässt sich nicht freigeben/);
  });

  it('Rechte nur von org-admin: verbieten oder beschränken wirkt nur für Maschinen-Clients (nicht ausgenommen)', () => {
    const adminDeny = { effect: 'deny', permission: 'acl:admin', resourceType: 'tenant', resourceId: null };
    expect(ineffectiveReason(entry({ ...adminDeny, principalType: 'client', principalRef: 'ci' }), ASSETS)).toBeNull();
    expect(ineffectiveReason(entry({ ...adminDeny, effect: 'restrict', principalType: 'client', principalRef: 'ci' }), ASSETS)).toBeNull();
    expect(ineffectiveReason(entry({ ...adminDeny, principalType: 'role', principalRef: 'editor' }), ASSETS)).toBe('Das Recht «Zugriff verwalten» hat nur die Rolle «Organisations-Admin»; Personen damit sind von Zugriffsregeln ausgenommen.');
    expect(ineffectiveReason(entry({ ...adminDeny, principalType: 'user', principalRef: 'sub-anna' }), ASSETS)).toMatch(/Personen damit sind von Zugriffsregeln ausgenommen/);
    // auch für einen Client nur auf passenden Ressourcen
    expect(ineffectiveReason(entry({ ...adminDeny, principalType: 'client', principalRef: 'ci', resourceType: 'schema', resourceId: S1 }), ASSETS)).toMatch(/wirkt nicht auf «Schema»/);
  });

  it('passende Rechte je Wirkung und Wer: Rechte nur von org-admin nur beim Verbieten oder Beschränken für einen Client', () => {
    const keys = (o: Parameters<typeof permissionsFor>[2]) => permissionsFor(ASSETS, 'tenant', o).map(p => p.key);
    expect(keys({ effect: 'deny', principalType: 'client' })).toContain('acl:admin');
    expect(keys({ effect: 'restrict', principalType: 'client' })).toContain('acl:admin');
    expect(keys({ effect: 'grant', principalType: 'client' })).not.toContain('acl:admin');
    expect(keys({ effect: 'deny', principalType: 'role' })).not.toContain('acl:admin');
    expect(keys({ effect: 'deny', principalType: 'user' })).not.toContain('acl:admin');
    expect(keys({ effect: 'grant', principalType: 'client' })).toEqual(['object:read', 'object:write', 'schema:write', 'connection:sync', 'webhook:admin', 'acl:read']);
  });

  it('Vorschau «freigeben»: die Rolle erhält das Recht, auch ohne Rolle mit diesem Recht', () => {
    const p = previewEntry({ draft: entry({ effect: 'grant', principalRef: 'viewer' }), entries: [], chain: schemaChain, catalog: ASSETS, resourceName: 'Server', who });
    expect(p.sentence).toBe('Auf Schema «Server» erhalten Personen mit Rolle «Leser:in» das Recht «Objekte ändern» (auch auf allem darunter), auch ohne Rolle mit diesem Recht. Verbote und Beschränkungen gelten weiter.');
    expect(p.roles).toEqual([
      { key: 'editor', label: 'Bearbeiter:in', outcome: 'keeps' },
      { key: 'reviewer', label: 'Prüfer:in', outcome: 'keeps' },
      { key: 'viewer', label: 'Leser:in', outcome: 'gains' },
      { key: 'org-admin', label: 'Organisations-Admin', outcome: 'exempt' },
    ]);
    expect(p.unchanged).toBe(false);
    expect(p.individual).toBe(false);
    // eine Person: Einzahl
    const one = previewEntry({ draft: entry({ effect: 'grant', principalType: 'user', principalRef: 'sub-carla', resourceType: 'connection', permission: 'connection:sync' }), entries: [], chain: [{ type: 'tenant', id: null }, { type: 'connection', id: S1 }], catalog: ASSETS, resourceName: 'Jira', who: () => '«Carla»', leaves: LEAVES });
    expect(one.sentence).toMatch(/^Auf Verbindung «Jira» erhält «Carla» das Recht «Abgleich starten», auch ohne Rolle/);
    expect(one.individual).toBe(true);
  });

  it('Vorschau «freigeben»: bestehende Beschränkungen und Verbote gelten weiter (auch alte «allow»-Einträge)', () => {
    const restricted = [entry({ principalRef: 'editor', effect: 'allow' })];
    const p = previewEntry({ draft: entry({ effect: 'grant', principalRef: 'viewer' }), entries: restricted, chain: schemaChain, catalog: ASSETS, resourceName: 'Server', who });
    expect(p.roles.find(r => r.key === 'viewer')?.outcome).toBe('without');
    expect(p.roles.find(r => r.key === 'reviewer')?.outcome).toBe('without');
    expect(p.unchanged).toBe(true);
    const denied = [entry({ resourceType: 'tenant', resourceId: null, effect: 'deny', principalRef: 'viewer' })];
    const q = previewEntry({ draft: entry({ effect: 'grant', principalRef: 'viewer' }), entries: denied, chain: schemaChain, catalog: ASSETS, resourceName: 'Server', who });
    expect(q.roles.find(r => r.key === 'viewer')?.outcome).toBe('without');
  });

  it('filtert und gruppiert nach Ressource (Organisation zuerst)', () => {
    const items = [entry({ id: 'a' }), entry({ id: 'b', resourceType: 'tenant', resourceId: null, permission: 'object:read' }), entry({ id: 'c', principalRef: 'viewer', permission: 'object:read' })];
    expect(groupByResource(items, ASSETS).map(g => [g.resourceType, g.items.map(i => i.id)])).toEqual([['tenant', ['b']], ['schema', ['a', 'c']]]);
    expect(filterEntries(items, { permission: 'object:read', who: 'role:viewer' }).map(i => i.id)).toEqual(['c']);
    expect(filterEntries(items, { resourceType: 'schema', resourceId: S1 }).map(i => i.id)).toEqual(['a', 'c']);
  });

  it('prüft Gruppenpfade', () => {
    expect(groupPathError('/orgs/demo/team')).toBeNull();
    expect(groupPathError('orgs/demo')).toMatch(/«\/» am Anfang/);
    expect(groupPathError('/orgs/')).toMatch(/ohne «\/» am Ende/);
  });
});

// ------------------------------------------------------------------------------------------- Seite (Notiz-App, Ordner)

const F1 = '00000000-0000-4000-8000-0000000000f1';
const F2 = '00000000-0000-4000-8000-0000000000f2';
const N1 = '00000000-0000-4000-8000-0000000000a1';
const RESOURCES = staticResources({ folder: { [F1]: 'Projekte', [F2]: 'Archiv' }, note: { [N1]: 'Protokoll' } }, { parents: { [`note:${N1}`]: { type: 'folder', id: F1 } } });
const note = (over: Partial<AclLike> & { id?: string }) => entry({ resourceType: 'folder', resourceId: F1, permission: 'note:write', ...over });
const ENTRIES = [
  note({ id: 'e1' }),
  note({ id: 'e2', permission: 'audit:read' }),
  note({ id: 'e3', resourceType: 'tenant', resourceId: null, permission: 'note:read', principalRef: 'viewer', effect: 'deny' }),
];
const EFFECTIVE = (simulated: boolean, roles: string[]) => ({
  principal: { id: '', kind: 'user', name: simulated ? 'Simulation' : 'Anna Admin', clientId: null }, simulated, source: simulated ? 'simulation' : 'token', roles, groups: [], scopes: [],
  permissions: ['note:read'], granted: [], resources: [{ resourceType: 'folder', resourceId: F1, permission: 'note:write', allowed: !simulated }],
});
const CLIENTS = { items: [
  { clientId: 'ci-bot', description: 'Import', createdAt: '', createdBy: null, lastUsedAt: new Date().toISOString(), lastRoles: ['editor'], lastScopes: ['notes:read'] },
  { clientId: 'neu', description: '', createdAt: '', createdBy: null, lastUsedAt: null, lastRoles: null, lastScopes: null },
] };
const ADMIN: Partial<Me> = { roles: ['org-admin'] };
const AUDITOR: Partial<Me> = { roles: ['auditor'], permissions: ['tenant:read', 'audit:read', 'acl:read'] };
const NO_CLIENTS: Partial<Me> = { roles: ['org-admin'], permissions: CATALOG.roles[0]!.permissions.filter(p => p !== 'members:admin') };

function routes(over: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    'GET /v1/acl': () => json({ items: ENTRIES }),
    'GET /v1/acl/effective': req => { const roles = new URL(req.url).searchParams.getAll('roles'); return json(EFFECTIVE(roles.length > 0, roles.length ? roles : ['org-admin'])); },
    'GET /v1/admin/clients': () => json(CLIENTS),
    ...over,
  };
}

function setup(path: string, o: { me?: Partial<Me>; routes?: Record<string, MockHandler>; config?: Partial<IamConfig>; ui?: ReactElement } = {}) {
  window.history.replaceState(null, '', path);
  const api = mockIamApi(o.routes ?? routes());
  vi.stubGlobal('fetch', api.fetch);
  return { ...api, ...render(<StaticIam me={o.me ?? ADMIN} config={o.config ?? { resources: RESOURCES }}>{o.ui ?? <AccessScreen />}</StaticIam>) };
}
const search = () => Object.fromEntries(new URLSearchParams(window.location.search));
const effCalls = (calls: Request[]) => calls.filter(c => new URL(c.url).pathname === '/v1/acl/effective');
const openAdd = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Zugriffsregel hinzufügen' }));
  return screen.findByRole('dialog', { name: 'Zugriffsregel in «Demo AG» hinzufügen' });
};
/** Ressource über die Auswahl des Adapters wählen. */
const pickFolder = async (dlg: HTMLElement, name = 'Projekte') => {
  await userEvent.click(within(dlg).getByRole('button', { name: 'Ordner' }));
  const picker = await screen.findByRole('dialog', { name: 'Ordner wählen' });
  await userEvent.click(await within(picker).findByRole('option', { name: new RegExp(name) }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ordner wählen' })).toBeNull());
};

describe('Seite «Zugriff»', () => {
  it('ohne acl:read: «Recht fehlt» mit den Rollen aus dem Katalog, keine Abfrage der Einträge', async () => {
    const { calls } = setup('/verwalten/zugriff', { me: { roles: ['viewer'], permissions: ['tenant:read', 'note:read'] } });
    expect(await screen.findByText(/fehlt dir das Recht «Zugriff lesen»\. Es gehört zu den Rollen «Ordner-Admin», «Prüfer:in» und «Organisations-Admin»/)).toBeInTheDocument();
    expect(calls.some(c => new URL(c.url).pathname === '/v1/acl')).toBe(false);
  });

  it('gruppiert nach Ressource mit Namen des Adapters, markiert wirkungslose Einträge und filtert über die URL', async () => {
    setup('/verwalten/zugriff');
    const table = await screen.findByRole('table', { name: 'Zugriffsregeln' });
    const groups = within(table).getAllByRole('columnheader').filter(h => h.getAttribute('scope') === 'colgroup');
    expect(groups.map(g => g.textContent)).toEqual(['Ganze Organisation1', 'Ordner Projekte2']);
    expect(within(table).getAllByText('Bearbeiter:in').length).toBeGreaterThan(0);
    const bad = within(table).getByText('wirkungslos').closest('tr')!;
    expect(bad).toHaveTextContent('Protokoll lesen');
    expect(bad).toHaveTextContent('wirkt nicht auf «Ordner»');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Recht:' }), 'note:read');
    await waitFor(() => expect(search()).toEqual({ permission: 'note:read' }));
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('1 von 3')).toBeInTheDocument();
    expect(await axeProblems(document.body)).toEqual([]);
  });

  it('übernimmt den Filter aus der URL (Link aus dem Hinweis); sichtbare Beschriftungen, keine Fachbegriffe', async () => {
    setup(`/verwalten/zugriff?resourceType=folder&resourceId=${F1}`);
    expect(await screen.findByText('2 von 3')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Einzeln:' })).toHaveValue(F1);
    expect(screen.getByText('Einzeln:')).not.toHaveClass('iam-sr');
    expect(screen.getByRole('combobox', { name: 'Wer:' })).toHaveDisplayValue('alle');
    expect(screen.queryByText(/Principal|ACL|Mandant|Tenant/)).toBeNull();
  });

  it('Dialog: passende Rechte je Ressource, org-admin nicht wählbar, Vorschau und Feldfehler am Feld', async () => {
    const { calls } = setup('/verwalten/zugriff', { routes: routes({ 'POST /v1/acl': () => json({ title: 'Die Eingabe ist ungültig.', status: 422, detail: 'Die Zugriffsregel würde nie wirken.', errors: [{ path: '/principalRef', message: 'Unbekannte Rolle' }] }, 422) }) });
    const dlg = await openAdd();
    const permSel = within(dlg).getByRole('combobox', { name: 'Recht' });
    expect(within(permSel).getAllByRole('option').map(o => o.getAttribute('value'))).toEqual(['note:read', 'note:write', 'note:delete', 'folder:admin']);
    expect(within(within(dlg).getByRole('combobox', { name: 'Rolle' })).queryByRole('option', { name: 'Organisations-Admin' })).toBeNull();
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Ressource' }), 'tenant');
    expect(within(within(dlg).getByRole('combobox', { name: 'Recht' })).getAllByRole('option').map(o => o.getAttribute('value'))).toEqual(['tenant:read', 'note:read', 'note:write', 'note:delete', 'folder:admin', 'acl:read', 'audit:read']);
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Ressource' }), 'folder');
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Recht' }), 'note:write');
    await pickFolder(dlg);
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Rolle' }), 'folder-admin');
    const preview = within(dlg).getByRole('status', { name: 'Vorschau' });
    expect(preview).toHaveTextContent('Auf Ordner «Projekte» behalten nur Personen mit Rolle «Bearbeiter:in» und Personen mit Rolle «Ordner-Admin» das Recht «Notizen ändern» (auch auf allem darunter).');
    expect(preview).toHaveTextContent('Berücksichtigt eine bestehende Zugriffsregel');
    // Ordner-Admin hatte es wegen e1 (nur Bearbeiter:in) nicht mehr und erhält es mit der neuen Zugriffsregel zurück
    expect(within(preview).getByRole('list', { name: 'Rollen danach' })).toHaveTextContent('erhält es Ordner-Adminbehält es Bearbeiter:inausgenommen, behält es Organisations-Admin');
    expect(await axeProblems(dlg)).toEqual([]);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    expect(await within(dlg).findByText('Unbekannte Rolle')).toHaveAttribute('id', expect.stringMatching(/-pr-e$/));
    const post = calls.find(c => c.method === 'POST')!;
    expect(await post.json()).toEqual({ resourceType: 'folder', resourceId: F1, principalType: 'role', principalRef: 'folder-admin', permission: 'note:write', effect: 'restrict' });
  });

  it('Dialog: identische Zugriffsregel gesperrt; ändert sich nichts an den Rollen, sagt die Vorschau das', async () => {
    const { calls } = setup('/verwalten/zugriff');
    const dlg = await openAdd();
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Rolle' }), 'editor');
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Recht' }), 'note:write');
    await pickFolder(dlg);
    // e1: genau diese Zugriffsregel gibt es schon
    expect(within(dlg).getByRole('alert')).toHaveTextContent('Diese Zugriffsregel gibt es schon');
    expect(within(dlg).getByRole('button', { name: 'Hinzufügen' })).toBeDisabled();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Verbieten' }));
    expect(within(dlg).queryByRole('alert')).toBeNull();
    expect(within(dlg).getByRole('button', { name: 'Hinzufügen' })).toBeEnabled();
    // Ordner-Admin hat es dort schon nicht mehr: verbieten für Ordner-Admin ändert an den Rollen nichts
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Rolle' }), 'folder-admin');
    expect(within(dlg).getByRole('status', { name: 'Vorschau' })).toHaveTextContent('Ändert derzeit nichts an den Rollen – keine Rolle verliert dadurch das Recht.');
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('Gruppe: Freitext mit Beispiel nach groupRolePrefix und Prüfung am Feld', async () => {
    const { calls } = setup('/verwalten/zugriff', { config: { resources: RESOURCES, groupRolePrefix: '/kunden/' } });
    const dlg = await openAdd();
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Wer' }), 'group');
    expect(within(dlg).getByText(/Beispiel: \/kunden\/demo\//)).toBeInTheDocument();
    await userEvent.type(within(dlg).getByRole('textbox', { name: 'Gruppenpfad' }), 'team');
    await pickFolder(dlg);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    expect(within(dlg).getByText(/«\/» am Anfang/)).toBeInTheDocument();
    expect(within(dlg).getByRole('textbox', { name: 'Gruppenpfad' })).toHaveFocus();
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('Person: Auswahl über das Personenverzeichnis, Name in der Vorschau', async () => {
    const CARLA = { id: '00000000-0000-4000-8000-0000000000c1', kind: 'user', name: 'Carla Check', email: 'carla@demo.example', clientId: null, lastSeenAt: null };
    const { calls } = setup('/verwalten/zugriff', { routes: routes({ 'GET /v1/people': () => json({ items: [CARLA], nextCursor: null }), 'POST /v1/acl': () => json(note({ id: 'neu', principalType: 'user', principalRef: CARLA.id }), 201) }) });
    const dlg = await openAdd();
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Wer' }), 'user');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Person' }));
    const picker = await screen.findByRole('dialog', { name: 'Person wählen' });
    await userEvent.click(await within(picker).findByRole('option', { name: /Carla Check/ }));
    expect(await within(dlg).findByRole('button', { name: 'Person' })).toHaveTextContent('Carla Check');
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Recht' }), 'note:write');
    await pickFolder(dlg);
    // e1 beschränkt schon auf Bearbeiter:in: beide behalten das Recht
    expect(within(dlg).getByRole('status', { name: 'Vorschau' })).toHaveTextContent('Auf Ordner «Projekte» behalten nur Personen mit Rolle «Bearbeiter:in» und «Carla Check» das Recht «Notizen ändern» (auch auf allem darunter).');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    expect(await screen.findByText('Zugriffsregel in «Demo AG» hinzugefügt')).toBeInTheDocument();
    expect(await calls.find(c => c.method === 'POST')!.json()).toMatchObject({ principalType: 'user', principalRef: CARLA.id });
    // Suche fragt das Verzeichnis, nicht die Mitgliederliste
    expect(calls.some(c => new URL(c.url).pathname === '/v1/people')).toBe(true);
  });

  it('Person über ihr Subject (statt Principal-ID): so angezeigt, nicht an /v1/people; die anderen Namen lösen sich auf', async () => {
    const CARLA = { id: '00000000-0000-4000-8000-0000000000c1', kind: 'user', name: 'Carla Check', email: null, clientId: null, lastSeenAt: null };
    const { calls } = setup('/verwalten/zugriff', { routes: routes({
      'GET /v1/acl': () => json({ items: [note({ id: 's1', principalType: 'user', principalRef: 'dora' }), note({ id: 's2', principalType: 'user', principalRef: CARLA.id })] }),
      'GET /v1/people': req => (new URL(req.url).searchParams.getAll('ids').every(id => /^[0-9a-f-]{36}$/.test(id)) ? json({ items: [CARLA], nextCursor: null }) : json({ title: 'Ungültig', status: 400 }, 400)),
    }) });
    const table = await screen.findByRole('table', { name: 'Zugriffsregeln' });
    expect(await within(table).findByText('Carla Check')).toBeInTheDocument();
    expect(within(table).getByText('dora')).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Mehr zu «Notizen ändern» beschränkt für Person dora auf Projekte' })).toBeInTheDocument();
    const ids = calls.filter(c => new URL(c.url).pathname === '/v1/people').flatMap(c => new URL(c.url).searchParams.getAll('ids'));
    expect(ids).toEqual([CARLA.id]);
  });

  it('Dialog vor dem Katalog geöffnet: Ladezustand, danach Vorgaben aus dem Katalog, die auch gesendet werden', async () => {
    let release!: () => void;
    const ready = new Promise<void>(r => { release = r; });
    const { calls } = setup('/verwalten/zugriff', { routes: routes({
      'GET /v1/authz/catalog': async () => { await ready; return json(CATALOG); },
      'POST /v1/acl': () => json(note({ id: 'neu' }), 201),
    }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Zugriffsregel hinzufügen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Zugriffsregel in «Demo AG» hinzufügen' });
    expect(within(dlg).queryByRole('combobox', { name: 'Recht' })).toBeNull();
    release();
    // das Formular ersetzt den Ladezustand; Fokus auf dem ersten Feld
    expect(await screen.findByRole('combobox', { name: 'Rolle' })).toHaveValue('folder-admin');
    const form = screen.getByRole('dialog', { name: 'Zugriffsregel in «Demo AG» hinzufügen' });
    expect(within(form).getByRole('combobox', { name: 'Recht' })).toHaveValue('note:read');
    await waitFor(() => expect(within(form).getByRole('combobox', { name: 'Ressource' })).toHaveFocus());
    await pickFolder(form);
    await userEvent.click(within(form).getByRole('button', { name: 'Hinzufügen' }));
    expect(await screen.findByText('Zugriffsregel in «Demo AG» hinzugefügt')).toBeInTheDocument();
    expect(await calls.find(c => c.method === 'POST')!.json()).toEqual({ resourceType: 'folder', resourceId: F1, principalType: 'role', principalRef: 'folder-admin', permission: 'note:read', effect: 'restrict' });
  });

  it('ohne acl:admin nennt der Kopf das fehlende Recht, statt still auszublenden; keine Zeilenaktionen', async () => {
    setup('/verwalten/zugriff', { me: AUDITOR });
    const table = await screen.findByRole('table', { name: 'Zugriffsregeln' });
    expect(await screen.findByText(/^Zum Hinzufügen und Entfernen von Zugriffsregeln fehlt dir das Recht «Zugriff verwalten»\. Es gehört nur zur Rolle «Organisations-Admin»\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Zugriffsregel hinzufügen' })).toBeNull();
    expect(within(table).queryByRole('button', { name: /^Mehr zu/ })).toBeNull();
  });

  it('Zeilenmenü mit eindeutigem Namen; Entfernen nennt die Organisation, Fehler bleibt im Dialog', async () => {
    let fail = true;
    setup('/verwalten/zugriff', { routes: routes({ 'DELETE /v1/acl/e1': () => (fail ? json({ title: 'Konflikt', status: 409, detail: 'Gerade geändert.' }, 409) : new Response(null, { status: 204 })) }) });
    const table = await screen.findByRole('table', { name: 'Zugriffsregeln' });
    const names = within(table).getAllByRole('button', { name: /^Mehr zu/ }).map(b => b.getAttribute('aria-label'));
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
    expect(names).toContain('Mehr zu «Notizen ändern» beschränkt für Rolle «Bearbeiter:in» auf Projekte');
    expect(names).toContain('Mehr zu «Notizen lesen» verboten für Rolle «Leser:in» auf der ganzen Organisation');
    await userEvent.click(within(table).getByRole('button', { name: 'Mehr zu «Notizen ändern» beschränkt für Rolle «Bearbeiter:in» auf Projekte' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Zugriffsregel entfernen …' }));
    const c = await screen.findByRole('alertdialog', { name: 'Zugriffsregel in «Demo AG» entfernen?' });
    expect(c).toHaveTextContent('«Notizen ändern» für Personen mit Rolle «Bearbeiter:in» auf Projekte wird in «Demo AG» nicht mehr beschränkt.');
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Abbrechen' })).toHaveFocus());
    await userEvent.click(within(c).getByRole('button', { name: 'Entfernen' }));
    // Fehler im Dialog statt als Meldung unten (der Dialog bleibt offen)
    expect(await within(c).findByRole('alert')).toHaveTextContent('Gerade geändert.');
    fail = false;
    await userEvent.click(within(c).getByRole('button', { name: 'Entfernen' }));
    expect(await screen.findByText('Zugriffsregel in «Demo AG» entfernt')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('Dialog: Wirkung vor dem Recht; «Freigeben» nicht auf dem Blatt (Notiz), Wechsel dorthin setzt «Beschränken auf»', async () => {
    setup('/verwalten/zugriff');
    const dlg = await openAdd();
    const seg = within(dlg).getByRole('group', { name: 'Wirkung' });
    expect(within(seg).getAllByRole('button').map(b => b.textContent)).toEqual(['Freigeben', 'Beschränken auf', 'Verbieten']);
    expect(within(seg).getByRole('button', { name: 'Beschränken auf' })).toHaveAttribute('aria-pressed', 'true');
    expect(seg.compareDocumentPosition(within(dlg).getByRole('combobox', { name: 'Recht' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(within(seg).getByRole('button', { name: 'Freigeben' }));
    expect(within(seg).getByRole('button', { name: 'Freigeben' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dlg).getByRole('group', { name: 'Was' })).toBeInTheDocument();
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Ressource' }), 'note');
    const grant = within(seg).getByRole('button', { name: 'Freigeben' });
    expect(grant).toHaveAttribute('aria-disabled', 'true');
    expect(grant).toHaveAttribute('title', 'Freigaben gelten für Bereiche, nicht für einzelne Ressourcen vom Typ «Notiz».');
    expect(within(seg).getByRole('button', { name: 'Beschränken auf' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dlg).queryByRole('group', { name: 'Was' })).toBeNull();
    // gesperrt bleibt gesperrt, auch per Klick
    await userEvent.click(grant);
    expect(grant).toHaveAttribute('aria-pressed', 'false');
  });

  it('Dialog: «Freigeben» mit Vorschau «erhalten»; Rechte nur von org-admin nicht freigebbar', async () => {
    const { calls } = setup('/verwalten/zugriff', { routes: routes({ 'POST /v1/acl': () => json(note({ id: 'neu', effect: 'grant' }), 201) }) });
    const dlg = await openAdd();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Ressource' }), 'tenant');
    expect(within(within(dlg).getByRole('combobox', { name: 'Recht' })).queryByRole('option', { name: 'Zugriff verwalten' })).toBeNull();
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Recht' }), 'note:write');
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Rolle' }), 'viewer');
    const preview = within(dlg).getByRole('status', { name: 'Vorschau' });
    expect(preview).toHaveTextContent('In der ganzen Organisation erhalten Personen mit Rolle «Leser:in» das Recht «Notizen ändern» (auch auf allem darunter), auch ohne Rolle mit diesem Recht.');
    expect(within(preview).getByRole('list', { name: 'Rollen danach' })).toHaveTextContent('erhält es Leser:in');
    expect(preview).not.toHaveTextContent('Ändert derzeit nichts');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    expect(await screen.findByText('Zugriffsregel in «Demo AG» hinzugefügt')).toBeInTheDocument();
    const posts = calls.filter(c => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(await posts[0]!.json()).toEqual({ resourceType: 'tenant', resourceId: null, principalType: 'role', principalRef: 'viewer', permission: 'note:write', effect: 'grant' });
  });

  it('Dialog: «Rechte einer Rolle» freigeben sendet eine Zugriffsregel je passendem Recht der Rolle', async () => {
    const { calls } = setup('/verwalten/zugriff', { routes: routes({ 'POST /v1/acl': () => json(note({ id: 'neu', effect: 'grant' }), 201) }) });
    const dlg = await openAdd();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    const what = within(dlg).getByRole('group', { name: 'Was' });
    expect(within(what).getByRole('button', { name: 'Ein Recht' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(what).getByRole('button', { name: 'Rechte einer Rolle' }));
    expect(within(dlg).queryByRole('combobox', { name: 'Recht' })).toBeNull();
    const bundle = within(dlg).getByRole('combobox', { name: 'Rolle im Bereich' });
    expect(within(bundle).queryByRole('option', { name: 'Organisations-Admin' })).toBeNull();
    await userEvent.selectOptions(bundle, 'editor');
    expect(within(dlg).getByText('Gibt die 2 passenden Rechte dieser Rolle frei: Notizen lesen, Notizen ändern.')).toBeInTheDocument();
    await pickFolder(dlg);
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Rolle' }), 'auditor');
    const preview = within(dlg).getByRole('status', { name: 'Vorschau' });
    expect(preview).toHaveTextContent('Auf Ordner «Projekte» erhalten Personen mit Rolle «Prüfer:in» die Rechte der Rolle «Bearbeiter:in» (auch auf allem darunter), auch ohne diese Rolle: Notizen lesen, Notizen ändern.');
    expect(preview).toHaveTextContent('2 Zugriffsregeln (eine je Recht).');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    expect(await screen.findByText('2 Zugriffsregeln in «Demo AG» hinzugefügt')).toBeInTheDocument();
    const bodies = await Promise.all(calls.filter(c => c.method === 'POST').map(c => c.json()));
    expect(bodies).toEqual(['note:read', 'note:write'].map(permission => ({ resourceType: 'folder', resourceId: F1, principalType: 'role', principalRef: 'auditor', permission, effect: 'grant' })));
  });

  it('Dialog: «Rechte einer Rolle» ohne bereits freigegebene Rechte; alle schon freigegeben sperrt «Hinzufügen»', async () => {
    const granted = note({ id: 'g1', principalRef: 'auditor', permission: 'note:read', effect: 'grant' });
    const { calls } = setup('/verwalten/zugriff', { routes: routes({ 'GET /v1/acl': () => json({ items: [...ENTRIES, granted] }), 'POST /v1/acl': () => json({ ...granted, id: 'neu' }, 201) }) });
    const dlg = await openAdd();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Freigeben' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Rechte einer Rolle' }));
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Rolle im Bereich' }), 'viewer');
    await pickFolder(dlg);
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Rolle' }), 'auditor');
    // Leser:in hat nur «Notizen lesen», und das ist hier schon freigegeben
    expect(within(dlg).getByRole('alert')).toHaveTextContent('Diese Rechte sind hier schon freigegeben.');
    expect(within(dlg).getByRole('button', { name: 'Hinzufügen' })).toBeDisabled();
    await userEvent.selectOptions(within(dlg).getByRole('combobox', { name: 'Rolle im Bereich' }), 'editor');
    expect(within(dlg).queryByRole('alert')).toBeNull();
    expect(within(dlg).getByRole('status', { name: 'Vorschau' })).toHaveTextContent('Eine neue Zugriffsregel; eine gibt es schon.');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    expect(await screen.findByText('Zugriffsregel in «Demo AG» hinzugefügt')).toBeInTheDocument();
    const posts = calls.filter(c => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(await posts[0]!.json()).toMatchObject({ permission: 'note:write', effect: 'grant', principalRef: 'auditor' });
  });

  it('Tabelle: Wirkung als Pille (auch alte «allow»-Einträge); Menü und Entfernen mit Verb', async () => {
    setup('/verwalten/zugriff', { routes: routes({ 'GET /v1/acl': () => json({ items: [
      note({ id: 'g1', principalRef: 'viewer', effect: 'grant' }),
      note({ id: 'r1', principalRef: 'editor', effect: 'restrict' }),
      note({ id: 'a1', principalRef: 'folder-admin', effect: 'allow' }),
      note({ id: 'd1', principalRef: 'auditor', permission: 'note:read', effect: 'deny' }),
    ] }) }) });
    const table = await screen.findByRole('table', { name: 'Zugriffsregeln' });
    const pill = (label: string) => within(within(table).getByText(label, { selector: 'td *' }).closest('tr')!).getByText(/^(Freigeben|Beschränken auf|Verbieten)$/);
    expect(pill('Leser:in')).toHaveTextContent('Freigeben');
    expect(pill('Leser:in')).toHaveClass('iam-pill', 'iam-st-ok');
    expect(pill('Bearbeiter:in')).toHaveTextContent('Beschränken auf');
    expect(pill('Bearbeiter:in')).toHaveClass('iam-pill', 'iam-st-warn');
    expect(pill('Ordner-Admin')).toHaveTextContent('Beschränken auf');
    expect(pill('Prüfer:in')).toHaveTextContent('Verbieten');
    expect(pill('Prüfer:in')).toHaveClass('iam-pill', 'iam-st-bad');
    expect(within(table).queryByText('wirkungslos')).toBeNull();
    await userEvent.click(within(table).getByRole('button', { name: 'Mehr zu «Notizen ändern» freigegeben für Rolle «Leser:in» auf Projekte' }));
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Zugriffsregel entfernen …' }));
    expect(await screen.findByRole('alertdialog', { name: 'Zugriffsregel in «Demo AG» entfernen?' })).toHaveTextContent('wird in «Demo AG» nicht mehr freigegeben');
  });

  it('unbekannte Ressource im Filter (Link aus einer anderen Organisation): «Nicht gefunden» statt roher ID', async () => {
    const FOREIGN = '00000000-0000-4000-8000-0000000000ff';
    setup(`/verwalten/zugriff?resourceType=folder&resourceId=${FOREIGN}`);
    const nf = await screen.findByRole('alert');
    expect(nf).toHaveTextContent('Nicht gefunden');
    expect(nf).toHaveTextContent('Du arbeitest in «Demo AG».');
    const pick = screen.getByRole('combobox', { name: 'Einzeln:' });
    expect(pick).toHaveDisplayValue('unbekannt (00000000)');
    await userEvent.click(within(nf).getByRole('button', { name: 'Filter zurücksetzen' }));
    await waitFor(() => expect(search()).toEqual({}));
    expect(await screen.findByRole('table', { name: 'Zugriffsregeln' })).toBeInTheDocument();
  });

  it('fehlende Ressource beim Absenden: Fehler und Fokus am Feld; ohne Absenden kein Fehler; Hintergrund schliesst nicht', async () => {
    const { calls } = setup('/verwalten/zugriff');
    const dlg = await openAdd();
    expect(within(dlg).queryByText('Bitte wählen.')).toBeNull();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Hinzufügen' }));
    expect(within(dlg).getByText('Bitte wählen.')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Ordner' })).toHaveFocus();
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    fireEvent.mouseDown(dlg.parentElement!);
    expect(screen.getByRole('dialog', { name: 'Zugriffsregel in «Demo AG» hinzufügen' })).toBeInTheDocument();
  });

  it('ohne Adapter `resources`: ID als Eingabe und in der Liste', async () => {
    setup('/verwalten/zugriff', { config: {} });
    const table = await screen.findByRole('table', { name: 'Zugriffsregeln' });
    expect(within(table).getAllByRole('columnheader').some(h => h.textContent?.includes(F1))).toBe(true);
    const dlg = await openAdd();
    expect(within(dlg).getByRole('textbox', { name: 'Ordner' })).toHaveAttribute('placeholder', 'ID der Ressource');
  });

  it('zwei Reiter nach ARIA-Muster, Reiter in der URL, Pfeiltasten wechseln', async () => {
    const { calls } = setup('/verwalten/zugriff');
    const tabs = await screen.findByRole('tablist', { name: 'Zugriff' });
    const [rules, check] = within(tabs).getAllByRole('tab');
    expect(rules).toHaveAccessibleName(/^Zugriffsregeln/);
    expect(check).toHaveAccessibleName('Rechte prüfen');
    expect(rules).toHaveAttribute('aria-selected', 'true');
    expect(check).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', rules!.id);
    await waitFor(() => expect(rules).toHaveTextContent('Zugriffsregeln3'));
    expect(screen.getByRole('button', { name: 'Zugriffsregel hinzufügen' })).toBeInTheDocument();
    await userEvent.click(check!);
    await waitFor(() => expect(search()).toEqual({ ansicht: 'pruefen' }));
    expect(check).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('form', { name: 'Rechte prüfen' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Zugriffsregeln' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Zugriffsregel hinzufügen' })).toBeNull();
    check!.focus();
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(search()).toEqual({}));
    expect(rules).toHaveFocus();
    expect(await screen.findByRole('table', { name: 'Zugriffsregeln' })).toBeInTheDocument();
    expect(effCalls(calls)).toHaveLength(1);
  });

  it('im Reiter Zugriffsregeln keine zweite Liste eigener Rechte und keine Abfrage der wirksamen Rechte', async () => {
    const { calls } = setup('/verwalten/zugriff?ansicht=regeln');
    await screen.findByRole('table', { name: 'Zugriffsregeln' });
    expect(screen.getByRole('tab', { name: /^Zugriffsregeln/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(/^Darf \d+ von/)).toBeNull();
    expect(effCalls(calls)).toHaveLength(0);
  });

  it('ohne Zugriffsregeln eine Zeile mit Erklärung und Aktion, keine Filter und keine Tabelle; ohne acl:admin ohne Aktion', async () => {
    const { unmount } = setup('/verwalten/zugriff', { routes: routes({ 'GET /v1/acl': () => json({ items: [] }) }) });
    const line = (await screen.findByText('Keine Zugriffsregeln.')).closest('p')!;
    expect(line).toHaveClass('iam-acl-none');
    expect(line).toHaveTextContent('Es gelten die Rechte der Rollen');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('search', { name: 'Zugriffsregeln filtern' })).toBeNull();
    await userEvent.click(within(line).getByRole('button', { name: 'Zugriffsregel hinzufügen' }));
    expect(await screen.findByRole('dialog', { name: 'Zugriffsregel in «Demo AG» hinzufügen' })).toBeInTheDocument();
    unmount();
    setup('/verwalten/zugriff', { me: AUDITOR, routes: routes({ 'GET /v1/acl': () => json({ items: [] }) }) });
    const none = (await screen.findByText('Keine Zugriffsregeln.')).closest('p')!;
    expect(within(none).queryByRole('button')).toBeNull();
  });
});

describe('Rechte prüfen', () => {
  it('Standard «Ich» mit echten Rechten (Organisations-Admin als ein Satz) und Ressourcen mit Zugriffsregeln', async () => {
    const { calls } = setup('/verwalten/zugriff?ansicht=pruefen', { me: NO_CLIENTS });
    const form = await screen.findByRole('form', { name: 'Rechte prüfen' });
    const seg = within(form).getByRole('group', { name: 'Wer?' });
    // ohne members:admin kein «Maschinen-Client» und keine Abfrage der Clients
    expect(within(seg).getAllByRole('button').map(b => b.textContent)).toEqual(['Ich', 'Person', 'Rolle(n)']);
    expect(within(seg).getByRole('button', { name: 'Ich' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Rechte von Anna Admin' })).toBeInTheDocument();
    expect(screen.queryByText('simuliert')).toBeNull();
    expect(await screen.findByText('Alle Rechte. Zugriffsregeln gelten nicht.')).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Entscheid je Ressource' })).toHaveTextContent('Notizen ändern · Ordner Projekteerlaubt');
    expect(new URL(effCalls(calls)[0]!.url).search).toBe('');
    expect(calls.some(c => new URL(c.url).pathname === '/v1/admin/clients')).toBe(false);
  });

  it('Suchparameter ansicht=pruefen&rolle=<key> öffnen «Rechte prüfen» mit dieser Rolle; die Wahl wandert in die URL', async () => {
    const { calls } = setup('/verwalten/zugriff?ansicht=pruefen&rolle=viewer');
    const form = await screen.findByRole('form', { name: 'Rechte prüfen' });
    expect(within(form).getByRole('button', { name: 'Rolle(n)' })).toHaveAttribute('aria-pressed', 'true');
    const roles = within(form).getByRole('group', { name: 'Rollen' });
    expect(await within(roles).findByRole('button', { name: 'Leser:in' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('heading', { name: 'Rechte von Leser:in' })).toBeInTheDocument();
    expect(screen.getByText('simuliert')).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Entscheid je Ressource' })).toHaveTextContent('verboten');
    await waitFor(() => expect(effCalls(calls).map(c => new URL(c.url).searchParams.getAll('roles'))).toContainEqual(['viewer']));
    await userEvent.click(within(roles).getByRole('button', { name: 'Bearbeiter:in' }));
    await waitFor(() => expect(search()).toEqual({ ansicht: 'pruefen', rolle: 'viewer,editor' }));
    // Wechsel auf «Ich» räumt die URL auf
    await userEvent.click(within(form).getByRole('button', { name: 'Ich' }));
    await waitFor(() => expect(search()).toEqual({ ansicht: 'pruefen' }));
  });

  it('Verbot auf Ebene der Organisation: Recht als «fehlt (Zugriffsregel)» und im Entscheid «Ganze Organisation verboten»', async () => {
    // e3 verbietet Leser:in «Notizen lesen» in der ganzen Organisation; die API rechnet es heraus
    setup('/verwalten/zugriff?ansicht=pruefen&rolle=viewer', { routes: routes({ 'GET /v1/acl/effective': req => json({
      ...EFFECTIVE(true, new URL(req.url).searchParams.getAll('roles')), permissions: ['tenant:read'], resources: [] }) }) });
    expect(await screen.findByText('Darf 1 von 10')).toBeInTheDocument();
    expect(screen.getByText(/1 Recht fehlt wegen einer Zugriffsregel\./)).toBeInTheDocument();
    const row = screen.getByText('Notizen lesen', { selector: '.iam-rights-l, .iam-rights-l *' }).closest('li')!;
    expect(row).toHaveTextContent('fehlt (Zugriffsregel)');
    expect(await screen.findByRole('list', { name: 'Entscheid je Ressource' })).toHaveTextContent('Notizen lesen · Ganze Organisationverboten');
  });

  it('Maschinen-Client mit org-admin ist nicht ausgenommen: Verbot aus der Antwort gilt auch dann', async () => {
    setup('/verwalten/zugriff?ansicht=pruefen&client=ci-bot', { routes: routes({
      'GET /v1/admin/clients': () => json({ items: [{ ...CLIENTS.items[0], lastRoles: ['org-admin'], lastScopes: ['notes:read'] }] }),
      'GET /v1/acl/effective': () => json({ ...EFFECTIVE(false, ['org-admin']), source: 'last-token', permissions: ['tenant:read'] }),
    }) });
    expect(await screen.findByText(/1 Recht fehlt wegen einer Zugriffsregel\./)).toBeInTheDocument();
    expect(screen.queryByText('Alle Rechte. Zugriffsregeln gelten nicht.')).toBeNull();
  });

  it('Rollen ohne Wahl: Aufforderung statt Ergebnis; Scopes aus dem Katalog statt Freitext', async () => {
    const { calls } = setup('/verwalten/zugriff?ansicht=pruefen');
    const form = await screen.findByRole('form', { name: 'Rechte prüfen' });
    await userEvent.click(within(form).getByRole('button', { name: 'Rolle(n)' }));
    expect(screen.getByText('Wähle mindestens eine Rolle.')).toBeInTheDocument();
    await userEvent.click(within(within(form).getByRole('group', { name: 'Rollen' })).getByRole('button', { name: 'Bearbeiter:in' }));
    const more = within(form).getByRole('button', { name: /Gruppen und Scopes/ });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(within(form).getByRole('button', { name: 'Scopes wählen' }));
    const picker = await screen.findByRole('dialog', { name: 'Scopes wählen' });
    await userEvent.click(within(picker).getByText('notes:read'));
    await userEvent.click(within(picker).getByRole('button', { name: 'Übernehmen' }));
    // Bearbeiter:in darf Notizen ändern, aber nicht mit nur «notes:read»
    expect(await screen.findByText(/1 Recht fehlt nur wegen des Scopes/)).toBeInTheDocument();
    await waitFor(() => expect(new URL(effCalls(calls).pop()!.url).searchParams.getAll('scopes')).toEqual(['notes:read']));
    await userEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveTextContent('1 gewählt');
  });

  it('«Person» mit echten Rechten aus Keycloak: nicht simuliert, Rollen der Person und zusätzlich freigegebene Rechte', async () => {
    const CARLA = { id: '00000000-0000-4000-8000-0000000000c1', kind: 'user', name: 'Carla Check', email: 'carla@demo.example', clientId: null, lastSeenAt: null };
    const { calls } = setup('/verwalten/zugriff?ansicht=pruefen', { routes: routes({
      'GET /v1/people': () => json({ items: [CARLA], nextCursor: null }),
      'GET /v1/admin/members': () => json({ items: [] }),
      'GET /v1/acl/effective': req => {
        const u = new URL(req.url);
        if (u.searchParams.get('principal') && !u.searchParams.getAll('roles').length) {
          return json({ principal: { id: CARLA.id, kind: 'user', name: 'Carla Check', clientId: null }, simulated: false, source: 'keycloak', roles: ['viewer'], groups: ['/orgs/demo/team'], scopes: [],
            permissions: ['tenant:read', 'note:read'], granted: ['folder:admin'], resources: [{ resourceType: 'folder', resourceId: F1, permission: 'note:write', allowed: false }] });
        }
        return json({ ...EFFECTIVE(true, u.searchParams.getAll('roles')), source: 'simulation' });
      },
    }) });
    const form = await screen.findByRole('form', { name: 'Rechte prüfen' });
    await userEvent.click(within(form).getByRole('button', { name: 'Person' }));
    expect(screen.getByText('Wähle eine Person.')).toBeInTheDocument();
    await userEvent.click(within(form).getByText('Person suchen …'));
    const picker = await screen.findByRole('dialog', { name: 'Person wählen' });
    await userEvent.click(await within(picker).findByRole('option', { name: /Carla Check/ }));
    expect(await screen.findByRole('heading', { name: 'Rechte von Carla Check' })).toBeInTheDocument();
    expect(await within(form).findByText(/^Echte Rechte: Rollen und Gruppen aus der Anmeldung \(Keycloak\)/)).toBeInTheDocument();
    expect(screen.queryByText('simuliert')).toBeNull();
    expect(within(within(form).getByRole('group', { name: 'Rollen der Person' })).getByRole('button', { name: 'Leser:in' })).toHaveAttribute('aria-pressed', 'true');
    const extra = screen.getByRole('heading', { name: 'Zusätzlich freigegeben (nur in einzelnen Bereichen)' }).parentElement!;
    expect(extra).toHaveTextContent('«Ordner verwalten» – wo genau, steht unter «Ressourcen mit Zugriffsregeln».');
    const effs = effCalls(calls).map(c => new URL(c.url).search);
    expect(effs.at(-1)).toBe(`?principal=${CARLA.id}`);
    expect(effs.every(s => !s.includes('roles='))).toBe(true);
    // eigene Wahl der Rollen: Simulation
    await userEvent.click(within(within(form).getByRole('group', { name: 'Rollen der Person' })).getByRole('button', { name: 'Bearbeiter:in' }));
    expect(await screen.findByText('simuliert')).toBeInTheDocument();
    expect(within(form).getByText(/^Simulation mit den gewählten Rollen und Gruppen/)).toBeInTheDocument();
    await waitFor(() => expect(new URL(effCalls(calls).pop()!.url).searchParams.getAll('roles')).toEqual(['viewer', 'editor']));
  });

  it('client=<id> öffnet den Maschinen-Client mit Rollen und Scopes des letzten Tokens; eigene Wahl simuliert als Client', async () => {
    const { calls } = setup('/verwalten/zugriff?ansicht=pruefen&client=ci-bot');
    const form = await screen.findByRole('form', { name: 'Rechte prüfen' });
    expect(within(form).getByRole('button', { name: 'Maschinen-Client' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(within(form).getByRole('combobox', { name: 'Maschinen-Client' })).toHaveValue('ci-bot'));
    expect(await within(form).findByText(/Rollen und Scopes aus dem letzten Token/)).toBeInTheDocument();
    expect(within(within(form).getByRole('group', { name: 'Rollen im Token' })).getByRole('button', { name: 'Bearbeiter:in' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(form).getByText('notes:read')).toHaveAttribute('title', 'Organisation und Notizen lesen');
    expect(within(form).getByRole('group', { name: /^Scopes/ })).toBeVisible();
    expect(within(form).queryByRole('button', { name: /Gruppen/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Rechte von ci-bot' })).toBeInTheDocument();
    expect(screen.getByText(/1 Recht fehlt nur wegen des Scopes/)).toBeInTheDocument();
    await waitFor(() => {
      const u = new URL(effCalls(calls).pop()!.url);
      expect([u.searchParams.get('client'), u.searchParams.getAll('roles'), u.searchParams.get('simulate')]).toEqual(['ci-bot', [], null]);
    });
    await userEvent.click(within(within(form).getByRole('group', { name: 'Rollen im Token' })).getByRole('button', { name: 'Leser:in' }));
    await waitFor(() => {
      const u = new URL(effCalls(calls).pop()!.url);
      expect([u.searchParams.get('client'), u.searchParams.get('simulate')]).toEqual(['ci-bot', 'true']);
      expect(u.searchParams.getAll('roles').sort()).toEqual(['editor', 'viewer']);
      expect(u.searchParams.getAll('scopes')).toEqual(['notes:read']);
    });
  });

  it('Maschinen-Client noch nie benutzt: Hinweis, kein Scope; ohne members:admin kein Segment, Hinweis auf das Recht', async () => {
    const { unmount } = setup('/verwalten/zugriff?ansicht=pruefen&client=neu');
    expect(await screen.findByText(/Noch nie benutzt/)).toBeInTheDocument();
    expect(screen.getByText('kein Scope')).toBeInTheDocument();
    unmount();
    const { calls } = setup('/verwalten/zugriff?ansicht=pruefen&client=ci-bot', { me: NO_CLIENTS });
    const form = await screen.findByRole('form', { name: 'Rechte prüfen' });
    expect(within(form).queryByRole('button', { name: 'Maschinen-Client' })).toBeNull();
    expect(within(form).getByRole('button', { name: 'Ich' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText(/^Zum Prüfen eines Maschinen-Clients fehlt dir das Recht «/)).toBeInTheDocument();
    expect(calls.some(c => new URL(c.url).pathname === '/v1/admin/clients')).toBe(false);
  });
});

describe('Hinweis «Zugriff eingeschränkt»', () => {
  const hint = (type: string, id: string, items: unknown[], me: Partial<Me> = ADMIN) => setup('/', { me, routes: { 'GET /v1/acl': () => json({ items }) }, ui: <AclHint resourceType={type} resourceId={id} /> });

  it('zählt Einträge auf der Ressource und den Stufen darüber (nicht auf der Organisation) und verlinkt die gefilterte Seite', async () => {
    const items = [note({ id: 'a' }), note({ id: 'b', principalRef: 'viewer' }), note({ id: 'c', resourceType: 'note', resourceId: N1 }), note({ id: 'd', resourceType: 'tenant', resourceId: null }), note({ id: 'e', resourceId: F2 })];
    const { unmount } = hint('note', N1, items);
    const link = await screen.findByRole('link', { name: 'Zugriff eingeschränkt (1 hier, 2 von «Projekte»)' });
    expect(link.getAttribute('href')).toBe(`/verwalten/zugriff?resourceType=note&resourceId=${N1}`);
    expect(link).toHaveClass('iam-btn', 'iam-sm');
    unmount();
    hint('folder', F1, items);
    expect((await screen.findByRole('link', { name: 'Zugriff eingeschränkt (2)' })).getAttribute('href')).toBe(`/verwalten/zugriff?resourceType=folder&resourceId=${F1}`);
  });

  it('nur geerbte Einträge: Link auf die Stufe darüber; ohne acl:read nichts und keine Abfrage', async () => {
    const { unmount } = hint('note', N1, [note({ id: 'a' })]);
    const link = await screen.findByRole('link', { name: 'Zugriff eingeschränkt (1 von «Projekte»)' });
    expect(link.getAttribute('href')).toBe(`/verwalten/zugriff?resourceType=folder&resourceId=${F1}`);
    unmount();
    const { calls } = hint('folder', F1, [note({ id: 'a' })], { roles: ['viewer'], permissions: ['tenant:read', 'note:read'] });
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull());
    expect(calls.some(c => new URL(c.url).pathname === '/v1/acl')).toBe(false);
  });
});
