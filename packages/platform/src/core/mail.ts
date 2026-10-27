/**
 * E-Mail-Versand als Baustein, gewählt über `MAIL_ADAPTER`:
 *
 * - **smtp:** eigener schlanker Client auf `node:net`/`node:tls` (keine Abhängigkeit). Verbindung aus `SMTP_URL`:
 *   `smtps://` mit TLS ab dem ersten Byte (Standard-Port 465), `smtp://` mit STARTTLS als Pflicht (Standard-Port 587);
 *   Zertifikat und Name geprüft, mindestens TLS 1.2. Ohne TLS (Klartext, Zertifikat ungeprüft) nur mit
 *   `SMTP_ALLOW_INSECURE`, in Produktion verboten. Anmeldung mit `AUTH PLAIN` oder `AUTH LOGIN`, nie ohne TLS ausser im
 *   Entwicklungsmodus. Feste Frist für den ganzen Versand (`SMTP_TIMEOUT`), auch bei tröpfchenweiser Antwort.
 * - **protokoll:** versendet nichts, schreibt die Nachricht ins Log und hält die letzten 100 fest (`sent`) – für
 *   Entwicklung und Tests; in Produktion verboten (Inhalte wie Links mit Token gehören nicht ins Log).
 * - **aus** (Standard): jeder Versand scheitert mit `MailError` (dauerhaft).
 *
 * Schutz gegen Header-Injection: Adressen, Namen und Betreff mit Zeilenumbruch oder Steuerzeichen sind ein Fehler,
 * nichts wird still bereinigt. Adressen nur ASCII (kein SMTPUTF8); Namen und Betreff mit anderen Zeichen als
 * Encoded-Word (RFC 2047). Text und optional HTML (`multipart/alternative`), je UTF-8 in Base64.
 */
import { randomUUID } from 'node:crypto';
import net, { isIP } from 'node:net';
import { hostname } from 'node:os';
import tls from 'node:tls';
import type { PlatformConfig } from '../config/env.ts';
import type { Log } from '../worker/queue.ts';

export type MailAdapter = 'aus' | 'protokoll' | 'smtp';

export interface MailMessage {
  /** Empfänger: `name@example.ch` oder `Name <name@example.ch>`. */
  to: string | readonly string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface MailResult { messageId: string; accepted: string[] }

export interface Mailer {
  readonly adapter: MailAdapter;
  send(message: MailMessage): Promise<MailResult>;
}

/** Versand gescheitert. `permanent`: erneuter Versuch zwecklos (5xx, ungültige Nachricht, nicht eingerichtet). */
export class MailError extends Error {
  readonly permanent: boolean;
  readonly code: number | undefined;
  constructor(message: string, permanent = false, code?: number) { super(message); this.permanent = permanent; this.code = code; }
}

interface Address { name: string | null; address: string }

// Lokaler Teil als dot-atom (RFC 5322 3.2.3), Domain aus Labels; nur ASCII
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
// Zeilenumbrüche und alle übrigen Steuerzeichen (C0, DEL, C1, Zeilen- und Absatztrenner)
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

/** Adresse lesen und prüfen; wirft `MailError` (dauerhaft), nie still bereinigt. */
export function parseAddress(raw: string, field = 'Adresse'): Address {
  if (CONTROL.test(raw)) throw new MailError(`${field}: Zeilenumbruch oder Steuerzeichen nicht erlaubt`, true);
  const m = /^\s*(?:(.*?)\s*<([^<>]*)>|([^<>\s]+))\s*$/.exec(raw);
  const address = m?.[2] ?? m?.[3];
  const at = address?.lastIndexOf('@') ?? -1;
  if (!address || at < 1 || address.length > 254 || at > 64 || !LOCAL.test(address.slice(0, at)) || !DOMAIN.test(address.slice(at + 1))) {
    throw new MailError(`${field}: «${raw}» ist keine gültige Adresse`, true);
  }
  const name = m?.[1]?.replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').trim() || null;
  return { name, address };
}

/** Encoded-Words (RFC 2047, Base64) zu höchstens 60 Zeichen, gefaltet (Zeilen bis 78 Zeichen samt Feldname); Zeichen werden nie geteilt. */
function encodedWords(s: string): string {
  const words: string[] = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 36) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

const PRINTABLE = /^[\x20-\x7e]*$/;

function formatAddress(a: Address): string {
  if (!a.name) return a.address;
  const name = PRINTABLE.test(a.name) ? `"${a.name.replace(/["\\]/g, '\\$&')}"` : encodedWords(a.name);
  return `${name} <${a.address}>`;
}

function subjectHeader(subject: string): string {
  if (CONTROL.test(subject)) throw new MailError('Betreff: Zeilenumbruch oder Steuerzeichen nicht erlaubt', true);
  return PRINTABLE.test(subject) && subject.length <= 70 ? subject : encodedWords(subject);
}

/** UTF-8 in Base64, Zeilen zu 76 Zeichen. */
function base64Body(s: string): string {
  return (Buffer.from(s.replace(/\r?\n/g, '\r\n')).toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/** Datum nach RFC 5322 (`Tue, 27 Oct 2026 10:00:00 +0000`). */
const mailDate = (d: Date) => d.toUTCString().replace(/GMT$/, '+0000');

export interface BuiltMail { from: string; to: string[]; messageId: string; data: string }

/** Nachricht prüfen und als RFC-5322-Text mit CRLF aufbauen (ohne Punkt-Maskierung). */
export function buildMail(fromRaw: string, m: MailMessage): BuiltMail {
  const from = parseAddress(fromRaw, 'Absender');
  const list = typeof m.to === 'string' ? [m.to] : [...m.to];
  if (!list.length) throw new MailError('Empfänger fehlt', true);
  const to = list.map(x => parseAddress(x, 'Empfänger'));
  const replyTo = m.replyTo === undefined ? null : parseAddress(m.replyTo, 'Antwort an');
  const subject = subjectHeader(m.subject);
  const messageId = `<${randomUUID()}@${from.address.slice(from.address.lastIndexOf('@') + 1)}>`;
  const headers = [
    `From: ${formatAddress(from)}`,
    `To: ${to.map(formatAddress).join(',\r\n ')}`,
    ...(replyTo ? [`Reply-To: ${formatAddress(replyTo)}`] : []),
    `Subject: ${subject}`,
    `Date: ${mailDate(new Date())}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];
  const part = (type: string, body: string) => [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', base64Body(body)];
  let body: string[];
  if (m.html === undefined) body = part('text/plain', m.text);
  else {
    const boundary = `=_${randomUUID()}`;
    body = [`Content-Type: multipart/alternative;\r\n boundary="${boundary}"`, '',
      `--${boundary}`, ...part('text/plain', m.text), `--${boundary}`, ...part('text/html', m.html), `--${boundary}--`];
  }
  return { from: from.address, to: to.map(a => a.address), messageId, data: [...headers, ...body].join('\r\n') + '\r\n' };
}

/** Versand abgeschaltet (`MAIL_ADAPTER=aus`). */
export function disabledMailer(): Mailer {
  return { adapter: 'aus', async send() { throw new MailError('E-Mail-Versand nicht eingerichtet (MAIL_ADAPTER=aus)', true); } };
}

export interface LoggedMail { from: string; to: string[]; replyTo?: string; subject: string; text: string; html?: string; messageId: string; data: string }

/** Adapter «protokoll»: prüft und baut die Nachricht wie «smtp», versendet sie nicht, schreibt sie ins Log. */
export function protokollMailer(o: { from: string; log?: Pick<Log, 'info'> }): Mailer & { readonly sent: LoggedMail[] } {
  const sent: LoggedMail[] = [];
  return {
    adapter: 'protokoll',
    sent,
    async send(m) {
      const built = buildMail(o.from, m);
      const entry: LoggedMail = {
        from: built.from, to: built.to, subject: m.subject, text: m.text, messageId: built.messageId, data: built.data,
        ...(m.replyTo !== undefined ? { replyTo: m.replyTo } : {}), ...(m.html !== undefined ? { html: m.html } : {}),
      };
      sent.push(entry);
      if (sent.length > 100) sent.shift();
      o.log?.info({ mail: { to: entry.to, subject: entry.subject, messageId: entry.messageId, text: entry.text } }, 'E-Mail (Protokoll, nicht versendet)');
      return { messageId: built.messageId, accepted: built.to };
    },
  };
}

export interface SmtpOptions {
  /** `smtps://user:pass@host:465` oder `smtp://user:pass@host:587` (STARTTLS); Benutzer und Passwort URL-kodiert. */
  url: string;
  /** Absender (`MAIL_FROM`), auch für den Umschlag (`MAIL FROM`). */
  from: string;
  /** Frist für den ganzen Versand (Standard 30 s). */
  timeoutMs?: number;
  /** Nur Entwicklung: Klartext ohne STARTTLS und ungeprüftes Zertifikat zulassen. */
  allowInsecure?: boolean;
  /** Vertrauenswürdige Zertifikate statt der Standard-Liste (z. B. eigener Testserver). */
  ca?: string | Buffer;
  /** Name im `EHLO` (Standard: Hostname). */
  ehloName?: string;
}

/** `SMTP_URL` prüfen; liefert die Fehler (leer = gültig). */
export function smtpUrlProblems(raw: string): string[] {
  let url: URL;
  try { url = new URL(raw); } catch { return ['ungültige Adresse']; }
  const problems: string[] = [];
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') problems.push('nur smtp:// (STARTTLS) oder smtps:// (TLS)');
  if (!url.hostname) problems.push('Host fehlt');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) problems.push('ohne Pfad, Parameter und Fragment');
  if (url.password && !url.username) problems.push('Passwort ohne Benutzer');
  try { decodeURIComponent(url.username); decodeURIComponent(url.password); } catch { problems.push('Benutzer oder Passwort falsch URL-kodiert'); }
  return problems;
}

interface Reply { code: number; lines: string[] }

/** Antworten des Servers zeilenweise lesen (mehrzeilig mit `250-`, Ende mit `250 `). */
class SmtpReader {
  private buf = '';
  private lines: string[] = [];
  private ready: Reply[] = [];
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  failure: Error | null = null;

  push(chunk: Buffer): void {
    this.buf += chunk.toString('latin1');
    if (this.buf.length > 64 * 1024) return this.fail(new MailError('Antwort des Servers zu lang'));
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -]|$)(.*)$/.exec(line);
      if (!m) return this.fail(new MailError(`ungültige Antwort des Servers: «${line.slice(0, 80)}»`));
      this.lines.push(m[3]!);
      if (m[2] !== '-') { this.ready.push({ code: Number(m[1]), lines: this.lines }); this.lines = []; }
    }
    if (this.waiting && this.ready.length) { const w = this.waiting; this.waiting = null; w.resolve(this.ready.shift()!); }
  }

  /** Noch ungelesene Daten (nach STARTTLS ein Angriff: Antworten vor dem Handshake eingeschleust). */
  pending(): boolean { return this.buf.length > 0 || this.lines.length > 0 || this.ready.length > 0; }

  fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.reject(e); }
  }

  read(): Promise<Reply> {
    if (this.ready.length) return Promise.resolve(this.ready.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
}

const ehloHost = () => (/^[A-Za-z0-9.-]{1,253}$/.test(hostname()) ? hostname() : 'localhost');

/** Adapter «smtp». */
export function smtpMailer(o: SmtpOptions): Mailer {
  const problems = smtpUrlProblems(o.url);
  if (problems.length) throw new MailError(`SMTP_URL: ${problems.join(', ')}`, true);
  parseAddress(o.from, 'Absender');
  return { adapter: 'smtp', send: async m => smtpSend(o, buildMail(o.from, m)) };
}

async function smtpSend(o: SmtpOptions, mail: BuiltMail): Promise<MailResult> {
  const url = new URL(o.url);
  const secure = url.protocol === 'smtps:';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (secure ? 465 : 587));
  const timeoutMs = o.timeoutMs ?? 30_000;
  const insecure = o.allowInsecure === true;
  const tlsOptions = (): tls.ConnectionOptions => ({
    host, servername: isIP(host) ? undefined : host, rejectUnauthorized: !insecure, minVersion: 'TLSv1.2', ...(o.ca ? { ca: o.ca } : {}),
  });
  const reader = new SmtpReader();
  const onData = (c: Buffer) => reader.push(c);
  const onError = (e: Error) => reader.fail(e instanceof MailError ? e : new MailError(`Verbindung zum Mailserver: ${e.message}`));
  const onClose = () => reader.fail(new MailError('Mailserver hat die Verbindung geschlossen'));
  const attach = (s: net.Socket) => { s.on('data', onData); s.on('error', onError); s.on('close', onClose); };
  const detach = (s: net.Socket) => { s.off('data', onData); s.off('error', onError); s.off('close', onClose); };

  let socket: net.Socket = secure ? tls.connect({ host, port, ...tlsOptions() }) : net.connect({ host, port });
  attach(socket);
  // Feste Frist für den ganzen Versand; das Leerlauf-Zeitlimit des Sockets allein griffe bei tröpfchenweiser Antwort nie
  let abortHandshake: ((e: MailError) => void) | null = null;
  const deadline = setTimeout(() => {
    const e = new MailError(`Zeitlimit ${timeoutMs} ms beim Versand überschritten`);
    reader.fail(e);
    abortHandshake?.(e);
    socket.destroy();
  }, timeoutMs);

  const expect = async (codes: number[] | 'positiv', what: string): Promise<Reply> => {
    const r = await reader.read();
    if (codes === 'positiv' ? r.code < 200 || r.code > 299 : !codes.includes(r.code)) throw new MailError(`${what}: ${r.code} ${r.lines.join(' ').slice(0, 200)}`, r.code >= 500, r.code);
    return r;
  };
  const command = (line: string, codes: number[] | 'positiv', what: string) => { socket.write(`${line}\r\n`); return expect(codes, what); };
  const ehlo = async () => {
    const r = await command(`EHLO ${o.ehloName ?? ehloHost()}`, [250], 'EHLO');
    return r.lines.slice(1).map(l => l.toUpperCase());
  };

  try {
    await expect([220], 'Begrüssung');
    let caps = await ehlo();
    if (!secure) {
      if (caps.some(c => c === 'STARTTLS')) {
        await command('STARTTLS', [220], 'STARTTLS');
        if (reader.pending()) throw new MailError('Mailserver sendet vor dem TLS-Handshake weitere Daten (STARTTLS-Injection)');
        detach(socket);
        const plain = socket;
        socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
          const s = tls.connect({ socket: plain, ...tlsOptions() }, () => { s.off('error', reject); s.off('close', closed); abortHandshake = null; resolve(s); });
          const closed = () => reject(new Error('Verbindung beim Handshake geschlossen'));
          s.once('error', reject);
          s.once('close', closed);
          // Frist abgelaufen: Handshake nicht offen lassen
          abortHandshake = e => { s.destroy(); reject(e); };
        }).catch(e => {
          plain.destroy();
          throw e instanceof MailError ? e : new MailError(`TLS mit dem Mailserver: ${(e as Error).message}`);
        });
        attach(socket);
        caps = await ehlo();
      } else if (!insecure) {
        throw new MailError('Mailserver bietet kein STARTTLS – TLS ist Pflicht (SMTP_ALLOW_INSECURE nur in Entwicklung)');
      }
    }
    if (url.username) {
      const user = decodeURIComponent(url.username), pass = decodeURIComponent(url.password);
      const auth = caps.find(c => c.startsWith('AUTH ') || c.startsWith('AUTH='))?.slice(5).split(/\s+/) ?? [];
      const b64 = (s: string) => Buffer.from(s).toString('base64');
      if (auth.includes('PLAIN')) await command(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235], 'Anmeldung');
      else if (auth.includes('LOGIN')) {
        await command('AUTH LOGIN', [334], 'Anmeldung');
        await command(b64(user), [334], 'Anmeldung');
        await command(b64(pass), [235], 'Anmeldung');
      } else throw new MailError('Mailserver bietet weder AUTH PLAIN noch AUTH LOGIN', true);
    }
    await command(`MAIL FROM:<${mail.from}>`, [250], 'Absender');
    for (const rcpt of mail.to) await command(`RCPT TO:<${rcpt}>`, [250, 251], `Empfänger ${rcpt}`);
    await command('DATA', [354], 'DATA');
    // Punkt-Maskierung (RFC 5321 4.5.2), dann Ende mit <CRLF>.<CRLF>
    socket.write(mail.data.replace(/^\./gm, '..') + '.\r\n');
    // Jede abschliessende 2xx-Antwort ist Annahme (RFC 5321 4.2.5); sonst würde ein erneuter Versuch doppelt zustellen
    await expect('positiv', 'Nachricht');
    // Höflich beenden; antwortet der Server nicht, schliesst die Verbindung nach einer Sekunde ohnehin
    socket.end('QUIT\r\n');
    const s = socket, linger = setTimeout(() => s.destroy(), 1000);
    linger.unref();
    s.once('close', () => clearTimeout(linger));
    return { messageId: mail.messageId, accepted: mail.to };
  } catch (e) {
    socket.destroy();
    throw e;
  } finally {
    clearTimeout(deadline);
    detach(socket);
    socket.on('error', () => {});
  }
}

/** Mailer nach der Konfiguration (`MAIL_ADAPTER`, `MAIL_FROM`, `SMTP_URL`, `SMTP_TIMEOUT`, `SMTP_ALLOW_INSECURE`). */
export function createMailer(cfg: Pick<PlatformConfig, 'app'>, log?: Pick<Log, 'info'>): Mailer {
  const m = cfg.app.mail;
  if (m.adapter === 'smtp') return smtpMailer({ url: m.smtpUrl!, from: m.from!, timeoutMs: m.timeoutMs, allowInsecure: m.allowInsecure });
  if (m.adapter === 'protokoll') return protokollMailer({ from: m.from ?? 'noreply@localhost.localdomain', log });
  return disabledMailer();
}
