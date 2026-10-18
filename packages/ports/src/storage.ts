import type { ByteStream } from './common.ts';

export const BUCKET_NAMES = ['staging', 'uploads', 'assets', 'exports', 'audit', 'packs'] as const;
export type BucketName = (typeof BUCKET_NAMES)[number];

export interface ObjRef {
  bucket: BucketName;
  key: string;
  versionId?: string;
}

/** S3's presigned-URL ceiling (7 days); every implementation enforces it. */
export const MAX_PRESIGN_EXPIRES_SEC = 604_800;
export const MAX_OBJECT_KEY_LENGTH = 1024;

const KEY_SEGMENT = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;

/**
 * Portable object keys: '/'-separated segments of `[A-Za-z0-9._-]` that neither start nor end with '.',
 * so no key can mean a parent directory, a hidden file or a Windows-trimmed name on any store.
 */
export function isValidObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_OBJECT_KEY_LENGTH) return false;
  return key.split('/').every((segment) => KEY_SEGMENT.test(segment));
}

export const MAX_OBJECT_TAGS = 10;
const TAG_TEXT = /^[\p{L}\p{N}\p{Zs}_.:/=+@-]*$/u;

/** S3 object-tag rules: at most 10 tags; keys of 1..128 and values of 0..256 letters, digits, spaces or `_.:/=+-@`; no `aws:` keys. */
export function isValidObjectTags(tags: Record<string, string>): boolean {
  const entries = Object.entries(tags);
  return (
    entries.length <= MAX_OBJECT_TAGS &&
    entries.every(([k, v]) => k.length >= 1 && k.length <= 128 && v.length <= 256 && TAG_TEXT.test(k) && TAG_TEXT.test(v) && !k.toLowerCase().startsWith('aws:'))
  );
}

export interface PresignPostInput {
  bucket: BucketName;
  key: string;
  contentType: string;
  minBytes: number;
  maxBytes: number;
  expiresSec: number;
  /** Object tags the store applies to the upload (`isValidObjectTags`, else PortError('invalid_argument')). */
  tags?: Record<string, string>;
}

/** A browser uploads with multipart/form-data: every `fields` entry, then the file as `file`. */
export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

export interface PresignGetInput {
  bucket: BucketName;
  key: string;
  expiresSec: number;
  downloadName?: string;
}

export interface ObjectHead {
  bytes: number;
  contentType?: string;
  /** Opaque, unquoted; changes whenever the content changes. */
  etag: string;
}

/** Inclusive byte offsets, as in an HTTP `Range` header; `end` past the last byte is clamped. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface PutOptions {
  contentType: string;
  sse?: true;
  objectLock?: { mode: 'compliance'; retainUntil: Date };
}

export interface StorageCapabilities {
  objectLock: boolean;
  versioning: boolean;
  sse: boolean;
}

/**
 * Object storage (architecture §6). Missing objects: `head` → null, `get`/`copy` → PortError('not_found').
 * Asking for `sse`, `objectLock` or a `versionId` the store does not support → PortError('unsupported'),
 * never a silent downgrade.
 */
export interface Storage {
  presignPost(i: PresignPostInput): Promise<PresignedPost>;
  presignGet(i: PresignGetInput): Promise<string>;
  head(bucket: BucketName, key: string): Promise<ObjectHead | null>;
  get(bucket: BucketName, key: string, range?: ByteRange): Promise<ByteStream>;
  put(bucket: BucketName, key: string, body: ByteStream | Uint8Array, o: PutOptions): Promise<void>;
  copy(src: ObjRef, dst: ObjRef): Promise<void>;
  /** Deleting a key that does not exist is not an error. */
  delete(bucket: BucketName, keys: ReadonlyArray<string | { key: string; versionId: string }>): Promise<void>;
  capabilities(): Promise<StorageCapabilities>;
}
