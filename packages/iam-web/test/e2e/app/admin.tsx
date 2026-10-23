/**
 * Testseite der Verwalten-Seiten: Navigation «Zugang» (IamNav), Seiten aus `iamRoutes` (mit Guard, per `load()`),
 * nachgebildete API mit Zustand (Einladen, Rollen setzen, eigene Rollen, Maschinen-Clients, Zugriffsregeln, Organisationen),
 * Ordner und Notizen über `staticResources`. Die Person
 * gehört zur Plattform-Administration. `?p=<id>` startet auf dieser Route (`organization` mit «muster»).
 */
import { lazy, StrictMode, Suspense, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/styles.css';
import { historyRouter, IamNav, IamProvider, makeIamRoutes, type AclEntry, type ClientGrant, type EntraConnection, type Member, type Organization, type Role } from '../../../src/index.ts';
import { CATALOG, json, ME, mockIamApi, staticResources } from '../../../src/testing/index.tsx';
import './page.css';

sessionStorage.removeItem('iam.tab.org');
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const member = (id: string, name: string, email: string, roles: string[], o: Partial<Member> = {}): Member =>
  ({ id, principalId: `p-${id}`, username: email, name, email, status: 'active', roles, lastSeenAt: ago(1), createdAt: null, loginPath: null, ...o });
let members: Member[] = [
  member(ME.person.subject, 'Anna Admin', 'anna@demo.example', ['org-admin'], { lastSeenAt: ago(0) }),
  member('m-carla', 'Carla Check', 'carla@demo.example', ['editor', 'viewer'], { lastSeenAt: ago(2) }),
  member('m-nora', 'Nora Neu', 'nora@demo.example', ['viewer'], { status: 'invited', lastSeenAt: null, createdAt: ago(3) }),
  member('m-erik', 'Erik Extern mit einem sehr langen Namen', 'erik.extern@partner-mit-langer-domain.example', ['auditor'], { status: 'disabled', lastSeenAt: null }),
];
let custom: Role[] = [];
let clients: ClientGrant[] = [
  { clientId: 'notiz-import', description: 'Nächtlicher Import', createdAt: ago(20), createdBy: 'Anna Admin', lastUsedAt: ago(0.1), lastRoles: ['editor'], lastScopes: ['notes:read'] },
  { clientId: 'neu-client', description: '', createdAt: ago(1), createdBy: null, lastUsedAt: null, lastRoles: null, lastScopes: null },
];
const org = (alias: string, name: string, o: Partial<Organization> = {}): Organization =>
  ({ id: `kc-${alias}`, alias, name, description: null, enabled: true, domains: [`${alias}.example`], tenant: { id: `t-${alias}`, status: 'active', createdAt: ago(100) }, ...o });
let orgs: Organization[] = [org('demo', 'Demo AG', { domains: [] }), org('muster', 'Muster GmbH'), org('neu', 'Neu AG mit einem langen Namen', { tenant: null, domains: [] })];
const setOrg = (alias: string, f: (o: Organization) => Organization) => { orgs = orgs.map(o => (o.alias === alias ? f(o) : o)); return orgs.find(o => o.alias === alias)!; };
let entra: EntraConnection = {
  entraTenantId: '0f0e0d0c-0000-4000-8000-000000000001', entraName: 'Demo AG (Entra)', domains: ['demo.example'], availableDomains: ['extra.example'], stage: 'pending',
  testedAt: ago(0.5), testedBy: 'Anna Admin', enforcedAt: null, enforcedBy: null, testLoginPath: '/auth/login?idp=entra-001&org=demo', status: 'active', lastError: null,
  connectedAt: ago(2), connectedBy: 'Anna Admin', refreshedAt: ago(1),
};
const entraMembers = [{ email: 'anna@demo.example', name: 'Anna Admin', linked: true, reason: null }, { email: 'carla@demo.example', name: 'Carla Check', linked: false, reason: 'In Entra ID nicht gefunden' }];
const F1 = '00000000-0000-4000-8000-0000000000f1', F2 = '00000000-0000-4000-8000-0000000000f2', N1 = '00000000-0000-4000-8000-0000000000a1';
const resources = staticResources({ folder: { [F1]: 'Projekte', [F2]: 'Archiv mit einem langen Ordnernamen' }, note: { [N1]: 'Protokoll' } }, { parents: { [`note:${N1}`]: { type: 'folder', id: F1 } } });
const acl = (id: string, o: Partial<AclEntry>): AclEntry => ({ id, resourceType: 'folder', resourceId: F1, principalType: 'role', principalRef: 'editor', permission: 'note:write', effect: 'restrict', createdAt: ago(5), createdBy: 'p-anna', ...o });
let aclEntries: AclEntry[] = [
  acl('a1', {}),
  acl('a2', { principalType: 'user', principalRef: 'p-m-carla', permission: 'note:delete', effect: 'grant' }),
  acl('a3', { resourceType: 'tenant', resourceId: null, principalRef: 'viewer', permission: 'note:read', effect: 'deny' }),
  acl('a4', { resourceId: F2, principalType: 'group', principalRef: '/orgs/demo/team-mit-einem-langen-gruppennamen', permission: 'audit:read' }),
];
const people = () => members.filter(m => m.principalId).map(m => ({ id: m.principalId!, kind: 'user', name: m.name, email: m.email, clientId: null, lastSeenAt: m.lastSeenAt }));
const features = { entra: true };
const routes = makeIamRoutes({}, features);
const roles = () => ({
  items: [...CATALOG.roles.map(r => ({ ...r, custom: false, id: null, version: null, memberCount: members.filter(m => m.roles.includes(r.key)).length, createdAt: null, updatedAt: null })), ...custom],
  customPermissions: CATALOG.permissions.filter(p => !p.adminOnly).map(p => p.key), maxCustom: 50,
});
const idOf = (req: Request) => new URL(req.url).pathname.split('/')[4]!;

window.fetch = mockIamApi({
  'GET /v1/roles': () => json(roles()),
  'GET /v1/admin/status': () => json({ enabled: true, reason: null, organization: 'demo', platformAdmin: true, canManageMembers: true, rolesManageable: true, roles: roles().items.map(({ key, label, description, permissions, adminOnly, custom: c }) => ({ key, label, description, permissions, adminOnly, custom: c })) }),
  'GET /v1/admin/members': () => json({ items: members }),
  'POST /v1/admin/members': async req => {
    const b = await req.json() as { email: string; roles: string[] };
    const m = member(`m-${members.length}`, b.email.split('@')[0]!, b.email, b.roles, { status: 'invited', lastSeenAt: null, createdAt: new Date().toISOString() });
    members = [...members, m];
    return json({ result: 'invitation-sent', emailSent: true, member: m }, 202);
  },
  ...Object.fromEntries(members.map(m => [`PUT /v1/admin/members/${m.id}/roles`, async (req: Request) => {
    const { roles: r } = await req.json() as { roles: string[] };
    members = members.map(x => (x.id === idOf(req) ? { ...x, roles: r } : x));
    return json(members.find(x => x.id === idOf(req)));
  }])),
  'GET /v1/admin/entra': () => json({ enabled: true, reason: null, connection: entra }),
  'GET /v1/admin/entra/preview': () => json({ members: entraMembers }),
  'POST /v1/admin/entra/enforce': () => { entra = { ...entra, stage: 'enforced', enforcedAt: new Date().toISOString(), enforcedBy: 'Anna Admin' }; return json({ connection: entra, members: entraMembers, rejectedDomains: [] }); },
  'GET /v1/platform/organizations/muster/entra': () => json({ enabled: true, reason: null, connection: null }),
  'GET /v1/admin/members/entra-search': () => json({ more: false, items: [
    { id: 'e-paula', name: 'Paula Plan', email: 'paula@demo.example', userPrincipalName: 'paula@demo.example', department: 'Planung', jobTitle: 'Planerin', selectable: true, reason: null },
    { id: 'e-gast', name: 'Gina Gast', email: 'gina@gmail.example', userPrincipalName: 'gina_gmail.example#EXT#@demo.onmicrosoft.com', department: null, jobTitle: null, selectable: false, reason: 'Gastkonto in Entra ID' },
  ] }),
  'POST /v1/admin/members/entra': async req => {
    const b = await req.json() as { roles: string[] };
    const m = member('m-paula', 'Paula Plan', 'paula@demo.example', b.roles, { status: 'invited', lastSeenAt: null, createdAt: new Date().toISOString(), loginPath: '/auth/entra/entra-001?org=demo' });
    members = [...members, m];
    return json({ result: 'added', emailSent: false, member: m }, 202);
  },
  'GET /v1/admin/clients': () => json({ items: clients }),
  'PUT /v1/admin/clients/notiz-2': async req => {
    const { description } = await req.json() as { description: string };
    const c: ClientGrant = { clientId: 'notiz-2', description, createdAt: new Date().toISOString(), createdBy: 'Anna Admin', lastUsedAt: null, lastRoles: null, lastScopes: null };
    clients = [...clients, c];
    return json(c, 201);
  },
  'DELETE /v1/admin/clients/neu-client': () => { clients = clients.filter(c => c.clientId !== 'neu-client'); return new Response(null, { status: 204 }); },
  'GET /v1/acl': () => json({ items: aclEntries }),
  'POST /v1/acl': async req => {
    const e = acl(`a${aclEntries.length + 1}-${Date.now()}`, { ...await req.json() as Partial<AclEntry>, createdAt: new Date().toISOString() });
    aclEntries = [...aclEntries, e];
    return json(e, 201);
  },
  ...Object.fromEntries(['a1', 'a2', 'a3', 'a4'].map(id => [`DELETE /v1/acl/${id}`, () => { aclEntries = aclEntries.filter(e => e.id !== id); return new Response(null, { status: 204 }); }])),
  'GET /v1/acl/effective': req => {
    const roles = new URL(req.url).searchParams.getAll('roles');
    const simulated = roles.length > 0;
    return json({ principal: { id: 'p-anna', kind: 'user', name: 'Anna Admin', clientId: null }, simulated, source: simulated ? 'simulation' : 'token', roles: simulated ? roles : ME.roles, groups: [], scopes: [],
      permissions: [], granted: [], resources: [{ resourceType: 'folder', resourceId: F1, permission: 'note:write', allowed: !simulated }, { resourceType: 'folder', resourceId: F2, permission: 'audit:read', allowed: true }] });
  },
  'GET /v1/people': req => {
    const u = new URL(req.url), q = (u.searchParams.get('q') ?? '').toLowerCase(), ids = u.searchParams.getAll('ids');
    return json({ items: people().filter(p => (ids.length ? ids.includes(p.id) : p.name.toLowerCase().includes(q))), nextCursor: null });
  },
  'GET /v1/platform/organizations': () => json({ items: orgs }),
  ...Object.fromEntries(['demo', 'muster', 'neu'].flatMap(a => [
    [`GET /v1/platform/organizations/${a}`, () => json(orgs.find(o => o.alias === a))],
    [`GET /v1/platform/organizations/${a}/members`, () => json({ items: a === 'demo' ? members : [member(`m-${a}`, 'Mara Muster', `mara@${a}.example`, ['org-admin'])] })],
    [`GET /v1/platform/organizations/${a}/clients`, () => json({ items: a === 'demo' ? clients : [] })],
    [`POST /v1/platform/organizations/${a}/suspend`, () => json(setOrg(a, o => ({ ...o, enabled: false, tenant: o.tenant && { ...o.tenant, status: 'suspended' } })))],
    [`POST /v1/platform/organizations/${a}/resume`, () => json(setOrg(a, o => ({ ...o, enabled: true, tenant: o.tenant && { ...o.tenant, status: 'active' } })))],
  ])),
  'POST /v1/roles': async req => {
    const b = await req.json() as { label: string; description: string; permissions: string[] };
    const r: Role = { key: `c-${b.label.toLowerCase().replace(/[^a-z]+/g, '-')}`, ...b, custom: true, adminOnly: false, id: `r-${custom.length}`, version: 1, memberCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    custom = [...custom, r];
    return json(r, 201);
  },
}, { me: ME }).fetch;

const start = routes.find(r => r.id === new URLSearchParams(location.search).get('p')) ?? routes[0]!;
history.replaceState(null, '', start.path.replace(':alias', 'muster'));

/** Route zum Pfad; `:alias` passt auf einen Abschnitt (wie im Router der App). */
const match = (path: string) => routes.find(r => new RegExp(`^${r.path.replace(/:[a-z]+/g, '[^/]+')}$`).test(path));

function Pages() {
  const path = historyRouter.usePathname();
  const route = match(path);
  const Page = useMemo(() => (route ? lazy(route.load) : null), [route]);
  return Page ? <Suspense fallback={<p>Lädt …</p>}><Page /></Suspense> : <p>Unbekannt: {path}</p>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IamProvider product="Notizen" features={features} resources={resources}>
      <div className="admin">
        <aside><IamNav /></aside>
        <main className="admin-main"><Pages /></main>
      </div>
    </IamProvider>
  </StrictMode>,
);
