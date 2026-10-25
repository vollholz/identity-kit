/**
 * Lock-Datei `.identity-kit.lock` (Spezifikation 15.4): hält fest, welche Dateien das Kit in der App verwaltet, mit
 * welcher Version sie erzeugt wurden und wie ihr Inhalt lautet (SHA-256). Weicht eine verwaltete Datei ab, wurde sie
 * von Hand geändert; `npx create-iam-app sync` schreibt sie neu. Verwaltete Dateien tragen zusätzlich einen Kopf
 * (`MANAGED_MARK`), damit man auch ohne Werkzeug sieht, woher sie kommen.
 */
import { createHash } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** Steht in der ersten Zeilen jeder verwalteten Datei. */
export const MANAGED_MARK = 'Verwaltet von identity-kit';

export const LockSchema = Type.Object({
  /** Version von `@vollholz/create-iam-app`, die die Dateien geschrieben hat. */
  kit: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$' }),
  /** Versionen der Teile, die in den verwalteten Dateien stehen (Module als Git-Tag, Pakete als Mindeststand). */
  versions: Type.Record(Type.String(), Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$' })),
  /** Verwaltete Dateien (Pfad ab Wurzel der App) → `sha256:<hex>` des Inhalts mit LF-Zeilenenden. */
  files: Type.Record(Type.String(), Type.String({ pattern: '^sha256:[0-9a-f]{64}$' })),
}, { additionalProperties: false });

export type Lock = Static<typeof LockSchema>;

/** Prüfsumme wie in der Lock-Datei (Zeilenenden normalisiert, damit Windows und Linux gleich zählen). */
export const fileHash = (content: string | Buffer) => `sha256:${createHash('sha256').update(content.toString().replace(/\r\n/g, '\n')).digest('hex')}`;

export function lockErrors(data: unknown): string[] {
  if (!Value.Check(LockSchema, data)) return [...Value.Errors(LockSchema, data)].map(e => `${e.path || '/'}: ${e.message}`);
  return [];
}

/** Lock-Datei als Text (Schlüssel sortiert, stabil für Diffs). */
export function formatLock(lock: Lock): string {
  const sort = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({ kit: lock.kit, versions: sort(lock.versions), files: sort(lock.files) }, null, 2)}\n`;
}
