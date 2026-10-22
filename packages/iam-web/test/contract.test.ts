/**
 * Vertrag (docs/entwurf.md › Teststrategie): Die Typen aus dem Auszug der OpenAPI sind aktuell; die eigentliche Prüfung
 * der Typen des Pakets steht in contract.check.ts und läuft mit `npm run typecheck`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import openapiTS, { astToString } from 'openapi-typescript';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, 'fixtures');

describe('Vertrag', () => {
  it('openapi-iam.d.ts ist aus openapi-iam.json erzeugt (npm run contract:types)', async () => {
    const spec = JSON.parse(readFileSync(join(dir, 'openapi-iam.json'), 'utf8'));
    const fresh = astToString(await openapiTS(spec));
    const committed = readFileSync(join(dir, 'openapi-iam.d.ts'), 'utf8');
    const body = (s: string) => s.slice(s.indexOf('export interface paths'));
    expect(body(committed)).toBe(body(fresh));
  });

  it('der Auszug enthält alle Endpunkte, die das Paket nutzt', () => {
    const spec = JSON.parse(readFileSync(join(dir, 'openapi-iam.json'), 'utf8')) as { paths: Record<string, unknown> };
    for (const p of ['/auth/me', '/auth/switch', '/auth/logout', '/v1/authz/catalog', '/v1/roles', '/v1/roles/{key}', '/v1/admin/status',
      '/v1/admin/members', '/v1/admin/clients', '/v1/admin/entra', '/v1/platform/organizations', '/v1/acl', '/v1/acl/effective', '/v1/people']) {
      expect(spec.paths, p).toHaveProperty([p]);
    }
  });
});
