/** Konfiguration der Tests (Produkt `notes`) aus Umgebungswerten wie in einer App. */
import { iamConfig, IAM_VARS, readVars, type IamConfig } from '../../src/config.ts';

export function testConfig(issuer: string, env: Record<string, string> = {}): IamConfig {
  const { raw, mode, errors } = readVars({ NODE_ENV: 'test', OIDC_ISSUER_URL: issuer, DATABASE_URL: 'postgres://x@localhost/x', PUBLIC_BASE_URL: 'http://api.test', TENANT_AUTO_PROVISION: 'true', ...env }, IAM_VARS('notes'), null);
  if (errors.length) throw new Error(errors.join('\n'));
  return iamConfig(raw, mode);
}
