/**
 * The runtime half of "no answer values in audit metadata" (architecture §2.7); the lint rule
 * `form-audit/no-answer-values` (tools/lint/audit-plugin.js) is the static half and uses the same key list.
 * Keys that name answer containers are dropped at any depth and listed under `_scrubbed`; long strings, deep
 * nesting and oversized metadata are replaced, never truncated, so no prefix of a value leaks.
 */
export const ANSWER_KEYS: readonly string[] = [
  'answer',
  'answers',
  'value',
  'values',
  'response',
  'responses',
  'payload',
  'data',
  'field',
  'fields',
  'fieldvalues',
  'input',
  'inputs',
  'prefill',
  'submission',
  'submissiondata',
  'body',
  'content',
  'plaintext',
  'decrypted',
  'raw',
];

const ANSWER_KEY_SET = new Set(ANSWER_KEYS);
export const MAX_METADATA_STRING = 1024;
export const MAX_METADATA_DEPTH = 4;
export const MAX_METADATA_ITEMS = 1000;
export const MAX_METADATA_BYTES = 16 * 1024;

/** `submissionData`, `submission_data` and `Submission-Data` all name the same thing. */
export const isAnswerKey = (key: string): boolean => ANSWER_KEY_SET.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Postgres text and jsonb refuse NUL, and JCS refuses lone surrogates: both become U+FFFD so the chain never wedges. */
export const storableText = (s: string): string => s.replaceAll(NUL, REPLACEMENT).replace(LONE_SURROGATE, REPLACEMENT);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function scrubAuditMetadata(metadata: unknown): Record<string, Json> {
  const scrubbed: string[] = [];

  const walk = (v: unknown, path: string, depth: number): Json | undefined => {
    if (v === null) return null;
    switch (typeof v) {
      case 'boolean':
        return v;
      case 'number':
        return Number.isFinite(v) ? v : null;
      case 'bigint':
        return v.toString();
      case 'string':
        return v.length > MAX_METADATA_STRING ? `[omitted: ${v.length} chars]` : storableText(v);
      case 'object':
        break;
      default:
        return undefined;
    }
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (depth >= MAX_METADATA_DEPTH) {
      scrubbed.push(path);
      return '[omitted: too deep]';
    }
    if (Array.isArray(v)) {
      const items = v.slice(0, MAX_METADATA_ITEMS).map((x, i) => walk(x, `${path}[${i}]`, depth + 1) ?? null);
      if (v.length > MAX_METADATA_ITEMS) items.push(`[omitted: ${v.length - MAX_METADATA_ITEMS} more]`);
      return items;
    }
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === '_scrubbed') continue;
      const p = path ? `${path}.${k}` : k;
      if (isAnswerKey(k)) {
        scrubbed.push(p);
        continue;
      }
      const w = walk(x, p, depth + 1);
      if (w !== undefined) out[storableText(k)] = w;
    }
    return out;
  };

  const isObject = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata);
  const root = isObject ? walk(metadata, '', 0) : {};
  const out = (root ?? {}) as Record<string, Json>;
  // A second pass (the chain worker re-scrubs) keeps the paths the first one removed.
  const earlier = isObject ? (metadata as Record<string, unknown>)._scrubbed : undefined;
  const paths = [...(Array.isArray(earlier) ? earlier.filter((p): p is string => typeof p === 'string').slice(0, 100) : []), ...scrubbed];
  if (paths.length > 0) out._scrubbed = paths.map(storableText);
  if (new TextEncoder().encode(JSON.stringify(out)).byteLength > MAX_METADATA_BYTES) return { _omitted: 'metadata over 16 KiB' };
  return out;
}
