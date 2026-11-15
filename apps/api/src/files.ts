import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';

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

/** The request body an upload of a file of at most `bytes` needs: its base64, plus the JSON around it. */
export const uploadBodyLimitFor = (bytes: number): number => Math.ceil(bytes / 3) * 4 + 4096;

/** The request body limit for an upload whatever the form: the base64 of the biggest file any form may take. */
export const UPLOAD_BODY_LIMIT = uploadBodyLimitFor(MAX_UPLOAD_BYTES);

/**
 * `source` passed through, unchanged, until it has carried more than `limit` bytes; then the stream fails with
 * `onExceed()`. For a body that declares no length (chunked), where nothing is known to be too big until it is.
 */
export function capBytes(source: Readable, limit: number, onExceed: () => Error): Readable {
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) done(onExceed());
      else done(null, chunk);
    },
  });
  // Errors of the source travel on; nothing is left listening when the counter fails.
  source.once('error', (err) => counter.destroy(err));
  return source.pipe(counter);
}

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

type Family = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'zip' | 'ole';

/** What the bytes of an allowed type must look like: a format whose first bytes `sniff` knows, or plain text. */
type Content = Family | 'text';

interface AllowedType {
  /** Lower-case file name extensions, without the dot. */
  extensions: readonly string[];
  /** The MIME types a browser sends for them (parameters such as `; charset` are removed first). */
  mimeTypes: readonly string[];
  content: Content;
}

const OOXML = 'application/vnd.openxmlformats-officedocument';
const ODF = 'application/vnd.oasis.opendocument';

/**
 * The only (extension, MIME type, content) triples that are ever stored, whatever a form's own field says it accepts:
 * a field narrows this list, never widens it. It is an allowlist because a list of bad types is never complete (a
 * browser opens `.xht`, `.mht` and `.chm`, and Windows opens `.pif`, `.cpl` and `.iso`, as readily as `.html` and
 * `.exe`), and because every entry names the bytes that must be inside, so a program cannot ride in under a
 * document's name. The download headers (attachment, octet-stream, nosniff, a sandbox CSP) remain the guarantee that
 * a stored file never runs; this list keeps the store clean.
 */
const ALLOWED: readonly AllowedType[] = [
  { extensions: ['pdf'], mimeTypes: ['application/pdf'], content: 'pdf' },
  { extensions: ['png'], mimeTypes: ['image/png'], content: 'png' },
  { extensions: ['jpg', 'jpeg'], mimeTypes: ['image/jpeg'], content: 'jpeg' },
  { extensions: ['gif'], mimeTypes: ['image/gif'], content: 'gif' },
  { extensions: ['webp'], mimeTypes: ['image/webp'], content: 'webp' },
  { extensions: ['doc'], mimeTypes: ['application/msword'], content: 'ole' },
  { extensions: ['xls'], mimeTypes: ['application/vnd.ms-excel'], content: 'ole' },
  { extensions: ['ppt'], mimeTypes: ['application/vnd.ms-powerpoint'], content: 'ole' },
  { extensions: ['docx'], mimeTypes: [`${OOXML}.wordprocessingml.document`], content: 'zip' },
  { extensions: ['xlsx'], mimeTypes: [`${OOXML}.spreadsheetml.sheet`], content: 'zip' },
  { extensions: ['pptx'], mimeTypes: [`${OOXML}.presentationml.presentation`], content: 'zip' },
  { extensions: ['odt'], mimeTypes: [`${ODF}.text`], content: 'zip' },
  { extensions: ['ods'], mimeTypes: [`${ODF}.spreadsheet`], content: 'zip' },
  { extensions: ['odp'], mimeTypes: [`${ODF}.presentation`], content: 'zip' },
  { extensions: ['zip'], mimeTypes: ['application/zip', 'application/x-zip-compressed'], content: 'zip' },
  { extensions: ['txt'], mimeTypes: ['text/plain'], content: 'text' },
  // Windows with Excel installed reports a .csv as application/vnd.ms-excel.
  { extensions: ['csv'], mimeTypes: ['text/csv', 'application/csv', 'application/vnd.ms-excel'], content: 'text' },
];

const BY_EXTENSION = new Map(ALLOWED.flatMap((type) => type.extensions.map((ext) => [ext, type] as const)));

/** A MIME type without its parameters, lower case: `Text/Plain; charset=UTF-8` is `text/plain`. */
export function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

function allowedType(name: string, mime: string): AllowedType | null {
  const type = BY_EXTENSION.get(extensionOf(name));
  return type && type.mimeTypes.includes(baseMime(mime)) ? type : null;
}

/**
 * True for every (name, MIME type) pair that is not on the allowlist: markup, scripts, programs, installers, disk
 * images, macro documents, shortcuts, and every type nobody has vouched for. Named for what the upload route does
 * with it: it never stores it.
 */
export function isNeverStored(name: string, mime: string): boolean {
  return allowedType(name, mime) === null;
}

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

/**
 * True when the first bytes, after a byte-order mark, blanks and any run of `<!-- -->` comments, open a tag, a
 * declaration or a processing instruction: a page or an SVG that a browser would run if it were ever served as one.
 * A comment that never closes counts as markup. Only the head is read, as a browser's sniffer reads only the head.
 */
function opensMarkup(bytes: Buffer): boolean {
  let head = bytes.subarray(0, 4096).toString('utf8').replace(/^\ufeff/, '');
  for (;;) {
    // eslint-disable-next-line no-control-regex -- a NUL is blank to a browser's sniffer
    head = head.replace(/^[\s\u0000]+/, '');
    if (!head.startsWith('<!--')) break;
    const end = head.indexOf('-->', 4);
    if (end < 0) return true;
    head = head.slice(end + 3);
  }
  return /^<[a-z!?/]/i.test(head);
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Text is valid UTF-8 and holds no control character but tab, line feed and carriage return (so no NUL, no escape codes). */
function isPlainText(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte < 0x20 ? byte !== 0x09 && byte !== 0x0a && byte !== 0x0d : byte === 0x7f) return false;
  }
  try {
    UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why these bytes cannot be what the name and MIME say, or are markup that could run if ever served, else null:
 * `markup`; `type_not_allowed` (not an allowlisted extension and MIME pair); or `content_mismatch` (the bytes are not
 * the format the pair names: a program or a zip named .txt, a PNG named .pdf).
 */
export function contentProblem(bytes: Buffer, name: string, mime: string): string | null {
  if (opensMarkup(bytes)) return 'markup';
  const type = allowedType(name, mime);
  if (!type) return 'type_not_allowed';
  if (type.content === 'text') return isPlainText(bytes) ? null : 'content_mismatch';
  return sniff(bytes) === type.content ? null : 'content_mismatch';
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
