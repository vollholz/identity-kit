/**
 * DPoP (RFC 9449) auf der Client-Seite des MCP-Dienstes: Der Dienst hält ein eigenes
 * Schlüsselpaar (ES256), lässt sich beim Token Exchange daran gebundene API-Tokens ausstellen (`cnf.jkt`) und belegt bei
 * jedem API-Aufruf mit einem frischen Proof (`htm`, `htu`, `ath`, `jti`), dass er den privaten Schlüssel besitzt.
 * Ein abgegriffenes API-Token ist ohne diesen Schlüssel wertlos.
 *
 * Schlüssel aus MCP_DPOP_KEY (PEM, P-256) oder beim Start erzeugt. Nonces der Gegenstellen (Header `DPoP-Nonce`)
 * werden je Ursprung gemerkt und in folgende Proofs übernommen.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, SignJWT, type JWK } from 'jose';
import { ConfigError } from '../config.ts';
import { normalizeHtu } from '../tokens.ts';

export class DpopSigner {
  /** JWK-Thumbprint (RFC 7638) des öffentlichen Schlüssels, steht in `cnf.jkt` der gebundenen Tokens. */
  readonly jkt: string;
  /** true, wenn der Schlüssel beim Start erzeugt wurde (nicht aus MCP_DPOP_KEY). */
  readonly ephemeral: boolean;
  private readonly key: KeyObject;
  private readonly jwk: JWK;
  private readonly nonces = new Map<string, string>();

  private constructor(key: KeyObject, jwk: JWK, jkt: string, ephemeral: boolean) { this.key = key; this.jwk = jwk; this.jkt = jkt; this.ephemeral = ephemeral; }

  /** @param pem privater Schlüssel (PKCS#8 oder SEC1, Kurve P-256); ohne Angabe wird einer erzeugt. */
  static async create(pem?: string | null): Promise<DpopSigner> {
    let key: KeyObject;
    if (pem) {
      try { key = createPrivateKey(pem); } catch (e) { throw new ConfigError(`MCP_DPOP_KEY: kein lesbarer privater Schlüssel (${(e as Error).message})`); }
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new ConfigError('MCP_DPOP_KEY: erwartet wird ein EC-Schlüssel auf P-256 (ES256).');
    } else {
      key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    }
    const { kty, crv, x, y } = await exportJWK(createPublicKey(key));
    const jwk: JWK = { kty, crv, x, y };
    return new DpopSigner(key, jwk, await calculateJwkThumbprint(jwk, 'sha256'), !pem);
  }

  /** Proof für eine Anfrage; mit `accessToken` inkl. `ath` (Aufrufe der Ressource), ohne für den Token-Endpunkt. */
  proof(htm: string, htu: string, accessToken?: string): Promise<string> {
    const nonce = this.nonces.get(new URL(htu).origin);
    return new SignJWT({
      htm: htm.toUpperCase(), htu: normalizeHtu(htu), jti: randomUUID(), iat: Math.floor(Date.now() / 1000),
      ...(accessToken ? { ath: createHash('sha256').update(accessToken).digest('base64url') } : {}),
      ...(nonce ? { nonce } : {}),
    }).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: this.jwk }).sign(this.key);
  }

  /** Merkt sich eine Nonce aus der Antwort; liefert true, wenn sie neu ist (dann lohnt eine Wiederholung). */
  remember(url: string, headers: Headers): boolean {
    const nonce = headers.get('dpop-nonce');
    if (!nonce) return false;
    const origin = new URL(url).origin;
    if (this.nonces.get(origin) === nonce) return false;
    this.nonces.set(origin, nonce);
    return true;
  }
}

/** Fordert die Ressource (401) eine Nonce an? (RFC 9449 Abschnitt 9) */
export function wantsNonce(status: number, headers: Headers): boolean {
  return status === 401 && /\berror="use_dpop_nonce"/.test(headers.get('www-authenticate') ?? '');
}
