/**
 * Geheimnisse in der Datenbank (app-boilerplate 5.3): Umschlagverschlüsselung mit AES-256-GCM. Der Datenschlüssel je
 * Mandant wird mit HKDF aus dem Hauptschlüssel (`ENCRYPTION_KEYS`, der erste verschlüsselt) und der Mandanten-ID
 * abgeleitet; die AAD bindet das Chiffrat an Mandant, Zweck und Datensatz. Format `v1.<schlüssel-id>.<base64url>`.
 * Rotation: `rotate-keys` entschlüsselt mit dem alten und verschlüsselt mit dem ersten Schlüssel neu.
 *
 * Die Ableitung hängt am Produkt (`<product>/data-key/v1`): `createSealer(ctx)` bzw. `platform.seal`.
 */
import { hkdfSync } from 'node:crypto';
import { box, keyById, primaryKey, unbox, type Keyring } from '@vollholz/iam';
import type { PlatformContext } from '../context.ts';

export type { Keyring };

const VERSION = 'v1';

function dataKey(info: string, master: Buffer, tenantId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from(tenantId, 'utf8'), Buffer.from(info, 'utf8'), 32));
}

const aadOf = (tenantId: string, purpose: string, recordId: string) => `${tenantId}|${purpose}|${recordId}`;

export interface Sealer {
  /** Verschlüsselt `plain` für den Mandanten; `purpose` und `recordId` binden das Chiffrat an seinen Ort. */
  seal(keys: Keyring, tenantId: string, purpose: string, recordId: string, plain: string): string;
  /** Gegenstück zu `seal`; wirft bei falschem Schlüssel, falscher Bindung oder Manipulation. */
  unseal(keys: Keyring, tenantId: string, purpose: string, recordId: string, sealed: string): string;
  /** Neu verschlüsseln, falls nicht mit dem ersten Schlüssel; liefert null, wenn nichts zu tun ist. */
  reseal(keys: Keyring, tenantId: string, purpose: string, recordId: string, sealed: string): string | null;
}

/** Schlüssel-ID eines Chiffrats (für die Rotation). */
export const sealedKeyId = (sealed: string) => sealed.split('.')[1] ?? '';

export function createSealer(ctx: Pick<PlatformContext, 'product'>): Sealer {
  const info = `${ctx.product}/data-key/v1`;
  const seal: Sealer['seal'] = (keys, tenantId, purpose, recordId, plain) => {
    const k = primaryKey(keys);
    return `${VERSION}.${k.id}.${box(dataKey(info, k.key, tenantId), plain, aadOf(tenantId, purpose, recordId)).toString('base64url')}`;
  };
  const unseal: Sealer['unseal'] = (keys, tenantId, purpose, recordId, sealed) => {
    const [v, id, data] = sealed.split('.');
    if (v !== VERSION || !id || !data) throw new Error('Chiffrat: unbekanntes Format');
    return unbox(dataKey(info, keyById(keys, id).key, tenantId), Buffer.from(data, 'base64url'), aadOf(tenantId, purpose, recordId)).toString('utf8');
  };
  const reseal: Sealer['reseal'] = (keys, tenantId, purpose, recordId, sealed) =>
    sealedKeyId(sealed) === primaryKey(keys).id ? null : seal(keys, tenantId, purpose, recordId, unseal(keys, tenantId, purpose, recordId, sealed));
  return { seal, unseal, reseal };
}
