/**
 * Texte des Baukastens (Spezifikation 11.2, docs/entwurf.md › Texte): `en` vollständig wie `de`, Du-Form und Schweizer
 * Rechtschreibung, verbindliche Begriffe – in den Wörterbüchern und in allen sichtbaren Zeichenketten der Quellen.
 * Herkunft der Prüfungen: vollholz/assets `web/src/ui/texts.test.ts`, `terms.test.ts`, `scripts/check-address.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { de } from '../src/texts/de.ts';
import { en } from '../src/texts/en.ts';
import { configureTexts, format, t, tn, type IamPluralKey } from '../src/texts/index.ts';

afterEach(() => configureTexts({ locale: 'de', texts: {} }));

const SRC = join(import.meta.dirname, '..', 'src');
/** Sichtbar nie «Mandant»/«Tenant» (ausser im Header X-Tenant), «ACL» oder «Principal» (11.2). */
const BANNED_TERMS = /Mandant|(?<!X-)Tenant\b|\bACL\b|Principal\b/;
/** Anrede in der Sie-Form (Grossschreibung mitten im Satz oder am Anfang). */
const SIE_FORM = /\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres|Ihnen)\b/;
/** Gewollte 3. Person, z. B. «Sie lässt sich nicht entfernen» (Organisation, Rolle) – mit Begründung eintragen. */
// `iam.handover.*`: öffentliche Freigabe für die Entra-Administration der Kunden-IT, eine Person ausserhalb der App («Sie»)
const SIE_EXCEPTIONS = new Set<string>([
  'iam.members.lastAdmin', // «Sie lässt sich nicht entfernen»: die Person mit der Rolle, keine Anrede (Wortlaut Assets)
]);

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

/** Texte, die sichtbar werden können: Zeichenketten (auch in Vorlagen und JSX-Attributen) und JSX-Text. */
export function visibleTexts(code: string, file = 'datei.tsx'): string[] {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isJsxText(n)) { if (n.text.trim()) out.push(n.text.trim()); }
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const sources = () => (readdirSync(SRC, { recursive: true }) as string[])
  .filter(f => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !f.startsWith(`texts${'/'}`))
  .map(f => join(SRC, f));

describe('Texte', () => {
  it('en hat dieselben Schlüssel und Platzhalter wie de', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
    for (const [k, v] of Object.entries(de)) expect([k, placeholders(en[k as keyof typeof de])]).toEqual([k, placeholders(v)]);
  });

  it('Schlüssel beginnen mit iam. und kein Text ist leer', () => {
    for (const [k, v] of [...Object.entries(de), ...Object.entries(en)]) {
      expect(k).toMatch(/^iam\.[a-z0-9.]+(_one|_other)?$/i);
      expect(v.trim()).not.toBe('');
    }
  });

  it('de: Du-Form, kein ß, Begriffe nach 11.2', () => {
    const bad = Object.entries(de).filter(([k, v]) => (SIE_FORM.test(v) && !SIE_EXCEPTIONS.has(k) && !k.startsWith('iam.handover.')) || v.includes('ß') || BANNED_TERMS.test(v));
    expect(bad).toEqual([]);
  });

  it('en: Begriffe nach 11.2 (organization, role, permission, scope, access rule)', () => {
    expect(Object.entries(en).filter(([, v]) => BANNED_TERMS.test(v) || /\btenant\b/i.test(v))).toEqual([]);
  });

  it('erkennt sichtbare Texte, nicht Code', () => {
    const code = [
      '// Mandant im Kommentar',
      "import { tenant } from './Mandant.ts';",
      "const tenantId = 1; const h = { 'X-Tenant': 'demo' };",
      "const a = 'Jeder Mandant';",
      'const b = `Im Mandanten ${tenantId}`;',
      'export const C = () => <p title="Tenant">Ein Mandant <b>{a}</b></p>;',
    ].join('\n');
    expect(visibleTexts(code).filter(x => BANNED_TERMS.test(x))).toEqual(['Jeder Mandant', 'Im Mandanten ', 'Tenant', 'Ein Mandant']);
  });

  it('keine verbotenen Begriffe, kein ß und keine Sie-Form in sichtbaren Texten der Quellen', () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(5);
    const hits = files.flatMap(f => visibleTexts(readFileSync(f, 'utf8'), f)
      .filter(x => BANNED_TERMS.test(x) || x.includes('ß') || SIE_FORM.test(x))
      .map(x => `${relative(SRC, f)}: ${x}`));
    expect(hits).toEqual([]);
  });
});

describe('Texte überschreiben und Sprachen', () => {
  it('ersetzt Platzhalter, unbekannte bleiben stehen', () => {
    expect(t('iam.error.status', { status: 418 })).toBe('Fehler 418');
    expect(format('{a} und {b}', { a: 1 })).toBe('1 und {b}');
  });

  it('überschreibt einzelne Schlüssel und fällt auf de zurück', () => {
    configureTexts({ locale: 'fr', texts: { fr: { 'iam.error.0': 'Pas de connexion au serveur' } } });
    expect(t('iam.error.0')).toBe('Pas de connexion au serveur');
    expect(t('iam.error.403')).toBe('Dafür fehlt dir das Recht.');
    configureTexts({ locale: 'de', texts: { de: { 'iam.error.403': 'Das darfst du nicht.' } } });
    expect(t('iam.error.403')).toBe('Das darfst du nicht.');
    configureTexts({ locale: 'en', texts: {} });
    expect(t('iam.error.403')).toBe('You lack the permission for this.');
  });

  it('wählt die Mehrzahl nach Intl.PluralRules und setzt {count}', () => {
    // Mehrzahl-Schlüssel folgen mit den Bausteinen; hier über eigene Texte geprüft
    configureTexts({ locale: 'de', texts: { de: { 'iam.x_one': '{count} Person', 'iam.x_other': '{count} Personen' } as never } });
    const key = 'iam.x' as IamPluralKey;
    expect(tn(key, 1)).toBe('1 Person');
    expect(tn(key, 0)).toBe('0 Personen');
    expect(tn(key, 1200)).toBe(`${new Intl.NumberFormat('de-CH').format(1200)} Personen`);
  });
});
