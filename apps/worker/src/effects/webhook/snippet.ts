/*
 * The answer of a receiver, as the delivery log keeps it (WP-1.18; architecture §2.4: `response_snippet` is at most 1 KB,
 * scrubbed of personal data, and nulled after 30 days). A receiver may echo what it was sent ("thanks asha@example.com,
 * phone 9876543210"), so the text that is stored is scrubbed first: the log must not become a second copy of the answers.
 */

/** The column holds at most this many characters (`webhook_deliveries_response_snippet_check`). */
export const MAX_SNIPPET_CHARS = 1024;

/** Anything shaped like an address: something, an `@`, something, up to a quote, bracket, comma or space. Deliberately loose; over-scrubbing costs nothing. */
const EMAIL = /[^\s@"'<>()[\]{},;:/\\]+@[^\s@"'<>()[\]{},;:/\\]+/gu;
/** Six or more digits in a row, also when written with spaces or dashes ("98765 43210", "4111-1111-1111-1111"), in any script. */
const LONG_DIGITS = /\p{Nd}(?:[ -]?\p{Nd}){5,}/gu;
/** Control characters (a NUL cannot be stored in a text column) and any run of white space become one space. */
const WHITE_OR_CONTROL = /[\s\p{Cc}]+/gu;

/**
 * `text` as it may be stored: control characters and runs of white space collapsed, email-like words and long digit runs
 * replaced by `[email]` and `[number]`, then cut to 1024 characters. Scrubbing comes before cutting, so an address cut in
 * half by the limit can never be left behind as a fragment. Null when nothing is left.
 */
export function scrubSnippet(text: string): string | null {
  const scrubbed = text.replace(WHITE_OR_CONTROL, ' ').replace(EMAIL, '[email]').replace(LONG_DIGITS, '[number]').trim();
  if (scrubbed === '') return null;
  return scrubbed.length > MAX_SNIPPET_CHARS ? scrubbed.slice(0, MAX_SNIPPET_CHARS).trimEnd() : scrubbed;
}
