import { createHmac } from 'node:crypto';
import { STACK_PORTS } from './stack-ports.ts';
import { expect, type Page } from './test.ts';

/** Mailpit's HTTP API in the e2e stack. */
const MAILPIT_API = `http://127.0.0.1:${STACK_PORTS.mailpit}`;

interface MailpitSummary {
  ID: string;
  Subject: string;
}

/** The link to `path` in the newest message to `to`, waiting for the send that follows the API's answer. */
export async function mailLink(to: string, path: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const pattern = new RegExp(`https?://[^\\s]+${path.replace(/\//g, '\\/')}#token=[A-Za-z0-9_-]{43}`);
  for (;;) {
    const search = await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = (await search.json()) as { messages: MailpitSummary[] };
    for (const m of messages) {
      const message = (await (await fetch(`${MAILPIT_API}/api/v1/message/${m.ID}`)).json()) as { Text: string };
      const link = pattern.exec(message.Text)?.[0];
      if (link) return link;
    }
    if (Date.now() > deadline) throw new Error(`no ${path} link mailed to ${to}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function base32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/\s/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The RFC 6238 code an authenticator app shows for `secret`, `offset` steps from now. */
export function totp(secret: string, offset = 0): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = mac[mac.length - 1]! & 15;
  const n = ((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

export const PASSWORD = 'violet-anchor-teapot-91';
export const newEmail = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

/** Sign-up through the builder, then the emailed verification link: the browser ends signed in on the forms list. */
export async function signUpAndVerify(page: Page, email: string): Promise<void> {
  await page.goto('/auth/sign-up');
  await page.getByLabel('Your name').fill('Asha');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText(`We sent a link to ${email}`);
  await page.goto(await mailLink(email, '/auth/verify'));
  // The link names its account and is used only on the click (no silent sign-in from a link someone else sent).
  await page.getByRole('button', { name: `Continue as ${email}` }).click();
  await page.waitForURL('**/forms');
  await expect(page.getByRole('navigation', { name: 'Account' })).toContainText(email);
}
