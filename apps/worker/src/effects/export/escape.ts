/*
 * Formula-injection escaping for exported cells (WP-1.17, OWASP "CSV Injection"). A spreadsheet reads a cell that starts
 * with `=`, `+`, `-` or `@` as a formula, and `=cmd|' /C calc'!A0` as a command, so an answer a respondent typed (or a
 * form label its owner typed) could run code on the machine of whoever opens the file. The fix is a leading apostrophe:
 * spreadsheets read it as "this is text" and show the rest as typed.
 */

/** The characters a spreadsheet treats as the start of a formula. */
const FORMULA_START = new Set(['=', '+', '-', '@']);

/** A tab or a carriage return as the first character: OWASP lists both, because some importers treat them as a formula lead-in. */
const CONTROL_START = new Set(['\t', '\r']);

/** Invisible characters a spreadsheet skips as well: DEL, the zero-width space, the word joiner and the byte-order mark. */
const INVISIBLE = new Set([0x7f, 0x200b, 0x2060, 0xfeff]);

const WHITE_SPACE = /\s/u;

/** White space, control characters (C0) and the invisible ones above: what may sit before a formula character and not stop it being one. */
function isSkipped(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x20 || INVISIBLE.has(code) || WHITE_SPACE.test(char);
}

/**
 * The cell as it may be written to a CSV or XLSX file: unchanged unless it starts (after any leading white space) with a
 * formula character, or starts with a tab or a carriage return, in which case it gets a leading apostrophe. Plain text,
 * digits without a sign and non-Latin scripts pass through byte for byte.
 */
export function escapeCell(value: string): string {
  if (value === '') return value;
  if (CONTROL_START.has(value.charAt(0))) return `'${value}`;
  let at = 0;
  while (at < value.length && isSkipped(value.charAt(at))) at += 1;
  return FORMULA_START.has(value.charAt(at)) ? `'${value}` : value;
}
