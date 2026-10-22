/**
 * Verschlüsselung mit den Hauptschlüsseln aus ENCRYPTION_KEYS (aus Assets `core/crypto.ts`, `modules/auth/sealer.ts`).
 *
 * - AES-256-GCM. Der erste Schlüssel verschlüsselt, alle Schlüssel entschlüsseln (Rotation: neuen Schlüssel vorne
 *   eintragen, Bestand neu verschlüsseln, danach den alten entfernen).
 * - Zusatzdaten (AAD) binden jedes Chiffrat an seinen Zweck und seine Zeile (Sitzung: Sitzungs-ID), damit ein
 *   umkopierter Wert nicht entschlüsselt werden kann.
 * - `box`/`unbox`: Rohformat `IV (12) | Tag (16) | Chiffrat`. `Sealer`: Version (1) | Länge Schlüssel-ID (1) |
 *   Schlüssel-ID | Rohformat – das Format der Sitzungen und des Anmeldezustands in Assets, gespeicherte Werte bleiben lesbar.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface MasterKey { id: string; key: Buffer }
export type Keyring = readonly MasterKey[];

const IV = 12, TAG = 16;

/** Fehlt ENCRYPTION_KEYS, wenn etwas verschlüsselt werden soll. */
export class NoEncryptionKeyError extends Error {
  constructor() { super('ENCRYPTION_KEYS ist nicht gesetzt'); }
}

export function primaryKey(keys: Keyring): MasterKey {
  const k = keys[0];
  if (!k) throw new NoEncryptionKeyError();
  return k;
}

export function keyById(keys: Keyring, id: string): MasterKey {
  const k = keys.find(x => x.id === id);
  if (!k) throw new Error(`Hauptschlüssel «${id}» fehlt in ENCRYPTION_KEYS`);
  return k;
}

export function validateKeyring(keys: Keyring) {
  for (const k of keys) {
    if (k.key.length !== 32) throw new Error(`Schlüssel ${k.id} muss 32 Bytes haben`);
    if (!k.id || Buffer.byteLength(k.id) > 255 || k.id.includes('.')) throw new Error('Schlüssel-ID: 1–255 Bytes, ohne Punkt');
  }
}

/** Verschlüsselt mit einem konkreten Schlüssel. Ergebnis: IV | Tag | Chiffrat. */
export function box(key: Buffer, plain: string | Buffer, aad: string): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/** Gegenstück zu `box`; wirft bei falschem Schlüssel, falscher AAD oder Manipulation. */
export function unbox(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < IV + TAG) throw new Error('Chiffrat zu kurz');
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(sealed.subarray(IV, IV + TAG));
  return Buffer.concat([d.update(sealed.subarray(IV + TAG)), d.final()]);
}

const VERSION = 1;

/** Verschlüsselung mit Schlüssel-ID im Chiffrat (Sitzungen, Anmeldezustand). */
export class Sealer {
  private readonly keys: MasterKey[];

  constructor(keys: MasterKey[]) {
    if (!keys.length) throw new Error('mindestens ein Schlüssel nötig');
    validateKeyring(keys);
    this.keys = keys;
  }

  seal(plain: string | Buffer, aad: string): Buffer {
    const k = primaryKey(this.keys);
    const id = Buffer.from(k.id, 'utf8');
    return Buffer.concat([Buffer.from([VERSION, id.length]), id, box(k.key, plain, aad)]);
  }

  /** Wirft bei unbekanntem Schlüssel, falscher AAD oder Manipulation. */
  open(buf: Buffer, aad: string): Buffer {
    if (buf.length < 2 || buf[0] !== VERSION) throw new Error('unbekanntes Format');
    const idLen = buf[1]!;
    const id = buf.subarray(2, 2 + idLen).toString('utf8');
    return unbox(keyById(this.keys, id).key, buf.subarray(2 + idLen), aad);
  }

  sealString(plain: string, aad: string): string { return this.seal(plain, aad).toString('base64url'); }
  openString(sealed: string, aad: string): string { return this.open(Buffer.from(sealed, 'base64url'), aad).toString('utf8'); }
}
