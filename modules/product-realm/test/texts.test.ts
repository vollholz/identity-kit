// Texte des Baukastens (texts/): Du-Form, gleiche Schlüssel, Platzhalter und HTML-Tags wie der Keycloak-Standard
// (26.8.1). Bei jedem Keycloak-Update die Quelldateien
// (*.source.json) mit der neuen Version vergleichen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readTexts = (f: string) => JSON.parse(readFileSync(new URL(`../texts/${f}`, import.meta.url), 'utf8')) as Record<string, string>;
const formal = /\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres|Ihnen)\b/;
const tags = (s: string) => (s.match(/<\/?[a-z0-9]+/gi) ?? []).map(t => t.toLowerCase()).sort();

// Login/E-Mails (Platzhalter {0}) und Kontoverwaltung (Account Console, Platzhalter {{name}})
for (const name of ['localization-de', 'localization-account-de']) {
  test(`${name}.json in Du-Form: gleiche Schlüssel, Platzhalter und HTML-Tags wie der Standard, keine Sie-Form, kein ß`, () => {
    const src = readTexts(`${name}.source.json`);
    const du = readTexts(`${name}.json`);
    assert.deepEqual(Object.keys(du).sort(), Object.keys(src).sort(), `gleiche Schlüssel wie ${name}.source.json`);
    const placeholders = (s: string) => (s.match(/\{\{\w+\}\}|\{\d+\}/g) ?? []).sort();
    for (const [k, v] of Object.entries(du)) {
      assert.deepEqual(placeholders(v), placeholders(src[k]!), `${k}: Platzhalter`);
      assert.deepEqual(tags(v), tags(src[k]!), `${k}: HTML-Tags`);
      assert.doesNotMatch(v, /ß/, `${k}: ß`);
      assert.doesNotMatch(v, formal, `${k}: Sie-Form`);
    }
  });
}

test('Login- und Kontotexte überschneiden sich nicht (ein Namensraum je Realm; gemeinsame Schlüssel nur in localization-de.json)', () => {
  const login = readTexts('localization-de.json');
  assert.deepEqual(Object.keys(readTexts('localization-account-de.json')).filter(k => k in login), []);
});

test('Einladungs-E-Mail (localization-invite.json): de und en wie der Standard, Produktname als __PRODUKT__, de in Du-Form', () => {
  const invite = JSON.parse(readFileSync(new URL('../texts/localization-invite.json', import.meta.url), 'utf8')) as Record<string, Record<string, string>>;
  // Platzhalter und Tags aus Keycloak 26.8.1 (messages_en.properties): {0} Link, {2} Realm, {3} Schritte, {4} Gültigkeit
  const standard: Record<string, string> = {
    executeActionsSubject: 'Update Your Account',
    executeActionsBody: '{2} {3} {0} {4}',
    executeActionsBodyHtml: '<p>{2} {3}</p><p><a href="{0}"></a></p><p>{4}</p><p></p>',
    'requiredAction.VERIFY_EMAIL': 'Verify Email',
    confirmExecutionOfActions: 'Perform the following action(s)',
    accountUpdatedTitle: 'Account updated',
    accountUpdatedMessage: 'Your account has been updated.',
  };
  const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort();
  assert.deepEqual(Object.keys(invite).sort(), ['de', 'en']);
  for (const [lang, texts] of Object.entries(invite)) {
    assert.deepEqual(Object.keys(texts).sort(), Object.keys(standard).sort(), lang);
    assert.match(texts.executeActionsSubject!, /__PRODUKT__/, `${lang}: Betreff nennt das Produkt (localization.tf ersetzt __PRODUKT__)`);
    for (const [k, v] of Object.entries(texts)) {
      assert.deepEqual(placeholders(v), placeholders(standard[k]!), `${lang}.${k}: Platzhalter`);
      assert.deepEqual(tags(v), tags(standard[k]!), `${lang}.${k}: HTML-Tags`);
      if (lang === 'de') { assert.doesNotMatch(v, /ß/, `${k}: ß`); assert.doesNotMatch(v, formal, `${k}: Sie-Form`); }
    }
  }
  // Nicht zugleich in den Du-Texten (sonst entschiede die Reihenfolge im merge)
  assert.deepEqual(Object.keys(readTexts('localization-de.json')).filter(k => k in invite.de!), []);
});
