import { expect } from 'vitest';
import type { Fixture, IsolationCase, IsolationDomain, Res, SeedEnv } from './types.ts';

/**
 * Cases for the notification routes (WP-1.16): org email senders and the notifications and email log of a form. Each is
 * an `auth: 'user'` route, so each needs a case here or the suite fails.
 *
 * Org A's sender is made by the seed through the API, as org A's owner, so the cases aim a real id at org B's member. Its
 * name, address and SMTP URL (with its password) are in `f.extra`, so the suite also scans every answer for them. Every
 * body is valid for its route, so a refusal can only be the sender not being visible to org B.
 */

const bodyOf = (res: Res) => res.json<Record<string, unknown>>();

/** Distinctive values: the suite fails any answer to org B that carries one of them. */
export const SENDER_NAME = 'Org A mailbox 4d2b';
export const SENDER_ADDRESS = 'billing-4d2b@iso-a-sender.test';
export const SENDER_SMTP_URL = 'smtps://iso-a-user-4d2b:iso-a-pass-93c1@smtp.iso-a-sender.test:465';

async function seed(env: SeedEnv, f: Fixture): Promise<Record<string, string>> {
  const sender = await env.as(f.a.ownerId, f.a.orgId, 'POST', '/v1/email-senders', { name: SENDER_NAME, fromAddress: SENDER_ADDRESS, smtpUrl: SENDER_SMTP_URL });
  if (sender.statusCode !== 201) throw new Error(`seed: expected 201 for an email sender, got ${sender.statusCode} ${sender.body}`);
  const { id: senderId } = sender.json<{ id: string }>();
  return {
    senderId,
    senderName: SENDER_NAME,
    senderAddress: SENDER_ADDRESS,
    senderSmtpUrl: SENDER_SMTP_URL,
    senderSmtpPassword: 'iso-a-pass-93c1',
  };
}

const cases: IsolationCase[] = [
  {
    route: 'GET /v1/email-senders',
    call: () => ({ url: '/v1/email-senders' }),
    own: {
      status: 200,
      check: (res, f) => {
        const items = bodyOf(res).items as Array<{ id: string }>;
        expect(items.map((s) => s.id)).not.toContain(f.extra.senderId);
        expect(items).toEqual([]);
      },
    },
    note: 'The route takes no id of org A’s, so org B’s member gets their own org’s list, which is empty: org A’s sender, its address and its SMTP URL are not in it (the suite also scans the answer for them).',
  },
  {
    route: 'POST /v1/email-senders',
    call: () => ({ url: '/v1/email-senders', body: { name: 'Org B mailbox', fromAddress: 'hello@iso-b-sender.test', smtpUrl: 'smtps://iso-b-user:iso-b-pass@smtp.iso-b-sender.test:465' } }),
    own: { status: 201, check: (res) => expect(bodyOf(res)).toMatchObject({ name: 'Org B mailbox', verifiedAt: null }) },
    note: 'The route takes no org: the sender and its sealed secret are org B’s, whatever the body says. The baseline check proves org A still has exactly the one sender and one secret the seed made.',
  },
  {
    route: 'PATCH /v1/email-senders/:id',
    call: (f) => ({ url: `/v1/email-senders/${f.extra.senderId}`, body: { name: 'Org B was here', smtpUrl: 'smtps://attacker:attacker@smtp.attacker.test:465' } }),
    note: 'Would rename org A’s sender and point it at org B’s relay (a new secret in org A, the old one deleted); the baseline check proves both are untouched.',
  },
  {
    route: 'DELETE /v1/email-senders/:id',
    call: (f) => ({ url: `/v1/email-senders/${f.extra.senderId}` }),
    note: 'Would delete org A’s sender and its sealed secret; the baseline check proves both are still there.',
  },
  {
    route: 'POST /v1/email-senders/:id/test',
    call: (f) => ({ url: `/v1/email-senders/${f.extra.senderId}/test` }),
    note: 'Would connect to org A’s relay with org A’s credentials and send to org B’s member: the sender is looked up (under RLS) before any mailer is asked for.',
  },
];

export const NOTIFICATIONS_ISOLATION: IsolationDomain = { cases, seed };
