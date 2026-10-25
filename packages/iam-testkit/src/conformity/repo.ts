/**
 * Konformität auf Ebene Repository (ohne Geheimnisse, in jedem Pull Request): Manifest, verwaltete Dateien gegen die
 * Lock-Datei, gepinnte und unterstützte Versionen, Modell und `platform.json`, eigene Dateien in verwalteten Ordnern.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOCK_FILE, MANIFEST_FILE, manifestErrors, resolved, type Manifest } from './manifest.ts';
import { fileHash, lockErrors, MANAGED_MARK, type Lock } from './lock.ts';
import { finding, type Finding } from './report.ts';
import { MINIMUM, newer, versionProblem, type Part } from './support.ts';
import { checkModel, type AuthzModel } from '../model.ts';

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
const rel = (dir: string, file: string) => relative(dir, file).split('\\').join('/');

/** Manifest lesen und prüfen; `null`, wenn es fehlt oder ungültig ist (Befund in `findings`). */
export function loadManifest(dir: string, findings: Finding[]): Manifest | null {
  const base = { level: 'repo', check: 'Manifest vorhanden und gültig', zone: 'fest', source: `identity-kit · ${MANIFEST_FILE}` } as const;
  const file = join(dir, MANIFEST_FILE);
  if (!existsSync(file)) { findings.push(finding(base, [`${MANIFEST_FILE} fehlt (npx create-iam-app legt es an)`])); return null; }
  let data: unknown;
  try { data = readJson(file); } catch (e) { findings.push(finding(base, [`${MANIFEST_FILE}: ${(e as Error).message}`])); return null; }
  const errors = manifestErrors(data);
  findings.push(finding(base, errors));
  return errors.length ? null : data as Manifest;
}

function loadLock(dir: string, findings: Finding[]): Lock | null {
  const base = { level: 'repo', check: 'Lock-Datei vorhanden und gültig', zone: 'fest', source: `identity-kit · ${LOCK_FILE}` } as const;
  const file = join(dir, LOCK_FILE);
  if (!existsSync(file)) { findings.push(finding(base, [`${LOCK_FILE} fehlt (npx create-iam-app sync schreibt sie)`])); return null; }
  let data: unknown;
  try { data = readJson(file); } catch (e) { findings.push(finding(base, [`${LOCK_FILE}: ${(e as Error).message}`])); return null; }
  const errors = lockErrors(data);
  findings.push(finding(base, errors));
  return errors.length ? null : data as Lock;
}

/** Verwaltete Dateien unverändert, keine fehlt. */
export function managedFileProblems(dir: string, lock: Lock): string[] {
  const out: string[] = [];
  for (const [path, hash] of Object.entries(lock.files)) {
    const file = join(dir, path);
    if (!existsSync(file)) { out.push(`${path} fehlt`); continue; }
    if (fileHash(readFileSync(file)) !== hash) out.push(`${path} von Hand geändert (Einstellungen gehören in ${MANIFEST_FILE}; zurück mit npx create-iam-app sync)`);
  }
  return out;
}

/**
 * Eigene Dateien in Ordnern mit verwalteten OpenTofu-Dateien (`*.tf`, `*.tf.json`): Sie könnten am Modul vorbei
 * Ressourcen im Realm anlegen. Erlaubt nur mit Begründung in `exceptions.files`; jede Ausnahme muss noch bestehen.
 */
export function unmanagedFileProblems(dir: string, lock: Lock, exceptions: Record<string, string>): string[] {
  const dirs = new Set(Object.keys(lock.files).filter(p => p.endsWith('.tf')).map(p => dirname(p)));
  const out: string[] = [];
  for (const d of [...dirs].sort()) {
    const abs = join(dir, d);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs).sort()) {
      if (!/\.tf(\.json)?$/.test(f)) continue;
      const path = d === '.' ? f : `${d}/${f}`;
      if (!lock.files[path] && !exceptions[path]) out.push(`${path}: eigene Datei neben den verwalteten (Realm nur über das Modul; sonst begründen in exceptions.files)`);
    }
  }
  for (const path of Object.keys(exceptions)) if (!existsSync(join(dir, path))) out.push(`Ausnahme ${path} veraltet (Datei fehlt)`);
  return out;
}

/** Pakete `@vollholz/*` exakt gepinnt und im unterstützten Fenster; Backend und Test-Kit vorhanden. */
function packageFindings(dir: string, files: string[]): Finding[] {
  const problems: string[] = [], hints: string[] = [];
  const found = new Map<string, string>();
  for (const f of files) {
    const file = join(dir, f);
    if (!existsSync(file)) { problems.push(`${f} fehlt (paths.packages im Manifest)`); continue; }
    const pkg = readJson(file) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (!name.startsWith('@vollholz/')) continue;
        found.set(name, spec);
        if (!(name in MINIMUM)) { problems.push(`${f}: ${name} ist kein Teil des Kits`); continue; }
        const p = versionProblem(name as Part, spec);
        if (p) problems.push(`${f}: ${p}`);
        const n = newer(name as Part, spec);
        if (n) hints.push(`${f}: ${name} ${spec} → ${n} verfügbar`);
      }
    }
  }
  if (!found.has('@vollholz/iam')) problems.push('@vollholz/iam fehlt (Backend des Kits)');
  if (!found.has('@vollholz/iam-testkit')) problems.push('@vollholz/iam-testkit fehlt (Tests und Konformität)');
  const base = { level: 'repo', check: 'Pakete gepinnt und unterstützt', zone: 'fest', source: 'identity-kit · Unterstützte Versionen' } as const;
  return [finding(base, problems), ...(hints.length ? [{ ...base, check: 'Neuere Versionen des Kits', status: 'warn' as const, details: hints }] : [])];
}

const MODULE_REF = /identity-kit\.git\/\/modules\/([a-z-]+)\?ref=([a-z-]+)-v(\d+\.\d+\.\d+)/g;

/** Versionen der Realm-Module in allen `.tf` unter `infra/keycloak`. */
export function moduleRefs(dir: string): { file: string; module: string; tag: string; version: string }[] {
  const root = join(dir, 'infra', 'keycloak');
  const out: { file: string; module: string; tag: string; version: string }[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) walk(join(d, e.name));
      else if (e.isFile() && e.name.endsWith('.tf')) {
        for (const m of readFileSync(join(d, e.name), 'utf8').matchAll(MODULE_REF)) out.push({ file: rel(dir, join(d, e.name)), module: m[1]!, tag: m[2]!, version: m[3]! });
      }
    }
  };
  walk(root);
  return out;
}

function moduleFinding(dir: string): Finding {
  const refs = moduleRefs(dir);
  const problems: string[] = [];
  if (!refs.some(r => r.module === 'product-realm')) problems.push('infra/keycloak: Modul product-realm nicht eingebunden');
  if (!refs.some(r => r.module === 'product-realm-bootstrap')) problems.push('infra/keycloak/bootstrap: Modul product-realm-bootstrap nicht eingebunden');
  for (const r of refs) {
    if (r.module !== r.tag) problems.push(`${r.file}: Modul ${r.module} mit Tag ${r.tag}-v${r.version}`);
    else if (!(r.module in MINIMUM)) problems.push(`${r.file}: unbekanntes Modul ${r.module}`);
    else { const p = versionProblem(r.module as Part, r.version); if (p) problems.push(`${r.file}: ${p}`); }
  }
  return finding({ level: 'repo', check: 'Realm-Module gepinnt und unterstützt', zone: 'fest', source: 'identity-kit · Unterstützte Versionen' }, problems);
}

interface ModelLike { product: string; toJSON(): unknown; platformJson(): string; features?: { members?: boolean } }

/** Modell der App laden (TypeScript direkt mit Node 24) und mit `checkModel` prüfen; `platform.json` aktuell. */
async function modelFindings(dir: string, m: Manifest): Promise<Finding[]> {
  const r = resolved(m);
  const base = { level: 'repo', check: 'Modell nach den Regeln M1–M13', zone: 'app', source: `${r.model} (App) · Regeln: identity-kit` } as const;
  const file = join(dir, r.model);
  if (!existsSync(file)) return [finding(base, [`${r.model} fehlt (paths.model im Manifest)`])];
  let model: ModelLike;
  try {
    const mod = await import(pathToFileURL(file).href) as { model?: ModelLike };
    if (!mod.model || typeof mod.model.toJSON !== 'function' || typeof mod.model.platformJson !== 'function') return [finding(base, [`${r.model} exportiert kein model = defineModel(…)`])];
    model = mod.model;
  } catch (e) {
    return [finding(base, [`${r.model} lässt sich nicht laden: ${(e as Error).message.split('\n')[0]}`])];
  }
  const out: Finding[] = [];
  const platform = join(dir, 'infra', 'keycloak', 'platform.json');
  const check = checkModel(model.toJSON() as AuthzModel, { product: m.product, members: model.features?.members !== false, ...(existsSync(platform) ? { platformJson: readFileSync(platform, 'utf8') } : {}) });
  const errors = [...check.errors];
  if (model.product !== m.product) errors.push(`model.product «${model.product}» ≠ product «${m.product}» im Manifest`);
  out.push(finding(base, errors));
  if (check.warnings.length) out.push({ ...base, check: 'Modell: SOLL-Regeln', status: 'warn', details: check.warnings });
  const pj = { level: 'repo', check: 'platform.json aus dem Modell', zone: 'fest', source: 'identity-kit · Realm-Modul (Scopes)' } as const;
  if (!existsSync(platform)) out.push(finding(pj, ['infra/keycloak/platform.json fehlt (node infra/keycloak/platform.ts > infra/keycloak/platform.json)']));
  else out.push(finding(pj, readFileSync(platform, 'utf8') === model.platformJson() ? [] : ['infra/keycloak/platform.json ≠ model.platformJson() (neu schreiben: node infra/keycloak/platform.ts > infra/keycloak/platform.json)']));
  return out;
}

function settingsFinding(m: Manifest): Finding {
  const r = resolved(m);
  const on = Object.entries({ entra: r.realm.entra, m2m: r.realm.m2m, mcp: r.realm.mcp, smtp: !!r.realm.smtp }).filter(([, v]) => v).map(([k]) => k);
  const details = [`Schalter: ${on.length ? on.join(', ') : 'keine'}`, `Maschinen-Clients: ${Object.keys(r.realm.machineClients ?? {}).join(', ') || 'keine'}`];
  const ex = m.exceptions ?? {};
  for (const [kind, list] of [['Datei', ex.files], ['Tabelle ohne tenant_id', ex.withoutTenant], ['SECURITY DEFINER', ex.securityDefiner]] as const) {
    for (const [k, why] of Object.entries(list ?? {})) details.push(`Ausnahme ${kind} ${k}: ${why}`);
  }
  return { level: 'repo', check: 'Einstellungen der App', zone: 'einstellbar', source: MANIFEST_FILE, status: 'ok', details };
}

export interface RepoOptions {
  /** Modell nicht laden (z. B. ohne installierte Abhängigkeiten). */
  skipModel?: boolean;
}

/** Alle Prüfungen der Ebene Repository. */
export async function repoChecks(dir: string, o: RepoOptions = {}): Promise<{ findings: Finding[]; manifest: Manifest | null }> {
  const findings: Finding[] = [];
  const manifest = loadManifest(dir, findings);
  const lock = loadLock(dir, findings);
  if (lock) {
    findings.push(finding({ level: 'repo', check: 'Verwaltete Dateien unverändert', zone: 'fest', source: `identity-kit · create-iam-app ${lock.kit}` }, managedFileProblems(dir, lock)));
    findings.push(finding({ level: 'repo', check: 'Keine eigenen Dateien in verwalteten Ordnern', zone: 'fest', source: 'identity-kit · Realm nur über das Modul' }, unmanagedFileProblems(dir, lock, manifest?.exceptions?.files ?? {})));
    const kit = versionProblem('@vollholz/create-iam-app', lock.kit);
    const hint = newer('@vollholz/create-iam-app', lock.kit);
    findings.push(kit ? finding({ level: 'repo', check: 'Gerüst unterstützt', zone: 'fest', source: 'identity-kit · Unterstützte Versionen' }, [kit])
      : { level: 'repo', check: 'Gerüst unterstützt', zone: 'fest', source: 'identity-kit · Unterstützte Versionen', status: hint ? 'warn' : 'ok', details: hint ? [`create-iam-app ${lock.kit} → ${hint} verfügbar (npx @vollholz/create-iam-app@${hint} sync)`] : [] });
  }
  // Ohne Manifest bleiben alle Prüfungen offen, die seine Werte brauchen
  findings.push(...packageFindings(dir, manifest ? resolved(manifest).packages : ['package.json']));
  findings.push(moduleFinding(dir));
  if (manifest) {
    findings.push(settingsFinding(manifest));
    if (o.skipModel) findings.push({ level: 'repo', check: 'Modell nach den Regeln M1–M13', zone: 'app', source: resolved(manifest).model, status: 'skip', details: ['--skip-model'] });
    else findings.push(...await modelFindings(dir, manifest));
  }
  // Verwaltete Dateien ohne Eintrag in der Lock-Datei (z. B. kopiert statt erzeugt)
  if (lock) {
    const stray = ['infra/keycloak', 'infra/keycloak/bootstrap', '.github/workflows'].flatMap(d => {
      const abs = join(dir, d);
      return existsSync(abs) ? readdirSync(abs, { withFileTypes: true }).filter(e => e.isFile()).map(e => `${d}/${e.name}`) : [];
    }).filter(p => !lock.files[p] && readFileSync(join(dir, p), 'utf8').slice(0, 400).includes(MANAGED_MARK));
    if (stray.length) findings.push({ level: 'repo', check: 'Kopf «verwaltet» nur an verwalteten Dateien', zone: 'fest', source: `identity-kit · ${LOCK_FILE}`, status: 'warn', details: stray.map(p => `${p} trägt den Kopf, steht aber nicht in ${LOCK_FILE}`) });
  }
  return { findings, manifest };
}
