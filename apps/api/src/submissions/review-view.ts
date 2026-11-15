import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { formVersions, isUuid, reviewerScope, submissionReviews, type ReviewState, type TenantCtx, type Tx } from '@form/db';
import { visibleBlocksForReviewer } from '@form/logic';
import { plainLabelText, type BlockId, type CompiledForm, type ReviewGroupId, type ReviewSettings } from '@form/schema';
import { storableText } from '../text-safety.ts';
import { WeightedCache } from '../weighted-cache.ts';

/*
 * What the responses API shows a person who is acting as a reviewer of a form (WP-2.33, decision "own_unit redaction scope"):
 *
 *   - `reviewerViewOf` says whether the caller is redacted: they sit in a review group that the form's live settings assign
 *     a unit of, with `own_unit` visibility, whatever their role (an owner or admin in such a group is redacted too). Anyone
 *     else, a member of no review group included, sees the whole response.
 *   - `redaction.visibility` gives, per form version, the blocks such a caller may see (`visibleBlocksForReviewer`, the same
 *     function the review screens and the export use). Every answer, display row, grid cell and file of another block is
 *     removed before the response is serialised. A block the function does not know is hidden by default.
 *   - `reviewSummaries` gives each response its review state, unit by unit: the unit's name and its state, and nothing else
 *     (no group, no checker, no round, no answer).
 *
 * Everything reads through the caller's tenant transaction, so row-level security limits it to their org.
 */

/** The review scope of the caller on one form. */
export interface ReviewerView {
  /** The form's live review settings, or null when the form was never set up for review (then no response has review rows). */
  settings: ReviewSettings | null;
  /** The review groups of the caller that the settings assign a unit of this form to. */
  groupIds: readonly string[];
  /** The caller sees only the blocks of their own units. */
  redacted: boolean;
}

/**
 * Whether, and how, the caller reviews `formId`. A settings row that no longer parses is an error (`reviewerScope`'s own),
 * not "no review": a reader that treated it as unreviewed would show a checker every unit's answers.
 */
export async function reviewerViewOf(tx: Tx, tenant: Pick<TenantCtx, 'userId'>, formId: string): Promise<ReviewerView> {
  const userId = tenant.userId;
  if (!userId || !isUuid(userId)) return { settings: null, groupIds: [], redacted: false };
  const scope = await reviewerScope(tx, { formId, userId });
  const groups = new Set(scope.groupIds);
  const redacted = scope.settings !== null && scope.settings.units.some((a) => groups.has(a.groupId) && a.visibility === 'own_unit');
  return { settings: scope.settings, groupIds: scope.groupIds, redacted };
}

/** The blocks a caller may see in a response filed under one version: a set, or null for all of them. */
export interface Visibility {
  of(versionId: string): ReadonlySet<BlockId> | null;
}

/** For a caller who is not redacted. */
export const SEES_ALL: Visibility = { of: () => null };

/** Keeps an answer, cell, row or file of `blockId` unless the caller may not see that block. */
export const mayShow = (visible: ReadonlySet<BlockId> | null, blockId: string): boolean => visible === null || visible.has(blockId as BlockId);

/** The parts of a compiled form that decide what a reviewer sees. */
type Scoping = Pick<CompiledForm, 'documentOrder' | 'reviewUnits' | 'plan' | 'reads'>;

const isScoping = (value: unknown): value is Scoping => {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v['documentOrder']) && Array.isArray(v['plan']) && v['reads'] !== null && typeof v['reads'] === 'object';
};

/**
 * Loads the compiled parts a version needs and works out the visible blocks. A version never changes once published, so
 * what is read of it is kept (bounded by weight) by version id, the same argument as the plan loader: a version id reaches
 * it only through a row the caller could read under their own tenant context.
 */
export function createRedactionLoader(o: { maxEntries?: number; maxBytes?: number } = {}) {
  const cache = new WeightedCache<Scoping>(o.maxEntries ?? 500, o.maxBytes ?? 16 * 1024 * 1024);

  async function scopingOf(tx: Tx, ids: readonly string[]): Promise<Map<string, Scoping>> {
    const found = new Map<string, Scoping>();
    const missing: string[] = [];
    for (const id of ids) {
      const hit = cache.get(id);
      if (hit) found.set(id, hit);
      else missing.push(id);
    }
    if (missing.length === 0) return found;
    const rows = await tx
      .select({
        id: formVersions.id,
        scoping: sql<unknown>`jsonb_build_object('documentOrder', ${formVersions.compiled} -> 'documentOrder', 'reviewUnits', ${formVersions.compiled} -> 'reviewUnits', 'plan', ${formVersions.compiled} -> 'plan', 'reads', ${formVersions.compiled} -> 'reads')`,
      })
      .from(formVersions)
      .where(inArray(formVersions.id, missing));
    for (const row of rows) {
      // A version with no compiled plan (a legacy stand-in, `compiled` '{}') cannot be scoped: it is left out, and so hidden.
      if (!isScoping(row.scoping)) continue;
      found.set(row.id, row.scoping);
      cache.set(row.id, row.scoping, 1024 + JSON.stringify(row.scoping).length * 2);
    }
    return found;
  }

  return {
    /**
     * What `view` may see of a response filed under each of `versionIds`. Works for a redacted caller only: anyone else gets
     * `SEES_ALL` without a read. A version that cannot be scoped shows nothing, so the answer of an unknown form shape is
     * never shown by mistake.
     */
    async visibility(tx: Tx, view: ReviewerView, versionIds: Iterable<string>): Promise<Visibility> {
      if (!view.redacted || view.settings === null) return SEES_ALL;
      const ids = [...new Set(versionIds)];
      const scopings = await scopingOf(tx, ids);
      const settings = view.settings;
      const sets = new Map<string, ReadonlySet<BlockId> | null>();
      return {
        of(versionId) {
          if (sets.has(versionId)) return sets.get(versionId) ?? null;
          const scoping = scopings.get(versionId);
          // `null` is the function's own "nothing is hidden from this caller", which for a redacted caller it never says; an unscoped version is not that: it shows nothing.
          const shown = scoping === undefined ? new Set<BlockId>() : visibleBlocksForReviewer(scoping, settings, view.groupIds as ReviewGroupId[]);
          sets.set(versionId, shown);
          return shown;
        },
      };
    },
  };
}

export type RedactionLoader = ReturnType<typeof createRedactionLoader>;

/** One review unit of a response, as the list and the detail show it: its name and where it stands. */
export interface ReviewUnitSummary {
  name: string;
  state: ReviewState;
}

/** `{ review }` for a response that was held for review, and nothing for any other: its key is absent, as it was before review existed. */
export const reviewOf = (summaries: ReadonlyMap<string, ReviewUnitSummary[]>, id: string): { review?: ReviewUnitSummary[] } => {
  const review = summaries.get(id);
  return review ? { review } : {};
};

const MAX_UNIT_NAME = 200;

/** The name of a unit from the definition: plain text, with whatever is not text left out (a unit name pipes nothing, the zod twin refuses it). */
function unitNameOf(name: unknown): string {
  const text = plainLabelText(name as Parameters<typeof plainLabelText>[0]).trim();
  return storableText(text.length > MAX_UNIT_NAME ? `${text.slice(0, MAX_UNIT_NAME - 1)}…` : text);
}

/**
 * The review of each of these responses of one form, unit by unit, in the order of the units in the version the response
 * was filed under (a unit the version does not name goes last, by its review order). Responses that were never held for
 * review are absent from the result. The names come from the response's own version, which is what the checker was shown.
 *
 * Nothing is read for a form with no review settings row: a review is opened from those settings, the table has no delete,
 * and the grid of a form that never had review (the common case) pays for no extra query.
 */
export async function reviewSummaries(
  tx: Tx,
  view: Pick<ReviewerView, 'settings'>,
  orgId: string,
  formId: string,
  rows: ReadonlyArray<{ id: string; receivedAt: Date; formVersionId: string }>,
): Promise<Map<string, ReviewUnitSummary[]>> {
  const out = new Map<string, ReviewUnitSummary[]>();
  if (view.settings === null || rows.length === 0) return out;
  const times = rows.map((r) => r.receivedAt.getTime());
  const reviews = await tx
    .select({ submissionId: submissionReviews.submissionId, unitId: submissionReviews.unitId, state: submissionReviews.state, order: submissionReviews.reviewOrder })
    .from(submissionReviews)
    .where(
      and(
        eq(submissionReviews.orgId, orgId),
        eq(submissionReviews.formId, formId),
        inArray(submissionReviews.submissionId, rows.map((r) => r.id)),
        // The partition key: lets the planner skip the months with no row of this page.
        gte(submissionReviews.submissionReceivedAt, new Date(Math.min(...times))),
        lte(submissionReviews.submissionReceivedAt, new Date(Math.max(...times))),
      ),
    );
  if (reviews.length === 0) return out;

  const versionOf = new Map(rows.map((r) => [r.id, r.formVersionId]));
  const versionIds = [...new Set(reviews.flatMap((r) => versionOf.get(r.submissionId) ?? []))];
  const defined = await tx
    .select({ id: formVersions.id, units: sql<unknown>`${formVersions.definition} #> '{review,units}'` })
    .from(formVersions)
    .where(inArray(formVersions.id, versionIds));
  const names = new Map<string, Map<string, { name: string; index: number }>>();
  for (const v of defined) {
    const units = Array.isArray(v.units) ? (v.units as Array<{ id?: unknown; name?: unknown }>) : [];
    names.set(
      v.id,
      new Map(units.flatMap((u, index) => (typeof u.id === 'string' ? [[u.id, { name: unitNameOf(u.name), index }] as const] : []))),
    );
  }

  const grouped = new Map<string, Array<{ unitId: string; state: ReviewState; order: number }>>();
  for (const r of reviews) {
    const list = grouped.get(r.submissionId);
    if (list) list.push(r);
    else grouped.set(r.submissionId, [r]);
  }
  for (const [submissionId, units] of grouped) {
    const defs = names.get(versionOf.get(submissionId) ?? '');
    const rank = (unitId: string) => defs?.get(unitId)?.index ?? Number.MAX_SAFE_INTEGER;
    units.sort((a, b) => rank(a.unitId) - rank(b.unitId) || a.order - b.order || (a.unitId < b.unitId ? -1 : 1));
    // A unit the version no longer names is shown by its id: a state without a name would say nothing.
    out.set(submissionId, units.map((u) => ({ name: defs?.get(u.unitId)?.name ?? storableText(u.unitId), state: u.state })));
  }
  return out;
}
