/**
 * Stand-ins for @form/schema types until WP-0.04 lands; switch these to re-exports from @form/schema then.
 * They are branded as schema v2 brands them, so code written against them keeps compiling after the switch.
 */
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };
/** ISO 3166-1 alpha-2, e.g. 'IN'. */
export type CountryCode = Brand<string, 'CountryCode'>;
/** RFC 3339 instant in UTC, e.g. '2027-01-31T10:00:00.000Z'. */
export type IsoInstant = Brand<string, 'IsoInstant'>;

export const toIsoInstant = (d: Date): IsoInstant => d.toISOString() as IsoInstant;

/**
 * Bytes in flight. Node `Readable` and WHATWG `ReadableStream` both satisfy it, so the ports stay free of
 * Node and DOM types.
 */
export type ByteStream = AsyncIterable<Uint8Array>;

export type SignatureAlg = 'ed25519' | 'es256';

export type PortErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_argument'
  | 'unsupported'
  | 'expired'
  | 'integrity'
  | 'unavailable'
  /** The remote permanently refused this request (e.g. SMTP 5xx to RCPT TO or DATA); retrying it will not help. */
  | 'rejected'
  | 'egress_denied';

/** The one error type adapters throw for expected failures; anything else is a bug or an outage. */
export class PortError extends Error {
  readonly code: PortErrorCode;

  constructor(code: PortErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PortError';
    this.code = code;
  }
}

export function isPortError(e: unknown, code?: PortErrorCode): e is PortError {
  return e instanceof PortError && (code === undefined || e.code === code);
}
