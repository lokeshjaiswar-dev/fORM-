import type { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import { escapeCell } from './escape.ts';
import { ExportFailure, type TableWriter } from './table.ts';

/*
 * XLSX for exports (WP-1.17), written with exceljs's streaming workbook writer: a row is committed as soon as it is added,
 * so a large export holds one batch in memory, not the sheet. Every cell is written as a string (never a number, a date or
 * a formula), after `escapeCell`, so the file holds exactly the text the answers read as and a spreadsheet never evaluates one.
 */

/** Rows a worksheet can hold (Excel's limit), the header row included. */
export const XLSX_MAX_ROWS = 1_048_576;

/** Characters a cell can hold (Excel's limit); a longer text is cut, because Excel refuses to open a file with a longer one. */
export const XLSX_MAX_CELL_CHARS = 32_767;

const SHEET_NAME = 'Responses';

/** The cell as written: escaped against formula injection, then cut at Excel's limit (never in the middle of a surrogate pair). */
export function xlsxCell(value: string): string {
  const safe = escapeCell(value);
  if (safe.length <= XLSX_MAX_CELL_CHARS) return safe;
  let end = XLSX_MAX_CELL_CHARS;
  const last = safe.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return safe.slice(0, end);
}

/** An XLSX writer over a Node writable (the upload's stream): one worksheet, `Responses`, headed by the header row. */
export function createXlsxWriter(out: Writable): TableWriter {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: false, useSharedStrings: false });
  workbook.creator = 'fORM-';
  const sheet = workbook.addWorksheet(SHEET_NAME);
  let written = 0;

  const add = (cells: readonly string[]): void => {
    if (written >= XLSX_MAX_ROWS) {
      throw new ExportFailure('xlsx_row_limit', 'A spreadsheet holds at most 1,048,575 responses. Export to CSV, or choose a date range.');
    }
    sheet.addRow(cells.map(xlsxCell)).commit();
    written += 1;
  };

  return {
    async start(headers) {
      add(headers);
    },
    async rows(rows) {
      for (const row of rows) add(row);
      // Let the zip stream take what was committed before the next batch is read.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async finish() {
      sheet.commit();
      await workbook.commit();
    },
  };
}
