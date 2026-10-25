/**
 * Anmeldung über Microsoft Entra ID je Organisation (Spezifikation Kap. 9.4).
 *
 * Eine org-admin (oder die Plattform-Administration im Auftrag) verbindet die Organisation selbst mit ihrem Entra-Tenant,
 * in zwei Stufen, damit sich niemand aussperrt:
 * 1. Verbinden (`pending`): Admin-Zustimmung im Tenant → das IAM liest Organisation und verifizierte Domänen (Graph) →
 *    legt in Keycloak einen Identitätsanbieter für genau diesen Tenant an, verbindet ihn mit der Organisation, ordnet die
 *    Domänen zu (ohne Weiterleitung) und verknüpft verknüpfbare Mitglieder über ihre Objekt-ID. Passwörter und Anmeldung
 *    bleiben wie bisher; die Verknüpfung erlaubt nur zusätzlich die Anmeldung über Entra.
 * 2. Testanmeldung: Eine verknüpfte Person der Domänen meldet sich über Entra an (`/auth/login?idp=<alias>`), die
 *    Oberfläche meldet es (`test`).
 * 3. «Nur Entra» aktivieren (`enforced`), erst nach der Testanmeldung und mit bestätigter Liste der Mitglieder, die
 *    nicht verknüpft werden können (sie verlieren die Anmeldung): restliche Mitglieder verknüpfen, Passwörter entfernen,
 *    Weiterleitung der Domänen einschalten. Ab dann prüft auch der Resolver (principal.ts, Claim `identity_provider`).
 *
 * Regeln (Mandantentrennung wie admin.ts, die Organisation kommt aus dem Scope, nie aus der Anfrage):
 * - Nur im Tenant verifizierte Domänen werden Organisations-Domänen. Domänen, die schon eine andere Organisation hat,
 *   werden abgelehnt, ohne die Organisation zu nennen.
 * - Verknüpft wird nur über die Objekt-ID (`oid`), nie über die Adresse aus dem Token (nOAuth); nur Mitglieder des
 *   Tenants, keine Gäste (`notLinkable`). Der Anbieter legt nie selbst Konten an und verknüpft nie selbst (Erstanmeldung:
 *   Ablauf `<produkt>-entra-first-login` des Realm-Moduls verweigert).
 * - Ein Alias je Organisation aus vorab registrierten Plätzen `entra-001` … (ENTRA_IDP_SLOTS): Die Redirect-URI des
 *   Anbieters muss in der Entra-App eingetragen sein, das IAM braucht so keine Schreibrechte in Entra.
 * - Eine org-admin kann sich nicht selbst aussperren: Liegt ihre Adresse in einer gebundenen Domäne, muss ihr Konto
 *   verknüpfbar sein, bevor «Nur Entra» gilt.
 * - Rückkehrpfade der Oberfläche aus ENTRA_UI_PATH (`<pfad>/zustimmung`, `<pfad>/test`, passend zu `paths.entra` in
 *   `@vollholz/iam-web`); der Status nennt beide.
 *
 * Personen vorab hinzufügen: `search` sucht Personen im Tenant der Organisation; hinzufügen, verknüpfen und einladen
 * macht `AdminService.addFromEntra` mit `connectionOf`, `graphFor`, `linkAccount` und `removeFirstFactor`.
 *
 * Eigene App (Kit 0.3, `connectApp`): Statt der App der Plattform trägt die Organisation Tenant,
 * Anwendungs-ID und Geheimnis einer App aus ihrem eigenen Tenant ein – auch ohne ENTRA_CLIENT_ID. Kein Nachweis über
 * eine Admin-Zustimmung: Ein Token der App im Tenant belegt die erteilten Anwendungsberechtigungen, die Registrierung
 * im Tenant (`GET /applications`, nur im Heimat-Tenant der App) belegt, dass die App dem Tenant gehört – nicht einem
 * Hersteller, dem der Tenant nur zugestimmt hat. Dieselbe App meldet in Keycloak an und liest Graph. Der Anbieter heisst
 * `entra-app-<alias>`, damit die Redirect-URI vor dem Verbinden feststeht. Das Geheimnis liegt verschlüsselt in der
 * Datenbank (ENCRYPTION_KEYS, AAD an Mandant und App) und in Keycloak, nie in einer Antwort. Ein Link (`kind:
 * 'credentials'`) lässt die Kunden-IT die App selbst eintragen, ohne Konto und ohne das Geheimnis weiterzugeben.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DOMAIN_RE, entraAddress, type AdminDeps, type AdminService, type Scope, type Work } from './admin.ts';
import type { IamConfig } from './config.ts';
import { box, keyById, NoEncryptionKeyError, primaryKey, unbox, type Keyring } from './crypto.ts';
import { schemaName, withTenant, type Tx } from './db.ts';
import { conflict, HttpError, invalid, notFound } from './errors.ts';
import { EntraError, EntraGraph, GUID_RE, notLinkable, OWN_APP_PERMISSIONS, SEARCH_MIN, type AppPermission, type ConsentApprover, type EntraOrganization, type EntraUser } from './graph.ts';
import type { KcIdp, KcIdpMapper, KcOrg, KcOrgDomain, KcUser } from './keycloak.ts';
import { lockKey } from './locks.ts';
import { asciiLower, type Principal } from './principal.ts';
import { findTenant, listTenants, type TenantRow } from './tenants.ts';

/** Ablauf der Erstanmeldung über den Anbieter: verweigert immer (Realm-Modul, `entra.tf`). */
export const entraFirstLoginFlow = (product: string) => `${product}-entra-first-login`;
/** Gültigkeit einer gestarteten Admin-Zustimmung. */
const CONSENT_TTL_MS = 15 * 60_000;
/** Längste Gültigkeit eines Links an die Entra-Administration. */
const LINK_MAX_MINUTES = 24 * 60;
/** Frist einer laufenden Einlösung (Minuten). */
const LINK_CLAIM_MIN = 5;
/** Höchstens so viele offene Links je Organisation. */
const LINK_MAX_OPEN = 5;
/** Nach dem Verbinden in derselben Transaktion (Einlösung über einen Link; ohne zustimmende Person bei eigener App). */
type OnConnected = (tx: Tx, approver: ConsentApprover | null) => Promise<void>;
/** Ablauf des Geheimnisses einer eigenen App: so viele Tage vorher warnt der Status. */
const SECRET_WARN_DAYS = 30;
const linkGone = () => new HttpError(404, 'Link ungültig', 'Der Link ist abgelaufen, wurde widerrufen oder schon verwendet. Bitte bei der Administration der Organisation einen neuen Link anfordern.');
const LINK_COLS = 'id, kind, entra_tenant_id::text AS entra_tenant_id, tenant_input, platform, created_by::text AS created_by, created_by_subject, created_by_name, created_by_tenant, created_at, expires_at, used_at, revoked_at, approver_name, error_reason, error_detail';
interface LinkRow {
  id: string; kind: LinkKind; entra_tenant_id: string; tenant_input: string; platform: boolean; created_by: string; created_by_subject: string; created_by_name: string; created_by_tenant: string;
  created_at: Date; expires_at: Date; used_at: Date | null; revoked_at: Date | null; approver_name: string | null; error_reason: string | null; error_detail: string | null;
}
/** Art eines Links: `consent` Zustimmung über die App der Plattform, `credentials` Kunden-IT trägt die eigene App ein. */
export type LinkKind = 'consent' | 'credentials';
/** Link an die Entra-Administration für die Liste der Organisation. */
export interface ConsentLinkOut {
  id: string; kind: LinkKind; entraTenantId: string; createdByName: string; createdAt: Date; expiresAt: Date;
  status: 'open' | 'in-progress' | 'expired' | 'revoked' | 'connected' | 'failed'; usedAt: Date | null; approverName: string | null; error: { reason: string; detail: string } | null;
}
/** Nach der Zustimmung braucht Entra einige Sekunden, bis die Rechte gelten. */
const CONSENT_RETRY_MS = [0, 2_000, 4_000, 8_000];
/** Erstfaktoren, die die automatische Weiterleitung zu Entra verhindern (Keycloak: OrganizationAuthenticator). */
const FIRST_FACTORS = new Set(['password', 'webauthn-passwordless']);

/** Pfad der Oberfläche, auf den Microsoft nach der Admin-Zustimmung zurückleitet (in der Entra-App eingetragen). */
export const consentPath = (cfg: Pick<IamConfig, 'entra'>) => `${cfg.entra.uiPath}/zustimmung`;
export const consentRedirectUri = (cfg: Pick<IamConfig, 'entra' | 'publicBaseUrl'>) => `${cfg.publicBaseUrl}${consentPath(cfg)}`;
/** Pfad der Oberfläche, auf den die Testanmeldung zurückführt. */
export const testPath = (cfg: Pick<IamConfig, 'entra'>) => `${cfg.entra.uiPath}/test`;
/** Öffentliche Seite für den Link an die Entra-Administration (Token im Fragment). */
export const handoverPath = (cfg: Pick<IamConfig, 'entra'>) => `${cfg.entra.uiPath}/freigabe`;
/** Alias des n-ten Platzes. */
export const slotAlias = (n: number) => `entra-${String(n).padStart(3, '0')}`;
/** Redirect-URIs aller Plätze (Broker-Endpunkt von Keycloak) – in der Entra-App einzutragen. */
export function brokerRedirectUris(cfg: Pick<IamConfig, 'oidc' | 'entra'>): string[] {
  return Array.from({ length: cfg.entra.slots }, (_, i) => brokerRedirectUri(cfg, slotAlias(i + 1)));
}
/** Redirect-URI eines Anbieters (Broker-Endpunkt von Keycloak). */
export const brokerRedirectUri = (cfg: Pick<IamConfig, 'oidc'>, alias: string) => `${cfg.oidc.issuer}/broker/${alias}/endpoint`;
/** Alias des Anbieters einer Verbindung mit eigener App: fest je Organisation (kanonischer Alias), kein Platz. */
export const ownAppAlias = (org: string) => `entra-app-${asciiLower(org)}`;

// ---------------------------------------------------------------- Geheimnis der eigenen App (ENCRYPTION_KEYS)
const secretAad = (tenantId: string, clientId: string) => `entra_connection:${tenantId}:${clientId.toLowerCase()}`;
const b64u = (b: Buffer) => b.toString('base64url');
const noKeys = () => new HttpError(503, 'Verschlüsselung nicht eingerichtet', 'ENCRYPTION_KEYS ist nicht gesetzt; das Geheimnis einer eigenen App lässt sich nicht speichern.', {}, { reason: 'encryption-missing' });
/** `v1.<keyId>.<iv>.<tag>.<ct>` (AES-256-GCM), AAD an Mandant und Anwendungs-ID gebunden: umkopiert nicht entschlüsselbar. */
export function encryptAppSecret(keys: Keyring, tenantId: string, clientId: string, plain: string): string {
  let k;
  try { k = primaryKey(keys); } catch (e) { if (e instanceof NoEncryptionKeyError) throw noKeys(); throw e; }
  const b = box(k.key, plain, secretAad(tenantId, clientId));
  return ['v1', k.id, b64u(b.subarray(0, 12)), b64u(b.subarray(12, 28)), b64u(b.subarray(28))].join('.');
}
export function decryptAppSecret(keys: Keyring, tenantId: string, clientId: string, enc: string): string {
  const [v, id, iv, tag, ct] = enc.split('.');
  if (v !== 'v1' || !id || !iv || !tag || ct === undefined) throw new Error('Geheimnis der App: unbekanntes Format');
  return unbox(keyById(keys, id).key, Buffer.concat([Buffer.from(iv, 'base64url'), Buffer.from(tag, 'base64url'), Buffer.from(ct, 'base64url')]), secretAad(tenantId, clientId)).toString('utf8');
}
/**
 * Rotation der Hauptschlüssel (Betriebsskript der App, `ops:rotate-keys`): Geheimnisse eigener Apps im Mandantenkontext
 * `tx` auf den ersten Schlüssel umstellen. Gibt die Anzahl betroffener Verbindungen zurück (mit `dryRun` ohne Änderung).
 */
export async function rewrapEntraSecrets(tx: Tx, keys: Keyring, o: { schema: string; dryRun?: boolean }): Promise<number> {
  const S = schemaName(o.schema), primary = primaryKey(keys);
  // Ohne Mandantenkontext sähe die Abfrage (FORCE RLS) nichts und meldete still 0: der alte Schlüssel wäre scheinbar frei
  if (!(await tx.query<{ t: string | null }>('SELECT app.tenant_id() AS t')).rows[0]?.t) throw new Error('rewrapEntraSecrets: Mandantenkontext fehlt (withTenant je Mandant)');
  const rows = (await tx.query<{ tenant_id: string; app_client_id: string; app_secret_enc: string }>(
    `SELECT tenant_id::text, app_client_id::text, app_secret_enc FROM ${S}.entra_connection WHERE app_secret_enc IS NOT NULL AND split_part(app_secret_enc, '.', 2) <> $1 FOR UPDATE`, [primary.id])).rows;
  if (!o.dryRun) {
    for (const r of rows) {
      await tx.query(`UPDATE ${S}.entra_connection SET app_secret_enc = $1 WHERE tenant_id = $2`,
        [encryptAppSecret(keys, r.tenant_id, r.app_client_id, decryptAppSecret(keys, r.tenant_id, r.app_client_id, r.app_secret_enc)), r.tenant_id]);
    }
  }
  return rows.length;
}

/** Gespeicherte Verbindung (`entra_connection`). */
export interface EntraConnection {
  /** Mandant (AAD des Geheimnisses). */
  tenantId: string;
  /** Eigene App der Organisation; null = App der Plattform. */
  appClientId: string | null; appSecretEnc: string | null; appSecretExpiresAt: Date | null;
  entraTenantId: string; entraName: string; idpAlias: string; domains: string[]; tenantDomains: string[]; kcDomainsAdded: string[];
  stage: 'pending' | 'enforced'; testedAt: Date | null; testedByName: string | null; enforcedAt: Date | null; enforcedByName: string | null;
  status: 'active' | 'error'; lastError: string | null; connectedAt: Date; connectedByName: string; refreshedAt: Date;
}
const COLS = `tenant_id::text AS "tenantId", app_client_id::text AS "appClientId", app_secret_enc AS "appSecretEnc", app_secret_expires_at AS "appSecretExpiresAt",
  entra_tenant_id::text AS "entraTenantId", entra_name AS "entraName", idp_alias AS "idpAlias", domains, tenant_domains AS "tenantDomains",
  kc_domains_added AS "kcDomainsAdded", stage, tested_at AS "testedAt", tested_by_name AS "testedByName", enforced_at AS "enforcedAt", enforced_by_name AS "enforcedByName",
  status, last_error AS "lastError", connected_at AS "connectedAt", connected_by_name AS "connectedByName", refreshed_at AS "refreshedAt"`;

/** Verbindung nach aussen (ohne interne Felder). */
export interface EntraConnectionOut {
  entraTenantId: string; entraName: string; domains: string[]; availableDomains: string[];
  /** `own`: eigene App der Organisation (`clientId`), `platform`: App der Plattform. */
  method: 'platform' | 'own'; clientId: string | null;
  /** Ablauf des Geheimnisses der eigenen App, wenn bekannt; `secretExpiresSoon`: in höchstens 30 Tagen oder schon abgelaufen. */
  secretExpiresAt: Date | null; secretExpiresSoon: boolean;
  /** Redirect-URI des Anbieters (bei eigener App in der App eingetragen, Plattform «Web»). */
  redirectUri: string;
  stage: 'pending' | 'enforced'; testedAt: Date | null; testedBy: string | null; enforcedAt: Date | null; enforcedBy: string | null;
  /** Testanmeldung über diesen Anbieter (Navigation im Browser, auch als Link für andere Personen der Domänen). */
  testLoginPath: string;
  status: 'active' | 'error'; lastError: string | null; connectedAt: Date; connectedBy: string; refreshedAt: Date;
}
/**
 * Status für die Oberfläche. `consentPath`, `testPath`: Rückkehrpfade aus ENTRA_UI_PATH (müssen zu `paths.entra` der
 * Oberfläche und zur Redirect-URI der Entra-App passen).
 */
export interface EntraStatus {
  /** App der Plattform eingerichtet (ENTRA_CLIENT_ID); ohne sie geht nur die eigene App. */
  enabled: boolean; reason: string | null; consentPath: string; testPath: string;
  /** Angebotene Wege: `ownApp` eigene App (braucht ENCRYPTION_KEYS), `platformApp` Zustimmung über ENTRA_CLIENT_ID. */
  methods: { platformApp: boolean; ownApp: boolean };
  /** Warum die eigene App nicht geht (sonst null). */
  ownAppReason: string | null;
  /** Anleitung für die eigene App (null, wenn sie nicht geht): Redirect-URI dieser Organisation, Berechtigungen. */
  ownApp: OwnAppGuide | null;
  connection: EntraConnectionOut | null;
}
/** Anleitung für die App-Registrierung beim Kunden (Status und öffentliche Seite des Links). */
export interface OwnAppGuide { redirectUri: string; permissions: AppPermission[] }

/** Mitglied einer gebundenen Domäne: verknüpft (bzw. verknüpfbar) oder nicht (mit Grund). */
export interface BindResult { email: string; name: string; linked: boolean; reason: string | null; passwordKept?: string }
export interface ConnectResult { connection: EntraConnectionOut; members: BindResult[]; rejectedDomains: string[] }
/**
 * Treffer der Personensuche: nur, was die Auswahl braucht. `selectable` false mit Grund: nicht verknüpfbar
 * (`notLinkable`) oder schon Mitglied bzw. eingeladen in dieser Organisation – nie etwas über andere Organisationen.
 */
export interface EntraCandidate {
  id: string; name: string; email: string; userPrincipalName: string; department: string | null; jobTitle: string | null;
  selectable: boolean; reason: string | null;
}

const OFF = 'Die App der Plattform für Microsoft Entra ID ist nicht eingerichtet (ENTRA_CLIENT_ID). Verbinden geht mit einer eigenen App im Tenant der Organisation.';
const domainOf = (email: string | null | undefined) => (email && email.includes('@') ? email.slice(email.lastIndexOf('@') + 1).toLowerCase() : null);
const nameOf = (u: KcUser) => [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.username;
const hash = (state: string) => createHash('sha256').update(state).digest('hex');
const wrongKind = () => conflict('Dieser Link ist für einen anderen Weg erzeugt worden. Bitte die Seite des Links neu laden.', { reason: 'link-kind' });
const ownAppConnected = () => conflict('Die Organisation ist mit einer eigenen App verbunden. Für die App der Plattform zuerst trennen.', { reason: 'own-app' });
const tenantNotFound = () => invalid('Tenant nicht gefunden', [{ path: '/tenant', message: 'Tenant-ID (GUID) oder eine Domäne des Tenants angeben, z. B. contoso.onmicrosoft.com' }]);

/** Identitätsanbieter für einen Tenant: Keycloak-Anbieter «microsoft» (Prinzipal = Objekt-ID aus Graph `/me`). */
export function idpRepresentation(alias: string, entraTenantId: string, cfg: { clientId: string | null; clientSecret: string | null }, product: string): KcIdp {
  return {
    alias, displayName: 'Microsoft', providerId: 'microsoft', enabled: true,
    // Adresse aus Entra nie als bestätigt übernehmen, kein Token speichern, nur Anmeldung (Knopf auf der Anmeldeseite verborgen:
    // Keycloak leitet über die Domäne der Organisation weiter)
    trustEmail: false, storeToken: false, linkOnly: false, hideOnLogin: true, addReadTokenRoleOnCreate: false,
    firstBrokerLoginFlowAlias: entraFirstLoginFlow(product),
    config: {
      clientId: cfg.clientId!, clientSecret: cfg.clientSecret!, clientAuthMethod: 'client_secret_post',
      // Anmeldung nur am Endpunkt dieses Tenants: Tokens stellt Entra nur für Konten dieses Tenants aus
      tenantId: entraTenantId, syncMode: 'IMPORT', pkceEnabled: 'true', pkceMethod: 'S256', loginHint: 'true',
      guiOrder: '', hideOnLogin: 'true',
    },
  };
}

/**
 * Mapper `entra-groups` an jedem Entra-Anbieter (Kap. 3.5, 9.4; O3): Claim `groups` des Entra-Tokens (Objekt-IDs) →
 * Benutzerattribut `entra_groups`, Sync-Modus FORCE; der Client-Mapper des Realm-Moduls gibt es als Claim `groups` aus.
 */
export function entraGroupsMapper(alias: string): KcIdpMapper {
  return {
    name: ENTRA_GROUPS_MAPPER, identityProviderAlias: alias, identityProviderMapper: 'oidc-user-attribute-idp-mapper',
    config: { syncMode: 'FORCE', claim: 'groups', 'user.attribute': 'entra_groups' },
  };
}
export const ENTRA_GROUPS_MAPPER = 'entra-groups';

export class EntraService {
  private readonly deps: AdminDeps;
  /** Schema der Tabellen (geprüft). */
  private readonly S: string;
  private readonly admin: AdminService;
  /** App der Plattform; null: nicht eingerichtet (ENTRA_CLIENT_ID fehlt), dann nur eigene Apps. */
  readonly graph: EntraGraph | null;
  private readonly retryMs: number[];
  private readonly fetchImpl: typeof fetch | undefined;
  /** Tenant suchen (OpenID-Konfiguration, ohne Anmeldung): geht auch ohne App der Plattform. */
  private readonly directory: EntraGraph;
  /** Zugänge eigener Apps (Token-Zwischenspeicher je App), Schlüssel Anwendungs-ID und Hash des Geheimnisses. */
  private readonly ownGraphs = new Map<string, EntraGraph>();

  constructor(deps: AdminDeps, admin: AdminService, graph: EntraGraph | null, o: { retryMs?: number[]; fetch?: typeof fetch } = {}) {
    this.deps = deps; this.admin = admin; this.graph = graph; this.retryMs = o.retryMs ?? CONSENT_RETRY_MS; this.fetchImpl = o.fetch;
    this.S = schemaName(deps.schema);
    this.directory = new EntraGraph({ clientId: '', clientSecret: '', timeoutMs: deps.cfg.entra.timeoutMs }, o.fetch);
  }

  /** App der Plattform (Zustimmung, Links mit Zustimmung); ohne sie 409 `platform-app-disabled`. */
  private platformApp(): EntraGraph {
    if (!this.graph) throw new HttpError(409, 'App der Plattform nicht eingerichtet', OFF, {}, { reason: 'platform-app-disabled' });
    return this.graph;
  }
  private get kc() { return this.admin.kc; }

  private ownGraph(clientId: string, clientSecret: string): EntraGraph {
    const key = `${clientId}:${hash(clientSecret)}`;
    let g = this.ownGraphs.get(key);
    if (!g) {
      if (this.ownGraphs.size > 500) this.ownGraphs.clear();
      g = new EntraGraph({ clientId, clientSecret, timeoutMs: this.deps.cfg.entra.timeoutMs, own: true }, this.fetchImpl);
      this.ownGraphs.set(key, g);
    }
    return g;
  }

  /** App einer Verbindung: Anwendungs-ID und Geheimnis (eigene App entschlüsselt, sonst die der Plattform). */
  private appOf(c: Pick<EntraConnection, 'tenantId' | 'appClientId' | 'appSecretEnc'>): { clientId: string | null; clientSecret: string | null } {
    if (!c.appClientId || !c.appSecretEnc) return { clientId: this.deps.cfg.entra.clientId, clientSecret: this.deps.cfg.entra.clientSecret };
    return { clientId: c.appClientId, clientSecret: decryptAppSecret(this.deps.cfg.encryptionKeys, c.tenantId, c.appClientId, c.appSecretEnc) };
  }

  /** Zugang zu Graph für eine Verbindung (auch für `addFromEntra`): eigene App oder die der Plattform. */
  graphFor(c: Pick<EntraConnection, 'tenantId' | 'appClientId' | 'appSecretEnc'>): EntraGraph {
    if (!c.appClientId) return this.platformApp();
    const a = this.appOf(c);
    return this.ownGraph(a.clientId!, a.clientSecret!);
  }

  /** Mapper `entra-groups` anlegen bzw. auf das Soll bringen (idempotent); andere Mapper legt die App nicht an. */
  private async ensureGroupsMapper(w: Pick<Work, 'done'>, alias: string): Promise<void> {
    const want = entraGroupsMapper(alias);
    const have = (await this.kc.idpMappers(alias)).find(m => m.name === ENTRA_GROUPS_MAPPER);
    if (!have) { await this.kc.createIdpMapper(alias, want); w.done({ step: 'mapper_created' }); return; }
    const same = have.identityProviderMapper === want.identityProviderMapper && Object.entries(want.config).every(([k, v]) => have.config?.[k] === v);
    if (!same) { await this.kc.updateIdpMapper(alias, { ...want, id: have.id! }); w.done({ step: 'idp_updated' }); }
  }

  /** Anleitung für eine eigene App dieser Organisation (bestehende Verbindung behält ihren Anbieter). */
  private guide(orgAlias: string, idpAlias?: string): OwnAppGuide {
    return { redirectUri: brokerRedirectUri(this.deps.cfg, idpAlias ?? ownAppAlias(orgAlias)), permissions: OWN_APP_PERMISSIONS.map(p => ({ ...p })) };
  }

  // ---------------------------------------------------------------- Lesen
  /** Verbindung der Organisation des Mandantenkontexts (auch für `addFromEntra`). */
  async connectionOf(tx: Tx): Promise<EntraConnection | null> {
    return (await tx.query<EntraConnection>(`SELECT ${COLS} FROM ${this.S}.entra_connection`)).rows[0] ?? null;
  }

  /** Hat die Organisation eine Entra-Verbindung? (`/auth/me` › `tenant.entraConnected`, Gruppen als Subjekte) */
  async connected(tenantId: string): Promise<boolean> {
    return !!(await withTenant(this.deps.db, { tenantId }, tx => this.connectionOf(tx)));
  }

  /** Namen der Gruppen je Mandant (Objekt-IDs sind eindeutig, eine Verbindung je Organisation), 1 h. */
  private readonly groupCache = new Map<string, Map<string, { name: string; at: number }>>();
  private rememberGroups(tenantId: string, groups: { id: string; name: string }[]) {
    let m = this.groupCache.get(tenantId);
    if (!m) { m = new Map(); this.groupCache.set(tenantId, m); }
    for (const g of groups) m.set(g.id, { name: g.name, at: Date.now() });
  }

  /** Verbindung oder 409 `entra-not-connected`. */
  private async requireConnection(tenantId: string): Promise<EntraConnection> {
    const c = await withTenant(this.deps.db, { tenantId }, tx => this.connectionOf(tx));
    if (!c) throw conflict('Die Organisation ist nicht mit Microsoft Entra ID verbunden.', { reason: 'entra-not-connected' });
    return c;
  }

  /** Gruppen aus Entra suchen (A4, Kap. 9.5); `name` = Anzeigename, sonst Objekt-ID. */
  async searchGroups(tenantId: string, q: string): Promise<{ id: string; name: string }[]> {
    const c = await this.requireConnection(tenantId);
    const out = (await this.graphFor(c).searchGroups(c.entraTenantId, q)).map(g => ({ id: g.id, name: g.displayName ?? g.id }));
    this.rememberGroups(tenantId, out);
    return out;
  }

  /** Gruppen nach Objekt-ID auflösen (bis 100); unbekannte fehlen in der Antwort. */
  async groupsByIds(tenantId: string, ids: string[]): Promise<{ id: string; name: string }[]> {
    const c = await this.requireConnection(tenantId);
    const g = this.graphFor(c);
    const out: { id: string; name: string }[] = [];
    for (const id of ids.slice(0, 100)) {
      const x = await g.group(c.entraTenantId, id);
      if (x) out.push({ id: x.id, name: x.displayName ?? x.id });
    }
    this.rememberGroups(tenantId, out);
    return out;
  }

  /**
   * Namen für Subjekte `group:<id>` («Wer hat Zugriff?», «Warum?»): aus dem Zwischenspeicher, fehlende über Graph;
   * ohne Verbindung oder bei Fehlern bleibt die Objekt-ID (Aufrufer).
   */
  async groupNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const cache = this.groupCache.get(tenantId), out = new Map<string, string>(), missing: string[] = [];
    for (const id of ids) {
      const hit = cache?.get(id);
      if (hit && Date.now() - hit.at < 3_600_000) out.set(id, hit.name); else missing.push(id);
    }
    if (missing.length && await this.connected(tenantId)) {
      for (const g of await this.groupsByIds(tenantId, missing).catch(() => [])) out.set(g.id, g.name);
    }
    return out;
  }

  /** @param alias Organisation der Verbindung: die Testanmeldung wählt sie vor (Personen in mehreren Organisationen). */
  private out(c: EntraConnection, alias: string): EntraConnectionOut {
    return {
      entraTenantId: c.entraTenantId, entraName: c.entraName, domains: c.domains, availableDomains: c.tenantDomains.filter(d => !c.domains.includes(d)),
      method: c.appClientId ? 'own' : 'platform', clientId: c.appClientId, secretExpiresAt: c.appSecretExpiresAt,
      secretExpiresSoon: !!c.appSecretExpiresAt && c.appSecretExpiresAt.getTime() - Date.now() < SECRET_WARN_DAYS * 86_400_000,
      redirectUri: brokerRedirectUri(this.deps.cfg, c.idpAlias),
      stage: c.stage, testedAt: c.testedAt, testedBy: c.testedByName, enforcedAt: c.enforcedAt, enforcedBy: c.enforcedByName,
      testLoginPath: `/auth/login?idp=${c.idpAlias}&org=${encodeURIComponent(alias)}&returnTo=${encodeURIComponent(testPath(this.deps.cfg))}`,
      status: c.status, lastError: c.lastError, connectedAt: c.connectedAt, connectedBy: c.connectedByName, refreshedAt: c.refreshedAt,
    };
  }

  private async ctx(s: Scope) {
    const org = await this.admin.org(s.alias);
    return { org, tenantId: await this.admin.tenantFor(s, org) };
  }

  async status(s: Scope): Promise<EntraStatus> {
    const { org, tenantId } = await this.ctx(s);
    const c = await withTenant(this.deps.db, { tenantId }, tx => this.connectionOf(tx));
    const keys = this.deps.cfg.encryptionKeys.length > 0;
    return {
      enabled: !!this.graph, reason: this.graph ? null : OFF, consentPath: consentPath(this.deps.cfg), testPath: testPath(this.deps.cfg),
      methods: { platformApp: !!this.graph, ownApp: keys },
      ownAppReason: keys ? null : 'ENCRYPTION_KEYS ist nicht gesetzt; das Geheimnis einer eigenen App lässt sich nicht speichern.',
      ownApp: keys ? this.guide(org.alias, c?.idpAlias) : null,
      connection: c ? this.out(c, org.alias) : null,
    };
  }

  // ---------------------------------------------------------------- Personen suchen
  /**
   * Personen im Tenant der eigenen Organisation suchen (Graph `$search` über Name, mail und UPN). Wählbar ist nur, wer
   * verknüpfbar ist und noch nicht Mitglied oder eingeladen ist – geprüft an der Adresse und an der Verknüpfung über die
   * Objekt-ID, beides nur in dieser Organisation. Ob für eine Person anderswo ein Konto besteht, prüft die Suche nicht.
   */
  async search(s: Scope, query: string): Promise<{ items: EntraCandidate[]; more: boolean }> {
    const q = query.trim();
    if (q.replace(/["\\]/g, '').trim().length < SEARCH_MIN) throw invalid('Suchbegriff zu kurz', [{ path: '/q', message: `Mindestens ${SEARCH_MIN} Zeichen` }]);
    const { org, tenantId } = await this.ctx(s);
    const { c, open } = await withTenant(this.deps.db, { tenantId }, async tx => ({
      c: await this.connectionOf(tx),
      open: (await tx.query<{ email: string; user_id: string }>(`SELECT lower(email) AS email, user_id FROM ${this.S}.member_invitation WHERE accepted_at IS NULL`)).rows,
    }));
    if (!c) throw conflict('Die Organisation ist nicht mit Microsoft Entra ID verbunden.', { reason: 'entra-not-connected' });
    const r = await this.graphFor(c).searchUsers(c.entraTenantId, q);
    const members = await this.kc.members(org.id);
    const memberMails = new Set(members.map(u => u.email?.toLowerCase()).filter(Boolean)), memberIds = new Set(members.map(u => u.id));
    const openMails = new Set(open.map(o => o.email)), openIds = new Set(open.map(o => o.user_id));
    const items: EntraCandidate[] = [];
    for (const u of r.users) {
      const email = entraAddress(u, c.domains);
      let reason = notLinkable(u, c.domains);
      if (!reason) {
        if (openMails.has(email)) reason = 'Bereits eingeladen';
        else if (memberMails.has(email)) reason = 'Bereits Mitglied';
        else {
          const l = await this.kc.userByIdentity(c.idpAlias, u.id);
          if (l) reason = openIds.has(l.id) ? 'Bereits eingeladen' : memberIds.has(l.id) ? 'Bereits Mitglied' : 'Bereits mit einem anderen Konto verknüpft';
        }
      }
      items.push({
        id: u.id, name: u.displayName?.trim() || [u.givenName, u.surname].filter(Boolean).join(' ') || email, email, userPrincipalName: u.userPrincipalName,
        department: u.department ?? null, jobTitle: u.jobTitle ?? null, selectable: !reason, reason,
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name, 'de-CH'));
    return { items, more: r.more };
  }

  // ---------------------------------------------------------------- Admin-Zustimmung
  /**
   * Startet die Admin-Zustimmung: Tenant über Tenant-ID oder Domäne suchen, `state` speichern (nur als Hash, an Person,
   * Organisation und Tenant gebunden), Adresse für die Navigation zurückgeben (Code-Flow mit PKCE und `nonce` aus `state`). `state` trägt vorne `o.`/`p.` und den
   * Alias, damit die Oberfläche nach der Rückkehr den richtigen Endpunkt wählt; geprüft wird nur gegen die Datenbank.
   */
  async startConsent(s: Scope, input: { tenant: string }): Promise<{ url: string; entraTenantId: string }> {
    const g = this.platformApp();
    const org = await this.admin.org(s.alias);
    if (!org.enabled) throw conflict('Die Organisation ist gesperrt.');
    const tid = await g.resolveTenant(input.tenant);
    if (!tid) throw invalid('Tenant nicht gefunden', [{ path: '/tenant', message: 'Tenant-ID (GUID) oder eine Domäne des Tenants angeben, z. B. contoso.onmicrosoft.com' }]);
    const state = `${s.platform ? 'p' : 'o'}.${asciiLower(org.alias)}.${randomBytes(32).toString('base64url')}`;
    const tenantId = await this.admin.tenantFor(s, org);
    await withTenant(this.deps.db, { tenantId }, async tx => {
      const existing = await this.connectionOf(tx);
      if (existing && existing.entraTenantId !== tid) throw conflict('Die Organisation ist bereits mit einem anderen Entra-Tenant verbunden. Zuerst trennen.', { reason: 'tenant-mismatch' });
      // Redirect-URI `entra-app-…` steht nicht in der App der Plattform: Wechsel nur über Trennen
      if (existing?.appClientId) throw ownAppConnected();
      await tx.query(`DELETE FROM ${this.S}.entra_consent WHERE expires_at < now()`);
      await tx.query(`INSERT INTO ${this.S}.entra_consent (tenant_id, state_hash, entra_tenant_id, subject, platform, expires_at)
        VALUES (app.tenant_id(), $1, $2, $3, $4, now() + make_interval(secs => $5))`, [hash(state), tid, s.actor.subject, s.platform, CONSENT_TTL_MS / 1000]);
      await this.admin.write(tx, this.admin.actorOf(s), { action: 'entra.consent_started', resourceType: 'tenant', resourceId: tenantId, data: { entraTenantId: tid } });
    });
    const proof = this.consentProof(state);
    return { url: g.consentUrl(tid, { state, redirectUri: consentRedirectUri(this.deps.cfg), nonce: proof.nonce, codeChallenge: createHash('sha256').update(proof.verifier).digest('base64url') }), entraTenantId: tid };
  }

  /**
   * Rückkehr von der Zustimmung (Parameter wie von Microsoft: `code`, `state` bzw. `error`). `state` muss zu dieser
   * Organisation, dieser Person und demselben Weg (eigene Organisation bzw. Plattform) passen und ist nur einmal gültig.
   * Nachweis über den Code: ID-Token einer Administration des gestarteten Tenants (`EntraGraph.verifyConsent`); ein Tenant,
   * der schon früher zugestimmt hat, genügt nie. Danach liest die Plattform die Organisation im Tenant selbst.
   */
  async completeConsent(s: Scope, p: { state: string; code?: string; error?: string; errorDescription?: string }): Promise<ConnectResult> {
    this.platformApp();
    const { org, tenantId } = await this.ctx(s);
    const gone = () => new HttpError(404, 'Zustimmung nicht gefunden', 'Die Zustimmung ist abgelaufen, wurde schon verwendet oder gehört nicht zu dieser Organisation. Bitte neu verbinden.');
    if (p.state.split('.')[1] !== asciiLower(org.alias)) throw gone();
    const row = await withTenant(this.deps.db, { tenantId }, async tx => (await tx.query<{ tid: string }>(
      `UPDATE ${this.S}.entra_consent SET used_at = now() WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now() AND subject = $2 AND platform = $3
       RETURNING entra_tenant_id::text AS tid`, [hash(p.state), s.actor.subject, s.platform])).rows[0]);
    if (!row) throw gone();
    try { return (await this.proveAndConnect(s, org, row.tid, p)).result; } catch (e) {
      // Abgelehnt, nicht nachgewiesen oder Fehler bei Microsoft: im Protokoll der Organisation (der state ist verbraucht)
      if (e instanceof HttpError && e.status === 409 && ['consent-error', 'consent-unproven'].includes(String(e.extra.reason))) {
        await withTenant(this.deps.db, { tenantId }, tx => this.admin.write(tx, this.admin.actorOf(s), {
          action: 'entra.consent_failed', resourceType: 'tenant', resourceId: tenantId, data: { entraTenantId: row.tid, reason: e.extra.reason, detail: e.detail ?? null },
        })).catch(() => undefined);
      }
      throw e;
    }
  }

  private async proveAndConnect(s: Scope, org: KcOrg, tid: string, p: { state: string; code?: string; error?: string; errorDescription?: string }, audit: Record<string, unknown> = {}, onConnected?: OnConnected): Promise<{ result: ConnectResult; approver: ConsentApprover }> {
    const g = this.platformApp();
    const row = { tid };
    if (p.error) {
      // Gründe von Microsoft nur als Code (die Beschreibung kann Interna des Tenants enthalten)
      const code = /AADSTS\d+/.exec(p.errorDescription ?? '')?.[0] ?? p.error.slice(0, 64);
      throw new HttpError(409, 'Zustimmung nicht erteilt', p.error === 'access_denied'
        ? `Die Zustimmung wurde abgelehnt oder abgebrochen (${code}). Die Zustimmung braucht eine globale Administration oder die Rolle «Privileged Role Administrator» im Tenant.`
        : `Microsoft meldet einen Fehler (${code}).`, {}, { reason: 'consent-error', code });
    }
    // Nachweis: Code der Anmeldung im gestarteten Tenant, ID-Token einer Administration (nicht nur «irgendwann zugestimmt»,
    // das Client-Credentials-Token allein bewiese nichts über die handelnde Person)
    if (!p.code) throw new HttpError(409, 'Zustimmung nicht nachgewiesen', 'Die Rückkehr von Microsoft enthält keinen Code. Bitte neu verbinden.', {}, { reason: 'consent-unproven' });
    const proof = this.consentProof(p.state);
    const approver = await g.verifyConsent(row.tid, { code: p.code, redirectUri: consentRedirectUri(this.deps.cfg), codeVerifier: proof.verifier, nonce: proof.nonce });
    let eo: EntraOrganization | null = null;
    for (const wait of this.retryMs) {
      if (wait) await sleep(wait);
      try { eo = await g.organization(row.tid, true); break; } catch (e) {
        // Rechte gelten erst nach einigen Sekunden; andere Fehler sofort melden
        if (!(e instanceof EntraError) || e.status !== 409 || wait === this.retryMs.at(-1)) throw e;
      }
    }
    return { result: await this.connect(s, org, eo!, { g, own: null }, approver, audit, onConnected), approver };
  }

  /**
   * PKCE-Verifier und `nonce` der Zustimmung, aus `state` abgeleitet (HMAC mit ENTRA_CLIENT_SECRET): an den gespeicherten
   * state gebunden, ohne ihn im Klartext zu speichern; wer nur `state` kennt (er steht in der Adresse), kennt sie nicht.
   */
  private consentProof(state: string): { verifier: string; nonce: string } {
    const mac = (label: string) => createHmac('sha256', this.deps.cfg.entra.clientSecret ?? '').update(`${label}\0${state}`).digest('base64url');
    return { verifier: mac('pkce'), nonce: mac('nonce') };
  }

  // ---------------------------------------------------------------- Eigene App
  /**
   * Verbinden mit einer eigenen App der Organisation (auch ohne App der Plattform) bzw. Anwendungs-ID oder Geheimnis einer
   * bestehenden Verbindung wechseln (gleicher Tenant; Stufe und Domänen bleiben). Prüfung bei Microsoft vor dem Speichern
   * (`EntraGraph.checkApp`): Token der App im Tenant (Anwendungs-ID und Geheimnis gehören zu einer App genau dieses
   * Tenants), erteilte Anwendungsberechtigungen, Organisation; Ablauf des Geheimnisses, wenn die App ihn lesen darf, sonst
   * `secretExpiresAt` der Eingabe. Danach wie nach der Zustimmung: Anbieter, Domänen, Verknüpfung.
   * `o.tid`: Tenant fest vorgegeben (Link); `o.audit`, `o.onConnected` wie bei der Zustimmung über einen Link.
   */
  async connectApp(s: Scope, input: { tenant?: string; clientId: string; clientSecret: string; secretExpiresAt?: string | null },
    o: { tid?: string; audit?: Record<string, unknown>; onConnected?: OnConnected } = {}): Promise<ConnectResult> {
    const clientId = input.clientId.trim().toLowerCase(), secret = input.clientSecret.trim();
    if (!GUID_RE.test(clientId)) throw invalid('Anwendungs-ID ungültig', [{ path: '/clientId', message: 'Anwendungs-ID (Client-ID) der App, eine GUID' }]);
    if (!secret) throw invalid('Geheimnis fehlt', [{ path: '/clientSecret', message: 'Wert des geheimen Clientschlüssels' }]);
    let manual: Date | null = null;
    if (input.secretExpiresAt) {
      manual = new Date(input.secretExpiresAt);
      if (Number.isNaN(manual.getTime())) throw invalid('Ablauf ungültig', [{ path: '/secretExpiresAt', message: 'Datum (ISO 8601)' }]);
    }
    if (!this.deps.cfg.encryptionKeys.length) throw noKeys();
    const org = await this.admin.org(s.alias);
    if (!org.enabled) throw conflict('Die Organisation ist gesperrt.');
    const tid = o.tid ?? await this.directory.resolveTenant(input.tenant ?? '');
    if (!tid) throw tenantNotFound();
    const g = this.ownGraph(clientId, secret);
    const check = await g.checkApp(tid);
    return this.connect(s, org, check.organization, { g, own: { clientId, clientSecret: secret, expiresAt: check.secretExpiresAt ?? manual } }, null, o.audit ?? {}, o.onConnected);
  }

  // ---------------------------------------------------------------- Link an die Entra-Administration
  /**
   * Link für eine andere Person der Kunden-IT, die bei Microsoft zustimmen darf (Entra-Administration), ohne Sitzung in
   * der App. Gleiche Prüfungen wie beim Start der Zustimmung; der Link ist an Organisation, Mandant und den verlangten
   * Entra-Tenant gebunden, einmal einlösbar, widerrufbar und läuft ab (Standard 15 Minuten, höchstens 24 Stunden). Das
   * Token steht im Fragment der Adresse (`<ENTRA_UI_PATH>/freigabe#<token>`, nie in Logs oder im Referer) und wird nur als
   * SHA-256 gespeichert; vorne steht der Alias, damit die Einlösung den Mandanten findet.
   */
  async createConsentLink(s: Scope, input: { tenant: string; validMinutes?: number; kind?: LinkKind }): Promise<{ id: string; kind: LinkKind; url: string; entraTenantId: string; expiresAt: Date }> {
    const kind = input.kind ?? (this.graph ? 'consent' : 'credentials');
    if (kind === 'consent') this.platformApp();
    else if (!this.deps.cfg.encryptionKeys.length) throw noKeys();
    const org = await this.admin.org(s.alias);
    if (!org.enabled) throw conflict('Die Organisation ist gesperrt.');
    const minutes = input.validMinutes ?? CONSENT_TTL_MS / 60_000;
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > LINK_MAX_MINUTES) throw invalid('Gültigkeit ungültig', [{ path: '/validMinutes', message: `5 bis ${LINK_MAX_MINUTES} Minuten` }]);
    const tid = await this.directory.resolveTenant(input.tenant);
    if (!tid) throw tenantNotFound();
    // Kanonischer Alias (klein, wie der Mandant): Keycloak kann ihn mit Grossbuchstaben führen, das Token-Muster nicht
    const token = `${asciiLower(org.alias)}.${randomBytes(32).toString('base64url')}`;
    const tenantId = await this.admin.tenantFor(s, org);
    const row = await withTenant(this.deps.db, { tenantId }, async tx => {
      const existing = await this.connectionOf(tx);
      if (existing && existing.entraTenantId !== tid) throw conflict('Die Organisation ist bereits mit einem anderen Entra-Tenant verbunden. Zuerst trennen.', { reason: 'tenant-mismatch' });
      if (kind === 'consent' && existing?.appClientId) throw ownAppConnected();
      // Höchstens LINK_MAX_OPEN offene Links (unter der Sperre der Organisation gezählt): viele weitergegebene Links
      // vergrössern die Angriffsfläche, ohne zu helfen
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey.admin(org.alias)]);
      const open = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${this.S}.entra_consent_link WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`)).rows[0]!.n);
      // Erledigte Links nach 90 Tagen löschen (das Protokoll bleibt)
      await tx.query(`DELETE FROM ${this.S}.entra_consent_link WHERE expires_at < now() - interval '90 days'`);
      if (open >= LINK_MAX_OPEN) throw conflict(`Höchstens ${LINK_MAX_OPEN} offene Links je Organisation. Einen nicht mehr gebrauchten Link widerrufen.`, { reason: 'too-many-links' });
      const r = (await tx.query<{ id: string; expires_at: Date }>(`INSERT INTO ${this.S}.entra_consent_link
          (tenant_id, token_hash, entra_tenant_id, tenant_input, platform, created_by, created_by_subject, created_by_name, created_by_tenant, expires_at, kind)
        VALUES (app.tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9), $10) RETURNING id, expires_at`,
      [hash(token), tid, input.tenant.trim().slice(0, 253), s.platform, s.actor.principalId, s.actor.subject, s.actor.name.slice(0, 256), s.actor.tenantAlias, minutes, kind])).rows[0]!;
      await this.admin.write(tx, this.admin.actorOf(s), { action: 'entra.consent_link_created', resourceType: 'tenant', resourceId: tenantId, data: { linkId: r.id, kind, entraTenantId: tid, expiresAt: r.expires_at } });
      return r;
    });
    return { id: row.id, kind, url: `${this.deps.cfg.publicBaseUrl}${handoverPath(this.deps.cfg)}#${token}`, entraTenantId: tid, expiresAt: row.expires_at };
  }

  /** Links der Organisation, die neuesten zuerst, mit Zustand und Fehler: alle offenen (höchstens LINK_MAX_OPEN), dazu die letzten 20 erledigten. */
  async consentLinks(s: Scope): Promise<ConsentLinkOut[]> {
    const { tenantId } = await this.ctx(s);
    const rows = await withTenant(this.deps.db, { tenantId }, async tx => (await tx.query<LinkRow & { expired: boolean; claimed: boolean }>(
      `(SELECT ${LINK_COLS}, false AS expired, claimed_at > now() - make_interval(mins => $1) AS claimed FROM ${this.S}.entra_consent_link WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now())
       UNION ALL
       (SELECT ${LINK_COLS}, expires_at <= now() AS expired, false AS claimed FROM ${this.S}.entra_consent_link WHERE NOT (used_at IS NULL AND revoked_at IS NULL AND expires_at > now())
        ORDER BY created_at DESC LIMIT 20)
       ORDER BY created_at DESC`, [LINK_CLAIM_MIN])).rows);
    return rows.map(r => ({
      id: r.id, kind: r.kind, entraTenantId: r.entra_tenant_id, createdByName: r.created_by_name, createdAt: r.created_at, expiresAt: r.expires_at,
      status: r.revoked_at ? 'revoked' : r.used_at ? 'connected' : r.expired ? 'expired' : r.claimed ? 'in-progress' : r.error_reason ? 'failed' : 'open',
      usedAt: r.used_at, approverName: r.approver_name, error: r.error_reason ? { reason: r.error_reason, detail: r.error_detail ?? '' } : null,
    }));
  }

  /** Link widerrufen; eingelöst 409, unbekannt 404. */
  async revokeConsentLink(s: Scope, id: string): Promise<void> {
    const { tenantId } = await this.ctx(s);
    await withTenant(this.deps.db, { tenantId }, async tx => {
      const r = (await tx.query<{ used_at: Date | null; revoked_at: Date | null }>(`SELECT used_at, revoked_at FROM ${this.S}.entra_consent_link WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!r) throw notFound('Link');
      if (r.used_at) throw conflict('Der Link ist schon eingelöst.');
      if (r.revoked_at) return;
      await tx.query(`UPDATE ${this.S}.entra_consent_link SET revoked_at = now(), error_reason = NULL, error_detail = NULL WHERE id = $1`, [id]);
      // offene Zustimmungen über diesen Link verfallen mit
      await tx.query(`UPDATE ${this.S}.entra_consent SET expires_at = now() WHERE link_id = $1 AND used_at IS NULL`, [id]);
      await this.admin.write(tx, this.admin.actorOf(s), { action: 'entra.consent_link_revoked', resourceType: 'tenant', resourceId: tenantId, data: { linkId: id } });
    });
  }

  /**
   * Offener Link zum Token: Mandant über den Alias vorne im Token, dann unter RLS über den Hash. Unbekannt, abgelaufen,
   * widerrufen, eingelöst oder Organisation gesperrt: immer dieselbe Antwort (404), nichts über den Grund.
   */
  private async openLink(token: string): Promise<{ tenant: TenantRow; link: LinkRow }> {
    const gone = linkGone();
    const alias = /^([a-z0-9][a-z0-9_-]{0,62})\.[A-Za-z0-9_-]{43}$/.exec(token)?.[1];
    const tenant = alias ? await findTenant(this.deps.db, alias) : null;
    if (!tenant || tenant.status !== 'active') throw gone;
    const link = await withTenant(this.deps.db, { tenantId: tenant.id }, async tx => (await tx.query<LinkRow>(
      `SELECT ${LINK_COLS} FROM ${this.S}.entra_consent_link WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [hash(token)])).rows[0]);
    if (!link) throw gone;
    return { tenant, link };
  }

  /**
   * Öffentlich: was die Seite zeigt – Name der Organisation, App, wer fragt und für welches Verzeichnis (Tenant wie bei
   * der Erzeugung angegeben, mit Tenant-ID), Ablauf. So erkennt die Entra-Administration einen fremden Link (Phishing).
   */
  async handoverInfo(token: string): Promise<{ kind: LinkKind; organization: string; product: string; requestedBy: string; tenant: string; entraTenantId: string; expiresAt: Date; notice: string; ownApp: OwnAppGuide | null }> {
    const { tenant, link } = await this.openLink(token);
    const own = link.kind === 'credentials';
    // Bestehende Verbindung behält ihren Anbieter (Redirect-URI des Platzes)
    const idp = own ? await withTenant(this.deps.db, { tenantId: tenant.id }, async tx => (await this.connectionOf(tx))?.idpAlias) : undefined;
    return {
      kind: link.kind, organization: tenant.name, product: this.deps.model.product, requestedBy: link.created_by_name, tenant: link.tenant_input, entraTenantId: link.entra_tenant_id, expiresAt: link.expires_at,
      notice: `${own ? 'Mit der eigenen App' : 'Mit der Zustimmung'} melden sich Personen von «${tenant.name}» in ${this.deps.model.product} über Microsoft an. Die verifizierten Domänen des Verzeichnisses werden dieser Organisation zugeordnet und stehen keiner anderen mehr zur Verfügung.`,
      ownApp: own ? this.guide(tenant.alias, idp) : null,
    };
  }

  /** Öffentlich: Zustimmung bei Microsoft starten (wie startConsent, `state` mit `h.`); wiederholbar, solange der Link offen ist. */
  async handoverStart(token: string): Promise<{ url: string }> {
    const { tenant, link } = await this.openLink(token);
    if (link.kind !== 'consent') throw wrongKind();
    const g = this.platformApp();
    await this.requireCreator(tenant, link);
    const state = `h.${tenant.alias}.${randomBytes(32).toString('base64url')}`;
    await withTenant(this.deps.db, { tenantId: tenant.id }, async tx => {
      await tx.query(`DELETE FROM ${this.S}.entra_consent WHERE expires_at < now()`);
      await tx.query(`INSERT INTO ${this.S}.entra_consent (tenant_id, state_hash, entra_tenant_id, subject, platform, link_id, expires_at)
        VALUES (app.tenant_id(), $1, $2, NULL, $3, $4, least(now() + make_interval(secs => $5), $6))`, [hash(state), link.entra_tenant_id, link.platform, link.id, CONSENT_TTL_MS / 1000, link.expires_at]);
      await this.admin.write(tx, this.admin.actorOf(this.linkScope(tenant, link)), { action: 'entra.consent_started', resourceType: 'tenant', resourceId: tenant.id, data: { entraTenantId: link.entra_tenant_id, viaLink: link.id } });
    });
    const proof = this.consentProof(state);
    return { url: g.consentUrl(link.entra_tenant_id, { state, redirectUri: consentRedirectUri(this.deps.cfg), nonce: proof.nonce, codeChallenge: createHash('sha256').update(proof.verifier).digest('base64url') }) };
  }

  /**
   * Öffentlich: Rückkehr von Microsoft über einen Link. Gleicher Nachweis wie completeConsent; verbunden wird im Namen der
   * Person, die den Link erzeugt hat (Akteur im Protokoll), mit der zustimmenden Person (`consentBy`) und `viaLink`.
   * Der Link wird vor dem Nachweis mit einer Frist belegt (`claimed_at`; zwei Rückkehren gleichzeitig: nur eine verbindet),
   * eingelöst (`used_at`) erst nach Erfolg; bei einem Fehlschlag wird er mit dem Fehler wieder frei, nach einem Abbruch
   * des Prozesses nach Ablauf der Frist. Der `state` ist in jedem Fall verbraucht.
   */
  async handoverComplete(p: { state: string; code?: string; error?: string; errorDescription?: string }): Promise<{ organization: string; connected: true }> {
    this.platformApp();
    const gone = new HttpError(404, 'Zustimmung nicht gefunden', 'Die Zustimmung ist abgelaufen oder wurde schon verwendet. Den Link erneut öffnen.');
    const alias = /^h\.([a-z0-9][a-z0-9_-]{0,62})\./.exec(p.state)?.[1];
    const tenant = alias ? await findTenant(this.deps.db, alias) : null;
    if (!tenant || tenant.status !== 'active') throw gone;
    const claimed = await withTenant(this.deps.db, { tenantId: tenant.id }, async tx => {
      const c = (await tx.query<{ tid: string; link_id: string }>(
        `UPDATE ${this.S}.entra_consent SET used_at = now() WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now() AND link_id IS NOT NULL
         RETURNING entra_tenant_id::text AS tid, link_id`, [hash(p.state)])).rows[0];
      if (!c) return null;
      // Frist statt used_at: bricht der Prozess mitten in der Einlösung ab, ist der Link nach LINK_CLAIM_MIN wieder frei
      const link = await this.claim(tx, c.link_id);
      return link ? { tid: c.tid, link } : null;
    });
    if (!claimed) throw gone;
    const { link } = claimed;
    return this.redeem(tenant, link, async (s, onConnected) => {
      const org = await this.admin.org(tenant.alias);
      await this.proveAndConnect(s, org, claimed.tid, p, { viaLink: link.id, linkCreatedBy: link.created_by_name }, onConnected);
      return { organization: org.name, connected: true as const };
    });
  }

  /**
   * Öffentlich: Die Kunden-IT trägt über einen Link (`kind: 'credentials'`) die eigene App ein, ohne Konto in der App
   * und ohne das Geheimnis weiterzugeben. Tenant fest aus dem Link; gleiche Prüfung wie `connectApp`, verbunden im Namen
   * der Person, die den Link erzeugt hat. Belegen, Einlösen und Freigeben wie bei der Zustimmung über einen Link.
   */
  async handoverApp(token: string, input: { clientId: string; clientSecret: string; secretExpiresAt?: string | null }): Promise<{ organization: string; connected: true }> {
    const { tenant, link: open } = await this.openLink(token);
    if (open.kind !== 'credentials') throw wrongKind();
    const link = await withTenant(this.deps.db, { tenantId: tenant.id }, tx => this.claim(tx, open.id));
    if (!link) throw linkGone();
    return this.redeem(tenant, link, async (s, onConnected) => {
      await this.connectApp(s, input, { tid: link.entra_tenant_id, audit: { viaLink: link.id, linkCreatedBy: link.created_by_name }, onConnected });
      return { organization: tenant.name, connected: true as const };
    });
  }

  /** Link mit Frist belegen: bricht der Prozess mitten in der Einlösung ab, ist er nach LINK_CLAIM_MIN wieder frei. */
  private async claim(tx: Tx, id: string): Promise<LinkRow | null> {
    return (await tx.query<LinkRow>(`UPDATE ${this.S}.entra_consent_link SET claimed_at = now()
        WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => $2)) RETURNING ${LINK_COLS}`, [id, LINK_CLAIM_MIN])).rows[0] ?? null;
  }

  /**
   * Belegten Link einlösen: Rechte der erzeugenden Person prüfen, verbinden (`run`); eingelöst in derselben Transaktion
   * wie die Verbindung – verbunden heisst immer auch eingelöst, und umgekehrt. Während der Prüfung widerrufen: nichts
   * verbunden (locked() setzt Keycloak zurück). Fehlschlag: Link mit dem Fehler wieder frei, solange nicht verbunden.
   */
  private async redeem<T>(tenant: TenantRow, link: LinkRow, run: (s: Scope, onConnected: OnConnected) => Promise<T>): Promise<T> {
    const s = this.linkScope(tenant, link);
    let connected = false;
    try {
      await this.requireCreator(tenant, link);
      return await run(s, async (tx, approver) => {
        const r = await tx.query(`UPDATE ${this.S}.entra_consent_link SET used_at = now(), claimed_at = NULL, approver_name = $2, error_reason = NULL, error_detail = NULL
          WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [link.id, approver ? (approver.name ?? approver.username ?? approver.oid).slice(0, 256) : null]);
        if (!r.rowCount) throw linkGone();
        connected = true;
      });
    } catch (e) {
      if (connected) throw e;
      const known = e instanceof HttpError && e.status === 409;
      const reason = known ? String(e.extra.reason ?? 'conflict') : null;
      await withTenant(this.deps.db, { tenantId: tenant.id }, async tx => {
        await tx.query(`UPDATE ${this.S}.entra_consent_link SET claimed_at = NULL, error_reason = $2, error_detail = $3 WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
          [link.id, (reason ?? 'error').slice(0, 64), known ? (e.detail ?? e.title).slice(0, 1000) : 'Verbinden fehlgeschlagen']);
        // Nur Zustimmung abgelehnt bzw. nicht nachgewiesen; Fehler beim Verbinden protokolliert locked() (`entra.connect_failed`)
        if (reason === 'consent-error' || reason === 'consent-unproven') await this.admin.write(tx, this.admin.actorOf(s), {
          action: 'entra.consent_failed', resourceType: 'tenant', resourceId: tenant.id, data: { entraTenantId: link.entra_tenant_id, reason, detail: (e as HttpError).detail ?? null, viaLink: link.id } });
      }).catch(() => undefined);
      throw e;
    }
  }

  /** Akteur einer Einlösung: die Person, die den Link erzeugt hat (ohne Token; ihre Rechte prüft requireCreator). */
  private linkScope(tenant: TenantRow, link: LinkRow): Scope {
    const actor: Principal = {
      tenantId: tenant.id, tenantAlias: link.created_by_tenant, principalId: link.created_by, kind: 'user', subject: link.created_by_subject, name: link.created_by_name,
      email: null, clientId: null, groups: [], subjects: [`user:${link.created_by}`], scopes: [], platformAdmin: link.platform, binding: 'none', token: '',
    };
    return { alias: tenant.alias, actor, platform: link.platform, source: 'api', correlationId: randomUUID() };
  }

  /**
   * Darf die Person, die den Link erzeugt hat, noch, und ist die Organisation nicht gesperrt? Plattform-Link: Realm-Rolle
   * PLATFORM_ADMIN_ROLE; sonst Mitglied mit `members:admin` (Tupel an org). Wenn nicht: Link widerrufen (Protokoll mit
   * `reason: 'creator-lost-access'`) und dieselbe Antwort wie für einen ungültigen Link. Fehler bei Keycloak: Link bleibt.
   */
  private async requireCreator(tenant: TenantRow, link: LinkRow): Promise<void> {
    const t = this.deps.cfg.tenancy, subject = link.created_by_subject;
    const org = await this.admin.org(tenant.alias, true);
    if (!org.enabled) throw linkGone();
    let ok: boolean;
    if (link.platform) ok = (await this.kc.realmRoles(subject)).includes(t.platformAdminRole);
    else ok = !!(await this.kc.member(org.id, subject)) && await this.admin.managesMembers(tenant.id, subject);
    if (ok) return;
    await withTenant(this.deps.db, { tenantId: tenant.id }, async tx => {
      const r = await tx.query(`UPDATE ${this.S}.entra_consent_link SET revoked_at = now(), error_reason = 'creator-lost-access', error_detail = NULL WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [link.id]);
      await tx.query(`UPDATE ${this.S}.entra_consent SET expires_at = now() WHERE link_id = $1 AND used_at IS NULL`, [link.id]);
      if (r.rowCount) await this.admin.write(tx, this.admin.actorOf(this.linkScope(tenant, link)), { action: 'entra.consent_link_revoked', resourceType: 'tenant', resourceId: tenant.id, data: { linkIds: [link.id], reason: 'creator-lost-access' } });
    });
    throw linkGone();
  }

  // ---------------------------------------------------------------- Bausteine
  /**
   * Plattformweite Sperre (bis zum Ende der Transaktion von locked()): Domänenprüfung, Vergabe der Plätze und die
   * zugehörigen Änderungen in Keycloak laufen über alle Organisationen nacheinander. Die Sperre je Organisation genügt
   * nicht – zwei Organisationen sähen sonst denselben freien Platz, und die zweite löschte den eben angelegten Anbieter
   * der ersten (der Unique-Index griffe erst nach den Änderungen in Keycloak).
   */
  private static async lockPlatform(tx: Tx) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey.entraPlatform()]);
  }

  /** Domänen, die eine andere Organisation hat (Plattform oder Keycloak); ohne zu verraten, welche. */
  private async taken(tx: Tx, orgId: string, domains: string[]): Promise<Set<string>> {
    const out = new Set((await tx.query<{ d: string[] }>('SELECT app.entra_domains_taken($1::text[]) AS d', [domains])).rows[0]?.d ?? []);
    for (const o of await this.kc.listOrgs()) if (o.id !== orgId) for (const d of o.domains ?? []) if (domains.includes(d.name.toLowerCase())) out.add(d.name.toLowerCase());
    return out;
  }

  /**
   * Verknüpfung planen: Mitglieder mit Adresse in `domains`, je genau eine verknüpfbare Person in Entra mit dieser
   * Adresse (UPN oder mail). Schon verknüpfte Konten zählen als verknüpft (`entra` null), wenn die verknüpfte Person in
   * Entra noch verknüpfbar ist, sonst mit Grund. Ändert nichts.
   */
  private async plan(g: EntraGraph, tid: string, members: KcUser[], domains: string[], idp: string | null): Promise<Plan[]> {
    const out: Plan[] = [];
    for (const u of members) {
      if (!domains.includes(domainOf(u.email) ?? '')) continue;
      const x = await this.planOne(g, tid, u, domains, idp);
      if (await this.keepsFirstFactor(u.id)) x.passwordKept = 'Plattform-Administration: Passwort und Passkey bleiben (Notfallzugang)';
      out.push(x);
    }
    return out;
  }

  private async planOne(g: EntraGraph, tid: string, u: KcUser, domains: string[], idp: string | null): Promise<Plan> {
    const link = idp ? (await this.kc.federatedIdentities(u.id)).find(f => f.identityProvider === idp) : undefined;
    if (link) {
      // Bestehende Verknüpfung nur, solange die Person in Entra verknüpfbar bleibt (deaktiviert, gelöscht, Gast, Domäne
      // gewechselt: Anmeldung ginge verloren); die Objekt-ID zählt, nicht die Adresse
      const e = await g.user(tid, link.userId);
      return { user: u, entra: null, reason: e ? notLinkable(e, domains) : 'In Entra ID nicht gefunden' };
    }
    const hits = await g.usersByAddress(tid, u.email!);
    const ok = hits.filter(h => !notLinkable(h, domains, u.email));
    if (ok.length === 1) return { user: u, entra: ok[0]!, reason: null };
    return { user: u, entra: null, reason: ok.length > 1 ? 'Mehrere Personen in Entra ID mit dieser Adresse' : hits.length ? notLinkable(hits[0]!, domains, u.email) : 'In Entra ID nicht gefunden' };
  }

  private static report(plan: Plan[]): BindResult[] {
    return plan.map(x => ({ email: x.user.email!, name: nameOf(x.user), linked: !x.reason, reason: x.reason, ...(x.passwordKept ? { passwordKept: x.passwordKept } : {}) }));
  }

  /**
   * Bestätigung «verlieren die Anmeldung»: Wer beim Erzwingen nicht verknüpft werden kann,
   * muss in `confirmed` stehen – genau diese Liste, sonst 409 mit der aktuellen Liste (nie stillschweigend).
   */
  private static requireConfirmed(plan: Plan[], confirmed: string[] | undefined) {
    const lost = plan.filter(x => x.reason).map(x => x.user.email!.toLowerCase()).sort();
    const got = [...new Set((confirmed ?? []).map(e => e.trim().toLowerCase()))].sort();
    if (lost.join() !== got.join()) {
      throw conflict(lost.length
        ? `${lost.length === 1 ? 'Ein Mitglied verliert' : `${lost.length} Mitglieder verlieren`} die Anmeldung (in Entra ID nicht verknüpfbar): ${lost.join(', ')}. Bitte bestätigen.`
        : 'Die Liste hat sich geändert: Alle Mitglieder lassen sich verknüpfen. Bitte erneut bestätigen.', { reason: 'confirm-not-linked', notLinked: EntraService.report(plan.filter(x => x.reason)) });
    }
  }

  /** Nicht aussperren: die handelnde Person (ohne Plattform-Administration) muss verknüpfbar sein. */
  private static requireSelf(s: Scope, plan: Plan[], viaLink = false) {
    const self = plan.find(x => x.user.id === s.actor.subject);
    // Über einen Link liest die Entra-Administration die Meldung (öffentlich): ohne Anrede und ohne Grund
    if (!s.platform && self?.reason && viaLink) throw conflict('Das Konto der Person, die den Link erzeugt hat, liesse sich nicht mit Entra ID verknüpfen; sie könnte sich danach nicht mehr anmelden. Sie muss das zuerst in der App klären.', { reason: 'self-not-linkable' });
    if (!s.platform && self?.reason) throw conflict(`Dein Konto liesse sich nicht mit Entra ID verknüpfen (${self.reason}). Ohne Verknüpfung könntest du dich danach nicht mehr anmelden.`, { reason: 'self-not-linkable' });
  }

  /**
   * Konto mit einer Person in Entra verknüpfen (auch für `addFromEntra`). Prüft `notLinkable` erneut; die Objekt-ID ist
   * der Schlüssel, der UPN nur zur Anzeige in Keycloak.
   */
  async linkAccount(w: Pick<Work, 'done'>, c: Pick<EntraConnection, 'idpAlias' | 'domains'>, user: KcUser, entra: EntraUser): Promise<void> {
    const why = notLinkable(entra, c.domains, user.email);
    if (why) throw conflict(`Nicht verknüpfbar: ${why}.`);
    if (await this.kc.addFederatedIdentity(user.id, { identityProvider: c.idpAlias, userId: entra.id, userName: entra.userPrincipalName }) === 'conflict') {
      throw conflict('Diese Person in Entra ID ist bereits mit einem anderen Konto verknüpft.');
    }
    w.done({ step: 'account_linked' });
  }

  /** Erstfaktoren (Passwort, Passkey) und die offene Aktion «Passwort setzen» entfernen (auch für `addFromEntra`). */
  async removeFirstFactor(w: Pick<Work, 'done'>, user: KcUser): Promise<boolean> {
    if (await this.keepsFirstFactor(user.id)) return false;
    let changed = false;
    for (const c of await this.kc.credentials(user.id)) if (FIRST_FACTORS.has(c.type)) { await this.kc.deleteCredential(user.id, c.id); changed = true; }
    const actions = user.requiredActions ?? [];
    if (actions.includes('UPDATE_PASSWORD')) { await this.kc.updateUser(user.id, { requiredActions: actions.filter(a => a !== 'UPDATE_PASSWORD') }); changed = true; }
    if (changed) w.done({ step: 'password_removed' });
    return changed;
  }

  /**
   * Konten der Plattform-Administration (PLATFORM_ADMIN_ROLE, auch zusammengesetzt) behalten Passwort und Passkey: «Nur
   * Entra» einer Organisation ändert nie den Notfallzugang der Plattform.
   */
  private async keepsFirstFactor(userId: string): Promise<boolean> {
    return (await this.kc.realmRoles(userId)).includes(this.deps.cfg.tenancy.platformAdminRole);
  }

  /**
   * Domänen der Organisation in Keycloak: gebundene zeigen auf den Anbieter, mit Weiterleitung nur bei «Nur Entra»;
   * andere bleiben, wie sie sind. `drop`: selbst eingetragene Domänen, die nicht mehr gebunden sind.
   */
  private static orgDomains(org: KcOrg, alias: string, bound: string[], redirect: boolean, drop: string[] = []): { domains: KcOrgDomain[]; added: string[] } {
    const have = new Map((org.domains ?? []).map(d => [d.name.toLowerCase(), d]));
    const domains: KcOrgDomain[] = [...have.values()].filter(d => !bound.includes(d.name.toLowerCase()) && !drop.includes(d.name.toLowerCase()))
      .map(d => (d.identityProviderAlias === alias ? { name: d.name, verified: d.verified ?? false } : d));
    for (const b of bound) domains.push({ name: b, verified: true, identityProviderAlias: alias, autoRedirect: redirect });
    return { domains, added: bound.filter(b => !have.has(b)) };
  }

  /** Plan ausführen: verknüpfen; bei «Nur Entra» zusätzlich Erstfaktoren entfernen. */
  private async bind(w: Work, c: Pick<EntraConnection, 'idpAlias' | 'domains'>, plan: Plan[], enforce: boolean): Promise<number> {
    let linked = 0;
    for (const x of plan) {
      if (x.entra) { await this.linkAccount(w, c, x.user, x.entra); linked++; }
      if (enforce) await this.removeFirstFactor(w, x.user);
    }
    return linked;
  }

  // ---------------------------------------------------------------- Verbinden
  /**
   * Verbinden bzw. erneut verbinden (gleicher Tenant): Anbieter anlegen oder nachführen, Domänen zuordnen, Mitglieder
   * verknüpfen. Neu: Stufe `pending` (keine Weiterleitung, Passwörter bleiben). Bei «Nur Entra» bleibt es dabei; neu
   * verknüpfbare Mitglieder verlieren dann ihr Passwort, nicht verknüpfbare werden gemeldet (sie hatten die Anmeldung
   * schon beim Aktivieren bzw. Hinzufügen der Domäne verloren). Scheitert ein Schritt, werden Organisation und ein neu
   * angelegter Anbieter zurückgesetzt; was bleibt, protokolliert locked() (`entra.connect_failed`).
   */
  private async connect(s: Scope, org0: KcOrg, eo: EntraOrganization, app: { g: EntraGraph; own: { clientId: string; clientSecret: string; expiresAt: Date | null } | null },
    approver: ConsentApprover | null = null, audit: Record<string, unknown> = {}, onConnected?: OnConnected): Promise<ConnectResult> {
    const { g, own } = app;
    return this.admin.locked(s, org0, { action: 'entra.connect_failed', resourceType: 'tenant' }, async w => {
      const { tx } = w;
      await EntraService.lockPlatform(tx);
      const org = await this.admin.org(org0.alias, true);
      const existing = await this.connectionOf(tx);
      if (existing && existing.entraTenantId !== eo.id) throw conflict('Die Organisation ist bereits mit einem anderen Entra-Tenant verbunden. Zuerst trennen.', { reason: 'tenant-mismatch' });
      if (existing?.appClientId && !own) throw ownAppConnected();
      const enforced = existing?.stage === 'enforced';
      const verified = eo.verifiedDomains.filter(d => DOMAIN_RE.test(d));
      const taken = await this.taken(tx, org.id, verified);
      // Bestehende Verbindung: gebundene Domänen bleiben (sofern noch verifiziert), neue kommen nicht von selbst dazu
      const want = existing ? existing.domains.filter(d => verified.includes(d)) : verified;
      const bound = want.filter(d => !taken.has(d)), rejected = want.filter(d => taken.has(d));
      if (!bound.length) throw conflict('Keine Domäne des Tenants lässt sich binden: Jede verifizierte Domäne gehört bereits einer anderen Organisation.', { reason: 'domains-taken' });
      const plan = await this.plan(g, eo.id, await this.kc.members(org.id), bound, existing?.idpAlias ?? null);
      if (enforced) EntraService.requireSelf(s, plan, !!audit.viaLink);
      // Eigene App: fester Alias je Organisation (Redirect-URI vorab bekannt); eine bestehende Verbindung behält ihren
      const alias = existing?.idpAlias ?? (own ? ownAppAlias(org.alias) : (await tx.query<{ a: string | null }>('SELECT app.entra_free_slot($1) AS a', [this.deps.cfg.entra.slots])).rows[0]!.a);
      if (!alias) throw conflict('Alle Plätze für Entra-Verbindungen sind belegt. Die Plattform-Administration muss weitere Redirect-URIs in der Entra-App eintragen (ENTRA_IDP_SLOTS).', { reason: 'no-slot' });

      let created = false, linked = 0;
      try {
        const rep = idpRepresentation(alias, eo.id, own ?? this.deps.cfg.entra, this.deps.model.product);
        const have = await this.kc.getIdp(alias);
        if (have && !existing) await this.kc.deleteIdp(alias); // Rest eines abgebrochenen Laufs: Plätze und `entra-app-<alias>` gehören der Plattform
        // Bestehender Anbieter: erst nach allen anderen Schritten nachführen (unten), sonst meldete Keycloak nach einem
        // Fehlschlag mit der neuen App an, während die Datenbank zurückrollt
        if (!(have && existing)) { await this.kc.createIdp(rep); created = true; w.done({ step: 'idp_created' }); await this.ensureGroupsMapper(w, alias); }
        if (!existing) { await this.kc.linkOrgIdp(org.id, alias); w.done({ step: 'idp_linked' }); }
        const d = EntraService.orgDomains(org, alias, bound, enforced);
        await this.kc.updateOrg({ ...org, domains: d.domains });
        w.done({ step: 'organization_updated' });
        linked = await this.bind(w, { idpAlias: alias, domains: bound }, plan, enforced);
        const addedNow = existing ? [...new Set([...existing.kcDomainsAdded, ...d.added])] : d.added;
        const secretEnc = own ? encryptAppSecret(this.deps.cfg.encryptionKeys, w.tenantId, own.clientId, own.clientSecret) : null;
        const c = (await tx.query<EntraConnection>(
          `INSERT INTO ${this.S}.entra_connection (tenant_id, entra_tenant_id, entra_name, idp_alias, domains, tenant_domains, kc_domains_added, connected_by_name, app_client_id, app_secret_enc, app_secret_expires_at)
           VALUES (app.tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (tenant_id) DO UPDATE SET entra_name = excluded.entra_name, domains = excluded.domains, tenant_domains = excluded.tenant_domains,
             kc_domains_added = excluded.kc_domains_added, app_client_id = excluded.app_client_id, app_secret_enc = excluded.app_secret_enc,
             app_secret_expires_at = excluded.app_secret_expires_at, status = 'active', last_error = NULL, refreshed_at = now()
           RETURNING ${COLS}`, [eo.id, eo.displayName.slice(0, 256), alias, bound, verified, addedNow, s.actor.name, own?.clientId ?? null, secretEnc, own?.expiresAt ?? null])).rows[0]!;
        const members = EntraService.report(plan);
        await w.log({ action: existing ? 'entra.reconnected' : 'entra.connected', resourceType: 'tenant', resourceId: w.tenantId, data: {
          entraTenantId: eo.id, entraName: eo.displayName, app: own ? 'own' : 'platform', ...(own ? { appClientId: own.clientId, secretExpiresAt: own.expiresAt } : {}), domains: bound, rejectedDomains: rejected, stage: c.stage, linked: members.filter(r => r.linked).length,
          ...(approver ? { consentBy: approver } : {}), ...audit,
          notLinked: members.filter(r => !r.linked).map(r => ({ email: r.email, reason: r.reason })),
        } });
        // In derselben Transaktion wie die Verbindung (z. B. Link als eingelöst markieren)
        if (onConnected) await onConnected(tx, approver);
        // Übrige offene Links für die eigene App verfallen: ein alter Link überschriebe sonst später diese Verbindung
        if (own) await tx.query(`UPDATE ${this.S}.entra_consent_link SET revoked_at = now(), error_reason = 'superseded', error_detail = NULL
          WHERE kind = 'credentials' AND used_at IS NULL AND revoked_at IS NULL`);
        if (have && existing) { await this.kc.updateIdp(rep); w.done({ step: 'idp_updated' }); await this.ensureGroupsMapper(w, alias); }
        this.deps.resolver.forgetEntra();
        return { connection: this.out(c, org.alias), members, rejectedDomains: rejected };
      } catch (e) {
        // Domänen der Organisation zurücksetzen (sie verweisen sonst auf den Anbieter), dann einen neu angelegten Anbieter
        // löschen (entfernt auch die Verknüpfungen)
        await this.kc.updateOrg(org).then(() => w.undone({ step: 'organization_updated' }), () => undefined);
        if (created && await this.kc.deleteIdp(alias).then(() => true, () => false)) {
          w.undone({ step: 'idp_created' }); w.undone({ step: 'idp_linked' });
          for (let i = 0; i < linked; i++) w.undone({ step: 'account_linked' });
        }
        throw e;
      }
    });
  }

  // ---------------------------------------------------------------- Testanmeldung, «Nur Entra» aktivieren
  /**
   * Testanmeldung festhalten: Die Sitzung dieser Person ist über den Anbieter der Organisation angemeldet (Claim
   * `identity_provider`) und ihre Adresse liegt in einer gebundenen Domäne. Jede Person der Organisation darf das melden.
   */
  async test(s: Scope): Promise<EntraConnectionOut> {
    const { tenantId } = await this.ctx(s);
    return withTenant(this.deps.db, { tenantId }, async tx => {
      const c = await this.connectionOf(tx);
      if (!c) throw notFound('Verbindung mit Entra ID');
      if (s.actor.identityProvider !== c.idpAlias) throw conflict('Diese Sitzung ist nicht über Microsoft angemeldet. Testanmeldung über «Testanmeldung mit Microsoft» starten.', { reason: 'not-entra-session' });
      if (!c.domains.includes(domainOf(s.actor.email) ?? '')) throw conflict('Deine Adresse liegt in keiner gebundenen Domäne.', { reason: 'not-in-domains' });
      const n = (await tx.query<EntraConnection>(`UPDATE ${this.S}.entra_connection SET tested_at = now(), tested_by_name = $1 RETURNING ${COLS}`, [s.actor.name])).rows[0]!;
      await this.admin.write(tx, this.admin.actorOf(s), { action: 'entra.test_login', resourceType: 'tenant', resourceId: tenantId, data: { email: s.actor.email } });
      return this.out(n, s.alias);
    });
  }

  /** Vorschau für «Nur Entra aktivieren»: wer verknüpft ist bzw. wird, wer die Anmeldung verliert (mit Grund). Ändert nichts. */
  async preview(s: Scope): Promise<{ members: BindResult[] }> {
    const { org, tenantId } = await this.ctx(s);
    const c = await withTenant(this.deps.db, { tenantId }, tx => this.connectionOf(tx));
    if (!c) throw notFound('Verbindung mit Entra ID');
    return { members: EntraService.report(await this.plan(this.graphFor(c), c.entraTenantId, await this.kc.members(org.id), c.domains, c.idpAlias)) };
  }

  /**
   * «Nur Entra» aktivieren: erst nach der Testanmeldung und mit bestätigter Liste der Mitglieder, die nicht verknüpft
   * werden können. Verknüpft die übrigen, entfernt Passwörter aller Mitglieder der Domänen, schaltet die Weiterleitung
   * ein; ab dann prüft der Resolver den Anbieter der Anmeldung.
   */
  async enforce(s: Scope, input: { notLinked?: string[] }): Promise<ConnectResult> {
    return this.withConnection(s, 'entra.enforce', async (w, c, org) => {
      if (c.stage === 'enforced') throw conflict('«Nur Entra» ist bereits aktiv.');
      if (!c.testedAt) throw conflict('Zuerst eine Testanmeldung mit Microsoft durchführen: Erst wenn eine Person der Domänen sich über Entra angemeldet hat, lässt sich «Nur Entra» aktivieren.', { reason: 'test-login-missing' });
      const plan = await this.plan(this.graphFor(c), c.entraTenantId, await this.kc.members(org.id), c.domains, c.idpAlias);
      EntraService.requireSelf(s, plan);
      EntraService.requireConfirmed(plan, input.notLinked);
      await this.kc.updateOrg({ ...org, domains: EntraService.orgDomains(org, c.idpAlias, c.domains, true).domains });
      w.done({ step: 'organization_updated' });
      await this.bind(w, c, plan, true);
      const n = (await w.tx.query<EntraConnection>(`UPDATE ${this.S}.entra_connection SET stage = 'enforced', enforced_at = now(), enforced_by_name = $1 RETURNING ${COLS}`, [s.actor.name])).rows[0]!;
      const members = EntraService.report(plan);
      await w.log({ action: 'entra.enforced', resourceType: 'tenant', resourceId: w.tenantId, data: { domains: c.domains, linked: members.filter(r => r.linked).length, notLinked: members.filter(r => !r.linked).map(r => ({ email: r.email, reason: r.reason })) } });
      this.deps.resolver.forgetEntra();
      return { connection: this.out(n, org.alias), members, rejectedDomains: [] };
    });
  }

  // ---------------------------------------------------------------- Ändern, Aktualisieren, Trennen
  private async withConnection<T>(s: Scope, action: string, fn: (w: Work, c: EntraConnection, org: KcOrg) => Promise<T>): Promise<T> {
    const org0 = await this.admin.org(s.alias);
    return this.admin.locked(s, org0, { action: `${action}_failed`, resourceType: 'tenant' }, async w => {
      const c = await this.connectionOf(w.tx);
      if (!c) throw notFound('Verbindung mit Entra ID');
      return fn(w, c, await this.admin.org(org0.alias, true));
    });
  }

  /**
   * Gebundene Domänen auf diese Auswahl setzen (Teilmenge der verifizierten Domänen des Tenants). Neue Domänen: Mitglieder
   * verknüpfen; bei «Nur Entra» auch Passwörter entfernen, mit bestätigter Liste wie beim Aktivieren (`notLinked`).
   * Entfernte Domänen: keine Weiterleitung mehr, Personen dieser Domänen setzen über «Passwort vergessen» wieder ein Passwort.
   */
  async setDomains(s: Scope, wanted: string[], notLinked?: string[]): Promise<ConnectResult> {
    const list = [...new Set(wanted.map(d => d.trim().toLowerCase()))];
    return this.withConnection(s, 'entra.domains_change', async (w, c, org) => {
      const bad = list.filter(d => !c.tenantDomains.includes(d));
      if (bad.length) throw invalid('Domäne nicht verifiziert', bad.map(d => ({ path: '/domains', message: `«${d}» ist im Tenant nicht verifiziert (oder «Aktualisieren» fehlt)` })));
      if (!list.length) throw invalid('Mindestens eine Domäne', [{ path: '/domains', message: 'Zum Lösen aller Domänen die Verbindung trennen' }]);
      const add = list.filter(d => !c.domains.includes(d)), del = c.domains.filter(d => !list.includes(d));
      if (add.length) await EntraService.lockPlatform(w.tx);
      const taken = await this.taken(w.tx, org.id, add);
      if (taken.size) throw conflict(`Bereits einer anderen Organisation zugeordnet: ${[...taken].sort().join(', ')}.`, { reason: 'domains-taken' });
      const enforced = c.stage === 'enforced';
      const plan = await this.plan(this.graphFor(c), c.entraTenantId, add.length ? await this.kc.members(org.id) : [], add, c.idpAlias);
      if (enforced) { EntraService.requireSelf(s, plan); EntraService.requireConfirmed(plan, notLinked); }
      return this.apply(w, c, org, list, plan, { action: 'entra.domains_changed', data: { added: add, removed: del } });
    });
  }

  /** Domänen der Organisation setzen, Plan ausführen, Verbindung speichern und protokollieren. */
  private async apply(w: Work, c: EntraConnection, org: KcOrg, domains: string[], plan: Plan[],
    o: { action: string; data: Record<string, unknown>; tenantDomains?: string[]; entraName?: string }): Promise<ConnectResult> {
    const enforced = c.stage === 'enforced';
    // Selbst eingetragene Domänen, die nicht mehr gebunden sind, wieder entfernen
    const drop = c.kcDomainsAdded.filter(x => !domains.includes(x));
    const d = EntraService.orgDomains(org, c.idpAlias, domains, enforced, drop);
    await this.kc.updateOrg({ ...org, domains: d.domains });
    w.done({ step: 'organization_updated' });
    await this.bind(w, { idpAlias: c.idpAlias, domains }, plan, enforced);
    const added = [...new Set([...c.kcDomainsAdded.filter(x => !drop.includes(x)), ...d.added])];
    const n = (await w.tx.query<EntraConnection>(
      `UPDATE ${this.S}.entra_connection SET domains = $1, kc_domains_added = $2, tenant_domains = $3, entra_name = $4, status = 'active', last_error = NULL, refreshed_at = now()
       RETURNING ${COLS}`, [domains, added, o.tenantDomains ?? c.tenantDomains, (o.entraName ?? c.entraName).slice(0, 256)])).rows[0]!;
    const members = EntraService.report(plan);
    await w.log({ action: o.action, resourceType: 'tenant', resourceId: w.tenantId, data: { ...o.data, domains, linked: members.filter(r => r.linked).length, notLinked: members.filter(r => !r.linked).map(r => ({ email: r.email, reason: r.reason })) } });
    this.deps.resolver.forgetEntra();
    return { connection: this.out(n, org.alias), members, rejectedDomains: [] };
  }

  /**
   * Aktualisieren: Organisation und verifizierte Domänen neu lesen, nicht mehr verifizierte Domänen lösen, Anbieter mit
   * der aktuellen Konfiguration (auch einem neuen ENTRA_CLIENT_SECRET) nachführen. Graph nicht erreichbar → Status `error`.
   * Eigene App: mit ihr gelesen; den Ablauf ihres Geheimnisses liest sie neu, wenn sie darf (sonst bleibt der bekannte).
   */
  async refresh(s: Scope): Promise<ConnectResult> {
    const { tenantId } = await this.ctx(s);
    const ctx = { tenantId };
    const c0 = await withTenant(this.deps.db, ctx, tx => this.connectionOf(tx));
    if (!c0) throw notFound('Verbindung mit Entra ID');
    const tid = c0.entraTenantId;
    let eo: EntraOrganization, expires = c0.appSecretExpiresAt;
    try {
      if (c0.appClientId) { const r = await this.graphFor(c0).checkApp(tid); eo = r.organization; expires = r.secretExpiresAt ?? expires; }
      else eo = await this.graphFor(c0).organization(tid);
    } catch (e) {
      if (e instanceof HttpError) await withTenant(this.deps.db, ctx, tx => tx.query(`UPDATE ${this.S}.entra_connection SET status = 'error', last_error = $1`, [(e.detail ?? e.title).slice(0, 1000)]));
      throw e;
    }
    return this.withConnection(s, 'entra.refresh', async (w, c, o) => {
      if (eo.id !== c.entraTenantId) throw conflict('Antwort passt nicht zum verbundenen Tenant.');
      const verified = eo.verifiedDomains.filter(d => DOMAIN_RE.test(d));
      const domains = c.domains.filter(d => verified.includes(d));
      if (!domains.length) throw conflict('Keine der gebundenen Domänen ist im Tenant noch verifiziert. Verbindung trennen oder neu verbinden.');
      await this.kc.updateIdp(idpRepresentation(c.idpAlias, c.entraTenantId, this.appOf(c), this.deps.model.product));
      await this.ensureGroupsMapper(w, c.idpAlias);
      if (c.appClientId && expires?.getTime() !== c.appSecretExpiresAt?.getTime()) await w.tx.query(`UPDATE ${this.S}.entra_connection SET app_secret_expires_at = $1`, [expires]);
      return this.apply(w, c, o, domains, [], { action: 'entra.refreshed', data: { removed: c.domains.filter(d => !domains.includes(d)) }, tenantDomains: verified, entraName: eo.displayName });
    });
  }

  /**
   * Trennen: Anbieter löschen (mit allen Verknüpfungen), Zuordnung der Domänen aufheben, selbst eingetragene Domänen
   * entfernen. Die Konten bleiben; war «Nur Entra» aktiv, haben sie kein Passwort und kommen erst nach «Passwort vergessen»
   * wieder hinein.
   */
  async disconnect(s: Scope): Promise<void> {
    await this.withConnection(s, 'entra.disconnect', async (w, c, org) => {
      const domains = (org.domains ?? []).filter(d => !c.kcDomainsAdded.includes(d.name.toLowerCase()))
        .map(d => (d.identityProviderAlias === c.idpAlias ? { name: d.name, verified: d.verified ?? false } : d));
      await this.kc.updateOrg({ ...org, domains });
      w.done({ step: 'organization_updated' });
      await this.kc.unlinkOrgIdp(org.id, c.idpAlias);
      await this.kc.deleteIdp(c.idpAlias);
      w.done({ step: 'idp_deleted' });
      await w.tx.query(`DELETE FROM ${this.S}.entra_connection`);
      await w.tx.query(`DELETE FROM ${this.S}.entra_consent`);
      // Offene Links verfallen: wer neu verbinden will, erzeugt einen neuen
      await w.tx.query(`UPDATE ${this.S}.entra_consent_link SET revoked_at = now(), error_reason = 'disconnected', error_detail = NULL WHERE used_at IS NULL AND revoked_at IS NULL`);
      await w.log({ action: 'entra.disconnected', resourceType: 'tenant', resourceId: w.tenantId, data: { entraTenantId: c.entraTenantId, entraName: c.entraName, domains: c.domains, stage: c.stage } });
    });
    this.deps.resolver.forgetEntra();
  }

  /** Alle Verbindungen aktualisieren (Plattform, z. B. nach neuem ENTRA_CLIENT_SECRET); auch die mit eigener App. */
  async refreshAll(s: Scope): Promise<{ refreshed: string[]; failed: { alias: string; detail: string }[] }> {
    const out = { refreshed: [] as string[], failed: [] as { alias: string; detail: string }[] };
    for (const t of await listTenants(this.deps.db)) {
      if (t.status !== 'active') continue;
      const has = await withTenant(this.deps.db, { tenantId: t.id }, async tx => !!(await tx.query(`SELECT 1 FROM ${this.S}.entra_connection`)).rowCount);
      if (!has) continue;
      try { await this.refresh({ ...s, alias: t.alias }); out.refreshed.push(t.alias); }
      catch (e) { out.failed.push({ alias: t.alias, detail: e instanceof HttpError ? e.detail ?? e.title : 'Fehler' }); }
    }
    return out;
  }
}

/** Geplante Verknüpfung eines Mitglieds: `entra` = zu verknüpfende Person, `reason` = warum nicht (null: verknüpft bzw. verknüpfbar). */
interface Plan { user: KcUser; entra: EntraUser | null; reason: string | null; passwordKept?: string }
