/**
 * Konfiguration des IAM aus Umgebungsvariablen (Spezifikation Kap. 13; aus Assets `config/env.ts`).
 *
 * Jede Variable ist einmal beschrieben (Typ, Standard, Pflicht, geheim). Daraus entstehen die geprüfte, typisierte
 * Konfiguration beim Start (fehlende oder ungültige Werte brechen mit allen Meldungen zugleich ab) und die Liste für die
 * Doku der App (`IAM_VARS`). Standardwerte mit dem Namen des Produkts (`<produkt>-api` …) setzt `product` ein.
 *
 * Eine App mit eigener Variablenliste (Assets) liest die Werte selbst (`readVars` mit ihrer Liste) und ruft dann
 * `iamConfigErrors` und `iamConfig` mit denselben Rohwerten auf; Namen und Bedeutung der Variablen sind dieselben.
 */
import { readFileSync } from 'node:fs';

type Kind = 'string' | 'int' | 'bool' | 'url' | 'list' | 'enum' | 'duration';

/**
 * Dienste (Prozesse) einer App. Jeder verlangt nur die Werte, die sein Code liest, und bekommt im Deployment nur seine
 * Geheimnisse (Kap. 13 › Geheimnisse je Dienst). `null` (Skripte, Tests): alle Prüfungen.
 */
export type Service = 'api' | 'worker' | 'mcp';
export type Mode = 'development' | 'test' | 'production';

export interface VarSpec {
  name: string;
  kind: Kind;
  group: string;
  description: string;
  default?: string;
  /** Pflicht in jedem Modus (sonst nur, wenn `requiredIn` passt). */
  required?: boolean;
  /** Pflicht nur in diesen Modi. */
  requiredIn?: Mode[];
  /** Pflicht nur für diese Dienste (Standard: alle). Die anderen lesen den Wert nicht und starten ohne ihn. */
  services?: Service[];
  secret?: boolean;
  /** Erlaubt `<NAME>_FILE` mit Pfad zu einer Datei (Docker/Kubernetes Secrets). */
  fileAllowed?: boolean;
  values?: string[];
  example?: string;
}

export class ConfigError extends Error {}

const DUR = /^(\d+)(ms|s|m|h|d)$/;
export function parseDuration(v: string): number {
  if (v.trim() === '0') return 0;
  const m = DUR.exec(v.trim());
  if (!m) throw new Error(`ungültige Dauer «${v}» (z. B. 30s, 5m, 8h)`);
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[m[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
}

/**
 * Technischer Name des Produkts (Spezifikation Kap. 2, `<produkt>`): Kleinbuchstaben und Ziffern, Teile mit «-»
 * getrennt, höchstens 41 Zeichen. So heissen Realm und Clients (`<produkt>-api`); Bezeichner in der Datenbank leiten
 * sich mit «_» statt «-» ab (`productIdent`). Eine Regel für Konfiguration, Migrationen und `db/bootstrap.sql`.
 */
export const PRODUCT_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Prüft den Namen des Produkts (ConfigError sonst). */
export function checkProduct(product: string): string {
  if (!PRODUCT_PATTERN.test(product) || product.length > 41) throw new ConfigError(`product: ungültiger Name «${product}» (Kleinbuchstaben, Ziffern, Teile mit «-», höchstens 41 Zeichen)`);
  return product;
}

/** Bezeichner in der Datenbank zum Produkt: Schema und Präfix der Rollen (`my-app` → `my_app`). */
export const productIdent = (product: string) => checkProduct(product).replaceAll('-', '_');

/** Variablen des IAM mit den Standardwerten für `product`. */
export function IAM_VARS(product: string): VarSpec[] {
  checkProduct(product);
  const p = product;
  return [
    { name: 'NODE_ENV', kind: 'enum', group: 'Allgemein', values: ['development', 'test', 'production'], default: 'development', description: 'Betriebsmodus. In `production` gelten strengere Prüfungen (HTTPS, Geheimnisse, DPoP).' },
    { name: 'PUBLIC_BASE_URL', kind: 'url', group: 'Allgemein', default: 'http://localhost:8080', requiredIn: ['production'], description: 'Öffentliche Adresse der API und der Oberfläche, ohne abschliessenden Schrägstrich. Grundlage für Weiterleitungen und DPoP (`htu`).', example: `https://${p}.example.ch` },

    { name: 'DATABASE_URL', kind: 'url', group: 'Datenbank', required: true, services: ['api'], secret: true, fileAllowed: true, description: 'Verbindung der Laufzeit (Rolle ohne BYPASSRLS, nicht Besitzerin der Tabellen).', example: `postgres://${productIdent(p)}_runtime:***@localhost:5433/${productIdent(p)}` },
    { name: 'DATABASE_ADMIN_URL', kind: 'url', group: 'Datenbank', secret: true, fileAllowed: true, description: 'Verbindung für Migrationen (Besitzer-Rolle).', example: `postgres://${productIdent(p)}_owner:***@localhost:5433/${productIdent(p)}` },
    { name: 'DATABASE_WORKER_URL', kind: 'url', group: 'Datenbank', secret: true, fileAllowed: true, description: 'Verbindung des Workers. Ohne Angabe gilt `DATABASE_URL`; der Worker braucht nur eine der beiden.' },
    { name: 'DATABASE_POOL_MAX', kind: 'int', group: 'Datenbank', default: '20', description: 'Maximale Verbindungen pro Prozess.' },
    { name: 'DATABASE_STATEMENT_TIMEOUT', kind: 'duration', group: 'Datenbank', default: '30s', description: 'Abbruch langer SQL-Anweisungen.' },
    { name: 'DATABASE_SSL', kind: 'enum', group: 'Datenbank', values: ['disable', 'require', 'verify-full'], default: 'disable', description: 'TLS zur Datenbank. In Produktion `verify-full`.' },

    { name: 'OIDC_ISSUER_URL', kind: 'url', group: 'Anmeldung (Keycloak)', required: true, description: 'Issuer des Realms. Endpunkte werden über Discovery ermittelt.', example: `https://identity.project-suite.ch/realms/${p}` },
    { name: 'OIDC_API_AUDIENCE', kind: 'string', group: 'Anmeldung (Keycloak)', default: `${p}-api`, description: 'Erwartete Zielgruppe (`aud`) für Tokens der REST-API.' },
    { name: 'OIDC_MCP_AUDIENCE', kind: 'string', group: 'Anmeldung (Keycloak)', default: `${p}-mcp`, description: 'Erwartete Zielgruppe für Tokens des MCP-Dienstes.' },
    { name: 'OIDC_CLOCK_TOLERANCE', kind: 'duration', group: 'Anmeldung (Keycloak)', default: '30s', description: 'Toleranz für Uhrzeitabweichungen bei `exp`, `nbf`, `iat`.' },
    { name: 'OIDC_BFF_CLIENT_ID', kind: 'string', group: 'Anmeldung (Keycloak)', default: `${p}-platform`, description: 'Client der Oberfläche (BFF, vertraulich, Code-Flow mit PKCE).' },
    { name: 'OIDC_BFF_CLIENT_SECRET', kind: 'string', group: 'Anmeldung (Keycloak)', secret: true, fileAllowed: true, description: 'Geheimnis des BFF-Clients (nur übergangsweise; Warnung beim Start). In `production` Pflicht, ausser `OIDC_BFF_PRIVATE_KEY` ist gesetzt.' },
    { name: 'OIDC_BFF_PRIVATE_KEY', kind: 'string', group: 'Anmeldung (Keycloak)', secret: true, fileAllowed: true, description: 'Privater Schlüssel (PEM, PKCS#8) für `private_key_jwt` des BFF-Clients. Hat Vorrang vor dem Geheimnis.' },
    { name: 'OIDC_SCOPES', kind: 'string', group: 'Anmeldung (Keycloak)', default: 'openid profile email organization', description: 'Scopes bei der Anmeldung. `organization` liefert die Organisationen (als `organization:*`).' },

    { name: 'TENANT_CLAIM', kind: 'string', group: 'Mandanten und Rollen', default: 'organization', description: 'Claim mit den Organisationen (Liste von Aliassen oder Objekt mit Aliassen als Schlüssel).' },
    { name: 'TENANT_AUTO_PROVISION', kind: 'bool', group: 'Mandanten und Rollen', default: 'true', description: 'Unbekannte Organisation beim ersten Zugriff einer Person als Mandant anlegen (Maschinen-Clients nie).' },
    { name: 'ROLE_SOURCE', kind: 'enum', group: 'Mandanten und Rollen', values: ['client', 'groups', 'both'], default: 'groups', description: 'Rollen von Personen. `groups` (empfohlen): je Organisation über Gruppen `<prefix>/<org>/<rolle>`. `client`/`both`: Client-Rollen gelten nur, wenn das Token genau eine Organisation enthält (Warnung beim Start).' },
    { name: 'ROLE_CLIENT_ID', kind: 'string', group: 'Mandanten und Rollen', default: `${p}-platform`, description: 'Client, dessen Client-Rollen ausgewertet werden (`resource_access.<client>.roles`; Service Accounts).' },
    { name: 'OIDC_PERSON_CLIENT_IDS', kind: 'list', group: 'Mandanten und Rollen', default: '', description: 'Clients (`azp`), deren Tokens als Person gelten. Leer = `OIDC_BFF_CLIENT_ID` und `MCP_CLIENT_ID`. Tokens aller anderen Clients gelten als Maschinen-Client (Freigabe je Mandant, Scopes).' },
    { name: 'GROUPS_CLAIM', kind: 'string', group: 'Mandanten und Rollen', default: 'groups', description: 'Claim mit Gruppenpfaden.' },
    { name: 'GROUP_ROLE_PREFIX', kind: 'string', group: 'Mandanten und Rollen', default: '/orgs', description: 'Präfix der Rollengruppen: `<prefix>/<org-alias>/<rolle>`.' },
    { name: 'PLATFORM_ADMIN_ROLE', kind: 'string', group: 'Mandanten und Rollen', default: 'platform-admin', description: 'Realm-Rolle für die Plattform-Administration über alle Mandanten.' },

    { name: 'KEYCLOAK_MGMT_CLIENT_ID', kind: 'string', group: 'Verwaltung von Organisationen und Mitgliedern', default: '', description: `Vertraulicher Client mit Service Account (\`${p}-admin\`). Ohne Angabe ist die Verwaltung von Organisationen, Mitgliedern und Rollen abgeschaltet.` },
    { name: 'KEYCLOAK_MGMT_PRIVATE_KEY', kind: 'string', group: 'Verwaltung von Organisationen und Mitgliedern', secret: true, fileAllowed: true, description: 'Privater Schlüssel (PEM, PKCS#8, EC P-256 oder RSA) für `private_key_jwt` des Verwaltungs-Clients. Hat Vorrang vor dem Geheimnis.' },
    { name: 'KEYCLOAK_MGMT_CLIENT_SECRET', kind: 'string', group: 'Verwaltung von Organisationen und Mitgliedern', secret: true, fileAllowed: true, description: 'Geheimnis des Verwaltungs-Clients (nur übergangsweise; Warnung beim Start).' },
    { name: 'KEYCLOAK_MGMT_URL', kind: 'url', group: 'Verwaltung von Organisationen und Mitgliedern', description: 'Adresse der Admin-API des Realms, falls sie nicht aus `OIDC_ISSUER_URL` folgt (`…/realms/<realm>` → `…/admin/realms/<realm>`).', example: `http://keycloak:8080/admin/realms/${p}` },
    { name: 'KEYCLOAK_MGMT_INVITE_LIFESPAN', kind: 'duration', group: 'Verwaltung von Organisationen und Mitgliedern', default: '72h', description: 'Gültigkeit des Links in der Einladung («Passwort festlegen»). 1h bis 30d.' },
    { name: 'KEYCLOAK_MGMT_INVITE_MIN_TIME', kind: 'duration', group: 'Verwaltung von Organisationen und Mitgliedern', default: '2s', description: 'Mindestdauer der Antwort auf Einladen, Zurückziehen und erneut Senden: neues und bestehendes Konto sind so auch an der Antwortzeit nicht zu unterscheiden. 0 = aus.' },
    { name: 'KEYCLOAK_MGMT_TIMEOUT', kind: 'duration', group: 'Verwaltung von Organisationen und Mitgliedern', default: '10s', description: 'Zeitlimit je Aufruf der Admin-API.' },
    { name: 'KEYCLOAK_SYNC_CLIENT_ID', kind: 'string', group: 'Verwaltung von Organisationen und Mitgliedern', default: '', description: `Eigener Client mit Service Account für den Abgleich der Mitglieder im Worker (\`${p}-sync\`). Ohne Angabe kein Abgleich im Worker.` },
    { name: 'KEYCLOAK_SYNC_PRIVATE_KEY', kind: 'string', group: 'Verwaltung von Organisationen und Mitgliedern', secret: true, fileAllowed: true, description: 'Privater Schlüssel (PEM, PKCS#8) für `private_key_jwt` des Abgleich-Clients; nicht der des Verwaltungs-Clients.' },
    { name: 'KEYCLOAK_SYNC_CLIENT_SECRET', kind: 'string', group: 'Verwaltung von Organisationen und Mitgliedern', secret: true, fileAllowed: true, description: 'Geheimnis des Abgleich-Clients (nur übergangsweise; Warnung beim Start).' },
    { name: 'MEMBER_SYNC_INTERVAL', kind: 'duration', group: 'Verwaltung von Organisationen und Mitgliedern', default: '1h', description: 'Abstand der Abgleiche aller Mandanten im Worker; höchstens ein Lauf über alle Instanzen. `0` = aus, sonst mindestens 1m.' },

    { name: 'ENTRA_CLIENT_ID', kind: 'string', group: 'Anmeldung über Microsoft Entra ID', default: '', description: 'Anwendungs-ID der mandantenfähigen App in Microsoft Entra ID. Ohne Angabe ist die Anmeldung über Entra ID abgeschaltet. Braucht die Verwaltung (`KEYCLOAK_MGMT_CLIENT_ID`).' },
    { name: 'ENTRA_CLIENT_SECRET', kind: 'string', group: 'Anmeldung über Microsoft Entra ID', secret: true, fileAllowed: true, description: 'Geheimnis der Entra-App (Tokens für Microsoft Graph, Identitätsanbieter in Keycloak).' },
    { name: 'ENTRA_IDP_SLOTS', kind: 'int', group: 'Anmeldung über Microsoft Entra ID', default: '100', description: 'Anzahl der in der Entra-App eingetragenen Redirect-URIs `…/broker/entra-001/endpoint` bis `…/entra-<n>/endpoint`. 1 bis 250.' },
    { name: 'ENTRA_UI_PATH', kind: 'string', group: 'Anmeldung über Microsoft Entra ID', default: '/verwalten/anmeldung', description: 'Seite «Anmeldung» der Oberfläche (`paths.entra` in `@vollholz/iam-web`). Rückkehr nach der Admin-Zustimmung: `<pfad>/zustimmung` (als Redirect-URI in der Entra-App eingetragen), nach der Testanmeldung: `<pfad>/test`.' },
    { name: 'ENTRA_TIMEOUT', kind: 'duration', group: 'Anmeldung über Microsoft Entra ID', default: '10s', description: 'Zeitlimit je Aufruf bei Microsoft (Anmeldung, Graph).' },

    { name: 'DPOP_MODE', kind: 'enum', group: 'Maschinenzugriff (M2M)', values: ['off', 'optional', 'required-for-clients', 'required'], default: 'required-for-clients', description: 'DPoP-Pflicht. `required-for-clients`: Maschinen-Clients müssen sendergebundene Tokens verwenden, Personen (über BFF) nicht.' },
    { name: 'DPOP_MAX_AGE', kind: 'duration', group: 'Maschinenzugriff (M2M)', default: '300s', description: 'Maximales Alter eines DPoP-Proofs (`iat`).' },
    { name: 'MTLS_HEADER', kind: 'string', group: 'Maschinenzugriff (M2M)', default: '', description: 'Header, in dem der Proxy das Client-Zertifikat weitergibt (PEM, auch URL-kodiert, oder DER als base64); der Proxy muss ihn immer setzen bzw. überschreiben. Aktiviert mTLS-gebundene Tokens (RFC 8705).' },

    { name: 'SESSION_SECRET', kind: 'string', group: 'Sitzung (Oberfläche)', secret: true, fileAllowed: true, requiredIn: ['production'], services: ['api'], description: 'Schlüssel für Sitzungs-Cookies (mind. 32 Zeichen). Mehrere kommagetrennt für Rotation, der erste signiert.' },
    { name: 'SESSION_TTL', kind: 'duration', group: 'Sitzung (Oberfläche)', default: '8h', description: 'Maximale Dauer einer Sitzung.' },
    { name: 'SESSION_IDLE_TIMEOUT', kind: 'duration', group: 'Sitzung (Oberfläche)', default: '60m', description: 'Abmeldung nach Inaktivität.' },
    { name: 'ENCRYPTION_KEYS', kind: 'string', group: 'Verschlüsselung', secret: true, fileAllowed: true, requiredIn: ['production'], services: ['api', 'worker'], description: 'Hauptschlüssel (Sitzungen, Geheimnisse der App). Format `id:base64(32 Bytes)`, mehrere kommagetrennt; der erste verschlüsselt.', example: 'k1:BASE64...' },

    { name: 'MCP_PUBLIC_URL', kind: 'url', group: 'MCP', default: 'http://localhost:8081/mcp', requiredIn: ['production'], services: ['mcp'], description: 'Öffentliche Adresse des MCP-Endpunkts inkl. `/mcp` (Resource Identifier nach RFC 9728, `htu` bei DPoP).', example: `https://mcp.${p}.example.ch/mcp` },
    { name: 'MCP_API_URL', kind: 'url', group: 'MCP', default: 'http://localhost:8080', description: 'Interne Adresse der REST-API, die der MCP-Dienst aufruft.' },
    { name: 'MCP_CLIENT_ID', kind: 'string', group: 'MCP', default: `${p}-mcp`, description: 'Client des MCP-Dienstes für Token Exchange (RFC 8693).' },
    { name: 'MCP_HOST_CLIENT_IDS', kind: 'list', group: 'MCP', default: `${p}-mcp-cli`, description: 'Clients (`azp`), über die sich Personen in MCP-Hosts anmelden. Nur deren Tokens tauscht der MCP-Dienst; andere Tokens mit der Zielgruppe `OIDC_MCP_AUDIENCE` weist er mit 403 ab.' },
    { name: 'MCP_CLIENT_SECRET', kind: 'string', group: 'MCP', secret: true, fileAllowed: true, description: 'Geheimnis des MCP-Clients (nur übergangsweise; Warnung beim Start). Alternativ `MCP_PRIVATE_KEY`.' },
    { name: 'MCP_PRIVATE_KEY', kind: 'string', group: 'MCP', secret: true, fileAllowed: true, description: 'Privater Schlüssel (PEM) für `private_key_jwt` des MCP-Clients.' },
    { name: 'MCP_DPOP_KEY', kind: 'string', group: 'MCP', secret: true, fileAllowed: true, description: 'Privater Schlüssel (PEM, EC P-256) für DPoP der getauschten API-Tokens. Ohne Angabe erzeugt jede Instanz beim Start einen eigenen.' },

    { name: 'SHARED_STATE', kind: 'enum', group: 'Betrieb', values: ['postgres', 'memory'], default: 'postgres', description: 'Speicher für Replay-Schutz (DPoP, Logout-Tokens) und Rate-Limit. `postgres`: geteilt über alle Instanzen (Pflicht bei mehr als einer Instanz). `memory`: nur im Prozess.' },
    { name: 'RATE_LIMIT_NAMESPACE', kind: 'string', group: 'Betrieb', description: 'Vorsatz der Rate-Limit-Schlüssel des Pakets (`<namespace>:<produkt>:…`), wenn mehrere Umgebungen denselben geteilten Speicher nutzen (z. B. E2E und lokale App mit SHARED_STATE=postgres). Buchstaben, Ziffern, `_`, `-`, `.`; leer: kein Vorsatz.', example: 'e2e' },
  ];
}

export interface IamConfig {
  mode: Mode;
  publicBaseUrl: string;
  db: { url: string; adminUrl: string | null; workerUrl: string; poolMax: number; statementTimeoutMs: number; ssl: 'disable' | 'require' | 'verify-full' };
  oidc: { issuer: string; apiAudience: string; mcpAudience: string; clockToleranceSec: number; bffClientId: string; bffClientSecret: string | null; bffPrivateKey: string | null; scopes: string };
  tenancy: { claim: string; autoProvision: boolean; roleSource: 'client' | 'groups' | 'both'; roleClientId: string; personClients: string[]; groupsClaim: string; groupRolePrefix: string; platformAdminRole: string };
  m2m: { dpopMode: 'off' | 'optional' | 'required-for-clients' | 'required'; dpopMaxAgeSec: number; mtlsHeader: string | null };
  /** Verwaltung über die Keycloak-Admin-API; `clientId` null = abgeschaltet. */
  mgmt: { clientId: string | null; privateKey: string | null; clientSecret: string | null; adminUrl: string | null; inviteLifespanSec: number; inviteMinMs: number; timeoutMs: number };
  /** Anmeldung über Microsoft Entra ID je Organisation; `clientId` null = abgeschaltet. */
  entra: { clientId: string | null; clientSecret: string | null; slots: number; timeoutMs: number; uiPath: string };
  /** Abgleich der Mitglieder im Worker; `clientId` null oder `intervalMs` 0 = abgeschaltet. */
  memberSync: { clientId: string | null; privateKey: string | null; clientSecret: string | null; intervalMs: number };
  session: { secrets: string[]; ttlMs: number; idleMs: number };
  encryptionKeys: { id: string; key: Buffer }[];
  mcp: { publicUrl: string; apiUrl: string; clientId: string; clientSecret: string | null; privateKey: string | null; dpopKey: string | null; /** MCP_HOST_CLIENT_IDS */ hostClients: string[] };
  ops: { sharedState: 'postgres' | 'memory'; rateLimitNamespace: string };
}

/** Rohwerte (nach `_FILE` und Standardwerten). */
export type RawVars = Record<string, string | undefined>;

/**
 * Liest die Variablen `vars` (mit `<NAME>_FILE` und Standardwerten) und prüft Pflicht und Form.
 * Pflicht ist nur, was `service` liest; gesetzte Werte werden für jeden Dienst geprüft.
 */
export function readVars(env: NodeJS.ProcessEnv, vars: VarSpec[], service: Service | null): { raw: RawVars; mode: Mode; errors: string[] } {
  const errors: string[] = [];
  // Leer = Standard; ein ungültiger Wert ist ein Fehler (Prüfung von NODE_ENV) und gilt bis dahin als Produktion,
  // damit keine Prüfung still wegfällt
  const given = env.NODE_ENV || 'development';
  const mode: Mode = (['development', 'test', 'production'] as const).find(m => m === given) ?? 'production';
  if (mode !== given) errors.push(`NODE_ENV: erlaubt: development, test, production (nicht «${given}»)`);
  const needs = (...s: Service[]) => service === null || s.includes(service);
  const raw: RawVars = {};
  for (const v of vars) {
    let val = env[v.name];
    const file = env[`${v.name}_FILE`];
    if ((val === undefined || val === '') && file && v.fileAllowed) {
      try { val = readFileSync(file, 'utf8').trim(); } catch { errors.push(`${v.name}_FILE: Datei ${file} nicht lesbar`); }
    }
    if (val === undefined || val === '') val = v.default;
    const required = (v.required || (v.requiredIn ?? []).includes(mode)) && (!v.services || needs(...v.services));
    if (required && (val === undefined || val === '')) errors.push(`${v.name} fehlt – ${v.description}`);
    if (val !== undefined && val !== '') {
      try {
        if (v.kind === 'int' && !/^\d+$/.test(val)) throw new Error('ganze Zahl erwartet');
        if (v.kind === 'bool' && !/^(true|false|1|0)$/i.test(val)) throw new Error('true oder false erwartet');
        if (v.kind === 'url') new URL(val);
        if (v.kind === 'enum' && !v.values!.includes(val)) throw new Error(`erlaubt: ${v.values!.join(', ')}`);
        if (v.kind === 'duration') parseDuration(val);
      } catch (e) { errors.push(`${v.name}: ${(e as Error).message}`); }
    }
    raw[v.name] = val;
  }
  return { raw, mode, errors };
}

/** ENCRYPTION_KEYS lesen: `id:base64(32 Bytes)`, kommagetrennt. */
export function parseEncryptionKeys(v: string): { id: string; key: Buffer }[] {
  const keys = v.split(',').map(x => x.trim()).filter(Boolean).map(part => {
    const i = part.indexOf(':'); if (i < 1) throw new Error('Format id:base64');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(part.slice(0, i))) throw new Error(`Schlüssel-ID «${part.slice(0, i)}»: nur Buchstaben, Ziffern, - und _ (höchstens 64)`);
    const key = Buffer.from(part.slice(i + 1), 'base64'); if (key.length !== 32) throw new Error(`Schlüssel ${part.slice(0, i)} muss 32 Bytes haben`);
    return { id: part.slice(0, i), key };
  });
  const ids = keys.map(k => k.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`Schlüssel-ID «${dup}» doppelt`);
  return keys;
}

/** Prüfungen über mehrere Variablen (nach `readVars`); Meldungen wie in Assets. */
export function iamConfigErrors(raw: RawVars, mode: Mode, service: Service | null): string[] {
  const errors: string[] = [];
  const needs = (...s: Service[]) => service === null || s.includes(service);
  const n = (k: string) => Number(raw[k]);
  if (raw.ENCRYPTION_KEYS) {
    try { parseEncryptionKeys(raw.ENCRYPTION_KEYS); } catch (e) { errors.push(`ENCRYPTION_KEYS: ${(e as Error).message}`); }
  }
  if ((raw.SESSION_SECRET ?? '').split(',').map(x => x.trim()).filter(Boolean).some(x => x.length < 32)) errors.push('SESSION_SECRET: jeder Schlüssel braucht mindestens 32 Zeichen');
  // Datenbank des Workers: DATABASE_WORKER_URL, sonst DATABASE_URL (die API verlangt DATABASE_URL über ihre Pflicht)
  if (service === 'worker' && !raw.DATABASE_WORKER_URL && !raw.DATABASE_URL) errors.push('DATABASE_WORKER_URL oder DATABASE_URL (bzw. _FILE) fehlt – Verbindung des Workers zur Datenbank');
  // Schlüssel der Keycloak-Clients nur in dem Dienst, der den Client nutzt: BFF und Verwaltung in der API, Abgleich im Worker
  if (needs('api') && mode === 'production' && !raw.OIDC_BFF_CLIENT_SECRET && !raw.OIDC_BFF_PRIVATE_KEY) errors.push('OIDC_BFF_CLIENT_SECRET oder OIDC_BFF_PRIVATE_KEY (bzw. _FILE) fehlt – Anmeldung des BFF-Clients bei Keycloak');
  if (needs('api') && raw.KEYCLOAK_MGMT_CLIENT_ID && !raw.KEYCLOAK_MGMT_PRIVATE_KEY && !raw.KEYCLOAK_MGMT_CLIENT_SECRET) errors.push('KEYCLOAK_MGMT_CLIENT_ID gesetzt: KEYCLOAK_MGMT_PRIVATE_KEY oder KEYCLOAK_MGMT_CLIENT_SECRET (bzw. _FILE) fehlt');
  if (needs('api') && raw.ENTRA_CLIENT_ID) {
    if (!raw.ENTRA_CLIENT_SECRET) errors.push('ENTRA_CLIENT_ID gesetzt: ENTRA_CLIENT_SECRET (bzw. _FILE) fehlt');
    if (!raw.KEYCLOAK_MGMT_CLIENT_ID) errors.push('ENTRA_CLIENT_ID gesetzt: KEYCLOAK_MGMT_CLIENT_ID fehlt – die Anmeldung über Entra ID richtet die Plattform über die Verwaltung in Keycloak ein');
  }
  if (raw.ENTRA_UI_PATH !== undefined && (!/^\/[\w~.-]+(\/[\w~.-]+)*\/?$/.test(raw.ENTRA_UI_PATH) || raw.ENTRA_UI_PATH.split('/').some(x => x === '.' || x === '..'))) errors.push('ENTRA_UI_PATH: Pfad der Oberfläche wie /verwalten/anmeldung');
  if (raw.ENTRA_IDP_SLOTS && /^\d+$/.test(raw.ENTRA_IDP_SLOTS) && (n('ENTRA_IDP_SLOTS') < 1 || n('ENTRA_IDP_SLOTS') > 250)) errors.push('ENTRA_IDP_SLOTS: 1 bis 250');
  if (needs('worker') && raw.KEYCLOAK_SYNC_CLIENT_ID && !raw.KEYCLOAK_SYNC_PRIVATE_KEY && !raw.KEYCLOAK_SYNC_CLIENT_SECRET) errors.push('KEYCLOAK_SYNC_CLIENT_ID gesetzt: KEYCLOAK_SYNC_PRIVATE_KEY oder KEYCLOAK_SYNC_CLIENT_SECRET (bzw. _FILE) fehlt');
  if (raw.RATE_LIMIT_NAMESPACE && !/^[A-Za-z0-9_.-]{1,64}$/.test(raw.RATE_LIMIT_NAMESPACE.trim())) errors.push('RATE_LIMIT_NAMESPACE: Buchstaben, Ziffern, _, - und ., höchstens 64 Zeichen');
  if (raw.GROUP_ROLE_PREFIX !== undefined && !GROUP_PREFIX_RE.test(raw.GROUP_ROLE_PREFIX)) errors.push('GROUP_ROLE_PREFIX: Gruppenpfad wie /orgs (ohne Leerzeichen und leere Teile)');
  try { const ms = parseDuration(raw.MEMBER_SYNC_INTERVAL ?? '1h'); if (ms > 0 && ms < 60_000) errors.push('MEMBER_SYNC_INTERVAL: mindestens 1m oder 0 (aus)'); } catch { /* bereits gemeldet */ }
  try {
    const life = parseDuration(raw.KEYCLOAK_MGMT_INVITE_LIFESPAN ?? '72h');
    if (life < 3_600_000 || life > 30 * 86_400_000) errors.push('KEYCLOAK_MGMT_INVITE_LIFESPAN: 1h bis 30d');
  } catch { /* bereits gemeldet */ }
  if (mode === 'production') {
    if (raw.PUBLIC_BASE_URL && !raw.PUBLIC_BASE_URL.startsWith('https://')) errors.push('PUBLIC_BASE_URL muss in Produktion mit https:// beginnen');
    if (raw.OIDC_ISSUER_URL && !raw.OIDC_ISSUER_URL.startsWith('https://')) errors.push('OIDC_ISSUER_URL muss in Produktion mit https:// beginnen');
    if (raw.DPOP_MODE === 'off') errors.push('DPOP_MODE=off ist in Produktion nicht erlaubt');
  }
  return errors;
}

/** Typisierte Konfiguration aus geprüften Rohwerten. */
/**
 * Präfix der Rollengruppen einheitlich mit führendem und ohne abschliessenden «/» (`orgs`, `/orgs/` → `/orgs`): Token
 * (Gruppenpfade), Verwaltung (Gruppen anlegen) und Status sehen so denselben Pfad.
 */
/** Gültiger GROUP_ROLE_PREFIX: Gruppenpfad ohne Leerzeichen und leere Teile (führender und abschliessender «/» optional). */
export const GROUP_PREFIX_RE = /^\/?[^\s/]+(\/[^\s/]+)*\/?$/;

export function normalizeGroupPrefix(v: string): string { return `/${v.replace(/^\/+|\/+$/g, '')}`; }

export function iamConfig(raw: RawVars, mode: Mode): IamConfig {
  const s = (k: string) => raw[k] ?? '';
  const n = (k: string) => Number(raw[k]);
  const b = (k: string) => /^(true|1)$/i.test(raw[k] ?? '');
  const d = (k: string) => parseDuration(raw[k] ?? '0ms');
  const opt = (k: string) => (raw[k] ? raw[k]! : null);
  const list = (k: string) => s(k).split(',').map(x => x.trim()).filter(Boolean);
  return {
    mode, publicBaseUrl: s('PUBLIC_BASE_URL').replace(/\/$/, ''),
    db: { url: s('DATABASE_URL'), adminUrl: opt('DATABASE_ADMIN_URL'), workerUrl: opt('DATABASE_WORKER_URL') ?? s('DATABASE_URL'), poolMax: n('DATABASE_POOL_MAX'), statementTimeoutMs: d('DATABASE_STATEMENT_TIMEOUT'), ssl: s('DATABASE_SSL') as IamConfig['db']['ssl'] },
    oidc: { issuer: s('OIDC_ISSUER_URL').replace(/\/$/, ''), apiAudience: s('OIDC_API_AUDIENCE'), mcpAudience: s('OIDC_MCP_AUDIENCE'), clockToleranceSec: Math.round(d('OIDC_CLOCK_TOLERANCE') / 1000), bffClientId: s('OIDC_BFF_CLIENT_ID'), bffClientSecret: opt('OIDC_BFF_CLIENT_SECRET'), bffPrivateKey: opt('OIDC_BFF_PRIVATE_KEY'), scopes: s('OIDC_SCOPES') },
    tenancy: { claim: s('TENANT_CLAIM'), autoProvision: b('TENANT_AUTO_PROVISION'), roleSource: s('ROLE_SOURCE') as IamConfig['tenancy']['roleSource'], roleClientId: s('ROLE_CLIENT_ID'), personClients: list('OIDC_PERSON_CLIENT_IDS'), groupsClaim: s('GROUPS_CLAIM'), groupRolePrefix: normalizeGroupPrefix(s('GROUP_ROLE_PREFIX')), platformAdminRole: s('PLATFORM_ADMIN_ROLE') },
    m2m: { dpopMode: s('DPOP_MODE') as IamConfig['m2m']['dpopMode'], dpopMaxAgeSec: Math.round(d('DPOP_MAX_AGE') / 1000), mtlsHeader: opt('MTLS_HEADER') },
    mgmt: { clientId: opt('KEYCLOAK_MGMT_CLIENT_ID'), privateKey: opt('KEYCLOAK_MGMT_PRIVATE_KEY'), clientSecret: opt('KEYCLOAK_MGMT_CLIENT_SECRET'), adminUrl: opt('KEYCLOAK_MGMT_URL')?.replace(/\/$/, '') ?? null, inviteLifespanSec: Math.round(d('KEYCLOAK_MGMT_INVITE_LIFESPAN') / 1000), inviteMinMs: d('KEYCLOAK_MGMT_INVITE_MIN_TIME'), timeoutMs: d('KEYCLOAK_MGMT_TIMEOUT') },
    entra: { clientId: opt('ENTRA_CLIENT_ID'), clientSecret: opt('ENTRA_CLIENT_SECRET'), slots: n('ENTRA_IDP_SLOTS'), timeoutMs: d('ENTRA_TIMEOUT'), uiPath: s('ENTRA_UI_PATH').replace(/\/+$/, '') },
    memberSync: { clientId: opt('KEYCLOAK_SYNC_CLIENT_ID'), privateKey: opt('KEYCLOAK_SYNC_PRIVATE_KEY'), clientSecret: opt('KEYCLOAK_SYNC_CLIENT_SECRET'), intervalMs: d('MEMBER_SYNC_INTERVAL') },
    session: { secrets: list('SESSION_SECRET'), ttlMs: d('SESSION_TTL'), idleMs: d('SESSION_IDLE_TIMEOUT') },
    encryptionKeys: raw.ENCRYPTION_KEYS ? parseEncryptionKeys(raw.ENCRYPTION_KEYS) : [],
    mcp: { publicUrl: s('MCP_PUBLIC_URL').replace(/\/$/, ''), apiUrl: s('MCP_API_URL').replace(/\/$/, ''), clientId: s('MCP_CLIENT_ID'), clientSecret: opt('MCP_CLIENT_SECRET'), privateKey: opt('MCP_PRIVATE_KEY'), dpopKey: opt('MCP_DPOP_KEY'), hostClients: list('MCP_HOST_CLIENT_IDS') },
    ops: { sharedState: s('SHARED_STATE') as IamConfig['ops']['sharedState'], rateLimitNamespace: s('RATE_LIMIT_NAMESPACE').trim() },
  };
}

/** Liest, prüft und typisiert die Konfiguration des IAM; Fehler gesammelt als ConfigError. */
export function loadIamConfig(env: NodeJS.ProcessEnv, o: { product: string; service: Service | null }): IamConfig {
  const { raw, mode, errors } = readVars(env, IAM_VARS(o.product), o.service);
  errors.push(...iamConfigErrors(raw, mode, o.service));
  if (errors.length) throw new ConfigError('Konfiguration ungültig:\n  - ' + errors.join('\n  - '));
  return iamConfig(raw, mode);
}

/**
 * Warnungen beim Start (keine Abbrüche): Client-Geheimnisse statt `private_key_jwt` (Spezifikation P3, nur
 * übergangsweise) und Client-Rollen als Rollenquelle von Personen (Kap. 6.2). Nur für die Clients des Dienstes.
 */
export function iamWarnings(cfg: IamConfig, service: Service | null): string[] {
  const out: string[] = [];
  const needs = (...s: Service[]) => service === null || s.includes(service);
  const secret = (name: string, key: string) => `${name}: Client-Geheimnis statt privatem Schlüssel (${key}, private_key_jwt). Nur übergangsweise (Spezifikation Kap. 3.4, P3).`;
  if (needs('api') && cfg.oidc.bffClientSecret && !cfg.oidc.bffPrivateKey) out.push(secret('OIDC_BFF_CLIENT_SECRET', 'OIDC_BFF_PRIVATE_KEY'));
  if (needs('api') && cfg.mgmt.clientId && cfg.mgmt.clientSecret && !cfg.mgmt.privateKey) out.push(secret('KEYCLOAK_MGMT_CLIENT_SECRET', 'KEYCLOAK_MGMT_PRIVATE_KEY'));
  if (needs('worker') && cfg.memberSync.clientId && cfg.memberSync.clientSecret && !cfg.memberSync.privateKey) out.push(secret('KEYCLOAK_SYNC_CLIENT_SECRET', 'KEYCLOAK_SYNC_PRIVATE_KEY'));
  if (needs('mcp') && cfg.mcp.clientSecret && !cfg.mcp.privateKey) out.push(secret('MCP_CLIENT_SECRET', 'MCP_PRIVATE_KEY'));
  if (cfg.tenancy.roleSource !== 'groups') {
    out.push(`ROLE_SOURCE=${cfg.tenancy.roleSource}: Client-Rollen (${cfg.tenancy.roleClientId}) von Personen gelten nur, wenn das Token genau eine Organisation enthält; `
      + 'Personen in mehreren Organisationen erhalten Rollen nur über Gruppen. Empfohlen: ROLE_SOURCE=groups (Rollen je Organisation über Gruppen).');
  }
  return out;
}
