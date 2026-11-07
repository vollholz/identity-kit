/** Test-App «probe» (Kompositionswurzel): Plattform, Module Notizen und Berichte, Migrationen aus `migrations/`. */
import { join } from 'node:path';
import { defineApp } from '../../src/index.ts';
import { berichtHooks, berichtModule } from './bericht/index.ts';
import { notizModule } from './notiz/index.ts';
import { platform } from './platform.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export const app = defineApp({
  platform,
  modules: [notizModule, berichtModule],
  people: { permissions: ['notiz:read'] },
  migrations: { dir: MIGRATIONS_DIR },
  // Ereignisse des Baukastens in die Outbox der App (gleiche Transaktion)
  iamEvents: { after: (tx, e) => platform.emit(tx, `iam.${e.type}`, e.subject, e.data) },
  moduleHooks: berichtHooks,
});
