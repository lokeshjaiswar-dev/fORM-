import { FormpackAttestationSchema, FormpackManifestSchema, FormpackSignatureSchema, FormpackTemplateFileSchema, TemplateCategorySchema, canonicalJson } from '@form/schema';
import type { FormpackAttestation, FormpackManifest, FormpackSignature, FormpackTemplateFile, Sha256Hex } from '@form/schema';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';

/* `.formpack` bundles (templates spec §8.1): a zip whose manifest lists every file's sha256, signed over JCS(manifest). */

export const MANIFEST_PATH = 'manifest.json';
export const SIGNATURE_PATH = 'signature.json';
export const CATEGORIES_PATH = 'categories.json';
export const ATTESTATIONS_PATH = 'attestations.json';

/** Import guards (templates spec §8.1 step 1). */
export const FORMPACK_LIMITS = {
  packBytes: 200 * 1024 * 1024,
  files: 2000,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  /** Largest uncompressed / compressed ratio a file may have. */
  ratio: 200,
} as const;

export type SignatureAlg = FormpackSignature['alg'];

/**
 * A key a reader trusts, as in `template_signing_keys` and the Helm `trustedKeys` list. `publicKey` is base64 of the
 * port wire format: 32 raw bytes for `ed25519`, a 65-byte uncompressed SEC1 point for `es256`.
 */
export interface TrustedKey { keyId: string; alg: SignatureAlg; publicKey: string }

/** Signs with one key; the key decides the algorithm (`KeyProvider.sign(keyId, data)` has this shape). */
export interface PackSigner { keyId: string; sign(data: Uint8Array): Promise<{ alg: SignatureAlg; signature: Uint8Array }> }

/** `categories.json`: categories without database ids; a child names its parent by slug. */
export const PackCategorySchema = TemplateCategorySchema.omit({ id: true, orgId: true, parentId: true }).extend({ parentSlug: z.string().min(1).exactOptional() });
export type PackCategory = z.infer<typeof PackCategorySchema>;

export type FormpackTemplateEntry = FormpackManifest['templates'][number];
export interface FormpackTemplate { entry: FormpackTemplateEntry; file: FormpackTemplateFile }

export interface Formpack {
  manifest: FormpackManifest;
  signature: FormpackSignature;
  templates: FormpackTemplate[];
  categories: PackCategory[];
  attestations: FormpackAttestation[];
}

export type FormpackErrorCode =
  | 'invalid_zip' | 'unsafe_path' | 'too_large' | 'missing_file' | 'unlisted_file' | 'manifest_invalid' | 'signature_invalid'
  | 'untrusted_key' | 'algorithm_mismatch' | 'bad_signature' | 'hash_mismatch' | 'file_invalid';

export class FormpackError extends Error {
  readonly code: FormpackErrorCode;
  readonly path: string | undefined;

  constructor(code: FormpackErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'FormpackError';
    this.code = code;
    this.path = path;
  }
}

export const sha256Hex = (bytes: Uint8Array): Sha256Hex => bytesToHex(sha256(bytes)) as Sha256Hex;

/** The bytes a pack signature covers: UTF-8 of the manifest's RFC 8785 form. */
export const manifestBytes = (manifest: unknown): Uint8Array => utf8ToBytes(canonicalJson(manifest));

export const jsonBytes = (value: unknown): Uint8Array => utf8ToBytes(`${JSON.stringify(value, null, 2)}\n`);

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

/** Zip entries are written in this order with a fixed timestamp, so the same files give the same bytes. */
const ZIP_TIME = Date.UTC(2000, 0, 1, 12);

/** Writes the manifest, signs it and zips the bundle. `files` holds every file the manifest lists. */
export async function writeFormpack(manifest: FormpackManifest, files: ReadonlyMap<string, Uint8Array>, signer: PackSigner): Promise<Uint8Array> {
  const signed = manifestBytes(manifest);
  const { alg, signature } = await signer.sign(signed);
  const sig: FormpackSignature = { alg, keyId: signer.keyId, sig: toBase64(signature) };
  const zippable: Zippable = {
    [MANIFEST_PATH]: [jsonBytes(manifest), { mtime: ZIP_TIME }],
    [SIGNATURE_PATH]: [jsonBytes(sig), { mtime: ZIP_TIME }],
  };
  for (const path of [...files.keys()].sort()) zippable[path] = [files.get(path) ?? new Uint8Array(), { mtime: ZIP_TIME }];
  return zipSync(zippable, { level: 9 });
}

const UNSAFE_PATH = /(^\/)|\\|(^|\/)\.\.?(\/|$)|\/\/|^[A-Za-z]:/;
/** Absolute, drive-letter, backslash, dot-segment, empty-segment and control-character paths. */
const unsafePath = (name: string): boolean => UNSAFE_PATH.test(name) || [...name].some((c) => c.charCodeAt(0) < 0x20);

function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength > FORMPACK_LIMITS.packBytes) throw new FormpackError('too_large', `the pack is larger than ${FORMPACK_LIMITS.packBytes} bytes`);
  const seen = new Set<string>();
  let total = 0;
  let out: Record<string, Uint8Array>;
  try {
    out = unzipSync(bytes, {
      filter(file) {
        if (file.name.endsWith('/')) return false;
        if (unsafePath(file.name)) throw new FormpackError('unsafe_path', `unsafe path ${JSON.stringify(file.name)}`, file.name);
        if (seen.has(file.name)) throw new FormpackError('invalid_zip', `${file.name} appears twice`, file.name);
        seen.add(file.name);
        if (seen.size > FORMPACK_LIMITS.files) throw new FormpackError('too_large', `more than ${FORMPACK_LIMITS.files} files`);
        total += file.originalSize;
        if (file.originalSize > FORMPACK_LIMITS.fileBytes || total > FORMPACK_LIMITS.totalBytes) throw new FormpackError('too_large', `${file.name} is too large`, file.name);
        if (file.originalSize > Math.max(file.size, 1) * FORMPACK_LIMITS.ratio) throw new FormpackError('too_large', `${file.name} expands more than ${FORMPACK_LIMITS.ratio} times`, file.name);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof FormpackError) throw e;
    throw new FormpackError('invalid_zip', `not a readable zip: ${e instanceof Error ? e.message : String(e)}`);
  }
  return new Map(Object.entries(out));
}

function readJson(files: ReadonlyMap<string, Uint8Array>, path: string, code: FormpackErrorCode): unknown {
  const bytes = files.get(path);
  if (!bytes) throw new FormpackError('missing_file', `${path} is missing`, path);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new FormpackError(code, `${path} is not UTF-8 JSON`, path);
  }
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, value: unknown, code: FormpackErrorCode, path: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new FormpackError(code, `${path}: ${issue ? `${issue.path.map(String).join('/')} ${issue.message}` : 'invalid'}`, path);
}

/** WebCrypto verification with the port wire formats (Ed25519 raw key; ES256 SEC1 key and IEEE P1363 signature). */
export async function verifySignature(alg: SignatureAlg, publicKey: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const { subtle } = globalThis.crypto;
  const own = (b: Uint8Array) => new Uint8Array(b);
  try {
    if (alg === 'ed25519') {
      const key = await subtle.importKey('raw', own(publicKey), { name: 'Ed25519' }, false, ['verify']);
      return await subtle.verify({ name: 'Ed25519' }, key, own(signature), own(data));
    }
    const key = await subtle.importKey('raw', own(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, own(signature), own(data));
  } catch {
    return false;
  }
}

export interface ReadOptions { trustedKeys: readonly TrustedKey[] }

/**
 * Opens a `.formpack`: zip guards, then the signature over JCS(manifest) with a trusted key of the same algorithm,
 * then every listed file against its sha256. A file the manifest does not list is refused, so the one signature
 * covers the whole bundle. Template files are parsed with their twins; migration and full validation are the
 * importer's (templates spec §8.1 step 3).
 */
export async function readFormpack(bytes: Uint8Array, options: ReadOptions): Promise<Formpack> {
  const files = unzip(bytes);
  const rawManifest = readJson(files, MANIFEST_PATH, 'manifest_invalid');
  const manifest = parse(FormpackManifestSchema, rawManifest, 'manifest_invalid', MANIFEST_PATH);
  const signature = parse(FormpackSignatureSchema, readJson(files, SIGNATURE_PATH, 'signature_invalid'), 'signature_invalid', SIGNATURE_PATH);

  const key = options.trustedKeys.find((k) => k.keyId === signature.keyId);
  if (!key) throw new FormpackError('untrusted_key', `key ${JSON.stringify(signature.keyId)} is not trusted`, SIGNATURE_PATH);
  if (key.alg !== signature.alg) throw new FormpackError('algorithm_mismatch', `key ${key.keyId} signs with ${key.alg}, not ${signature.alg}`, SIGNATURE_PATH);
  let sig: Uint8Array;
  let publicKey: Uint8Array;
  try {
    sig = fromBase64(signature.sig);
    publicKey = fromBase64(key.publicKey);
  } catch {
    throw new FormpackError('signature_invalid', 'the signature or key is not base64', SIGNATURE_PATH);
  }
  if (!(await verifySignature(key.alg, publicKey, sig, manifestBytes(rawManifest)))) {
    throw new FormpackError('bad_signature', `the manifest signature does not verify with ${key.keyId}`, SIGNATURE_PATH);
  }

  const listed = [
    ...manifest.templates.map((t) => ({ path: t.path, sha256: t.sha256 })),
    manifest.categories,
    ...(manifest.attestations ? [manifest.attestations] : []),
    ...manifest.assets.map((a) => ({ path: a.path, sha256: a.sha256 })),
  ];
  const paths = new Set<string>([MANIFEST_PATH, SIGNATURE_PATH]);
  for (const { path, sha256: expected } of listed) {
    if (paths.has(path)) throw new FormpackError('manifest_invalid', `${path} is listed twice`, path);
    paths.add(path);
    const file = files.get(path);
    if (!file) throw new FormpackError('missing_file', `${path} is listed but missing`, path);
    if (sha256Hex(file) !== expected) throw new FormpackError('hash_mismatch', `${path} does not match its manifest sha256`, path);
  }
  for (const path of files.keys()) if (!paths.has(path)) throw new FormpackError('unlisted_file', `${path} is not in the manifest`, path);

  const templates = manifest.templates.map((entry): FormpackTemplate => {
    const file = parse(FormpackTemplateFileSchema, readJson(files, entry.path, 'file_invalid'), 'file_invalid', entry.path);
    if (file.payload.kind !== entry.kind) throw new FormpackError('file_invalid', `${entry.path} holds a ${file.payload.kind} template, the manifest says ${entry.kind}`, entry.path);
    return { entry, file };
  });
  const categories = parse(z.array(PackCategorySchema), readJson(files, manifest.categories.path, 'file_invalid'), 'file_invalid', manifest.categories.path);
  const attestations = manifest.attestations
    ? parse(z.array(FormpackAttestationSchema), readJson(files, manifest.attestations.path, 'file_invalid'), 'file_invalid', manifest.attestations.path)
    : [];
  return { manifest, signature, templates, categories, attestations };
}
