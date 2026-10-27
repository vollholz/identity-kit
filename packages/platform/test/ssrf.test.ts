/**
 * SSRF-Schutz für Abrufe an Adressen aus Daten (Webhooks): nur öffentliche Adressen, festgehaltene Auflösung, keine
 * Zugangsdaten in der Adresse; feste Frist auch bei tröpfchenweiser Antwort, Grössengrenze, Kennung des Absenders.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { isPublicAddress, resolveTarget, safeRequest } from '../src/index.ts';

test('private und reservierte Adressen gesperrt', async () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', 'fe80::1', '100.64.0.1', '0.0.0.0']) assert.equal(isPublicAddress(a), false, a);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false);
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
  await assert.rejects(resolveTarget('http://127.0.0.1/x'), /nicht öffentliche/);
  await assert.rejects(resolveTarget('http://[::1]/x'), /nicht öffentliche/);
  await assert.rejects(resolveTarget('file:///etc/passwd'), /Nur http/);
  await assert.rejects(resolveTarget('http://a:b@example.ch/'), /Zugangsdaten/);
  assert.equal((await resolveTarget('http://127.0.0.1/x', { allowPrivate: true })).address, '127.0.0.1');
});

test('feste Frist auch bei tröpfchenweiser Antwort, Grössengrenze beendet das Lesen', async () => {
  // Antwortet alle 50 ms mit einem Byte und endet nie: das Leerlauf-Zeitlimit allein griffe nie
  const slow = createServer((_req, res) => { res.writeHead(200); const t = setInterval(() => res.write('x'), 50); res.on('close', () => clearInterval(t)); });
  await new Promise<void>(r => slow.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(slow.address() as { port: number }).port}/`;
  try {
    const started = Date.now();
    await assert.rejects(safeRequest(url, { timeoutMs: 400, allowPrivate: true }), /Zeitlimit 400 ms/);
    assert.ok(Date.now() - started < 2000, 'Frist eingehalten');
    const r = await safeRequest(url, { timeoutMs: 5000, allowPrivate: true, maxBytes: 3 });
    assert.deepEqual([r.status, r.body], [200, 'xxx']);
  } finally { slow.closeAllConnections(); slow.close(); }
});

test('Kennung des Absenders: Standard des Pakets, sonst die der App', async () => {
  const agents: (string | undefined)[] = [];
  const server = createServer((req, res) => { agents.push(req.headers['user-agent']); res.end('ok'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    await safeRequest(url, { timeoutMs: 2000, allowPrivate: true });
    await safeRequest(url, { timeoutMs: 2000, allowPrivate: true, userAgent: 'probe-webhooks/1' });
    assert.deepEqual(agents, ['vollholz-platform/0', 'probe-webhooks/1']);
  } finally { server.close(); }
});

test('Inhalt als Bytes (Uint8Array, Buffer) unverändert mit Content-Length, Text als UTF-8', async () => {
  const got: { body: Buffer; length: string | undefined; chunked: string | undefined }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { got.push({ body: Buffer.concat(chunks), length: req.headers['content-length'], chunked: req.headers['transfer-encoding'] }); res.writeHead(201).end(); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  // Alle Bytewerte, darunter ungültiges UTF-8 (wie verschlüsselter Inhalt bei Web Push, aes128gcm)
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  try {
    const r = await safeRequest(url, { timeoutMs: 2000, allowPrivate: true, headers: { 'content-encoding': 'aes128gcm' }, body: bytes });
    assert.equal(r.status, 201);
    await safeRequest(url, { timeoutMs: 2000, allowPrivate: true, body: Buffer.from(bytes) });
    await safeRequest(url, { timeoutMs: 2000, allowPrivate: true, body: 'Grüsse' });
    await safeRequest(url, { timeoutMs: 2000, allowPrivate: true, body: bytes.subarray(16, 32), headers: { 'Content-Length': '16' } });
    assert.deepEqual(got.map(g => [g.length, g.chunked]), [['256', undefined], ['256', undefined], ['7', undefined], ['16', undefined]]);
    assert.ok(got[0]!.body.equals(Buffer.from(bytes)));
    assert.ok(got[1]!.body.equals(Buffer.from(bytes)));
    assert.equal(got[2]!.body.toString('utf8'), 'Grüsse');
    assert.ok(got[3]!.body.equals(Buffer.from(bytes.subarray(16, 32))));
  } finally { server.close(); }
});
