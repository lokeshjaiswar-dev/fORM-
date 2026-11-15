import type { FormDefinition, StoredBlock } from '@form/schema';
import { blockText } from '@/lib/definition';

/*
 * A block-level comparison of two drafts of one form, for the merge dialog (WP-1.06). With no common ancestor the
 * comparison is "yours against theirs": a block is only in one draft, or in both with different content. Form-level
 * parts (title, pages, logic, theme and so on) are compared whole and named, not diffed.
 */

/** Same JSON value, whatever the key order: the server's JSONB does not keep the order a draft was written in. */
export function sameDefinition(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameDefinition(item, b[i]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const others = Object.keys(right).filter((key) => right[key] !== undefined);
  return keys.length === others.length && keys.every((key) => key in right && sameDefinition(left[key], right[key]));
}

/** A block that differs, named the way the author knows it: its label (or text) and its type. */
export interface BlockDiff {
  id: string;
  label: string;
  type: string;
}

/** The parts of a form outside its blocks that can differ. */
export const FORM_PARTS = ['title', 'pages', 'endings', 'logic', 'privacy', 'theme', 'behavior', 'i18n', 'other'] as const;
export type FormPart = (typeof FORM_PARTS)[number];

export interface DraftDiff {
  /** Blocks in your draft that the saved draft does not have. */
  onlyMine: BlockDiff[];
  /** Blocks in the saved draft that yours does not have. */
  onlyTheirs: BlockDiff[];
  /** Blocks in both whose content differs. */
  changed: BlockDiff[];
  /** The form-level parts that differ. */
  form: FormPart[];
  /** True when the two drafts are the same document. */
  identical: boolean;
}

const describe = (id: string, block: StoredBlock | undefined): BlockDiff => ({ id, label: blockText(block), type: block?.type ?? '' });

/** Form-level keys that are not part of what the author edits, or are compared as blocks. */
const IGNORED = new Set(['blocks', 'formId', 'schemaVersion', 'revision']);
const KNOWN = new Set<string>(FORM_PARTS);

export function diffDrafts(mine: FormDefinition, theirs: FormDefinition): DraftDiff {
  const a = mine.blocks as Record<string, StoredBlock>;
  const b = theirs.blocks as Record<string, StoredBlock>;
  const onlyMine = Object.keys(a)
    .filter((id) => !(id in b))
    .map((id) => describe(id, a[id]));
  const onlyTheirs = Object.keys(b)
    .filter((id) => !(id in a))
    .map((id) => describe(id, b[id]));
  const changed = Object.keys(a)
    .filter((id) => id in b && !sameDefinition(a[id], b[id]))
    .map((id) => describe(id, a[id]));

  const left = mine as unknown as Record<string, unknown>;
  const right = theirs as unknown as Record<string, unknown>;
  const form = new Set<FormPart>();
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (IGNORED.has(key) || sameDefinition(left[key], right[key])) continue;
    form.add(KNOWN.has(key) ? (key as FormPart) : 'other');
  }
  const parts = FORM_PARTS.filter((part) => form.has(part));
  return { onlyMine, onlyTheirs, changed, form: parts, identical: !onlyMine.length && !onlyTheirs.length && !changed.length && !parts.length };
}
