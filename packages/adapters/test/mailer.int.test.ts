import { afterAll, beforeAll, describe } from 'vitest';
import { mailpitInbox, runMailerContract, startMailpit, type MailpitServer } from '@form/testkit';
import { createEgressGuard } from '../src/egress/index.ts';
import { createSmtpMailer } from '../src/mailer/index.ts';

/** The SMTP mailer against a real Mailpit (Testcontainers), held to an air-gapped guard with Mailpit as the internal relay. */
describe('Mailpit', () => {
  let mailpit: MailpitServer;
  beforeAll(async () => {
    mailpit = await startMailpit();
  });
  afterAll(() => mailpit?.stop());

  runMailerContract('SMTP → Mailpit container', () => {
    const host = new URL(mailpit.smtpUrl).hostname;
    return {
      impl: createSmtpMailer({ url: mailpit.smtpUrl, egress: createEgressGuard({ policy: 'none', trusted: [host] }) }),
      inbox: mailpitInbox(mailpit.apiUrl),
    };
  });
});
