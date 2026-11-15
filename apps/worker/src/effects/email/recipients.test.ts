import type { Tx } from '@form/db';
import type { NotificationConfig } from '@form/schema';
import { describe, expect, it } from 'vitest';
import { answered, compiledOf, definitionOf, maskedField, MARKETING, omittedField, personal, RESPOND } from '../../../test/email-fixtures.ts';
import { disclosableFields } from '../disclosure.ts';
import { deliveredTo, isMailable, maskAddress, resolveRecipients } from './recipients.ts';

/*
 * WP-1.16 NOT-02/03/04: who a notification goes to. The cases that need no database (a literal address, the respondent's
 * answer to an email field) run here with a transaction that fails the test if it is touched; a member, a role and the
 * org boundary are in `test/notifications.int.test.ts` against a real database with RLS.
 */

/** A transaction that proves the recipient kinds under test never read the database. */
const noDatabase = new Proxy({}, { get: () => () => { throw new Error('this recipient kind must not read the database'); } }) as unknown as Tx;

const lists = (o: { to?: unknown[]; cc?: unknown[]; bcc?: unknown[]; replyTo?: unknown }): Pick<NotificationConfig, 'to' | 'cc' | 'bcc' | 'replyTo'> =>
  ({ to: o.to ?? [], ...(o.cc ? { cc: o.cc } : {}), ...(o.bcc ? { bcc: o.bcc } : {}), ...(o.replyTo ? { replyTo: o.replyTo } : {}) }) as never;

const email = (address: string) => ({ kind: 'email', address });
const fieldOf = (blockId: string) => ({ kind: 'field', blockId });

/** An email field the notification may see, a masked one, an omitted one and one of another purpose, with an answer each. */
function fieldsFor(purposeIds: string[] = [RESPOND], answers: Record<string, [string, unknown]> = {}) {
  const blocks = [
    personal('mail', {}, { type: 'email' }),
    personal('mail2', {}, { type: 'email' }),
    maskedField('sealed_mail'),
    omittedField('hidden_mail'),
    personal('promo_mail', { purposeIds: [MARKETING] }, { type: 'email' }),
    personal('free_text'),
  ];
  const definition = definitionOf(blocks);
  const all: Record<string, [string, unknown]> = {
    mail: ['email', { address: 'asha@example.com' }],
    mail2: ['email', { address: 'ravi@example.com' }],
    sealed_mail: ['short_text', 'sealed@example.com'],
    hidden_mail: ['short_text', 'hidden@example.com'],
    promo_mail: ['email', { address: 'promo@example.com' }],
    free_text: ['short_text', 'typed@example.com'],
    ...answers,
  };
  return disclosableFields({ definition, compiled: compiledOf(definition), answers: answered(all), purposeIds, channel: 'notification' });
}

const ctx = (fields = fieldsFor()) => ({ orgId: 'org', formId: 'form', fields });

describe('isMailable and maskAddress', () => {
  it('accepts an ordinary and an internationalised address', () => {
    for (const a of ['asha@example.com', 'first.last+tag@sub.example.co.in', 'user@डाटामेल.भारत']) expect(isMailable(a)).toBe(true);
  });

  it('refuses what could break a header or is not an address', () => {
    for (const a of ['', 'plain', '@example.com', 'a@', 'a@b', 'a@@b.com', 'a b@example.com', 'a@exa mple.com', 'a@example.com\r\nBcc: x@y.test', 'a\n@example.com', '<a@example.com>', 'a@example..com', 'a@.example.com', `${'x'.repeat(250)}@e.co`, 'a,b@example.com', 'a@example.com;b@example.com']) {
      expect(isMailable(a), JSON.stringify(a)).toBe(false);
    }
  });

  it('shows the first character, three stars and the domain', () => {
    expect(maskAddress('asha@example.com')).toBe('a***@example.com');
    expect(maskAddress('x@e.co')).toBe('x***@e.co');
    expect(maskAddress('😀smile@example.com')).toBe('😀***@example.com');
    expect(maskAddress('not-an-address')).toBe('***');
  });
});

describe('resolveRecipients: literal addresses and the respondent’s email field', () => {
  it('returns a literal address as written in to, cc and bcc', async () => {
    const r = await resolveRecipients(noDatabase, lists({ to: [email('owner@acme.example')], cc: [email('cc@acme.example')], bcc: [email('bcc@acme.example')] }), ctx());
    expect(r).toEqual({ to: [{ address: 'owner@acme.example' }], cc: [{ address: 'cc@acme.example' }], bcc: [{ address: 'bcc@acme.example' }], skipped: 0 });
    expect(deliveredTo(r).map((a) => a.address)).toEqual(['owner@acme.example', 'cc@acme.example', 'bcc@acme.example']);
  });

  it('reads the respondent’s address from an email field that is in the notification’s purposes', async () => {
    const r = await resolveRecipients(noDatabase, lists({ to: [fieldOf('mail')], replyTo: fieldOf('mail2') }), ctx());
    expect(r.to).toEqual([{ address: 'asha@example.com' }]);
    expect(r.replyTo).toEqual({ address: 'ravi@example.com' });
  });

  it('gives nobody for a field that is out of purpose, omitted, masked, not an email field, not answered, or not there', async () => {
    const asked = [fieldOf('promo_mail'), fieldOf('hidden_mail'), fieldOf('sealed_mail'), fieldOf('free_text'), fieldOf('nope')];
    const r = await resolveRecipients(noDatabase, lists({ to: [...asked, email('keep@acme.example')] }), ctx());
    expect(r.to).toEqual([{ address: 'keep@acme.example' }]);
    expect(r.skipped).toBe(5);
    // A recipient of the marketing purpose may use the marketing address and not the respondent's own.
    const marketing = await resolveRecipients(noDatabase, lists({ to: [fieldOf('promo_mail'), fieldOf('mail')] }), ctx(fieldsFor([MARKETING])));
    expect(marketing.to).toEqual([{ address: 'promo@example.com' }]);
    // Not answered: the field is allowed but holds nothing.
    const blank = await resolveRecipients(noDatabase, lists({ to: [fieldOf('mail')] }), ctx(fieldsFor([RESPOND], { mail: ['email', { address: '' }] })));
    expect(blank.to).toEqual([]);
  });

  it('skips an address that cannot be mailed, whatever put it there', async () => {
    const r = await resolveRecipients(noDatabase, lists({ to: [email('no-at-sign'), fieldOf('mail')], replyTo: email('also bad') }), ctx(fieldsFor([RESPOND], { mail: ['email', { address: 'x@example.com\r\nBcc: y@example.com' }] })));
    expect(r.to).toEqual([]);
    expect(r.replyTo).toBeUndefined();
    expect(r.skipped).toBe(3);
  });

  it('keeps an address once, in the highest list, and compares without regard to case', async () => {
    const r = await resolveRecipients(
      noDatabase,
      lists({ to: [email('A@Example.com')], cc: [email('a@example.com'), email('b@example.com')], bcc: [email('B@example.com'), fieldOf('mail')], replyTo: email('a@example.com') }),
      ctx(fieldsFor([RESPOND], { mail: ['email', { address: 'a@EXAMPLE.com' }] })),
    );
    expect(r.to.map((a) => a.address)).toEqual(['A@Example.com']);
    expect(r.cc.map((a) => a.address)).toEqual(['b@example.com']);
    expect(r.bcc).toEqual([]);
    // Reply-To is a header, not a delivery, so it may repeat a recipient.
    expect(r.replyTo).toEqual({ address: 'a@example.com' });
  });

  it('does not read the database for a config that names no member or role', async () => {
    await expect(resolveRecipients(noDatabase, lists({ to: [email('a@acme.example')] }), ctx())).resolves.toBeDefined();
  });
});
