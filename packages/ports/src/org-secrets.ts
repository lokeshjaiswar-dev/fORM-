/**
 * Org secrets at rest (WP-1.16, WP-1.18): the SMTP URL of an org's email sender and the HMAC key of a webhook.
 *
 * This is the seam the api and the worker use. They may not import `@form/adapters` (only the composition roots do:
 * the `adapters-only-from-composition-roots` rule), so the routes and jobs that seal or open a secret receive an
 * `OrgSecrets` in their deps, typed here, and `main.ts` builds it with `createOrgSecrets(keys)` from
 * `@form/adapters/kms`. A fake of this interface is all a unit test of a route needs.
 *
 * A secret is never returned by an API after it is created and never logged; an implementation puts no plaintext, key
 * or stored value into an error message.
 */

/** What a secret is bound to: its org, its row and its kind (`smtp`, `webhook_hmac`, ...). Each is a plain identifier without `:`. */
export interface OrgSecretContext {
  orgId: string;
  secretId: string;
  kind: string;
}

/** The stored jsonb value of a sealed secret: no plaintext in it. `dek` is the data key wrapped under the org's key context. */
export interface SealedOrgSecret {
  v: 1;
  alg: 'A256GCM';
  /** Which KMS key wrapped the data key, as `KeyProvider.wrap` returned it. */
  kekRef: string;
  dek: string;
  iv: string;
  tag: string;
  ct: string;
}

/** `KeyProvider` bound to the envelope of org secrets; the one object a route or job needs to seal or open one. */
export interface OrgSecrets {
  /** Encrypts `plaintext` for one secret row; sealing the same value twice gives two different stored values. */
  seal(ctx: OrgSecretContext, plaintext: Uint8Array | string): Promise<SealedOrgSecret>;
  /**
   * Decrypts a stored value (`unknown`, because it comes from a jsonb column). Throws when it is not the stored shape,
   * and `PortError('integrity')` when it was changed or belongs to another org, row or kind.
   */
  open(ctx: OrgSecretContext, stored: unknown): Promise<Uint8Array>;
}
