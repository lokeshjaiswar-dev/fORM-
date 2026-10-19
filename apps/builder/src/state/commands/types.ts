import { z } from 'zod';
import {
  BehaviorSchema, BlockIdSchema, BlockSchema, DocumentOpSchema, EndingIdSchema, EndingSchema, FormDefinitionSchema, PageIdSchema, PurposeSchema,
  RichDocSchema, RuleIdSchema, RuleSchema, ThemeSchema,
  type Behavior, type Block, type BlockId, type DocumentOp, type Ending, type EndingId, type FormDefinition, type PageId, type Purpose,
  type RichDoc, type Rule, type RuleId, type Theme,
} from '@form/schema';

/**
 * What a block edit may change: anything but the block's identity and type. A key whose value is `undefined` is
 * removed from the block. The edited block is checked against its strict twin, so a patch can never leave it invalid.
 */
export type BlockPatch = Readonly<Record<string, unknown>>;

/** What happens to rules that read a deleted block (B21): removed, or kept and disabled. */
export type RuleFate = 'remove' | 'disable';

/** A new block may bring the form's first purpose with it (I7), so it is added in the same undoable step. */
export type BlockSource = { block: Block; purpose?: Purpose } | { id: BlockId };

/** A position on a page: the index among the page's top-level blocks. */
export interface PageSlot {
  pageId: PageId;
  index: number;
}

/**
 * Every document change is one of these. Commands are data: new ids come from the dispatch context or the command,
 * so the same command list replays to the same document. `apply_ops` applies template `DocumentOp`s (snippets,
 * BL-085) with the `applyDocumentOps` semantics, as one undoable step.
 */
export type Command =
  | { type: 'set_title'; title: string }
  | { type: 'set_description'; description: RichDoc | null }
  | { type: 'set_theme'; theme: Theme }
  | { type: 'set_behavior'; behavior: Behavior }
  | { type: 'set_endings'; endings: Ending[]; defaultEndingId: EndingId; behavior?: Behavior }
  | { type: 'apply_ops'; ops: DocumentOp[] }
  | { type: 'update_block'; id: BlockId; patch: BlockPatch }
  | { type: 'set_width'; id: BlockId; width: 'full' | 'half' }
  | { type: 'delete_block'; id: BlockId; rules: RuleFate }
  | { type: 'duplicate_block'; id: BlockId }
  | { type: 'paste_block'; block: Block; at: PageSlot; purpose?: Purpose }
  | { type: 'move_block'; id: BlockId; to: PageSlot }
  | { type: 'place_beside'; hostId: BlockId; source: BlockSource }
  | { type: 'split_page'; pageId: PageId; index: number; newPageId: PageId }
  | { type: 'merge_page'; pageId: PageId }
  | { type: 'set_rule'; rule: Rule }
  | { type: 'remove_rule'; id: RuleId }
  | { type: 'replace_document'; doc: FormDefinition };

const index = z.number().int().nonnegative();
const slot = z.strictObject({ pageId: PageIdSchema, index });

/** The command twin: payloads are checked against the strict v2 twins (unknown keys rejected). */
export const CommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('set_title'), title: z.string().max(500) }),
  z.strictObject({ type: z.literal('set_description'), description: RichDocSchema.nullable() }),
  z.strictObject({ type: z.literal('set_theme'), theme: ThemeSchema }),
  z.strictObject({ type: z.literal('set_behavior'), behavior: BehaviorSchema }),
  z.strictObject({ type: z.literal('set_endings'), endings: z.array(EndingSchema).min(1), defaultEndingId: EndingIdSchema, behavior: BehaviorSchema.optional() }),
  z.strictObject({ type: z.literal('apply_ops'), ops: z.array(DocumentOpSchema).min(1) }),
  z.strictObject({ type: z.literal('update_block'), id: BlockIdSchema, patch: z.record(z.string(), z.unknown()) }),
  z.strictObject({ type: z.literal('set_width'), id: BlockIdSchema, width: z.enum(['full', 'half']) }),
  z.strictObject({ type: z.literal('delete_block'), id: BlockIdSchema, rules: z.enum(['remove', 'disable']) }),
  z.strictObject({ type: z.literal('duplicate_block'), id: BlockIdSchema }),
  z.strictObject({ type: z.literal('paste_block'), block: BlockSchema, at: slot, purpose: PurposeSchema.optional() }),
  z.strictObject({ type: z.literal('move_block'), id: BlockIdSchema, to: slot }),
  z.strictObject({
    type: z.literal('place_beside'),
    hostId: BlockIdSchema,
    source: z.union([z.strictObject({ block: BlockSchema, purpose: PurposeSchema.optional() }), z.strictObject({ id: BlockIdSchema })]),
  }),
  z.strictObject({ type: z.literal('split_page'), pageId: PageIdSchema, index, newPageId: PageIdSchema }),
  z.strictObject({ type: z.literal('merge_page'), pageId: PageIdSchema }),
  z.strictObject({ type: z.literal('set_rule'), rule: RuleSchema }),
  z.strictObject({ type: z.literal('remove_rule'), id: RuleIdSchema }),
  z.strictObject({ type: z.literal('replace_document'), doc: FormDefinitionSchema }),
]);
