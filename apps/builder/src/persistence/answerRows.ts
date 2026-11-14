import { valueDefinition } from '@form/registry';
import type { Answers, FieldBlock, FileRef, FormDefinition, ValueFieldType } from '@form/schema';
import { toPlain } from '@form/schema';
import { blockOrder, isField } from '@/lib/definition';
import type { SubmissionField } from '@/persistence/SubmissionsRepository';

function joinReadable(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(joinReadable).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.address === 'string' && rec.address) return rec.address;
    if (typeof rec.e164 === 'string' && rec.e164) return rec.e164;
    if ('optionId' in rec) return joinReadable(rec.other ?? rec.optionId);
    if (Array.isArray(rec.optionIds)) return rec.optionIds.map(joinReadable).concat(rec.other ? [joinReadable(rec.other)] : []).filter(Boolean).join(', ');
    if (typeof rec.name === 'string' && rec.name) return rec.name;
    if (typeof rec.fileId === 'string' && typeof rec.name === 'string') return rec.name;
    if (typeof rec.start === 'string' && typeof rec.end === 'string' && rec.start.includes('T')) {
      const zone = typeof rec.respondentTimeZone === 'string' ? rec.respondentTimeZone : 'UTC';
      const slots = Array.isArray(rec.slots) && rec.slots.length > 0 ? rec.slots : [{ start: rec.start, end: rec.end }];
      return slots
        .map((slot) => {
          if (!slot || typeof slot !== 'object') return '';
          const row = slot as { start?: unknown; end?: unknown };
          if (typeof row.start !== 'string' || typeof row.end !== 'string') return '';
          const from = new Date(row.start);
          const to = new Date(row.end);
          if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return `${row.start} – ${row.end}`;
          const date = new Intl.DateTimeFormat('en-IN', { timeZone: zone, day: 'numeric', month: 'short', year: 'numeric' }).format(from);
          const start = new Intl.DateTimeFormat('en-IN', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true }).format(from);
          const end = new Intl.DateTimeFormat('en-IN', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true }).format(to);
          return `${date}, ${start} – ${end}`;
        })
        .filter(Boolean)
        .join('; ');
    }
    const pairs = Object.entries(rec)
      .filter(([key]) => key !== 'type' && key !== 'enc' && key !== 'file')
      .map(([key, v]) => {
        const right = joinReadable(v);
        return right ? `${key} - ${right}` : '';
      })
      .filter(Boolean);
    return pairs.join('\n');
  }
  return String(value);
}

function answerValue(answer: unknown): unknown {
  if (answer && typeof answer === 'object' && 'value' in answer) return (answer as { value: unknown }).value;
  return answer;
}

function registryText(block: FieldBlock, value: unknown): string | null {
  try {
    const def = valueDefinition(block.type as ValueFieldType);
    if (!def.export) return null;
    return (def.export.text as (v: unknown, b: unknown) => string)(value, block);
  } catch {
    return null;
  }
}

function fieldLabel(block: FieldBlock): string {
  return toPlain(block.label).trim() || block.key;
}

function asFileRef(value: unknown): FileRef | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.fileId !== 'string' || typeof rec.name !== 'string') return null;
  return rec as unknown as FileRef;
}

export type AnswerMedia = { fileId?: string; assetId?: string; name: string; mime?: string };

export type ReadableField = SubmissionField & { media?: AnswerMedia[] };

function mediaFor(block: FieldBlock, answer: unknown): AnswerMedia[] {
  const value = answerValue(answer);
  if (block.type === 'file_upload' && Array.isArray(value)) {
    return value.flatMap((item) => {
      const file = asFileRef(item);
      return file ? [{ fileId: file.fileId, name: file.name, mime: file.mime }] : [];
    });
  }
  if (block.type === 'signature' && value && typeof value === 'object') {
    const file = asFileRef((value as { file?: unknown }).file);
    return file ? [{ fileId: file.fileId, name: file.name, mime: file.mime }] : [];
  }
  if ((block.type === 'single_choice' || block.type === 'multi_choice') && 'display' in block.config && block.config.display === 'image') {
    const options = block.config.options;
    const ids: string[] = [];
    if (block.type === 'single_choice' && value && typeof value === 'object') {
      const optionId = (value as { optionId?: unknown }).optionId;
      if (typeof optionId === 'string') ids.push(optionId);
    }
    if (block.type === 'multi_choice' && value && typeof value === 'object') {
      const optionIds = (value as { optionIds?: unknown }).optionIds;
      if (Array.isArray(optionIds)) ids.push(...optionIds.filter((id): id is string => typeof id === 'string'));
    }
    return ids.flatMap((id) => {
      const option = options.find((o) => o.id === id);
      const assetId = option?.image?.assetId;
      if (!assetId) return [];
      const name = typeof option.label === 'string' ? option.label : id;
      return [{ assetId, name }];
    });
  }
  return [];
}

/** One readable line for a stored answer, using option labels and field text — never raw JSON. */
export function displayAnswer(block: FieldBlock | undefined, answer: unknown): string {
  const value = answerValue(answer);
  if (block && isField(block)) {
    const text = registryText(block, value);
    if (text != null && text.trim()) return text.trim();
  }
  return joinReadable(value);
}

function looksLikeJson(value: string): string {
  return value.trim();
}

function isJson(value: string): boolean {
  const t = looksLikeJson(value);
  return t.startsWith('{') || t.startsWith('[');
}

/** Labels and readable values for a filled form, in document order (including nested sections). */
export function answerRows(definition: FormDefinition, answers: Answers): ReadableField[] {
  const rows: ReadableField[] = [];
  for (const id of blockOrder(definition)) {
    const block = definition.blocks[id];
    if (!isField(block)) continue;
    const answer = answers[block.id];
    if (!answer) continue;
    const media = mediaFor(block, answer);
    rows.push({ key: block.key, label: fieldLabel(block), value: displayAnswer(block, answer), ...(media.length ? { media } : {}) });
  }
  return rows;
}

function decodeStoredValue(value: string): string {
  if (!isJson(value)) return value;
  try {
    return joinReadable(JSON.parse(value) as unknown) || value;
  } catch {
    return value;
  }
}

/** Rebuild from the form when it is available so labels and media stay current. */
export function readableFields(definition: FormDefinition | null, record: { answers: Record<string, unknown>; fields: SubmissionField[] }): ReadableField[] {
  if (definition) {
    const rebuilt = answerRows(definition, record.answers as Answers);
    if (rebuilt.length) return rebuilt;
  }
  return record.fields
    .filter((field) => field.label || field.value)
    .map((field) => ({ ...field, value: decodeStoredValue(field.value) }));
}
