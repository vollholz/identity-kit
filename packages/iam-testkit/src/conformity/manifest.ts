/**
 * Manifest der App (`identity.app.json`, Spezifikation 1.2 und 15.4): die einzige Stelle, an der eine App ihr Setup
 * beschreibt. Was im Manifest steht, gehört zur Zone «Einstellbar»; was hier nicht vorkommt, ist «Fest» (Vertrag des
 * Kits) oder «App-eigen» (Modell, Ressourcen, Policies, Oberfläche). Die verwalteten Dateien von `create-iam-app`
 * (`infra/keycloak/*.tf`, Workflows) lesen ihre Werte zur Laufzeit aus dem Manifest; eine Änderung der Einstellungen
 * braucht deshalb kein neues Gerüst.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const MANIFEST_FILE = 'identity.app.json';
export const LOCK_FILE = '.identity-kit.lock';

const PRODUCT = '^(?!master$)[a-z][a-z0-9-]{1,30}[a-z0-9]$';
const ALIAS = '^[a-z0-9][a-z0-9_-]{0,62}$';
const SCOPE = '^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$';
const EMAIL = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';
const URL = '^https?://[^/\\s]+(/\\S*)?$';
const REASON = Type.String({ minLength: 3, description: 'Begründung' });

const Smtp = Type.Object({
  host: Type.String({ minLength: 1 }),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: 'Standard 587' })),
  from: Type.String({ pattern: EMAIL }),
  fromDisplayName: Type.Optional(Type.String({ description: 'Standard: displayName' })),
  replyTo: Type.Optional(Type.String()),
  starttls: Type.Optional(Type.Boolean({ description: 'Standard true' })),
  ssl: Type.Optional(Type.Boolean({ description: 'Standard false' })),
  user: Type.String({ minLength: 1, description: 'Konto beim Mailserver; Passwort nur als Secret SMTP_PASSWORD' }),
}, { additionalProperties: false, description: 'Eigenes Mailkonto der App (Einladungen, Passwort festlegen)' });

const MachineClient = Type.Object({
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  organizations: Type.Array(Type.String({ pattern: ALIAS }), { minItems: 1, uniqueItems: true }),
  scopes: Type.Optional(Type.Array(Type.String({ pattern: SCOPE }), { uniqueItems: true })),
}, { additionalProperties: false, description: 'Öffentlicher Schlüssel in infra/keycloak/keys/<client>.json; Rolle erst mit der Freigabe in der App' });

/** Schalter des Realm-Moduls, die eine App setzen darf (Zone «Einstellbar»). */
export const RealmSettingsSchema = Type.Object({
  theme: Type.Optional(Type.String({ minLength: 1, description: 'Theme auf der Keycloak-Instanz; leer: Standard-Theme' })),
  themeTexts: Type.Optional(Type.String({ description: 'Pfad (ab Wurzel des Repositorys) zu einer JSON-Datei { "<sprache>": { "<schlüssel>": "<text>" } }' })),
  localization: Type.Optional(Type.String({ description: 'Pfad zu weiteren Realm-Texten je Sprache (JSON, wie themeTexts)' })),
  supportedLocales: Type.Optional(Type.Array(Type.String({ pattern: '^[a-z]{2}(-[A-Z]{2})?$' }), { minItems: 1, uniqueItems: true, description: 'Standard ["de", "en"]' })),
  smtp: Type.Optional(Type.Union([Smtp, Type.Null()])),
  m2m: Type.Optional(Type.Boolean({ description: 'Maschinen-Clients der Organisationen (DPoP-Pflicht)' })),
  mcp: Type.Optional(Type.Boolean({ description: 'MCP-Dienst (Clients <produkt>-mcp und -mcp-cli)' })),
  mcpCallbackPort: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
  mcpExtraRedirectUris: Type.Optional(Type.Array(Type.String({ pattern: URL }), { uniqueItems: true })),
  entra: Type.Optional(Type.Boolean({ description: 'Anmeldung über Microsoft Entra ID je Organisation (eigene App der Organisation)' })),
  entraDenyMessage: Type.Optional(Type.String({ minLength: 1 })),
  machineClients: Type.Optional(Type.Record(Type.String({ pattern: '^[a-z0-9][a-z0-9._-]{2,62}$' }), MachineClient)),
}, { additionalProperties: false });

export const ManifestSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  product: Type.String({ pattern: PRODUCT, description: 'Technischer Name: Realm, Clients <produkt>-*, Datenbankrollen <produkt>_*' }),
  displayName: Type.String({ minLength: 1 }),
  publicBaseUrl: Type.String({ pattern: URL, description: 'PUBLIC_BASE_URL der App' }),
  keycloakUrl: Type.String({ pattern: URL, description: 'Keycloak-Instanz mit Basispfad, ohne /realms' }),
  realm: Type.Optional(RealmSettingsSchema),
  paths: Type.Optional(Type.Object({
    model: Type.Optional(Type.String({ description: 'Modul mit `export const model = defineModel(…)`; Standard src/authz/model.ts' })),
    migrations: Type.Optional(Type.String({ description: 'Migrationen der App; Standard db/migrations' })),
    packages: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: 'package.json-Dateien mit @vollholz/*; Standard ["package.json"]' })),
  }, { additionalProperties: false })),
  database: Type.Optional(Type.Object({
    schema: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9_]{0,62}$', description: 'Schema der Tabellen; Standard <produkt> mit «_»' })),
  }, { additionalProperties: false })),
  state: Type.Optional(Type.Object({
    bucket: Type.String({ minLength: 3 }),
    region: Type.String({ minLength: 1 }),
    endpoint: Type.String({ pattern: URL }),
    key: Type.Optional(Type.String({ pattern: '^[\\w./-]+\\.tfstate$', description: 'Schlüssel des Realm-States; Standard <produkt>/keycloak.tfstate (bestehende Apps: bisheriger Schlüssel)' })),
    bootstrapKey: Type.Optional(Type.String({ pattern: '^[\\w./-]+\\.tfstate$', description: 'Schlüssel des Bootstrap-States; Standard <produkt>/keycloak-bootstrap.tfstate' })),
  }, { additionalProperties: false, description: 'S3-Backend des OpenTofu-States' })),
  operators: Type.Optional(Type.Array(Type.Object({
    email: Type.String({ pattern: EMAIL }),
    first: Type.Optional(Type.String()),
    last: Type.Optional(Type.String()),
  }, { additionalProperties: false }), { minItems: 1, description: 'Betrieb: Konten mit der Realm-Rolle der Plattform-Administration, ohne Organisation (iam-org-bootstrap --manifest)' })),
  organizations: Type.Optional(Type.Array(Type.Object({
    alias: Type.String({ pattern: ALIAS }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    admins: Type.Array(Type.Object({
      email: Type.String({ pattern: EMAIL }),
      first: Type.Optional(Type.String()),
      last: Type.Optional(Type.String()),
    }, { additionalProperties: false }), { minItems: 1, description: 'org-admin der Organisation, nie die Plattform-Administration' }),
  }, { additionalProperties: false }), { minItems: 1, description: 'Erste Organisationen mit ihren Admins (iam-org-bootstrap --manifest)' })),
  exceptions: Type.Optional(Type.Object({
    files: Type.Optional(Type.Record(Type.String(), REASON, { description: 'Eigene Dateien in verwalteten Ordnern (z. B. infra/keycloak/moved.tf)' })),
    withoutTenant: Type.Optional(Type.Record(Type.String(), REASON, { description: 'Tabellen der App ohne tenant_id, auf die die Laufzeit Rechte hat' })),
    securityDefiner: Type.Optional(Type.Record(Type.String(), REASON, { description: 'SECURITY-DEFINER-Funktionen der App (Signatur schema.name(arg typen))' })),
  }, { additionalProperties: false, description: 'Begründete Abweichungen; jede wird im Konformitätstest angezeigt' })),
}, {
  $id: 'https://github.com/vollholz/identity-kit/packages/iam-testkit/schema/identity-app.schema.json',
  title: 'identity.app.json – Manifest einer App mit dem Identity-Kit',
  additionalProperties: false,
});

export type Manifest = Static<typeof ManifestSchema>;

/** Prüft ein Manifest; Fehlertexte mit JSON-Pfad. */
export function manifestErrors(data: unknown): string[] {
  if (!Value.Check(ManifestSchema, data)) return [...Value.Errors(ManifestSchema, data)].map(e => `${e.path || '/'}: ${e.message}`);
  const out: string[] = [];
  const m = data;
  const r = m.realm ?? {};
  if (Object.keys(r.machineClients ?? {}).length && !r.m2m) out.push('/realm/machineClients: braucht realm.m2m = true');
  const reserved = [...['platform', 'api', 'admin', 'sync', 'iac', 'tofu', 'mcp', 'mcp-cli'].map(s => `${m.product}-${s}`), ...BUILTIN_CLIENTS];
  for (const c of Object.keys(r.machineClients ?? {})) if (reserved.includes(c)) out.push(`/realm/machineClients/${c}: Client-ID ist für das Produkt oder Keycloak reserviert`);
  const seen = new Set<string>();
  (m.organizations ?? []).forEach((o, i) => { if (seen.has(o.alias)) out.push(`/organizations/${i}/alias: ${o.alias} doppelt`); seen.add(o.alias); });
  // Betrieb und Organisation nie mit demselben Konto (iam 3.0)
  const operators = new Set((m.operators ?? []).map(x => x.email.trim().toLowerCase()));
  (m.organizations ?? []).forEach((o, i) => o.admins.forEach((a, j) => {
    if (operators.has(a.email.trim().toLowerCase())) out.push(`/organizations/${i}/admins/${j}/email: ${a.email} ist Betrieb (operators) – für die Organisation eine andere Adresse verwenden`);
  }));
  return out;
}

/** Eingebaute Clients jedes Realms. */
export const BUILTIN_CLIENTS = ['account', 'account-console', 'admin-cli', 'admin-permissions', 'broker', 'realm-management', 'security-admin-console'];

/** Datenbank-Bezeichner des Produkts (`my-app` → `my_app`), wie `productIdent` im Backend-Paket. */
export const productIdent = (product: string) => product.replace(/-/g, '_');

/** Abgeleitete Werte mit Standards. */
export function resolved(m: Manifest) {
  return {
    product: m.product,
    ident: productIdent(m.product),
    schema: m.database?.schema ?? productIdent(m.product),
    model: m.paths?.model ?? 'src/authz/model.ts',
    migrations: m.paths?.migrations ?? 'db/migrations',
    packages: m.paths?.packages ?? ['package.json'],
    realm: { entra: false, m2m: false, mcp: false, machineClients: {}, ...m.realm },
  };
}
