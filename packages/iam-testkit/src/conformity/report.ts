/**
 * Ergebnis des Konformitätstests: je Prüfung Ebene, Zone, Herkunft und Status, damit lesbar ist, woher eine Vorgabe
 * kommt und wer sie ändern darf (Spezifikation 1.2).
 */

export type Level = 'repo' | 'db' | 'realm';
/** Zone der Vorgabe: `fest` (Vertrag des Kits), `einstellbar` (Manifest), `app` (App-eigen, innerhalb der Regeln). */
export type Zone = 'fest' | 'einstellbar' | 'app';
export type Status = 'ok' | 'warn' | 'fail' | 'skip';

export interface Finding {
  level: Level;
  /** Kurzer Name der Prüfung, z. B. «Verwaltete Dateien unverändert». */
  check: string;
  zone: Zone;
  /** Woher die Vorgabe kommt, z. B. «identity-kit · Lock-Datei» oder «identity.app.json › realm.entra». */
  source: string;
  status: Status;
  /** Befunde bzw. Hinweise (leer bei ok). */
  details: string[];
}

export const LEVEL_LABEL: Record<Level, string> = { repo: 'Repository', db: 'Datenbank', realm: 'Realm' };
export const ZONE_LABEL: Record<Zone, string> = { fest: 'Fest', einstellbar: 'Einstellbar', app: 'App-eigen' };
const MARK: Record<Status, string> = { ok: 'OK', warn: 'WARNUNG', fail: 'FEHLER', skip: 'übersprungen' };
const ICON: Record<Status, string> = { ok: '✅', warn: '⚠️', fail: '❌', skip: '⏭️' };

/** Befund aus einer Liste von Problemen: leer = ok. */
export function finding(base: Omit<Finding, 'status' | 'details'>, problems: string[], status: Exclude<Status, 'ok'> = 'fail'): Finding {
  return { ...base, status: problems.length ? status : 'ok', details: problems };
}

export function summary(findings: Finding[]) {
  const count = (s: Status) => findings.filter(f => f.status === s).length;
  return { ok: count('ok'), warn: count('warn'), fail: count('fail'), skip: count('skip') };
}

/** Exit-Code: 1 bei Fehlern (mit `strict` auch bei Warnungen), sonst 0. */
export const exitCode = (findings: Finding[], strict = false) => (findings.some(f => f.status === 'fail' || (strict && f.status === 'warn')) ? 1 : 0);

export function formatText(findings: Finding[], title: string): string {
  const lines = [title, ''];
  for (const level of ['repo', 'db', 'realm'] as Level[]) {
    const of = findings.filter(f => f.level === level);
    if (!of.length) continue;
    lines.push(`${LEVEL_LABEL[level]}`);
    for (const f of of) {
      lines.push(`  ${MARK[f.status].padEnd(12)} ${f.check}  [${ZONE_LABEL[f.zone]} · ${f.source}]`);
      for (const d of f.details) lines.push(`               – ${d}`);
    }
    lines.push('');
  }
  const s = summary(findings);
  lines.push(`${s.ok} OK, ${s.warn} Warnungen, ${s.fail} Fehler, ${s.skip} übersprungen`);
  return `${lines.join('\n')}\n`;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function formatMarkdown(findings: Finding[], title: string): string {
  const s = summary(findings);
  const lines = [`### ${title}`, '', `${s.fail ? '❌' : s.warn ? '⚠️' : '✅'} ${s.ok} OK, ${s.warn} Warnungen, ${s.fail} Fehler, ${s.skip} übersprungen`, '',
    '| | Ebene | Prüfung | Zone | Herkunft | Befunde |', '|---|---|---|---|---|---|'];
  for (const f of findings) {
    const details = f.details.length ? f.details.slice(0, 20).map(cell).join('<br>') + (f.details.length > 20 ? `<br>… ${f.details.length - 20} weitere` : '') : '';
    lines.push(`| ${ICON[f.status]} | ${LEVEL_LABEL[f.level]} | ${cell(f.check)} | ${ZONE_LABEL[f.zone]} | ${cell(f.source)} | ${details} |`);
  }
  return `${lines.join('\n')}\n`;
}
