import { describe, expect, it } from 'vitest';
import { createCsvWriter, CSV_BOM, csvField, csvLine } from './csv.ts';
import type { ByteSink } from './table.ts';
import { parseCsv } from './test-csv.ts';

function collector(): { sink: ByteSink; bytes: () => Buffer } {
  const chunks: Uint8Array[] = [];
  return { sink: { write: async (c) => void chunks.push(c) }, bytes: () => Buffer.concat(chunks) };
}

async function write(headers: string[], rows: string[][]): Promise<Buffer> {
  const out = collector();
  const writer = createCsvWriter(out.sink);
  await writer.start(headers);
  await writer.rows(rows);
  await writer.finish();
  return out.bytes();
}

describe('csv', () => {
  it('quotes a field that holds a comma, a quote or a line break and doubles the quotes inside it (RFC 4180)', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('line1\r\nline2')).toBe('"line1\r\nline2"');
    expect(csvLine(['a', 'b,c', ''])).toBe('a,"b,c",\r\n');
  });

  it('starts with the UTF-8 byte-order mark and ends each record with CRLF', async () => {
    const file = await write(['h1', 'h2'], [['a', 'b']]);
    expect([...file.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
    expect(file.subarray(3).toString('utf8')).toBe('h1,h2\r\na,b\r\n');
  });

  it('round-trips quotes, commas and newlines through a reader', async () => {
    const rows = [
      ['say "hi", then leave', 'two\nlines', 'tab\there'],
      ['', ',', '""'],
    ];
    const file = await write(['a', 'b', 'c'], rows);
    expect(parseCsv(file.subarray(3).toString('utf8'))).toEqual([['a', 'b', 'c'], ...rows]);
  });

  it('round-trips Devanagari and Tamil byte-exact', async () => {
    const devanagari = 'नमस्ते, मेरा नाम आशा है। ऋतु क्षत्रिय ज्ञान';
    const tamil = 'வணக்கம், என் பெயர் ஆஷா. தமிழ்நாடு ஸ்ரீ';
    const file = await write(['नाम', 'பெயர்'], [[devanagari, tamil]]);
    const [header, row] = parseCsv(file.subarray(3).toString('utf8'));
    expect(header).toEqual(['नाम', 'பெயர்']);
    expect(Buffer.from(row![0]!, 'utf8').equals(Buffer.from(devanagari, 'utf8'))).toBe(true);
    expect(Buffer.from(row![1]!, 'utf8').equals(Buffer.from(tamil, 'utf8'))).toBe(true);
    // The bytes in the file are the text's own UTF-8, not a re-encoding.
    expect(file.includes(Buffer.from(devanagari, 'utf8'))).toBe(true);
    expect(file.includes(Buffer.from(tamil, 'utf8'))).toBe(true);
  });

  it('escapes formula payloads in the header and in every cell, and quotes the result when it needs quotes', async () => {
    const payload = "=cmd|' /C calc'!A0";
    const file = await write(['=HYPERLINK("http://evil")', 'ok'], [[payload, '+91 98765 43210'], ['@SUM(A1)', '-5']]);
    const rows = parseCsv(file.subarray(3).toString('utf8'));
    expect(rows).toEqual([
      ['\'=HYPERLINK("http://evil")', 'ok'],
      ["'=cmd|' /C calc'!A0", "'+91 98765 43210"],
      ["'@SUM(A1)", "'-5"],
    ]);
  });

  it('writes nothing for an empty batch and a header-only file when there are no rows', async () => {
    const file = await write(['only'], []);
    expect(file.subarray(3).toString('utf8')).toBe('only\r\n');
  });
});
