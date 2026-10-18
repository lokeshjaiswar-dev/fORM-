import { z } from 'zod';
import { DATE_PATTERNS, META_KEYS } from '../rich-text.ts';
import type { ListItemNode } from '../rich-text.ts';
import { guarded, richTextLimitError } from './_util.ts';
import {
  AssetRefSchema, BlockIdSchema, BrandRefSchema, CurrencyCodeSchema, HexColorSchema, SafeHrefSchema, SafeUrlSchema,
  TemplateVariableNameSchema, TextAlignSchema, VariableIdSchema,
} from './primitives.ts';

export const ThemeColorTokenSchema = z.enum(['page', 'surface', 'text', 'muted', 'accent', 'accentText', 'inputBg', 'inputBorder', 'inputText', 'error', 'success']);
export const ColorValueSchema = z.union([HexColorSchema, z.strictObject({ token: ThemeColorTokenSchema }), BrandRefSchema]);

export const MarkSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bold') }),
  z.strictObject({ type: z.literal('italic') }),
  z.strictObject({ type: z.literal('underline') }),
  z.strictObject({ type: z.literal('strike') }),
  z.strictObject({ type: z.literal('code') }),
  z.strictObject({ type: z.literal('link'), attrs: z.strictObject({ href: SafeHrefSchema }) }),
  z.strictObject({ type: z.literal('textColor'), attrs: z.strictObject({ color: ColorValueSchema }) }),
  z.strictObject({ type: z.literal('highlight'), attrs: z.strictObject({ color: ColorValueSchema }) }),
]);

export const MetaKeySchema = z.enum(META_KEYS);
export const AnswerPathSchema = z.string().min(1).max(256);

export const ValueRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('answer'), blockId: BlockIdSchema, path: AnswerPathSchema.exactOptional(), row: z.literal('current').exactOptional() }),
  z.strictObject({ kind: z.literal('variable'), varId: VariableIdSchema }),
  z.strictObject({ kind: z.literal('meta'), key: MetaKeySchema, name: z.string().max(128).exactOptional() }),
]);
export const SubmissionRefSchema = z.strictObject({
  kind: z.literal('submission'),
  key: z.enum(['unique_id', 'submission_id', 'submitted_at', 'edit_url', 'pdf_url', 'form_title', 'withdraw_consent_url', 'resume_url']),
});
export const PipeSourceSchema = z.discriminatedUnion('kind', [ValueRefSchema, SubmissionRefSchema]);

export const DatePatternSchema = z.enum(DATE_PATTERNS);
const hourCycle = z.enum(['h12', 'h23']);
const decimals = z.number().int().min(0).max(10);
const numberFormat = z.strictObject({
  kind: z.literal('number'),
  decimals: decimals.exactOptional(),
  grouping: z.enum(['none', 'indian', 'international']).exactOptional(),
  decimalSeparator: z.enum(['.', ',']).exactOptional(),
  prefix: z.string().max(32).exactOptional(),
  suffix: z.string().max(32).exactOptional(),
});
const moneyFormat = z.strictObject({ kind: z.literal('money'), currency: CurrencyCodeSchema.exactOptional(), grouping: z.enum(['indian', 'international']).exactOptional() });
const percentFormat = z.strictObject({ kind: z.literal('percent'), decimals: decimals.exactOptional() });
/** The number / money / percent subset (NumberConfig.format). */
export const NumericValueFormatSchema = z.discriminatedUnion('kind', [numberFormat, moneyFormat, percentFormat]);
export const ValueFormatSchema = z.discriminatedUnion('kind', [
  numberFormat,
  moneyFormat,
  percentFormat,
  z.strictObject({ kind: z.literal('date'), pattern: DatePatternSchema }),
  z.strictObject({ kind: z.literal('datetime'), pattern: DatePatternSchema, hourCycle }),
  z.strictObject({ kind: z.literal('time'), hourCycle }),
  z.strictObject({ kind: z.literal('option'), show: z.enum(['label', 'code']) }),
  z.strictObject({ kind: z.literal('list'), separator: z.string().max(16) }),
  z.strictObject({ kind: z.literal('text'), transform: z.enum(['none', 'upper', 'lower', 'title']).exactOptional() }),
]);

export const PipeAttrsSchema = z.strictObject({
  source: PipeSourceSchema,
  format: ValueFormatSchema.exactOptional(),
  fallback: z.string().max(1000).exactOptional(),
  encode: z.enum(['none', 'url']).exactOptional(),
});
export const PipeNodeSchema = z.strictObject({ type: z.literal('pipe'), attrs: PipeAttrsSchema });
export const VarNodeSchema = z.strictObject({
  type: z.literal('var'),
  attrs: z.strictObject({ name: TemplateVariableNameSchema, fallback: z.string().max(1000).exactOptional() }),
});

export const TextNodeSchema = z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(50_000), marks: z.array(MarkSchema).max(16).exactOptional() });
export const HardBreakNodeSchema = z.strictObject({ type: z.literal('hardBreak') });
export const InlineNodeSchema = z.discriminatedUnion('type', [TextNodeSchema, HardBreakNodeSchema, PipeNodeSchema, VarNodeSchema]);

export const ParagraphNodeSchema = z.strictObject({
  type: z.literal('paragraph'),
  attrs: z.strictObject({ align: TextAlignSchema.exactOptional() }).exactOptional(),
  content: z.array(InlineNodeSchema).exactOptional(),
});
export const HeadingNodeSchema = z.strictObject({
  type: z.literal('heading'),
  attrs: z.strictObject({ level: z.literal([1, 2, 3]), align: TextAlignSchema.exactOptional() }),
  content: z.array(InlineNodeSchema).exactOptional(),
});
/* The list nodes recurse; the exported node schemas below run the rich-text limits first. */
const ListItemLazy: z.ZodType<ListItemNode> = z.lazy(() => ListItemNodeShape);
const BulletListNode = z.strictObject({ type: z.literal('bulletList'), content: z.array(ListItemLazy).min(1) });
const OrderedListNode = z.strictObject({
  type: z.literal('orderedList'),
  attrs: z.strictObject({ start: z.number().int().min(0).exactOptional() }).exactOptional(),
  content: z.array(ListItemLazy).min(1),
});
const ListItemNodeShape = z.strictObject({
  type: z.literal('listItem'),
  content: z.array(z.discriminatedUnion('type', [ParagraphNodeSchema, BulletListNode, OrderedListNode])).min(1),
});
export const ListItemNodeSchema = guarded(richTextLimitError, ListItemNodeShape);
export const BulletListNodeSchema = guarded(richTextLimitError, BulletListNode);
export const OrderedListNodeSchema = guarded(richTextLimitError, OrderedListNode);
export const BlockquoteNodeSchema = z.strictObject({ type: z.literal('blockquote'), content: z.array(ParagraphNodeSchema).min(1) });
export const HorizontalRuleNodeSchema = z.strictObject({ type: z.literal('horizontalRule') });
export const ImageNodeSchema = z.strictObject({
  type: z.literal('image'),
  attrs: z.strictObject({
    asset: z.union([AssetRefSchema, BrandRefSchema]),
    widthPct: z.number().min(1).max(100).exactOptional(),
    align: TextAlignSchema.exactOptional(),
    href: SafeUrlSchema.exactOptional(),
  }),
});

const RichBlockNode = z.discriminatedUnion('type', [
  ParagraphNodeSchema, HeadingNodeSchema, BulletListNode, OrderedListNode, BlockquoteNodeSchema, HorizontalRuleNodeSchema, ImageNodeSchema,
]);
export const RichBlockNodeSchema = guarded(richTextLimitError, RichBlockNode);

const RichDocShape = z.strictObject({ type: z.literal('doc'), content: z.array(RichBlockNode) });
const InlineDocShape = z.strictObject({ type: z.literal('doc'), content: z.tuple([ParagraphNodeSchema]) });
/** ≤ 20k nodes, depth ≤ 8, lists nested ≤ 3, checked before the recursive parse. */
export const RichDocSchema = guarded(richTextLimitError, RichDocShape);
/** Exactly one paragraph. */
export const InlineDocSchema = guarded(richTextLimitError, InlineDocShape);

export const PlainTemplateSchema = z.array(z.union([
  z.string(),
  z.strictObject({ pipe: PipeAttrsSchema }),
  z.strictObject({ var: VarNodeSchema.shape.attrs }),
])).max(64);
export const LabelTextSchema = z.union([z.string(), PlainTemplateSchema]);
