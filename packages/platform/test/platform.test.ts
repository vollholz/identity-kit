/**
 * Kontext, Module und gebundene Bausteine (ohne Datenbank): Namen und Präfixe aus dem Produkt, Prüfung der Module und
 * Werkzeuge, Verschlüsselung gebunden an Produkt, Mandant und Ort, CloudEvents mit dem Präfix der App.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkModules, checkTools, claimLockKey, createSealer, defineModule, platformContext, toCloudEvent } from '../src/index.ts';
import { app } from './fixture/app.ts';
import { platform } from './fixture/platform.ts';

const KEYS = [{ id: 'k1', key: Buffer.alloc(32, 1) }, { id: 'k0', key: Buffer.alloc(32, 2) }];

test('Kontext: Schema, Rollen und Präfixe aus dem Produkt', () => {
  const c = platformContext({ product: 'my-app', title: 'Meine App' });
  assert.equal(c.schema, 'my_app');
  assert.deepEqual(c.roles, { owner: 'my_app_owner', app: 'my_app_app', sched: 'my_app_sched' });
  assert.equal(c.eventPrefix, 'ch.my-app');
  assert.equal(claimLockKey(c), 'my-app:claim');
  assert.throws(() => platformContext({ product: 'Mein Produkt', title: 'x' }), /product/);
  assert.throws(() => platformContext({ product: 'ok', schema: 'a;drop', title: 'x' }), /schema/);
  assert.throws(() => platformContext({ product: 'ok', eventPrefix: 'ch..x', title: 'x' }), /eventPrefix/);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.roles));
});

test('Module: Namen, Jobs, Aufgaben, Tags und Werkzeuge eindeutig', () => {
  const job = { kind: 'a.b', run: async () => undefined };
  assert.throws(() => checkModules([defineModule({ name: 'a' }), defineModule({ name: 'a' })]), /Modul «a» doppelt/);
  assert.throws(() => checkModules([defineModule({ name: 'a', jobs: [job] }), defineModule({ name: 'b', jobs: [job] })]), /Job-Art «a.b» doppelt/);
  assert.throws(() => checkModules([defineModule({ name: 'a', tags: [{ name: 'T', description: '' }] }), defineModule({ name: 'b', tags: [{ name: 'T', description: '' }] })]), /Tag «T» doppelt/);
  // Oberfläche zuletzt, Werkzeuge aus den Modulen
  assert.deepEqual(app.modules.map(m => m.name), ['notiz', 'ui']);
  assert.deepEqual(Object.keys(app.tools).sort(), ['get_notiz', 'list_notizen']);
});

test('Werkzeuge: jedes Werkzeug des Modells umgesetzt und umgekehrt', () => {
  const { list_notizen, get_notiz } = app.tools;
  assert.throws(() => checkTools({ model: platform.model, tools: { list_notizen: list_notizen! } }), /get_notiz: im Modell, aber ohne Umsetzung/);
  assert.throws(() => checkTools({ model: platform.model, tools: { list_notizen: list_notizen!, get_notiz: get_notiz!, extra: get_notiz! } }), /extra: umgesetzt, aber nicht im Modell/);
});

test('Verschlüsselung: gebunden an Produkt, Mandant, Zweck und Datensatz; Rotation auf den ersten Schlüssel', () => {
  const sealed = platform.seal(KEYS, 't1', 'webhook.secret', 'r1', 'geheim');
  assert.match(sealed, /^v1\.k1\./);
  assert.equal(platform.unseal(KEYS, 't1', 'webhook.secret', 'r1', sealed), 'geheim');
  assert.throws(() => platform.unseal(KEYS, 't2', 'webhook.secret', 'r1', sealed));
  assert.throws(() => platform.unseal(KEYS, 't1', 'webhook.secret', 'r2', sealed));
  // Anderes Produkt, anderer Datenschlüssel
  assert.throws(() => createSealer({ product: 'andere' }).unseal(KEYS, 't1', 'webhook.secret', 'r1', sealed));
  assert.equal(platform.reseal(KEYS, 't1', 'webhook.secret', 'r1', sealed), null);
  const old = platform.seal([KEYS[1]!], 't1', 'x', 'r', 'alt');
  const fresh = platform.reseal(KEYS, 't1', 'x', 'r', old)!;
  assert.match(fresh, /^v1\.k1\./);
  assert.equal(platform.unseal(KEYS, 't1', 'x', 'r', fresh), 'alt');
});

test('CloudEvent: Typ mit dem Präfix der App, Quelle je Organisation', () => {
  const e = toCloudEvent(platform.context, { id: 'e1', type: 'notiz.created', subject: 'notiz/1', data: { a: 1 }, created_at: new Date(0), tenant_alias: 'demo' }, 'https://probe.example.ch');
  assert.equal(e.type, 'ch.probe.notiz.created');
  assert.equal(e.source, 'https://probe.example.ch/organisationen/demo');
  assert.equal(e.subject, 'notiz/1');
});
