import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectPortError, mailpitInbox, runMailerContract, startSmtpSink, type SmtpSink } from '@form/testkit';
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

  it('reports an unreachable server', async () => {
    const mailer = createSmtpMailer({ url: `smtp://127.0.0.1:${await closedPort()}`, timeoutMs: 2000 });
    await expectPortError(mailer.send(message), 'unavailable');
    expect(await mailer.verify()).toEqual({ ok: false, error: expect.any(String) });
  });

  it('does not pretend to verify per-org senders', async () => {
    expect(await createSmtpMailer({ url: `smtp://${sink.host}:${sink.port}` }).verify('org-smtp-secret')).toEqual({
      ok: false,
      error: 'per-org senders are not supported by the dev SMTP mailer',
    });
  });
});
