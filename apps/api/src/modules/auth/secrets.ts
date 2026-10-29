import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PLATFORM_ORG_KEY } from '@form/db';
import type { KeyProvider } from '@form/ports';
import { z } from 'zod';

/**
 * `users.totp_secret_enc`: the TOTP secret under a per-secret data key (AES-256-GCM, the user id as AAD), and the
 * data key wrapped by the KMS under the platform key context (the platform is the Fiduciary for account data).
 */
const sealedSchema = z.object({
  v: z.literal(1),
  alg: z.literal('A256GCM'),
  kekRef: z.string().min(1),
  dek: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ct: z.string().min(1),
});

export type SealedSecret = z.infer<typeof sealedSchema>;

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');
const aad = (userId: string) => Buffer.from(`fr:totp:v1:${userId}`);

export async function sealTotpSecret(keys: KeyProvider, userId: string, secret: Uint8Array): Promise<SealedSecret> {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(aad(userId));
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  const { wrapped, kekRef } = await keys.wrap(dek, { orgId: PLATFORM_ORG_KEY });
  return { v: 1, alg: 'A256GCM', kekRef, dek: b64(wrapped), iv: b64(iv), tag: b64(cipher.getAuthTag()), ct: b64(ct) };
}

/** Throws when the stored value is malformed, under another key, or belongs to another user. */
export async function openTotpSecret(keys: KeyProvider, userId: string, stored: unknown): Promise<Uint8Array> {
  const s = sealedSchema.parse(stored);
  const dek = await keys.unwrap(unb64(s.dek), s.kekRef, { orgId: PLATFORM_ORG_KEY });
  const decipher = createDecipheriv('aes-256-gcm', dek, unb64(s.iv));
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(unb64(s.tag));
  return new Uint8Array(Buffer.concat([decipher.update(unb64(s.ct)), decipher.final()]));
}
