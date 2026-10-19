import { z } from 'zod';
import { V1 } from '@form/schema';
import type { FormBlock, FormSchema, FormSettings } from '@/types/form';

/** What a block edit may change: everything but the block's identity, type and position. */
export type BlockPatch = Partial<Omit<FormBlock, 'id' | 'type' | 'order'>>;

/** What happens to rules that read a deleted block (B21): removed, or kept and disabled. */
export type RuleFate = 'remove' | 'disable';

export type BlockSource = { block: FormBlock } | { id: string };

/**
 * Every document change is one of these. Commands are data: new ids come from the dispatch context, so the same
 * command list replays to the same document.
 */
export type Command =
  | { type: 'set_title'; title: string }
  | { type: 'set_description'; description: string }
  | { type: 'update_settings'; patch: Partial<FormSettings> }
  | { type: 'add_block'; block: FormBlock; index: number }
  | { type: 'update_block'; id: string; patch: BlockPatch }
  | { type: 'set_width'; id: string; width: 'full' | 'half' }
  | { type: 'delete_block'; id: string; rules: RuleFate }
  | { type: 'duplicate_block'; id: string }
  | { type: 'move_block'; from: number; to: number }
  | { type: 'place_beside'; hostId: string; source: BlockSource }
  | { type: 'replace_document'; doc: FormSchema };

const index = z.number().int().nonnegative();
const id = z.string().min(1);

/** The command twin: block and document payloads are checked against the strict v1 twins (unknown keys rejected). */
export const CommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('set_title'), title: z.string() }),
  z.strictObject({ type: z.literal('set_description'), description: z.string() }),
  z.strictObject({ type: z.literal('update_settings'), patch: V1.FormSettingsSchema.partial() }),
  z.strictObject({ type: z.literal('add_block'), block: V1.FormBlockSchema, index }),
  z.strictObject({ type: z.literal('update_block'), id, patch: V1.FormBlockSchema.omit({ id: true, type: true, order: true }).partial() }),
  z.strictObject({ type: z.literal('set_width'), id, width: z.enum(['full', 'half']) }),
  z.strictObject({ type: z.literal('delete_block'), id, rules: z.enum(['remove', 'disable']) }),
  z.strictObject({ type: z.literal('duplicate_block'), id }),
  z.strictObject({ type: z.literal('move_block'), from: index, to: index }),
  z.strictObject({
    type: z.literal('place_beside'),
    hostId: id,
    source: z.union([z.strictObject({ block: V1.FormBlockSchema }), z.strictObject({ id })]),
  }),
  z.strictObject({ type: z.literal('replace_document'), doc: V1.FormSchemaSchema }),
]);
