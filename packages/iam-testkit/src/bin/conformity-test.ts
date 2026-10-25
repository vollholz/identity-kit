#!/usr/bin/env node
/**
 * `iam-conformity-test`: Hält die App den Vertrag des Identity-Kits ein? (Spezifikation 14.1, Abnahme P15)
 *
 *   npx iam-conformity-test                      Ebene Repository (Standard; ohne Geheimnisse, für jeden Pull Request)
 *   npx iam-conformity-test --db                 zusätzlich Datenbank (CONFORMITY_DATABASE_URL oder DATABASE_ADMIN_URL)
 *   npx iam-conformity-test --realm              zusätzlich Realm (Admin-API, nur lesend)
 *   npx iam-conformity-test --all                alle drei Ebenen
 *   npx iam-conformity-test --realm --no-repo --product <produkt>   nur Realm, ohne Manifest (zentral beim Betreiber)
 *
 * Weitere Schalter: --dir <pfad> (Wurzel der App, Standard .), --json, --markdown <datei> (Tabelle anhängen, z. B.
 * $GITHUB_STEP_SUMMARY), --strict (Warnungen zählen als Fehler), --skip-model (Modell nicht laden).
 * Realm-Anmeldung (private_key_jwt, ES256): KEYCLOAK_CONFORMITY_URL (sonst KEYCLOAK_TF_URL, sonst keycloakUrl des
 * Manifests), KEYCLOAK_CONFORMITY_REALM (Standard: Realm der App), KEYCLOAK_CONFORMITY_CLIENT_ID (Standard
 * <produkt>-iac), KEYCLOAK_CONFORMITY_PRIVATE_KEY bzw. _B64 (sonst KEYCLOAK_IAC_PRIVATE_KEY bzw. _B64).
 * Exit-Code: 0 konform (Warnungen erlaubt), 1 Befunde, 64 Aufruf falsch, 2 Prüfung nicht möglich.
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { dbChecks } from '../conformity/db.ts';
import { productIdent, resolved, type Manifest } from '../conformity/manifest.ts';
import { adminReader, realmChecks } from '../conformity/realm.ts';
import { repoChecks, loadManifest } from '../conformity/repo.ts';
import { exitCode, formatMarkdown, formatText, type Finding } from '../conformity/report.ts';

const fail = (m: string, code = 64): never => { console.error(`iam-conformity-test: ${m}`); process.exit(code); };
let a;
try {
  a = parseArgs({
    options: {
      dir: { type: 'string', default: '.' }, product: { type: 'string' },
      db: { type: 'boolean', default: false }, realm: { type: 'boolean', default: false }, all: { type: 'boolean', default: false },
      'no-repo': { type: 'boolean', default: false }, 'skip-model': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false }, markdown: { type: 'string' }, strict: { type: 'boolean', default: false },
    },
  }).values;
} catch (e) { fail((e as Error).message); }
const o = a!;
const env = process.env;
const dir = resolve(o.dir);
const repo = !o['no-repo'];
const withDb = o.db || o.all, withRealm = o.realm || o.all;
if (!repo && !withDb && !withRealm) fail('nichts zu prüfen: --no-repo braucht --db oder --realm');

const findings: Finding[] = [];
let manifest: Manifest | null = null;
try {
  if (repo) {
    const r = await repoChecks(dir, { skipModel: o['skip-model'] });
    findings.push(...r.findings);
    manifest = r.manifest;
  }
  else if (!o.product) manifest = loadManifest(dir, findings);
} catch (e) { fail(`Repository: ${(e as Error).message}`, 2); }

const product = o.product ?? manifest?.product;
if ((withDb || withRealm) && !product) fail('Produkt unbekannt: gültiges identity.app.json oder --product');
if (o.product && manifest && o.product !== manifest.product) fail(`--product ${o.product} ≠ product ${manifest.product} im Manifest`);

if (withDb) {
  const url = env.CONFORMITY_DATABASE_URL || env.DATABASE_ADMIN_URL || fail('--db: CONFORMITY_DATABASE_URL oder DATABASE_ADMIN_URL fehlt');
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: url, application_name: 'iam-conformity-test' });
  try {
    await c.connect();
    const r = manifest ? resolved(manifest) : null;
    findings.push(...await dbChecks(c, { ident: productIdent(product!), schema: r?.schema ?? productIdent(product!), appDir: dir, exceptions: manifest?.exceptions }));
  } catch (e) { fail(`Datenbank: ${(e as Error).message}`, 2); } finally { await c.end().catch(() => undefined); }
}

if (withRealm) {
  const baseUrl = env.KEYCLOAK_CONFORMITY_URL || env.KEYCLOAK_TF_URL || manifest?.keycloakUrl || fail('--realm: KEYCLOAK_CONFORMITY_URL fehlt');
  const b64 = env.KEYCLOAK_CONFORMITY_PRIVATE_KEY_B64 || env.KEYCLOAK_IAC_PRIVATE_KEY_B64;
  const privateKey = env.KEYCLOAK_CONFORMITY_PRIVATE_KEY || (env.KEYCLOAK_CONFORMITY_PRIVATE_KEY_B64 ? undefined : env.KEYCLOAK_IAC_PRIVATE_KEY)
    || (b64 ? Buffer.from(b64, 'base64').toString('utf8') : fail('--realm: KEYCLOAK_CONFORMITY_PRIVATE_KEY(_B64) bzw. KEYCLOAK_IAC_PRIVATE_KEY(_B64) fehlt'));
  const kc = adminReader({ baseUrl, loginRealm: env.KEYCLOAK_CONFORMITY_REALM || product!, clientId: env.KEYCLOAK_CONFORMITY_CLIENT_ID || `${product}-iac`, privateKey });
  try { findings.push(...await realmChecks(kc, { product: product!, manifest })); } catch (e) { fail(`Realm: ${(e as Error).message}`, 2); }
}

const title = `Konformität ${product ?? dir} mit dem Identity-Kit`;
if (o.json) process.stdout.write(`${JSON.stringify({ product: product ?? null, findings }, null, 2)}\n`);
else process.stdout.write(formatText(findings, title));
if (o.markdown) appendFileSync(o.markdown, formatMarkdown(findings, title));
process.exit(exitCode(findings, o.strict));
