/**
 * Gleicht den von Keycloak angelegten Mapper «organization» (Scope «organization») an die Soll-Konfiguration an –
 * idempotent; aufgerufen von OpenTofu (scopes.tf, terraform_data.organization_mapper), wenn sich die Soll-Konfiguration
 * oder der Scope ändert. Keine Abhängigkeiten ausser Node.
 *
 * Umgebung: KEYCLOAK_URL (mit Basispfad), KEYCLOAK_REALM, KEYCLOAK_IAC_CLIENT_ID, ORGANIZATION_MAPPER (JSON der
 *           Soll-Konfiguration; alle aus scopes.tf), KEYCLOAK_IAC_PRIVATE_KEY (PEM, von kc.sh)
 */
import { adminApi, need } from './admin-api.ts';

const want = JSON.parse(need('ORGANIZATION_MAPPER')) as Record<string, string>;
const { kc } = await adminApi(need('KEYCLOAK_URL'), need('KEYCLOAK_REALM'), need('KEYCLOAK_IAC_CLIENT_ID'));

interface Mapper { id: string; name: string; protocol: string; protocolMapper: string; config: Record<string, string> }
const scope = (await kc<{ id: string; name: string }[]>('GET', '/client-scopes')).find(s => s.name === 'organization');
if (!scope) throw new Error('Scope «organization» fehlt im Realm');
const mappers = await kc<Mapper[]>('GET', `/client-scopes/${scope.id}/protocol-mappers/models`);
const m = mappers.find(x => x.protocolMapper === 'oidc-organization-membership-mapper');
if (!m) throw new Error('Mapper vom Typ oidc-organization-membership-mapper fehlt im Scope «organization»');

const diff = Object.entries(want).filter(([k, v]) => m.config[k] !== v).map(([k]) => k);
if (diff.length === 0) {
  console.log(`Mapper «${m.name}»: aktuell`);
} else {
  await kc('PUT', `/client-scopes/${scope.id}/protocol-mappers/models/${m.id}`, { ...m, config: { ...m.config, ...want } });
  const after = (await kc<Mapper[]>('GET', `/client-scopes/${scope.id}/protocol-mappers/models`)).find(x => x.id === m.id)!;
  const still = Object.entries(want).filter(([k, v]) => after.config[k] !== v).map(([k]) => k);
  if (still.length) throw new Error(`Mapper «${m.name}»: nach dem Abgleich weichen noch ab: ${still.join(', ')}`);
  console.log(`Mapper «${m.name}»: abgeglichen (${diff.join(', ')})`);
}
