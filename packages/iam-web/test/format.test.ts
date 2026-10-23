import { afterEach, describe, expect, it } from 'vitest';
import { configureTexts, fmtDate, fmtDateTime, fmtNum, initials, plural, relTime, shortId } from '../src/index.ts';

/** Erwartung aus Intl selbst: Trennzeichen und Muster hängen von der ICU-Version ab. */
const num = (l: string, n: number) => new Intl.NumberFormat(l).format(n);
const day = (l: string, d: string) => new Intl.DateTimeFormat(l, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d));

afterEach(() => configureTexts({ locale: 'de', texts: {} }));

describe('Formatierung', () => {
  it('schreibt Datum und Zahlen schweizerisch', () => {
    expect(fmtDate('2026-10-22T12:00:00Z')).toBe('22.10.2026');
    expect(fmtDateTime(new Date(2026, 9, 22, 8, 5))).toBe('22.10.2026, 08:05');
    expect(fmtNum(1234567)).toBe(num('de-CH', 1234567));
    expect(fmtNum(1234567)).toMatch(/^1\D234\D567$/);
    expect(fmtDate('kein Datum')).toBe('kein Datum');
    expect(fmtDate(null)).toBe('');
    expect(fmtDateTime('')).toBe('');
  });

  it('nennt relative Zeiten', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(relTime(now - 10_000, now)).toBe('gerade eben');
    expect(relTime(now - 5 * 60_000, now)).toBe('vor 5 Minuten');
    expect(relTime(now - 3 * 3600_000, now)).toBe('vor 3 Stunden');
    expect(relTime(now - 86_400_000, now)).toBe('gestern');
    expect(relTime(now + 3 * 86_400_000, now)).toBe('in 3 Tagen');
    expect(relTime(now - 60 * 86_400_000, now)).toBe('vor 2 Monaten');
    expect(relTime(now - 800 * 86_400_000, now)).toBe('vor 2 Jahren');
    expect(relTime('x', now)).toBe('');
    expect(relTime(undefined, now)).toBe('');
  });

  it('folgt der Sprache der Texte', () => {
    configureTexts({ locale: 'en' });
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(relTime(now - 10_000, now)).toBe('just now');
    expect(relTime(now - 86_400_000, now)).toBe('yesterday');
    expect(fmtDate('2026-10-22T12:00:00Z')).toBe(day('en-CH', '2026-10-22T12:00:00Z'));
    expect(fmtNum(1200)).toBe(num('en-CH', 1200));
  });

  it('bildet Mehrzahl, Initialen und kurze IDs', () => {
    expect(plural(1, 'Person', 'Personen')).toBe('1 Person');
    expect(plural(1200, 'Person', 'Personen')).toBe(`${num('de-CH', 1200)} Personen`);
    expect(initials('Anna Maria Admin')).toBe('AA');
    expect(initials('anna')).toBe('A');
    expect(initials(null)).toBe('?');
    expect(shortId('0123456789abcdef')).toBe('01234567');
    expect(shortId(null)).toBe('');
  });
});
