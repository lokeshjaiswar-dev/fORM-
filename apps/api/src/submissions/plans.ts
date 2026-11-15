import { desc, eq, inArray, sql } from 'drizzle-orm';
import { formVersions, type Tx } from '@form/db';
import { headerOf, valueDefinition } from '@form/registry';
import type { Answers, BlockId, FieldBlock, FormDefinition, ValueFieldType } from '@form/schema';
import { storableText } from '../text-safety.ts';
import { WeightedCache } from '../weighted-cache.ts';
import { exportText, fieldBlocksOf, isProtected, type Taint } from './fields.ts';

/** What a protected value shows as in the grid and the detail: never a prefix, never its length. */
export const MASK = '••••••';

const MAX_LABEL = 200;
const MAX_CELL = 500;
const MAX_DETAIL_VALUE = 10_000;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One field of one version, as the grid and the detail read it. */
export interface PlannedField {
  id: BlockId;
  key: string;
  type: string;
  /** The column label this version gives the field: the registry's export header. */
  label: string;
  /** The answer is masked wherever the server shows it (`isProtected`). */
  masked: boolean;
  block: FieldBlock;
}

/** The fields of a published version in document order, with what is needed to show a response filed under it. */
export interface VersionPlan {
  id: string;
  number: number;
  fields: PlannedField[];
  byId: Map<string, PlannedField>;
}

/** A column of the grid: one per field block id across every version of the form. */
export interface GridColumn {
  id: string;
  key: string;
  label: string;
  type: string;
}

function labelOf(block: FieldBlock): string {
  const def = valueDefinition(block.type as ValueFieldType);
  const columns = (def.export.columns as (b: unknown) => Array<{ header: string }>)(block);
  // A field that exports several columns (a name's parts) is one column of the grid, headed by the field's own label.
  const header = columns.length === 1 ? (columns[0]?.header ?? '') : headerOf(block as never);
  return storableText(clip(header.trim() || block.key, MAX_LABEL));
}

/** The plan of a version from its stored definition and the taint of its compiled plan. */
export function planOf(row: { id: string; number: number; definition: unknown; taint: unknown }): VersionPlan {
  const definition = row.definition as FormDefinition;
  const taint = (row.taint ?? undefined) as Taint | undefined;
  const fields = fieldBlocksOf(definition).map(
    (block): PlannedField => ({
      id: block.id,
      key: storableText(block.key),
      type: block.type,
      label: labelOf(block),
      masked: isProtected(block, definition, taint),
      block,
    }),
  );
  return { id: row.id, number: row.number, fields, byId: new Map(fields.map((f) => [f.id, f])) };
}

/**
 * The columns of the grid: the union of the fields of every version of the form, one column per block id. The label is
 * the newest version's (a field renamed in version 3 is headed by its version 3 name over the answers of version 1 too),
 * and the order is the newest version's, followed by the fields only older versions had, so the answers to a field the
 * form no longer asks stay readable. `plans` are newest first.
 */
export function gridColumns(plans: readonly VersionPlan[]): GridColumn[] {
  const columns = new Map<string, GridColumn>();
  for (const plan of plans) {
    for (const field of plan.fields) {
      if (!columns.has(field.id)) columns.set(field.id, { id: field.id, key: field.key, label: field.label, type: field.type });
    }
  }
  return [...columns.values()];
}

type StoredLike = { type?: unknown; value?: unknown } | undefined;
const answerOf = (answers: Answers | Record<string, unknown>, id: string): StoredLike => (answers as Record<string, StoredLike>)[id];

/**
 * The cells of one grid row, by block id, built on the server from the answers and the version they were filed under
 * (`export.text`): only the fields that were answered, so a row says nothing of a field its version never had. A masked
 * field's cell is `MASK` and its id is listed in `masked`, so the page can tell a hidden value from an empty one.
 */
export function cellsOf(plan: VersionPlan | undefined, answers: Answers | Record<string, unknown>): { cells: Record<string, string>; masked: string[] } {
  const cells: Record<string, string> = {};
  const masked: string[] = [];
  if (!plan) return { cells, masked };
  for (const field of plan.fields) {
    const answer = answerOf(answers, field.id);
    if (!answer) continue;
    if (field.masked) {
      cells[field.id] = MASK;
      masked.push(field.id);
      continue;
    }
    const text = storableText(clip(exportText(field.block, answer.value), MAX_CELL));
    if (text !== '') cells[field.id] = text;
  }
  return { cells, masked };
}

/** A line of the detail: the field's label and its answer as readable text (or `MASK`). */
export interface DetailField {
  id: string;
  key: string;
  label: string;
  type: string;
  value: string;
  masked: boolean;
}

export function detailFieldsOf(plan: VersionPlan | undefined, answers: Answers | Record<string, unknown>): DetailField[] {
  if (!plan) return [];
  const out: DetailField[] = [];
  for (const field of plan.fields) {
    const answer = answerOf(answers, field.id);
    if (!answer) continue;
    out.push({
      id: field.id,
      key: field.key,
      label: field.label,
      type: field.type,
      value: field.masked ? MASK : storableText(clip(exportText(field.block, answer.value), MAX_DETAIL_VALUE)),
      masked: field.masked,
    });
  }
  return out;
}

/**
 * The stored answers with every protected one replaced by `{ type, masked: true }`, and so is any answer the version
 * has no field for, because the server cannot say it is safe. Revealing a value is WP-1.11; until then it does not leave.
 */
export function maskedAnswersOf(plan: VersionPlan | undefined, answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, answer] of Object.entries(answers)) {
    const field = plan?.byId.get(id);
    if (field && !field.masked) {
      out[id] = answer;
      continue;
    }
    const type = (answer as { type?: unknown } | null)?.type;
    out[id] = { type: typeof type === 'string' ? type : (field?.type ?? 'unknown'), masked: true };
  }
  return out;
}

/**
 * Plans of the published versions of forms, kept by version id. A version never changes once published, so a plan never
 * goes stale; only its size bounds the cache. Plans reach the cache only through a query run under the caller's tenant
 * context, and a version id is a uuid no caller is told about except through their own rows, so one org's plan cannot be
 * served to another.
 */
export function createPlanLoader(o: { maxEntries?: number; maxBytes?: number } = {}) {
  const cache = new WeightedCache<VersionPlan>(o.maxEntries ?? 2000, o.maxBytes ?? 32 * 1024 * 1024);

  /** The plans of these versions: from the cache, or loaded now (definition and taint, nothing else of the version). */
  async function plansOf(tx: Tx, ids: readonly string[]): Promise<Map<string, VersionPlan>> {
    const plans = new Map<string, VersionPlan>();
    const missing: string[] = [];
    for (const id of ids) {
      const hit = cache.get(id);
      if (hit) plans.set(id, hit);
      else missing.push(id);
    }
    if (missing.length === 0) return plans;
    const rows = await tx
      .select({ id: formVersions.id, number: formVersions.number, definition: formVersions.definition, taint: sql<unknown>`${formVersions.compiled} -> 'taint'` })
      .from(formVersions)
      .where(inArray(formVersions.id, missing));
    for (const row of rows) {
      const plan = planOf(row);
      plans.set(row.id, plan);
      // The blocks are what the plan holds on to; two bytes a character covers the strings and the object overhead.
      cache.set(row.id, plan, 1024 + JSON.stringify(plan.fields.map((f) => f.block)).length * 2);
    }
    return plans;
  }

  return {
    /** Every version of the form, newest first (version 0, the stand-in for responses of a never-published form, last). */
    async ofForm(tx: Tx, formId: string): Promise<VersionPlan[]> {
      const versions = await tx
        .select({ id: formVersions.id })
        .from(formVersions)
        .where(eq(formVersions.formId, formId))
        .orderBy(desc(formVersions.number));
      const plans = await plansOf(tx, versions.map((v) => v.id));
      return versions.flatMap((v) => {
        const plan = plans.get(v.id);
        return plan ? [plan] : [];
      });
    },

    /** One version, by the id a response is filed under (which came from a row the caller could read). */
    async ofVersion(tx: Tx, versionId: string): Promise<VersionPlan | undefined> {
      return (await plansOf(tx, [versionId])).get(versionId);
    },
  };
}

export type PlanLoader = ReturnType<typeof createPlanLoader>;
