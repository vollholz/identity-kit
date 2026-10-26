/**
 * Rotation der Hauptschlüssel (Umschlagverschlüsselung, `ENCRYPTION_KEYS`; Startbefehl `rotate-keys`): Der erste
 * Schlüssel der Liste verschlüsselt; alle Geheimnisse, die noch mit einem älteren verschlüsselt sind, werden je
 * Mandant neu verpackt. Danach darf der alte Schlüssel aus der Liste entfernt werden.
 */
import { rewrapEntraSecrets, type Db, type Keyring, type Tx } from '@vollholz/iam';
import type { FullTx } from '../authz/view.ts';
import type { PlatformContext } from '../context.ts';

export interface Rewrapper {
  name: string;
  /** Verpackt die Geheimnisse des Mandanten (Kontext ist gesetzt) mit dem ersten Schlüssel neu; liefert die Anzahl. */
  run(tx: Tx, keys: Keyring, tenantId: string): Promise<number>;
}

/** Geheimnisse eigener Entra-Apps der Organisationen (@vollholz/iam). */
export const entraRewrapper = (ctx: PlatformContext, o: { dryRun?: boolean } = {}): Rewrapper =>
  ({ name: 'entra', run: (tx, keys) => rewrapEntraSecrets(tx, keys, { schema: ctx.schema, ...(o.dryRun ? { dryRun: true } : {}) }) });

/** Alle Mandanten, je in eigener Transaktion mit voller Sicht; liefert die Anzahl neu verpackter Geheimnisse je Art. */
export async function rotateKeys(o: { db: Db; fullTx: FullTx; keys: Keyring; rewrappers: Rewrapper[] }): Promise<Record<string, number>> {
  const out: Record<string, number> = Object.fromEntries(o.rewrappers.map(r => [r.name, 0]));
  const tenants = (await o.db.query<{ id: string }>('SELECT id FROM app.platform_tenants() ORDER BY alias')).rows;
  for (const t of tenants) {
    await o.fullTx(o.db, t.id, async tx => {
      for (const r of o.rewrappers) out[r.name] = (out[r.name] ?? 0) + await r.run(tx, o.keys, t.id);
    });
  }
  return out;
}
