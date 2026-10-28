/**
 * Gerüst einer App mit dem Identity-Kit (Spezifikation 15.4): verwaltete Dateien aus `templates/managed` (Kopf
 * «Verwaltet von identity-kit», Prüfsumme in `.identity-kit.lock`, bei `sync` neu geschrieben) und Dateien der App aus
 * `templates/app` (nur angelegt, wenn sie fehlen; danach gehören sie der App). Eine von Hand geänderte verwaltete Datei
 * überschreibt `sync` nur mit `force`.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { CURRENT, LOCK_FILE, MANIFEST_FILE, fileHash, formatLock, lockErrors, manifestErrors, type Lock, type Manifest, type OperatorDefaults } from '@vollholz/iam-testkit';
import { realmFromOperator, THEME_TEXTS_FILE, themeTextsFile } from './operator.ts';

const PKG = join(import.meta.dirname, '..');
export const KIT_VERSION = (JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { version: string }).version;
const TEMPLATES = join(PKG, 'templates');

/** Teile, deren Versionen in die verwalteten Dateien eingesetzt werden. */
export const VERSIONS = {
  'product-realm': CURRENT['product-realm'],
  'product-realm-bootstrap': CURRENT['product-realm-bootstrap'],
  '@vollholz/iam': CURRENT['@vollholz/iam'],
  '@vollholz/iam-testkit': CURRENT['@vollholz/iam-testkit'],
};

export const managedMark = (kit = KIT_VERSION) =>
  `Verwaltet von identity-kit (create-iam-app ${kit}) – nicht von Hand ändern. Einstellungen: identity.app.json; neu schreiben: npx @vollholz/create-iam-app@${kit} sync`;

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name)).split('\\').join('/')]).sort();
}

const render = (text: string, vars: Record<string, string>) => text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => vars[k] ?? m);

/** Inhalt aller verwalteten Dateien dieser Version (Pfad → Text). */
export function managedFiles(): Map<string, string> {
  const files = walk(join(TEMPLATES, 'managed'));
  const list = files.map(f => `- \`${f}\``).join('\n');
  const vars = { MARK: managedMark(), KIT: KIT_VERSION, PRODUCT_REALM: VERSIONS['product-realm'], BOOTSTRAP: VERSIONS['product-realm-bootstrap'], MANAGED_FILES: list };
  return new Map(files.map(f => [f, render(readFileSync(join(TEMPLATES, 'managed', f), 'utf8'), vars)]));
}

export type Action = 'create' | 'update' | 'unchanged' | 'conflict' | 'remove' | 'keep';
export interface PlannedFile { path: string; action: Action; content?: string; reason?: string }

function readLock(dir: string): Lock | null {
  const file = join(dir, LOCK_FILE);
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const errors = lockErrors(data);
  if (errors.length) throw new Error(`${LOCK_FILE} ungültig:\n${errors.join('\n')}`);
  return data as Lock;
}

/**
 * Was `sync` täte: neue Dateien anlegen, unveränderte aktualisieren, von Hand geänderte melden (`conflict`), entfallene
 * verwaltete Dateien löschen (nur unverändert, sonst `keep`).
 */
export function planSync(dir: string): PlannedFile[] {
  const lock = readLock(dir);
  const want = managedFiles();
  const out: PlannedFile[] = [];
  for (const [path, content] of want) {
    const file = join(dir, path);
    if (!existsSync(file)) { out.push({ path, action: 'create', content }); continue; }
    const have = readFileSync(file, 'utf8');
    if (fileHash(have) === fileHash(content)) { out.push({ path, action: 'unchanged', content }); continue; }
    const pristine = lock?.files[path] !== undefined && fileHash(have) === lock.files[path];
    out.push(pristine ? { path, action: 'update', content } : { path, action: 'conflict', content, reason: lock?.files[path] ? 'von Hand geändert' : 'besteht schon, nicht vom Kit' });
  }
  for (const path of Object.keys(lock?.files ?? {})) {
    if (want.has(path) || !existsSync(join(dir, path))) continue;
    const pristine = fileHash(readFileSync(join(dir, path))) === lock!.files[path];
    out.push(pristine ? { path, action: 'remove' } : { path, action: 'keep', reason: 'entfällt im Kit, aber von Hand geändert – prüfen und selbst löschen' });
  }
  return out;
}

/** Plan ausführen und Lock-Datei schreiben; bei Konflikten ohne `force` Abbruch vor jeder Änderung. */
export function applySync(dir: string, plan: PlannedFile[], o: { force?: boolean } = {}): void {
  const conflicts = plan.filter(p => p.action === 'conflict');
  if (conflicts.length && !o.force) throw new Error(`Von Hand geänderte Dateien (Einstellungen gehören in ${MANIFEST_FILE}; überschreiben mit --force):\n${conflicts.map(c => `  ${c.path}: ${c.reason}`).join('\n')}`);
  const files: Record<string, string> = {};
  for (const p of plan) {
    const file = join(dir, p.path);
    if (p.action === 'remove') { rmSync(file); continue; }
    if (p.action === 'keep' || !p.content) continue;
    if (p.action !== 'unchanged') {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, p.content);
      if (p.path.endsWith('.sh')) chmodSync(file, 0o755);
    }
    files[p.path] = fileHash(p.content);
  }
  writeFileSync(join(dir, LOCK_FILE), formatLock({ kit: KIT_VERSION, versions: { ...VERSIONS }, files }));
}

export interface InitOptions {
  product: string;
  displayName: string;
  publicBaseUrl: string;
  keycloakUrl: string;
  entra?: boolean;
  state?: Manifest['state'];
  admin?: { alias: string; name?: string; email: string };
  /** Konto des Betriebs (Realm-Rolle platform-admin, ohne Organisation); nie dieselbe Adresse wie `admin`. */
  operator?: { email: string };
  /** Vorgaben des Betreibers (`--operator-defaults`): `realm.smtp`, `realm.theme`, `realm.themeTexts`. */
  operatorDefaults?: OperatorDefaults;
}

/** Manifest aus den Angaben von `init`. */
export function newManifest(o: InitOptions): Manifest {
  const m: Manifest = {
    $schema: './node_modules/@vollholz/iam-testkit/schema/identity-app.schema.json',
    product: o.product, displayName: o.displayName, publicBaseUrl: o.publicBaseUrl, keycloakUrl: o.keycloakUrl,
    realm: { entra: o.entra ?? false, m2m: false, mcp: false, smtp: null, ...(o.operatorDefaults ? realmFromOperator(o.operatorDefaults, o.displayName) : {}) },
    ...(o.state ? { state: o.state } : {}),
    ...(o.operator ? { operators: [{ email: o.operator.email }] } : {}),
    ...(o.admin ? { organizations: [{ alias: o.admin.alias, ...(o.admin.name ? { name: o.admin.name } : {}), admins: [{ email: o.admin.email }] }] } : {}),
  };
  const errors = manifestErrors(m);
  if (errors.length) throw new Error(`Angaben ungültig:\n${errors.join('\n')}`);
  return m;
}

export function readManifest(dir: string): Manifest {
  const file = join(dir, MANIFEST_FILE);
  if (!existsSync(file)) throw new Error(`${MANIFEST_FILE} fehlt (npx @vollholz/create-iam-app init legt es an)`);
  const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const errors = manifestErrors(data);
  if (errors.length) throw new Error(`${MANIFEST_FILE} ungültig:\n${errors.join('\n')}`);
  return data as Manifest;
}

/**
 * Dateien der App, nur wenn sie fehlen: Modell (Stufe «einfach»), passende `platform.json`, Ordner der Migrationen,
 * `.npmrc` für GitHub Packages, mit Vorgaben des Betreibers `infra/keycloak/theme-texts.json`; in `package.json` die
 * Pakete des Kits (exakt) und Skripte. Liefert die angelegten Pfade.
 */
export function appFiles(dir: string, m: Manifest, operatorDefaults: OperatorDefaults | null = null): string[] {
  const created: string[] = [];
  const add = (path: string, content: string) => {
    const file = join(dir, path);
    if (existsSync(file)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    created.push(path);
  };
  const model = m.paths?.model ?? 'src/authz/model.ts';
  add(model, render(readFileSync(join(TEMPLATES, 'app', 'src', 'authz', 'model.ts'), 'utf8'), { PRODUCT: m.product }));
  // Scopes der Vorlage; nach eigenen Änderungen am Modell neu schreiben (node infra/keycloak/platform.ts)
  add('infra/keycloak/platform.json', `${JSON.stringify({ scopes: [`${m.product}:read`, `${m.product}:write`] }, null, 2)}\n`);
  add(`${m.paths?.migrations ?? 'db/migrations'}/.gitkeep`, '');
  add('.npmrc', '@vollholz:registry=https://npm.pkg.github.com\n');
  add('.nvmrc', '24\n');
  // Texte des Themes (Vorlage des Betreibers oder Grundgerüst), wenn das Manifest auf die Datei zeigt
  if (m.realm?.themeTexts === THEME_TEXTS_FILE) add(THEME_TEXTS_FILE, themeTextsFile(m, operatorDefaults));

  const pkgFile = join(dir, 'package.json');
  const pkg: Record<string, unknown> = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown> : { name: m.product, private: true, type: 'module' };
  const deps = (pkg.dependencies ??= {}) as Record<string, string>;
  const dev = (pkg.devDependencies ??= {}) as Record<string, string>;
  const scripts = (pkg.scripts ??= {}) as Record<string, string>;
  const before = JSON.stringify(pkg);
  deps['@vollholz/iam'] ??= VERSIONS['@vollholz/iam'];
  if (!deps['@vollholz/iam-testkit']) dev['@vollholz/iam-testkit'] ??= VERSIONS['@vollholz/iam-testkit'];
  dev['@vollholz/create-iam-app'] ??= KIT_VERSION;
  scripts['identity:conformity'] ??= 'iam-conformity-test';
  scripts['identity:platform-json'] ??= 'node infra/keycloak/platform.ts > infra/keycloak/platform.json';
  scripts['identity:first-org'] ??= `iam-org-bootstrap --manifest ${MANIFEST_FILE}`;
  scripts['identity:sync'] ??= 'create-iam-app sync';
  if (JSON.stringify(pkg) !== before || !existsSync(pkgFile)) { writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`); created.push('package.json'); }
  return created;
}

export function writeManifest(dir: string, m: Manifest): void {
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(m, null, 2)}\n`);
}
