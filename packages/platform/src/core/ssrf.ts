/**
 * Abrufe an Adressen aus Daten (Webhooks) mit SSRF-Schutz (app-boilerplate 6): nur http(s), Namen einmal auflösen, jede
 * Adresse prüfen (keine privaten, lokalen, Link-Local-, Multicast- oder reservierten Netze), dann genau diese Adresse
 * verwenden (festgehalten, kein zweites Auflösen → kein DNS-Rebinding). Keine Weiterleitungen, Zeitlimit, begrenzte
 * Antwort.
 */
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export class SsrfError extends Error {}

/** Ist die Adresse öffentlich erreichbar (nicht privat, lokal, reserviert)? */
export function isPublicAddress(address: string): boolean {
  // IPv4-mapped (::ffff:a.b.c.d) wie die IPv4-Adresse prüfen; BlockList vergleicht beide Formen gleich
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const a = mapped ?? address;
  const family = isIP(a);
  if (!family) return false;
  return !blocked.check(a, family === 4 ? 'ipv4' : 'ipv6');
}

/** Ziel prüfen und die zu verwendende Adresse festhalten. */
export async function resolveTarget(raw: string, o: { allowPrivate?: boolean } = {}): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SsrfError('Adresse ungültig'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SsrfError('Nur http und https sind erlaubt');
  if (url.username || url.password) throw new SsrfError('Zugangsdaten in der Adresse sind nicht erlaubt');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const found = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!found.length) throw new SsrfError(`Name ${host} nicht auflösbar`);
  if (!o.allowPrivate) {
    const bad = found.find(a => !isPublicAddress(a.address));
    if (bad) throw new SsrfError(`Ziel ${host} zeigt auf eine nicht öffentliche Adresse`);
  }
  const first = found[0]!;
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

export interface SafeResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

/**
 * Anfrage an eine Adresse aus Daten. Folgt keinen Weiterleitungen (3xx zählt als Antwort), liest höchstens
 * `maxBytes` der Antwort und bricht nach `timeoutMs` ab (Gesamtzeit, nicht nur Leerlauf). `body` als Text (UTF-8) oder
 * Bytes (`Uint8Array`, auch `Buffer`, z. B. Web Push mit `aes128gcm`) geht unverändert hinaus, mit `Content-Length`,
 * sofern `headers` keine nennt.
 */
export async function safeRequest(raw: string, o: {
  method?: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs: number; allowPrivate?: boolean; maxBytes?: number; userAgent?: string;
}): Promise<SafeResponse> {
  const { url, address, family } = await resolveTarget(raw, o);
  const pinned: LookupFunction = (_host, opts, cb) => {
    if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
    else cb(null, address, family);
  };
  const mod = url.protocol === 'https:' ? https : http;
  const max = o.maxBytes ?? 64 * 1024;
  const headers: Record<string, string> = { 'user-agent': o.userAgent ?? 'vollholz-platform/0', ...o.headers };
  if (o.body !== undefined && !Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) {
    headers['content-length'] = String(typeof o.body === 'string' ? Buffer.byteLength(o.body) : o.body.byteLength);
  }
  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(deadline); fn(); } };
    const req = mod.request(url, {
      method: o.method ?? 'POST', headers, lookup: pinned, timeout: o.timeoutMs,
      ...(url.protocol === 'https:' ? { servername: isIP(url.hostname) ? undefined : url.hostname } : {}),
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      const done = () => finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('data', (c: Buffer) => {
        chunks.push(c.subarray(0, max - size));
        size += c.length;
        // Grenze erreicht: Rest nicht abwarten, Verbindung schliessen
        if (size >= max) { done(); res.destroy(); }
      });
      res.on('end', done);
      res.on('error', e => finish(() => reject(e)));
    });
    // Feste Frist für die ganze Anfrage (das Zeitlimit von node:http gilt nur für Leerlauf): Ein Gegenüber, das
    // tröpfchenweise antwortet, hält die Zustellung sonst beliebig lange auf
    const deadline = setTimeout(() => {
      const err = new SsrfError(`Zeitlimit ${o.timeoutMs} ms überschritten`);
      finish(() => reject(err));
      req.destroy(err);
    }, o.timeoutMs);
    req.on('timeout', () => req.destroy(new SsrfError(`Zeitlimit ${o.timeoutMs} ms überschritten`)));
    req.on('error', e => finish(() => reject(e)));
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}
