/**
 * Formatierung nach der Sprache der Texte (`intlLocale`: Deutsch als de-CH). Herkunft: vollholz/assets `web/src/ui/format.ts`.
 */
import { intlLocale, t } from './texts/index.ts';

type When = string | number | Date | null | undefined;

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>();
function fmt<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>(kind: string, make: (l: string) => T): T {
  const l = intlLocale(), k = `${kind}:${l}`;
  let f = cache.get(k) as T | undefined;
  if (!f) { f = make(l); cache.set(k, f); }
  return f;
}
const dateFmt = () => fmt('d', l => new Intl.DateTimeFormat(l, { day: '2-digit', month: '2-digit', year: 'numeric' }));
const dateTimeFmt = () => fmt('dt', l => new Intl.DateTimeFormat(l, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
const numFmt = () => fmt('n', l => new Intl.NumberFormat(l));
const rtf = () => fmt('r', l => new Intl.RelativeTimeFormat(l, { numeric: 'auto' }));

const toDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));

export const fmtNum = (n: number): string => numFmt().format(n);

export function fmtDate(v: When): string {
  if (v == null || v === '') return '';
  const d = toDate(v);
  return Number.isNaN(d.getTime()) ? String(v) : dateFmt().format(d);
}

export function fmtDateTime(v: When): string {
  if (v == null || v === '') return '';
  const d = toDate(v);
  return Number.isNaN(d.getTime()) ? String(v) : dateTimeFmt().format(d);
}

/** «vor 5 Minuten», «gestern», «in 3 Tagen». */
export function relTime(v: When, now = Date.now()): string {
  if (v == null || v === '') return '';
  const ts = toDate(v).getTime();
  if (Number.isNaN(ts)) return '';
  const s = Math.round((ts - now) / 1000), a = Math.abs(s);
  if (a < 45) return t('iam.time.now');
  if (a < 3600) return rtf().format(Math.round(s / 60), 'minute');
  if (a < 86_400) return rtf().format(Math.round(s / 3600), 'hour');
  if (a < 30 * 86_400) return rtf().format(Math.round(s / 86_400), 'day');
  if (a < 365 * 86_400) return rtf().format(Math.round(s / (30 * 86_400)), 'month');
  return rtf().format(Math.round(s / (365 * 86_400)), 'year');
}

/** Zahl mit Einzahl oder Mehrzahl, z. B. `plural(3, 'Person', 'Personen')`. */
export const plural = (n: number, one: string, many: string): string => `${fmtNum(n)} ${n === 1 ? one : many}`;

export function initials(name: string | null | undefined): string {
  const p = (name ?? '?').trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[p.length - 1]![0] : '')).toUpperCase();
}

export const shortId = (id: string | null | undefined): string => (id ? id.slice(0, 8) : '');
