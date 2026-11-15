import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { PortError, type KeyProvider } from '@form/ports';
import { expectPortError, utf8 } from '@form/testkit';
import { createKeyfileKeyProvider } from './keyfile.ts';
import { MAX_ORG_SECRET_BYTES, openOrgSecret, openOrgSecretText, sealOrgSecret, sealedOrgSecretSchema, type OrgSecretContext, type SealedOrgSecret } from './org-secret.ts';

const ORG_A = '01970000-0000-7000-8000-00000000000a';
const ORG_B = '01970000-0000-7000-8000-00000000000b';
const SECRET_ID = '01970000-0000-7000-8000-0000000000c1';
const ctx: OrgSecretContext = { orgId: ORG_A, secretId: SECRET_ID, kind: 'smtp' };
const PLAINTEXT = 'smtps://mailer:hunter2-correct-horse@smtp.example.test:465';

const keyfile = () => createKeyfileKeyProvider({ masterKey: randomBytes(32) });

/** The same bytes with one bit flipped: editing the base64 text could change an unused trailing bit and nothing else. */
const flipped = (b64: string) => {
  const bytes = Buffer.from(b64, 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return bytes.toString('base64url');
};

/** A provider that ignores the context, so a failure below can only come from the cipher text's own binding. */
function contextBlindKeys(): KeyProvider {
  const real = keyfile();
  return {
    ...real,
    wrap: (key) => real.wrap(key, { orgId: 'any' }),
    unwrap: (wrapped, ref) => real.unwrap(wrapped, ref, { orgId: 'any' }),
  };
}

describe('org secrets', () => {
  it('seals and opens a secret under the org key context', async () => {
    const keys = keyfile();
    const sealed = await sealOrgSecret(keys, ctx, PLAINTEXT);
    expect(sealedOrgSecretSchema.safeParse(sealed).success).toBe(true);
    expect(sealed).toMatchObject({ v: 1, alg: 'A256GCM', kekRef: expect.stringMatching(/^keyfile:/) });
    expect(await openOrgSecretText(keys, ctx, sealed)).toBe(PLAINTEXT);
    expect(new TextDecoder().decode(await openOrgSecret(keys, ctx, sealed))).toBe(PLAINTEXT);
    // What is stored is a plain jsonb value, and it round-trips through JSON as a database column would.
    expect(await openOrgSecretText(keys, ctx, JSON.parse(JSON.stringify(sealed)))).toBe(PLAINTEXT);
  });

  it('seals bytes as well as text (an HMAC key)', async () => {
    const keys = keyfile();
    const key = randomBytes(32);
    const sealed = await sealOrgSecret(keys, { ...ctx, kind: 'webhook_hmac' }, key);
    expect(Buffer.from(await openOrgSecret(keys, { ...ctx, kind: 'webhook_hmac' }, sealed))).toEqual(key);
  });

  it('keeps the plaintext, and the data key, out of the stored value', async () => {
    const keys = keyfile();
    const sealed = await sealOrgSecret(keys, ctx, PLAINTEXT);
    const text = JSON.stringify(sealed);
    expect(text).not.toContain(PLAINTEXT);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(Buffer.from(PLAINTEXT).toString('base64url'));
  });

  it('wraps the data key under the org key context, not the platform one', async () => {
    const seen: string[] = [];
    const real = keyfile();
    const spy: KeyProvider = {
      ...real,
      wrap: (key, c) => (seen.push(`wrap:${c.orgId}`), real.wrap(key, c)),
      unwrap: (wrapped, ref, c) => (seen.push(`unwrap:${c.orgId}`), real.unwrap(wrapped, ref, c)),
    };
    const sealed = await sealOrgSecret(spy, ctx, PLAINTEXT);
    await openOrgSecret(spy, ctx, sealed);
    expect(seen).toEqual([`wrap:${ORG_A}`, `unwrap:${ORG_A}`]);
  });

  it('gives two seals of the same value a different data key, iv and cipher text', async () => {
    const keys = keyfile();
    const a = await sealOrgSecret(keys, ctx, PLAINTEXT);
    const b = await sealOrgSecret(keys, ctx, PLAINTEXT);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(a.dek).not.toBe(b.dek);
    expect(a.tag).not.toBe(b.tag);
    expect(await openOrgSecretText(keys, ctx, a)).toBe(await openOrgSecretText(keys, ctx, b));
  });

  describe('is bound to its org, its row and its kind', () => {
    it('refuses another org: the KMS will not unwrap the data key for it', async () => {
      const keys = keyfile();
      const sealed = await sealOrgSecret(keys, ctx, PLAINTEXT);
      await expectPortError(openOrgSecret(keys, { ...ctx, orgId: ORG_B }, sealed), 'integrity');
    });

    it('refuses another org even when the KMS does not check the context: the cipher text is bound to it too', async () => {
      const keys = contextBlindKeys();
      const sealed = await sealOrgSecret(keys, ctx, PLAINTEXT);
      expect(await openOrgSecretText(keys, ctx, sealed)).toBe(PLAINTEXT);
      await expectPortError(openOrgSecret(keys, { ...ctx, orgId: ORG_B }, sealed), 'integrity');
    });

    it('refuses another secret id of the same org (a value copied into another row)', async () => {
      const keys = keyfile();
      const sealed = await sealOrgSecret(keys, ctx, PLAINTEXT);
      await expectPortError(openOrgSecret(keys, { ...ctx, secretId: '01970000-0000-7000-8000-0000000000c2' }, sealed), 'integrity');
    });

    it('refuses another kind (an SMTP URL pasted into a webhook secret)', async () => {
      const keys = keyfile();
      const sealed = await sealOrgSecret(keys, ctx, PLAINTEXT);
      await expectPortError(openOrgSecret(keys, { ...ctx, kind: 'webhook_hmac' }, sealed), 'integrity');
    });

    it('cannot make two contexts share one AAD with a colon in a part', async () => {
      const keys = keyfile();
      await expectPortError(sealOrgSecret(keys, { orgId: 'a:b', secretId: 'c', kind: 'smtp' }, PLAINTEXT), 'invalid_argument');
      await expectPortError(sealOrgSecret(keys, { orgId: 'a', secretId: 'b:c', kind: 'smtp' }, PLAINTEXT), 'invalid_argument');
      await expectPortError(sealOrgSecret(keys, { orgId: 'a', secretId: 'c', kind: 'smtp:x' }, PLAINTEXT), 'invalid_argument');
      await expectPortError(sealOrgSecret(keys, { orgId: '', secretId: 'c', kind: 'smtp' }, PLAINTEXT), 'invalid_argument');
      const sealed = await sealOrgSecret(keys, ctx, PLAINTEXT);
      await expectPortError(openOrgSecret(keys, { orgId: ORG_A, secretId: '', kind: 'smtp' }, sealed), 'invalid_argument');
    });

    it('does not put the refused part into the error', async () => {
      const keys = keyfile();
      const bad = 'secret-looking:value';
      const e = await sealOrgSecret(keys, { ...ctx, secretId: bad }, PLAINTEXT).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(PortError);
      expect((e as PortError).message).not.toContain(bad);
      expect((e as PortError).message).not.toContain('hunter2');
    });
  });

  describe('refuses a changed value', () => {
    it.each(['ct', 'tag', 'iv', 'dek'] as const)('a changed %s', async (field) => {
      const keys = keyfile();
      const sealed = await sealOrgSecret(keys, ctx, PLAINTEXT);
      const error = await openOrgSecret(keys, ctx, { ...sealed, [field]: flipped(sealed[field]) }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe('integrity');
      expect(String(error)).not.toContain('hunter2');
    });

    it('a cipher text and a tag from two different seals', async () => {
      const keys = keyfile();
      const a = await sealOrgSecret(keys, ctx, PLAINTEXT);
      const b = await sealOrgSecret(keys, ctx, PLAINTEXT);
      await expectPortError(openOrgSecret(keys, ctx, { ...a, tag: b.tag }), 'integrity');
      await expectPortError(openOrgSecret(keys, ctx, { ...a, ct: b.ct }), 'integrity');
    });

    it('a value sealed by another master key', async () => {
      const sealed = await sealOrgSecret(keyfile(), ctx, PLAINTEXT);
      await expectPortError(openOrgSecret(keyfile(), ctx, sealed), 'not_found', 'integrity');
    });
  });

  describe('refuses a malformed stored value with a zod error that never carries the plaintext', () => {
    const shapes: Array<[string, (s: SealedOrgSecret) => unknown]> = [
      ['null', () => null],
      ['the plaintext itself, as a legacy column might hold it', () => PLAINTEXT],
      ['an object holding the plaintext as a field', () => ({ smtpUrl: PLAINTEXT })],
      ['a wrong version', (s) => ({ ...s, v: 2 })],
      ['a wrong algorithm', (s) => ({ ...s, alg: 'A128CBC' })],
      ['a missing tag', ({ tag: _tag, ...rest }) => rest],
      ['a truncated iv', (s) => ({ ...s, iv: s.iv.slice(0, 10) })],
      ['a truncated tag', (s) => ({ ...s, tag: s.tag.slice(0, 10) })],
      ['an empty cipher text', (s) => ({ ...s, ct: '' })],
      ['a cipher text that is not base64url', (s) => ({ ...s, ct: `${PLAINTEXT}!` })],
      ['the plaintext as the key reference', (s) => ({ ...s, kekRef: 42 })],
      ['the plaintext as the iv', (s) => ({ ...s, iv: PLAINTEXT })],
      ['a number for the data key', (s) => ({ ...s, dek: 7 })],
    ];

    it.each(shapes)('%s', async (_name, make) => {
      const keys = keyfile();
      const sealed = await sealOrgSecret(keys, ctx, PLAINTEXT);
      const error = await openOrgSecret(keys, ctx, make(sealed)).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(ZodError);
      const text = `${(error as ZodError).message} ${JSON.stringify((error as ZodError).issues)} ${String(error)}`;
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('smtp.example.test');
      expect(text).not.toContain(PLAINTEXT);
    });

    it('does not call the KMS for a malformed value', async () => {
      let calls = 0;
      const real = keyfile();
      const counting: KeyProvider = { ...real, unwrap: (...args) => (calls++, real.unwrap(...args)) };
      await expect(openOrgSecret(counting, ctx, { v: 1 })).rejects.toBeInstanceOf(ZodError);
      expect(calls).toBe(0);
    });
  });

  describe('limits what is sealed', () => {
    it('refuses an empty secret', async () => {
      await expectPortError(sealOrgSecret(keyfile(), ctx, ''), 'invalid_argument');
      await expectPortError(sealOrgSecret(keyfile(), ctx, new Uint8Array()), 'invalid_argument');
    });

    it('seals the longest allowed secret and refuses one byte more', async () => {
      const keys = keyfile();
      const longest = randomBytes(MAX_ORG_SECRET_BYTES);
      const sealed = await sealOrgSecret(keys, ctx, longest);
      expect(Buffer.from(await openOrgSecret(keys, ctx, sealed))).toEqual(longest);
      await expectPortError(sealOrgSecret(keys, ctx, randomBytes(MAX_ORG_SECRET_BYTES + 1)), 'invalid_argument');
    });

    it('seals text with multi-byte characters unchanged', async () => {
      const keys = keyfile();
      const sealed = await sealOrgSecret(keys, ctx, utf8('पासवर्ड-密码-🔑'));
      expect(await openOrgSecretText(keys, ctx, sealed)).toBe('पासवर्ड-密码-🔑');
    });
  });
});
