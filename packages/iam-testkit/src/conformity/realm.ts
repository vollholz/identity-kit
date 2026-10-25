/**
 * Konformität auf Ebene Realm (gegen die laufende Keycloak-Instanz, nur lesend über die Admin-API): Einstellungen der
 * Zone «Fest» wie im Modul product-realm, nur Clients des Moduls, vertrauliche Clients mit `private_key_jwt`, keine
 * Rollen ausser `platform-admin`, Identity Provider nur als eigene Entra-App einer Organisation, Ereignisse an.
 * Erkennt Änderungen von Hand, auch wenn kein OpenTofu-Plan läuft. Ohne Manifest (zentral beim Betreiber) gelten die
 * Maschinen-Clients des Moduls über ihr Attribut `<produkt>.m2m`.
 */
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { BUILTIN_CLIENTS, type Manifest } from './manifest.ts';
import { finding, type Finding } from './report.ts';
import { PLATFORM_ADMIN_ROLE } from '../model.ts';

export interface AdminLogin {
  /** Basisadresse der Instanz mit Basispfad, z. B. https://id.example.ch. */
  baseUrl: string;
  /** Realm der Anmeldung: der Realm der App (IaC-Client) oder `master` (Betreiber). */
  loginRealm: string;
  clientId: string;
  /** PEM (EC P-256) für `private_key_jwt`. */
  privateKey: string;
}

/** Nur lesender Zugriff auf die Admin-API (GET). */
export interface AdminReader { get<T>(path: string): Promise<T> }

/** Anmeldung mit `private_key_jwt` (ES256) und GET-Aufrufe auf `/admin/realms/…`. */
export function adminReader(l: AdminLogin, fetchImpl: typeof fetch = fetch): AdminReader {
  const base = l.baseUrl.replace(/\/$/, '');
  let token: Promise<string> | undefined;
  const login = async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const aud = `${base}/realms/${l.loginRealm}`;
    const input = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({ iss: l.clientId, sub: l.clientId, aud, jti: randomUUID(), iat: now, exp: now + 60 })}`;
    const sig = sign('sha256', Buffer.from(input), { key: createPrivateKey(l.privateKey), dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const r = await fetchImpl(`${aud}/protocol/openid-connect/token`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: l.clientId, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: `${input}.${sig}` }),
    });
    if (!r.ok) throw new Error(`Anmeldung als ${l.clientId} im Realm ${l.loginRealm} fehlgeschlagen: HTTP ${r.status}`);
    return ((await r.json()) as { access_token: string }).access_token;
  };
  return {
    async get<T>(path: string): Promise<T> {
      token ??= login();
      const r = await fetchImpl(`${base}/admin${path}`, { headers: { authorization: `Bearer ${await token}` }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
      return await r.json() as T;
    },
  };
}

/** Einstellungen der Zone «Fest» (product-realm, realm.tf): Feld der Admin-API → erwarteter Wert. */
export const FIXED_REALM_SETTINGS: Record<string, unknown> = {
  enabled: true,
  organizationsEnabled: true,
  sslRequired: 'external',
  registrationAllowed: false,
  duplicateEmailsAllowed: false,
  accessTokenLifespan: 300,
  ssoSessionIdleTimeout: 3600,
  ssoSessionMaxLifespan: 36000,
  offlineSessionMaxLifespanEnabled: true,
  offlineSessionMaxLifespan: 7776000,
  revokeRefreshToken: true,
  refreshTokenMaxReuse: 0,
  adminPermissionsEnabled: true,
  bruteForceProtected: true,
  permanentLockout: false,
  failureFactor: 10,
};

/** Rollen, die Keycloak in jedem Realm anlegt, dazu `platform-admin` des Moduls. */
const allowedRoles = (realm: string) => [PLATFORM_ADMIN_ROLE, 'offline_access', 'uma_authorization', `default-roles-${realm}`];

interface ClientRep {
  id: string; clientId: string; publicClient?: boolean; bearerOnly?: boolean; clientAuthenticatorType?: string;
  directAccessGrantsEnabled?: boolean; implicitFlowEnabled?: boolean; serviceAccountsEnabled?: boolean; attributes?: Record<string, string>;
}

export interface RealmOptions {
  product: string;
  realm?: string;
  /** Mit Manifest: Maschinen-Clients und Schalter genau prüfen. */
  manifest?: Manifest | null;
}

export async function realmChecks(kc: AdminReader, o: RealmOptions): Promise<Finding[]> {
  const realm = o.realm ?? o.product;
  const R = `/realms/${encodeURIComponent(realm)}`;
  const kit = { level: 'realm', zone: 'fest' } as const;
  const out: Finding[] = [];

  // Einstellungen
  const rep = await kc.get<Record<string, unknown>>(R);
  const settings: string[] = [];
  for (const [k, want] of Object.entries(FIXED_REALM_SETTINGS)) if (rep[k] !== want) settings.push(`${k} = ${JSON.stringify(rep[k])} statt ${JSON.stringify(want)}`);
  const policy = String(rep.passwordPolicy ?? '');
  const len = Number(/length\((\d+)\)/.exec(policy)?.[1] ?? 0);
  if (len < 12 || !policy.includes('notUsername') || !policy.includes('notEmail')) settings.push(`passwordPolicy «${policy}» schwächer als length(12) and notUsername and notEmail`);
  out.push(finding({ ...kit, check: 'Realm-Einstellungen wie im Modul', source: 'identity-kit · product-realm (realm.tf)' }, settings));

  // Ereignisse
  const ev = await kc.get<{ eventsEnabled?: boolean; adminEventsEnabled?: boolean }>(`${R}/events/config`).catch(() => null);
  out.push(ev ? finding({ ...kit, check: 'Anmelde- und Admin-Ereignisse an', source: 'identity-kit · product-realm (realm.tf)' }, [
    ...(ev.eventsEnabled ? [] : ['eventsEnabled = false']), ...(ev.adminEventsEnabled ? [] : ['adminEventsEnabled = false']),
  ]) : { ...kit, check: 'Anmelde- und Admin-Ereignisse an', source: 'identity-kit · product-realm (realm.tf)', status: 'skip', details: ['Ereignis-Konfiguration nicht lesbar (Rolle view-events)'] });

  // Clients
  const clients = await kc.get<ClientRep[]>(`${R}/clients?max=1000`);
  const p = o.product;
  const r = o.manifest?.realm;
  const own = ['platform', 'api', 'admin', 'sync', 'iac'].map(s => `${p}-${s}`);
  if (r ? r.mcp : true) own.push(`${p}-mcp`, `${p}-mcp-cli`);
  const declared = r ? Object.keys(r.machineClients ?? {}) : null;
  const unexpected: string[] = [], auth: string[] = [];
  for (const c of clients) {
    if (BUILTIN_CLIENTS.includes(c.clientId)) continue;
    const m2m = c.attributes?.[`${p}.m2m`] === 'true';
    const known = own.includes(c.clientId) || (declared ? declared.includes(c.clientId) : m2m);
    if (!known) unexpected.push(`${c.clientId}: nicht aus dem Modul (Clients nur als Code; Maschinen-Clients unter realm.machineClients)`);
    if (declared?.includes(c.clientId) && !m2m) unexpected.push(`${c.clientId}: im Manifest, aber ohne Attribut ${p}.m2m (nicht vom Modul angelegt?)`);
    if (c.directAccessGrantsEnabled) auth.push(`${c.clientId}: Direct Access Grants (Passwort-Anmeldung) an`);
    if (c.implicitFlowEnabled) auth.push(`${c.clientId}: Implicit Flow an`);
    if (!c.publicClient && !c.bearerOnly && c.clientAuthenticatorType !== 'client-jwt') auth.push(`${c.clientId}: Anmeldung «${c.clientAuthenticatorType}» statt private_key_jwt (client-jwt)`);
  }
  for (const c of declared ?? []) if (!clients.some(x => x.clientId === c)) unexpected.push(`${c}: im Manifest, fehlt im Realm (Workflow «Keycloak» ausführen)`);
  for (const c of own.filter(c => !c.endsWith('-mcp') && !c.endsWith('-mcp-cli'))) if (!clients.some(x => x.clientId === c)) unexpected.push(`${c} fehlt`);
  out.push(finding({ ...kit, check: 'Nur Clients aus dem Modul', source: 'identity-kit · product-realm; Maschinen-Clients: identity.app.json › realm.machineClients' }, unexpected));
  out.push(finding({ ...kit, check: 'Keine Client-Geheimnisse, keine Passwort-Anmeldung', source: 'identity-kit · Spezifikation 1 (Grundsatz 6)' }, auth));

  // Rollen
  const roles = (await kc.get<{ name: string }[]>(`${R}/roles?max=1000`)).map(x => x.name);
  const roleProblems = roles.filter(x => !allowedRoles(realm).includes(x)).map(x => `Realm-Rolle ${x}: Rollen liegen nur in der Datenbank der App`);
  for (const c of clients.filter(c => c.clientId.startsWith(`${p}-`))) {
    const cr = await kc.get<{ name: string }[]>(`${R}/clients/${encodeURIComponent(c.id)}/roles`);
    for (const x of cr) roleProblems.push(`Client-Rolle ${c.clientId}/${x.name}: Rollen liegen nur in der Datenbank der App`);
  }
  if (!roles.includes(PLATFORM_ADMIN_ROLE)) roleProblems.push(`Realm-Rolle ${PLATFORM_ADMIN_ROLE} fehlt`);
  out.push(finding({ ...kit, check: 'Keine Rollen in Keycloak (ausser platform-admin)', source: 'identity-kit · Spezifikation 3.5' }, roleProblems));

  // Identity Provider
  const idps = await kc.get<{ alias: string; providerId?: string }[]>(`${R}/identity-provider/instances`).catch(() => null);
  if (!idps) out.push({ level: 'realm', check: 'Identity Provider nur je Organisation', zone: 'einstellbar', source: 'identity.app.json › realm.entra', status: 'skip', details: ['nicht lesbar (Rolle view-identity-providers)'] });
  else {
    const entra = r ? !!r.entra : true;
    const bad = idps.filter(i => !entra || !/^entra-app-[a-z0-9][a-z0-9_-]*$/.test(i.alias))
      .map(i => entra ? `${i.alias}: nicht nach dem Muster entra-app-<alias> (eigene Entra-App einer Organisation)` : `${i.alias}: Identity Provider, obwohl realm.entra aus ist`);
    out.push(finding({ level: 'realm', check: 'Identity Provider nur je Organisation', zone: 'einstellbar', source: 'identity.app.json › realm.entra' }, bad));
  }
  return out;
}
