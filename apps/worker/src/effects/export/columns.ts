import { visibleBlocksForReviewer } from '@form/logic';
import { headerOf, valueDefinition } from '@form/registry';
import type { BlockId, CompiledForm, FieldBlock, FormDefinition, ReviewGroupId, ReviewSettings, StoredBlock, ValueFieldType } from '@form/schema';
import { disclosableFields, formPurposeIds, MASK, type DisclosableField } from '../disclosure.ts';

/*
 * The columns of an export and the cells of each response (WP-1.17 EXP-01). Which answers may leave is decided by
 * `disclosableFields` (channel `export`), the one place the notification and webhook paths use as well; this file adds
 * what is particular to a file with one row per response:
 *
 *  - The columns are the union over every version of the form, so the answers to a field the form no longer asks stay
 *    in the file. The newest version that has a field decides its columns (header, order, and whether it is exported at
 *    all): a field marked `omit` in the current version is not in the file for the responses of older versions either.
 *  - A response is read under the version it was filed under, and its own version's verdict applies as well: a field that
 *    version omitted is blank, one it masked is `MASK`, and one the newest version masks is `MASK` for older responses too.
 *  - Reviewer redaction (decision "own_unit redaction scope"): when the person who asked is acting as a reviewer on the form
 *    with `own_unit` visibility, the columns of blocks outside their units are dropped, per version, using the same
 *    `visibleBlocksForReviewer` as the review screens.
 */

/** The two columns every export starts with. English for now: localised headers are BL-043. */
export const FIXED_HEADERS = ['Response ID', 'Received at'] as const;

export interface ExportVersion {
  id: string;
  number: number;
  definition: FormDefinition;
  compiled: CompiledForm;
}

/** The review scope of the person who asked (`reviewerScope`): the live settings and the groups of theirs assigned a unit of the form. */
export interface ExportReviewer {
  settings: Pick<ReviewSettings, 'units'>;
  groupIds: readonly string[];
}

export interface ExportPlanInput {
  /** Every version of the form, in any order. */
  versions: readonly ExportVersion[];
  /** `exports.include_sensitive`: shows the fields that would be `MASK`; never one that is omitted. */
  includeSensitive: boolean;
  /** Set when the requester is a reviewer of the form; null or undefined for anyone else. */
  reviewer?: ExportReviewer | null | undefined;
}

/** A response as the export reads it: ids, its version and its stored answers. */
export interface ExportResponse {
  id: string;
  receivedAt: Date;
  formVersionId: string;
  answers: Readonly<Record<string, unknown>>;
}

export interface ExportRow {
  /** One cell per header, unescaped (the writers escape). */
  cells: string[];
  /** The keys of the fields whose value is in this row: what the disclosures row names. A masked field is not one. */
  fieldKeys: string[];
}

export interface ExportPlan {
  headers: string[];
  /** The number of field columns (headers minus the two fixed ones). */
  fieldColumns: number;
  rowOf(response: ExportResponse): ExportRow;
}

interface ColumnSpec {
  suffix: string;
  header: string;
}

const isField = (block: StoredBlock | undefined): block is FieldBlock => block !== undefined && 'compliance' in block;

const childrenOf = (block: StoredBlock | undefined): readonly BlockId[] =>
  block && (block.type === 'section' || block.type === 'repeating_group') ? block.config.children : [];

/** The placed field blocks of a definition in document order (the same walk as `disclosableFields`). */
function placedFields(definition: FormDefinition): FieldBlock[] {
  const out: FieldBlock[] = [];
  const seen = new Set<BlockId>();
  const visit = (id: BlockId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const block = definition.blocks[id];
    if (isField(block)) out.push(block);
    childrenOf(block).forEach(visit);
  };
  for (const page of definition.pages) page.children.forEach(visit);
  return out;
}

/** The columns the registry gives a field; a field whose config the registry cannot read is one column headed by its label. */
function columnsOf(block: FieldBlock): ColumnSpec[] {
  try {
    const columns = (valueDefinition(block.type as ValueFieldType).export.columns as (b: unknown) => ColumnSpec[])(block);
    if (columns.length > 0) return columns.map((c) => ({ suffix: c.suffix, header: c.header }));
  } catch {
    // fall through to the single column
  }
  return [{ suffix: '', header: headerOf(block as never) }];
}

interface VersionInfo {
  version: ExportVersion;
  purposeIds: string[];
  /** Every placed field block of the version, in document order. */
  placed: FieldBlock[];
  /** The blocks of this version the requester may see, or null for all of them (no redaction). */
  visible: ReadonlySet<BlockId> | null;
  /** The blocks this version exports at all: not omitted, not out of purpose, and visible to the requester. */
  allowed: Set<BlockId>;
  /** The suffixes of each field's export columns in this version, in the order its cells come. */
  suffixes: Map<BlockId, string[]>;
}

function describe(version: ExportVersion, o: Pick<ExportPlanInput, 'includeSensitive' | 'reviewer'>): VersionInfo {
  const { definition, compiled } = version;
  const purposeIds = formPurposeIds(definition);
  const placed = placedFields(definition);
  const visible = o.reviewer ? (visibleBlocksForReviewer(compiled, o.reviewer.settings, o.reviewer.groupIds as ReviewGroupId[]) as ReadonlySet<BlockId> | null) : null;
  // With no answers `disclosableFields` lists exactly the fields it would ever show: the ones that are not omitted or out of purpose.
  const shown = disclosableFields({ definition, compiled, answers: {}, purposeIds, channel: 'export', includeSensitive: o.includeSensitive });
  const allowed = new Set<BlockId>(shown.map((f) => f.blockId).filter((id) => visible === null || visible.has(id)));
  const suffixes = new Map<BlockId, string[]>(placed.map((b) => [b.id, columnsOf(b).map((c) => c.suffix)]));
  return { version, purposeIds, placed, visible, allowed, suffixes };
}

/** One field of the file: its columns and the version whose settings govern them. */
interface PlanField {
  blockId: BlockId;
  key: string;
  governing: VersionInfo;
  columns: ColumnSpec[];
}

/**
 * The plan of an export: the headers, and a function that makes the cells of one response. Pure: it reads nothing from the
 * database, so the job can build it once from the form's versions and run it over every batch.
 */
export function buildExportPlan(input: ExportPlanInput): ExportPlan {
  const infos = [...input.versions]
    .sort((a, b) => b.number - a.number || (a.id < b.id ? 1 : -1))
    .map((v) => describe(v, input));
  const byVersion = new Map<string, VersionInfo>(infos.map((i) => [i.version.id, i]));

  // The newest version that places a block governs it.
  const governing = new Map<BlockId, { info: VersionInfo; block: FieldBlock }>();
  for (const info of infos) {
    for (const block of info.placed) if (!governing.has(block.id)) governing.set(block.id, { info, block });
  }
  const fields: PlanField[] = [];
  for (const [blockId, { info, block }] of governing) {
    if (!info.allowed.has(blockId)) continue;
    fields.push({ blockId, key: block.key, governing: info, columns: columnsOf(block) });
  }
  const headers = [...FIXED_HEADERS, ...fields.flatMap((f) => f.columns.map((c) => c.header))];
  const fieldColumns = headers.length - FIXED_HEADERS.length;

  function rowOf(response: ExportResponse): ExportRow {
    const fixed = [response.id, response.receivedAt.toISOString()];
    const own = byVersion.get(response.formVersionId);
    if (!own) return { cells: [...fixed, ...Array.from({ length: fieldColumns }, () => '')], fieldKeys: [] };

    const answers = response.answers as Record<string, unknown>;
    const readers = new Map<string, Map<BlockId, DisclosableField>>();
    const read = (info: VersionInfo): Map<BlockId, DisclosableField> => {
      let found = readers.get(info.version.id);
      if (!found) {
        const rows = disclosableFields({
          definition: info.version.definition,
          compiled: info.version.compiled,
          answers,
          purposeIds: info.purposeIds,
          channel: 'export',
          includeSensitive: input.includeSensitive,
        });
        found = new Map(rows.map((f) => [f.blockId, f]));
        readers.set(info.version.id, found);
      }
      return found;
    };

    const cells = fixed;
    const fieldKeys: string[] = [];
    for (const field of fields) {
      const mine = own.allowed.has(field.blockId) ? read(own).get(field.blockId) : undefined;
      if (!mine || !mine.answered) {
        for (let i = 0; i < field.columns.length; i += 1) cells.push('');
        continue;
      }
      // The newest version's verdict also applies to a response of an older one: masked there, masked here.
      const masked = mine.masked || (field.governing !== own && read(field.governing).get(field.blockId)?.masked === true);
      if (masked) {
        for (let i = 0; i < field.columns.length; i += 1) cells.push(MASK);
        continue;
      }
      const ownSuffixes = own.suffixes.get(field.blockId) ?? [];
      for (const column of field.columns) {
        const at = ownSuffixes.indexOf(column.suffix);
        cells.push(at < 0 ? '' : (mine.cells[at] ?? ''));
      }
      fieldKeys.push(mine.key);
    }
    return { cells, fieldKeys };
  }

  return { headers, fieldColumns, rowOf };
}
