/**
 * {{MARK}}
 *
 * Scopes der App als JSON für das Realm-Modul (platform.json): `model.platformJson()` aus @vollholz/iam. Pfad des
 * Modells aus identity.app.json › paths.model (Standard src/authz/model.ts). iam-conformity-test prüft, dass die Datei
 * aktuell ist.
 *
 *   node infra/keycloak/platform.ts > infra/keycloak/platform.json
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'identity.app.json'), 'utf8')) as { paths?: { model?: string } };
const { model } = await import(pathToFileURL(join(root, manifest.paths?.model ?? 'src/authz/model.ts')).href) as { model: { platformJson(): string } };
process.stdout.write(model.platformJson());
