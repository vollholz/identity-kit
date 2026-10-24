/**
 * `KeycloakFake` über HTTP für die Kommandozeilen (`iam-org-bootstrap`, `iam-reset`), die als eigener Prozess laufen,
 * und Aufruf einer Kommandozeile mit Code, stdout und stderr.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { KeycloakFake } from '@vollholz/iam-testkit';

export async function serveFake(fake: KeycloakFake): Promise<{ base: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => void (async () => {
      const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
      const r = await fake.fetch(`http://idp.test${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body });
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(r.status, headers);
      res.end(Buffer.from(await r.arrayBuffer()));
    })());
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(ok => server.close(() => ok())) };
}

/** Kommandozeile aus src/bin (TypeScript direkt) mit genau dieser Umgebung (plus PATH). */
export const runBin = (bin: string, args: string[], env: Record<string, string>) => promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', '..', 'src', 'bin', bin), ...args], { env: { PATH: process.env.PATH, ...env } })
  .then(r => ({ code: 0, out: r.stdout, err: r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }));
