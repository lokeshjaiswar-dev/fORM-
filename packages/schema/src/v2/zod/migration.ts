import { z } from 'zod';
import { keyed } from './_util.ts';
import { FormSchemaSchema as V1FormSchemaSchema } from '../../v1.ts';
import { FormDefinitionSchema } from './definition.ts';
import { FormOpsSchema } from './ops.ts';
import { HolidayCalendarIdSchema, IsoDateSchema, IsoInstantSchema, LocaleSchema, TimeZoneSchema } from './primitives.ts';

/* §18 */

export const AnyFormDocumentSchema = z.union([FormDefinitionSchema, V1FormSchemaSchema]);

export const MigrationNoteSchema = z.object({
  path: z.string(),
  code: z.enum([
    'html_sanitised', 'logic_value_unmatched', 'logic_operator_changed', 'logic_rule_disabled', 'dangling_logic_source',
    'password_extracted', 'key_generated', 'external_asset_queued', 'redirect_dropped', 'unsafe_pattern_dropped',
    'empty_trailing_page_removed', 'duplicate_option_value', 'clamped', 'required_disabled_resolved',
    'default_purpose_added', 'compliance_defaulted', 'initially_hidden_set', 'aadhaar_truncated',
  ]),
  detail: z.string(),
});

export const V1MigrationResultSchema = z.object({
  definition: FormDefinitionSchema,
  ops: FormOpsSchema.pick({ access: true, retention: true }),
  plaintextPasswordToHash: z.string().exactOptional(),
  assetImports: z.array(z.object({ target: z.enum(['logo', 'cover']), url: z.string() })),
  notes: z.array(MigrationNoteSchema),
});

/* §19 */

export const EvalMetaSchema = z.object({
  now: IsoInstantSchema,
  timeZone: TimeZoneSchema,
  locale: LocaleSchema,
  urlParams: keyed(z.record(z.string(), z.string())).readonly(),
  device: z.enum(['desktop', 'tablet', 'mobile']).exactOptional(),
  pageUrl: z.string().exactOptional(),
  referrer: z.string().exactOptional(),
  embedOrigin: z.string().exactOptional(),
  isPreview: z.boolean(),
  holidayCalendars: keyed(z.partialRecord(HolidayCalendarIdSchema, z.array(IsoDateSchema))).readonly().exactOptional(),
  shuffleSeed: z.string().min(1),
});
