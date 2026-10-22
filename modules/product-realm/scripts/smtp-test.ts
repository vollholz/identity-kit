/**
 * Testmail über die SMTP-Einstellungen des Realms senden (Admin-API testSMTPConnection), ohne Konsole und ohne Passwort.
 * Aufruf aus kc.sh der App (Pfad nach `tofu init`: .terraform/modules/<name>/modules/product-realm/scripts/smtp-test.ts):
 *
 *   node smtp-test.ts <empfänger> [--env-password] [--user=<name>]
 *
 * --env-password: statt des gespeicherten Passworts das aus der Umgebung (TF_VAR_smtp_password, wie für den Apply)
 * verwenden; zeigt, ob ein Fehler am gespeicherten Wert oder am Zugang selbst liegt. --user=<name>: anderen
 * Benutzernamen testen.
 *
 * Keycloak schickt die Testmail an die E-Mail-Adresse des angemeldeten Kontos. Ein Service Account hat keine, und die
 * Konsole kann den Test für Admins aus dem Realm master nicht auslösen (Konto im Realm des Produkts nicht vorhanden).
 * Deshalb erhält der IaC-Client für die Dauer des Tests die Empfängeradresse (nicht verifiziert), danach wird der
 * vorherige Stand wiederhergestellt. Getestet wird die gespeicherte Konfiguration des Realms; das Passwort bleibt
 * maskiert und Keycloak setzt das gespeicherte ein.
 *
 * Umgebung wie die übrigen Skripte (admin-api.ts): KEYCLOAK_URL (mit Basispfad), KEYCLOAK_REALM, KEYCLOAK_IAC_CLIENT_ID,
 * KEYCLOAK_IAC_PRIVATE_KEY; Aufruf aus kc.sh: README.md › Aufruf.
 */
import { adminApi, need } from './admin-api.ts';

const to = (process.argv[2] ?? '').trim();
const envPassword = process.argv.includes('--env-password');
const userOverride = process.argv.find((a) => a.startsWith('--user='))?.slice('--user='.length);
if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to)) throw new Error('Aufruf: smtp-test.ts <empfänger>');

const { realm, clientId, raw } = await adminApi(need('KEYCLOAK_URL'), need('KEYCLOAK_REALM'), need('KEYCLOAK_IAC_CLIENT_ID'));

const stored = (await raw<{ smtpServer?: Record<string, string> }>('GET', '')).data.smtpServer ?? {};
const smtp = userOverride ? { ...stored, user: userOverride } : stored;
if (!smtp.host) throw new Error(`Im Realm ${realm} ist kein SMTP eingerichtet`);

const client = (await raw<{ id: string }[]>('GET', `/clients?clientId=${encodeURIComponent(clientId)}`)).data[0]!;
const sa = (await raw<Record<string, unknown> & { id: string; email?: string }>('GET', `/clients/${client.id}/service-account-user`)).data;
const before = { email: sa.email ?? '', emailVerified: Boolean(sa.emailVerified) };

const put = (email: string, verified: boolean) => raw('PUT', `/users/${sa.id}`, { ...sa, email, emailVerified: verified });
let result: { status: number; data: unknown };
try {
  const set = await put(to, false);
  // Realm ohne doppelte E-Mail-Adressen: eine Adresse, die schon ein Konto im Realm hat, geht nicht
  if (set.status === 409) throw new Error(`${to} gehört schon einem Konto im Realm ${realm}; andere Empfängeradresse wählen`);
  if (set.status >= 300) throw new Error(`Empfänger setzen: HTTP ${set.status} ${JSON.stringify(set.data)}`);
  result = await raw('POST', '/testSMTPConnection', envPassword ? { ...smtp, password: need('TF_VAR_smtp_password') } : smtp);
} finally {
  const back = await put(before.email, before.emailVerified);
  if (back.status >= 300) console.error(`Achtung: E-Mail von ${clientId} nicht zurückgesetzt (HTTP ${back.status})`);
}
if (result.status === 204) console.log(`Testmail an ${to} über ${smtp.host}:${smtp.port ?? ''} (Absender ${smtp.from ?? '-'}, Anmeldung ${smtp.user ?? '-'}) verschickt`);
else { console.error(`SMTP-Test fehlgeschlagen: HTTP ${result.status} ${JSON.stringify(result.data)}`); process.exitCode = 1; }
