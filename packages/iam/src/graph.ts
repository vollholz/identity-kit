/**
 * Zugang zu Microsoft Entra ID und Microsoft Graph für die Anmeldung je Organisation (Spezifikation Kap. 9.4).
 *
 * Eine mandantenfähige App der Plattform (ENTRA_CLIENT_ID) meldet sich je Kunden-Tenant mit Client Credentials an
 * (`/{tid}/oauth2/v2.0/token`, Scope `https://graph.microsoft.com/.default`). Das klappt erst, wenn eine Administration
 * des Tenants der App zugestimmt hat (Zustimmung mit Anmeldung, `consentUrl` und `verifyConsent`). Gelesen wird nur: die Organisation mit ihren
 * verifizierten Domänen (`Organization.Read.All`) und Personen (`User.Read.All`, für die Verknüpfung bestehender Konten und das
 * Hinzufügen aus Entra ID).
 *
 * Eigene App der Organisation (`own`, Kit 0.3): gleicher Ablauf mit Anwendungs-ID und Geheimnis einer App im Tenant der
 * Organisation. Fehler nennen dann die Eingaben der Organisation (`reason`: `wrong-tenant`, `invalid-secret`,
 * `secret-expired`, `invalid-client`, `missing-permissions`, `app-not-registered-in-tenant`) statt ENTRA_CLIENT_SECRET;
 * `checkApp` prüft die erteilten Anwendungsberechtigungen, dass die App im Tenant registriert ist, und liest den Ablauf
 * des Geheimnisses.
 *
 * Wie keycloak.ts kennt diese Klasse keine Mandantengrenze; welcher Tenant zu welcher Organisation gehört, entscheidet
 * entra.ts. Adressen von Microsoft sind fest (kein SSRF über Eingaben); die Tenant-ID wird vor jeder Verwendung geprüft.
 */
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { HttpError } from './errors.ts';

export const ENTRA_LOGIN = 'https://login.microsoftonline.com';
/** Scopes der Zustimmung: Anmeldung (ID-Token) und die Anwendungsberechtigungen der App in Graph. */
const CONSENT_SCOPE = 'openid profile https://graph.microsoft.com/.default';
/** Rollen (`wids`), die einer App Anwendungsberechtigungen in Graph erteilen dürfen: Global bzw. Privileged Role Administrator. */
export const CONSENT_ADMIN_ROLES = ['62e90394-69f5-4237-9190-012177145e10', 'e8611ab8-c189-46e8-94e1-60213ab1f814'];

/** Wer im Tenant zugestimmt hat (aus dem geprüften ID-Token; fürs Audit). */
export interface ConsentApprover { oid: string; name: string | null; username: string | null }
export const GRAPH = 'https://graph.microsoft.com/v1.0';

/** GUID eines Tenants bzw. Objekts in Entra ID. */
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Eingabe der Organisation: Tenant-ID oder Domäne des Tenants (z. B. contoso.onmicrosoft.com). */
const TENANT_INPUT_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/;

/** Person in Entra ID (Auswahl der Felder, `$select`). */
export interface EntraUser {
  /** Objekt-ID (`oid` im Token) – Schlüssel der Verknüpfung in Keycloak, nie die Adresse. */
  id: string;
  userPrincipalName: string;
  mail: string | null;
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  /** `Member` oder `Guest`. */
  userType: string | null;
  accountEnabled: boolean | null;
  /** Nur zur Anzeige in der Personensuche (Hinzufügen aus Entra ID). */
  department?: string | null;
  jobTitle?: string | null;
}
export const USER_FIELDS = 'id,userPrincipalName,mail,displayName,givenName,surname,userType,accountEnabled,department,jobTitle';
/** Personensuche: Mindestlänge und höchstens so viele Treffer (Hinzufügen aus Entra ID). */
export const SEARCH_MIN = 2;
export const SEARCH_TOP = 20;

export interface EntraOrganization { id: string; displayName: string; verifiedDomains: string[] }

const domainOf = (address: string | null | undefined) => {
  const at = address?.lastIndexOf('@') ?? -1;
  return at > 0 ? address!.slice(at + 1).toLowerCase() : null;
};

/**
 * Darf diese Person mit einem Konto der Plattform verknüpft werden (Spezifikation Kap. 9.4)? `null` = ja, sonst der Grund.
 * Nur Mitglieder des Tenants (keine Gäste: `userType` Guest oder `#EXT#` im UPN), aktiv, und die Adresse des Kontos
 * liegt in einer verifizierten, der Organisation zugeordneten Domäne – geprüft an UPN bzw. `mail` aus Graph, die nur die
 * Administration des Tenants setzt. `email`: Adresse des Kontos in Keycloak, muss zu UPN oder `mail` passen.
 */
export function notLinkable(u: EntraUser, domains: readonly string[], email?: string | null): string | null {
  if (u.userType !== 'Member' || u.userPrincipalName.includes('#EXT#')) return 'Gastkonto in Entra ID';
  if (u.accountEnabled === false) return 'In Entra ID deaktiviert';
  const own = [u.userPrincipalName, u.mail].filter((a): a is string => !!a).map(a => a.toLowerCase());
  if (!own.some(a => domains.includes(domainOf(a) ?? ''))) return 'Adresse in Entra ID nicht in einer Domäne der Organisation';
  if (email && !own.includes(email.toLowerCase())) return 'Adresse in Entra ID passt nicht zum Konto';
  return null;
}

/** Fehler bei Microsoft → verständlicher Fehler der Plattform (Code von Entra, ohne Interna der Antwort; `reason` für die Oberfläche). */
export class EntraError extends HttpError {
  readonly code: string;
  constructor(status: number, title: string, detail: string, code = '', reason?: string) { super(status, title, detail, {}, reason ? { reason } : {}); this.code = code; }
}

type Fetch = typeof fetch;

/** Berechtigung einer eigenen App in Microsoft Graph, mit Grund (Anleitung für die Kunden-IT). */
export interface AppPermission { name: string; type: 'Application' | 'Delegated'; why: string; optional: boolean }
/** Berechtigungen, die eine eigene App braucht; Anwendungsberechtigungen mit Administratorzustimmung im Tenant. */
export const OWN_APP_PERMISSIONS: readonly AppPermission[] = [
  { name: 'User.Read', type: 'Delegated', why: 'Anmeldung der Personen über Microsoft', optional: false },
  { name: 'Organization.Read.All', type: 'Application', why: 'Name und verifizierte Domänen des Verzeichnisses lesen', optional: false },
  { name: 'User.Read.All', type: 'Application', why: 'Personen suchen und ihre Konten verknüpfen', optional: false },
  { name: 'Application.Read.All', type: 'Application', why: 'Nachweis, dass die App in diesem Verzeichnis registriert ist, und Ablauf des geheimen Clientschlüssels (Erinnerung vor dem Ablauf)', optional: false },
  { name: 'GroupMember.Read.All', type: 'Application', why: 'Gruppen suchen und ihre Namen anzeigen (Gruppen als Wer einer Freigabe)', optional: false },
];
/** Anwendungsberechtigung für Gruppen (A25). */
export const GROUPS_PERMISSION = 'GroupMember.Read.All';
/** Höchstzahl Treffer der Gruppensuche. */
export const GROUP_SEARCH_TOP = 50;
export interface EntraGroup { id: string; displayName: string | null }
const REQUIRED_ROLES = OWN_APP_PERMISSIONS.filter(p => p.type === 'Application' && !p.optional).map(p => p.name);
/** Statt Application.Read.All genügt auch die weitergehende Berechtigung. */
const ROLE_ALTERNATIVES: Record<string, string[]> = { 'Application.Read.All': ['Application.ReadWrite.All'] };

/** Zugang einer App. `own`: App der Organisation in ihrem eigenen Tenant (nicht die der Plattform). */
export interface EntraAppConfig { clientId: string; clientSecret: string; timeoutMs: number; own?: boolean }

/** Ergebnis von `checkApp`: Organisation, erteilte Rollen und Ablauf des Geheimnisses (null: kein passender Schlüssel gefunden). */
export interface AppCheck { organization: EntraOrganization; roles: string[]; secretExpiresAt: Date | null }

/** Rollen (`roles`) aus einem Zugriffstoken von Microsoft lesen, ohne Prüfung der Signatur (Token kommt direkt von Microsoft). */
function tokenRoles(token: string): string[] | null {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { roles?: unknown };
    return Array.isArray(p.roles) ? p.roles.map(String) : [];
  } catch { return null; }
}

export class EntraGraph {
  private readonly cfg: EntraAppConfig;
  private readonly fetchImpl: Fetch;
  private readonly tokens = new Map<string, { value: string; until: number }>();

  constructor(cfg: EntraAppConfig, fetchImpl: Fetch = fetch) {
    this.cfg = cfg; this.fetchImpl = fetchImpl;
  }

  get clientId() { return this.cfg.clientId; }

  private async request(url: string, init: RequestInit, what: string): Promise<{ status: number; data: any }> {
    let r: Response;
    try { r = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.cfg.timeoutMs) }); }
    catch (e) { throw new EntraError(503, 'Microsoft nicht erreichbar', `${what}: Microsoft nicht erreichbar (${(e as Error).name}).`); }
    const text = await r.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
    return { status: r.status, data };
  }

  /** Tenant-ID zu einer Eingabe (Tenant-ID oder Domäne) über die OpenID-Konfiguration; null = gibt es nicht. */
  async resolveTenant(input: string): Promise<string | null> {
    const v = input.trim().toLowerCase();
    if (!TENANT_INPUT_RE.test(v) || ['common', 'organizations', 'consumers'].includes(v)) return null;
    const r = await this.request(`${ENTRA_LOGIN}/${encodeURIComponent(v)}/v2.0/.well-known/openid-configuration`, { method: 'GET' }, 'Tenant suchen');
    if (r.status === 400 || r.status === 404) return null;
    if (r.status >= 300) throw new EntraError(502, 'Microsoft nicht verfügbar', `Tenant suchen: Microsoft antwortet mit ${r.status}.`);
    const m = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/.exec(String(r.data?.issuer ?? ''));
    // 9188040d-…: Tenant der privaten Microsoft-Konten, keine Organisation
    return m && GUID_RE.test(m[1]!) && m[1] !== '9188040d-6c67-4c5b-b112-36a304b66dad' ? m[1]! : null;
  }

  /**
   * Adresse der Zustimmung im Tenant (Navigation im Browser): Anmeldung mit Code-Flow, PKCE und `nonce`.
   * `prompt=admin_consent`: Zustimmung für den ganzen Tenant (Anwendungsberechtigungen über `.default` verlangen ohnehin
   * Global bzw. Privileged Role Administrator); `openid profile` darf neben `<resource>/.default` stehen, weitere statische
   * Scopes nicht. Anders als `…/adminconsent` liefert die Rückkehr einen Code, dessen ID-Token belegt, wer im Tenant
   * zugestimmt hat (`verifyConsent`).
   */
  consentUrl(tenantId: string, o: { state: string; redirectUri: string; nonce: string; codeChallenge: string }): string {
    if (!GUID_RE.test(tenantId)) throw new Error('Tenant-ID ungültig');
    const q = new URLSearchParams({
      client_id: this.cfg.clientId, response_type: 'code', response_mode: 'query', redirect_uri: o.redirectUri, scope: CONSENT_SCOPE,
      state: o.state, nonce: o.nonce, code_challenge: o.codeChallenge, code_challenge_method: 'S256', prompt: 'admin_consent',
    });
    return `${ENTRA_LOGIN}/${tenantId}/oauth2/v2.0/authorize?${q}`;
  }

  /**
   * Code der Zustimmung einlösen und das ID-Token prüfen: Signatur mit den Schlüsseln des Tenants, Aussteller und `tid` =
   * gestarteter Tenant, Zielgruppe = Entra-App, `nonce`; die Person ist Mitglied des Tenants (kein Gast) und hat die Rolle
   * «Global Administrator» oder «Privileged Role Administrator» (`wids`). Sonst 409 `consent-unproven`.
   */
  async verifyConsent(tenantId: string, o: { code: string; redirectUri: string; codeVerifier: string; nonce: string }): Promise<ConsentApprover> {
    if (!GUID_RE.test(tenantId)) throw new Error('Tenant-ID ungültig');
    const unproven = (why: string) => new HttpError(409, 'Zustimmung nicht nachgewiesen', `${why} Bitte neu verbinden; zustimmen muss eine globale Administration oder «Privileged Role Administrator» des Tenants.`, {}, { reason: 'consent-unproven' });
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code: o.code, redirect_uri: o.redirectUri, code_verifier: o.codeVerifier, scope: CONSENT_SCOPE });
    const r = await this.request(`${ENTRA_LOGIN}/${tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, 'Zustimmung einlösen');
    if (r.status >= 300 || typeof r.data?.id_token !== 'string') {
      const code = /AADSTS\d+/.exec(String(r.data?.error_description ?? ''))?.[0] ?? String(r.data?.error ?? r.status);
      throw unproven(`Microsoft löst den Code nicht ein (${code}).`);
    }
    const keys = await this.request(`${ENTRA_LOGIN}/${tenantId}/discovery/v2.0/keys`, { method: 'GET' }, 'Schlüssel des Tenants');
    if (keys.status >= 300 || !Array.isArray(keys.data?.keys)) throw new EntraError(502, 'Microsoft nicht verfügbar', `Schlüssel des Tenants: Microsoft antwortet mit ${keys.status}.`);
    let c: JWTPayload;
    try {
      c = (await jwtVerify(r.data.id_token, createLocalJWKSet(keys.data as JSONWebKeySet), { issuer: `${ENTRA_LOGIN}/${tenantId}/v2.0`, audience: this.cfg.clientId, algorithms: ['RS256'] })).payload;
    } catch (e) { throw unproven(`ID-Token ungültig (${(e as Error).name}).`); }
    if (c.tid !== tenantId) throw unproven('ID-Token aus einem anderen Tenant.');
    if (c.nonce !== o.nonce) throw unproven('ID-Token gehört nicht zu dieser Zustimmung.');
    // Gast: `acct` 1 bzw. Anmeldung über einen anderen Aussteller (`idp`)
    if (c.acct === 1 || (typeof c.idp === 'string' && c.idp !== c.iss)) throw unproven('Zugestimmt hat ein Gast des Tenants.');
    // `wids` gibt Microsoft nur aus, wenn die App-Registrierung Verzeichnisrollen im Gruppen-Claim ausgibt
    // (groupMembershipClaims mit «DirectoryRole»); fehlt der Claim, gilt die Zustimmung nicht (nie «kein Claim = Admin»)
    if (!Array.isArray(c.wids)) throw unproven('wids fehlt: DirectoryRole-Claim in der App-Registrierung aktivieren (Token configuration › groups claim › Directory roles).');
    const wids = c.wids.map(String);
    if (!CONSENT_ADMIN_ROLES.some(w => wids.includes(w))) throw unproven('Die zustimmende Person hat im Tenant weder «Global Administrator» noch «Privileged Role Administrator».');
    if (typeof c.oid !== 'string') throw unproven('ID-Token ohne Objekt-ID.');
    return { oid: c.oid, name: typeof c.name === 'string' ? c.name.slice(0, 256) : null, username: typeof c.preferred_username === 'string' ? c.preferred_username.slice(0, 256) : null };
  }

  /** Token für Graph im Tenant (Client Credentials). `fresh`: nicht aus dem Zwischenspeicher (nach der Zustimmung). */
  private async token(tenantId: string, fresh = false): Promise<string> {
    if (!GUID_RE.test(tenantId)) throw new Error('Tenant-ID ungültig');
    const hit = this.tokens.get(tenantId);
    if (!fresh && hit && Date.now() < hit.until) return hit.value;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scope: 'https://graph.microsoft.com/.default' });
    const r = await this.request(`${ENTRA_LOGIN}/${tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, 'Anmeldung bei Microsoft');
    if (r.status >= 300 || !r.data?.access_token) {
      // AADSTS-Code ohne Beschreibung (die kann Interna enthalten); 7000215/7000222: Geheimnis falsch bzw. abgelaufen
      const code = /AADSTS\d+/.exec(String(r.data?.error_description ?? ''))?.[0] ?? String(r.data?.error ?? r.status);
      const secret = /AADSTS7000(215|222)/.test(code);
      if (this.cfg.own) {
        // Eigene App: Eingaben der Organisation – sagen, welche nicht stimmt (700016: keine App mit dieser ID im Tenant)
        if (/AADSTS7000222/.test(code)) throw new EntraError(409, 'Geheimnis abgelaufen', `Das Geheimnis der App ist abgelaufen (${code}). In der App einen neuen geheimen Clientschlüssel anlegen und eintragen.`, code, 'secret-expired');
        if (secret) throw new EntraError(409, 'Geheimnis abgelehnt', `Microsoft lehnt das Geheimnis der App ab (${code}). Den Wert (nicht die ID) des geheimen Clientschlüssels angeben.`, code, 'invalid-secret');
        if (/AADSTS700016/.test(code)) throw new EntraError(409, 'App nicht im Tenant', `Im Tenant gibt es keine App mit dieser Anwendungs-ID (${code}). Stimmen Tenant und Anwendungs-ID?`, code, 'wrong-tenant');
        throw new EntraError(409, 'App nicht nutzbar', `Microsoft stellt der App kein Token aus (${code}). Stimmen Tenant, Anwendungs-ID und Geheimnis?`, code, 'invalid-client');
      }
      throw new EntraError(secret ? 503 : 409, secret ? 'Entra-App falsch eingerichtet' : 'Keine Zustimmung im Tenant',
        secret ? `Microsoft lehnt das Geheimnis der App ab (${code}). ENTRA_CLIENT_SECRET prüfen.` : `Microsoft stellt kein Token für den Tenant aus (${code}). Hat eine Administration des Tenants der App zugestimmt?`, code);
    }
    this.tokens.set(tenantId, { value: r.data.access_token, until: Date.now() + Math.max(60, Number(r.data.expires_in ?? 600) - 120) * 1000 });
    return r.data.access_token;
  }

  /** GET in Graph. 404 → null. `fresh`: neues Token (Rechte direkt nach der Zustimmung). */
  async get<T>(tenantId: string, path: string, o: { fresh?: boolean; what?: string; headers?: Record<string, string> } = {}): Promise<T | null> {
    const what = o.what ?? 'Graph';
    const r = await this.request(`${GRAPH}${path}`, { method: 'GET', headers: { authorization: `Bearer ${await this.token(tenantId, o.fresh)}`, ...o.headers } }, what);
    if (r.status === 404) return null;
    if (r.status === 401) this.tokens.delete(tenantId);
    if (r.status >= 300) {
      const code = String(r.data?.error?.code ?? r.status);
      throw new EntraError(r.status === 403 || r.status === 401 ? 409 : 502, r.status === 403 ? 'Recht in Entra ID fehlt' : 'Microsoft Graph nicht verfügbar',
        `${what}: Microsoft Graph antwortet mit ${r.status} (${code})${r.status !== 403 ? '' : this.cfg.own
          ? `. Fehlen der App die Anwendungsberechtigungen ${REQUIRED_ROLES.join(' und ')} (Microsoft Graph) mit Administratorzustimmung?`
          : '. Fehlt die Admin-Zustimmung für eine Berechtigung der App?'}.`, code, r.status === 403 && this.cfg.own ? 'missing-permissions' : undefined);
    }
    return r.data as T;
  }

  /**
   * Eigene App prüfen (vor dem Speichern): frisches Token im Tenant, erteilte Anwendungsberechtigungen aus dem Token
   * (`roles`; fehlt eine aus OWN_APP_PERMISSIONS: 409 `missing-permissions` mit `missing`; Token nicht lesbar: 409
   * `invalid-client`), Organisation lesen. Ein Token belegt nur, dass der Tenant der App zugestimmt hat – auch einer
   * mandantenfähigen App eines Herstellers. Darum muss die Registrierung im Tenant selbst liegen: `GET
   * /applications(appId=…)` gibt sie nur im Heimat-Tenant der App (sonst 409 `app-not-registered-in-tenant`). Daraus
   * auch der Ablauf des Geheimnisses (passwordCredentials, über `hint` = die ersten drei Zeichen; mehrere passende: das
   * früheste Ende; keiner: null).
   */
  async checkApp(tenantId: string): Promise<AppCheck> {
    const roles = tokenRoles(await this.token(tenantId, true));
    if (!roles) throw new EntraError(409, 'App nicht nutzbar', 'Das Token der App lässt sich nicht lesen (keine Anwendungsberechtigungen erkennbar). Stimmen Tenant, Anwendungs-ID und Geheimnis?', '', 'invalid-client');
    const missing = REQUIRED_ROLES.filter(r => !roles.includes(r) && !(ROLE_ALTERNATIVES[r] ?? []).some(a => roles.includes(a)));
    if (missing.length) {
      const e = new EntraError(409, 'Berechtigung fehlt', `Der App fehlen Anwendungsberechtigungen in Microsoft Graph: ${missing.join(', ')}. Hinzufügen und für den Tenant die Administratorzustimmung erteilen (eingetragen ohne Zustimmung zählt nicht).`, '', 'missing-permissions');
      e.extra.missing = missing;
      throw e;
    }
    if (!GUID_RE.test(this.cfg.clientId)) throw new EntraError(409, 'App nicht nutzbar', 'Anwendungs-ID ungültig.', '', 'invalid-client');
    const app = await this.get<{ passwordCredentials?: { hint?: string | null; endDateTime?: string | null }[] }>(tenantId,
      `/applications(appId='${this.cfg.clientId}')?$select=passwordCredentials`, { what: 'App lesen' });
    if (!app) throw new EntraError(409, 'App nicht in diesem Verzeichnis registriert', 'Die App ist in diesem Tenant nicht registriert (zum Beispiel die App eines Herstellers, der der Tenant nur zugestimmt hat). Eine eigene App-Registrierung in diesem Tenant anlegen.', '', 'app-not-registered-in-tenant');
    const organization = await this.organization(tenantId);
    const ends = (app.passwordCredentials ?? []).filter(p => p.hint && this.cfg.clientSecret.startsWith(p.hint) && p.endDateTime)
      .map(p => new Date(p.endDateTime!)).filter(d => !Number.isNaN(d.getTime())).sort((a, b) => a.getTime() - b.getTime());
    return { organization, roles, secretExpiresAt: ends[0] ?? null };
  }

  /** Organisation des Tenants mit ihren verifizierten Domänen (klein geschrieben). */
  async organization(tenantId: string, fresh = false): Promise<EntraOrganization> {
    const r = await this.get<{ value?: { id: string; displayName?: string; verifiedDomains?: { name: string }[] }[] }>(tenantId, '/organization?$select=id,displayName,verifiedDomains', { fresh, what: 'Organisation lesen' });
    const o = r?.value?.[0];
    if (!o || o.id !== tenantId) throw new EntraError(502, 'Microsoft Graph nicht verfügbar', 'Organisation lesen: Antwort passt nicht zum Tenant.');
    return { id: o.id, displayName: o.displayName ?? '', verifiedDomains: [...new Set((o.verifiedDomains ?? []).map(d => d.name.toLowerCase()))].sort() };
  }

  /** Personen mit genau dieser Adresse (UPN oder `mail`), höchstens 5. */
  async usersByAddress(tenantId: string, address: string): Promise<EntraUser[]> {
    const a = address.trim().toLowerCase().replace(/'/g, "''");
    const filter = encodeURIComponent(`userPrincipalName eq '${a}' or mail eq '${a}'`);
    const r = await this.get<{ value?: EntraUser[] }>(tenantId, `/users?$filter=${filter}&$select=${USER_FIELDS}&$top=5`, { what: 'Person suchen' });
    return r?.value ?? [];
  }

  /**
   * Personen suchen (Hinzufügen aus Entra ID): `$search` über Name, `mail` und UPN (Präfix je Wort, wie Entra sucht), höchstens
   * SEARCH_TOP Treffer. Braucht `ConsistencyLevel: eventual` (erweiterte Abfrage im Verzeichnis). Anführungszeichen und
   * Backslash werden entfernt (sonst endete der Suchausdruck); `more`: Graph hätte weitere Treffer.
   */
  async searchUsers(tenantId: string, query: string): Promise<{ users: EntraUser[]; more: boolean }> {
    const q = query.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (q.length < SEARCH_MIN) return { users: [], more: false };
    const search = ['displayName', 'mail', 'userPrincipalName'].map(f => `"${f}:${q}"`).join(' OR ');
    const r = await this.get<{ value?: EntraUser[]; '@odata.nextLink'?: string }>(tenantId,
      `/users?$search=${encodeURIComponent(search)}&$select=${USER_FIELDS}&$top=${SEARCH_TOP}&$count=true`, { what: 'Personen suchen', headers: { ConsistencyLevel: 'eventual' } });
    return { users: r?.value ?? [], more: !!r?.['@odata.nextLink'] };
  }

  /** Fehlt GroupMember.Read.All: 409 `entra-consent-missing` mit Hinweis (A25). */
  private groupsMissing(e: unknown): never {
    if (e instanceof EntraError && e.status === 409) {
      throw new EntraError(409, 'Recht in Entra ID fehlt', `Für Gruppen braucht die App die Anwendungsberechtigung ${GROUPS_PERMISSION} (Microsoft Graph) mit Administratorzustimmung.`, e.code, 'entra-consent-missing');
    }
    throw e;
  }

  /** Gruppen suchen (Anzeigename, Präfix je Wort), höchstens GROUP_SEARCH_TOP; `ConsistencyLevel: eventual`. */
  async searchGroups(tenantId: string, query: string): Promise<EntraGroup[]> {
    const q = query.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (q.length < SEARCH_MIN) return [];
    const r = await this.get<{ value?: EntraGroup[] }>(tenantId, `/groups?$search=${encodeURIComponent(`"displayName:${q}"`)}&$select=id,displayName&$top=${GROUP_SEARCH_TOP}&$orderby=displayName`,
      { what: 'Gruppen suchen', headers: { ConsistencyLevel: 'eventual' } }).catch(e => this.groupsMissing(e));
    return (r?.value ?? []).map(g => ({ id: g.id.toLowerCase(), displayName: g.displayName ?? null }));
  }

  /** Gruppe nach Objekt-ID; null = gibt es nicht (mehr). */
  async group(tenantId: string, id: string): Promise<EntraGroup | null> {
    if (!GUID_RE.test(id)) return null;
    const g = await this.get<EntraGroup>(tenantId, `/groups/${id}?$select=id,displayName`, { what: 'Gruppe lesen' }).catch(e => this.groupsMissing(e));
    return g ? { id: g.id.toLowerCase(), displayName: g.displayName ?? null } : null;
  }

  /** Person nach Objekt-ID; null = gibt es nicht (mehr). */
  async user(tenantId: string, id: string): Promise<EntraUser | null> {
    if (!GUID_RE.test(id)) return null;
    return this.get<EntraUser>(tenantId, `/users/${id}?$select=${USER_FIELDS}`, { what: 'Person lesen' });
  }
}
