#!/usr/bin/env node
/**
 * `create-iam-app`: Gerüst einer App mit dem Identity-Kit (Spezifikation 15.4).
 *
 *   npx @vollholz/create-iam-app init --product notes --name Notes --url https://notes.example.ch \
 *       --keycloak https://id.example.ch [--entra] [--admin anna@example.ch --org solutions [--org-name "Solutions"]] \
 *       [--operator betrieb@example.ch]   Betrieb (platform-admin, ohne Organisation; nie dieselbe Adresse wie --admin) \
 *       [--state-bucket <bucket> --state-region <region> --state-endpoint <url>]
 *       identity.app.json (falls es fehlt), verwaltete Dateien, Dateien der App (Modell, platform.json, …), Lock-Datei
 *   npx @vollholz/create-iam-app sync [--force]     verwaltete Dateien auf diese Version bringen (nach einem Upgrade)
 *   npx @vollholz/create-iam-app check              nur zeigen, was sync ändern würde (Code 1, wenn etwas)
 *   npx @vollholz/create-iam-app keys [--secret-dir <pfad>]
 *       fehlende Schlüsselpaare: öffentlich nach infra/keycloak/keys/, privat nach ~/.identity/<produkt>/ (0600)
 *
 * Alle: [--dir <pfad>] (Wurzel der App, Standard .). Code 0 ok, 1 Befund (check, Konflikt), 64 Aufruf falsch.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { MANIFEST_FILE } from '@vollholz/iam-testkit';
import { generateKeys } from '../keys.ts';
import { appFiles, applySync, KIT_VERSION, newManifest, planSync, readManifest, writeManifest, type PlannedFile } from '../scaffold.ts';

const fail = (m: string, code = 64): never => { console.error(`create-iam-app: ${m}`); process.exit(code); };
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string', default: '.' }, force: { type: 'boolean', default: false },
      product: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' }, keycloak: { type: 'string' }, entra: { type: 'boolean', default: false },
      admin: { type: 'string' }, org: { type: 'string' }, 'org-name': { type: 'string' }, operator: { type: 'string' },
      'state-bucket': { type: 'string' }, 'state-region': { type: 'string' }, 'state-endpoint': { type: 'string' },
      'secret-dir': { type: 'string' },
    },
  });
} catch (e) { fail((e as Error).message); }
const { values: a, positionals } = parsed!;
const cmd = positionals[0] ?? 'init';
if (positionals.length > 1 || !['init', 'sync', 'check', 'keys'].includes(cmd)) fail(`unbekannter Befehl «${positionals.join(' ')}» (init, sync, check, keys)`);
const dir = resolve(a.dir);
const label: Record<PlannedFile['action'], string> = { create: 'neu', update: 'aktualisiert', unchanged: 'unverändert', conflict: 'KONFLIKT', remove: 'gelöscht', keep: 'behalten' };
const show = (plan: PlannedFile[]) => { for (const p of plan) if (p.action !== 'unchanged') console.log(`  ${label[p.action].padEnd(12)} ${p.path}${p.reason ? ` (${p.reason})` : ''}`); };

try {
  if (cmd === 'init') {
    if (!existsSync(join(dir, MANIFEST_FILE))) {
      const need = (k: 'product' | 'name' | 'url' | 'keycloak') => a[k] ?? fail(`init: --${k} fehlt (oder ${MANIFEST_FILE} anlegen)`);
      const state = a['state-bucket'] ? { bucket: a['state-bucket'], region: a['state-region'] ?? fail('--state-region fehlt'), endpoint: a['state-endpoint'] ?? fail('--state-endpoint fehlt') } : undefined;
      if (a.admin && !a.org) fail('--admin braucht --org (Alias der ersten Organisation)');
      const m = newManifest({
        product: need('product'), displayName: need('name'), publicBaseUrl: need('url'), keycloakUrl: need('keycloak'), entra: a.entra, state,
        admin: a.admin ? { alias: a.org!, name: a['org-name'], email: a.admin } : undefined,
        operator: a.operator ? { email: a.operator } : undefined,
      });
      writeManifest(dir, m);
      console.log(`${MANIFEST_FILE} angelegt`);
    } else if (a.product || a.name || a.url || a.keycloak) fail(`${MANIFEST_FILE} besteht schon: Einstellungen dort ändern`);
    const m = readManifest(dir);
    const plan = planSync(dir);
    applySync(dir, plan, { force: a.force });
    console.log(`Verwaltete Dateien (create-iam-app ${KIT_VERSION}):`);
    show(plan);
    for (const f of appFiles(dir, m)) console.log(`  App          ${f}`);
    console.log(`
Nächste Schritte (docs/identity-kit.md, Leitfaden: identity-kit › docs/neue-app.md):
  1. npm install
  2. npx create-iam-app keys            Schlüsselpaare; ${m.product}-tofu.json an den Betreiber der Keycloak-Instanz
  3. identity.app.json › state           S3-Backend des OpenTofu-States${m.state ? ' (gesetzt)' : ' (fehlt noch)'}
  4. infra/keycloak/kc.sh bootstrap init && infra/keycloak/kc.sh bootstrap apply   (lokal, als ${m.product}-tofu)
  5. Betreiber: realm-admin für ${m.product}-iac; dann Workflow «Keycloak»
  6. Migrationen, dann npm run identity:first-org und npx iam-conformity-test --all`);
  } else if (cmd === 'sync' || cmd === 'check') {
    readManifest(dir);
    const plan = planSync(dir);
    const changes = plan.filter(p => p.action !== 'unchanged');
    if (cmd === 'check') {
      if (!changes.length) { console.log(`Verwaltete Dateien entsprechen create-iam-app ${KIT_VERSION}.`); process.exit(0); }
      console.log(`sync würde ändern (create-iam-app ${KIT_VERSION}):`);
      show(plan);
      process.exit(1);
    }
    applySync(dir, plan, { force: a.force });
    console.log(changes.length ? `Verwaltete Dateien auf create-iam-app ${KIT_VERSION}:` : `Nichts zu tun (create-iam-app ${KIT_VERSION}).`);
    show(plan);
  } else {
    const m = readManifest(dir);
    const secretDir = resolve(a['secret-dir'] ?? join(homedir(), '.identity', m.product));
    const r = generateKeys(dir, m, secretDir);
    for (const k of r.created) console.log(`  neu          ${k.client}: öffentlich ${k.publicFile}, privat ${k.privateFile}`);
    for (const s of r.skipped) console.log(`  vorhanden    ${s}`);
    console.log(`
Private Schlüssel liegen nur in ${secretDir} (nie ins Repository):
  - ${m.product}-tofu: öffentlichen Teil ${join(secretDir, `${m.product}-tofu.json`)} an den Betreiber (PR in dessen Repository);
    privat nur lokal als KEYCLOAK_TF_PRIVATE_KEY_B64 in .env – nie als CI-Secret
  - ${m.product}-iac: GitHub-Secret KEYCLOAK_IAC_PRIVATE_KEY (Environment production), lokal KEYCLOAK_IAC_PRIVATE_KEY_B64
  - ${m.product}-platform / -admin / -sync${m.realm?.mcp ? ' / -mcp' : ''}: Konfiguration der App (OIDC_BFF_PRIVATE_KEY, KEYCLOAK_MGMT_PRIVATE_KEY, KEYCLOAK_SYNC_PRIVATE_KEY)`);
  }
} catch (e) {
  fail((e as Error).message, 1);
}
