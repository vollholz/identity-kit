/** Hilfen für Tests des Resolvers: geprüftes Token aus Claims, Fehler mit Status und Titel. */
import assert from 'node:assert/strict';
import { HttpError } from '../../src/errors.ts';
import type { VerifiedToken } from '../../src/tokens.ts';

/** Geprüftes Token aus Claims (ohne Signatur; die prüft test/tokens.test.ts). */
export const verified = (claims: Record<string, unknown>, iat = Math.floor(Date.now() / 1000)): VerifiedToken => ({ token: 't', claims: { iat, ...claims }, binding: 'none' });

/** Fehler des Resolvers mit Status und Titel. */
export async function fails(p: Promise<unknown>, status: number, title: string, label = title) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof HttpError, label);
    assert.deepEqual([e.status, e.title], [status, title], `${label}: ${e.message}`);
    return true;
  });
}
