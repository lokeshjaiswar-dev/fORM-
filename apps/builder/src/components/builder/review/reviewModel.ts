import { defineMessages } from '@form/i18n';
import { reviewUnitIssues, reviewUnitMembership } from '@form/logic';
import type {
  BlockId, FormDefinition, ReviewGroupId, ReviewSettings, ReviewUnit, ReviewUnitAssignment, ReviewUnitId, ReviewVisibility, StoredBlock,
} from '@form/schema';
import { t } from '@/i18n';
import { blockOrder, blockText } from '@/lib/definition';

/*
 * What the Review tab shows about a form's review units (WP-2.33), as pure functions of the definition: the pages and
 * section breaks a unit can be made from, what a unit covers (exactly what `reviewUnitMembership` says, which is what the
 * server will use), and the problems the checks in `@form/logic` find, in words for the author. Also the working copy of the
 * server-side assignments (group, order, required, visibility) and what is wrong with it before it is saved.
 */

const M = defineMessages('builder', {
  'review.page': 'Page {n}',
  'review.page_titled': 'Page {n}: {title}',
  'review.break': 'Section break: {name}',
  'review.break_unnamed': 'Section break',
  'review.target_gone': 'A page or section break that is no longer in the form',
  'review.block_untitled': 'Untitled {type}',
  'review.issue_empty': 'This unit covers no questions, so there is nothing to check. Add fields to it, or delete the unit. The form cannot be published like this.',
  'review.issue_overlap': 'This unit shares questions with {others}. A question can belong to only one unit. The form cannot be published like this.',
  'review.issue_overlap_unknown': 'This unit shares questions with another unit. A question can belong to only one unit. The form cannot be published like this.',
  'review.issue_payment': 'This unit covers a payment. A payment is not approved or rejected by a checker. The form cannot be published like this.',
  'review.issue_dangling': 'The page or section break this unit was made from is no longer in the form. Delete the unit, or add one for the part you want checked. The form cannot be published like this.',
  'review.problem_group_gone': 'This unit’s group no longer exists or is archived. Choose another group.',
});

/** What a unit can be made from: a page or a section break that no unit points at yet. */
export interface TargetOption {
  /** `page:<id>` or `break:<id>`: what the picker holds. */
  value: string;
  label: string;
  target: ReviewUnit['target'];
  /** The name a new unit starts with; the author renames it. */
  name: string;
}

/** The text of a unit's name: a name is plain text (the schema refuses answer pipes); a template shows only its text parts. */
export const nameText = (name: ReviewUnit['name']): string => (typeof name === 'string' ? name : name.map((part) => (typeof part === 'string' ? part : '')).join(''));

function pageLabel(def: FormDefinition, index: number): string {
  const title = nameText(def.pages[index]?.title ?? '').trim();
  return title ? t(M['review.page_titled'], { n: index + 1, title }) : t(M['review.page'], { n: index + 1 });
}

function breakName(block: StoredBlock | undefined): string {
  return block?.type === 'section_break' ? block.config.name.trim() : '';
}

/** Where a unit points, in words; `gone` when the page or break is no longer in the form. */
export function describeTarget(def: FormDefinition, target: ReviewUnit['target']): { label: string; gone: boolean } {
  if (target.kind === 'page') {
    const index = def.pages.findIndex((p) => p.id === target.pageId);
    return index < 0 ? { label: t(M['review.target_gone']), gone: true } : { label: pageLabel(def, index), gone: false };
  }
  const block = def.blocks[target.blockId];
  if (block?.type !== 'section_break') return { label: t(M['review.target_gone']), gone: true };
  const name = breakName(block);
  return { label: name ? t(M['review.break'], { name }) : t(M['review.break_unnamed']), gone: false };
}

/** The pages and section breaks that have no review unit yet, in document order (pages first, then breaks). */
export function targetOptions(def: FormDefinition): TargetOption[] {
  const units = def.review?.units ?? [];
  const usedPages = new Set(units.flatMap((u) => (u.target.kind === 'page' ? [u.target.pageId] : [])));
  const usedBreaks = new Set(units.flatMap((u) => (u.target.kind === 'section_break' ? [u.target.blockId] : [])));
  const pages = def.pages.flatMap((page, index): TargetOption[] =>
    usedPages.has(page.id) ? [] : [{ value: `page:${page.id}`, label: pageLabel(def, index), target: { kind: 'page', pageId: page.id }, name: nameText(page.title ?? '').trim() || t(M['review.page'], { n: index + 1 }) }],
  );
  const breaks = blockOrder(def).flatMap((id): TargetOption[] => {
    const block = def.blocks[id];
    if (block?.type !== 'section_break' || usedBreaks.has(id)) return [];
    const name = breakName(block);
    return [{ value: `break:${id}`, label: name ? t(M['review.break'], { name }) : t(M['review.break_unnamed']), target: { kind: 'section_break', blockId: id }, name: name || t(M['review.break_unnamed']) }];
  });
  return [...pages, ...breaks];
}

/** A block in a unit's list: what the author typed as its label, else its type. */
export function blockLabel(block: StoredBlock | undefined): string {
  if (!block) return '';
  if (block.type === 'section_break') return breakName(block) || t(M['review.break_unnamed']);
  return blockText(block) || t(M['review.block_untitled'], { type: block.type });
}

/** The blocks each unit covers, as `reviewUnitMembership` returns them, with the label each is shown by. */
export function unitBlocks(def: FormDefinition): Record<string, Array<{ id: BlockId; label: string }>> {
  const membership = reviewUnitMembership(def);
  return Object.fromEntries(Object.entries(membership).map(([unitId, ids]) => [unitId, (ids ?? []).map((id) => ({ id, label: blockLabel(def.blocks[id]) }))]));
}

/** A problem with a unit, in words. `code` is the check's own code. */
export interface UnitProblem {
  code: string;
  message: string;
}

/**
 * The problems of each unit by unit id, from the same checks that refuse the publish (`reviewUnitIssues`), worded for the
 * author. The author sees them while editing, as warnings; at publish they are errors.
 */
export function unitProblems(def: FormDefinition): Record<string, UnitProblem[]> {
  const units = def.review?.units ?? [];
  if (units.length === 0) return {};
  const membership = reviewUnitMembership(def);
  const nameOf = new Map<string, string>(units.map((u) => [u.id, nameText(u.name).trim() || u.id]));
  const out: Record<string, UnitProblem[]> = {};
  for (const issue of reviewUnitIssues(def, 'save')) {
    const at = /^\/review\/units\/(\d+)(?:\/|$)/.exec(issue.path);
    const unit = at ? units[Number(at[1])] : undefined;
    if (!unit) continue;
    let message: string;
    switch (issue.code) {
      case 'review_unit_empty':
        message = t(M['review.issue_empty']);
        break;
      case 'review_unit_contains_payment':
        message = t(M['review.issue_payment']);
        break;
      case 'review_unit_dangling_target':
        message = t(M['review.issue_dangling']);
        break;
      case 'review_unit_overlap': {
        const mine = new Set(membership[unit.id] ?? []);
        const others = units
          .filter((u) => u.id !== unit.id && (membership[u.id] ?? []).some((id) => mine.has(id)))
          .map((u) => `“${nameOf.get(u.id) ?? u.id}”`);
        message = others.length ? t(M['review.issue_overlap'], { others: others.join(', ') }) : t(M['review.issue_overlap_unknown']);
        break;
      }
      default:
        message = issue.message;
    }
    (out[unit.id] ??= []).push({ code: issue.code, message });
  }
  return out;
}

/* ─── The assignments: who checks each unit (server state, edited here, saved with `If-Match`) ─── */

export const DEFAULT_VISIBILITY: ReviewVisibility = 'own_unit';

/** What a unit gets when its group is first chosen: checked first, required, and the checker sees that unit only. */
export const newAssignment = (unitId: string, groupId: string): ReviewUnitAssignment => ({
  unitId: unitId as ReviewUnitId,
  groupId: groupId as ReviewGroupId,
  order: 1,
  required: true,
  visibility: DEFAULT_VISIBILITY,
});

export const assignmentOf = (settings: ReviewSettings, unitId: string): ReviewUnitAssignment | undefined => settings.units.find((a) => a.unitId === unitId);

/** `settings` with the assignment of `unitId` replaced by `next`, added when there was none, or removed when `next` is null. */
export function withAssignment(settings: ReviewSettings, unitId: string, next: ReviewUnitAssignment | null): ReviewSettings {
  const rest = settings.units.filter((a) => a.unitId !== unitId);
  const at = settings.units.findIndex((a) => a.unitId === unitId);
  if (next === null) return { ...settings, units: rest };
  const units = at < 0 ? [...rest, next] : settings.units.map((a, i) => (i === at ? next : a));
  return { ...settings, units };
}

/** Whether two settings differ. Assignments compare by unit, so the order of the list is no change. */
export function isChanged(a: ReviewSettings, b: ReviewSettings): boolean {
  const key = (s: ReviewSettings) =>
    JSON.stringify([s.enabled, s.distinctCheckers, [...s.units].sort((x, y) => (x.unitId < y.unitId ? -1 : x.unitId > y.unitId ? 1 : 0)).map((u) => [u.unitId, u.groupId, u.order, u.required, u.visibility])]);
  return key(a) !== key(b);
}

/** Assignments of units the open draft has no unit for: the live version may still use them, so a save sends them back unchanged. */
export const orphansOf = (settings: ReviewSettings, def: FormDefinition): ReviewUnitAssignment[] => {
  const known = new Set((def.review?.units ?? []).map((u) => u.id as string));
  return settings.units.filter((a) => !known.has(a.unitId));
};

/**
 * What stops a save, by unit id: a group that is gone or archived (the server refuses it). `groups` is null when the list
 * could not be read; then groups are not judged. (The order cannot be wrong here: the field sends it only when it is a whole
 * number of 1 or more.)
 */
export function assignmentProblems(settings: ReviewSettings, def: FormDefinition, groups: ReadonlySet<string> | null): Record<string, string> {
  const known = new Set((def.review?.units ?? []).map((u) => u.id as string));
  const out: Record<string, string> = {};
  for (const a of settings.units) {
    if (!known.has(a.unitId)) continue;
    if (groups !== null && !groups.has(a.groupId)) out[a.unitId] = t(M['review.problem_group_gone']);
  }
  return out;
}

/** Where in the sent `units` list a 400's field path points (`body/units/2/groupId` is 2); null for any other path. */
const positionOf = (path: string): number | null => {
  const m = /^body\/units\/(\d+)(?:\/|$)/.exec(path);
  return m ? Number(m[1]) : null;
};

/**
 * The settings without the assignments of units that are not in the open draft, when those are all the server refused: a
 * unit that was in an earlier published version and is in no version now has nothing left to be assigned to. Null when the
 * refusal is about anything else, so it is shown to the author instead of being worked around.
 */
export function withoutRefusedOrphans(settings: ReviewSettings, def: FormDefinition, fields: ReadonlyArray<{ path: string }>): ReviewSettings | null {
  if (fields.length === 0) return null;
  const orphans = new Set(orphansOf(settings, def).map((a) => a.unitId as string));
  const drop = new Set<number>();
  for (const field of fields) {
    const at = positionOf(field.path);
    const assignment = at === null ? undefined : settings.units[at];
    if (at === null || !assignment || !orphans.has(assignment.unitId)) return null;
    drop.add(at);
  }
  return { ...settings, units: settings.units.filter((_, i) => !drop.has(i)) };
}
