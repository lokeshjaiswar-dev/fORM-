import { inArray, sql } from 'drizzle-orm';
import { formVersions, isUuid, reviewerScope, type TenantCtx, type Tx } from '@form/db';
import { visibleBlocksForReviewer } from '@form/logic';
import type { BlockId, CompiledForm, ReviewGroupId, ReviewSettings } from '@form/schema';
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
