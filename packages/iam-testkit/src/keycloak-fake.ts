/**
 * Nachgebildete Keycloak-Admin-API (Organisationen, Benutzer, Gruppen) als `fetch`-Ersatz für die Verwaltung des
 * Baukastens (Spezifikation Kap. 9). Herkunft: vollholz/assets `test/platform/keycloak-fake.ts`.
 * Verhalten wie Keycloak 26.6, soweit die Verwaltung es nutzt (live geprüft): Organisationsmitglieder, Gruppenpfade,
 * E-Mail-Versand scheitert ohne SMTP mit 500, Konten ohne Passwort, 409 bei doppelten Werten, `invite-existing-user`
 * mit 400 (Konto gesperrt, ohne E-Mail, unbekannt) bzw. 409 (schon Mitglied) vor dem Versand, Mitglied hinzufügen mit
 * unbekanntem Konto 400, Benutzersuche mit `email`/`username` (`exact`) und `search` (Teiltreffer).
 * Mit `deny` lassen sich einzelne Pfade sperren (403 wie bei fehlenden Rechten des Service Accounts), mit `fail`
 * scheitern sie mit einem beliebigen Status; `before` läuft vor jedem Aufruf (z. B. Zeitpunkt festhalten, warten).
 * Identitätsanbieter wie Keycloak 26.8 (Nr. 104): Anbieter anlegen/ändern/löschen (Löschen entfernt die Verknüpfungen der
 * Konten), mit Organisationen verbinden (je Verbindung `autoMembership`/`membershipType`), Domains mit
 * `identityProviderAlias`/`autoRedirect`, Verknüpfungen je Konto (409, wenn die Identität schon verknüpft ist),
 * Anmeldedaten löschen, Konten nach Verknüpfung suchen (`idpAlias`/`idpUserId`).
 */
import { randomUUID } from 'node:crypto';

export interface FakeUser { id: string; username: string; email: string; firstName?: string; lastName?: string; enabled: boolean; emailVerified: boolean; requiredActions: string[]; createdTimestamp: number; password: boolean }
export interface FakeOrg { id: string; alias: string; name: string; enabled: boolean; description?: string; domains: { name: string; verified: boolean; identityProviderAlias?: string; autoRedirect?: boolean }[] }
export interface FakeIdp { alias: string; providerId: string; config: Record<string, string>; [k: string]: unknown }
interface FakeGroup { id: string; name: string; path: string; parentId: string | null }

export class KeycloakFake {
  /** Präfix der Rollengruppen (GROUP_ROLE_PREFIX), Standard `/orgs`. */
  readonly groupPrefix: string;
  constructor(o: { groupPrefix?: string } = {}) { this.groupPrefix = (o.groupPrefix ?? '/orgs').replace(/\/$/, ''); }
  readonly orgs = new Map<string, FakeOrg>();
  readonly users = new Map<string, FakeUser>();
  readonly groups = new Map<string, FakeGroup>();
  readonly orgMembers = new Map<string, Set<string>>();
  readonly userGroups = new Map<string, Set<string>>();
  readonly idps = new Map<string, FakeIdp>();
  /** Verbindungen Organisation → Anbieter (Alias → Einstellungen der Verbindung). */
  readonly orgIdps = new Map<string, Map<string, { autoMembership: boolean; membershipType: string }>>();
  /** Verknüpfungen je Konto: Alias → Identität beim Anbieter. */
  readonly links = new Map<string, Map<string, { userId: string; userName: string }>>();
  readonly mails: { userId: string; kind: 'actions' | 'invite-existing'; orgId?: string; actions?: string[]; query?: string }[] = [];
  readonly calls: string[] = [];
  smtp = false;
  /** Pfade (Regex auf «METHOD /pfad»), die mit 403 antworten. */
  deny: RegExp[] = [];
  /** Pfade (Regex auf «METHOD /pfad»), die mit `status` scheitern (z. B. 500), ohne etwas zu ändern. */
  fail: { re: RegExp; status: number }[] = [];
  /** Wird vor jedem Aufruf der Admin-API abgewartet (mit «METHOD /pfad»). */
  before: ((call: string) => Promise<void> | void) | null = null;
  tokenRequests: URLSearchParams[] = [];

  // ---------------------------------------------------------------- Aufbau
  org(alias: string, name = alias): FakeOrg {
    const o: FakeOrg = { id: randomUUID(), alias, name, enabled: true, domains: [{ name: `${alias}.example`, verified: false }] };
    this.orgs.set(o.id, o); this.orgMembers.set(o.id, new Set());
    return o;
  }
  user(username: string, o: Partial<FakeUser> = {}): FakeUser {
    const u: FakeUser = { id: o.id ?? randomUUID(), username, email: o.email ?? `${username}@example.ch`, firstName: o.firstName, lastName: o.lastName, enabled: true, emailVerified: true, requiredActions: [], createdTimestamp: Date.now(), password: true, ...o };
    this.users.set(u.id, u); this.userGroups.set(u.id, new Set());
    return u;
  }
  groupPath(path: string): FakeGroup {
    let parent: FakeGroup | null = null;
    for (const name of path.split('/').filter(Boolean)) {
      const p: string = `${(parent as FakeGroup | null)?.path ?? ''}/${name}`;
      let g: FakeGroup | undefined = [...this.groups.values()].find(x => x.path === p);
      if (!g) { g = { id: randomUUID(), name, path: p, parentId: (parent as FakeGroup | null)?.id ?? null }; this.groups.set(g.id, g); }
      parent = g;
    }
    return parent!;
  }
  /** Person in Organisation mit Rollen (Gruppen <prefix>/<alias>/<rolle>). */
  member(o: FakeOrg, u: FakeUser, roles: string[] = []) {
    this.orgMembers.get(o.id)!.add(u.id);
    for (const r of roles) this.userGroups.get(u.id)!.add(this.groupPath(`${this.groupPrefix}/${o.alias}/${r}`).id);
  }
  rolesOf(o: FakeOrg, u: { id: string }): string[] {
    const base = `${this.groupPrefix}/${o.alias}/`;
    return [...this.userGroups.get(u.id) ?? []].map(id => this.groups.get(id)!.path).filter(p => p.startsWith(base)).map(p => p.slice(base.length)).sort();
  }
  byEmail(email: string) { return [...this.users.values()].find(u => u.email === email) ?? null; }

  // ---------------------------------------------------------------- HTTP
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body;
    if (url.pathname.endsWith('/protocol/openid-connect/token')) {
      this.tokenRequests.push(new URLSearchParams(String(body)));
      return json(200, { access_token: `fake-${randomUUID()}`, expires_in: 120, token_type: 'Bearer' });
    }
    const m = /\/admin\/realms\/[^/]+(\/.*)?$/.exec(url.pathname);
    if (!m) return json(404, { error: 'unbekannt' });
    const path = m[1] ?? '';
    this.calls.push(`${method} ${path}`);
    if (!(new Headers(init?.headers).get('authorization') ?? '').startsWith('Bearer fake-')) return json(401, { error: 'HTTP 401 Unauthorized' });
    if (this.before) await this.before(`${method} ${path}`);
    if (this.deny.some(r => r.test(`${method} ${path}`))) return json(403, { error: 'HTTP 403 Forbidden' });
    const failing = this.fail.find(f => f.re.test(`${method} ${path}`));
    if (failing) return json(failing.status, { errorMessage: 'Fehler (nachgebildet)' });
    const data = typeof body === 'string' && body ? (body.startsWith('{') || body.startsWith('[') || body.startsWith('"') ? JSON.parse(body) : body) : body instanceof URLSearchParams ? Object.fromEntries(body) : undefined;
    return this.route(method, path, url.searchParams, data);
  };

  private page<T>(list: T[], q: URLSearchParams) {
    const first = Number(q.get('first') ?? 0), max = Number(q.get('max') ?? 100);
    return list.slice(first, first + max);
  }
  private userRep(u: FakeUser) { const { password: _p, ...rep } = u; return rep; }
  private groupRep(g: FakeGroup) { return { id: g.id, name: g.name, path: g.path, parentId: g.parentId ?? undefined, subGroupCount: [...this.groups.values()].filter(x => x.parentId === g.id).length }; }

  private route(method: string, path: string, q: URLSearchParams, data: any): Response {
    let r: RegExpExecArray | null;
    const seg = path.split('/').filter(Boolean);
    // Realm (mit manage-realm lesbar; SMTP-Server nur, wenn eingerichtet)
    if (path === '' && method === 'GET') return json(200, { realm: 'test', enabled: true, smtpServer: this.smtp ? { host: 'smtp.test', from: 'noreply@test' } : {} });
    // Organisationen
    if (path === '/organizations' && method === 'GET') return json(200, this.page([...this.orgs.values()], q));
    if (path === '/organizations' && method === 'POST') {
      if ([...this.orgs.values()].some(o => o.alias === data.alias || o.name === data.name)) return json(409, { errorMessage: 'A organization with the same name already exists.' });
      const domains = (data.domains ?? []) as { name: string }[];
      if ([...this.orgs.values()].some(o => o.domains.some(d => domains.some(x => x.name === d.name)))) return json(409, { errorMessage: 'Domain already linked' });
      const o: FakeOrg = { id: randomUUID(), alias: data.alias, name: data.name, enabled: data.enabled !== false, description: data.description, domains: domains.map(d => ({ name: d.name, verified: false })) };
      this.orgs.set(o.id, o); this.orgMembers.set(o.id, new Set());
      return created(`/organizations/${o.id}`);
    }
    if ((r = /^\/organizations\/members\/([^/]+)\/organizations$/.exec(path))) {
      const uid = r[1]!;
      return json(200, [...this.orgs.values()].filter(o => this.orgMembers.get(o.id)!.has(uid)));
    }
    if (seg[0] === 'organizations' && seg[1]) {
      const o = this.orgs.get(seg[1]);
      if (!o) return json(404, { error: 'Organization not found' });
      if (seg[2] === 'identity-providers') {
        const links = this.orgIdps.get(o.id) ?? new Map();
        this.orgIdps.set(o.id, links);
        if (seg.length === 3 && method === 'POST') {
          const alias = String(data).trim().replace(/^"|"$/g, '');
          if (!this.idps.has(alias)) return json(400, { errorMessage: 'Identity provider not found with the given alias' });
          if (links.has(alias)) return json(409, { errorMessage: 'Identity provider already associated to the organization' });
          links.set(alias, { autoMembership: true, membershipType: 'UNMANAGED' }); return empty();
        }
        if (seg.length === 3 && method === 'GET') return json(200, [...links.keys()].map(a => this.idps.get(a)));
        const alias = seg[3]!;
        if (!links.has(alias)) return json(404, { errorMessage: 'Identity provider not associated with the organization' });
        if (method === 'PUT') { links.set(alias, { autoMembership: data.autoMembership ?? true, membershipType: data.membershipType ?? 'UNMANAGED' }); return empty(); }
        if (method === 'DELETE') { links.delete(alias); return empty(); }
      }
      if (seg.length === 2) {
        if (method === 'GET') return json(200, o);
        if (method === 'PUT') {
          if (data.alias !== o.alias) return json(400, { errorMessage: 'Cannot change the alias' });
          const names = ((data.domains ?? []) as { name: string }[]).map(d => d.name);
          if ([...this.orgs.values()].some(x => x.id !== o.id && x.domains.some(d => names.includes(d.name)))) return json(400, { errorMessage: 'Domain is already linked to organization' });
          if (((data.domains ?? []) as { identityProviderAlias?: string }[]).some(d => d.identityProviderAlias && !this.orgIdps.get(o.id)?.has(d.identityProviderAlias))) return json(400, { errorMessage: 'Identity provider not linked to the organization' });
          Object.assign(o, { name: data.name, enabled: data.enabled, description: data.description, domains: data.domains });
          return empty();
        }
        if (method === 'DELETE') { this.orgs.delete(o.id); return empty(); }
      }
      const members = this.orgMembers.get(o.id)!;
      if (seg[2] === 'members' && seg.length === 3) {
        if (method === 'GET') return json(200, this.page([...members], q).map(id => ({ ...this.userRep(this.users.get(id)!), membershipType: 'UNMANAGED' })));
        if (method === 'POST') {
          const uid = String(data);
          if (!this.users.has(uid)) return json(400, { errorMessage: 'User does not exist' });
          if (members.has(uid)) return json(409, { errorMessage: 'User is already a member of the organization.' });
          members.add(uid); return created(`/organizations/${o.id}/members/${uid}`);
        }
      }
      if (seg[2] === 'members' && seg[3] === 'invite-existing-user' && method === 'POST') {
        // Keycloak prüft das Konto vor dem Versand
        const u = this.users.get(String(data?.id ?? ''));
        if (!u) return json(400, { errorMessage: 'User does not exist' });
        if (!u.enabled) return json(400, { errorMessage: 'User is disabled' });
        if (!u.email) return json(400, { errorMessage: 'User does not have an email address' });
        if (members.has(u.id)) return json(409, { errorMessage: 'User already a member of the organization' });
        if (!this.smtp) return json(500, { errorMessage: 'Failed to send invite email' });
        this.mails.push({ userId: data.id, kind: 'invite-existing', orgId: o.id });
        return empty();
      }
      if (seg[2] === 'members' && seg[3]) {
        const uid = seg[3];
        if (!members.has(uid)) return json(404, { error: 'User is not a member of the organization' });
        if (method === 'GET') return json(200, { ...this.userRep(this.users.get(uid)!), membershipType: 'UNMANAGED' });
        if (method === 'DELETE') { members.delete(uid); return empty(); }
      }
    }
    // Benutzer
    if (path === '/users' && method === 'GET') {
      // email/username: genau mit exact=true, sonst Teiltreffer; search: Teiltreffer in Benutzername, Adresse, Name
      const exact = q.get('exact') === 'true', email = q.get('email')?.toLowerCase(), username = q.get('username')?.toLowerCase(), search = q.get('search')?.toLowerCase();
      // idpAlias/idpUserId: Konto mit dieser Verknüpfung (Keycloak 26: Suche über die Identität beim Anbieter)
      const idpAlias = q.get('idpAlias'), idpUserId = q.get('idpUserId');
      if (idpAlias || idpUserId) {
        return json(200, [...this.users.values()].filter(u => [...this.links.get(u.id) ?? []].some(([a, l]) => (!idpAlias || a === idpAlias) && (!idpUserId || l.userId === idpUserId))).map(u => this.userRep(u)));
      }
      const hit = (v: string | undefined, want: string) => !!v && (exact ? v.toLowerCase() === want : v.toLowerCase().includes(want));
      const list = [...this.users.values()].filter(u => (!email || hit(u.email, email)) && (!username || hit(u.username, username))
        && (!search || [u.username, u.email, u.firstName, u.lastName].some(v => v?.toLowerCase().includes(search))));
      return json(200, this.page(list, q).map(u => this.userRep(u)));
    }
    if (path === '/users' && method === 'POST') {
      if ([...this.users.values()].some(u => u.username === data.username || u.email === data.email)) return json(409, { errorMessage: 'User exists with same username' });
      const u = this.user(data.username, { email: data.email, firstName: data.firstName, lastName: data.lastName, enabled: data.enabled, emailVerified: !!data.emailVerified, requiredActions: data.requiredActions ?? [], password: false });
      return created(`/users/${u.id}`);
    }
    // Identitätsanbieter
    if (seg[0] === 'identity-provider' && seg[1] === 'instances') {
      if (seg.length === 2 && method === 'POST') {
        if (this.idps.has(data.alias)) return json(409, { errorMessage: 'Identity Provider with alias exists' });
        this.idps.set(data.alias, data); return created(`/identity-provider/instances/${data.alias}`);
      }
      const idp = this.idps.get(seg[2] ?? '');
      if (!idp) return json(404, { error: 'Identity provider not found' });
      if (method === 'GET') return json(200, { ...idp, config: { ...idp.config, clientSecret: '**********' } });
      if (method === 'PUT') { this.idps.set(idp.alias, data); return empty(); }
      if (method === 'DELETE') {
        this.idps.delete(idp.alias);
        for (const l of this.links.values()) l.delete(idp.alias);
        for (const l of this.orgIdps.values()) l.delete(idp.alias);
        return empty();
      }
    }
    if (seg[0] === 'users' && seg[1]) {
      const u = this.users.get(seg[1]);
      if (!u) return json(404, { error: 'User not found' });
      if (seg.length === 2 && method === 'GET') return json(200, this.userRep(u));
      if (seg.length === 2 && method === 'PUT') { if (data.requiredActions) u.requiredActions = data.requiredActions; return empty(); }
      if (seg[2] === 'credentials' && seg[3] && method === 'DELETE') { if (seg[3] === 'c1') u.password = false; return empty(); }
      if (seg[2] === 'federated-identity') {
        const mine = this.links.get(u.id) ?? new Map();
        this.links.set(u.id, mine);
        if (seg.length === 3) return json(200, [...mine].map(([identityProvider, l]) => ({ identityProvider, ...l })));
        const alias = seg[3]!;
        if (method === 'POST') {
          if (!this.idps.has(alias)) return json(404, { error: 'Identity provider not found' });
          if (mine.has(alias) || [...this.links.values()].some(l => l.get(alias)?.userId === data.userId)) return json(409, { errorMessage: 'User is already linked with provider' });
          mine.set(alias, { userId: data.userId, userName: data.userName }); return empty();
        }
        if (method === 'DELETE') { if (!mine.delete(alias)) return json(404, { error: 'Not found' }); return empty(); }
      }
      if (seg.length === 2 && method === 'DELETE') {
        this.users.delete(u.id); this.userGroups.delete(u.id);
        for (const s of this.orgMembers.values()) s.delete(u.id);
        return empty();
      }
      if (seg[2] === 'credentials') return json(200, u.password ? [{ id: 'c1', type: 'password' }] : []);
      if (seg[2] === 'execute-actions-email' && method === 'PUT') {
        if (!this.smtp) return json(500, { errorMessage: "Failed to send execute actions email: Invalid sender address 'null'." });
        this.mails.push({ userId: u.id, kind: 'actions', actions: data, query: q.toString() });
        return empty();
      }
      if (seg[2] === 'groups' && seg.length === 3) return json(200, [...this.userGroups.get(u.id)!].map(id => this.groupRep(this.groups.get(id)!)));
      if (seg[2] === 'groups' && seg[3]) {
        const g = this.groups.get(seg[3]);
        if (!g) return json(404, { error: 'Could not find group by id' });
        if (method === 'PUT') { this.userGroups.get(u.id)!.add(g.id); return empty(); }
        if (method === 'DELETE') { this.userGroups.get(u.id)!.delete(g.id); return empty(); }
      }
    }
    // Gruppen
    if (seg[0] === 'group-by-path') {
      const p = `/${seg.slice(1).map(decodeURIComponent).join('/')}`;
      const g = [...this.groups.values()].find(x => x.path === p);
      return g ? json(200, this.groupRep(g)) : json(404, { error: 'Group path does not exist' });
    }
    if (path === '/groups' && method === 'POST') {
      if ([...this.groups.values()].some(g => g.parentId === null && g.name === data.name)) return json(409, { errorMessage: 'Top level group named already exists.' });
      const g = this.groupPath(`/${data.name}`); return created(`/groups/${g.id}`);
    }
    if (seg[0] === 'groups' && seg[1]) {
      const g = this.groups.get(seg[1]);
      if (!g) return json(404, { error: 'Could not find group by id' });
      if (seg[2] === 'children' && method === 'POST') {
        if ([...this.groups.values()].some(x => x.parentId === g.id && x.name === data.name)) return json(409, { errorMessage: 'Sibling group named already exists.' });
        const c = this.groupPath(`${g.path}/${data.name}`); return created(`/groups/${c.id}`);
      }
      if (seg.length === 2 && method === 'DELETE') {
        for (const gs of this.userGroups.values()) gs.delete(g.id);
        this.groups.delete(g.id);
        return empty();
      }
      if (seg[2] === 'members' && method === 'GET') {
        return json(200, this.page([...this.userGroups].filter(([, gs]) => gs.has(g.id)).map(([id]) => this.userRep(this.users.get(id)!)), q));
      }
    }
    return json(404, { error: `nicht nachgebildet: ${method} ${path}` });
  }
}

function json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function created(location: string) { return new Response(null, { status: 201, headers: { location: `http://keycloak.test/admin/realms/test${location}` } }); }
function empty() { return new Response(null, { status: 204 }); }
