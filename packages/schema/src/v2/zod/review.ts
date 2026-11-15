import { z } from 'zod';
import type { ReviewGroupId, ReviewUnitId } from '../ids.ts';
import { REVIEW_REASON_CODES, REVIEW_VISIBILITIES } from '../review.ts';
import { BlockIdSchema, PageIdSchema, isOpaqueId } from './primitives.ts';
import { LabelTextSchema } from './rich-text.ts';

/** A form holds at most this many review units, and its settings at most this many assignments (bounds the membership work). */
export const MAX_REVIEW_UNITS = 200;

export const ReviewUnitIdSchema = z.custom<ReviewUnitId>(isOpaqueId, { message: 'invalid ReviewUnitId' });
export const ReviewGroupIdSchema = z.custom<ReviewGroupId>(isOpaqueId, { message: 'invalid ReviewGroupId' });

/** Pages and section breaks only. A `section` container target is refused until WP-2.09's single section model. */
export const ReviewUnitTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('page'), pageId: PageIdSchema }),
  z.strictObject({ kind: z.literal('section_break'), blockId: BlockIdSchema }),
]);

/** A unit name reaches checkers and respondents who may not see every answer, so it may not pipe one in. */
const hasPipe = (label: string | unknown[]): boolean => Array.isArray(label) && label.some((part) => typeof part === 'object' && part !== null && 'pipe' in part);
const ReviewUnitNameSchema = LabelTextSchema.refine((label) => !hasPipe(label), { message: 'a review unit name cannot pipe an answer' });

export const ReviewUnitSchema = z.strictObject({
  id: ReviewUnitIdSchema,
  name: ReviewUnitNameSchema,
  target: ReviewUnitTargetSchema,
});

export const FormReviewDefinitionSchema = z.strictObject({
  units: z.array(ReviewUnitSchema).max(MAX_REVIEW_UNITS),
});

export const ReviewReasonCodeSchema = z.enum(REVIEW_REASON_CODES);
export const ReviewVisibilitySchema = z.enum(REVIEW_VISIBILITIES);

export const ReviewUnitAssignmentSchema = z.strictObject({
  unitId: ReviewUnitIdSchema,
  groupId: ReviewGroupIdSchema,
  order: z.number().int().min(1),
  required: z.boolean(),
  visibility: ReviewVisibilitySchema,
});

export const ReviewSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  distinctCheckers: z.boolean(),
  units: z.array(ReviewUnitAssignmentSchema).max(MAX_REVIEW_UNITS),
});

/** The respondent-facing part of a definition's review: ids and names, never targets (`PublicFormDefinition.review`). */
export const PublicFormReviewSchema = z.strictObject({
  units: z.array(ReviewUnitSchema.pick({ id: true, name: true })).max(MAX_REVIEW_UNITS),
});
