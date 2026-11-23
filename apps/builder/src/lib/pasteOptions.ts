import type { ChoiceOption, OptionId } from '@form/schema';
import { labelString } from '@/fields/style';

/** The most options one choice block may hold (the schema's limit). */
export const MAX_OPTIONS = 5000;

export interface PasteResult {
  options: ChoiceOption[];
  /** Options created by the paste. */
  added: number;
  /** Links from an option to a parent answer created by the paste. */
  linked: number;
  /** Parent answers named in the rows that the parent question does not have, in first-seen order. */
  unknownParents: string[];
}

const comparable = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** Copies options so links can be added without touching the block's current config. */
const copy = (options: readonly ChoiceOption[]): ChoiceOption[] => options.map((o) => ({ ...o, ...(o.parentOptionIds ? { parentOptionIds: [...o.parentOptionIds] } : {}) }));

/** Adds `label` (or finds it, by label) and links it to `parentId`; counts what changed. */
function place(options: ChoiceOption[], byLabel: Map<string, number>, label: string, parentId: OptionId | undefined, newId: () => string, counts: { added: number; linked: number }): boolean {
  let index = byLabel.get(comparable(label));
  if (index === undefined) {
    if (options.length >= MAX_OPTIONS) return false;
    options.push({ id: newId() as OptionId, label, ...(parentId ? { parentOptionIds: [parentId] } : {}) });
    byLabel.set(comparable(label), options.length - 1);
    counts.added += 1;
    if (parentId) counts.linked += 1;
    return true;
  }
  const option = options[index] as ChoiceOption;
  if (parentId && !option.parentOptionIds?.includes(parentId)) {
    option.parentOptionIds = [...(option.parentOptionIds ?? []), parentId];
    counts.linked += 1;
  }
  return true;
}

/**
 * Adds one option per pasted line to one group: linked to `parentId`, or offered for every parent answer when it is
 * null. A line naming an option that already exists links that option too instead of repeating it. Commas are part of
 * a name ("Delhi, NCR"), so nothing about the format needs explaining. Nothing is ever removed.
 */
export function pasteIntoGroup(current: readonly ChoiceOption[], parentId: OptionId | null, text: string, newId: () => string): PasteResult {
  const options = copy(current);
  const byLabel = new Map(options.map((o, i) => [comparable(labelString(o.label)), i]));
  const counts = { added: 0, linked: 0 };
  for (const row of text.split(/\r?\n/)) {
    const label = row.trim().replace(/\s+/g, ' ');
    if (label && !place(options, byLabel, label, parentId ?? undefined, newId, counts)) break;
  }
  return { options, ...counts, unknownParents: [] };
}

/** A row's two cells: a tab separates spreadsheet columns; without one, the first comma does. */
function cells(row: string): [string, string] | null {
  const at = row.includes('\t') ? row.indexOf('\t') : row.indexOf(',');
  if (at === -1) return null;
  return [row.slice(0, at).trim(), row.slice(at + 1).trim()];
}

/**
 * Imports "parent answer, option" pairs (two spreadsheet columns paste tab-separated) for building a whole linked list
 * at once. Parent answers match by label or export code, ignoring case and extra spaces; an option is created once and
 * linked to every parent answer it appears with. A line with one cell is an option offered for every parent answer.
 */
export function importPairs(current: readonly ChoiceOption[], parentOptions: readonly ChoiceOption[], text: string, newId: () => string): PasteResult {
  const options = copy(current);
  const byLabel = new Map(options.map((o, i) => [comparable(labelString(o.label)), i]));
  const parentByName = new Map<string, OptionId>();
  for (const p of parentOptions) {
    parentByName.set(comparable(labelString(p.label)), p.id);
    if (p.code) parentByName.set(comparable(p.code), p.id);
  }
  const counts = { added: 0, linked: 0 };
  const unknown: string[] = [];
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const pair = cells(row);
    const label = (pair ? pair[1] : row.trim()).replace(/\s+/g, ' ');
    if (!label) continue;
    let parentId: OptionId | undefined;
    if (pair && pair[0]) {
      parentId = parentByName.get(comparable(pair[0]));
      if (!parentId) {
        if (!unknown.includes(pair[0])) unknown.push(pair[0]);
        continue;
      }
    }
    if (!place(options, byLabel, label, parentId, newId, counts)) break;
  }
  return { options, ...counts, unknownParents: unknown };
}
