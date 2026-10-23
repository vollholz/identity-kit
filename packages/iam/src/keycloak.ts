/**
 * Zugang zur Keycloak-Admin-API für die Verwaltung von Organisationen, Mitgliedern und Rollen (Spezifikation Kap. 9;
 * aus Assets `modules/admin/keycloak.ts`).
 *
 * Anmeldung als eigener vertraulicher Client mit Service Account (KEYCLOAK_MGMT_CLIENT_ID, im Worker
 * KEYCLOAK_SYNC_CLIENT_ID) im Realm der Plattform, bevorzugt mit `private_key_jwt` (RFC 7523), sonst mit
 * Client-Geheimnis. Die Rechte des Service Accounts richtet das Realm-Modul ein.
 *
 * Diese Klasse kennt keine Mandantengrenze: Sie führt aus, was ihr gesagt wird. Die Grenze setzen die Module durch.
 */
import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, importPKCS8, SignJWT, type CryptoKey, type JWK } from 'jose';
import { ConfigError, type IamConfig } from './config.ts';
import { HttpError } from './errors.ts';

export interface KcOrg { id: string; alias: string; name: string; enabled: boolean; description?: string; domains?: KcOrgDomain[]; [k: string]: unknown }
export interface KcUser {
  id: string; username: string; email?: string; firstName?: string; lastName?: string; enabled: boolean; emailVerified?: boolean;
  requiredActions?: string[]; createdTimestamp?: number; membershipType?: string;
}
/** Domain einer Organisation; ab Keycloak 26.8 mit Anbieter und automatischer Weiterleitung je Domain. */
export interface KcOrgDomain { name: string; verified?: boolean; identityProviderAlias?: string; autoRedirect?: boolean }
/** Mapper eines Identitätsanbieters (z. B. `entra-groups`). */
export interface KcIdpMapper { id?: string; name: string; identityProviderAlias: string; identityProviderMapper: string; config: Record<string, string> }

export interface KcIdp {
  alias: string; displayName?: string; providerId: string; enabled: boolean; trustEmail?: boolean; storeToken?: boolean; linkOnly?: boolean;
  hideOnLogin?: boolean; firstBrokerLoginFlowAlias?: string; postBrokerLoginFlowAlias?: string; config: Record<string, string>; [k: string]: unknown;
}
export interface KcFederatedIdentity { identityProvider: string; userId: string; userName: string }
export interface KcCredential { id: string; type: string }

/** Signaturverfahren, Schlüssel-ID (JWK-Thumbprint) und öffentlicher Schlüssel eines privaten Schlüssels (PEM). */
export async function keyInfo(pem: string): Promise<{ alg: string; kid: string; publicJwk: JWK }> {
  const k = createPrivateKey(pem);
  const t = k.asymmetricKeyType;
  const alg = t === 'rsa' ? 'RS256' : t === 'ec' ? ({ prime256v1: 'ES256', secp384r1: 'ES384', secp521r1: 'ES512' } as Record<string, string>)[k.asymmetricKeyDetails?.namedCurve ?? ''] : undefined;
  if (!alg) throw new ConfigError(`Privater Schlüssel für Keycloak: Schlüsseltyp ${t} nicht unterstützt (EC P-256/384/521 oder RSA)`);
  const jwk = await exportJWK(createPublicKey(k));
  const kid = await calculateJwkThumbprint(jwk, 'sha256');
  return { alg, kid, publicJwk: { ...jwk, kid, alg, use: 'sig' } };
}

/**
 * Fehler der Admin-API → verständlicher Fehler der Plattform (ohne Interna von Keycloak preiszugeben). `kcMessage`:
 * Meldung von Keycloak (`errorMessage`), nur fürs Log (die Fehlerbehandlung protokolliert den Fehler), nie in der Antwort.
 */
export class KeycloakError extends HttpError {
  readonly kcStatus: number;
  readonly kcMessage: string | null;
  constructor(kcStatus: number, what: string, detail?: string, kcMessage: string | null = null) {
    const status = kcStatus === 404 ? 404 : kcStatus === 409 ? 409 : 502;
    const title = kcStatus === 404 ? 'In Keycloak nicht gefunden' : kcStatus === 409 ? 'Konflikt in Keycloak' : 'Keycloak-Verwaltung nicht verfügbar';
    super(status, title, detail ?? what);
    this.kcStatus = kcStatus;
    this.kcMessage = kcMessage;
  }
}

type Fetch = typeof fetch;

/**
 * Ein Pfadsegment der Admin-API. `encodeURIComponent` kodiert `.` nicht, und `fetch` löst Punkt-Segmente auf: Eine ID
 * `..` machte aus `DELETE /users/..` ein `DELETE` auf den Realm. Leere Segmente, `.`, `..` und Segmente mit `/` werden
 * deshalb abgewiesen, bevor eine Anfrage hinausgeht.
 */
export function seg(s: string): string {
  if (typeof s !== 'string' || s === '' || s === '.' || s === '..' || s.includes('/')) throw new HttpError(422, 'Ungültige Kennung', 'Kennung für Keycloak ungültig (leer, «.», «..» oder mit «/»).');
  return encodeURIComponent(s);
}

export class KeycloakAdmin {
  readonly adminUrl: string;
  private readonly cfg: { clientId: string; privateKey: string | null; clientSecret: string | null; timeoutMs: number };
  private readonly tokenEndpoint: () => Promise<string>;
  private readonly issuer: string;
  private readonly fetchImpl: Fetch;
  private token: { value: string; until: number } | null = null;
  private pending: Promise<string> | null = null;
  private key: Promise<{ alg: string; kid: string; key: CryptoKey }> | null = null;

  /** @param creds Zugang: Standard der Verwaltungs-Client (KEYCLOAK_MGMT_*), für den Abgleich im Worker KEYCLOAK_SYNC_*. */
  constructor(cfg: Pick<IamConfig, 'oidc' | 'mgmt'>, tokenEndpoint: () => Promise<string>, fetchImpl: Fetch = fetch, creds: { clientId: string | null; privateKey: string | null; clientSecret: string | null } = cfg.mgmt) {
    if (!creds.clientId) throw new ConfigError('Client-ID des Keycloak-Zugangs fehlt (KEYCLOAK_MGMT_CLIENT_ID bzw. KEYCLOAK_SYNC_CLIENT_ID)');
    this.cfg = { clientId: creds.clientId, privateKey: creds.privateKey, clientSecret: creds.clientSecret, timeoutMs: cfg.mgmt.timeoutMs };
    this.issuer = cfg.oidc.issuer;
    const m = /^(.*)\/realms\/([^/]+)$/.exec(cfg.oidc.issuer);
    const derived = m ? `${m[1]}/admin/realms/${m[2]}` : null;
    if (!cfg.mgmt.adminUrl && !derived) throw new ConfigError('KEYCLOAK_MGMT_URL fehlt (OIDC_ISSUER_URL hat nicht die Form …/realms/<realm>)');
    this.adminUrl = cfg.mgmt.adminUrl ?? derived!;
    this.tokenEndpoint = tokenEndpoint;
    this.fetchImpl = fetchImpl;
  }

  // ---------------------------------------------------------------- Anmeldung (Client Credentials)
  private async signingKey() {
    this.key ??= (async () => {
      const pem = this.cfg.privateKey!;
      const info = await keyInfo(pem);
      const key = await importPKCS8(createPrivateKey(pem).export({ format: 'pem', type: 'pkcs8' }).toString(), info.alg);
      return { alg: info.alg, kid: info.kid, key };
    })();
    return this.key;
  }

  private async fetchToken(): Promise<string> {
    const endpoint = await this.tokenEndpoint();
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (this.cfg.privateKey) {
      const k = await this.signingKey();
      // Zielgruppe: Issuer des Realms (Keycloak akzeptiert Issuer und Token-Endpunkt)
      const assertion = await new SignJWT({}).setProtectedHeader({ alg: k.alg, kid: k.kid, typ: 'JWT' })
        .setIssuer(this.cfg.clientId).setSubject(this.cfg.clientId).setAudience(this.issuer).setJti(randomUUID()).setIssuedAt().setExpirationTime('60s').sign(k.key);
      body.set('client_id', this.cfg.clientId);
      body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      body.set('client_assertion', assertion);
    } else {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret ?? '')}`).toString('base64')}`;
    }
    let r: Response;
    try { r = await this.fetchImpl(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.cfg.timeoutMs) }); }
    catch (e) { throw new KeycloakError(503, 'Anmeldung des Verwaltungs-Clients fehlgeschlagen', `Keycloak nicht erreichbar (${(e as Error).name}).`); }
    const j = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
    if (!r.ok || !j.access_token) throw new KeycloakError(503, 'Anmeldung des Verwaltungs-Clients fehlgeschlagen', `Keycloak lehnt den Verwaltungs-Client ab (${j.error ?? r.status}). Einrichtung prüfen: KEYCLOAK_MGMT_* bzw. KEYCLOAK_SYNC_* und der Client im Realm-Modul.`);
    // 30 s Reserve vor Ablauf
    this.token = { value: j.access_token, until: Date.now() + Math.max(10, (j.expires_in ?? 60) - 30) * 1000 };
    return j.access_token;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    this.pending ??= this.fetchToken().finally(() => { this.pending = null; });
    return this.pending;
  }

  /**
   * Aufruf der Admin-API. `ok`: zusätzlich erlaubte Fehlerstatus (z. B. 404 → null). Bei 401 (Token widerrufen, Schlüssel
   * gewechselt) einmal mit neuem Token wiederholt.
   */
  async call<T = unknown>(method: string, path: string, body?: unknown, o: { ok?: number[]; form?: Record<string, string>; what?: string } = {}): Promise<{ status: number; data: T; location: string | null }> {
    let payload: string | URLSearchParams | undefined;
    const type: Record<string, string> = {};
    if (o.form) { payload = new URLSearchParams(o.form); type['content-type'] = 'application/x-www-form-urlencoded'; }
    else if (body !== undefined) { payload = JSON.stringify(body); type['content-type'] = 'application/json'; }
    let r!: Response;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { authorization: `Bearer ${await this.accessToken()}`, ...type };
      try { r = await this.fetchImpl(`${this.adminUrl}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(this.cfg.timeoutMs) }); }
      catch (e) { throw new KeycloakError(503, o.what ?? 'Keycloak nicht erreichbar', `Keycloak nicht erreichbar (${(e as Error).name}).`); }
      if (r.status !== 401) break;
      this.token = null;
      if (attempt === 0) await r.body?.cancel().catch(() => undefined);
    }
    const text = await r.text();
    if (!r.ok && !(o.ok ?? []).includes(r.status)) {
      let msg: string | null = null;
      try { const j = JSON.parse(text) as { errorMessage?: string; error?: string }; msg = (j.errorMessage ?? j.error ?? '').slice(0, 500) || null; } catch { /* kein JSON */ }
      if (r.status === 403) throw new KeycloakError(403, o.what ?? 'Keycloak verweigert', 'Dem Verwaltungs-Client fehlt ein Recht in Keycloak. Einrichtung mit dem Realm-Modul abgleichen.', msg);
      throw new KeycloakError(r.status, o.what ?? `${method} ${path}`, `${o.what ?? 'Aufruf'} fehlgeschlagen (Keycloak ${r.status}).`, msg);
    }
    let data: T;
    try { data = (text ? JSON.parse(text) : undefined) as T; } catch { data = text as T; }
    return { status: r.status, data, location: r.headers.get('location') };
  }

  /** Obergrenze für seitenweise geladene Listen (Organisationen, Mitglieder, Suche). */
  static readonly MAX_ENTRIES = 10_000;
  /**
   * Alle Seiten einer Liste. Mehr als MAX_ENTRIES Einträge: Fehler statt einer abgeschnittenen Liste – der Abgleich
   * hielte sonst alle übrigen Mitglieder für entfernt.
   */
  private async page<T>(path: string, size = 100): Promise<T[]> {
    const out: T[] = [];
    for (let first = 0; ; first += size) {
      const sep = path.includes('?') ? '&' : '?';
      const chunk = (await this.call<T[]>('GET', `${path}${sep}first=${first}&max=${size}`)).data ?? [];
      out.push(...chunk);
      if (chunk.length < size) return out;
      if (out.length >= KeycloakAdmin.MAX_ENTRIES) throw new KeycloakError(502, 'Liste zu lang', `Keycloak liefert mindestens ${KeycloakAdmin.MAX_ENTRIES.toLocaleString('de-CH')} Einträge; abgebrochen, ohne etwas zu ändern.`);
    }
  }

  private static idFrom(location: string | null): string {
    const id = location?.split('/').pop();
    if (!id) throw new KeycloakError(502, 'Antwort ohne Location');
    return id;
  }

  // ---------------------------------------------------------------- Organisationen
  listOrgs() { return this.page<KcOrg>('/organizations?briefRepresentation=false'); }
  async getOrg(id: string): Promise<KcOrg | null> { return (await this.call<KcOrg>('GET', `/organizations/${seg(id)}`, undefined, { ok: [404] })).data ?? null; }
  async createOrg(rep: Omit<KcOrg, 'id'>): Promise<string> { return KeycloakAdmin.idFrom((await this.call('POST', '/organizations', rep, { what: 'Organisation anlegen' })).location); }
  async updateOrg(org: KcOrg): Promise<void> { await this.call('PUT', `/organizations/${seg(org.id)}`, org, { what: 'Organisation ändern' }); }
  async deleteOrg(id: string): Promise<void> { await this.call('DELETE', `/organizations/${seg(id)}`, undefined, { ok: [404], what: 'Organisation löschen' }); }
  members(orgId: string) { return this.page<KcUser>(`/organizations/${seg(orgId)}/members?briefRepresentation=false`); }
  async member(orgId: string, userId: string): Promise<KcUser | null> {
    const r = await this.call<KcUser>('GET', `/organizations/${seg(orgId)}/members/${seg(userId)}`, undefined, { ok: [404] });
    return r.status === 404 ? null : r.data;
  }
  async addMember(orgId: string, userId: string) { await this.call('POST', `/organizations/${seg(orgId)}/members`, userId, { what: 'Mitglied hinzufügen' }); }
  async removeMember(orgId: string, userId: string) { await this.call('DELETE', `/organizations/${seg(orgId)}/members/${seg(userId)}`, undefined, { what: 'Mitglied entfernen', ok: [404] }); }
  async memberOrgs(userId: string): Promise<KcOrg[]> { return (await this.call<KcOrg[]>('GET', `/organizations/members/${seg(userId)}/organizations?briefRepresentation=true`)).data ?? []; }
  /**
   * Einladung an ein bestehendes Konto (Keycloak sendet die E-Mail; Mitglied erst nach Annahme).
   * `sent`: versendet. `failed`: Versand gescheitert (500, meist kein SMTP im Realm). `refused`: Keycloak lehnt das
   * Konto ab, bevor es eine E-Mail versucht (400 gesperrt, ohne E-Mail, unbekannt; 409 schon Mitglied) – das sagt
   * etwas über das Konto, nicht über den Versand; das Modul `admin` antwortet dann wie für ein neues Konto.
   */
  async inviteExistingUser(orgId: string, userId: string): Promise<'sent' | 'failed' | 'refused'> {
    const r = await this.call('POST', `/organizations/${seg(orgId)}/members/invite-existing-user`, undefined, { form: { id: userId }, ok: [400, 409, 500], what: 'Einladung senden' });
    return r.status < 300 ? 'sent' : r.status === 500 ? 'failed' : 'refused';
  }
  /** E-Mail-Versand im Realm eingerichtet (SMTP-Server gesetzt)? Braucht view-realm (in manage-realm enthalten). */
  async mailConfigured(): Promise<boolean> {
    const r = await this.call<{ smtpServer?: { host?: string } }>('GET', '', undefined, { ok: [403, 404], what: 'Realm lesen' });
    return r.status < 300 && !!r.data?.smtpServer?.host;
  }

  // ---------------------------------------------------------------- Benutzer
  async findUserByEmail(email: string): Promise<KcUser | null> {
    const list = (await this.call<KcUser[]>('GET', `/users?email=${encodeURIComponent(email)}&exact=true&briefRepresentation=false`)).data ?? [];
    return list.find(u => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
  }
  /** Konten, deren Benutzername, Name oder Adresse `search` enthält (Teiltreffer, alle Seiten). */
  searchUsers(search: string) { return this.page<KcUser>(`/users?search=${encodeURIComponent(search)}&briefRepresentation=false`); }
  async getUser(id: string): Promise<KcUser | null> { const r = await this.call<KcUser>('GET', `/users/${seg(id)}`, undefined, { ok: [404] }); return r.status === 404 ? null : r.data; }
  async createUser(rep: Omit<KcUser, 'id'>): Promise<string> { return KeycloakAdmin.idFrom((await this.call('POST', '/users', rep, { what: 'Konto anlegen' })).location); }
  async deleteUser(id: string) { await this.call('DELETE', `/users/${seg(id)}`, undefined, { ok: [404], what: 'Konto löschen' }); }
  async hasPassword(id: string): Promise<boolean> {
    return ((await this.call<{ type: string }[]>('GET', `/users/${seg(id)}/credentials`)).data ?? []).some(c => c.type === 'password');
  }
  /** E-Mail mit Aktionen (z. B. «Passwort setzen»). false: Versand gescheitert (meist kein SMTP im Realm). */
  async sendActionsEmail(id: string, actions: string[], o: { lifespanSec: number; clientId?: string; redirectUri?: string }): Promise<boolean> {
    const q = new URLSearchParams({ lifespan: String(o.lifespanSec), ...(o.clientId ? { client_id: o.clientId } : {}), ...(o.redirectUri ? { redirect_uri: o.redirectUri } : {}) });
    // Versand scheitert ohne SMTP mit 500; 400 z. B. bei ungültiger Weiterleitung. Beides: Konto bleibt, E-Mail später erneut senden.
    const r = await this.call('PUT', `/users/${seg(id)}/execute-actions-email?${q}`, actions, { ok: [400, 500], what: 'Einladung senden' });
    return r.status < 300;
  }

  async updateUser(id: string, rep: Partial<KcUser>) { await this.call('PUT', `/users/${seg(id)}`, rep, { what: 'Konto ändern' }); }
  /** Realm-Rollen eines Kontos samt zusammengesetzten (z. B. platform-admin über eine Gruppe oder Rolle). */
  async realmRoles(id: string): Promise<string[]> { return ((await this.call<{ name: string }[]>('GET', `/users/${seg(id)}/role-mappings/realm/composite`)).data ?? []).map(r => r.name); }
  async credentials(id: string): Promise<KcCredential[]> { return (await this.call<KcCredential[]>('GET', `/users/${seg(id)}/credentials`)).data ?? []; }
  async deleteCredential(id: string, credentialId: string) { await this.call('DELETE', `/users/${seg(id)}/credentials/${seg(credentialId)}`, undefined, { ok: [404], what: 'Anmeldedaten entfernen' }); }
  async federatedIdentities(id: string): Promise<KcFederatedIdentity[]> { return (await this.call<KcFederatedIdentity[]>('GET', `/users/${seg(id)}/federated-identity`)).data ?? []; }
  /** Konto mit einer Identität beim Anbieter verknüpfen (`userId`: Prinzipal beim Anbieter, bei Entra die Objekt-ID). 409: schon verknüpft. */
  async addFederatedIdentity(id: string, link: KcFederatedIdentity): Promise<'linked' | 'conflict'> {
    const r = await this.call('POST', `/users/${seg(id)}/federated-identity/${seg(link.identityProvider)}`, link, { ok: [409], what: 'Konto verknüpfen' });
    return r.status === 409 ? 'conflict' : 'linked';
  }
  /** Konto, das mit dieser Identität beim Anbieter verknüpft ist (bei Entra: Objekt-ID); null = keines. */
  async userByIdentity(alias: string, idpUserId: string): Promise<KcUser | null> {
    const q = new URLSearchParams({ idpAlias: alias, idpUserId, briefRepresentation: 'false', max: '2' });
    return (await this.call<KcUser[]>('GET', `/users?${q}`)).data?.[0] ?? null;
  }
  async removeFederatedIdentity(id: string, alias: string) { await this.call('DELETE', `/users/${seg(id)}/federated-identity/${seg(alias)}`, undefined, { ok: [404], what: 'Verknüpfung lösen' }); }

  // ---------------------------------------------------------------- Identitätsanbieter (Recht manage-identity-providers)
  async getIdp(alias: string): Promise<KcIdp | null> { const r = await this.call<KcIdp>('GET', `/identity-provider/instances/${seg(alias)}`, undefined, { ok: [404] }); return r.status === 404 ? null : r.data; }
  async createIdp(rep: KcIdp) { await this.call('POST', '/identity-provider/instances', rep, { what: 'Identitätsanbieter anlegen' }); }
  async updateIdp(rep: KcIdp) { await this.call('PUT', `/identity-provider/instances/${seg(rep.alias)}`, rep, { what: 'Identitätsanbieter ändern' }); }
  /** Löscht den Anbieter samt aller Verknüpfungen von Konten (Keycloak entfernt sie mit). */
  async deleteIdp(alias: string) { await this.call('DELETE', `/identity-provider/instances/${seg(alias)}`, undefined, { ok: [404], what: 'Identitätsanbieter löschen' }); }
  /** Anbieter mit der Organisation verbinden; ohne automatische Mitgliedschaft (sonst kehrte eine entfernte Person mit der nächsten Anmeldung zurück). */
  async linkOrgIdp(orgId: string, alias: string) {
    const base = `/organizations/${seg(orgId)}/identity-providers`;
    await this.call('POST', base, alias, { ok: [409], what: 'Anbieter mit Organisation verbinden' });
    await this.call('PUT', `${base}/${seg(alias)}`, { autoMembership: false, membershipType: 'UNMANAGED' }, { what: 'Anbieter mit Organisation verbinden' });
  }
  async unlinkOrgIdp(orgId: string, alias: string) { await this.call('DELETE', `/organizations/${seg(orgId)}/identity-providers/${seg(alias)}`, undefined, { ok: [400, 404], what: 'Anbieter von Organisation lösen' }); }

  // ---------------------------------------------------------------- Gruppen
  async idpMappers(alias: string): Promise<KcIdpMapper[]> { return (await this.call<KcIdpMapper[]>('GET', `/identity-provider/instances/${seg(alias)}/mappers`)).data ?? []; }
  async createIdpMapper(alias: string, rep: KcIdpMapper) { await this.call('POST', `/identity-provider/instances/${seg(alias)}/mappers`, rep, { what: 'Mapper des Anbieters anlegen' }); }
  async updateIdpMapper(alias: string, rep: KcIdpMapper & { id: string }) { await this.call('PUT', `/identity-provider/instances/${seg(alias)}/mappers/${seg(rep.id)}`, rep, { what: 'Mapper des Anbieters ändern' }); }
}
