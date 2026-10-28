import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, problems, sections } from './changelog.ts';

const text = `# Changelog

## [Unveröffentlicht]

### Hinzugefügt

- noch offen

## [2.0.0] – 2026-10-28

### Breaking

- A entfällt. Migration: B nehmen.

## [1.0.0] - 2026-01-01

Stand bis 1.0.0, ohne Einzelnachweis.

[2.0.0]: https://example.ch/2.0.0
`;
const pkg = (version: string) => ({ dir: 'packages/x', name: '@vollholz/x', version });

test('Abschnitte je Version, ohne «Unveröffentlicht» und Linkverweise', () => {
  assert.deepEqual(sections(text).map(s => [s.version, s.date]), [['2.0.0', '2026-10-28'], ['1.0.0', '2026-01-01']]);
  assert.equal(sections(text)[0]!.body, '### Breaking\n\n- A entfällt. Migration: B nehmen.');
  assert.equal(sections(text)[1]!.body, 'Stand bis 1.0.0, ohne Einzelnachweis.');
});

test('Version mit Abschnitt zuoberst: in Ordnung', () => {
  assert.deepEqual(problems(pkg('2.0.0'), text, '1.0.0'), []);
});

test('erhöhte Version ohne Abschnitt: Befund', () => {
  assert.match(problems(pkg('2.1.0'), text, '2.0.0').join('\n'), /Abschnitt «## \[2\.1\.0\] – <datum>» fehlt/);
});

test('fehlende Datei, leerer Abschnitt, ohne Datum, nicht zuoberst, kleinere Version', () => {
  assert.match(problems(pkg('1.0.0'), null, null)[0]!, /CHANGELOG\.md fehlt/);
  assert.match(problems(pkg('3.0.0'), '## [3.0.0] – 2026-10-28\n\n## [2.0.0] – 2026-10-01\n\nx\n', null)[0]!, /ist leer/);
  assert.match(problems(pkg('3.0.0'), '## [3.0.0]\n\nx\n', null)[0]!, /ohne Datum/);
  assert.match(problems(pkg('1.0.0'), text, null)[0]!, /nicht zuoberst/);
  assert.match(problems(pkg('2.0.0'), text, '2.1.0').join('\n'), /kleiner als im Basis-Stand/);
});

test('Vergleich nach SemVer', () => {
  assert.equal(compareVersions('4.0.0', '3.2.1'), 1);
  assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
  assert.equal(compareVersions('4.0.0-rc.1', '4.0.0'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1, 'numerische Kennungen numerisch');
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1, 'längere Liste hat Vorrang');
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1, 'numerisch vor alphanumerisch');
  assert.equal(compareVersions('1.0.0-beta', '1.0.0-alpha.9'), 1);
});
