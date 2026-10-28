/**
 * Unterstützte Versionen der Teile des Kits (Spezifikation 15.5). Fenster: aktuelle und vorherige Hauptversion –
 * enger, wo Teile nur zusammen funktionieren (Rollen liegen ab `@vollholz/iam` 2 und `product-realm` 2 nur noch in der
 * Datenbank der App). Der Konformitätstest meldet eine App ausserhalb des Fensters; mit jeder neuen Hauptversion rückt
 * es nach (Test im Kit: `CURRENT` = Versionen im Repository).
 */

export type Part = '@vollholz/iam' | '@vollholz/iam-web' | '@vollholz/iam-testkit' | '@vollholz/create-iam-app' | '@vollholz/platform' | 'product-realm' | 'product-realm-bootstrap';

/** Stand dieses Test-Kits (beim Release gleich den Versionen im Repository identity-kit). */
export const CURRENT: Record<Part, string> = {
  '@vollholz/iam': '4.0.0',
  '@vollholz/iam-web': '2.1.0',
  '@vollholz/iam-testkit': '2.2.0',
  '@vollholz/create-iam-app': '0.3.0',
  '@vollholz/platform': '0.5.0',
  'product-realm': '2.0.0',
  'product-realm-bootstrap': '0.1.1',
};

/** Ältester unterstützter Stand je Teil, mit Grund. */
export const MINIMUM: Record<Part, { version: string; reason: string }> = {
  '@vollholz/iam': { version: '3.0.0', reason: 'aktuelle und vorherige Hauptversion (4, 3); Rollen nur als Tupel in der Datenbank der App, passend zu product-realm 2' },
  '@vollholz/iam-web': { version: '1.0.0', reason: 'aktuelle Hauptversion' },
  '@vollholz/iam-testkit': { version: '1.0.0', reason: 'aktuelle Hauptversion' },
  '@vollholz/create-iam-app': { version: '0.1.0', reason: 'erste Version' },
  '@vollholz/platform': { version: '0.1.0', reason: 'erste Version' },
  'product-realm': { version: '2.0.0', reason: 'ab 2.0 keine Rollen in Keycloak, passend zu @vollholz/iam 2' },
  'product-realm-bootstrap': { version: '0.1.0', reason: 'erste Version' },
};

const parse = (v: string) => v.split('.').map(Number) as [number, number, number];

/** Vergleich zweier Versionen x.y.z: negativ, 0 oder positiv. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Befund zu einer Version oder null, wenn sie im Fenster liegt. */
export function versionProblem(part: Part, version: string): string | null {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return `${part}: «${version}» ist keine exakte Version (x.y.z, ohne ^ oder ~)`;
  const min = MINIMUM[part];
  if (compareVersions(version, min.version) < 0) return `${part} ${version} ist älter als ${min.version} (${min.reason})`;
  // Eine neuere Hauptversion kennt dieses Test-Kit nicht: ihren Vertrag kann es nicht prüfen
  if (parse(version)[0] > parse(CURRENT[part])[0]) return `${part} ${version} ist neuer als die Hauptversion, die dieses Test-Kit kennt (${CURRENT[part]}): @vollholz/iam-testkit aktualisieren`;
  return null;
}

/** Ist eine neuere Version bekannt? (Hinweis, kein Fehler.) */
export function newer(part: Part, version: string): string | null {
  return /^\d+\.\d+\.\d+$/.test(version) && compareVersions(version, CURRENT[part]) < 0 ? CURRENT[part] : null;
}
