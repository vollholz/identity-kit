/**
 * Testseite der Verwalten-Seiten: Navigation «Zugang» (IamNav), Seiten aus `iamRoutes` (mit Guard, per `load()`),
 * nachgebildete API mit Zustand (Einladen, Rollen setzen, eigene Rollen, Maschinen-Clients, Zugriffsregeln, Organisationen),
 * Ordner und Notizen über `staticResources`. Die Person
 * gehört zur Plattform-Administration. `?p=<id>` startet auf dieser Route (`organization` mit «muster»).
 */
import { lazy, StrictMode, Suspense, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/styles.css';
import { historyRouter, IamNav, IamProvider, makeIamRoutes, type AclEntry, type ClientGrant, type ConsentLink, type EntraConnection, type Member, type Organization, type Role } from '../../../src/index.ts';
import { CATALOG, json, ME, mockIamApi, staticResources } from '../../../src/testing/index.tsx';
import './page.css';

sessionStorage.removeItem('iam.tab.org');
/** Principal-ID (UUID) je Mitglied, fest aus der ID abgeleitet. */
const pid = (id: string) => `00000000-0000-4000-8000-${[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 0xffffffffffff, 7).toString(16).padStart(12, '0')}`;
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const member = (id: string, name: string, email: string, roles: string[], o: Partial<Member> = {}): Member =>
  ({ id, principalId: pid(id), username: email, name, email, status: 'active', roles, lastSeenAt: ago(1), createdAt: null, loginPath: null, ...o });
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
  acl('a2', { principalType: 'user', principalRef: pid('m-carla'), permission: 'note:delete', effect: 'grant' }),
  acl('a3', { resourceType: 'tenant', resourceId: null, principalRef: 'viewer', permission: 'note:read', effect: 'deny' }),
  acl('a4', { resourceId: F2, principalType: 'group', principalRef: '/orgs/demo/team-mit-einem-langen-gruppennamen', permission: 'audit:read' }),
];
/** Rechte auf Ebene der Organisation: aus den Rollen, ohne Verbote dort (wie der Server, ohne Beschränkungen und Freigaben). */
const tenantPerms = (rs: string[]) => [...new Set(CATALOG.roles.filter(r => rs.includes(r.key)).flatMap(r => r.permissions
  .filter(p => r.key === 'org-admin' || !aclEntries.some(e => e.resourceType === 'tenant' && e.effect === 'deny' && e.principalType === 'role' && e.principalRef === r.key && e.permission === p))))];
const people = () => members.filter(m => m.principalId).map(m => ({ id: m.principalId!, kind: 'user', name: m.name, email: m.email, clientId: null, lastSeenAt: m.lastSeenAt }));
const features = { entra: true };
// `?own=1`: Server ohne App der Plattform, nur eigene App-Registrierung (ab iam 0.3.0)
const ownMode = new URLSearchParams(location.search).get('own') === '1';
const OWN_GUIDE = {
  redirectUri: 'https://login.notizen.example/realms/notizen/broker/entra-demo/endpoint',
  permissions: [
    { name: 'User.Read', type: 'Delegated', why: 'Anmeldung', optional: false },
    { name: 'Organization.Read.All', type: 'Application', why: 'Name und verifizierte Domänen des Verzeichnisses', optional: false },
    { name: 'User.Read.All', type: 'Application', why: 'Personen der Domänen lesen und verknüpfen', optional: false },
    { name: 'Application.Read.All', type: 'Application', why: 'Ablauf des Secrets lesen', optional: true },
  ],
};
let ownConn: EntraConnection | null = null;
const APP_TOKEN = 'demo.e2eCredentialsToken_0123456789abcdefABCDEFG';
// Link an die Entra-Administration: Token nur im Fragment; Microsoft leitet in den Tests auf ?p=handoverReturn zurück
const HANDOVER_TOKEN = 'demo.e2eHandoverToken_0123456789abcdefABCDEFGHIJ';
let links: ConsentLink[] = [
  // Gescheitert wie beim Server: Link bleibt bis zum Ablauf offen (nicht eingelöst, noch gültig)
  { id: 'l-alt', entraTenantId: '0f1e2d3c-4b5a-4697-8876-a5b4c3d2e1f0', createdByName: 'Anna Admin', createdAt: ago(3), expiresAt: new Date(Date.now() + 20 * 3_600_000).toISOString(), status: 'failed', usedAt: null, approverName: null, error: { reason: 'consent-unproven', detail: 'Die zustimmende Person ist keine Administration des Verzeichnisses.' } },
];
const routes = makeIamRoutes({}, features);
const roles = () => ({
  items: [...CATALOG.roles.map(r => ({ ...r, custom: false, id: null, version: null, memberCount: members.filter(m => m.roles.includes(r.key)).length, createdAt: null, updatedAt: null })), ...custom],
  customPermissions: CATALOG.permissions.filter(p => !p.adminOnly).map(p => p.key), maxCustom: 50,
});
const idOf = (req: Request) => new URL(req.url).pathname.split('/')[4]!;

const api = mockIamApi({
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
  'GET /v1/admin/entra': () => json(ownMode
    ? { enabled: false, reason: 'Keine App der Plattform eingerichtet', connection: ownConn, methods: { platformApp: false, ownApp: true }, ownAppReason: null, ownApp: OWN_GUIDE }
    : { enabled: true, reason: null, connection: entra }),
  'PUT /v1/admin/entra/app': async req => {
    const b = await req.json() as { tenant: string; clientId: string };
    ownConn = { ...entra, entraTenantId: '3f2b6c1e-8a4d-4f0e-9c7b-1d2e3f4a5b6c', redirectUri: OWN_GUIDE.redirectUri, testedAt: null, testedBy: null, method: 'own', clientId: b.clientId, secretExpiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), secretExpiresSoon: true };
    return json({ connection: ownConn, members: entraMembers, rejectedDomains: [] });
  },
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
      permissions: tenantPerms(simulated ? roles : ME.roles), granted: [], resources: [{ resourceType: 'folder', resourceId: F1, permission: 'note:write', allowed: !simulated }, { resourceType: 'folder', resourceId: F2, permission: 'audit:read', allowed: true }] });
  },
  'GET /v1/people': req => {
    const u = new URL(req.url), q = (u.searchParams.get('q') ?? '').toLowerCase(), ids = u.searchParams.getAll('ids');
    return json({ items: people().filter(p => (ids.length ? ids.includes(p.id) : p.name.toLowerCase().includes(q))), nextCursor: null });
  },
  'GET /v1/admin/entra/consent-links': () => json({ items: links }),
  'POST /v1/admin/entra/consent-links': async req => {
    const b = await req.json() as { tenant: string; validMinutes?: number; kind?: 'consent' | 'credentials' };
    const l: ConsentLink = { id: `l-${links.length}`, entraTenantId: '0f1e2d3c-4b5a-4697-8876-a5b4c3d2e1f0', createdByName: 'Anna Admin', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (b.validMinutes ?? 15) * 60_000).toISOString(), status: 'open', usedAt: null, approverName: null, error: null };
    links = [l, ...links];
    if (b.kind === 'credentials') l.kind = 'credentials';
    return json({ id: l.id, url: `${location.origin}/admin.html?p=handover#${b.kind === 'credentials' ? APP_TOKEN : HANDOVER_TOKEN}`, entraTenantId: l.entraTenantId, expiresAt: l.expiresAt }, 201);
  },
  'DELETE /v1/admin/entra/consent-links/l-1': () => { links = links.map(l => (l.id === 'l-1' ? { ...l, status: 'revoked' as const } : l)); return new Response(null, { status: 204 }); },
  'POST /v1/entra/handover/info': async req => { const { token } = await req.json() as { token: string }; return token === APP_TOKEN
    ? json({ organization: 'Demo AG', product: 'Notizen', requestedBy: 'Anna Admin', tenant: 'demoag.onmicrosoft.com', entraTenantId: '0f1e2d3c-4b5a-4697-8876-a5b4c3d2e1f0', notice: 'Verifizierte Domänen des Verzeichnisses gehen an die Organisation «Demo AG».', expiresAt: new Date(Date.now() + 900_000).toISOString(), kind: 'credentials', ownApp: OWN_GUIDE })
    : token === HANDOVER_TOKEN
    ? json({ organization: 'Demo AG', product: 'Notizen', requestedBy: 'Anna Admin', tenant: 'demoag.onmicrosoft.com', entraTenantId: '0f1e2d3c-4b5a-4697-8876-a5b4c3d2e1f0', notice: 'Verifizierte Domänen des Verzeichnisses gehen an die Organisation «Demo AG».', expiresAt: new Date(Date.now() + 900_000).toISOString() })
    : json({ title: 'Nicht gefunden', status: 404 }, 404); },
  'POST /v1/entra/handover/credentials': async req => {
    const b = await req.json() as { token: string; clientSecret: string };
    return b.token !== APP_TOKEN ? json({ title: 'Nicht gefunden', status: 404 }, 404)
      : b.clientSecret === 'falsch' ? json({ title: 'Secret ungültig', status: 409, detail: 'AADSTS7000215', reason: 'invalid-secret' }, 409)
      : json({ organization: 'Demo AG', connected: true });
  },
  'POST /v1/entra/handover/start': () => json({ url: 'https://login.microsoftonline.com/demoag.onmicrosoft.com/oauth2/v2.0/authorize?state=h.demo.e2e' }),
  'POST /v1/entra/handover/complete': () => json({ organization: 'Demo AG', connected: true }),
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
}, { me: ME });
// Aufrufe der Seite laufen nicht über das Netz: für die Prüfung, wohin das Token geht, im Tab mitschreiben (auch über
// die Weiterleitung zu Microsoft und zurück)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const r = new Request(input, init);
  const log = JSON.parse(sessionStorage.getItem('iamCalls') ?? '[]') as { url: string; body: string }[];
  sessionStorage.setItem('iamCalls', JSON.stringify([...log, { url: r.url, body: await r.clone().text() }]));
  return api.fetch(r);
};

const params = new URLSearchParams(location.search);
const p = params.get('p');
if (p === 'handover') history.replaceState(null, '', `/verwalten/anmeldung/freigabe${location.hash}`);
else if (p === 'handoverReturn') { params.delete('p'); history.replaceState(null, '', `/verwalten/anmeldung/zustimmung?${params}`); }
else history.replaceState(null, '', (routes.find(r => r.id === p) ?? routes[0]!).path.replace(':alias', 'muster'));

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
