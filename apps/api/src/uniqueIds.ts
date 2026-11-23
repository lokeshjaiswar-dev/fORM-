import { nextSerial, serialPeriod, type Executor, type SerialReset } from '@form/db';
import { formatUniqueId } from '@form/registry';
import type { UniqueIdConfig } from '@form/schema';
import { z } from 'zod';

/** Submit response: `uniqueId` is the value to show on the ending (a `showOnEnding` field); `uniqueIds` has every issued value by block. */
export const submitResponse = z.object({
  id: z.uuid(),
  uniqueId: z.string().optional(),
  uniqueIds: z.record(z.string(), z.string()).optional(),
});

/** A `unique_id` field of a form definition, with its config read defensively (drafts are not validated). */
export interface SerialField {
  id: string;
  key: string;
  /** Plain text of the block label, for a readable row the client did not send. */
  label: string;
  config: UniqueIdConfig;
}

/** A value the server issued for one field on one submission. */
export interface IssuedSerial {
  blockId: string;
  key: string;
  label: string;
  value: string;
  showOnEnding: boolean;
}

interface FieldRow {
  key: string;
  label: string;
  value: string;
}

/** The text nodes of an InlineDoc (or a plain string), joined. */
function plainText(doc: unknown): string {
  if (typeof doc === 'string') return doc;
  if (typeof doc !== 'object' || doc === null) return '';
  const node = doc as { text?: unknown; content?: unknown };
  if (typeof node.text === 'string') return node.text;
  return Array.isArray(node.content) ? node.content.map(plainText).join('') : '';
}

const RESETS: readonly SerialReset[] = ['never', 'year', 'month'];
/** A longer pad is a broken config, not a reference number; it would only bloat every stored answer. */
const MAX_PAD = 32;

function readConfig(raw: unknown): UniqueIdConfig {
  const c = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof UniqueIdConfig, unknown>>;
  const prefix = Array.isArray(c.prefix) ? (c.prefix as UniqueIdConfig['prefix']) : [];
  const padTo = typeof c.padTo === 'number' && Number.isInteger(c.padTo) && c.padTo >= 1 ? Math.min(c.padTo, MAX_PAD) : 1;
  const startAt = typeof c.startAt === 'number' && Number.isFinite(c.startAt) && c.startAt >= 0 ? Math.trunc(c.startAt) : 1;
  const resetEvery = RESETS.includes(c.resetEvery as SerialReset) ? (c.resetEvery as SerialReset) : 'never';
  return { prefix, padTo, startAt, resetEvery, showOnEnding: c.showOnEnding === true };
}

/** The `unique_id` fields in a definition's block map, ordered by id so every transaction locks counters alike. */
export function serialFields(blocks: unknown): SerialField[] {
  if (typeof blocks !== 'object' || blocks === null) return [];
  const fields: SerialField[] = [];
  for (const block of Object.values(blocks as Record<string, unknown>)) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: unknown; id?: unknown; key?: unknown; label?: unknown; config?: unknown };
    if (b.type !== 'unique_id' || typeof b.id !== 'string' || !b.id) continue;
    const key = typeof b.key === 'string' && b.key ? b.key : b.id;
    fields.push({ id: b.id, key, label: plainText(b.label).trim() || key, config: readConfig(b.config) });
  }
  return fields.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The form's time zone (`behavior.timeZone`); UTC when the definition has none. */
export function formTimeZone(definition: unknown): string {
  if (typeof definition !== 'object' || definition === null) return 'UTC';
  const behavior = (definition as { behavior?: unknown }).behavior;
  if (typeof behavior !== 'object' || behavior === null) return 'UTC';
  const zone = (behavior as { timeZone?: unknown }).timeZone;
  return typeof zone === 'string' && zone ? zone : 'UTC';
}

/** Issues the next value of every field, in the caller's transaction (so a failed insert gives the numbers back). */
export async function issueSerials(
  tx: Executor,
  input: { orgId: string; formId: string; fields: readonly SerialField[]; timeZone: string; at: Date },
): Promise<IssuedSerial[]> {
  const issued: IssuedSerial[] = [];
  for (const field of input.fields) {
    const n = await nextSerial(tx, {
      orgId: input.orgId,
      formId: input.formId,
      blockId: field.id,
      period: serialPeriod(field.config.resetEvery, input.at, input.timeZone),
      startAt: field.config.startAt,
    });
    issued.push({ blockId: field.id, key: field.key, label: field.label, value: formatUniqueId(field.config, n), showOnEnding: field.config.showOnEnding });
  }
  return issued;
}

/**
 * Answers and readable rows with the issued values in place of the client's preview. A field the client sent no
 * readable row for gets one, so the stored rows never miss or misstate the number.
 */
export function withSerials<T extends FieldRow>(
  answers: Readonly<Record<string, unknown>>,
  fields: readonly T[],
  issued: readonly IssuedSerial[],
): { answers: Record<string, unknown>; fields: T[] } {
  if (!issued.length) return { answers: { ...answers }, fields: [...fields] };
  const byKey = new Map(issued.map((s) => [s.key, s.value]));
  const nextAnswers: Record<string, unknown> = { ...answers };
  for (const s of issued) nextAnswers[s.blockId] = { type: 'unique_id', value: s.value };
  const present = new Set(fields.map((row) => row.key));
  const missing = issued.filter((s) => !present.has(s.key)).map((s) => ({ key: s.key, label: s.label, value: s.value }) as T);
  return {
    answers: nextAnswers,
    fields: [...fields.map((row) => (byKey.has(row.key) ? { ...row, value: byKey.get(row.key)! } : row)), ...missing],
  };
}

/** What the submit response carries for the ending: the first value marked `showOnEnding`, and every value by block. */
export function serialResponse(issued: readonly IssuedSerial[]): { uniqueId?: string; uniqueIds?: Record<string, string> } {
  if (!issued.length) return {};
  const shown = issued.find((s) => s.showOnEnding);
  return {
    ...(shown ? { uniqueId: shown.value } : {}),
    uniqueIds: Object.fromEntries(issued.map((s) => [s.blockId, s.value])),
  };
}

/** A block map without `unique_id` fields: their values are issued by the server, so a uniqueness check skips them. */
export function withoutSerialBlocks<M extends Readonly<Record<string, unknown>>>(blocks: M): M {
  /* The same map type comes back, so callers keep the block types they passed in. */
  return Object.fromEntries(
    Object.entries(blocks).filter(([, b]) => !(typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'unique_id')),
  ) as M;
}
