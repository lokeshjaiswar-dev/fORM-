import type { TrustedKey } from './formpack.ts';

export const DEV_KEY_ID = 'fORM-dev-2026';

/**
 * The P0 development signing key (`templates:build` without `FORM_PACK_SIGNING_KEY`). Its seed is public, so it proves
 * only that a pack came out of `templates:build`: the offline builder trusts it until release packs are signed with the
 * CI KMS key and readers take their keys from the trust store (WP-T1.2).
 */
export const DEV_TRUSTED_KEY: TrustedKey = { keyId: DEV_KEY_ID, alg: 'ed25519', publicKey: '0rjZe50bgDfclrjHjunBA4vUZ0dNsdLOgOpgU04ut7M=' };
