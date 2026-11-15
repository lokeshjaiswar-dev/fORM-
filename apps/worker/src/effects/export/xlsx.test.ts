import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { createXlsxWriter, XLSX_MAX_CELL_CHARS, xlsxCell } from './xlsx.ts';

async function build(headers: string[], rows: string[][]): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<void>((resolve, reject) => {
    out.on('end', resolve);
    out.on('error', reject);
  });
  const writer = createXlsxWriter(out);
  await writer.start(headers);
  await writer.rows(rows);
  await writer.finish();
  await finished;
  return Buffer.concat(chunks);
}

async function read(file: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet('Responses');
  if (!sheet) throw new Error('no Responses sheet');
  return sheet;
}

const DEVANAGARI = 'नमस्ते, मेरा नाम आशा है। ऋतु क्षत्रिय ज्ञान';
const TAMIL = 'வணக்கம், என் பெயர் ஆஷா. தமிழ்நாடு ஸ்ரீ';

describe('xlsx', () => {
  it('reads back the same Devanagari and Tamil strings', async () => {
    const sheet = await read(await build(['नाम', 'பெயர்'], [[DEVANAGARI, TAMIL]]));
    expect(sheet.getRow(1).values).toEqual([undefined, 'नाम', 'பெயர்']);
    expect(sheet.getCell(2, 1).value).toBe(DEVANAGARI);
    expect(sheet.getCell(2, 2).value).toBe(TAMIL);
  });

  it('makes every cell a string and none a formula, whatever it looks like', async () => {
    const looksLike = ['42', '3.14', '2026-11-16', 'true', '1e3', '=1+1', '=SUM(A1:A2)', '+1', '-1', '@x', '{=1}', 'end'];
    const sheet = await read(await build(['a', 'b', 'c'], [looksLike.slice(0, 3), looksLike.slice(3, 6), looksLike.slice(6, 9), looksLike.slice(9, 12)]));
    let cells = 0;
    sheet.eachRow((row) =>
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells += 1;
        expect(cell.formula, `cell ${cell.address}`).toBeUndefined();
        expect(cell.type === ExcelJS.ValueType.String || cell.type === ExcelJS.ValueType.Null, `cell ${cell.address} is ${ExcelJS.ValueType[cell.type]}`).toBe(true);
        expect(typeof cell.value === 'string' || cell.value === null, `cell ${cell.address}`).toBe(true);
      }),
    );
    expect(cells).toBe(15);
    expect(sheet.getCell(2, 1).value).toBe('42');
    expect(sheet.getCell(2, 3).value).toBe('2026-11-16');
  });

  it('escapes the formula payload: the cell is text with a leading apostrophe', async () => {
    const payload = "=cmd|' /C calc'!A0";
    const sheet = await read(await build(['=HYPERLINK("http://evil")'], [[payload], ['@SUM(A1)'], ['\t=1'], [' =1']]));
    expect(sheet.getCell(1, 1).value).toBe('\'=HYPERLINK("http://evil")');
    expect(sheet.getCell(2, 1).value).toBe(`'${payload}`);
    expect(sheet.getCell(3, 1).value).toBe("'@SUM(A1)");
    expect(sheet.getCell(4, 1).value).toBe("'\t=1");
    expect(sheet.getCell(5, 1).value).toBe("' =1");
    expect(sheet.getCell(2, 1).formula).toBeUndefined();
  });

  it('writes a zip with one worksheet and no formula part', async () => {
    const file = await build(['h'], [['=1+1']]);
    expect(file.subarray(0, 2).toString('latin1')).toBe('PK');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((w) => w.name)).toEqual(['Responses']);
  });

  it('cuts a text that is longer than a cell can hold, never in the middle of a character', () => {
    const long = 'a'.repeat(XLSX_MAX_CELL_CHARS + 10);
    expect(xlsxCell(long)).toHaveLength(XLSX_MAX_CELL_CHARS);
    const astral = `${'a'.repeat(XLSX_MAX_CELL_CHARS - 1)}\u{1F600}tail`;
    const cut = xlsxCell(astral);
    expect(cut).toHaveLength(XLSX_MAX_CELL_CHARS - 1);
    expect(cut.codePointAt(cut.length - 1)).toBe('a'.codePointAt(0));
    expect(xlsxCell('short')).toBe('short');
  });
});
