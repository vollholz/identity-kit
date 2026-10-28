/**
 * Vorgaben des Betreibers (docs/neue-app.md › Vorgaben des Betreibers): Mailversand und Theme, gleich für alle Apps des
 * Betreibers, aus einer Datei oder einer URL im Repository des Betreibers. `init` übernimmt sie in ein neues Manifest;
 * bei einem bestehenden Manifest (und bei `sync`) gibt es nur Hinweise – geändert wird es nie stillschweigend.
 * Das Kit kennt keinen Betreiber: Format in `@vollholz/iam-testkit` (OperatorDefaultsSchema), Werte nur aus der Quelle.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { operatorDefaultsErrors, themeTextsFor, type Manifest, type OperatorDefaults } from '@vollholz/iam-testkit';

/** Pfad der Texte des Themes im Repository der App (Datei der App, nur angelegt, wenn sie fehlt). */
export const THEME_TEXTS_FILE = 'infra/keycloak/theme-texts.json';

/**
 * Vorgaben lesen: `https://…` (mit `GITHUB_TOKEN` als Bearer, falls gesetzt – für Dateien in privaten Repositorys über
 * raw.githubusercontent.com bzw. die API mit `Accept: application/vnd.github.raw`) oder Pfad zu einer Datei.
 */
export async function loadOperatorDefaults(source: string, o: { cwd?: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): Promise<OperatorDefaults> {
  let text: string;
  if (/^https?:\/\//.test(source)) {
    if (!source.startsWith('https://')) throw new Error(`Vorgaben des Betreibers: nur https (${source})`);
    const token = (o.env ?? process.env).GITHUB_TOKEN;
    const res = await (o.fetch ?? fetch)(source, { headers: { accept: 'application/vnd.github.raw, application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Vorgaben des Betreibers: ${source} antwortet ${res.status}${res.status === 404 && !token ? ' (privates Repository? GITHUB_TOKEN setzen)' : ''}`);
    text = await res.text();
  } else {
    const file = resolve(o.cwd ?? process.cwd(), source);
    if (!existsSync(file)) throw new Error(`Vorgaben des Betreibers: ${file} fehlt`);
    text = readFileSync(file, 'utf8');
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`Vorgaben des Betreibers: kein JSON (${(e as Error).message})`); }
  const errors = operatorDefaultsErrors(data);
  if (errors.length) throw new Error(`Vorgaben des Betreibers ungültig:\n${errors.map(x => `  ${x}`).join('\n')}`);
  return data as OperatorDefaults;
}

/** Einstellungen des Realms aus den Vorgaben: `smtp` (Anzeigename = displayName der App), `theme`, `themeTexts`. */
export function realmFromOperator(d: OperatorDefaults, displayName: string): Pick<NonNullable<Manifest['realm']>, 'smtp' | 'theme' | 'themeTexts'> {
  return {
    smtp: { ...d.smtp, fromDisplayName: displayName },
    ...(d.theme ? { theme: d.theme } : {}),
    themeTexts: THEME_TEXTS_FILE,
  };
}

/** Grundgerüst der Texte, wenn der Betreiber keine Vorlage mitgibt (Schlüssel, die das Theme auswerten kann). */
const SKELETON: Record<string, string> = { themeClaim: '{displayName}', themeMailFooter: '{displayName} · {publicBaseUrl}' };

/** Inhalt von `infra/keycloak/theme-texts.json` je Sprache der App. */
export function themeTextsFile(m: Manifest, d: OperatorDefaults | null): string {
  const langs = m.realm?.supportedLocales ?? ['de', 'en'];
  const template = d?.themeTexts && Object.keys(d.themeTexts).length ? d.themeTexts : Object.fromEntries(langs.map(l => [l, SKELETON]));
  // Sprachen der App ohne Vorlage: die Vorlage der ersten Sprache (Werte danach übersetzen)
  const first = Object.values(template)[0] ?? SKELETON;
  const all = Object.fromEntries(langs.map(l => [l, template[l] ?? first]));
  return `${JSON.stringify(themeTextsFor(all, { displayName: m.displayName, product: m.product, publicBaseUrl: m.publicBaseUrl }), null, 2)}\n`;
}

/** Hinweise zu einem bestehenden Manifest (nie geändert): was fehlt oder von den Vorgaben abweicht. */
export function operatorHints(m: Manifest, d: OperatorDefaults | null): string[] {
  const r = m.realm ?? {};
  const out: string[] = [];
  if (!r.smtp) out.push('realm.smtp fehlt: ohne Mailversand keine Einladung «Passwort festlegen» (Vorgaben des Betreibers: docs/neue-app.md)');
  if (!d) return out;
  if (r.smtp) {
    for (const k of ['host', 'port', 'starttls', 'ssl', 'from', 'replyTo', 'user'] as const) {
      if (d.smtp[k] !== undefined && r.smtp[k] !== d.smtp[k]) out.push(`realm.smtp.${k}: ${JSON.stringify(r.smtp[k] ?? null)}, Vorgabe des Betreibers ${JSON.stringify(d.smtp[k])}`);
    }
  } else out.push(`Vorgabe des Betreibers für realm.smtp: ${JSON.stringify({ ...d.smtp, fromDisplayName: m.displayName })}`);
  if (d.theme && r.theme !== d.theme) out.push(`realm.theme: ${JSON.stringify(r.theme ?? null)}, Vorgabe des Betreibers ${JSON.stringify(d.theme)}`);
  if (!r.themeTexts) out.push(`realm.themeTexts fehlt: Vorlage nach ${THEME_TEXTS_FILE} (Texte des Themes je Sprache)`);
  return out;
}
