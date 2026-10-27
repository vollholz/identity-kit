/**
 * E-Mail-Versand: SMTP gegen einen lokalen Testserver (STARTTLS, TLS ab dem ersten Byte, Klartext nur im
 * Entwicklungsmodus), Anmeldung erst nach TLS, Zeitlimit, Header-Injection, Text und HTML, Fehler dauerhaft oder
 * vorübergehend; Adapter «protokoll» und «aus»; Konfiguration.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import tls from 'node:tls';
import { ConfigError, MailError, createMailer, protokollMailer, smtpMailer } from '../src/index.ts';
import { app } from './fixture/app.ts';

// Selbstsigniertes Zertifikat für 127.0.0.1, nur für diesen Lauf
let key = '', cert = '';
before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'smtp-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  key = readFileSync(join(dir, 'key.pem'), 'utf8');
  cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
});

interface Received { from: string; to: string[]; data: string; auth: { mech: string; user: string; pass: string; tls: boolean } | null; tlsAtMail: boolean; commands: string[] }

interface FakeOptions {
  mode: 'smtps' | 'starttls' | 'plain';
  auth?: ('PLAIN' | 'LOGIN')[];
  rcpt?: (address: string) => string;
  /** Begrüssung nie senden (Zeitlimit). */
  silent?: boolean;
  /** Nach «220 STARTTLS» eine eingeschleuste Antwort im Klartext nachschieben. */
  inject?: boolean;
  /** Nach «220 STARTTLS» den Handshake nie beginnen (Zeitlimit im Handshake). */
  stall?: boolean;
}

/** Kleiner SMTP-Server für die Tests: hält jede angenommene Nachricht fest. */
async function fakeSmtp(o: FakeOptions) {
  const received: Received[] = [];
  const sockets = new Set<net.Socket>();
  const handle = (raw: net.Socket, secure: boolean) => {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => {});
    let sock: net.Socket = raw, isTls = secure, buf = '', data: string[] | null = null, login: string[] | null = null;
    const msg: Received = { from: '', to: [], data: '', auth: null, tlsAtMail: false, commands: [] };
    const say = (l: string) => sock.write(`${l}\r\n`);
    const ehlo = () => {
      const caps = ['250-fake.test', ...(o.mode === 'starttls' && !isTls ? ['250-STARTTLS'] : []), ...(o.auth ? [`250-AUTH ${o.auth.join(' ')}`] : []), '250 8BITMIME'];
      for (const c of caps) say(c);
    };
    const line = (l: string) => {
      if (data) {
        if (l === '.') { msg.data = data.join('\r\n'); received.push({ ...msg, to: [...msg.to] }); data = null; say('250 angenommen'); }
        else data.push(l.startsWith('..') ? l.slice(1) : l);
        return;
      }
      msg.commands.push(l);
      if (login) {
        login.push(Buffer.from(l, 'base64').toString());
        if (login.length === 1) say('334 UGFzc3dvcmQ6');
        else { msg.auth = { mech: 'LOGIN', user: login[0]!, pass: login[1]!, tls: isTls }; login = null; say('235 ok'); }
        return;
      }
      const [verb] = l.split(' ');
      switch (verb!.toUpperCase()) {
        case 'EHLO': return ehlo();
        case 'STARTTLS':
          // Eingeschleust: im selben Paket wie die Zusage, also vor dem Handshake beim Client
          say(o.inject ? '220 los\r\n250 eingeschleust' : '220 los');
          sock.removeAllListeners('data');
          if (o.stall) return;
          sock = new tls.TLSSocket(sock, { isServer: true, key, cert });
          sock.on('error', () => {});
          isTls = true;
          sock.on('data', onData);
          return;
        case 'AUTH': {
          const [, mech, arg] = l.split(' ');
          if (mech === 'PLAIN') {
            const [, user, pass] = Buffer.from(arg!, 'base64').toString().split('\0');
            msg.auth = { mech, user: user!, pass: pass!, tls: isTls };
            return say('235 ok');
          }
          login = [];
          return say('334 VXNlcm5hbWU6');
        }
        case 'MAIL': msg.from = /<(.*)>/.exec(l)![1]!; msg.tlsAtMail = isTls; return say('250 ok');
        case 'RCPT': {
          const a = /<(.*)>/.exec(l)![1]!;
          const reply = o.rcpt?.(a) ?? '250 ok';
          if (reply.startsWith('25')) msg.to.push(a);
          return say(reply);
        }
        case 'DATA': data = []; return say('354 los');
        case 'QUIT': say('221 tschüss'); return sock.end();
        default: return say('502 unbekannt');
      }
    };
    const onData = (c: Buffer) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); line(l); }
    };
    sock.on('data', onData);
    if (!o.silent) say('220 fake.test ESMTP');
  };
  const server = o.mode === 'smtps' ? tls.createServer({ key, cert }, s => handle(s, true)) : net.createServer(s => handle(s, false));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    received, port,
    url: (user = 'konto%40probe.ch', pass = 'ge%3Aheim') => `${o.mode === 'smtps' ? 'smtps' : 'smtp'}://${user}:${pass}@127.0.0.1:${port}`,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

/** Teile einer empfangenen Nachricht: Kopfzeilen und dekodierte Inhalte je Content-Type. */
function parse(data: string) {
  const [head, ...rest] = data.split('\r\n\r\n');
  const headers = head!.replace(/\r\n /g, ' ');
  const header = (name: string) => new RegExp(`^${name}: (.*)$`, 'mi').exec(headers)?.[1];
  const decodeWords = (v: string) => v.replace(/\?=\s+=\?/g, '?==?').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString());
  const parts: Record<string, string> = {};
  for (const m of data.matchAll(/Content-Type: (text\/\w+); charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|\r\n$)/g)) {
    parts[m[1]!] = Buffer.from(m[2]!.replace(/\r\n/g, ''), 'base64').toString();
  }
  const single = /^(text\/\w+); charset=utf-8$/.exec(header('Content-Type') ?? '')?.[1];
  if (single) parts[single] = Buffer.from(rest.join('').replace(/\r\n/g, ''), 'base64').toString();
  return { header, subject: decodeWords(header('Subject') ?? ''), from: decodeWords(header('From') ?? ''), parts, body: rest.join('\r\n\r\n') };
}

const FROM = 'Probe Ärzte <noreply@probe.ch>';
const message = { to: ['Anna Muster <anna@example.ch>', 'ben@example.ch'], subject: 'Schicht morgen: Änderung für Zürich – bitte prüfen, die Zeiten haben sich verschoben', text: 'Hallo\n.\nZeile mit Punkt', html: '<p>Hallo</p>' };

test('STARTTLS: Anmeldung erst nach TLS, Text und HTML, Umlaute, Punkt-Maskierung', async () => {
  const srv = await fakeSmtp({ mode: 'starttls', auth: ['PLAIN', 'LOGIN'] });
  try {
    const r = await smtpMailer({ url: srv.url(), from: FROM, ca: cert, timeoutMs: 5000 }).send(message);
    assert.deepEqual(r.accepted, ['anna@example.ch', 'ben@example.ch']);
    const [got] = srv.received;
    assert.ok(got);
    assert.deepEqual(got.auth, { mech: 'PLAIN', user: 'konto@probe.ch', pass: 'ge:heim', tls: true });
    assert.ok(got.tlsAtMail);
    assert.equal(got.from, 'noreply@probe.ch');
    assert.deepEqual(got.to, ['anna@example.ch', 'ben@example.ch']);
    const p = parse(got.data);
    assert.equal(p.subject, message.subject);
    assert.equal(p.from, 'Probe Ärzte <noreply@probe.ch>');
    assert.equal(p.header('To'), '"Anna Muster" <anna@example.ch>, ben@example.ch');
    assert.equal(p.header('Message-ID'), r.messageId);
    assert.match(p.header('Content-Type') ?? '', /^multipart\/alternative; boundary=/);
    assert.equal(p.parts['text/plain'], 'Hallo\r\n.\r\nZeile mit Punkt');
    assert.equal(p.parts['text/html'], '<p>Hallo</p>');
    for (const l of got.data.split('\r\n')) assert.ok(l.length <= 78, `Zeile zu lang: ${l}`);
  } finally { srv.close(); }
});

test('smtps: TLS ab dem ersten Byte, AUTH LOGIN, nur Text', async () => {
  const srv = await fakeSmtp({ mode: 'smtps', auth: ['LOGIN'] });
  try {
    await smtpMailer({ url: srv.url(), from: 'noreply@probe.ch', ca: cert }).send({ to: 'anna@example.ch', subject: 'Hallo', text: 'Nur Text' });
    const [got] = srv.received;
    assert.deepEqual(got?.auth, { mech: 'LOGIN', user: 'konto@probe.ch', pass: 'ge:heim', tls: true });
    const p = parse(got!.data);
    assert.equal(p.header('Content-Type'), 'text/plain; charset=utf-8');
    assert.equal(p.parts['text/plain'], 'Nur Text');
    assert.equal(p.subject, 'Hallo');
  } finally { srv.close(); }
});

test('TLS ist Pflicht: ohne STARTTLS kein Versand und keine Anmeldung; Klartext nur ausdrücklich', async () => {
  const srv = await fakeSmtp({ mode: 'plain', auth: ['PLAIN'] });
  try {
    await assert.rejects(smtpMailer({ url: srv.url(), from: FROM }).send(message), (e: unknown) => e instanceof MailError && /kein STARTTLS/.test(e.message));
    assert.equal(srv.received.length, 0);
    await smtpMailer({ url: srv.url(), from: FROM, allowInsecure: true }).send(message);
    assert.equal(srv.received.length, 1);
    assert.equal(srv.received[0]!.auth?.tls, false);
  } finally { srv.close(); }
});

test('Zertifikat wird geprüft', async () => {
  const srv = await fakeSmtp({ mode: 'starttls', auth: ['PLAIN'] });
  const tls2 = await fakeSmtp({ mode: 'smtps', auth: ['PLAIN'] });
  try {
    await assert.rejects(smtpMailer({ url: srv.url(), from: FROM }).send(message), /TLS mit dem Mailserver/);
    await assert.rejects(smtpMailer({ url: tls2.url(), from: FROM }).send(message), /Verbindung zum Mailserver/);
    assert.equal(srv.received.length + tls2.received.length, 0);
  } finally { srv.close(); tls2.close(); }
});

test('STARTTLS-Injection: Antworten vor dem Handshake brechen ab', async () => {
  const srv = await fakeSmtp({ mode: 'starttls', auth: ['PLAIN'], inject: true });
  try {
    await assert.rejects(smtpMailer({ url: srv.url(), from: FROM, ca: cert }).send(message), /STARTTLS-Injection/);
  } finally { srv.close(); }
});

test('Zeitlimit für den ganzen Versand', async () => {
  const srv = await fakeSmtp({ mode: 'starttls', silent: true });
  try {
    const started = Date.now();
    await assert.rejects(smtpMailer({ url: srv.url(), from: FROM, timeoutMs: 300 }).send(message), (e: unknown) => e instanceof MailError && /Zeitlimit 300 ms/.test(e.message) && !e.permanent);
    assert.ok(Date.now() - started < 2000);
  } finally { srv.close(); }
  const stalled = await fakeSmtp({ mode: 'starttls', stall: true });
  try {
    await assert.rejects(smtpMailer({ url: stalled.url(), from: FROM, timeoutMs: 300, ca: cert }).send(message), /Zeitlimit 300 ms/);
  } finally { stalled.close(); }
});

test('abgelehnte Empfänger: 5xx dauerhaft, 4xx vorübergehend', async () => {
  const srv = await fakeSmtp({ mode: 'starttls', auth: ['PLAIN'], rcpt: a => (a.startsWith('weg') ? '550 unbekannt' : a.startsWith('voll') ? '452 Postfach voll' : '250 ok') });
  try {
    const mailer = smtpMailer({ url: srv.url(), from: FROM, ca: cert });
    await assert.rejects(mailer.send({ ...message, to: 'weg@example.ch' }), (e: unknown) => e instanceof MailError && e.permanent && e.code === 550);
    await assert.rejects(mailer.send({ ...message, to: 'voll@example.ch' }), (e: unknown) => e instanceof MailError && !e.permanent && e.code === 452);
    assert.equal(srv.received.length, 0);
  } finally { srv.close(); }
});

test('Header-Injection: Zeilenumbrüche in Adressen, Namen und Betreff sind ein Fehler', async () => {
  const srv = await fakeSmtp({ mode: 'starttls', auth: ['PLAIN'] });
  try {
    const mailer = smtpMailer({ url: srv.url(), from: FROM, ca: cert });
    const bad = [
      { ...message, to: 'anna@example.ch\r\nBcc: alle@example.ch' },
      { ...message, to: 'Anna\nBcc: x@example.ch <anna@example.ch>' },
      { ...message, subject: 'Hallo\r\nBcc: alle@example.ch' },
      { ...message, subject: 'Hallo Bcc: alle@example.ch' },
      { ...message, replyTo: 'x@example.ch\rBcc: y@example.ch' },
      { ...message, to: 'anna@example.ch>\r\nRCPT TO:<x@example.ch' },
      { ...message, to: 'kein-at' },
      { ...message, to: [] },
    ];
    for (const m of bad) await assert.rejects(mailer.send(m), (e: unknown) => e instanceof MailError && e.permanent, JSON.stringify(m.to) + m.subject);
    assert.throws(() => smtpMailer({ url: srv.url(), from: 'x@probe.ch\r\nBcc: y@probe.ch', ca: cert }), MailError);
    assert.equal(srv.received.length, 0);
  } finally { srv.close(); }
});

test('Adapter «protokoll» und «aus»', async () => {
  const lines: object[] = [];
  const p = protokollMailer({ from: FROM, log: { info: o => lines.push(o) } });
  const r = await p.send({ to: 'anna@example.ch', subject: 'Einladung', text: 'Link: https://x/abc', replyTo: 'team@probe.ch' });
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0]!.messageId, r.messageId);
  assert.match(p.sent[0]!.data, /^Reply-To: team@probe\.ch$/m);
  assert.deepEqual(lines, [{ mail: { to: ['anna@example.ch'], subject: 'Einladung', messageId: r.messageId, text: 'Link: https://x/abc' } }]);
  await assert.rejects(p.send({ to: 'a@example.ch', subject: 'x\ny', text: '' }), MailError);

  const base = { OIDC_ISSUER_URL: 'http://localhost:8180/realms/probe', DATABASE_URL: 'postgres://x@localhost/probe' };
  const off = createMailer(app.loadConfig(base, 'worker'));
  assert.equal(off.adapter, 'aus');
  await assert.rejects(off.send({ to: 'a@example.ch', subject: 'x', text: 'y' }), (e: unknown) => e instanceof MailError && e.permanent);
  assert.equal(createMailer(app.loadConfig({ ...base, MAIL_ADAPTER: 'protokoll' }, 'worker')).adapter, 'protokoll');
  const srv = await fakeSmtp({ mode: 'plain', auth: ['PLAIN'] });
  try {
    const cfg = app.loadConfig({ ...base, MAIL_ADAPTER: 'smtp', SMTP_URL: srv.url(), MAIL_FROM: FROM, SMTP_ALLOW_INSECURE: 'true', SMTP_TIMEOUT: '5s' }, 'worker');
    assert.deepEqual(cfg.app.mail, { adapter: 'smtp', from: FROM, smtpUrl: srv.url(), timeoutMs: 5000, allowInsecure: true });
    await createMailer(cfg).send({ to: 'anna@example.ch', subject: 'Hallo', text: 'Hallo' });
    assert.equal(srv.received.length, 1);
  } finally { srv.close(); }
});

test('Konfiguration: Pflicht bei smtp, Form, Verbote in Produktion', () => {
  const errorsOf = (env: Record<string, string>) => {
    try { app.loadConfig(env, 'worker'); return []; } catch (e) { assert.ok(e instanceof ConfigError); return e.message.split('\n').slice(1).map(l => l.replace(/^\s+- /, '')); }
  };
  const base = { OIDC_ISSUER_URL: 'http://localhost:8180/realms/probe', DATABASE_URL: 'postgres://x@localhost/probe' };
  const smtp = errorsOf({ ...base, MAIL_ADAPTER: 'smtp' });
  assert.ok(smtp.some(e => e.startsWith('SMTP_URL fehlt')));
  assert.ok(smtp.some(e => e.startsWith('MAIL_FROM fehlt')));
  assert.ok(errorsOf({ ...base, SMTP_URL: 'https://mail.example.ch' }).some(e => e.startsWith('SMTP_URL: nur smtp://')));
  assert.ok(errorsOf({ ...base, MAIL_FROM: 'a@b.ch\nBcc: c@d.ch' }).some(e => e.startsWith('MAIL_FROM: Zeilenumbruch')));
  assert.ok(errorsOf({ ...base, MAIL_ADAPTER: 'brief' }).some(e => e.startsWith('MAIL_ADAPTER:')));
  assert.deepEqual(errorsOf({ ...base, MAIL_ADAPTER: 'smtp', SMTP_URL: 'smtps://u:p@mail.example.ch', MAIL_FROM: 'noreply@probe.ch' }), []);

  const prod = {
    NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://probe.example.ch', OIDC_ISSUER_URL: 'https://id.example.ch/realms/probe',
    DATABASE_URL: 'postgres://x@db/probe', DATABASE_SSL: 'verify-full', ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
  };
  assert.deepEqual(errorsOf(prod), []);
  const errors = errorsOf({ ...prod, MAIL_ADAPTER: 'protokoll', SMTP_ALLOW_INSECURE: 'true' });
  assert.ok(errors.some(e => e.startsWith('MAIL_ADAPTER=protokoll ist in Produktion nicht erlaubt')));
  assert.ok(errors.some(e => e.startsWith('SMTP_ALLOW_INSECURE=true ist in Produktion nicht erlaubt')));
  assert.ok(app.vars.find(v => v.name === 'SMTP_URL')?.secret);
});
