import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectPortError, mailpitInbox, runMailerContract, startSmtpSink, type SmtpSink } from '@form/testkit';
import { createEgressGuard } from '../egress/guard.ts';
import { createSmtpMailer } from './smtp.ts';

runMailerContract('SMTP → in-process sink', async () => {
  const sink = await startSmtpSink();
  return { impl: createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}` }), inbox: sink, refusals: sink.refusals, dispose: () => sink.close() };
});

/** Against a real Mailpit: FORM_TEST_MAILPIT_SMTP=smtp://localhost:1025 FORM_TEST_MAILPIT_API=http://localhost:8025 */
const mailpitSmtp = process.env.FORM_TEST_MAILPIT_SMTP;
const mailpitApi = process.env.FORM_TEST_MAILPIT_API;
if (mailpitSmtp && mailpitApi) {
  runMailerContract('SMTP → Mailpit', () => ({ impl: createSmtpMailer({ url: mailpitSmtp }), inbox: mailpitInbox(mailpitApi) }));
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe('SMTP mailer', () => {
  let sink: SmtpSink;
  beforeAll(async () => {
    sink = await startSmtpSink();
  });
  afterAll(() => sink.close());

  const message = { from: { address: 'noreply@form.test' }, to: [{ address: 'a@acme.test' }], subject: 's', text: 't' };

  it('generates Message-IDs on the sender domain or a configured one', async () => {
    const own = await createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}` }).send(message);
    expect(own.messageId).toMatch(/^<[0-9a-f-]{36}@form\.test>$/);
    const configured = await createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}`, messageIdDomain: 'mail.form.test' }).send(message);
    expect(configured.messageId).toMatch(/@mail\.form\.test>$/);
  });

  it('keeps generated Message-IDs ASCII', async () => {
    const idn = await createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}` }).send({ ...message, from: { address: 'noreply@डाटामेल.भारत' } });
    expect(idn.messageId).toMatch(/^<[0-9a-f-]{36}@xn--[a-z0-9-]+\.xn--[a-z0-9-]+>$/);
    const configured = await createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}`, messageIdDomain: 'मेल.भारत' }).send(message);
    expect(configured.messageId).toMatch(/@xn--[a-z0-9-]+\.xn--[a-z0-9-]+>$/);
    expect(() => createSmtpMailer({ messageIdDomain: 'bad domain' })).toThrow(/Message-ID domain/);
  });

  it('accepts IDN addresses and refuses headers the mailer owns', async () => {
    const mailer = createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}` });
    await expect(mailer.send({ ...message, to: [{ address: 'user@डाटामेल.भारत' }] })).resolves.toBeDefined();
    await expectPortError(mailer.send({ ...message, headers: { Bcc: 'x@evil.test' } }), 'invalid_argument');
    await expectPortError(mailer.send({ ...message, from: { address: 'noreply@localhost' } }), 'invalid_argument');
  });

  it('never sends credentials to a server that does not offer STARTTLS', async () => {
    const before = sink.messages.length;
    const mailer = createSmtpMailer({ url: `smtp://relay-user:s3cret@${sink.host}:${sink.port}`, timeoutMs: 2000 });
    await expectPortError(mailer.send(message), 'unavailable');
    expect(await mailer.verify()).toEqual({ ok: false, error: expect.any(String) });
    expect(sink.messages.length).toBe(before);
  });

  it('reports an unreachable server', async () => {
    const mailer = createSmtpMailer({ url: `smtp://127.0.0.1:${await closedPort()}`, timeoutMs: 2000 });
    await expectPortError(mailer.send(message), 'unavailable');
    expect(await mailer.verify()).toEqual({ ok: false, error: expect.any(String) });
  });

  describe('per-org senders', () => {
    let orgSink: SmtpSink;
    beforeAll(async () => {
      orgSink = await startSmtpSink();
    });
    afterAll(() => orgSink.close());

    const senders = (egress = createEgressGuard({ policy: 'allowlist', allowlist: ['127.0.0.1'] })) => ({
      resolve: async (ref: string) => (ref === 'secret-acme' ? `smtp://${orgSink.host}:${orgSink.port}` : undefined),
      egress,
    });

    it('delivers through the org relay its secret names, and verifies it', async () => {
      const mailer = createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}`, senders: senders() });
      const { messageId } = await mailer.send({ ...message, senderSecretRef: 'secret-acme' });
      expect(await orgSink.find(messageId)).toBeDefined();
      expect(await sink.find(messageId)).toBeUndefined();
      expect(await mailer.verify('secret-acme')).toEqual({ ok: true });
    });

    it('refuses an unknown sender', async () => {
      const mailer = createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}`, senders: senders() });
      await expectPortError(mailer.send({ ...message, senderSecretRef: 'secret-other' }), 'not_found');
      expect(await mailer.verify('secret-other')).toEqual({ ok: false, error: 'no such SMTP sender' });
      await expectPortError(createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}` }).send({ ...message, senderSecretRef: 'secret-acme' }), 'not_found');
    });

    it('never connects to an org relay the egress guard denies (an internal address on SaaS)', async () => {
      const before = orgSink.messages.length;
      const mailer = createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}`, senders: senders(createEgressGuard({ policy: 'open' })) });
      await expectPortError(mailer.send({ ...message, senderSecretRef: 'secret-acme' }), 'egress_denied');
      expect(orgSink.messages.length).toBe(before);
    });
  });

  it('holds the platform relay to the guard it is given', async () => {
    const trusted = createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}`, egress: createEgressGuard({ policy: 'open', trusted: [sink.host] }) });
    await expect(trusted.send(message)).resolves.toBeDefined();
    const airGapped = createSmtpMailer({ url: 'smtp://smtp.provider.example:587', egress: createEgressGuard({ policy: 'none', resolve: async () => [{ address: '203.0.113.9', family: 4 }] }) });
    await expectPortError(airGapped.send(message), 'egress_denied');
    expect(() => createSmtpMailer({ url: 'http://smtp.example' })).toThrow(/smtp:\/\//);
  });
});
