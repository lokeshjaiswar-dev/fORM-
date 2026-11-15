import { jsonPointer, sha256Jcs } from '@form/schema';
import type { BlockId, CompiledForm, EvalState, FormDefinition, PageId, PublishIssue, ReviewGroupId, ReviewSettings, ReviewUnitId, Sha256Hex } from '@form/schema';
import { placementOf, type Placement } from './structure.ts';

/*
 * Review units (WP-2.33, schema §13.1): which blocks a unit covers, whether a unit can be used, and the pure helpers the
 * API builds the maker-checker flow on. Everything here is a function of the definition (or its compiled form) and the
 * data passed in: no clock, no randomness, no I/O, so Node and the browsers agree (determinism corpus).
 */

type Mode = 'save' | 'publish';
type UnitBlocks = Partial<Record<ReviewUnitId, BlockId[]>>;

/** What a unit's blocks are, and why the unit cannot be used when it cannot. */
interface UnitScan {
  index: number;
  id: ReviewUnitId;
  blocks: BlockId[];
  /** Set when the target is not in the form: the unit holds nothing and is reported as dangling. */
  dangling?: { path: string; message: string };
  /** The `section_break` block that opens the unit (it is a member, but a unit holding only it is empty). */
  marker?: BlockId;
}

/** Blocks of every page, in document order (a page's nested children included). */
function blocksByPage(placement: Placement): Map<PageId, BlockId[]> {
  const out = new Map<PageId, BlockId[]>();
  for (const id of placement.documentOrder) {
    const page = placement.pageOf[id];
    if (page === undefined) continue;
    const list = out.get(page);
    if (list) list.push(id);
    else out.set(page, [id]);
  }
  return out;
}

function scanUnits(def: FormDefinition, placement: Placement): UnitScan[] {
  const units = def.review?.units ?? [];
  if (!units.length) return [];
  const byPage = blocksByPage(placement);
  const position = new Map<string, number>(placement.documentOrder.map((id, i) => [id, i]));
  /* Every section_break in the form closes the unit before it, whether or not a unit targets it. */
  const breaks = placement.documentOrder.flatMap((id, i) => (def.blocks[id]?.type === 'section_break' ? [i] : []));
  return units.map((unit, index): UnitScan => {
    const at = (...rest: Array<string | number>) => jsonPointer('review', 'units', index, 'target', ...rest);
    const { target } = unit;
    if (target.kind === 'page') {
      if (!placement.pageIndex.has(target.pageId)) {
        return { index, id: unit.id, blocks: [], dangling: { path: at('pageId'), message: `review unit '${unit.id}' targets page '${target.pageId}', which does not exist` } };
      }
      return { index, id: unit.id, blocks: byPage.get(target.pageId) ?? [] };
    }
    const from = position.get(target.blockId);
    if (def.blocks[target.blockId]?.type !== 'section_break' || from === undefined) {
      const why = def.blocks[target.blockId] === undefined ? 'does not exist'
        : def.blocks[target.blockId]?.type !== 'section_break' ? 'is not a section break' : 'is not placed on any page';
      return { index, id: unit.id, blocks: [], dangling: { path: at('blockId'), message: `review unit '${unit.id}' targets block '${target.blockId}', which ${why}` } };
    }
    const next = breaks.find((i) => i > from);
    return { index, id: unit.id, blocks: placement.documentOrder.slice(from, next ?? placement.documentOrder.length), marker: target.blockId };
  });
}

/** What `checkReviewUnits` found: the issues, and the units that passed every check with the blocks they cover. */
export interface ReviewUnitCheck {
  issues: PublishIssue[];
  valid: UnitBlocks;
}

/**
 * The review checks behind `reviewUnitIssues` and `compile()`. Issues are errors at publish and warnings in a draft;
 * in a draft the units that fail are dropped from `valid`, so the preview and the compiled plan never break on one.
 */
export function checkReviewUnits(def: FormDefinition, mode: Mode, placement: Placement = placementOf(def)): ReviewUnitCheck {
  const scans = scanUnits(def, placement);
  if (!scans.length) return { issues: [], valid: {} };
  const severity = mode === 'publish' ? 'error' : 'warning';
  const bad = new Set<number>();
  const issues: PublishIssue[] = [];
  const report = (scan: UnitScan, code: PublishIssue['code'], path: string, message: string) => {
    issues.push({ severity, code, path, message });
    bad.add(scan.index);
  };

  const firstIndex = new Map<string, number>();
  const claimed = new Map<BlockId, UnitScan[]>();
  for (const scan of scans) {
    const first = firstIndex.get(scan.id);
    if (first !== undefined) {
      report(scan, 'duplicate_id', jsonPointer('review', 'units', scan.index, 'id'), `review unit id '${scan.id}' is already used by unit ${first + 1}`);
      continue;
    }
    firstIndex.set(scan.id, scan.index);
    if (scan.dangling) {
      report(scan, 'review_unit_dangling_target', scan.dangling.path, scan.dangling.message);
      continue;
    }
    for (const id of scan.blocks) {
      const list = claimed.get(id);
      if (list) list.push(scan);
      else claimed.set(id, [scan]);
    }
  }

  for (const scan of scans) {
    if (bad.has(scan.index)) continue;
    const target = jsonPointer('review', 'units', scan.index, 'target');
    if (scan.blocks.every((id) => id === scan.marker)) {
      report(scan, 'review_unit_empty', target, `review unit '${scan.id}' holds no blocks`);
      continue;
    }
    const payment = scan.blocks.find((id) => def.blocks[id]?.type === 'payment');
    if (payment !== undefined) {
      report(scan, 'review_unit_contains_payment', target, `review unit '${scan.id}' holds the payment block '${payment}'; a payment is not approved or rejected by a checker`);
      continue;
    }
    const shared = scan.blocks.find((id) => (claimed.get(id)?.length ?? 0) > 1);
    if (shared !== undefined) {
      const other = claimed.get(shared)?.find((s) => s.index !== scan.index);
      report(scan, 'review_unit_overlap', target, `review unit '${scan.id}' and unit '${other?.id ?? ''}' both hold block '${shared}'; a block belongs to at most one unit`);
    }
  }

  /* fromEntries defines own properties, so a unit id such as '__proto__' (a draft is not zod-parsed) stays a key. */
  const valid: UnitBlocks = Object.fromEntries(scans.filter((scan) => !bad.has(scan.index)).map((scan) => [scan.id, scan.blocks]));
  return { issues, valid };
}

/**
 * The blocks each review unit covers, in document order, for every unit of `def.review` whatever its problems
 * (a dangling unit holds nothing). A `page` unit holds that page's blocks and their nested children; a `section_break`
 * unit holds the break and every block after it up to, not including, the next `section_break` in document order,
 * across pages. For a unit that overlaps another this is what it would hold; `compile()` leaves such a unit out.
 */
export function reviewUnitMembership(def: FormDefinition): UnitBlocks {
  const seen = new Set<string>();
  const entries: Array<[ReviewUnitId, BlockId[]]> = [];
  for (const scan of scanUnits(def, placementOf(def))) {
    if (seen.has(scan.id)) continue;
    seen.add(scan.id);
    entries.push([scan.id, scan.blocks]);
  }
  return Object.fromEntries(entries);
}

/**
 * `review_unit_empty`, `review_unit_overlap`, `review_unit_contains_payment`, `review_unit_dangling_target` (and
 * `duplicate_id` for a repeated unit id). Errors in 'publish' mode, warnings in 'save' mode.
 */
export const reviewUnitIssues = (def: FormDefinition, mode: Mode): PublishIssue[] => checkReviewUnits(def, mode).issues;

export type ReviewUnitApplicability = 'applicable' | 'not_applicable';

/**
 * Which units this submission has to be reviewed in: a unit is `not_applicable` when none of its blocks is visible,
 * which is the case when every one is hidden or sits on a page the respondent's path never reached
 * (`EvalState.visible` holds a block only when it, its ancestors and its page are shown). Sorted by unit id, because the
 * compiled record is stored as jsonb, which does not keep key order.
 */
export function applicableUnits(compiled: Pick<CompiledForm, 'reviewUnits'>, state: Pick<EvalState, 'visible'>): Array<{ unitId: ReviewUnitId; state: ReviewUnitApplicability }> {
  const units = compiled.reviewUnits ?? {};
  return Object.keys(units).sort().map((unitId) => ({
    unitId: unitId as ReviewUnitId,
    state: (units[unitId as ReviewUnitId] ?? []).some((id) => state.visible.has(id)) ? 'applicable' : 'not_applicable',
  }));
}

/**
 * sha256 of the canonical JSON (RFC 8785) of the unit's stored answers: `{ [blockId]: answer }` for the unit's blocks that
 * have one. Key order does not matter, an answer outside the unit does not count, and an unanswered block is absent (I9).
 * A decision records it, and a decision made against an older hash is stale. `null` when the compiled form has no such unit.
 */
export function reviewUnitAnswersHash(
  compiled: Pick<CompiledForm, 'reviewUnits'>,
  unitId: ReviewUnitId,
  answers: Readonly<Partial<Record<BlockId, unknown>>>,
): Sha256Hex | null {
  const units = compiled.reviewUnits;
  const blocks = units !== undefined && Object.hasOwn(units, unitId) ? units[unitId] : undefined;
  if (blocks === undefined) return null;
  return sha256Jcs(Object.fromEntries(blocks.filter((id) => Object.hasOwn(answers, id) && answers[id] !== undefined).map((id) => [id, answers[id]])));
}

/**
 * The blocks a checker may see, or `null` when nothing is hidden from them (schema §13.1).
 *
 * `own_unit` redaction applies to anyone in a review group assigned to an `own_unit` unit of this form, whatever their
 * role: they see the blocks of the units assigned to their groups plus every block outside all units. Anyone else,
 * including a checker whose groups are all `whole_submission`, is not redacted. When one person holds both kinds,
 * `own_unit` wins. Assignments for units this compiled form does not hold are ignored. A caller drops answers whose
 * block is not in the returned set, so a block this function does not know is hidden by default.
 */
export function visibleBlocksForReviewer(
  compiled: Pick<CompiledForm, 'documentOrder' | 'reviewUnits'>,
  settings: Pick<ReviewSettings, 'units'>,
  callerGroupIds: Iterable<ReviewGroupId>,
): ReadonlySet<BlockId> | null {
  const units = compiled.reviewUnits ?? {};
  const groups = new Set(callerGroupIds);
  const mine = settings.units.filter((a) => groups.has(a.groupId) && Object.hasOwn(units, a.unitId));
  if (!mine.some((a) => a.visibility === 'own_unit')) return null;
  const allowed = new Set<BlockId>(mine.flatMap((a) => units[a.unitId] ?? []));
  const inSomeUnit = new Set<BlockId>(Object.values(units).flatMap((blocks) => blocks ?? []));
  return new Set(compiled.documentOrder.filter((id) => allowed.has(id) || !inSomeUnit.has(id)));
}
