/**
 * Hilfen für den Keycloak-Nachweis (keycloak.sh) gegen eine lokale Wegwerf-Instanz. Übernimmt, was in Produktion
 * der Betreiber der Instanz als Server-Admin erledigt (Spezifikation Kap. 2, Schritt 2), und erzeugt Testschlüssel.
 * Anmeldung als Admin des Realms master mit Passwort – nur hier, nur gegen die lokale Instanz.
 *
 *   node kc.ts keys <verzeichnis> <client> …           Schlüsselpaare: <client>.json (JWKS, öffentlich), <client>.pem
 *   node kc.ts wait                                     wartet, bis Keycloak antwortet (höchstens 180 s)
 *   node kc.ts product-hull <produkt> <jwks-datei>      wie der Betreiber: Realm (FGAP v2), <produkt>-iac
 *                                                      (private_key_jwt) und dessen realm-management/realm-admin
 *   node kc.ts rights <realm> <schlüssel-verz.> <smtp>  Rechte von <realm>-admin und <realm>-sync (Spezifikation 3.7):
 *                                                      was sie dürfen und was nicht (Realm, Abläufe, Schlüssel, Rollen)
 *
 * Umgebung: KC_URL (z. B. http://127.0.0.1:18080), KC_ADMIN_USER, KC_ADMIN_PASSWORD.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const env = process.env;
const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`${k} fehlt`); return v; };
const [cmd, ...args] = process.argv.slice(2);

async function adminToken(): Promise<string> {
  const r = await fetch(`${need('KC_URL')}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: need('KC_ADMIN_USER'), password: need('KC_ADMIN_PASSWORD') }),
  });
  if (!r.ok) throw new Error(`Admin-Anmeldung: HTTP ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${need('KC_URL')}/admin/realms${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function serviceAccount(token: string, realm: string, clientId: string): Promise<{ id: string }> {
  const [client] = await api<{ id: string }[]>(token, 'GET', `/${realm}/clients?clientId=${encodeURIComponent(clientId)}`);
  if (!client) throw new Error(`Client ${clientId} im Realm ${realm} fehlt`);
  return api(token, 'GET', `/${realm}/clients/${client.id}/service-account-user`);
}

// ---------- Rechte der Service Accounts (private_key_jwt wie die App)

async function clientToken(realm: string, clientId: string, keysDir: string): Promise<string> {
  const kid = (JSON.parse(readFileSync(`${keysDir}/${clientId}.json`, 'utf8')) as { keys: { kid: string }[] }).keys[0]!.kid;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64({ alg: 'ES256', typ: 'JWT', kid })}.${b64({ iss: clientId, sub: clientId, aud: `${need('KC_URL')}/realms/${realm}`, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  const sig = sign('sha256', Buffer.from(data), { key: readFileSync(`${keysDir}/${clientId}.pem`, 'utf8'), dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const r = await fetch(`${need('KC_URL')}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: `${data}.${sig}` }),
  });
  if (!r.ok) throw new Error(`Anmeldung ${clientId}: HTTP ${r.status} ${await r.text()}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

// Wie api(), aber ohne Abbruch: liefert Status, Inhalt und Location
async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any; location: string }> {
  const r = await fetch(`${need('KC_URL')}/admin/realms${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: unknown; try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  return { status: r.status, data, location: r.headers.get('location') ?? '' };
}

async function rights(realm: string, keysDir: string, smtp: boolean): Promise<void> {
  const R = `/${realm}`;
  const id = (loc: string) => loc.split('/').pop()!;
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const server = await adminToken();
  const [rm] = await api<{ id: string }[]>(server, 'GET', `${R}/clients?clientId=realm-management`);
  const manageRealm = await api<{ id: string; name: string }>(server, 'GET', `${R}/clients/${rm!.id}/roles/manage-realm`);
  const fixtureOrg = id((await call(server, 'POST', `${R}/organizations`, { name: `fx-${rnd()}`, alias: `fx-${rnd()}` })).location);
  const fails: string[] = [];
  const check = (who: string, what: string, got: number, want: number) => {
    if (got !== want) fails.push(`${who}: ${what} – HTTP ${got} statt ${want}`);
    console.log(`  ${got === want ? 'ok' : 'FEHLER'} ${who}: ${what} → ${got}`);
  };

  // <realm>-admin: Organisationen und Mitglieder verwalten, Konten anlegen; Realm nur lesen
  const adminClient = `${realm}-admin`;
  let t = await clientToken(realm, adminClient, keysDir);
  check(adminClient, 'Organisationen auflisten', (await call(t, 'GET', `${R}/organizations?briefRepresentation=false`)).status, 200);
  const org = await call(t, 'POST', `${R}/organizations`, { name: `t-${rnd()}`, alias: `t-${rnd()}` });
  check(adminClient, 'Organisation anlegen', org.status, 201);
  const orgId = id(org.location);
  const cur = (await call(t, 'GET', `${R}/organizations/${orgId}`)).data;
  check(adminClient, 'Organisation ändern', (await call(t, 'PUT', `${R}/organizations/${orgId}`, { ...cur, description: 'geändert' })).status, 204);
  const user = await call(t, 'POST', `${R}/users`, { username: `t-${rnd()}`, email: `t-${rnd()}@example.ch`, enabled: true });
  check(adminClient, 'Konto anlegen', user.status, 201);
  const userId = id(user.location);
  check(adminClient, 'Mitglied hinzufügen', (await call(t, 'POST', `${R}/organizations/${orgId}/members`, userId)).status, 201);
  check(adminClient, 'Mitglieder lesen', (await call(t, 'GET', `${R}/organizations/${orgId}/members?briefRepresentation=false`)).status, 200);
  check(adminClient, 'Organisationen einer Person', (await call(t, 'GET', `${R}/organizations/members/${userId}/organizations?briefRepresentation=true`)).status, 200);
  check(adminClient, 'Mitglied entfernen', (await call(t, 'DELETE', `${R}/organizations/${orgId}/members/${userId}`)).status, 204);
  // Weitere Aufrufe der App an Konten (packages/iam/src/keycloak.ts)
  check(adminClient, 'Konto ändern', (await call(t, 'PUT', `${R}/users/${userId}`, { firstName: 'Test' })).status, 204);
  check(adminClient, 'Anmeldedaten lesen', (await call(t, 'GET', `${R}/users/${userId}/credentials`)).status, 200);
  check(adminClient, 'Verknüpfte Anbieter lesen', (await call(t, 'GET', `${R}/users/${userId}/federated-identity`)).status, 200);
  check(adminClient, 'Realm-Rollen eines Kontos lesen', (await call(t, 'GET', `${R}/users/${userId}/role-mappings/realm/composite`)).status, 200);
  // Versand scheitert im Test (kein erreichbarer SMTP-Server); geprüft wird nur, dass Keycloak den Aufruf zulässt
  const actions = (await call(t, 'PUT', `${R}/users/${userId}/execute-actions-email?lifespan=600`, ['UPDATE_PASSWORD'])).status;
  check(adminClient, `Aktions-E-Mail auslösen (HTTP ${actions}, nicht 403)`, actions === 403 ? 403 : 0, 0);
  const realmRep = await call(t, 'GET', R);
  check(adminClient, 'Realm lesen', realmRep.status, 200);
  check(adminClient, `SMTP sichtbar (${smtp ? 'eingerichtet' : 'nicht eingerichtet'})`, !!realmRep.data?.smtpServer?.host === smtp ? 200 : 0, 200);
  check(adminClient, '× Realm-Einstellungen ändern', (await call(t, 'PUT', R, { displayName: 'übernommen' })).status, 403);
  check(adminClient, '× Anmeldeablauf anlegen', (await call(t, 'POST', `${R}/authentication/flows`, { alias: `x-${rnd()}`, providerId: 'basic-flow', topLevel: true, builtIn: false })).status, 403);
  check(adminClient, '× Signaturschlüssel anlegen', (await call(t, 'POST', `${R}/components`, { name: 'fremd', providerId: 'rsa-generated', providerType: 'org.keycloak.keys.KeyProvider', config: { priority: ['999'] } })).status, 403);
  check(adminClient, '× Client anlegen', (await call(t, 'POST', `${R}/clients`, { clientId: `x-${rnd()}` })).status, 403);
  const adminSa = await serviceAccount(server, realm, adminClient);
  check(adminClient, '× sich manage-realm geben', (await call(t, 'POST', `${R}/users/${adminSa.id}/role-mappings/clients/${rm!.id}`, [manageRealm])).status, 403);
  check(adminClient, 'Konto löschen', (await call(t, 'DELETE', `${R}/users/${userId}`)).status, 204);
  check(adminClient, 'Organisation löschen', (await call(t, 'DELETE', `${R}/organizations/${orgId}`)).status, 204);

  // Ohne view-realm: sieht <realm>-admin den SMTP-Server noch? (Begründung für view-realm; danach wiederhergestellt)
  if (smtp) {
    const viewRealm = await api<{ id: string; name: string }>(server, 'GET', `${R}/clients/${rm!.id}/roles/view-realm`);
    await api(server, 'DELETE', `${R}/users/${adminSa.id}/role-mappings/clients/${rm!.id}`, [viewRealm]);
    try {
      const r = await call(await clientToken(realm, adminClient, keysDir), 'GET', R);
      console.log(`  info ${adminClient} ohne view-realm: Realm lesen → ${r.status}, SMTP ${r.data?.smtpServer?.host ? 'sichtbar' : 'nicht sichtbar'}`);
    } finally {
      await api(server, 'POST', `${R}/users/${adminSa.id}/role-mappings/clients/${rm!.id}`, [viewRealm]);
    }
  }

  // <realm>-sync: nur lesen
  const syncClient = `${realm}-sync`;
  t = await clientToken(realm, syncClient, keysDir);
  check(syncClient, 'Organisationen auflisten', (await call(t, 'GET', `${R}/organizations?briefRepresentation=false`)).status, 200);
  check(syncClient, 'Mitglieder lesen', (await call(t, 'GET', `${R}/organizations/${fixtureOrg}/members?briefRepresentation=false`)).status, 200);
  check(syncClient, 'Konten lesen', (await call(t, 'GET', `${R}/users?max=5`)).status, 200);
  check(syncClient, '× Organisation anlegen', (await call(t, 'POST', `${R}/organizations`, { name: `x-${rnd()}`, alias: `x-${rnd()}` })).status, 403);
  check(syncClient, '× Konto anlegen', (await call(t, 'POST', `${R}/users`, { username: `x-${rnd()}`, enabled: true })).status, 403);
  check(syncClient, '× Realm-Einstellungen ändern', (await call(t, 'PUT', R, { displayName: 'übernommen' })).status, 403);

  await call(server, 'DELETE', `${R}/organizations/${fixtureOrg}`);
  if (fails.length) throw new Error(`Rechte nicht wie erwartet:\n${fails.join('\n')}`);
}

switch (cmd) {
  case 'keys': {
    // EC P-256, kid = JWK-Thumbprint (RFC 7638)
    const [dir, ...clients] = args;
    mkdirSync(dir!, { recursive: true });
    for (const c of clients) {
      const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
      const kid = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
      writeFileSync(`${dir}/${c}.json`, JSON.stringify({ keys: [{ kty: jwk.kty, x: jwk.x, y: jwk.y, crv: jwk.crv, kid, alg: 'ES256', use: 'sig' }] }, null, 2) + '\n');
      writeFileSync(`${dir}/${c}.pem`, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    }
    break;
  }
  case 'wait': {
    for (let i = 0; i < 90; i++) {
      try { if ((await fetch(`${need('KC_URL')}/realms/master/.well-known/openid-configuration`)).ok) process.exit(0); } catch { /* startet noch */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Keycloak antwortet nicht');
  }
  case 'product-hull': {
    // Wie der Betreiber (vollholz/identity › infra/keycloak/products.tf): Realm nur als Hülle mit FGAP v2, Client
    // <produkt>-iac mit private_key_jwt und realm-management/realm-admin; den Inhalt verwaltet danach product-realm
    const [product, jwksFile] = args;
    const token = await adminToken();
    await api(token, 'POST', '', { realm: product, enabled: true, adminPermissionsEnabled: true });
    await api(token, 'POST', `/${product}/clients`, {
      clientId: `${product}-iac`, name: 'OpenTofu (IaC)', protocol: 'openid-connect', publicClient: false, clientAuthenticatorType: 'client-jwt',
      standardFlowEnabled: false, implicitFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: true, frontchannelLogout: false,
      attributes: {
        [`${product}.platform`]: 'true', 'use.jwks.url': 'false', 'use.jwks.string': 'true', 'jwks.string': JSON.stringify(JSON.parse(readFileSync(jwksFile!, 'utf8'))),
        'token.endpoint.auth.signing.alg': 'ES256', 'access.token.lifespan': '300', 'pkce.code.challenge.method': 'S256',
      },
    });
    const sa = await serviceAccount(token, product!, `${product}-iac`);
    const [rm] = await api<{ id: string }[]>(token, 'GET', `/${product}/clients?clientId=realm-management`);
    const role = await api<{ id: string; name: string }>(token, 'GET', `/${product}/clients/${rm!.id}/roles/realm-admin`);
    await api(token, 'POST', `/${product}/users/${sa.id}/role-mappings/clients/${rm!.id}`, [role]);
    console.log(`Realm ${product}, ${product}-iac (realm-admin) angelegt`);
    break;
  }
  case 'rights': {
    const [realm, keysDir, smtp] = args;
    await rights(realm!, keysDir!, smtp === 'true');
    break;
  }
  default:
    throw new Error(`unbekannter Befehl: ${cmd ?? ''}`);
}
