import type { Answers, FormDefinition } from '@form/schema';
import { storableText } from '../text-safety.ts';
import { exportText, fieldBlocksOf, isProtected, type Taint } from './fields.ts';

/** The part of a published version the search document needs: what the fields are, and which derived values are tainted. */
export interface SearchableVersion {
  definition: FormDefinition;
  compiled?: { taint?: Taint | undefined } | undefined;
}

/**
 * The text of a response that the full-text index may hold: one string per answered field, as the field type's export
 * reads it. Only what is safe to search is in it (WP-1.15, architecture §2.4: "non-sensitive, non-tainted answers"):
 *
 * - no `encrypt` or `sensitive` field, so searching a PAN or a health answer finds nothing (those are searched through
 *   blind indexes, WP-1.11), and the index never holds ciphertext either way;
 * - no value derived from a sensitive one (`compiled.taint`, I13), or a calculation could carry it into the index;
 * - no repeating group with a protected field among its children, because the group's text is its rows' text.
 *
 * `version` is the published version the answers were validated against; `values` are those validated answers. The
 * submit pipeline (WP-1.12) calls this, in the same transaction as the INSERT, and passes the strings to the `SearchIndex`
 * as `SearchDocument.text`.
 */
export function searchDocFor(version: SearchableVersion, values: Answers): string[] {
  const taint = version.compiled?.taint;
  const out: string[] = [];
  for (const block of fieldBlocksOf(version.definition)) {
    const answer = (values as Record<string, { value?: unknown } | undefined>)[block.id];
    // An answer that is an encrypted envelope has no `value`: skipped by the check below even for a field that is not
    // protected in this definition.
    if (!answer || !('value' in answer) || isProtected(block, version.definition, taint)) continue;
    const text = storableText(exportText(block, answer.value));
    if (text !== '') out.push(text);
  }
  return out;
}
