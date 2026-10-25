/**
 * Interne ID eines Clients im Realm (für admin.tf, data "external"). Ersetzt data "keycloak_openid_client" für die
 * eingebauten Clients realm-management und admin-permissions: der Provider liest dabei das Client-Secret, was
 * Keycloak ab 26.8 verweigert (403). Hier wird kein Secret gelesen. Keine Abhängigkeiten ausser Node.
 *
 *   stdin  {"client_id": "realm-management", "url": "https://id.example.ch", "realm": "<produkt>", "iac_client_id": "<produkt>-iac"}
 *   stdout {"id": "<uuid>"}
 *
 * Anmeldung als IaC-Client (admin-api.ts); privater Schlüssel aus KEYCLOAK_IAC_PRIVATE_KEY.
 */
import { readFileSync } from 'node:fs';
import { adminApi } from './admin-api.ts';

const q = JSON.parse(readFileSync(0, 'utf8')) as Record<string, unknown>;
const missing = ['client_id', 'url', 'realm', 'iac_client_id'].filter(k => typeof q[k] !== 'string' || q[k] === '');
if (missing.length) throw new Error(`lookup.ts: Abfrage ohne ${missing.join(', ')}`);
const query = q as { client_id: string; url: string; realm: string; iac_client_id: string };
const api = await adminApi(query.url, query.realm, query.iac_client_id);
const list = await api.kc<{ id: string }[]>('GET', `/clients?clientId=${encodeURIComponent(query.client_id)}`);
if (list.length !== 1) throw new Error(`Client ${query.client_id} im Realm ${query.realm} nicht gefunden`);
process.stdout.write(JSON.stringify({ id: list[0]!.id }));
