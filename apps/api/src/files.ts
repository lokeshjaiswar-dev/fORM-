import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/*
 * Respondent files: the rules for what may be stored and how it is served back, and the byte store.
 *
 * The store is the local filesystem for now (`.data/files`, gitignored). Moving the bytes to the StoragePort / S3
 * adapter, with presigned uploads, scanning and lifecycle rules, is WP-1.14; `FileStore` is the seam it replaces.
 * Ownership does not live here: it is the `form_files` row (org, form), checked under row-level security.
 */

/** The most a single uploaded file may be, whatever the form's own limit says (the public runtime config says the same). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** A signature is a small PNG of a pad: far under this. */
export const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

/** The request body limit for an upload: the base64 of the biggest file, plus the JSON around it. */
export const UPLOAD_BODY_LIMIT = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4096;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface FileStore {
  /** Writes new bytes under `id` (a server-made uuid); never replaces an existing file. */
  put(id: string, bytes: Buffer): Promise<void>;
  get(id: string): Promise<Buffer | null>;
  remove(id: string): Promise<void>;
}

/** Bytes as `<dir>/<uuid>.bin`. The id must be a uuid, so no id can name a path outside `dir`. */
export function createFileStore(dir: string): FileStore {
  const root = path.resolve(dir);
  const at = (id: string): string => {
    if (!UUID.test(id)) throw new TypeError('file id must be a uuid');
    return path.join(root, `${id}.bin`);
  };
  return {
    async put(id, bytes) {
      await mkdir(root, { recursive: true });
      await writeFile(at(id), bytes, { flag: 'wx', mode: 0o600 });
    },
    async get(id) {
      try {
        return await readFile(at(id));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async remove(id) {
      await unlink(at(id)).catch(() => undefined);
    },
  };
}

/** Control characters, zero-width and direction-changing marks: invisible in a list, and able to disguise an extension. */
function isHidden(cp: number): boolean {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff;
}

const NOT_FILENAME = /[<>:"|?*\\/]/g;

/**
 * A name that is safe to show, store and put in a header: no path (a client's `..\..\x` is its last part), no control or
 * direction-changing characters, no characters the common file systems refuse, never empty, at most 150 characters
 * with the extension kept.
 */
export function normaliseFileName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? '';
  const visible = [...last.normalize('NFC')].filter((ch) => !isHidden(ch.codePointAt(0)!)).join('');
  let name = visible.replace(NOT_FILENAME, '_').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (name === '') return 'file';
  if (name.length > 150) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, 150 - ext.length) + ext;
  }
  return name;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Used when a form's upload field does not say what it takes (both lists empty): documents and pictures only. */
export const DEFAULT_ACCEPT = {
  extensions: ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'doc', 'docx', 'txt', 'csv'],
  mimeTypes: [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/csv',
  ],
} as const;

/** Never stored, whatever a form's field says it accepts: markup and programs a person might open or run. */
const NEVER = new Set([
  'html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'xml', 'xsl', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'php', 'phtml', 'asp', 'aspx', 'jsp',
  'exe', 'dll', 'msi', 'com', 'scr', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'sh', 'bash', 'jar', 'apk', 'app', 'dmg', 'lnk', 'hta', 'swf',
]);
const NEVER_MIME = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/x-msdownload)/;

export function isNeverStored(name: string, mime: string): boolean {
  return NEVER.has(extensionOf(name)) || NEVER_MIME.test(mime.toLowerCase());
}

type Family = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'zip' | 'ole';

/** The format the first bytes announce, for the formats whose type a browser-supplied name or MIME could fake. */
export function sniff(bytes: Buffer): Family | null {
  const head = (n: number) => bytes.subarray(0, n);
  if (head(5).toString('latin1') === '%PDF-') return 'pdf';
  if (head(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head(3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  if (['GIF87a', 'GIF89a'].includes(head(6).toString('latin1'))) return 'gif';
  if (head(4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (head(4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'zip';
  if (head(8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole';
  return null;
}

/** The family a declared name and MIME claim, when it is one `sniff` can check. */
function claimedFamily(ext: string, mime: string): Family | null {
  const m = mime.toLowerCase();
  if (ext === 'pdf' || m === 'application/pdf') return 'pdf';
  if (ext === 'png' || m === 'image/png') return 'png';
  if (ext === 'jpg' || ext === 'jpeg' || m === 'image/jpeg') return 'jpeg';
  if (ext === 'gif' || m === 'image/gif') return 'gif';
  if (ext === 'webp' || m === 'image/webp') return 'webp';
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'zip'].includes(ext) || m.includes('openxmlformats') || m === 'application/zip') return 'zip';
  if (['doc', 'xls', 'ppt'].includes(ext) || m === 'application/msword' || m === 'application/vnd.ms-excel') return 'ole';
  return null;
}

const MARKUP_START = /^\s*(<!doctype\s+html|<html|<head|<body|<script|<svg|<\?xml|<iframe|<object|<embed|<meta)/i;

/** Why these bytes cannot be what the name and MIME say (or are markup that could run if ever served), else null. */
export function contentProblem(bytes: Buffer, name: string, mime: string): string | null {
  if (MARKUP_START.test(bytes.subarray(0, 1024).toString('utf8').replace(/^\ufeff/, ''))) return 'markup';
  const claimed = claimedFamily(extensionOf(name), mime);
  const actual = sniff(bytes);
  if (claimed && actual !== claimed) return 'content_mismatch';
  // A format we recognise under a name that claims something else (a PNG named .pdf, or .txt).
  if (!claimed && actual && actual !== 'zip' && actual !== 'ole') return 'content_mismatch';
  return null;
}

/** The only types served back as themselves; everything else is `application/octet-stream`. */
const SERVED_AS_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function downloadContentType(storedMime: string): string {
  const m = storedMime.toLowerCase();
  return SERVED_AS_IMAGE.has(m) ? m : 'application/octet-stream';
}

/** `attachment` with an ASCII fallback and the full name as RFC 5987 `filename*`, safe in a header whatever the name holds. */
export function attachmentHeader(name: string): string {
  const safe = normaliseFileName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;%]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
