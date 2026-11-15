import { escapeCell } from './escape.ts';
import type { ByteSink, TableWriter } from './table.ts';

/*
 * CSV for exports (WP-1.17): RFC 4180 (CRLF line ends, a field in double quotes when it holds a quote, a comma or a line
 * break, a quote inside it doubled), UTF-8 with a byte-order mark so that Excel reads Devanagari and Tamil as such and not
 * as Windows-1252. Every cell goes through `escapeCell` here, in the one place that writes the format, so a caller cannot
 * forget it.
 */

/** The UTF-8 byte-order mark (U+FEFF) that opens the file. */
export const CSV_BOM = String.fromCharCode(0xfeff);

const NEEDS_QUOTES = /[",\r\n]/;

/** One field, escaped against formula injection and quoted when RFC 4180 needs it. */
export function csvField(cell: string): string {
  const safe = escapeCell(cell);
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One record with its line end (CRLF). */
export function csvLine(cells: readonly string[]): string {
  return `${cells.map(csvField).join(',')}\r\n`;
}

const encoder = new TextEncoder();

/** A CSV writer over a sink: the BOM and the header first, then each batch as one chunk. */
export function createCsvWriter(sink: ByteSink): TableWriter {
  return {
    async start(headers) {
      await sink.write(encoder.encode(CSV_BOM + csvLine(headers)));
    },
    async rows(rows) {
      if (rows.length === 0) return;
      await sink.write(encoder.encode(rows.map(csvLine).join('')));
    },
    async finish() {},
  };
}
