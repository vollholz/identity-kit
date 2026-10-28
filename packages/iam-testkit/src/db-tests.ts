/**
 * Datenbank-Tests mit sichtbarem Überspringen. `describe(…, { skip })` von node:test zählt die Tests darin nicht: Ohne
 * Datenbank meldet der Lauf «grün» mit weniger Tests, ohne «skipped». `dbTests(skip)` gibt `test`, `it` und die Hooks so
 * zurück, dass jeder Test mit dem Grund als übersprungen zählt und die Hooks (Wegwerf-Datenbank) nicht laufen:
 *
 *   const { describe, test, before, after } = dbTests(await postgresSkip());   // oder testDatabases(…).dbSkip()
 */
import * as nodeTest from 'node:test';

export interface DbTests {
  /** Grund zum Überspringen oder `false`. */
  skip: false | string;
  describe: typeof nodeTest.describe;
  test: typeof nodeTest.test;
  it: typeof nodeTest.it;
  before: typeof nodeTest.before;
  after: typeof nodeTest.after;
  beforeEach: typeof nodeTest.beforeEach;
  afterEach: typeof nodeTest.afterEach;
}

type Fn = (...args: unknown[]) => unknown;

/** Test-Funktion mit `skip` in den Optionen (Formen von node:test: Name, Optionen, Funktion je optional). */
function skipping<F>(fn: F, skip: string): F {
  return ((...args: unknown[]) => {
    const i = args.findIndex(a => typeof a === 'object' && a !== null);
    if (i >= 0) args[i] = { ...(args[i] as object), skip: (args[i] as { skip?: unknown }).skip || skip };
    else args.splice(typeof args[0] === 'string' ? 1 : 0, 0, { skip });
    return (fn as Fn)(...args);
  }) as F;
}

/** Ohne Grund (`false`) die Funktionen von node:test unverändert. */
export function dbTests(skip: false | string): DbTests {
  const { describe, test, it, before, after, beforeEach, afterEach } = nodeTest;
  if (!skip) return { skip, describe, test, it, before, after, beforeEach, afterEach };
  const none = (() => undefined) as never;
  return { skip, describe, test: skipping(test, skip), it: skipping(it, skip), before: none, after: none, beforeEach: none, afterEach: none };
}
