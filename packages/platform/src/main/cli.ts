/**
 * Befehle einer App (Startbefehl des Images, z. B. `node src/cli.ts migrate`). Ausgabe JSON; Exit 0 ok, 1 Fehler,
 * 64 Aufruf falsch, 78 Konfiguration fehlt.
 *
 *   api | worker | mcp                      Prozess starten
 *   migrate                                 Migrationen (DATABASE_ADMIN_URL)
 *   tenant list
 *   tenant create <alias> [--name <name>]
 *   tenant suspend <alias> [--reason <text>]
 *   tenant resume <alias>
 *   tenant delete <alias> --confirm <alias>
 *   rotate-keys [--dry-run]                 Geheimnisse mit dem ersten Schlüssel aus ENCRYPTION_KEYS neu verpacken
 *
 * Verbindungen je auch als `_FILE`: DATABASE_ADMIN_URL (Besitzer), DATABASE_URL (Laufzeit).
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseEncryptionKeys, validateKeyring, type Keyring } from '@vollholz/iam';
import pg from 'pg';
import type { PlatformApp } from '../app.ts';
import { startApi, startMcp, startWorker } from './start.ts';

const USAGE = 'Befehl: api | worker | mcp | migrate | tenant <list|create|suspend|resume|delete> | rotate-keys [--dry-run]';

export async function runCli(app: PlatformApp, argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const read = (k: string) => env[k] || (env[`${k}_FILE`] ? readFileSync(env[`${k}_FILE`]!, 'utf8').trim() : '');
  const fail = (msg: string, code: number): never => { console.error(JSON.stringify({ level: 'error', msg })); process.exit(code); };
  const { values: a, positionals: [cmd, sub, alias] } = parseArgs({
    args: argv, allowPositionals: true,
    options: { name: { type: 'string' }, reason: { type: 'string' }, confirm: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  });

  switch (cmd) {
    case 'api': return startApi(app, env);
    case 'worker': return startWorker(app, env);
    case 'mcp': return startMcp(app, env);
    case 'migrate': {
      const url = read('DATABASE_ADMIN_URL') || fail('DATABASE_ADMIN_URL (bzw. _FILE) fehlt – Verbindung der Besitzer-Rolle für Migrationen', 78);
      try {
        const r = await app.migrate(url);
        console.log(JSON.stringify({ level: 'info', msg: 'Migrationen ausgeführt', applied: r.applied, adopted: r.adopted, skipped: r.skipped }));
      } catch (e) { fail((e as Error).message, 1); }
      return;
    }
    case 'tenant': {
      if (!sub || !['list', 'create', 'suspend', 'resume', 'delete'].includes(sub)) fail('tenant: list | create <alias> | suspend <alias> | resume <alias> | delete <alias> --confirm <alias>', 64);
      if (sub !== 'list' && !alias) fail(`tenant ${sub}: Alias fehlt`, 64);
      const adminUrl = read('DATABASE_ADMIN_URL') || fail('DATABASE_ADMIN_URL (bzw. _FILE) fehlt', 78);
      const runtimeUrl = read('DATABASE_URL') || (sub === 'list' || sub === 'delete' ? adminUrl : fail('DATABASE_URL (bzw. _FILE) fehlt', 78));
      const d = { admin: new pg.Pool({ connectionString: adminUrl, max: 2 }), runtime: new pg.Pool({ connectionString: runtimeUrl, max: 2 }) };
      try {
        const out = sub === 'list' ? await app.tenants.list(d)
          : sub === 'create' ? await app.tenants.create(d, alias!, a.name)
          : sub === 'suspend' ? await app.tenants.suspend(d, alias!, a.reason ?? '')
          : sub === 'resume' ? await app.tenants.resume(d, alias!)
          : await app.tenants.delete(d, alias!, a.confirm ?? '');
        console.log(JSON.stringify(out, null, 2));
      } catch (e) {
        fail((e as Error).message, 1);
      } finally { await Promise.all([d.admin.end(), d.runtime.end()]); }
      return;
    }
    case 'rotate-keys': {
      const url = read('DATABASE_URL') || fail('DATABASE_URL (bzw. _FILE) fehlt', 78);
      const raw = read('ENCRYPTION_KEYS') || fail('ENCRYPTION_KEYS (bzw. _FILE) fehlt', 78);
      let keys: Keyring = [];
      try { keys = parseEncryptionKeys(raw); validateKeyring(keys); } catch (e) { fail(`ENCRYPTION_KEYS: ${(e as Error).message}`, 78); }
      const dryRun = a['dry-run'] ?? false;
      const db = new pg.Pool({ connectionString: url, max: 2 });
      try {
        const counts = await app.rotateKeys({ db, keys, dryRun });
        console.log(JSON.stringify({ level: 'info', msg: dryRun ? 'Probelauf: neu zu verpacken' : 'Geheimnisse neu verpackt', primary: keys[0]!.id, counts }));
      } catch (e) {
        fail((e as Error).message, 1);
      } finally { await db.end(); }
      return;
    }
    default: fail(USAGE, 64);
  }
}
