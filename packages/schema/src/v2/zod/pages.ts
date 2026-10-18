import { z } from 'zod';
import {
  AssetRefSchema, BlockIdSchema, BrandRefSchema, EndingIdSchema, FieldKeySchema, FormIdSchema, OriginSchema, PageIdSchema, PdfTemplateIdSchema,
} from './primitives.ts';
import { LabelTextSchema, PipeSourceSchema, PlainTemplateSchema, RichDocSchema } from './rich-text.ts';

const label = z.string().max(200);

export const PageSchema = z.strictObject({
  id: PageIdSchema,
  title: LabelTextSchema.exactOptional(),
  children: z.array(BlockIdSchema),
  nav: z.strictObject({
    nextLabel: LabelTextSchema.exactOptional(),
    backLabel: LabelTextSchema.exactOptional(),
    showBack: z.boolean().exactOptional(),
    showNext: z.boolean().exactOptional(),
  }).exactOptional(),
  initiallyHidden: z.boolean().exactOptional(),
  origin: OriginSchema.exactOptional(),
});

export const EndingActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fill_again'), label: label.exactOptional(), prefill: z.union([z.literal('none'), z.strictObject({ carryKeys: z.array(FieldKeySchema) })]) }),
  z.strictObject({ kind: z.literal('download_pdf'), label: label.exactOptional(), pdfTemplateId: PdfTemplateIdSchema.exactOptional() }),
  z.strictObject({ kind: z.literal('edit_submission'), label: label.exactOptional() }),
  z.strictObject({ kind: z.literal('visit_url'), label, url: PlainTemplateSchema }),
  z.strictObject({
    kind: z.literal('open_form'),
    label,
    formId: FormIdSchema,
    prefill: z.array(z.strictObject({ toKey: FieldKeySchema, from: PipeSourceSchema })).exactOptional(),
  }),
]);

export const EndingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: EndingIdSchema,
    kind: z.literal('message'),
    name: label,
    content: RichDocSchema,
    actions: z.array(EndingActionSchema),
    confetti: z.boolean().exactOptional(),
    origin: OriginSchema.exactOptional(),
  }),
  z.strictObject({
    id: EndingIdSchema,
    kind: z.literal('redirect'),
    name: label,
    url: PlainTemplateSchema,
    delayMs: z.number().int().min(0).max(60_000).exactOptional(),
    message: RichDocSchema.exactOptional(),
    origin: OriginSchema.exactOptional(),
  }),
]);

export const WelcomeScreenSchema = z.strictObject({
  enabled: z.boolean(),
  content: RichDocSchema,
  image: z.union([AssetRefSchema, BrandRefSchema]).exactOptional(),
  startLabel: label.exactOptional(),
});
