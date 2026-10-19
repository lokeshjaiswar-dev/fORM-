import type { AvailableType } from '@form/registry';
import type {
  BlockId, BlockOf, Condition, ConditionId, FieldKey, FormDefinition, FormId, LogicOperator, Operand, PageId, Rule, RuleId, StoredBlock,
} from '@form/schema';
import { blankDefinition, blockOrder, createBlock, inlineDoc, isField, type IdSource } from '@/lib/definition';
import { newestFirst, summarize, type DocumentRepository, type FormSummary, type StoredForm } from '@/persistence/DocumentRepository';
import { currentDoc } from '@/state/documentStore';
import { loadDocument } from '@/state/history';
import { defaultOps, loadOps } from '@/state/opsStore';
import { resetUi } from '@/state/uiStore';

/** Sequential ids: the same calls give the same ids. */
export function counter(prefix = 'id'): IdSource {
  let n = 0;
  return { newId: () => `${prefix}_${(n += 1)}` };
}

const BASE = blankDefinition('test', counter('base'));
export const PURPOSE = BASE.privacy.purposes[0]!.id;

/**
 * A block of a registry type with id `id` (and key `id` for fields). A string `label` becomes an InlineDoc; `config`
 * is merged over the type's default config.
 */
export function block<T extends AvailableType>(type: T, id: string, patch: Record<string, unknown> = {}): BlockOf<T> {
  const base = createBlock({ type, configOverrides: {} }, BASE, counter(id)) as unknown as Record<string, unknown>;
  const { label, config, key, ...rest } = patch;
  const out: Record<string, unknown> = { ...base, id, ...rest };
  if (isField(base as unknown as StoredBlock)) {
    out['key'] = key ?? id;
    if (label !== undefined) out['label'] = typeof label === 'string' ? inlineDoc(label) : label;
  }
  if (config) out['config'] = { ...(base['config'] as object), ...(config as object) };
  return out as unknown as BlockOf<T>;
}

/** A form with `pages` (or one page of blocks), on the blank form's defaults. */
export function formWith(pages: StoredBlock[] | StoredBlock[][], rules: Rule[] = []): FormDefinition {
  const list = (pages.length && Array.isArray(pages[0]) ? pages : [pages]) as StoredBlock[][];
  const blocks: FormDefinition['blocks'] = {};
  for (const page of list) for (const b of page) blocks[b.id] = b;
  return {
    ...BASE,
    formId: 'test' as FormId,
    title: 'Test form',
    blocks,
    pages: list.map((page, i) => ({ id: `page_${i + 1}` as PageId, children: page.map((b) => b.id) })),
    logic: { ...BASE.logic, rules },
    behavior: { ...BASE.behavior, successAnimation: false },
    endings: BASE.endings.map((e) => (e.kind === 'message' ? { ...e, confetti: false } : e)),
  };
}

/** A one-condition rule: `action` on `targets` when `source` `op` `right`. */
export function rule(id: string, source: string, op: LogicOperator, right: Operand | undefined, action: 'show' | 'hide', targets: string[], enabled = true): Rule {
  const condition: Condition = {
    kind: 'condition', id: `${id}_c` as ConditionId, left: { kind: 'ref', ref: { kind: 'answer', blockId: source as BlockId } }, op, ...(right ? { right } : {}),
  };
  return {
    id: id as RuleId,
    enabled,
    when: { kind: 'group', id: `${id}_g` as ConditionId, combinator: 'all', children: [condition] },
    then: [{ type: action, targets: targets as BlockId[] }],
  };
}

export const text = (value: string): Operand => ({ kind: 'literal', value: { type: 'text', value } });

/** Opens a form with an empty history, default local ops and a fresh, started UI. */
export function resetStore(pages: StoredBlock[] | StoredBlock[][] = [], rules: Rule[] = []) {
  loadDocument(formWith(pages, rules));
  loadOps(defaultOps());
  resetUi({ started: true });
}

export const doc = () => currentDoc();
export const blockIds = (): string[] => blockOrder(currentDoc());
export const blockAt = (i: number): StoredBlock => currentDoc().blocks[blockOrder(currentDoc())[i] as BlockId] as StoredBlock;
export const keyOf = (b: StoredBlock | undefined): FieldKey | undefined => (b && isField(b) ? b.key : undefined);

/** A repository in memory; records are cloned in and out as IndexedDB would. */
export class MemoryRepository implements DocumentRepository {
  readonly records = new Map<string, StoredForm>();

  async list(): Promise<FormSummary[]> {
    return [...this.records.values()].map(summarize).sort(newestFirst);
  }

  async load(id: string): Promise<StoredForm | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async save(form: StoredForm): Promise<void> {
    this.records.set(form.id, structuredClone(form));
  }
}

/** A v1 export as an older builder saved it (for migration tests). */
export function v1Form(blocks: Array<Record<string, unknown>>, settings: Record<string, unknown> = {}) {
  return { id: 'v1form', title: 'Old form', description: '', blocks: blocks.map((b, i) => ({ label: '', order: i, ...b })), settings };
}
