import type { BlockId, PageId, ReviewGroupId, ReviewUnitId } from './ids.ts';
import type { LabelText } from './rich-text.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §13.1  REVIEW UNITS (WP-2.33, WFL-09): section-level maker-checker review
 *        The units live in the definition (versioned with the form); who reviews them lives in the
 *        server-stored ReviewSettings (live, revisioned, audited; there is no FormOps table to hold it yet).
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * What a unit covers. A `page` unit holds that page's blocks, nested children included. A `section_break` unit runs from
 * that break up to the next `section_break` in document order, across pages (§13.1 in 02-form-schema-v2.md).
 * `section` container targets wait for WP-2.09's single section model: the zod twin refuses them today.
 */
export type ReviewUnitTarget =
  | { kind: 'page'; pageId: PageId }
  | { kind: 'section_break'; blockId: BlockId };

/** One part of the form that a checker approves or rejects on its own. Unit ids are unique within a form. */
export interface ReviewUnit {
  id: ReviewUnitId;
  /**
   * Shown to reviewers and, in plain words, to the respondent. Static text: the zod twin refuses answer pipes, because a
   * name that piped an answer would carry another unit's value to a checker who may not see it.
   */
  name: LabelText;
  target: ReviewUnitTarget;
}

/** `FormDefinition.review`. Absent means the form has no review units. */
export interface FormReviewDefinition { units: ReviewUnit[] }

/** Why a checker rejected a unit. A fixed catalogue: free-text notes wait for the submission key (WP-1.11). */
export const REVIEW_REASON_CODES = ['incomplete', 'incorrect', 'missing_document', 'duplicate', 'other'] as const;
export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];

/**
 * What a checker sees of the submission: only the blocks of the units assigned to their groups (`own_unit`), or all of
 * it (`whole_submission`). `own_unit` wins when a checker holds both kinds.
 */
export const REVIEW_VISIBILITIES = ['own_unit', 'whole_submission'] as const;
export type ReviewVisibility = (typeof REVIEW_VISIBILITIES)[number];

/** Who reviews one unit, and how. Units with the same `order` are reviewed in parallel; a higher `order` waits for the lower ones. */
export interface ReviewUnitAssignment {
  unitId: ReviewUnitId;
  groupId: ReviewGroupId;
  /** ≥ 1. */
  order: number;
  /** A required unit must be approved (or not applicable) before the submission is final. */
  required: boolean;
  visibility: ReviewVisibility;
}

/**
 * The live review setup of one form, stored on the server (`form_review_settings`), never in a FormVersion and not part
 * of FormOps (there is no FormOps table). `unitId`s name units of the form's published definition.
 */
export interface ReviewSettings {
  enabled: boolean;
  /** One checker may decide at most one unit of a submission. */
  distinctCheckers: boolean;
  units: ReviewUnitAssignment[];
}
