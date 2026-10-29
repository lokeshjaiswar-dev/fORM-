import { createServer, type AddressInfo, type Socket } from 'node:net';

export interface DeliveredMail {
  /** Without angle brackets. */
  messageId: string;
  subject: string;
  /** Every envelope recipient (To, Cc and Bcc), lower-cased. */
  recipients: string[];
  /** The message as received, CRLF line endings. */
  raw: string;
}

/** Where a mailer contract looks for what it sent: the in-process sink below, or a real Mailpit. */
export interface Inbox {
  /** Whether `raw` is exactly what the mailer sent. Mailpit adds its own Bcc header, so Bcc header checks need a verbatim inbox. */
  readonly verbatim: boolean;
  find(messageId: string): Promise<DeliveredMail | undefined>;
}

/** What a test server refuses, so a mailer contract can check bounce handling. */
export interface SmtpRefusals {
  /** MAIL FROM answered 550: a sender or configuration problem. */
  refusedSender: string;
  /** RCPT TO answered 550: a hard bounce. */
  hardBounce: string;
  /** RCPT TO answered 451: deferred. */
  deferred: string;
  /** A message whose subject contains this is answered 554 after DATA. */
  refusedSubject: string;
}

export const SINK_REFUSALS: SmtpRefusals = {
  refusedSender: 'blocked@refuse.test',
  hardBounce: 'no-such-user@refuse.test',
  deferred: 'mailbox-busy@refuse.test',
  refusedSubject: '[testkit:refuse]',
};

export interface SmtpSink extends Inbox {
  readonly host: string;
  readonly port: number;
  /** Always applied; nothing the sink refuses is stored. */
  readonly refusals: SmtpRefusals;
  readonly messages: readonly DeliveredMail[];
  close(): Promise<void>;
}

const bare = (id: string) => id.trim().replace(/^<|>$/g, '');

/** Splits the header block and unfolds continuation lines. */
export function parseHeaders(raw: string): Map<string, string> {
  const end = raw.indexOf('\r\n\r\n');
  const block = (end === -1 ? raw : raw.slice(0, end)).replace(/\r\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return headers;
}

/** RFC 2047 encoded words (UTF-8, B or Q); adjacent words join without the whitespace between them. */
export function decodeMimeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _charset: string, enc: string, text: string) => {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_q, h: string) => String.fromCharCode(parseInt(h, 16))),
              'latin1',
            );
      return bytes.toString('utf8');
    });
}

const envelopeAddress = (line: string) => (/<([^>]*)>/.exec(line)?.[1] ?? '').toLowerCase();

/**
 * A minimal SMTP receiver for tests (no TLS, no auth, no pipelining), so mailer contracts run in
 * `pnpm test` without Docker. Mailpit speaks the same protocol for manual and container runs.
 * It refuses the senders, recipients and subjects in `SINK_REFUSALS`.
 */
export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: DeliveredMail[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let data: string[] = [];
    let recipients: string[] = [];
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 testkit ESMTP');

    const command = (line: string) => {
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') return reply('250 testkit');
      if (verb === 'MAIL') {
        recipients = [];
        if (envelopeAddress(line) === SINK_REFUSALS.refusedSender) return reply('550 5.7.1 Sender refused');
        return reply('250 OK');
      }
      if (verb === 'RCPT') {
        const address = envelopeAddress(line);
        if (address === SINK_REFUSALS.hardBounce) return reply('550 5.1.1 No such user');
        if (address === SINK_REFUSALS.deferred) return reply('451 4.2.1 Mailbox busy, try again later');
        recipients.push(address);
        return reply('250 OK');
      }
      if (verb === 'DATA') {
        inData = true;
        data = [];
        return reply('354 End data with <CR><LF>.<CR><LF>');
      }
      if (verb === 'RSET') {
        recipients = [];
        return reply('250 OK');
      }
      if (verb === 'NOOP') return reply('250 OK');
      if (verb === 'QUIT') {
        reply('221 Bye');
        return socket.end();
      }
      return reply('502 Command not implemented');
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (!inData) {
          command(line);
          continue;
        }
        if (line === '.') {
          inData = false;
          const raw = `${data.join('\r\n')}\r\n`;
          const headers = parseHeaders(raw);
          const subject = decodeMimeWords(headers.get('subject') ?? '');
          if (subject.includes(SINK_REFUSALS.refusedSubject)) {
            reply('554 5.6.0 Message refused');
            continue;
          }
          messages.push({ messageId: bare(headers.get('message-id') ?? ''), subject, recipients, raw });
          reply('250 OK queued');
          continue;
        }
        data.push(line.startsWith('..') ? line.slice(1) : line);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    host: '127.0.0.1',
    port,
    messages,
    refusals: SINK_REFUSALS,
    verbatim: true,
    find: async (messageId) => messages.find((m) => m.messageId === bare(messageId)),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const s of sockets) s.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

interface MailpitAddress {
  Address: string;
}

interface MailpitMessage {
  ID: string;
  MessageID: string;
  Subject: string;
  To: MailpitAddress[] | null;
  Cc: MailpitAddress[] | null;
  Bcc: MailpitAddress[] | null;
}

/** Reads a real Mailpit (`axllent/mailpit`) through its HTTP API, e.g. `http://localhost:8025`. */
export function mailpitInbox(apiUrl: string, o: { timeoutMs?: number } = {}): Inbox {
  const base = apiUrl.replace(/\/$/, '');
  const getJson = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`Mailpit ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    verbatim: false,
    async find(messageId) {
      const id = bare(messageId);
      const deadline = Date.now() + (o.timeoutMs ?? 5000);
      for (;;) {
        const search = await getJson<{ messages: MailpitMessage[] }>(`/api/v1/search?query=${encodeURIComponent(`message-id:"${id}"`)}`);
        const hit = search.messages.find((m) => bare(m.MessageID) === id);
        if (hit) {
          const msg = await getJson<MailpitMessage>(`/api/v1/message/${hit.ID}`);
          const rawRes = await fetch(`${base}/api/v1/message/${hit.ID}/raw`);
          if (!rawRes.ok) throw new Error(`Mailpit raw message ${hit.ID}: HTTP ${rawRes.status}`);
          const recipients = [...(msg.To ?? []), ...(msg.Cc ?? []), ...(msg.Bcc ?? [])].map((a) => a.Address.toLowerCase());
          const raw = (await rawRes.text()).replace(/\r?\n/g, '\r\n');
          return { messageId: bare(msg.MessageID), subject: msg.Subject, recipients, raw };
        }
        if (Date.now() > deadline) return undefined;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}

/** Mailpit, pinned by digest like `deploy/docker/compose.dev.yaml`. */
export const MAILPIT_IMAGE = 'axllent/mailpit:v1.31.3@sha256:ed9b00c609e77e99c79b93f1178255ebc271868920f2c69a8d166bd5634ed10d';

export interface MailpitServer {
  smtpUrl: string;
  apiUrl: string;
  stop(): Promise<void>;
}

/**
 * Mailpit in a Testcontainers container (the WP-0.15 dev SMTP sink), for end-to-end runs that read mail through its
 * HTTP API. `ports` pins the host ports, so a process started before the container knows where to look.
 */
export async function startMailpit(o: { ports?: { smtp: number; api: number } } = {}): Promise<MailpitServer> {
  const { GenericContainer, Wait } = await import('testcontainers');
  const exposed = o.ports
    ? [
        { container: 1025, host: o.ports.smtp },
        { container: 8025, host: o.ports.api },
      ]
    : [1025, 8025];
  const container = await new GenericContainer(MAILPIT_IMAGE)
    .withExposedPorts(...exposed)
    .withWaitStrategy(Wait.forHttp('/livez', 8025))
    .start();
  const host = container.getHost();
  return {
    smtpUrl: `smtp://${host}:${container.getMappedPort(1025)}`,
    apiUrl: `http://${host}:${container.getMappedPort(8025)}`,
    stop: async () => {
      await container.stop();
    },
  };
}
