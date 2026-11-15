import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DELIVERY_ID_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signWebhook } from './sign.ts';
import { verifyWebhook } from './verify-recipe.ts';

/*
 * WP-1.18: the signature a receiver checks. `verify-recipe.ts` is the file `docs/platform/webhook-signatures.md` quotes
 * verbatim; these tests sign with the code the worker runs and verify with the recipe a customer copies, so the two cannot
 * drift apart, and run the Python recipe of the page against the same signatures.
 */

const SECRET = 'whsec_k3Jx9-demo_secret/with+symbols==';
const BODY = '{"id":"e1","event":"submission.created","submission":{"answers":{"name":"Asha Ünal \\u2603"}}}';
const T = 1_731_744_000;

const fileText = (url: string): string => readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8');

describe('signWebhook and the published recipe', () => {
  it('makes `t=<seconds>,v1=<64 hex>` and the recipe verifies it', () => {
    const header = signWebhook(SECRET, BODY, T);
    expect(header).toMatch(new RegExp(`^t=${T},v1=[0-9a-f]{64}$`));
    expect(verifyWebhook(BODY, header, SECRET, T)).toBe(true);
    // The raw bytes verify as well as the text they decode to.
    expect(verifyWebhook(new TextEncoder().encode(BODY), header, SECRET, T)).toBe(true);
  });

  it('fails for a changed body, a changed timestamp and a changed secret', () => {
    const header = signWebhook(SECRET, BODY, T);
    expect(verifyWebhook(`${BODY} `, header, SECRET, T)).toBe(false);
    expect(verifyWebhook(BODY.replace('Asha', 'Asha2'), header, SECRET, T)).toBe(false);
    // Moving `t` (even to a time that is still inside the tolerance) changes the signed text, so the old signature no longer fits.
    expect(verifyWebhook(BODY, header.replace(`t=${T}`, `t=${T + 1}`), SECRET, T + 1)).toBe(false);
    expect(verifyWebhook(BODY, header, `${SECRET}x`, T)).toBe(false);
    expect(verifyWebhook(BODY, header, SECRET.toUpperCase(), T)).toBe(false);
  });

  it('signs the timestamp and the body with a dot between them, and nothing else', async () => {
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', SECRET).update(`${T}.${BODY}`).digest('hex');
    expect(signWebhook(SECRET, BODY, T)).toBe(`t=${T},v1=${expected}`);
    // Bytes of the secret are the key: the opened secret (Uint8Array) and its text sign the same.
    expect(signWebhook(new TextEncoder().encode(SECRET), BODY, T)).toBe(signWebhook(SECRET, BODY, T));
  });

  it('refuses a request more than five minutes from the receiver’s clock, in either direction, and accepts one at the edge', () => {
    const header = signWebhook(SECRET, BODY, T);
    expect(verifyWebhook(BODY, header, SECRET, T + 300)).toBe(true);
    expect(verifyWebhook(BODY, header, SECRET, T + 301)).toBe(false);
    expect(verifyWebhook(BODY, header, SECRET, T - 300)).toBe(true);
    expect(verifyWebhook(BODY, header, SECRET, T - 301)).toBe(false);
  });

  it('refuses a missing, malformed or incomplete header, and a signature that is not 64 hex digits', () => {
    const good = signWebhook(SECRET, BODY, T);
    const v1 = good.split('v1=')[1]!;
    for (const header of [undefined, '', 'garbage', `t=${T}`, `v1=${v1}`, `t=abc,v1=${v1}`, `t=,v1=${v1}`, `t=${T},v1=`, `t=${T},v1=${v1.slice(0, 62)}`, `t=${T},v1=${v1}00`, `t=${T},v1=${'z'.repeat(64)}`, `t=-${T},v1=${v1}`]) {
      expect(verifyWebhook(BODY, header, SECRET, T), String(header)).toBe(false);
    }
  });

  it('accepts a header with several v1 entries when any of them fits (a secret change), in either order', () => {
    const good = signWebhook(SECRET, BODY, T).split('v1=')[1]!;
    const other = signWebhook('another-secret', BODY, T).split('v1=')[1]!;
    expect(verifyWebhook(BODY, `t=${T},v1=${other},v1=${good}`, SECRET, T)).toBe(true);
    expect(verifyWebhook(BODY, `t=${T},v1=${good},v1=${other}`, SECRET, T)).toBe(true);
    expect(verifyWebhook(BODY, `t=${T},v1=${other}`, SECRET, T)).toBe(false);
  });

  it('refuses to sign a time that is not whole seconds', () => {
    expect(() => signWebhook(SECRET, BODY, 1.5)).toThrow(RangeError);
    expect(() => signWebhook(SECRET, BODY, -1)).toThrow(RangeError);
  });

  it('names the three headers a delivery carries', () => {
    expect([SIGNATURE_HEADER, DELIVERY_ID_HEADER, EVENT_HEADER]).toEqual(['fORM-Signature', 'fORM-Delivery-Id', 'fORM-Event']);
  });
});

describe('docs/platform/webhook-signatures.md', () => {
  const doc = fileText('../../../../../docs/platform/webhook-signatures.md');

  it('quotes verify-recipe.ts verbatim, the whole file', () => {
    const recipe = fileText('./verify-recipe.ts').trimEnd();
    expect(doc).toContain(['```ts', recipe, '```'].join('\n'));
  });

  it('says what a receiver must do: the raw body, five minutes, a constant-time compare', () => {
    expect(doc).toMatch(/raw body/i);
    expect(doc).toMatch(/5 minutes/);
    expect(doc).toMatch(/constant time/i);
    expect(doc).toContain('timingSafeEqual');
    expect(doc).toContain('hmac.compare_digest');
  });

  const python = /```python\n([\s\S]*?)```/.exec(doc)?.[1];
  const hasPython = spawnSync('python3', ['--version']).status === 0;

  it('has a Python recipe', () => {
    expect(python).toBeDefined();
  });

  // The Python recipe is run, not just read: it must accept what `signWebhook` signs and refuse what the Node recipe refuses.
  it.skipIf(!hasPython)('has a Python recipe that verifies what signWebhook signs and refuses the same things the Node recipe refuses', () => {
    const cases = [
      { name: 'good', body: BODY, header: signWebhook(SECRET, BODY, T), secret: SECRET, now: T, expected: true },
      { name: 'changed body', body: `${BODY} `, header: signWebhook(SECRET, BODY, T), secret: SECRET, now: T, expected: false },
      { name: 'changed secret', body: BODY, header: signWebhook(SECRET, BODY, T), secret: `${SECRET}x`, now: T, expected: false },
      { name: 'changed time', body: BODY, header: signWebhook(SECRET, BODY, T).replace(`t=${T}`, `t=${T + 1}`), secret: SECRET, now: T + 1, expected: false },
      { name: 'too old', body: BODY, header: signWebhook(SECRET, BODY, T), secret: SECRET, now: T + 301, expected: false },
      { name: 'edge', body: BODY, header: signWebhook(SECRET, BODY, T), secret: SECRET, now: T + 300, expected: true },
      { name: 'not hex', body: BODY, header: `t=${T},v1=${'é'.repeat(64)}`, secret: SECRET, now: T, expected: false },
      { name: 'missing', body: BODY, header: '', secret: SECRET, now: T, expected: false },
    ];
    const driver = [
      python!,
      'import json, sys',
      'cases = json.load(sys.stdin)',
      'print(json.dumps([verify_webhook(c["body"].encode("utf-8"), c["header"], c["secret"], c["now"]) for c in cases]))',
    ].join('\n');
    const run = spawnSync('python3', ['-I', '-c', driver], { input: JSON.stringify(cases), encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toEqual(cases.map((c) => c.expected));
    // And the Node recipe agrees case by case.
    expect(cases.map((c) => verifyWebhook(c.body, c.header, c.secret, c.now))).toEqual(cases.map((c) => c.expected));
  });
});
