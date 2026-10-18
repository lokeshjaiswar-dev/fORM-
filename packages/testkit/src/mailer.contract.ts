import { describe, expect, it, type TestContext } from 'vitest';
import type { MailMessage, Mailer } from '@form/ports';
import { expectPortError, uniquePrefix, useSubject, utf8, type ContractSetup, type ContractSubject } from './contract.ts';
import type { Inbox, SmtpRefusals } from './smtp-sink.ts';

export interface MailerContractSubject extends ContractSubject<Mailer> {
  inbox: Inbox;
  /** What the server under test refuses; without it the refusal cases are skipped (a stock Mailpit accepts everything). */
  refusals?: SmtpRefusals;
}

const headerBlock = (raw: string) => raw.slice(0, raw.indexOf('\r\n\r\n'));

export function runMailerContract(label: string, setup: ContractSetup<MailerContractSubject>): void {
  describe(`Mailer contract: ${label}`, () => {
    const subject = useSubject(setup);
    const mailer = () => subject().impl;
    const run = uniquePrefix();
    const message = (o: Partial<MailMessage> = {}): MailMessage => ({
      from: { address: 'noreply@form.test', name: 'fORM- Notifications' },
      to: [{ address: 'owner@acme.test', name: 'Form Owner' }],
      subject: `New response ${run}`,
      text: `token ${run}\nA new response arrived.`,
      ...o,
    });

    it('verifies the connection', async () => {
      expect(await mailer().verify()).toEqual({ ok: true });
    });

    it('delivers a message with an encoded subject, to every recipient', async () => {
      const { messageId, refused } = await mailer().send(
        message({
          subject: `नया उत्तर ${run}`,
          cc: [{ address: 'cc@acme.test' }],
          bcc: [{ address: 'audit@acme.test' }],
          html: `<p>token ${run}</p>`,
          replyTo: { address: 'privacy@acme.test' },
        }),
      );
      expect(messageId).toMatch(/^<[^<>\s]+@[^<>\s]+>$/);
      expect(refused).toEqual([]);
      const got = await subject().inbox.find(messageId);
      expect(got).toBeDefined();
      expect(got?.subject).toBe(`नया उत्तर ${run}`);
      expect([...(got?.recipients ?? [])].sort()).toEqual(['audit@acme.test', 'cc@acme.test', 'owner@acme.test']);
      expect(got?.raw).toContain(`token ${run}`);
      if (subject().inbox.verbatim) expect(headerBlock(got?.raw ?? '')).not.toContain('audit@acme.test');
    });

    it('keeps a caller-chosen Message-ID across resends', async () => {
      const id = `<${run}.resend@form.test>`;
      const first = await mailer().send(message({ messageId: id }));
      const second = await mailer().send(message({ messageId: id }));
      expect(first.messageId).toBe(id);
      expect(second.messageId).toBe(id);
      expect(await subject().inbox.find(id)).toBeDefined();
    });

    it('sends custom headers and attachments', async () => {
      const { messageId } = await mailer().send(
        message({
          headers: { 'List-Unsubscribe': '<https://form.test/u/abc>' },
          attachments: [{ filename: 'response.csv', contentType: 'text/csv', content: utf8('a,b\n1,2\n') }],
        }),
      );
      const raw = (await subject().inbox.find(messageId))?.raw ?? '';
      expect(headerBlock(raw)).toContain('List-Unsubscribe: <https://form.test/u/abc>');
      expect(raw).toContain('response.csv');
    });

    it('rejects a message without recipients', async () => {
      await expectPortError(mailer().send(message({ to: [] })), 'invalid_argument');
    });

    it.each<[string, Partial<MailMessage>]>([
      ['a CR/LF in the subject', { subject: 'Hi\r\nBcc: victim@evil.test' }],
      ['a CR/LF in a display name', { to: [{ address: 'owner@acme.test', name: 'x\r\nBcc: victim@evil.test' }] }],
      ['a CR/LF in a header value', { headers: { 'X-Tag': 'a\r\nBcc: victim@evil.test' } }],
      ['an invalid header name', { headers: { 'X Tag:': 'a' } }],
      ['a malformed address', { to: [{ address: 'not-an-address' }] }],
      ['an address with CR/LF', { to: [{ address: 'owner@acme.test\r\nBcc: victim@evil.test' }] }],
      ['a malformed Message-ID', { messageId: 'no-brackets@form.test' }],
      ['a non-ASCII Message-ID', { messageId: '<उत्तर@form.test>' }],
      ['a quoted Message-ID', { messageId: '<"a b"@form.test>' }],
    ])('rejects %s', async (_name, o) => {
      await expectPortError(mailer().send(message(o)), 'invalid_argument');
    });

    describe('refusals', () => {
      const refusals = (ctx: TestContext): SmtpRefusals => subject().refusals ?? ctx.skip('the server under test refuses nothing');

      it('delivers to the accepted recipients and reports a hard bounce as permanent', async (ctx) => {
        const r = refusals(ctx);
        const sent = await mailer().send(message({ to: [{ address: 'owner@acme.test' }, { address: r.hardBounce }] }));
        expect(sent.refused).toEqual([{ address: r.hardBounce, permanent: true, response: expect.stringMatching(/^5\d\d /) }]);
        expect((await subject().inbox.find(sent.messageId))?.recipients).toEqual(['owner@acme.test']);
      });

      it('reports a deferred recipient as not permanent', async (ctx) => {
        const r = refusals(ctx);
        const sent = await mailer().send(message({ to: [{ address: 'owner@acme.test' }], cc: [{ address: r.deferred }] }));
        expect(sent.refused).toEqual([{ address: r.deferred, permanent: false, response: expect.stringMatching(/^4\d\d /) }]);
      });

      it("throws 'rejected' when every recipient bounces for good", async (ctx) => {
        await expectPortError(mailer().send(message({ to: [{ address: refusals(ctx).hardBounce }] })), 'rejected');
      });

      it("throws 'unavailable' when no recipient is accepted but one is only deferred", async (ctx) => {
        const r = refusals(ctx);
        await expectPortError(mailer().send(message({ to: [{ address: r.hardBounce }, { address: r.deferred }] })), 'unavailable');
      });

      it("throws 'rejected' when the server refuses the message itself", async (ctx) => {
        const sent = mailer().send(message({ subject: `${refusals(ctx).refusedSubject} ${run}` }));
        await expectPortError(sent, 'rejected');
      });

      it("throws 'unavailable', never 'rejected', when the server refuses the sender", async (ctx) => {
        await expectPortError(mailer().send(message({ from: { address: refusals(ctx).refusedSender } })), 'unavailable');
      });
    });
  });
}
