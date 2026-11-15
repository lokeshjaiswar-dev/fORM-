import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { attachmentHeader, contentProblem, createFileStore, downloadContentType, isNeverStored, normaliseFileName, sniff } from './files.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from('%PDF-1.7\n%%EOF');

describe('normaliseFileName', () => {
  it('keeps only the last part of a path, either style', () => {
    expect(normaliseFileName('../../etc/passwd')).toBe('passwd');
    expect(normaliseFileName('C:\\Users\\asha\\cv.pdf')).toBe('cv.pdf');
  });

  it('drops control, zero-width and direction-changing characters, which can disguise an extension', () => {
    expect(normaliseFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(normaliseFileName('a\u0000b\u200b.pdf')).toBe('ab.pdf');
  });

  it('replaces characters file systems refuse, never ends in a dot or space, and is never empty', () => {
    expect(normaliseFileName('a<b>:"c|d?*.pdf')).toBe('a_b___c_d__.pdf');
    expect(normaliseFileName('report.pdf. . ')).toBe('report.pdf');
    expect(normaliseFileName('...')).toBe('file');
    expect(normaliseFileName('   ')).toBe('file');
    expect(normaliseFileName('.htaccess')).toBe('htaccess');
  });

  it('shortens a long name but keeps its extension', () => {
    const name = normaliseFileName(`${'a'.repeat(400)}.pdf`);
    expect(name.length).toBeLessThanOrEqual(150);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('attachmentHeader', () => {
  it('is an attachment whatever the name holds, with an ASCII fallback and the full name encoded', () => {
    expect(attachmentHeader('résumé.pdf')).toBe(`attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`);
    const hostile = attachmentHeader('x"; filename="evil.html\r\nSet-Cookie: a=b');
    expect(hostile).not.toMatch(/[\r\n]/);
    // One quoted fallback with no quote, semicolon or backslash in it, then the percent-encoded full name.
    expect(hostile).toMatch(/^attachment; filename="[^";\\]*"; filename\*=UTF-8''[A-Za-z0-9%._-]*$/);
  });
});

describe('what may be stored and how it is served', () => {
  it('never stores markup or programs, by extension or MIME type', () => {
    for (const [name, mime] of [['a.html', 'text/plain'], ['a.txt', 'text/html'], ['a.svg', 'image/svg+xml'], ['a.png', 'image/svg+xml'], ['a.JS', 'text/plain'], ['a.exe', 'x']] as const) {
      expect(isNeverStored(name, mime), name).toBe(true);
    }
    expect(isNeverStored('a.pdf', 'application/pdf')).toBe(false);
  });

  it('stores only extension and MIME pairs on the allowlist, and ignores MIME parameters', () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(isNeverStored('cv.docx', docx)).toBe(false);
    expect(isNeverStored('cv.DOCX', docx)).toBe(false);
    expect(isNeverStored('notes.txt', 'Text/Plain; charset=UTF-8')).toBe(false);
    expect(isNeverStored('table.csv', 'application/vnd.ms-excel')).toBe(false);
    // Right extension, wrong MIME type; right MIME type, wrong extension; an extension nobody vouched for.
    expect(isNeverStored('cv.docx', 'application/octet-stream')).toBe(true);
    expect(isNeverStored('cv.pdf', 'text/plain')).toBe(true);
    expect(isNeverStored('cv', 'application/pdf')).toBe(true);
    expect(isNeverStored('movie.mp4', 'video/mp4')).toBe(true);
    expect(isNeverStored('macro.docm', docx)).toBe(true);
  });

  it('wants bytes that are the format the pair names: a document starts as one, text is clean UTF-8', () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16, 0)]);
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(contentProblem(zip, 'cv.docx', docx)).toBeNull();
    expect(contentProblem(PDF, 'cv.docx', docx)).toBe('content_mismatch');
    expect(contentProblem(Buffer.from('café, naïve 日本語\r\n'), 'a.txt', 'text/plain')).toBeNull();
    expect(contentProblem(Buffer.from('a\u0000b'), 'a.txt', 'text/plain')).toBe('content_mismatch');
    expect(contentProblem(Buffer.from([0x61, 0xff, 0x62]), 'a.csv', 'text/csv')).toBe('content_mismatch');
    expect(contentProblem(Buffer.from('a \u001b[31m red'), 'a.txt', 'text/plain')).toBe('content_mismatch');
    expect(contentProblem(Buffer.from('hello'), 'a.xht', 'application/octet-stream')).toBe('type_not_allowed');
    // Text that merely contains angle brackets is fine; text that opens a tag is not, even after comments and blanks.
    expect(contentProblem(Buffer.from('1 < 2 and 3 > 2'), 'a.txt', 'text/plain')).toBeNull();
    expect(contentProblem(Buffer.from('  \n<!-- a --> <!-- b -->\n<p>hi</p>'), 'a.txt', 'text/plain')).toBe('markup');
    expect(contentProblem(Buffer.from('<!-- never closed <script>'), 'a.txt', 'text/plain')).toBe('markup');
  });

  it('recognises formats by their first bytes', () => {
    expect(sniff(PNG)).toBe('png');
    expect(sniff(PDF)).toBe('pdf');
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniff(Buffer.from('GIF89a....'))).toBe('gif');
    expect(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
    expect(sniff(Buffer.from('plain text'))).toBeNull();
  });

  it('accepts a file that is what it says, and refuses one that is not or that is markup', () => {
    expect(contentProblem(PDF, 'a.pdf', 'application/pdf')).toBeNull();
    expect(contentProblem(PNG, 'a.png', 'image/png')).toBeNull();
    expect(contentProblem(Buffer.from('just notes'), 'a.txt', 'text/plain')).toBeNull();
    expect(contentProblem(PNG, 'a.pdf', 'application/pdf')).toBe('content_mismatch');
    expect(contentProblem(PDF, 'a.png', 'image/png')).toBe('content_mismatch');
    expect(contentProblem(PNG, 'a.txt', 'text/plain')).toBe('content_mismatch');
    expect(contentProblem(Buffer.from('<html><body>x</body></html>'), 'a.txt', 'text/plain')).toBe('markup');
    expect(contentProblem(Buffer.from('  <!DOCTYPE html>'), 'a.pdf', 'application/pdf')).toBe('markup');
    expect(contentProblem(Buffer.from('<svg xmlns="x"/>'), 'a.png', 'image/png')).toBe('markup');
  });

  it('serves four image types as themselves and everything else as an opaque download', () => {
    for (const image of ['image/png', 'image/jpeg', 'image/gif', 'IMAGE/WEBP']) expect(downloadContentType(image)).toBe(image.toLowerCase());
    for (const other of ['application/pdf', 'text/html', 'image/svg+xml', 'text/plain', '', 'image/png; charset=x']) {
      expect(downloadContentType(other)).toBe('application/octet-stream');
    }
  });
});

describe('createFileStore', () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('keeps bytes under a uuid, never replaces them, and refuses any other id', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fr-store-'));
    const store = createFileStore(dir);
    const id = randomUUID();
    await store.put(id, Buffer.from('one'));
    await expect(store.put(id, Buffer.from('two'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await store.get(id))?.toString()).toBe('one');
    expect(await store.get(randomUUID())).toBeNull();
    for (const bad of ['../x', '..', `${id}/../x`, `${id}.bin`, '', 'a'.repeat(36)]) {
      await expect(store.get(bad), bad).rejects.toThrow(TypeError);
      await expect(store.put(bad, Buffer.from('x')), bad).rejects.toThrow(TypeError);
    }
    await store.remove(id);
    expect(await store.get(id)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});
