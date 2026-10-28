/**
 * Vorgaben des Betreibers für neue Apps (docs/neue-app.md › Vorgaben des Betreibers): Mailversand des Realms und Theme
 * der Keycloak-Instanz, gleich für alle Apps des Betreibers. Der Betreiber legt die Datei in seinem Repository ab;
 * `create-iam-app init --operator-defaults <datei|url>` übernimmt sie ins Manifest der App (`realm.smtp`, `realm.theme`,
 * `realm.themeTexts`). Das Kit kennt keinen Betreiber: nur dieses Format, keine Werte.
 *
 *   {
 *     "smtp": { "host": "mail.example.ch", "port": 587, "starttls": true, "from": "noreply@example.ch", "user": "noreply@example.ch" },
 *     "theme": "betreiber",
 *     "themeTexts": { "de": { "themeClaim": "{displayName}", "themeMailFooter": "{displayName} · {publicBaseUrl}" } }
 *   }
 *
 * `themeTexts`: Vorlage der Texte des Themes je Sprache; `{displayName}`, `{product}` und `{publicBaseUrl}` ersetzt
 * `init` durch die Werte der App. Das Passwort des Mailkontos steht nie hier (Secret `SMTP_PASSWORD` der App).
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EMAIL = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';

/** Schlüssel der Texte eines Themes (Realm-Texte, Spezifikation 3.1): `themeAccent…`, `themeClaim…`, `themeChips`, `themeSub.<Seite>`, `themeMailFooter`. */
export const THEME_TEXT_KEY = '^theme[A-Z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9-]*)?$';
/** Platzhalter in den Vorlagen der Texte. */
export const THEME_TEXT_VARS = ['displayName', 'product', 'publicBaseUrl'] as const;

export const OperatorDefaultsSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  smtp: Type.Object({
    host: Type.String({ minLength: 1 }),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: 'Standard 587' })),
    starttls: Type.Optional(Type.Boolean({ description: 'Standard true' })),
    ssl: Type.Optional(Type.Boolean({ description: 'Standard false' })),
    from: Type.String({ pattern: EMAIL, description: 'Absender aller Apps (z. B. noreply@…); Anzeigename = displayName der App' }),
    replyTo: Type.Optional(Type.String()),
    user: Type.String({ minLength: 1, description: 'Konto beim Mailserver; Passwort nur als Secret SMTP_PASSWORD der App' }),
  }, { additionalProperties: false }),
  theme: Type.Optional(Type.String({ minLength: 1, description: 'Theme auf der Keycloak-Instanz' })),
  themeTexts: Type.Optional(Type.Record(Type.String({ pattern: '^[a-z]{2}(-[A-Z]{2})?$' }), Type.Record(Type.String({ pattern: THEME_TEXT_KEY }), Type.String(), { additionalProperties: false }), {
    additionalProperties: false,
    description: 'Vorlage der Texte des Themes je Sprache; Platzhalter {displayName}, {product}, {publicBaseUrl}',
  })),
}, {
  $id: 'https://github.com/vollholz/identity-kit/packages/iam-testkit/schema/operator-defaults.schema.json',
  title: 'Vorgaben des Betreibers für Apps mit dem Identity-Kit (create-iam-app --operator-defaults)',
  additionalProperties: false,
});
export type OperatorDefaults = Static<typeof OperatorDefaultsSchema>;

/** Prüft die Vorgaben; Fehlertexte mit JSON-Pfad. */
export function operatorDefaultsErrors(data: unknown): string[] {
  if (!Value.Check(OperatorDefaultsSchema, data)) return [...Value.Errors(OperatorDefaultsSchema, data)].map(e => `${e.path || '/'}: ${e.message}`);
  const out: string[] = [];
  for (const [lang, texts] of Object.entries(data.themeTexts ?? {})) {
    for (const [k, v] of Object.entries(texts)) {
      if (k.startsWith('themeAccent') && !/^#[0-9A-Fa-f]{6}$/.test(v)) out.push(`/themeTexts/${lang}/${k}: nur #RRGGBB`);
      const unknown = [...v.matchAll(/\{(\w+)\}/g)].map(x => x[1]!).filter(x => !(THEME_TEXT_VARS as readonly string[]).includes(x));
      if (unknown.length) out.push(`/themeTexts/${lang}/${k}: unbekannter Platzhalter ${unknown.map(x => `{${x}}`).join(', ')} (erlaubt: ${THEME_TEXT_VARS.map(x => `{${x}}`).join(', ')})`);
    }
  }
  return out;
}

/** Texte des Themes einer App aus der Vorlage: Platzhalter ersetzt. */
export function themeTextsFor(template: Record<string, Record<string, string>>, app: { displayName: string; product: string; publicBaseUrl: string }): Record<string, Record<string, string>> {
  const fill = (v: string) => v.replace(/\{(displayName|product|publicBaseUrl)\}/g, (_, k: 'displayName' | 'product' | 'publicBaseUrl') => app[k]);
  return Object.fromEntries(Object.entries(template).map(([lang, texts]) => [lang, Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, fill(v)]))]));
}
