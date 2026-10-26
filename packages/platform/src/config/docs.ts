/**
 * `.env.example` und die Doku der Konfiguration (Markdown) aus der Variablenliste. Die App schreibt beide Dateien
 * (`app.envDocs()`); CI prüft, dass sie aktuell sind.
 */
import type { VarSpec } from '@vollholz/iam';

export interface EnvDocsOptions {
  /** Befehl, der die Dateien erzeugt (Hinweis am Anfang), z. B. `npm run env:docs`. */
  command?: string;
  /** Verweis auf die Geheimnisse je Dienst in der Betriebsdoku (Markdown-Link) oder null. */
  secretsLink?: string | null;
}

const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
const pflicht = (v: VarSpec) => (v.required ? 'immer' : v.requiredIn?.length ? v.requiredIn.join(', ') : '–');
const dienste = (v: VarSpec) => (v.services ? v.services.join(', ') : 'alle');

export function envDocs(vars: readonly VarSpec[], o: EnvDocsOptions = {}): { env: string; md: string } {
  const command = o.command ?? 'npm run env:docs';
  const groups = [...new Set(vars.map(v => v.group))];
  const byGroup = (g: string) => vars.filter(v => v.group === g);

  let env = `# Erzeugt von \`${command}\` – nicht von Hand ändern.\n`;
  for (const g of groups) {
    env += `\n# --- ${g} ---\n`;
    for (const v of byGroup(g)) {
      env += `# ${v.description.replaceAll('\n', ' ')}${v.fileAllowed ? ' (auch als _FILE)' : ''}\n`;
      const value = v.example ?? v.default ?? '';
      env += `${v.required || v.requiredIn ? '' : '# '}${v.name}=${v.secret && !v.example ? '' : value}\n`;
    }
  }

  const secrets = o.secretsLink === undefined ? '[betrieb.md](betrieb.md#geheimnisse-je-dienst)' : o.secretsLink;
  let md = `# Konfiguration\n\n> Erzeugt von \`${command}\` – nicht von Hand ändern.\n\n`
    + 'Nur Umgebungsvariablen. Geheimnisse mit `_FILE` auch als Datei (Docker/Kubernetes Secrets). Bei ungültiger\n'
    + 'Konfiguration endet jeder Prozess mit allen Meldungen zugleich und Exit-Code 78. «Dienste»: welcher Prozess den\n'
    + `Wert liest und nur dann verlangt${secrets ? ` (Geheimnisse je Dienst: ${secrets})` : ''}.\n`;
  for (const g of groups) {
    md += `\n## ${g}\n\n| Variable | Typ | Standard | Pflicht | Dienste | Beschreibung |\n|---|---|---|---|---|---|\n`;
    for (const v of byGroup(g)) {
      const typ = v.kind === 'enum' ? v.values!.map(x => `\`${x}\``).join(' \\| ') : v.kind;
      const flags = [v.secret ? 'geheim' : '', v.fileAllowed ? '`_FILE`' : ''].filter(Boolean).join(', ');
      md += `| \`${v.name}\` | ${typ} | ${v.default ? `\`${cell(v.default)}\`` : '–'} | ${pflicht(v)} | ${dienste(v)} | ${cell(v.description)}${flags ? ` (${flags})` : ''} |\n`;
    }
  }
  return { env, md };
}
