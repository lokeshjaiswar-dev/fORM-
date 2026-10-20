import { BUCKET_NAMES, MAX_PRESIGN_EXPIRES_SEC, PortError, isValidObjectKey, isValidObjectTags, type BucketName, type ByteRange, type PresignPostInput } from '@form/ports';
import { hasControlChars } from '../text.ts';

/** The argument checks every store runs before it touches anything, so stores fail alike (storage contract). */

const CONTENT_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\\\r\n]*"))*$/;

export const invalid = (message: string) => new PortError('invalid_argument', message);

export function checkBucket(bucket: string): BucketName {
  if (!(BUCKET_NAMES as readonly string[]).includes(bucket)) throw invalid(`unknown bucket: ${bucket}`);
  return bucket as BucketName;
}

export function checkKey(key: string): string {
  if (!isValidObjectKey(key)) throw invalid(`invalid object key: ${JSON.stringify(key)}`);
  return key;
}

export function checkContentType(contentType: string): string {
  if (!CONTENT_TYPE.test(contentType)) throw invalid(`invalid content type: ${JSON.stringify(contentType)}`);
  return contentType;
}

export function checkExpires(expiresSec: number): number {
  if (!Number.isInteger(expiresSec) || expiresSec < 1 || expiresSec > MAX_PRESIGN_EXPIRES_SEC) {
    throw invalid(`expiresSec must be an integer in 1..${MAX_PRESIGN_EXPIRES_SEC}`);
  }
  return expiresSec;
}

export function checkDownloadName(dl: string | undefined): string | undefined {
  if (dl !== undefined && (dl.length === 0 || dl.length > 255 || hasControlChars(dl) || /["\\/]/.test(dl))) throw invalid('invalid downloadName');
  return dl;
}

export function checkPostInput(i: PresignPostInput): void {
  checkBucket(i.bucket);
  checkKey(i.key);
  checkContentType(i.contentType);
  checkExpires(i.expiresSec);
  if (!Number.isInteger(i.minBytes) || !Number.isInteger(i.maxBytes) || i.minBytes < 0 || i.minBytes > i.maxBytes) {
    throw invalid('need integers 0 <= minBytes <= maxBytes');
  }
  if (i.tags && !isValidObjectTags(i.tags)) throw invalid('invalid object tags');
}

/** Shape only; whether `start` lies inside the object is the store's to say. */
export function checkRange(range: ByteRange): void {
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) throw invalid(`unsatisfiable range ${start}-${end}`);
}
