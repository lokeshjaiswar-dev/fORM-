import type { Answers, BlockId, FormDefinition } from '@form/schema';
import { draftWith, fieldBlock } from '../../test/publishable-draft.ts';

/*
 * Forms and answers for the submissions tests (unit and integration): a definition with plain, encrypted and sensitive
 * fields and a repeating group, built the way the builder stores them, so the tests exercise the real registry.
 */

export const FORM_ID = '0b9c1f5e-3d1a-4a64-9d51-0d1d3b2f6a10';

type Block = ReturnType<typeof fieldBlock>;

const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }] });

/** The block with a label of its own, which the grid shows as its column header. */
export const labelled = (block: Block, text: string): Block => ({ ...block, label: doc(text) });

/** The block as a sensitive field: classified `sensitive`, which forces `encrypt` (schema §3: "forced true for sensitive"). */
export const sensitive = (block: Block): Block => ({
  ...block,
  compliance: { ...block.compliance, classification: 'sensitive', category: 'government_id', encrypt: true, allowPrefill: false, inNotifications: 'mask', inExports: 'mask', purposeIds: ['pur_1'] },
});

/** The block as a personal field that is encrypted at rest and not otherwise sensitive. */
export const encrypted = (block: Block): Block => ({ ...block, compliance: { ...block.compliance, classification: 'personal', encrypt: true, purposeIds: ['pur_1'] } });

/** A repeating group of the given child blocks (the children are blocks of the definition, not placed on a page). */
export const group = (id: string, children: readonly string[]): Block =>
  ({
    ...labelled(fieldBlock(id, 'short_text'), id),
    type: 'repeating_group',
    config: { children, minRows: 0, maxRows: 5, initialRows: 1, layout: 'stacked' },
  }) as unknown as Block;

/** A definition with `top` placed on its page and `children` only reachable through a group's `config.children`. */
export function definitionOf(top: readonly Block[], children: readonly Block[] = [], formId = FORM_ID): FormDefinition {
  const base = draftWith(formId, [...top, ...children]);
  return { ...base, pages: [{ ...base.pages[0]!, children: top.map((b) => b.id) }] } as unknown as FormDefinition;
}

/** Answers by block id: `answers({ name: ['short_text', 'Asha'] })`. */
export function answers(byBlock: Record<string, [type: string, value: unknown]>): Answers {
  return Object.fromEntries(Object.entries(byBlock).map(([id, [type, value]]) => [id as BlockId, { type, value }])) as unknown as Answers;
}

export { fieldBlock };
