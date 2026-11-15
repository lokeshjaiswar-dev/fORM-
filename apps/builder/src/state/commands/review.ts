import { MAX_REVIEW_UNITS, type FormDefinition, type ReviewUnit, type ReviewUnitId } from '@form/schema';

/*
 * Review units (WP-2.33) are part of the form definition (`FormDefinition.review`): they are versioned with the form,
 * saved with the draft and undone with the rest of the document. Who reviews them (group, order, required, visibility)
 * is not here: that is server state with its own revision (persistence/reviewApi.ts).
 *
 * These are the immer recipes and the checks `dispatch` runs for the three review commands. A unit points at a page or
 * at a `section_break` block; a page that is merged away or a break that is deleted leaves a unit that points at
 * nothing, which the checks in `@form/logic` report as a warning (and refuse at publish) until the author deletes it.
 */

/** The longest unit name the builder takes (the schema takes any string; checkers and respondents read it in a list). */
export const MAX_UNIT_NAME = 120;

const unitOf = (doc: FormDefinition, id: string): ReviewUnit | undefined => doc.review?.units.find((u) => u.id === id);

/** Whether a unit already points at this page or break: one unit per target, because two would hold the same blocks. */
function targetTaken(doc: FormDefinition, target: ReviewUnit['target']): boolean {
  return (doc.review?.units ?? []).some((u) =>
    target.kind === 'page' ? u.target.kind === 'page' && u.target.pageId === target.pageId : u.target.kind === 'section_break' && u.target.blockId === target.blockId,
  );
}

/** What the command needs from the document it applies to; null when it can apply. */
export function reviewPrecondition(
  doc: FormDefinition,
  command:
    | { type: 'add_review_unit'; unit: ReviewUnit }
    | { type: 'rename_review_unit'; id: ReviewUnitId; name: string }
    | { type: 'remove_review_unit'; id: ReviewUnitId },
): string | null {
  switch (command.type) {
    case 'add_review_unit': {
      const { unit } = command;
      if (unitOf(doc, unit.id)) return `review unit '${unit.id}' already exists`;
      if ((doc.review?.units.length ?? 0) >= MAX_REVIEW_UNITS) return `a form has at most ${MAX_REVIEW_UNITS} review units`;
      if (typeof unit.name !== 'string' || unit.name.trim() === '' || unit.name.length > MAX_UNIT_NAME) return `a unit name is 1 to ${MAX_UNIT_NAME} characters`;
      const { target } = unit;
      if (target.kind === 'page' ? !doc.pages.some((p) => p.id === target.pageId) : doc.blocks[target.blockId]?.type !== 'section_break') {
        return target.kind === 'page' ? `no page '${target.pageId}'` : `block '${target.blockId}' is not a section break`;
      }
      return targetTaken(doc, target) ? 'that part of the form already has a review unit' : null;
    }
    case 'rename_review_unit':
      if (!unitOf(doc, command.id)) return `no review unit '${command.id}'`;
      return command.name.trim() === '' || command.name.length > MAX_UNIT_NAME ? `a unit name is 1 to ${MAX_UNIT_NAME} characters` : null;
    case 'remove_review_unit':
      return unitOf(doc, command.id) ? null : `no review unit '${command.id}'`;
  }
}

/** Appends a unit; the first one creates `review`. */
export function addReviewUnit(doc: FormDefinition, unit: ReviewUnit): void {
  if (doc.review) doc.review.units.push(unit);
  else doc.review = { units: [unit] };
}

export function renameReviewUnit(doc: FormDefinition, id: ReviewUnitId, name: string): void {
  const unit = doc.review?.units.find((u) => u.id === id);
  if (unit) unit.name = name;
}

/** Removes a unit; the last one takes `review` with it, so a form without units has the shape it had before there were any. */
export function removeReviewUnit(doc: FormDefinition, id: ReviewUnitId): void {
  if (!doc.review) return;
  doc.review.units = doc.review.units.filter((u) => u.id !== id);
  if (doc.review.units.length === 0) delete doc.review;
}
