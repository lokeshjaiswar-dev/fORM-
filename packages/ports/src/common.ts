import type { IsoInstant } from '@form/schema';

/** The schema v2 brands (ISO 3166-1 alpha-2; RFC 3339 instant in UTC), so port data is schema data. */
export type { CountryCode, IsoInstant } from '@form/schema';

/** `Date#toISOString` always yields an `IsoInstant`; it lives here because the pure schema package never touches `Date`. */
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
