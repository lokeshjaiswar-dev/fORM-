import type { ReviewUnitId } from '@form/schema';
import { APP_IDS } from '@/lib/definition';
import { dispatch, type CommandResult } from '@/state/commands/dispatch';
import type { TargetOption } from '@/components/builder/review/reviewModel';

/*
 * What the Review tab does to the form definition, each as one undoable step (the units are part of the draft, so they
 * are saved with it and undone with it). Who reviews them is server state and is not here.
 */

/** Makes a review unit from a page or a section break; the id is new, the name starts as the page's or break's own. */
export function addUnit(option: TargetOption): CommandResult {
  return dispatch({ type: 'add_review_unit', unit: { id: APP_IDS.newId() as ReviewUnitId, name: option.name, target: option.target } });
}

/** Typing in the name coalesces into one history step. */
export const renameUnit = (id: string, name: string): CommandResult => dispatch({ type: 'rename_review_unit', id: id as ReviewUnitId, name });

export const removeUnit = (id: string): CommandResult => dispatch({ type: 'remove_review_unit', id: id as ReviewUnitId });
