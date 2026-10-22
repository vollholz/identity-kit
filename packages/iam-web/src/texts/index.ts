/**
 * Texte des Baukastens (docs/entwurf.md › Texte): eingebaut `de` (Standard) und `en`; die App überschreibt einzelne
 * Schlüssel und ergänzt Sprachen (`configureTexts`, später über `IamProvider`). Fehlt ein Schlüssel in einer Sprache,
 * gilt Deutsch. Der Zustand ist modulweit, damit auch Code ohne React (ApiError, Formatierung) dieselben Texte nutzt.
 */
import { de, type IamTextKey } from './de.ts';
import { en } from './en.ts';

export type { IamTextKey };
/** Texte einer Sprache; Überschreibungen müssen nicht vollständig sein. */
export type IamTexts = Partial<Record<IamTextKey, string>>;
/** Sprache als BCP-47-Kürzel ohne Region (`de`, `en`, `fr` …). */
export type IamLocale = string;
export type TextVars = Record<string, string | number>;

const BUILTIN: Record<string, IamTexts> = { de, en };
/** Region für Datum und Zahlen je Sprache (Schweizer Schreibweise, wo es sie gibt). */
const INTL: Record<string, string> = { de: 'de-CH', en: 'en-CH', fr: 'fr-CH', it: 'it-CH' };

let locale: IamLocale = 'de';
let custom: Record<string, IamTexts> = {};

export function configureTexts(o: { locale?: IamLocale; texts?: Record<string, IamTexts> }) {
  if (o.locale) locale = o.locale;
  if (o.texts) custom = o.texts;
}

export const currentLocale = (): IamLocale => locale;
/** Locale für `Intl` (Datum, Zahl, Mehrzahl). */
export const intlLocale = (l: IamLocale = locale): string => INTL[l] ?? l;

function find(key: string, l: IamLocale): string | undefined {
  const k = key as IamTextKey;
  return custom[l]?.[k] ?? BUILTIN[l]?.[k] ?? custom.de?.[k] ?? (de as Partial<Record<string, string>>)[key];
}
const lookup = (key: IamTextKey, l: IamLocale): string => find(key, l) ?? key;

/** Platzhalter `{name}` ersetzen; unbekannte bleiben stehen (fällt im Test auf statt still zu verschwinden). */
export function format(text: string, vars?: TextVars): string {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

/** Text zum Schlüssel in der aktuellen Sprache. */
export function t(key: IamTextKey, vars?: TextVars): string {
  return format(lookup(key, locale), vars);
}

/** Schlüssel ohne Endung `_one`/`_other`, für die es eine Mehrzahl gibt. */
export type IamPluralKey = IamTextKey extends infer K ? (K extends `${infer B}_other` ? B : never) : never;

/** Mehrzahl nach `Intl.PluralRules`: `<key>_one`, `<key>_other` (weitere Kategorien fallen auf `_other`); `{count}` ist gesetzt. */
export function tn(key: IamPluralKey, count: number, vars?: TextVars): string {
  const cat = new Intl.PluralRules(intlLocale()).select(count);
  const text = find(`${key}_${cat}`, locale) ?? find(`${key}_other`, locale) ?? key;
  return format(text, { count: new Intl.NumberFormat(intlLocale()).format(count), ...vars });
}

/** Eingebaute Texte je Sprache (für Tests und Werkzeuge). */
export const builtinTexts: Readonly<Record<string, IamTexts>> = BUILTIN;

/** Aufzählung nach Sprache: «A», «B» und «C» (de) bzw. A, B, and C (en). */
export function listAnd(items: readonly string[]): string {
  return new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(items);
}

/** Aufzählung mit «oder». */
export function listOr(items: readonly string[]): string {
  return new Intl.ListFormat(intlLocale(), { type: 'disjunction' }).format(items);
}
