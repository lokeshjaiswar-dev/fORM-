import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PortError, type KeyProvider, type OrgSecretContext, type OrgSecrets, type SealedOrgSecret } from '@form/ports';
import { z } from 'zod';

/**
 * Org secrets at rest (WP-1.16, WP-1.18): the SMTP URL of an org's email sender and the HMAC key of a webhook. The
 * secret is encrypted with AES-256-GCM under a fresh per-secret data key (DEK), and the DEK is wrapped by the KMS under
 * the ORG's key context, because the org (the Fiduciary of its respondents' data) owns these secrets. It is the pattern
 * of the TOTP secret in `apps/api/src/modules/auth/secrets.ts`, which wraps under the platform context instead.
 *
 * Two bindings keep a stored value from being used anywhere else:
 * - the KMS wrap names the org, so another org's context cannot unwrap the DEK (`PortError('integrity')`);
 * - the GCM additional data is `fr:secret:v1:<kind>:<orgId>:<secretId>`, so the same bytes copied into another secret
 *   row of the same org (another id, or another kind such as an SMTP URL pasted into a webhook) fail authentication.
 *
 * What is stored is `SealedOrgSecret`, a jsonb value with no plaintext in it. A secret is never returned by an API after
 * it is created and never logged; nothing here puts a plaintext, a key or the stored value into an error message.
 *
 * Who calls this: the api and the worker may not import `@form/adapters` (the `adapters-only-from-composition-roots`
 * rule), so they take an `OrgSecrets` (the interface in `@form/ports`) in their deps, and the composition root
 * (`apps/api/src/main.ts`, `apps/worker/src/main.ts`) builds it with `createOrgSecrets(keys)` below.
 */

/** Up to 16 KiB: an SMTP URL or an HMAC key is far smaller, and the row stays small. */
export const MAX_ORG_SECRET_BYTES = 16 * 1024;

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Base64url of `n` bytes is `ceil(n * 4 / 3)` characters, with no padding. */
const b64Length = (n: number) => Math.ceil((n * 4) / 3);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const b64 = z.string().regex(BASE64URL);

/**
 * The stored shape. `iv` and `tag` have the exact length of 12 and 16 bytes, so a truncated value fails here, not in OpenSSL.
 * `satisfies` ties it to the port's `SealedOrgSecret`: a change to one that the other does not follow fails the build.
 */
export const sealedOrgSecretSchema = z.object({
  v: z.literal(1),
  alg: z.literal('A256GCM'),
  /** Which KMS key wrapped the DEK, as `KeyProvider.wrap` returned it. */
  kekRef: z.string().min(1).max(512),
  /** The DEK wrapped under the org's key context. */
  dek: b64.min(1).max(8192),
  iv: b64.length(b64Length(IV_BYTES)),
  tag: b64.length(b64Length(TAG_BYTES)),
  ct: b64.min(1).max(b64Length(MAX_ORG_SECRET_BYTES)),
}) satisfies z.ZodType<SealedOrgSecret>;

/** A short token: no `:` (it separates the parts of the AAD) and no spaces or control characters. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64url = (s: string) => Buffer.from(s, 'base64url');

/** The additional authenticated data of the cipher text; refuses a context that could make two secrets share one. */
function aadOf(ctx: OrgSecretContext): Buffer {
  for (const part of ['kind', 'orgId', 'secretId'] as const) {
    const value: unknown = ctx[part];
    // The message names the part, never its value.
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new PortError('invalid_argument', `the secret's ${part} is missing or not a plain identifier`);
  }
  return Buffer.from(`fr:secret:v1:${ctx.kind}:${ctx.orgId}:${ctx.secretId}`);
}

/**
 * Encrypts `plaintext` for one secret row. Every call makes a new data key and a new IV, so sealing the same value
 * twice gives two different stored values.
 */
export async function sealOrgSecret(keys: KeyProvider, ctx: OrgSecretContext, plaintext: Uint8Array | string): Promise<SealedOrgSecret> {
  const aad = aadOf(ctx);
  const bytes = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  if (bytes.byteLength === 0) throw new PortError('invalid_argument', 'a secret cannot be empty');
  if (bytes.byteLength > MAX_ORG_SECRET_BYTES) throw new PortError('invalid_argument', `a secret is at most ${MAX_ORG_SECRET_BYTES} bytes`);
  const dek = randomBytes(32);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(bytes), cipher.final()]);
  try {
    const { wrapped, kekRef } = await keys.wrap(dek, { orgId: ctx.orgId });
    return sealedOrgSecretSchema.parse({ v: 1, alg: 'A256GCM', kekRef, dek: b64url(wrapped), iv: b64url(iv), tag: b64url(cipher.getAuthTag()), ct: b64url(ct) });
  } finally {
    dek.fill(0);
  }
}

/**
 * Decrypts a stored value. Throws a `ZodError` when `stored` is not the stored shape (its messages name the field and the
 * rule, never the value), and a `PortError('integrity')` when it was changed, belongs to another org, row or kind, or its
 * data key cannot be unwrapped under this org.
 */
export async function openOrgSecret(keys: KeyProvider, ctx: OrgSecretContext, stored: unknown): Promise<Uint8Array> {
  const aad = aadOf(ctx);
  const s = sealedOrgSecretSchema.parse(stored);
  // The KMS refuses a DEK that was wrapped for another org before anything is decrypted.
  const dek = await keys.unwrap(unb64url(s.dek), s.kekRef, { orgId: ctx.orgId });
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, unb64url(s.iv));
    decipher.setAAD(aad);
    decipher.setAuthTag(unb64url(s.tag));
    return new Uint8Array(Buffer.concat([decipher.update(unb64url(s.ct)), decipher.final()]));
  } catch (e) {
    throw new PortError('integrity', 'the stored secret failed authentication', { cause: e });
  } finally {
    dek.fill(0);
  }
}

/** `openOrgSecret` for a secret that was sealed from text (an SMTP URL): the UTF-8 string. */
export async function openOrgSecretText(keys: KeyProvider, ctx: OrgSecretContext, stored: unknown): Promise<string> {
  return new TextDecoder().decode(await openOrgSecret(keys, ctx, stored));
}

/** `sealOrgSecret` and `openOrgSecret` bound to one `KeyProvider`: what the composition roots hand to the routes and jobs. */
export function createOrgSecrets(keys: KeyProvider): OrgSecrets {
  return {
    seal: (ctx, plaintext) => sealOrgSecret(keys, ctx, plaintext),
    open: (ctx, stored) => openOrgSecret(keys, ctx, stored),
  };
}
