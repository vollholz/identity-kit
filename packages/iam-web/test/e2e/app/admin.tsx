/**
 * Testseite der Verwalten-Seiten und der Zugriffs-Bausteine: Navigation «Zugang» (IamNav), Seiten aus `iamRoutes` (mit
 * Guard, per `load()`), nachgebildete API mit Zustand (Einladen, Rollen und Freigabestufe setzen, Clients freigeben,
 * Freigaben an Orten, «Warum?», Break-Glass, Organisationen), Ordner und Notizen über `staticResources`. Die Person
 * gehört zur Plattform-Administration. `?p=<id>` startet auf dieser Route (`organization` mit «muster»), `?p=notes` auf
 * der Seite «Notizen» der App mit «Zugriff …» je Ordner und Notiz.
 */
import { lazy, StrictMode, Suspense, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/styles.css';
import {
  AccessSheet, BreakGlassBanner, ClassificationBadge, historyRouter, IamNav, IamProvider, makeIamRoutes, WhyDialog,
  type AccessEntry, type Client, type ConsentLink, type EntraConnection, type Explain, type Level, type Me, type Member, type Organization, type ResourceRef,
} from '../../../src/index.ts';
import { accountInfo, CATALOG, json, ME, mockIamApi, staticResources } from '../../../src/testing/index.tsx';
import './page.css';

sessionStorage.removeItem('iam.tab.org');
/** Principal-ID (UUID) je Mitglied, fest aus der ID abgeleitet. */
const pid = (id: string) => `00000000-0000-4000-8000-${[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 0xffffffffffff, 7).toString(16).padStart(12, '0')}`;
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const member = (id: string, name: string, email: string, roles: string[], o: Partial<Member> = {}): Member => ({
  id, kind: 'user', principalId: pid(id), username: email, name, email, status: 'active', roles, clearance: 0, breakGlassUntil: null, places: 0,
  lastSeenAt: ago(1), createdAt: null, loginPath: null, clientId: null, scopes: null, description: null, ...o,
});
let me: Me = { ...ME, clearance: 1, tenant: { ...ME.tenant!, entraConnected: true } };
let members: Member[] = [
  member(ME.person.subject, 'Anna Admin', 'anna@demo.example', ['org-admin'], { lastSeenAt: ago(0), clearance: 1 }),
  member('m-carla', 'Carla Check', 'carla@demo.example', ['editor', 'viewer'], { lastSeenAt: ago(2), places: 2 }),
  member('m-nora', 'Nora Neu', 'nora@demo.example', ['viewer'], { status: 'invited', lastSeenAt: null, createdAt: ago(3) }),
  member('m-erik', 'Erik Extern mit einem sehr langen Namen', 'erik.extern@partner-mit-langer-domain.example', ['auditor'], { status: 'disabled', lastSeenAt: null }),
];
let clients: Client[] = [
  { clientId: 'notiz-import', principalId: pid('notiz-import'), description: 'Nächtlicher Import', roles: ['editor'], clearance: 0, places: 0, createdAt: ago(20), createdBy: 'Anna Admin', lastUsedAt: ago(0.1), lastScopes: ['notes:read'] },
];
const clientMember = (c: Client): Member => member(c.clientId, c.clientId, '', c.roles, {
  kind: 'client', principalId: c.principalId, username: `service-account-${c.clientId}`, email: null, clearance: c.clearance, clientId: c.clientId, scopes: c.lastScopes, lastSeenAt: c.lastUsedAt, createdAt: c.createdAt,
});
const all = () => [...members, ...clients.map(clientMember)];
const people = () => members.map(m => ({ id: m.principalId, kind: 'user', name: m.name, email: m.email, clientId: null, lastSeenAt: m.lastSeenAt }));
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

// Orte der App: Ordner und Notizen (Kette org → folder → note)
const F1 = '00000000-0000-4000-8000-0000000000f1', F2 = '00000000-0000-4000-8000-0000000000f2', N1 = '00000000-0000-4000-8000-0000000000a1', N2 = '00000000-0000-4000-8000-0000000000a2';
const NAMES: Record<string, Record<string, string>> = { folder: { [F1]: 'Projekte', [F2]: 'Archiv mit einem langen Ordnernamen' }, note: { [N1]: 'Protokoll', [N2]: 'Lohnliste' } };
const PARENT: Record<string, ResourceRef> = { [N1]: { type: 'folder', id: F1 }, [N2]: { type: 'folder', id: F1 } };
let classification: Record<string, Level> = { [N1]: 1, [N2]: 2 };
let opened: ResourceRef | null = null;
const openListeners = new Set<(r: ResourceRef) => void>();
const resources = staticResources(NAMES, { open: ref => { opened = ref; for (const l of openListeners) l(ref); } });

/** Freigaben (Tupel) mit Zustand; die Antwort von GET /v1/access setzt die Kette (geerbt) wie der Server zusammen. */
interface Tuple { id: string; subject: AccessEntry['subject']; relation: string; place: ResourceRef; expiresAt: string | null }
const anna: AccessEntry['subject'] = { ref: `user:${pid(ME.person.subject)}`, kind: 'user', name: 'Anna Admin' };
const carla: AccessEntry['subject'] = { ref: `user:${pid('m-carla')}`, kind: 'user', name: 'Carla Check' };
let seq = 0;
let tuples: Tuple[] = [
  { id: 't-anna', subject: anna, relation: 'org-admin', place: { type: 'org', id: null }, expiresAt: null },
  { id: 't-sync', subject: { ref: `client:${pid('notiz-import')}`, kind: 'client', name: 'notiz-import', scopes: ['notes:read'] }, relation: 'editor', place: { type: 'org', id: null }, expiresAt: null },
  { id: 't-carla-f1', subject: carla, relation: 'editor', place: { type: 'folder', id: F1 }, expiresAt: null },
  { id: 't-carla-n1', subject: carla, relation: 'viewer', place: { type: 'note', id: N1 }, expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString() },
  { id: 't-group-f1', subject: { ref: 'group:0f0e0d0c-1111', kind: 'group', name: 'Team Planung mit einem langen Gruppennamen' }, relation: 'viewer', place: { type: 'folder', id: F1 }, expiresAt: null },
];
const chain = (ref: ResourceRef): ResourceRef[] => (ref.type === 'org' ? [ref] : ref.type === 'folder' ? [{ type: 'org', id: null }, ref] : [{ type: 'org', id: null }, PARENT[ref.id!]!, ref]);
const same = (a: ResourceRef, b: ResourceRef) => a.type === b.type && (a.id ?? null) === (b.id ?? null);
const asEntry = (x: Tuple, at: ResourceRef): AccessEntry => {
  const direct = same(x.place, at);
  return { id: x.id, subject: x.subject, relation: x.relation, place: x.place, via: direct ? 'direct' : 'inherited', expiresAt: x.expiresAt, createdAt: ago(5), createdBy: 'Anna Admin', removable: direct && x.relation !== 'org-admin' };
};
const refOf = (u: URL): ResourceRef => ({ type: u.searchParams.get('type') ?? 'org', id: u.searchParams.get('id') });
/** Rollen an Orten: was am Typ hängen darf; ich (org-admin) darf alles ausser org-admin vergeben. */
const grantable = (ref: ResourceRef) => (CATALOG.types.find(x => x.key === ref.type)?.roles ?? []).filter(r => r !== 'org-admin');
const mark = (list: Member[]) => list.map(m => ({ ...m, places: tuples.filter(x => x.subject.ref === `${m.kind}:${m.principalId}` && x.place.type !== 'org').length }));
const syncMe = () => {
  const u = members.find(m => m.id === ME.person.subject)!;
  me = { ...me, clearance: me.breakGlassUntil && Date.parse(me.breakGlassUntil) > Date.now() ? 2 : u.clearance };
};

const features = { entra: true };
// `?own=1`: Server ohne App der Plattform, nur eigene App-Registrierung (ab iam 0.3.0)
const ownMode = new URLSearchParams(location.search).get('own') === '1';
const OWN_GUIDE = {
  redirectUri: 'https://login.notizen.example/realms/notizen/broker/entra-demo/endpoint',
  permissions: [
    { name: 'User.Read', type: 'Delegated', why: 'Anmeldung', optional: false },
    { name: 'Organization.Read.All', type: 'Application', why: 'Name und verifizierte Domänen des Verzeichnisses', optional: false },
    { name: 'User.Read.All', type: 'Application', why: 'Personen der Domänen lesen und verknüpfen', optional: false },
    { name: 'Application.Read.All', type: 'Application', why: 'Registrierung im Verzeichnis nachweisen, Ablauf des Secrets lesen', optional: false },
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
const idOf = (req: Request) => new URL(req.url).pathname.split('/')[4]!;

const api = mockIamApi({
  'GET /auth/me': () => { syncMe(); return json(me); },
  'GET /v1/admin/status': () => json({ enabled: true, reason: null, organization: 'demo', platformAdmin: true, canManageMembers: true, roles: CATALOG.roles }),
  'GET /v1/account': () => json(accountInfo({ platformAdmin: true })),
  'GET /v1/admin/members': () => json({ items: mark(all()) }),
  'POST /v1/admin/members': async req => {
    const b = await req.json() as { email: string; roles: string[] };
    const m = member(`m-${members.length}`, b.email.split('@')[0]!, b.email, b.roles, { status: 'invited', lastSeenAt: null, createdAt: new Date().toISOString() });
    members = [...members, m];
    return json({ result: 'invitation-sent', emailSent: true, member: m }, 202);
  },
  ...Object.fromEntries(members.flatMap(m => [[`PUT /v1/admin/members/${m.id}/roles`, async (req: Request) => {
    const { roles: r } = await req.json() as { roles: string[] };
    members = members.map(x => (x.id === idOf(req) ? { ...x, roles: r } : x));
    return json(members.find(x => x.id === idOf(req)));
  }], [`PUT /v1/admin/members/${m.id}/clearance`, async (req: Request) => {
    const { clearance } = await req.json() as { clearance: Level };
    if (idOf(req) === ME.person.subject) return json({ title: 'Verboten', status: 403, reason: 'self' }, 403);
    members = members.map(x => (x.id === idOf(req) ? { ...x, clearance } : x));
    return json(members.find(x => x.id === idOf(req)));
  }]])),
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
  ...Object.fromEntries(['notiz-import', 'notiz-2'].flatMap(id => [[`PUT /v1/admin/clients/${id}`, async (req: Request) => {
    const b = await req.json() as { roles: string[]; description?: string; clearance?: Level };
    const old = clients.find(c => c.clientId === id);
    const c: Client = { clientId: id, principalId: pid(id), description: b.description ?? old?.description ?? '', roles: b.roles, clearance: b.clearance ?? 0, places: 0, createdAt: old?.createdAt ?? new Date().toISOString(), createdBy: 'Anna Admin', lastUsedAt: old?.lastUsedAt ?? null, lastScopes: old?.lastScopes ?? null };
    clients = old ? clients.map(x => (x.clientId === id ? c : x)) : [...clients, c];
    return json(c);
  }], [`DELETE /v1/admin/clients/${id}`, () => { clients = clients.filter(c => c.clientId !== id); return new Response(null, { status: 204 }); }]])),
  'GET /v1/access': req => {
    const u = new URL(req.url);
    const subject = u.searchParams.get('subject');
    if (subject) {
      const ref = subject === 'me' ? anna.ref : subject;
      return json({ items: tuples.filter(x => x.subject.ref === ref).map(x => asEntry(x, x.place)) });
    }
    const ref = refOf(u);
    if (ref.type !== 'org' && !NAMES[ref.type]?.[ref.id ?? '']) return json({ title: 'Nicht gefunden', status: 404 }, 404);
    const path = chain(ref);
    const items = path.slice().reverse().flatMap(at => tuples.filter(x => same(x.place, at)).map(x => asEntry(x, ref)));
    return json({ resource: ref, classification: ref.type === 'note' ? classification[ref.id!] ?? 0 : null, items, grantable: grantable(ref) });
  },
  'POST /v1/access': async req => {
    const b = await req.json() as { subject: string; relation: string; type: string; id?: string | null; expiresAt?: string | null };
    const place = { type: b.type, id: b.id ?? null };
    if (tuples.some(x => x.subject.ref === b.subject && x.relation === b.relation && same(x.place, place))) return json({ title: 'Besteht schon', status: 409, reason: 'duplicate' }, 409);
    const name = b.subject === 'org:members' ? 'Alle Mitglieder' : b.subject.startsWith('group:') ? 'Abteilung X' : people().find(p => `user:${p.id}` === b.subject)?.name ?? b.subject;
    const kind = b.subject === 'org:members' ? 'members' : b.subject.startsWith('group:') ? 'group' : 'user';
    const x: Tuple = { id: `t-${++seq}`, subject: { ref: b.subject, kind, name }, relation: b.relation, place, expiresAt: b.expiresAt ?? null };
    tuples = [...tuples, x];
    return json(asEntry(x, place), 201);
  },
  'GET /v1/access/groups': req => {
    const q = (new URL(req.url).searchParams.get('q') ?? '').toLowerCase();
    return json({ items: [{ id: '0f0e0d0c-2222', name: 'Abteilung X' }, { id: '0f0e0d0c-3333', name: 'Abteilung Y' }].filter(g => g.name.toLowerCase().includes(q)) });
  },
  'GET /v1/access/explain': req => {
    const ref = refOf(new URL(req.url));
    const level = ref.type === 'note' ? classification[ref.id!] ?? 0 : 0;
    syncMe();
    const reasons: Explain['reasons'] = [{ via: ref.type === 'org' ? 'direct' : 'inherited', relation: 'org-admin', place: { type: 'org', id: null }, tupleId: 't-anna', matched: anna.ref, label: 'Anna Admin' }];
    const blocked = level > me.clearance ? { reason: 'clearance' as const, classification: level, clearance: me.clearance } : null;
    return json({ allowed: !blocked, permission: 'note:read', subject: { ref: anna.ref, name: 'Anna Admin' }, reasons, blocked } satisfies Explain);
  },
  'POST /v1/break-glass': async req => {
    const { minutes } = await req.json() as { minutes: number };
    me = { ...me, breakGlassUntil: new Date(Date.now() + minutes * 60_000).toISOString(), clearance: 2 };
    return json({ until: me.breakGlassUntil, clearance: 2 });
  },
  'DELETE /v1/break-glass': () => { me = { ...me, breakGlassUntil: null }; syncMe(); return new Response(null, { status: 204 }); },
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
    [`GET /v1/platform/organizations/${a}/members`, () => json({ items: a === 'demo' ? mark(all()) : [member(`m-${a}`, 'Mara Muster', `mara@${a}.example`, ['org-admin'], { clearance: 2 })] })],
    [`GET /v1/platform/organizations/${a}/clients`, () => json({ items: a === 'demo' ? clients : [] })],
    [`POST /v1/platform/organizations/${a}/suspend`, () => json(setOrg(a, o => ({ ...o, enabled: false, tenant: o.tenant && { ...o.tenant, status: 'suspended' } })))],
    [`POST /v1/platform/organizations/${a}/resume`, () => json(setOrg(a, o => ({ ...o, enabled: true, tenant: o.tenant && { ...o.tenant, status: 'active' } })))],
  ])),
});
// Aufrufe der Seite laufen nicht über das Netz: für die Prüfung, wohin das Token geht, im Tab mitschreiben (auch über
// die Weiterleitung zu Microsoft und zurück)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const r = new Request(input, init);
  const log = JSON.parse(sessionStorage.getItem('iamCalls') ?? '[]') as { url: string; body: string }[];
  sessionStorage.setItem('iamCalls', JSON.stringify([...log, { url: r.url, body: await r.clone().text() }]));
  // Freigaben je Tupel-ID (der Mock kennt nur feste Pfade)
  const t = /^\/v1\/access\/(t-[\w-]+)$/.exec(new URL(r.url).pathname)?.[1];
  if (t && r.method === 'DELETE') { tuples = tuples.filter(x => x.id !== t); return new Response(null, { status: 204 }); }
  if (t && r.method === 'PATCH') {
    const { expiresAt } = await r.json() as { expiresAt: string | null };
    tuples = tuples.map(x => (x.id === t ? { ...x, expiresAt } : x));
    const x = tuples.find(y => y.id === t)!;
    return json(asEntry(x, x.place));
  }
  return api.fetch(r);
};

const params = new URLSearchParams(location.search);
const p = params.get('p');
if (p === 'notes') history.replaceState(null, '', '/notizen');
else if (p === 'handover') history.replaceState(null, '', `/verwalten/anmeldung/freigabe${location.hash}`);
else if (p === 'handoverReturn') { params.delete('p'); history.replaceState(null, '', `/verwalten/anmeldung/zustimmung?${params}`); }
else history.replaceState(null, '', (routes.find(r => r.id === p) ?? routes[0]!).path.replace(':alias', 'muster'));

/** Route zum Pfad; `:alias` passt auf einen Abschnitt (wie im Router der App). */
const match = (path: string) => routes.find(r => new RegExp(`^${r.path.replace(/:[a-z]+/g, '[^/]+')}$`).test(path));

/** Seite der App: Ordner und Notizen mit Badge der Vertraulichkeit, «Zugriff …» und «Warum sehe ich das?». */
function NotesPage() {
  const [sheet, setSheet] = useState<{ ref: ResourceRef; label: string } | null>(null);
  const [why, setWhy] = useState<{ ref: ResourceRef; label: string } | null>(null);
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = (ref: ResourceRef) => { setSheet({ ref, label: ref.type === 'org' ? 'Demo AG' : NAMES[ref.type]![ref.id!]! }); rerender(n => n + 1); };
    openListeners.add(l);
    return () => { openListeners.delete(l); };
  }, []);
  const rows: { ref: ResourceRef; label: string; level?: Level }[] = [
    { ref: { type: 'folder', id: F1 }, label: 'Projekte' }, { ref: { type: 'folder', id: F2 }, label: NAMES.folder![F2]! },
    { ref: { type: 'note', id: N1 }, label: 'Protokoll', level: classification[N1] }, { ref: { type: 'note', id: N2 }, label: 'Lohnliste', level: classification[N2] },
  ];
  return (
    <div className="notes">
      <h1>Notizen</h1>
      <ul className="notes-list" aria-label="Ordner und Notizen">
        {rows.map(r => (
          <li key={`${r.ref.type}:${r.ref.id}`}>
            <span className="notes-name">{r.ref.type === 'folder' ? 'Ordner' : 'Notiz'} «{r.label}»</span>
            {r.level !== undefined ? <ClassificationBadge level={r.level} /> : null}
            <span className="notes-acts">
              <button type="button" className="iam-btn iam-sm" onClick={() => setSheet(r)}>Zugriff<span className="iam-sr"> auf {r.label}</span> …</button>
              <button type="button" className="iam-linkbtn" onClick={() => setWhy(r)}>Warum sehe ich das?<span className="iam-sr"> ({r.label})</span></button>
            </span>
          </li>
        ))}
      </ul>
      <p className="iam-muted">Zuletzt geöffnet: <output>{opened ? `${opened.type}:${opened.id ?? ''}` : '–'}</output></p>
      {sheet ? (
        <AccessSheet resource={sheet.ref} label={sheet.label} open onClose={() => setSheet(null)}
          classification={sheet.ref.type === 'note' ? {
            level: classification[sheet.ref.id!] ?? 0,
            onChange: async l => { classification = { ...classification, [sheet.ref.id!]: l }; rerender(n => n + 1); },
          } : undefined} />
      ) : null}
      {why ? <WhyDialog resource={why.ref} label={why.label} onClose={() => setWhy(null)} /> : null}
    </div>
  );
}

function Pages() {
  const path = historyRouter.usePathname();
  if (path === '/notizen') return <NotesPage />;
  const route = match(path);
  const Page = useMemo(() => (route ? lazy(route.load) : null), [route]);
  return Page ? <Suspense fallback={<p>Lädt …</p>}><Page /></Suspense> : <p>Unbekannt: {path}</p>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IamProvider product="Notizen" features={features} resources={resources}>
      <BreakGlassBanner />
      <div className="admin">
        <aside><IamNav /><a className="notes-link" href="/admin.html?p=notes">Notizen</a></aside>
        <main className="admin-main"><Pages /></main>
      </div>
    </IamProvider>
  </StrictMode>,
);
