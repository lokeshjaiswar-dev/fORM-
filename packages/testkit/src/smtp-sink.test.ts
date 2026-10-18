import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeMimeWords, parseHeaders, startSmtpSink, type SmtpSink } from './smtp-sink.ts';
import { collectBytes, eicarSample, trackedStream, utf8 } from './index.ts';

describe('decodeMimeWords', () => {
  it('decodes B and Q words and joins adjacent ones', () => {
    const b = `=?UTF-8?B?${Buffer.from('नया उत्तर').toString('base64')}?=`;
    expect(decodeMimeWords(`${b} done`)).toBe('नया उत्तर done');
    expect(decodeMimeWords('=?utf-8?Q?caf=C3=A9_au_lait?= =?utf-8?Q?_ok?=')).toBe('café au lait ok');
    expect(decodeMimeWords('plain')).toBe('plain');
  });
});

describe('parseHeaders', () => {
  it('unfolds continuation lines and stops at the body', () => {
    const h = parseHeaders('Subject: a\r\n  b\r\nMessage-ID: <x@y>\r\n\r\nBody: no\r\n');
    expect(h.get('subject')).toBe('a b');
    expect(h.get('message-id')).toBe('<x@y>');
    expect(h.has('body')).toBe(false);
  });
});

describe('startSmtpSink', () => {
  let sink: SmtpSink;
  beforeAll(async () => {
    sink = await startSmtpSink();
  });
  afterAll(() => sink.close());

  it('receives a message over raw SMTP, un-stuffing dots', async () => {
    const script = [
      'EHLO client',
      'MAIL FROM:<a@x.test>',
      'RCPT TO:<B@x.test>',
      'NOOP',
      'DATA',
      'Message-ID: <m1@x.test>\r\nSubject: hi\r\n\r\n..dotted\r\nline\r\n.',
      'BOGUS',
      'QUIT',
    ];
    const replies = await new Promise<string>((resolve, reject) => {
      const socket = connect(sink.port, sink.host);
      let out = '';
      socket.setEncoding('utf8');
      socket.on('data', (d: string) => (out += d));
      socket.on('end', () => resolve(out));
      socket.on('error', reject);
      socket.write(`${script.join('\r\n')}\r\n`);
    });
    expect(replies).toMatch(/^220 /);
    expect(replies).toContain('354 ');
    expect(replies).toContain('250 OK queued');
    expect(replies).toContain('502 ');
    expect(replies).toContain('221 Bye');
    const got = await sink.find('<m1@x.test>');
    expect(got).toMatchObject({ messageId: 'm1@x.test', subject: 'hi', recipients: ['b@x.test'] });
    expect(got?.raw).toContain('\r\n.dotted\r\nline\r\n');
  });
});

describe('SMTP sink refusals', () => {
  let sink: SmtpSink;
  beforeAll(async () => {
    sink = await startSmtpSink();
  });
  afterAll(() => sink.close());

  it('refuses the configured sender, recipients and subject without storing anything', async () => {
    const r = sink.refusals;
    const script = [
      'EHLO client',
      `MAIL FROM:<${r.refusedSender}>`,
      'MAIL FROM:<a@x.test>',
      `RCPT TO:<${r.hardBounce}>`,
      `RCPT TO:<${r.deferred}>`,
      'RCPT TO:<ok@x.test>',
      'DATA',
      `Message-ID: <refused@x.test>\r\nSubject: ${r.refusedSubject} hi\r\n\r\nbody\r\n.`,
      'QUIT',
    ];
    const replies = await new Promise<string>((resolve, reject) => {
      const socket = connect(sink.port, sink.host);
      let out = '';
      socket.setEncoding('utf8');
      socket.on('data', (d: string) => (out += d));
      socket.on('end', () => resolve(out));
      socket.on('error', reject);
      socket.write(`${script.join('\r\n')}\r\n`);
    });
    expect(replies).toContain('550 5.7.1 ');
    expect(replies).toContain('550 5.1.1 ');
    expect(replies).toContain('451 4.2.1 ');
    expect(replies).toContain('554 5.6.0 ');
    expect(sink.messages).toEqual([]);
  });
});

describe('stream helpers', () => {
  it('collects and tracks chunks', async () => {
    const { stream, consumed } = trackedStream([utf8('a'), utf8('bc')]);
    expect(new TextDecoder().decode(await collectBytes(stream))).toBe('abc');
    expect(consumed()).toBe(2);
  });

  it('assembles the EICAR sample', () => {
    expect(eicarSample().byteLength).toBe(68);
  });
});
